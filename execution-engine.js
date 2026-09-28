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
 * address by signing a server-issued nonce, and the server does the quoting,
 * risk-checking, wrapping, approving and broadcasting.
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

    if (typeof window.privySignMessage !== 'function' || !window.isPrivyConnected()) {
        throw new Error('Privy wallet not connected or ready');
    }

    const userAddress = window.getPrivyAddress();
    if (!userAddress) throw new Error('No connected wallet address');

    ExecutionState.isExecuting = true;
    updateExecutionUI(botId, 'PREPARING');

    try {
        // Directional routing, as before: a LONG sells USDC for the target
        // token, otherwise it sells the target token back to USDC.
        const isLong = String(method || '').includes('LONG');
        const fromToken = isLong ? 'USDC' : token;
        const toToken = isLong ? token : 'USDC';

        // 1. Authorise: request a nonce for THIS exact trade, sign it, post it back.
        //
        // The nonce is bound to the terms below, and the server rejects any
        // submission whose terms differ from the ones signed. The payload is
        // therefore built once and sent identically to both calls - if the two
        // ever disagreed, the signature would verify and the trade would still
        // be refused.
        updateExecutionUI(botId, 'AUTHORISING');
        const tradeTerms = {
            address: userAddress,
            botId,
            fromToken,
            toToken,
            amountUSD,          // dollar budget; the server converts
            slippage: 0.005
        };

        const nonceRes = await fetch('/api/wallet/trade-nonce', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(tradeTerms)
        });
        const nonceData = await nonceRes.json();
        if (!nonceRes.ok || !nonceData.success) {
            throw new Error(nonceData.error || 'Could not obtain a trade authorisation nonce');
        }

        const signature = await window.privySignMessage(nonceData.message);
        if (!signature) throw new Error('Trade authorisation was not signed');

        // 2. Execute on the server.
        updateExecutionUI(botId, 'SIGNING');
        const res = await fetch('/api/wallet/swap', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ...tradeTerms,
                traderAddress: nonceData.address,
                nonce: nonceData.nonce,
                signature
            })
        });

        const data = await res.json();
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
