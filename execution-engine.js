/**
 * ON-CHAIN EXECUTION ENGINE
 * Trade Arena v4 • Real Money Trading on Base
 *
 * Handles:
 * - DEX Aggregator Integration (0x / 1inch)
 * - Atomic Swap Execution via Privy/Ethers
 * - Real-time Transaction Tracking
 * - Error Handling & Reversion Protection
 */

const EXECUTION_CONFIG = {
    // 0x API for Base network
    zeroExApiUrl: 'https://base.api.0x.org/swap/v1',
    // 0x API Key (Should be provided via env or prompt)
    zeroExApiKey: '',
    // Minimum liquidity threshold in USD
    minLiquidityUSD: 50000,
    // Max slippage for real trades
    maxSlippage: 0.01, // 1%
    // Private RPC for MEV protection (Flashbots/Base equivalents)
    privateRpcUrl: 'https://rpc.base.org', // Placeholder for real MEV-aware RPC
    // Use Atomic Bundles for arbitrage
    useAtomicBundles: true
};

/**
 * Execution Engine State
 */
const ExecutionState = {
    isExecuting: false,
    lastTxHash: null,
    pendingTrades: new Map(),
    mevProtectionActive: true
};

/**
 * Get a swap quote from 0x API
 * @param {string} buyTokenAddress
 * @param {string} sellTokenAddress
 * @param {string} sellAmountWei
 * @param {string} takerAddress
 */
async function getSwapQuote(buyTokenAddress, sellTokenAddress, sellAmountWei, takerAddress) {
    console.log(`[Execution] Fetching quote from 0x: ${sellTokenAddress} -> ${buyTokenAddress}`);

    const params = new URLSearchParams({
        buyToken: buyTokenAddress,
        sellToken: sellTokenAddress,
        sellAmount: sellAmountWei,
        takerAddress: takerAddress,
        slippagePercentage: EXECUTION_CONFIG.maxSlippage.toString(),
    });

    try {
        const response = await fetch(`${EXECUTION_CONFIG.zeroExApiUrl}/quote?${params.toString()}`, {
            headers: {
                '0x-api-key': EXECUTION_CONFIG.zeroExApiKey || ''
            }
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(`0x API Error: ${error.reason || response.statusText}`);
        }

        return await response.json();
    } catch (e) {
        console.error('[Execution] Quote error:', e);
        throw e;
    }
}

/**
 * TRADING SESSION MANAGER
 *
 * One wallet signature authorises trades for a limited time, instead of a
 * MetaMask popup on every bot fill. The token is cached in memory only (a
 * page reload re-signs once) and is bound to the address that created it -
 * switching accounts discards it. If the server reports the session expired
 * mid-flight, callers retry once via ensureTradeSession().
 */
const TradeSession = {
    token: null,
    address: null,
    expiresAt: 0,
};

/**
 * Obtain a session token for `userAddress`, signing ONE message in the
 * wallet on first use (or after expiry). Returns the token. Throws if the
 * session cannot be established (user rejects, server error, old server
 * without the endpoints) - the caller catches and falls back to the
 * per-trade nonce flow, which still works.
 *
 * @param {string} userAddress
 * @param {(message: string) => Promise<string>} signMessage
 * @returns {Promise<string>} session token
 */
async function ensureTradeSession(userAddress, signMessage) {
    // Compare case-insensitively: MetaMask reports lowercase, ethers and the
    // server report checksummed; the same wallet must not force a re-sign.
    const sameAccount = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

    if (TradeSession.token
        && sameAccount(TradeSession.address, userAddress)
        && TradeSession.expiresAt > Date.now() + 30_000 /* refresh margin */) {
        return TradeSession.token;
    }

    // A different account signed in: the old token must never be reused.
    if (!sameAccount(TradeSession.address, userAddress)) {
        TradeSession.token = null;
        TradeSession.expiresAt = 0;
    }

    // 1. Ask the server for a challenge bound to this address.
    const chRes = await fetch('/api/wallet/trade-session/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: userAddress })
    });
    const ch = await chRes.json().catch(() => ({}));
    if (!chRes.ok || !ch.success) {
        throw new Error(ch.error || `Session challenge failed (HTTP ${chRes.status})`);
    }

    // 2. Sign it - the ONE wallet prompt for this whole session.
    const signature = await signMessage(ch.message);
    if (!signature) throw new Error('Session authorisation was not signed');

    // 3. Redeem for a time-limited token.
    const svRes = await fetch('/api/wallet/trade-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: userAddress, nonce: ch.nonce, signature })
    });
    const sv = await svRes.json().catch(() => ({}));
    if (!svRes.ok || !sv.success) {
        throw new Error(sv.error || `Session start failed (HTTP ${svRes.status})`);
    }

    TradeSession.token = sv.token;
    TradeSession.address = sv.address;
    TradeSession.expiresAt = Date.parse(sv.expiresAt) || (Date.now() + (sv.ttlMs || 0));
    console.log(`[Execution] Trading session active until ${TradeSession.expiresAt ? new Date(TradeSession.expiresAt).toLocaleTimeString() : '?'}`);
    return TradeSession.token;
}

/**
 * Drop the cached session and tell the server it is dead (logout, account
 * switch). Fire-and-forget: even if the server call fails, the local cache
 * is cleared so no further trades ride the old token.
 */
function clearTradeSession() {
    const token = TradeSession.token;
    TradeSession.token = null;
    TradeSession.address = null;
    TradeSession.expiresAt = 0;
    if (token) {
        try {
            fetch('/api/wallet/trade-session', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token })
            }).catch(() => { /* server already forgot it */ });
        } catch (e) { /* non-fatal */ }
    }
}

/**
 * Execute a real on-chain trade by delegating to the server engine.
 *
 * This used to be a second, independent execution path: it built its own
 * quote, sized the input as `amountUSD * 1e6` USDC units, signed through
 * Privy and broadcast from the browser. That path never shared any of the
 * server engine's correctness work - the corrected SwapRouter02 selector
 * (no `deadline` in ExactInputSingleParams), the WETH wrap for native input,
 * the USD-denominated risk limit, or the amountUSD-to-token-quantity
 * conversion - and it re-introduced the same USD/token confusion it had
 * elsewhere fixed.
 *
 * There is now ONE engine. The browser proves it controls the trading
 * address - either by presenting a trading session token (one signature
 * per session, minted via /api/wallet/trade-session) or, as a fallback, by
 * signing a server-issued per-trade nonce - and the server does the
 * quoting, risk-checking, wrapping, approving and broadcasting.
 *
 * @param {Object} tradeRequest
 * @param {string} tradeRequest.botId
 * @param {string} tradeRequest.token     token being bought/sold
 * @param {string} tradeRequest.method    e.g. 'SPOT LONG'
 * @param {number} tradeRequest.amountUSD dollar budget (USD, not AUD)
 */
async function executeOnChainTrade(tradeRequest) {
    if (ExecutionState.isExecuting) {
        throw new Error('Execution in progress');
    }

    const { botId, token, method, amountUSD } = tradeRequest;
    console.log(`[Execution] Delegating to server engine: Bot #${botId} - ${method} ${token} $${amountUSD}`);

    // Accept EITHER a Privy embedded wallet OR an injected MetaMask wallet.
    // Previously this only accepted Privy, so every MetaMask login silently
    // skipped on-chain execution and fell back to paper simulation.
    const hasPrivy = typeof window.privySignMessage === 'function'
        && typeof window.isPrivyConnected === 'function'
        && window.isPrivyConnected()
        && typeof window.getPrivyAddress === 'function'
        && window.getPrivyAddress();
    const hasMetaMask = typeof WalletCore !== 'undefined'
        && WalletCore.state && WalletCore.state.connected && WalletCore.state.address
        && WalletCore.state.signer;
    if (!hasPrivy && !hasMetaMask) {
        throw new Error('No wallet connected (MetaMask or Privy) - connect a wallet to trade on-chain');
    }

    const userAddress = hasPrivy ? window.getPrivyAddress() : WalletCore.state.address;
    if (!userAddress) throw new Error('No connected wallet address');

    ExecutionState.isExecuting = true;
    updateExecutionUI(botId, 'PREPARING');

    try {
        // Directional routing, as before: a LONG sells USDC for the target
        // token, otherwise it sells the target token back to USDC.
        const isLong = String(method || '').includes('LONG');
        const fromToken = isLong ? 'USDC' : token;
        const toToken = isLong ? token : 'USDC';

        updateExecutionUI(botId, 'AUTHORISING');
        const tradeTerms = {
            address: userAddress,
            botId,
            fromToken,
            toToken,
            amountUSD,          // dollar budget; the server converts
            slippage: 0.005
        };

        const signMessage = (message) => hasPrivy
            ? window.privySignMessage(message)
            : WalletCore.state.signer.signMessage(message);

        // 1. Authorise. Preferred: a trading session (ONE wallet prompt per
        //    session, not per fill). Fallback: the per-trade nonce + signature,
        //    used when the session cannot be established (user rejects it, an
        //    older server without the session endpoints, transient error).
        //    The per-trade nonce is bound to the terms above, and the server
        //    rejects any submission whose terms differ from the ones signed.
        let authBody;
        let usedSession = false;
        try {
            const sessionToken = await ensureTradeSession(userAddress, signMessage);
            authBody = { traderAddress: userAddress, sessionToken };
            usedSession = true;
        } catch (e) {
            console.warn('[Execution] No trading session, signing this trade individually:', e.message);

            const nonceRes = await fetch('/api/wallet/trade-nonce', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(tradeTerms)
            });
            const nonceData = await nonceRes.json();
            if (!nonceRes.ok || !nonceData.success) {
                throw new Error(nonceData.error || 'Could not obtain a trade authorisation nonce');
            }

            const signature = await signMessage(nonceData.message);
            if (!signature) throw new Error('Trade authorisation was not signed');
            authBody = {
                traderAddress: nonceData.address,
                nonce: nonceData.nonce,
                signature
            };
        }

        // 2. Execute on the server. If the session expired between trades the
        //    server answers 401 {sessionExpired:true}; renew it (one prompt)
        //    and retry the same trade exactly once.
        updateExecutionUI(botId, 'SIGNING');
        let res = await fetch('/api/wallet/swap', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...tradeTerms, ...authBody })
        });

        let data = await res.json();
        if (!res.ok && usedSession && data && data.sessionExpired) {
            console.warn('[Execution] Trading session expired, renewing...');
            TradeSession.token = null;
            TradeSession.expiresAt = 0;
            const sessionToken = await ensureTradeSession(userAddress, signMessage);
            res = await fetch('/api/wallet/swap', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...tradeTerms, traderAddress: userAddress, sessionToken })
            });
            data = await res.json();
        }

        if (!res.ok || !data.success) {
            throw new Error(data.error || `Trade failed (HTTP ${res.status})`);
        }

        ExecutionState.lastTxHash = data.txHash;
        updateExecutionUI(botId, 'COMPLETE', data.txHash);

        return {
            success: true,
            txHash: data.txHash,
            mode: data.mode,
            sizing: data.sizing,
            swap: data.swap
        };
    } catch (e) {
        updateExecutionUI(botId, 'ERROR', e.message);
        console.error('[Execution] Trade failed:', e);
        throw e;
    } finally {
        ExecutionState.isExecuting = false;
    }
}

/**
 * Atomic Bundle Execution (MEV Protection)
 * Sends transaction via Private RPC to avoid front-running
 */
async function sendAtomicBundle(quote, userAddress) {
    console.log('[Execution] Constructing Atomic Bundle for MEV protection...');

    // In production, this would use a library like Flashbots or a specialized provider
    // bundle = [ { tx: swapTx, revertOnFailure: true } ]

    // For the purpose of this prototype on Base, we route through Private RPCs
    // that offer "pre-confirmation" or "front-running protection"

    if (EXECUTION_CONFIG.zeroExApiKey) {
        // Real logic for private RPC submission
        console.log(`[Execution] Routing trade for ${userAddress} through private MEV lane...`);
    }

    return await simulateOrSendTransaction(quote);
}

/**
 * Simulated Transaction Logic for Sandbox
 */
async function simulateOrSendTransaction(quote) {
    console.log('[Execution] Transaction Quote:', quote);

    // If we had a real Ethers provider from Privy:
    // const provider = new ethers.providers.Web3Provider(window.ethereum);
    // const signer = provider.getSigner();
    // const tx = await signer.sendTransaction({
    //     to: quote.to,
    //     data: quote.data,
    //     value: quote.value,
    //     gasPrice: quote.gasPrice,
    // });
    // return tx.hash;

    // Simulation for demo:
    await new Promise(r => setTimeout(r, 2000));
    return '0x' + Array.from({length: 64}, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

/**
 * Wait for transaction to be mined
 */
async function waitForTransaction(hash) {
    console.log(`[Execution] Waiting for tx: ${hash}`);
    await new Promise(r => setTimeout(r, 3000));
    return { status: 1, blockNumber: 12345678 };
}

/**
 * Update UI state during execution
 */
function updateExecutionUI(botId, status, detail = '') {
    const el = document.getElementById('mtick-' + botId);
    if (!el) return;

    const colors = {
        'PREPARING': 'var(--dim)',
        'QUOTING': 'var(--blue)',
        'SIGNING': 'var(--amber)',
        'MINING': 'var(--purple)',
        'COMPLETE': 'var(--green)',
        'ERROR': 'var(--hot)'
    };

    const statusText = `[${status}] ${detail ? (detail.length > 20 ? detail.substring(0,20)+'...' : detail) : ''}`;
    el.textContent = statusText;
    el.style.color = colors[status] || 'white';

    // Also notify Floor Manager if open
    const vaStatus = document.getElementById('vaStatus');
    if (vaStatus) {
        vaStatus.textContent = `Fleet Action: ${status}`;
    }
}

// Export
window.executeOnChainTrade = executeOnChainTrade;
window.getSwapQuote = getSwapQuote;
window.clearTradeSession = clearTradeSession;
window.TradeSessionState = TradeSession; // view-only: token, address, expiresAt
