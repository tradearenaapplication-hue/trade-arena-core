/**
 * ON-CHAIN EXECUTION ENGINE (Backend)
 * Trade Arena • Production-grade swap execution on Base (mainnet + Sepolia)
 *
 * NETWORK SELECTION
 *   The network is chosen by BASE_CHAIN_ID (default 8453 = Base Mainnet).
 *   Set BASE_CHAIN_ID=84532 to point the whole engine at Base Sepolia, where
 *   test ETH is free. Addresses, RPC and the enforced chain check all follow
 *   from that one value, so a testnet run can never touch mainnet funds by
 *   accident.
 */

const { ethers } = require('ethers');
const crypto = require('crypto');
const { execSync } = require('child_process');
const tokenManager = require('./TokenManager');

/**
 * Per-network deployment table.
 *
 * Uniswap V3 addresses are chain-specific, and a mainnet router/quoter
 * address pointed at Sepolia returns no code and reverts every call. The
 * values below are taken from the official Uniswap Base deployment tables
 * and were each verified to return deployed bytecode.
 */
const NETWORKS = {
    8453: {
        name: 'Base Mainnet',
        rpcUrl: 'https://mainnet.base.org',
        swapRouter: '0x2626664c2603336E57B271c5C0b26F421741e481',
        quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
        isTestnet: false,
        // Block explorer for on-chain evidence. Every executed trade links
        // here, so a claim about a fill can always be checked independently
        // rather than taken on trust from this app's own records.
        explorer: 'https://basescan.org'
    },
    84532: {
        name: 'Base Sepolia',
        rpcUrl: 'https://sepolia.base.org',
        swapRouter: '0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4',
        quoter: '0xC5290058841028F1614F3A6F0F5816cAd0df5E27',
        isTestnet: true,
        explorer: 'https://sepolia.basescan.org'
    }
};

class OnchainExecutionEngine {
    constructor() {
        this.provider = null;
        this.signer = null;
        this.initialized = false;
        this.lastNonce = null;
        this.nonceMutex = false; // Simple lock for sequential nonce processing

        const configured = parseInt(process.env.BASE_CHAIN_ID || '8453', 10);
        const network = NETWORKS[configured];
        if (!network) {
            throw new Error(
                `Unsupported BASE_CHAIN_ID "${configured}". Expected one of: ${Object.keys(NETWORKS).join(', ')}`
            );
        }

        this.CHAIN_ID = configured;
        this.NETWORK = network;
        this.isTestnet = network.isTestnet;

        this.UNISWAP_ROUTER = network.swapRouter;
        this.UNISWAP_QUOTER = network.quoter;
    }

    /**
     * Initializes the provider and signer from environment variables.
     * Enforces strict validation that the chain matches BASE_CHAIN_ID.
     */
    async initialize() {
        if (this.initialized) return;

        const rpcUrl = process.env.BASE_RPC_URL || this.NETWORK.rpcUrl;
        const privateKey = process.env.TRADING_PRIVATE_KEY;

        if (!privateKey) {
            console.log(`[OnchainExecutionEngine] No TRADING_PRIVATE_KEY configured. Engine running in DRY RUN / SIMULATION mode (${this.NETWORK.name}).`);
            this.initialized = true;
            return;
        }

        try {
            // Normalise: 0x-prefixed, 32-byte hex. Trimmed so a pasted value with
            // stray whitespace or a trailing newline does not fail to parse.
            const normalizedKey = privateKey.trim().replace(/^0x/, '');

            if (!/^[0-9a-fA-F]{64}$/.test(normalizedKey)) {
                // Deliberately does NOT echo the value back.
                throw new Error(
                    'TRADING_PRIVATE_KEY is not a valid 32-byte hex key (expected 64 hex characters). ' +
                    'Check for missing 0x prefix, truncation, or a pasted seed phrase.'
                );
            }

            this.provider = new ethers.JsonRpcProvider(rpcUrl);
            this.signer = new ethers.Wallet('0x' + normalizedKey, this.provider);

            // Register the secret for redaction so it can never appear in a
            // stack trace, console dump or serialized error payload.
            this._redact(normalizedKey);

            // Strict network validation
            const network = await this.provider.getNetwork();
            const connectedChainId = Number(network.chainId);

            if (connectedChainId !== this.CHAIN_ID) {
                throw new Error(`CRITICAL: Connected to incorrect network. Expected ${this.NETWORK.name} (${this.CHAIN_ID}), got ${connectedChainId}`);
            }

            console.log(`[OnchainExecutionEngine] Initialized on ${this.NETWORK.name} with wallet: ${this.signer.address}`);
            this.initialized = true;
        } catch (error) {
            console.error('[OnchainExecutionEngine] Initialization failed:', error.message);
            throw error;
        }
    }

    /**
     * Scrub the private key from any string that might be logged.
     *
     * A wallet library error can embed the offending argument in its message
     * or stack. Without this, a single failed call could write the key to
     * stdout, a log file, or a crash reporter. Applied defensively to
     * console.error/console.log output via a wrapper below.
     */
    _redact(keyHex) {
        if (!keyHex) return;
        const secret = keyHex.toLowerCase();
        // Match the exact key (with or without 0x). Deliberately NOT a generic
        // /0x[0-9a-f]{64}/ pattern: that also matches router calldata and other
        // legitimate 32-byte hex, corrupting real values rather than secrets.
        const pattern = new RegExp(secret.replace(/^0x/, ''), 'gi');

        // Pure: returns redacted COPIES and never mutates the input. An earlier
        // version rewrote Error.message/.stack in place, which permanently
        // corrupted shared error objects - including ethers' own assertion
        // errors, turning "invalid private key" into "invalid [REDACTED]" and
        // destroying the diagnostic.
        const scrubString = (s) => String(s).replace(pattern, '[REDACTED_PRIVATE_KEY]');

        const scrub = (args) => args.map((a) => {
            if (typeof a === 'string') return scrubString(a);
            if (a instanceof Error) {
                // Copy rather than mutate, and leave the original error intact
                // for the caller.
                const copy = new Error(scrubString(a.message));
                copy.name = a.name;
                if (a.code) copy.code = a.code;
                copy.stack = a.stack ? scrubString(a.stack) : a.stack;
                return copy;
            }
            return a;
        });

        // Patch once per process; re-patching would wrap the wrapper.
        if (this._redactionInstalled) return;
        this._redactionInstalled = true;
        this._originalConsole = { log: console.log, error: console.error, warn: console.warn };

        for (const level of ['log', 'error', 'warn']) {
            const original = console[level].bind(console);
            console[level] = (...args) => original(...scrub(args));
        }
    }

    /**
     * Stops the console redaction wrapper. Used by tests and long-lived
     * processes that rotate keys.
     */
    restoreConsole() {
        if (!this._redactionInstalled || !this._originalConsole) return;
        const { log, error, warn } = this._originalConsole;
        console.log = log;
        console.error = error;
        console.warn = warn;
        this._redactionInstalled = false;
        this._originalConsole = null;
    }

    /**
     * Gets an on-chain quote from the Uniswap V3 Quoter contract.
     * @param {string} tokenIn - Address of token to swap from
     * @param {string} tokenOut - Address of token to swap to
     * @param {string} amountIn - Amount in base units
     * @param {number} fee - Uniswap pool fee tier (default 3000 = 0.3%)
     */
    async getUniswapV3Quote(tokenIn, tokenOut, amountIn, fee = 3000) {
        await this.initialize();
        if (!this.signer) {
            // Mock quote for dry run
            return (BigInt(amountIn) * 99n) / 100n; // Assume 1% price impact/fee
        }

        // QuoterV2 takes a single struct and returns four values. The legacy
        // v1 signature (5 positional args returning one uint256) does not
        // exist on this contract and reverts with "missing revert data".
        //
        // `ticksCrossed` is a uint32 COUNT, not a dynamic array. Declaring it as
        // `uint32[]` makes the ABI expect an offset word, so decoding every
        // successful quote failed with BAD_DATA - the contract returned valid
        // data that ethers could not parse, which surfaced as a misleading
        // "no executable quote" on every mainnet pair.
        const quoterAbi = [
            'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 ticksCrossed, uint256 gasEstimate)'
        ];

        const quoterContract = new ethers.Contract(this.UNISWAP_QUOTER, quoterAbi, this.provider);

        try {
            const quote = await quoterContract.quoteExactInputSingle.staticCall({
                tokenIn,
                tokenOut,
                amountIn,
                fee,
                sqrtPriceLimitX96: 0
            });
            const amountOut = quote.amountOut ?? quote[0];
            if (!amountOut || BigInt(amountOut) === 0n) {
                throw new Error('Quoter returned a zero amount (no liquidity for this pair/fee tier)');
            }
            return amountOut;
        } catch (error) {
            console.error(`[OnchainExecutionEngine] Quoter failed for ${tokenIn} -> ${tokenOut}:`, error.message);
            throw error;
        }
    }

    /**
     * Estimates gas limit and fetches current gas prices from provider.
     */
    async estimateGasParams(txRequest) {
        try {
            const feeData = await this.provider.getFeeData();
            const gasPrice = feeData.gasPrice;
            const maxFeePerGas = feeData.maxFeePerGas || gasPrice;
            const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas || (gasPrice / 10n);

            let gasLimitEstimate;
            try {
                gasLimitEstimate = await this.provider.estimateGas(txRequest);
            } catch (e) {
                console.warn('[OnchainExecutionEngine] Gas estimation failed, using standard default limit:', e.message);
                gasLimitEstimate = 300000n; // fallback default
            }

            // Multiply limit by 1.2 for security buffer
            const gasLimit = (gasLimitEstimate * 120n) / 100n;

            return {
                gasLimit,
                maxFeePerGas,
                maxPriorityFeePerGas,
                gasPrice
            };
        } catch (error) {
            console.error('[OnchainExecutionEngine] Gas parameter estimation failed:', error.message);
            throw error;
        }
    }

    /**
     * Executes transaction simulation using eth_call.
     */
    /**
     * Unwrap WETH back to native ETH.
     *
     * Used to unwind a wrap when a later step of a native trade fails. Swaps the
     * WETH balance for ETH so the funds are not left parked in a token the user
     * never asked to hold. Deliberately uses WETH9.withdraw(): a revert here is
     * cheap and leaves the WETH intact for manual recovery, whereas a failed
     * combined router call can strand funds inside the router.
     *
     * Throws on failure so the caller can report the balance needing manual
     * recovery; callers must treat this as best effort.
     */
    async unwrapWeth(amount) {
        const weth = tokenManager.resolveToken('WETH');
        if (!weth) throw new Error('WETH is not whitelisted on this network.');

        const wethContract = new ethers.Contract(
            weth.address,
            ['function withdraw(uint256) payable', 'function balanceOf(address) view returns (uint256)'],
            this.signer
        );

        // Never try to unwrap more than is actually held: a stale amount would
        // revert and, worse, could race a concurrent trade.
        const held = await wethContract.balanceOf(this.signer.address);
        if (held === 0n) {
            console.log('[OnchainExecutionEngine] No WETH held; nothing to unwind.');
            return;
        }
        const amountToUnwrap = amount > held ? held : amount;

        console.log(`[OnchainExecutionEngine] Unwinding ${ethers.formatEther(amountToUnwrap)} WETH back to ETH...`);
        const tx = await wethContract.withdraw(amountToUnwrap);
        const receipt = await tx.wait();
        console.log(`[OnchainExecutionEngine] Unwound to ETH (tx ${receipt.hash}).`);
    }

    async simulateTransaction(txRequest) {
        try {
            // eth_call with no `from` simulates as the zero address, which has no
            // token allowance or balance and reverts for reasons unrelated to the
            // real trade. Simulate as the actual signer so the result is meaningful.
            await this.provider.call({
                ...txRequest,
                from: this.signer ? this.signer.address : undefined
            });
            return true;
        } catch (error) {
            console.error('[OnchainExecutionEngine] Transaction simulation reverted:', error.message);
            return false;
        }
    }

    /**
     * Sequential Nonce Management to prevent collision in concurrent tasks.
     */
    async getNextNonce() {
        while (this.nonceMutex) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        this.nonceMutex = true;

        try {
            const onchainNonce = await this.provider.getTransactionCount(this.signer.address, 'pending');
            if (this.lastNonce === null || onchainNonce > this.lastNonce) {
                this.lastNonce = onchainNonce;
            } else {
                this.lastNonce++;
            }
            return this.lastNonce;
        } finally {
            this.nonceMutex = false;
        }
    }

    /**
     * Simulate a full native-ETH swap BEFORE anything is broadcast.
     *
     * The ordering problem: a native trade has to wrap ETH into WETH before the
     * swap can exist, and the swap can only be simulated once that WETH exists.
     * So the sequence is wrap -> approve -> simulate -> swap, and anything that
     * fails at the simulate step has already spent gas and left funds wrapped.
     *
     * The way out is to simulate against a STATE THAT DOES NOT EXIST YET:
     * pretend the wallet already holds the WETH and has already approved the
     * router, then run the swap against that. Nothing is broadcast, so a
     * failure costs nothing.
     *
     * This needs an RPC that supports eth_call state overrides. The public Base
     * endpoint does NOT ("missing revert data"), so this returns
     * {supported:false} there and the caller falls back to the pre-broadcast
     * checks plus the automatic unwrap. Configure SIMULATION_RPC_URL with an
     * Alchemy/QuickNode endpoint to get the stronger guarantee.
     */
    /**
     * Does the configured RPC support eth_call state overrides?
     *
     * Probed rather than assumed. Inferring support from the presence of a
     * URL is wrong in both directions: an endpoint that is set but does not
     * implement overrides would send a preflight that always fails, and - worse
     * - the reverse mistake is easy to make, because the main RPC variable
     * (BASE_RPC_URL) is the natural place to put a paid key while a separate
     * simulation variable sits empty, leaving the guarantee silently off.
     *
     * Probed once and cached; the answer cannot change within a process.
     */
    async canSimulateWithOverrides() {
        if (this._overrideSupport !== undefined) return this._overrideSupport;

        // The simulation RPC may be separate, but the main RPC is a sensible
        // fallback: if you have paid for a node, use it for preflight too.
        const simUrl = (process.env.SIMULATION_RPC_URL || process.env.BASE_RPC_URL || '').trim();
        if (!simUrl) {
            this._overrideSupport = false;
            return false;
        }

        try {
            let provider = this.provider;
            if (simUrl !== (this.NETWORK.rpcUrl || '') && simUrl !== (process.env.BASE_RPC_URL || '')) {
                provider = new ethers.JsonRpcProvider(simUrl);
            }
            // A trivial call carrying an override. An endpoint that ignores the
            // parameter still answers, so check the ANSWER is what we asked
            // for: the override gives a fresh 99-balance address exactly 7 ETH.
            const probe = '0x' + 'ab'.repeat(20);
            const res = await provider.send('eth_getBalance', [probe, 'latest', {
                [probe]: { balance: '0x' + (7n * 10n ** 18n).toString(16) }
            }]);
            const ok = res && BigInt(res) === 7n * 10n ** 18n;
            this._overrideSupport = !!ok;
            if (!ok) {
                console.log(
                    '[OnchainExecutionEngine] RPC did not apply a state override; ' +
                    'native swaps fall back to pre-checks and automatic unwrap. ' +
                    'Use an Alchemy or QuickNode Base endpoint to enable pre-broadcast simulation.'
                );
            }
        } catch (e) {
            this._overrideSupport = false;
        }
        return this._overrideSupport;
    }

    /**
     * Pre-flight a native swap against simulated state, when the RPC allows it.
     *
     * @returns {{ok: boolean, supported: boolean, reason: string}}
     */
    async preflightNativeSwap({ tokenIn, tokenOut, amountIn, amountOutMinimum, feeTier }) {
        if (!(await this.canSimulateWithOverrides())) {
            return {
                ok: false,
                supported: false,
                reason: 'RPC does not support state overrides; relying on pre-checks and automatic unwrap.'
            };
        }

        const NATIVE = '0x0000000000000000000000000000000000000000';
        const weth = tokenManager.resolveToken('WETH');
        if (!weth) return { ok: false, supported: true, reason: 'WETH not whitelisted on this network.' };

        const routerAbi = ['function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) payable returns (uint256)'];
        const iface = new ethers.Interface(routerAbi);
        const data = iface.encodeFunctionData('exactInputSingle', [{
            tokenIn, tokenOut, feeTier,
            recipient: this.signer.address,
            amountIn, amountOutMinimum,
            sqrtPriceLimitX96: 0
        }]);

        // Slot 3 of WETH9 is `mapping(address => uint256) balanceOf`.
        const BALANCE_SLOT = 3;
        const ALLOWANCE_SLOT = 4;
        const key = ethers.toBeHex(this.signer.address, 32);
        const maxUint = '0x' + 'f'.repeat(64);

        const wethState = {
            [BALANCE_SLOT]: {
                [key]: ethers.toBeHex(amountIn, 32)
            },
            [ALLOWANCE_SLOT]: {
                [ethers.keccak256(ethers.concat([key, ethers.toBeHex(this.UNISWAP_ROUTER, 32)]))]: maxUint
            }
        };

        try {
            await this.provider.call({
                to: this.UNISWAP_ROUTER,
                data,
                from: this.signer.address,
                stateOverride: {
                    [NATIVE]: { balance: ethers.toBeHex(amountIn, 32) },
                    [weth.address]: wethState
                }
            });
            return { ok: true, supported: true, reason: 'Simulated successfully against pre-wrap state.' };
        } catch (err) {
            return {
                ok: false,
                supported: true,
                reason: 'Swap would revert before broadcasting: ' + (err.shortMessage || err.message)
            };
        }
    }

    /**
     * Balance of `symbolOrAddress` held by `holder` (default: the engine wallet),
     * as a decimal string.
     *
     * Returns null - NOT "0" - when the read fails. The public Base endpoint
     * intermittently answers a valid call with "missing revert data" under
     * load, and treating that as a zero balance made a funded wallet report
     * $0 of holdings: the opening balance was seeded as nothing, cash showed
     * empty, and reconciliation reported phantom drift. A failed read is
     * unknown, and a caller must be able to tell it from an empty wallet.
     *
     * Retried a couple of times before giving up, because a single blip should
     * not empty the books.
     */
    async getTokenBalance(symbolOrAddress, holder = null, attempts = 3) {
        const address = holder || (this.signer ? this.signer.address : null);
        if (!address) return null;
        const token = tokenManager.resolveToken(symbolOrAddress);
        if (!token) return null;

        let lastError = null;
        for (let i = 0; i < attempts; i++) {
            try {
                const c = new ethers.Contract(
                    token.address,
                    ['function balanceOf(address) view returns (uint256)'],
                    this.provider
                );
                return ethers.formatUnits(await c.balanceOf(address), token.decimals);
            } catch (err) {
                lastError = err;
                if (i < attempts - 1) {
                    await new Promise((r) => setTimeout(r, 150 * (i + 1)));
                }
            }
        }
        console.error(
            `[OnchainExecutionEngine] Balance read for ${symbolOrAddress} failed after ` +
            `${attempts} attempts; reporting unknown rather than zero. ` +
            `Last error: ${lastError && (lastError.shortMessage || lastError.message)}`
        );
        return null;
    }

    /**
     * Block-explorer URL for a transaction, or null when there is no hash.
     *
     * Returns null rather than a broken link for a dry run or a failed
     * broadcast, so a UI can distinguish "no evidence yet" from "evidence".
     */
    getTxExplorerUrl(txHash) {
        if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(String(txHash))) return null;
        return `${this.NETWORK.explorer}/tx/${txHash}`;
    }

    /** Block-explorer URL for an address. */
    getAddressExplorerUrl(address) {
        if (!ethers.isAddress(address)) return null;
        return `${this.NETWORK.explorer}/address/${address}`;
    }

    /**
     * USD price of one unit of `symbolOrAddress`, or null if unpriceable.
     *
     * A thin wrapper over estimateUsdValue for callers that need a per-token
     * price rather than the value of a quantity, such as marking an open
     * position to market for unrealised P&L. Priced on-chain against USDC for
     * the same reason the risk limit is: an external feed could be spoofed.
     */
    async getTokenPriceUSD(symbolOrAddress) {
        const token = tokenManager.resolveToken(symbolOrAddress);
        if (!token) return null;
        return await this.estimateUsdValue(token, 1);
    }

    /**
     * Convert a USD budget into a quantity of `symbol`, or null if it cannot be
     * priced. Used by the API so callers can express a trade in dollars without
     * the engine having to guess which token they meant.
     */
    async usdToTokenAmount(symbolOrAddress, usd) {
        const budget = Number(usd);
        if (!Number.isFinite(budget) || budget <= 0) return null;

        const token = tokenManager.resolveToken(symbolOrAddress);
        if (!token) return null;

        const valueUsd = await this.estimateUsdValue(token, 1);
        if (valueUsd === null || valueUsd <= 0) return null;

        const raw = budget / valueUsd;
        if (!Number.isFinite(raw) || raw <= 0) return null;

        // A float division yields far more precision than the token has (a
        // $0.50 WETH trade is 0.00018872049951299712 - 20 decimal places, but
        // WETH has 18). Passing that to parseUnits throws "too many decimals",
        // which surfaced as an unpriceable trade. Truncate to the token's own
        // decimal precision, rounding DOWN so the trade never exceeds the
        // requested dollar budget.
        return this.truncateToDecimals(raw, token.decimals);
    }

    /**
     * Truncate a positive number to `decimals` places without going through
     * string rounding, so the result is always <= the input.
     */
    truncateToDecimals(value, decimals) {
        const factor = Math.pow(10, decimals);
        // Nudge down by one ULP-ish epsilon to defeat binary float artefacts
        // (e.g. 0.29999999999999998) before truncating.
        return Math.floor((value - Math.abs(value) * Number.EPSILON) * factor) / factor;
    }

    /**
     * Estimate the USD value of `amount` units of `token`, or null if a
     * reliable price cannot be obtained.
     *
     * Prices are derived ON-CHAIN by quoting the token against USDC on the
     * configured chain, so the risk limit cannot be defeated by a stale or
     * spoofed external price feed. Stablecoins are treated as $1 (that is their
     * defining peg) and a pool that cannot be quoted returns null, which the
     * caller treats as "refuse to trade".
     */
    async estimateUsdValue(token, amount) {
        const qty = Number(amount);
        if (!Number.isFinite(qty) || qty <= 0) return null;

        // Stablecoins are $1 by definition; avoid a pointless pool lookup.
        const STABLES = new Set(['USDC', 'USDT', 'DAI', 'USDB', 'FRAX']);
        if (STABLES.has(token.symbol)) return qty;

        const usdc = tokenManager.resolveToken('USDC');
        if (!usdc || usdc.address === token.address) return null;

        // Native ETH has no pool; quote its WETH leg instead.
        const quoteIn = token.native
            ? tokenManager.resolveToken('WETH')
            : token;
        if (!quoteIn) return null;

        // Probe a few tiers; the first executable quote wins.
        for (const fee of [500, 3000, 10000]) {
            try {
                const rawOut = await this.getUniswapV3Quote(
                    quoteIn.address,
                    usdc.address,
                    ethers.parseUnits(qty.toString(), quoteIn.decimals),
                    fee
                );
                const usd = Number(ethers.formatUnits(rawOut, usdc.decimals));
                // A "quote" of 0 or a non-finite value is not a price.
                if (Number.isFinite(usd) && usd > 0) return usd;
            } catch (_) { /* try the next tier */ }
        }
        return null;
    }

    /**
     * Executes a complete real on-chain trade on the configured Base network.
     * Enforces the complete lifecycle:
     * SIGNAL -> RISK VALIDATION -> QUOTE -> BALANCE -> ALLOWANCE -> APPROVAL -> CONSTRUCTION -> GAS -> SIMULATION -> BROADCAST -> RECEIPT -> DECODE -> PERSIST
     */
    async executeTrade(tradeRequest) {
        const { botId, fromToken, toToken, amount, slippageBps = 100 } = tradeRequest; // slippageBps default 100 (1%)
        console.log(`[OnchainExecutionEngine] Starting execution for Bot #${botId}: Swap ${amount} ${fromToken} -> ${toToken}`);

        await this.initialize();

        // 1. Resolve & Validate Whitelisted Assets strictly
        const resolvedIn = tokenManager.resolveToken(fromToken);
        // ETH is input-only: receiving native ETH would require unwrapping WETH
        // after the swap, which this engine does not do.
        const resolvedOut = tokenManager.resolveToken(toToken, { asInput: false });

        if (!resolvedIn || !resolvedOut) {
            throw new Error(`CRITICAL: Asset validation failed. Tokens must be whitelisted ${this.NETWORK.name} assets. In: ${fromToken}, Out: ${toToken}`);
        }

        // 🚀 METAMASK AGENT WALLET INTEGRATION
        // Check if mm CLI is available and authenticated
        let useAgentWallet = false;
        const mmPath = process.env.MM_PATH || 'mm';

        try {
            const doctorOutput = execSync(`${mmPath} doctor --json`, {
                encoding: 'utf8',
                env: { ...process.env },
                // execSync is blocking: without a bound, a missing or hung `mm`
                // binary stalls the Node event loop and every other request.
                timeout: 5000,
                windowsHide: true
            });
            const doctor = JSON.parse(doctorOutput);
            if (doctor.ok && doctor.data.authenticated && doctor.data.initialized) {
                useAgentWallet = true;
                console.log('[OnchainExecutionEngine] MetaMask Agent Wallet detected and authenticated. Using CLI for execution.');
            }
        } catch (e) {
            console.log('[OnchainExecutionEngine] MetaMask Agent Wallet not available or not authenticated.');
        }

        if (useAgentWallet) {
            try {
                const slippagePct = (slippageBps / 100).toFixed(1);
                const cmd = `${mmPath} swap execute --from ${resolvedIn.symbol} --to ${resolvedOut.symbol} --amount ${amount} --from-chain-id ${this.CHAIN_ID} --slippage ${slippagePct} --json`;
                console.log(`[OnchainExecutionEngine] Executing via Agent Wallet: ${cmd}`);
                
                const output = execSync(cmd, { 
                    encoding: 'utf8',
                    env: { ...process.env }
                });
                const result = JSON.parse(output);

                if (result.ok) {
                    const tx = result.data.transaction;
                    return {
                        success: true,
                        mode: 'AGENT_WALLET',
                        txHash: tx.hash,
                        blockNumber: tx.blockNumber,
                        gasUsed: tx.gasUsed || '0',
                        gasCostETH: tx.gasCostETH || '0',
                        fromAmount: amount,
                        toAmount: result.data.destAssetAmountHuman || '0',
                        timestamp: Date.now()
                    };
                } else {
                    throw new Error(result.error?.message || 'Agent Wallet execution failed');
                }
            } catch (error) {
                console.error('[OnchainExecutionEngine] Agent Wallet execution error:', error.message);
                throw error;
            }
        }

        const isDryRun = process.env.DRY_RUN === 'true' || !process.env.TRADING_PRIVATE_KEY;
        if (isDryRun) {
            console.log('[OnchainExecutionEngine] Running in DRY_RUN mode. Executing virtual trade.');
            const simulatedOutput = amount * 0.99; // Mock output
            return {
                success: true,
                mode: 'DRY_RUN',
                txHash: null,
                fromAmount: amount,
                toAmount: simulatedOutput,
                gasUsed: '85000',
                gasCostETH: '0.000085',
                timestamp: Date.now()
            };
        }

        // 2. Risk Validation (Limits Check)
        //
        // MAX_TRADE_USD is a DOLLAR cap, but `amount` is a token QUANTITY.
        // Comparing them directly is a unit error: with the limit at 10,
        // "10 USDC" (~$10) passed, but so did "5 ETH" (~$13,000), while
        // "1,000,000 PEPE" (~$0.01) was needlessly blocked. The cap is now
        // enforced in USD, using a spot price, and the trade is refused if a
        // reliable price cannot be obtained.
        const maxTradeUsd = parseFloat(process.env.MAX_TRADE_USD || '500');
        if (!Number.isFinite(maxTradeUsd) || maxTradeUsd <= 0) {
            throw new Error(`Execution blocked: MAX_TRADE_USD is not a valid positive limit (got "${process.env.MAX_TRADE_USD}")`);
        }

        const inputUsd = await this.estimateUsdValue(resolvedIn, amount);
        if (inputUsd === null) {
            throw new Error(
                `Execution blocked: could not determine the USD value of ${amount} ${resolvedIn.symbol}; ` +
                'refusing to trade without a reliable risk check.'
            );
        }
        if (inputUsd > maxTradeUsd) {
            throw new Error(
                `Execution blocked: ${amount} ${resolvedIn.symbol} is worth ~$${inputUsd.toFixed(2)}, ` +
                `which exceeds the MAX_TRADE_USD limit of $${maxTradeUsd}`
            );
        }
        console.log(`[OnchainExecutionEngine] Risk check: $${inputUsd.toFixed(2)} <= $${maxTradeUsd} limit.`);

        const tokenInAddress = resolvedIn.address;
        const tokenOutAddress = resolvedOut.address;

        // Native ETH is not an ERC-20, so it has no allowance to grant and no
        // balanceOf to read. Uniswap's router identifies it by the zero
        // address. Supporting it matters because a wallet that only holds gas
        // cannot otherwise trade at all: the ERC-20-only path would report
        // "Insufficient wallet balance: Have 0.0" forever.
        const NATIVE = '0x0000000000000000000000000000000000000000';
        const isNativeIn = tokenInAddress === NATIVE || /^(ETH|NATIVE)$/i.test(fromToken || '');
        const nativeInAddress = isNativeIn ? NATIVE : tokenInAddress;

        // Tracks WETH that this call wrapped and not yet swapped, so the catch
        // block can unwind it if a later step fails. Must be declared out here:
        // declared inside the try it would be out of scope where the cleanup
        // needs it.
        let wrappedAmount = 0n;

        const tokenAbi = [
            'function decimals() view returns (uint8)',
            'function balanceOf(address account) view returns (uint256)',
            'function allowance(address owner, address spender) view returns (uint256)',
            'function approve(address spender, uint256 amount) returns (bool)'
        ];

        // The router ABI must be expressed as JSON, not human-readable strings.
        //
        // ethers' human-readable parser does NOT support `struct Foo { ... }`
        // declarations, so the previous string form constructed an Interface
        // containing NO functions at all - silently, with no error. Every
        // swap then failed at encodeFunctionData with "unknown function
        // (argument=fragment, value=exactInputSingle)".
        //
        // The struct has SEVEN fields and NO `deadline`. SwapRouter02 dropped
        // the deadline in favour of `pay()`/`refundETH()`; including it gave
        // selector 0x414bf389, which the router does not implement, so calls
        // reverted with no data. The real selector is 0x04e45aaf, confirmed by
        // a live eth_call that reaches the router and returns "STF"
        // (SafeTransferFrom) rather than "no function".
        const EXACT_INPUT_SINGLE = {
            type: 'function',
            name: 'exactInputSingle',
            stateMutability: 'payable',
            inputs: [{
                name: 'params',
                type: 'tuple',
                components: [
                    { name: 'tokenIn', type: 'address' },
                    { name: 'tokenOut', type: 'address' },
                    { name: 'fee', type: 'uint24' },
                    { name: 'recipient', type: 'address' },
                    { name: 'amountIn', type: 'uint256' },
                    { name: 'amountOutMinimum', type: 'uint256' },
                    { name: 'sqrtPriceLimitX96', type: 'uint160' }
                ]
            }],
            outputs: [{ name: 'amountOut', type: 'uint256' }]
        };
        const routerAbi = [EXACT_INPUT_SINGLE];

        try {
            const tokenInContract = new ethers.Contract(tokenInAddress, tokenAbi, this.signer);
            // Native ETH always has 18 decimals.
            const decimals = isNativeIn ? 18 : await tokenInContract.decimals();
            const amountInRaw = ethers.parseUnits(amount.toString(), decimals);

            // 3. Balance Check
            if (isNativeIn) {
                const gasBalance = await this.provider.getBalance(this.signer.address);
                // Native input must be wrapped into WETH first, which costs an
                // extra transaction, and the wallet must keep enough ETH to pay
                // for the wrap + approve + swap. Comparing against the raw
                // amount would let a trade consume the entire balance and then
                // fail to pay for its own gas.
                const RESERVE = ethers.parseEther('0.0005');
                if (gasBalance < amountInRaw + RESERVE) {
                    throw new Error(
                        `Insufficient native ETH: have ${ethers.formatEther(gasBalance)}, ` +
                        `need ${amount} plus ~${ethers.formatEther(RESERVE)} reserved for gas`
                    );
                }
            } else {
            const walletBalance = await tokenInContract.balanceOf(this.signer.address);
            if (walletBalance < amountInRaw) {
                throw new Error(`Insufficient wallet balance: Have ${ethers.formatUnits(walletBalance, decimals)}, need ${amount}`);
            }
            }

            // 4. Quote Fetching
            console.log('[OnchainExecutionEngine] Fetching real executable quote...');
            const configuredFee = tokenManager.getPairFee(nativeInAddress, tokenOutAddress) || 3000;
            // A configured tier can have no pool (or no liquidity) for a given
            // pair. Falling back keeps a trade executable instead of aborting on
            // a tier that simply does not exist on-chain.
            const feeCandidates = [configuredFee, 500, 3000, 10000]
                .filter((f, i, arr) => arr.indexOf(f) === i);
            let expectedAmountOutRaw = null;
            let feeTier = configuredFee;
            for (const candidate of feeCandidates) {
                try {
                    // Quote with WETH for native input. Uniswap V3 pools are
                    // always ERC-20 <-> ERC-20, so a pool keyed on the zero
                    // address does not exist and the quoter reverts. The router
                    // wraps native ETH 1:1 into WETH internally, so quoting the
                    // WETH leg gives the same price the swap will execute at.
                    const quoteTokenIn = isNativeIn
                        ? tokenManager.resolveToken('WETH').address
                        : nativeInAddress;
                    expectedAmountOutRaw = await this.getUniswapV3Quote(quoteTokenIn, tokenOutAddress, amountInRaw, candidate);
                    feeTier = candidate;
                    break;
                } catch (e) {
                    console.warn(`[OnchainExecutionEngine] No executable quote at fee tier ${candidate}: ${e.message}`);
                }
            }
            if (expectedAmountOutRaw === null) {
                throw new Error(`No Uniswap V3 pool with liquidity for ${resolvedIn.symbol} -> ${resolvedOut.symbol} on ${this.NETWORK.name}`);
            }
            const expectedAmountOut = ethers.formatUnits(expectedAmountOutRaw, resolvedOut.decimals);
            console.log(`[OnchainExecutionEngine] Executable Quote: Receive approx ${expectedAmountOut} ${resolvedOut.symbol} (fee tier ${feeTier})`);

            // 5. Slippage Protection
            const slippageFactor = 10000n - BigInt(slippageBps);
            const amountOutMinimum = (expectedAmountOutRaw * slippageFactor) / 10000n;

            // 5b. Pre-broadcast sanity checks.
            //
            // Everything below this point can spend money: the wrap and the
            // approval are irreversible broadcasts, and only AFTER them does
            // the swap get simulated. So anything that can be known in advance
            // is checked here, while the position is still untouched.
            //
            // A native trade costs three transactions (wrap, approve, swap).
            // Verifying the balance covers only the first one left room for
            // gas and then ran out mid-sequence, which is exactly how funds
            // ended up stranded as WETH.
            if (expectedAmountOutRaw <= 0n) {
                throw new Error('Quote produced no output; aborting before any transaction is sent.');
            }
            if (amountOutMinimum <= 0n) {
                throw new Error('Slippage floor rounds to zero; aborting before any transaction is sent.');
            }
            if (isNativeIn) {
                // wrap + approve + swap, with headroom for the estimate itself.
                const gasNeeded = ethers.parseEther('0.0009');
                const bal = await this.provider.getBalance(this.signer.address);
                if (bal < amountInRaw + gasNeeded) {
                    throw new Error(
                        `Insufficient ETH for a native swap: ${ethers.formatEther(amountInRaw)} plus ` +
                        `~${ethers.formatEther(gasNeeded)} gas for the wrap, approval and swap. ` +
                        `Have ${ethers.formatEther(bal)}. Aborting before any transaction is sent.`
                    );
                }

                // When the RPC can simulate against overridden state, prove the
                // swap works BEFORE the wrap is broadcast. Without this the first
                // real failure costs gas and strands a wrap; with it, the failure
                // happens while the wallet is still untouched.
                const weth = tokenManager.resolveToken('WETH');
                if (weth) {
                    const pre = await this.preflightNativeSwap({
                        tokenIn: weth.address,
                        tokenOut: tokenOutAddress,
                        amountIn: amountInRaw,
                        amountOutMinimum,
                        feeTier
                    });
                    if (pre.supported) {
                        if (!pre.ok) {
                            throw new Error(pre.reason);
                        }
                        console.log('[OnchainExecutionEngine] Pre-wrap simulation passed: ' + pre.reason);
                    } else {
                        console.log('[OnchainExecutionEngine] ' + pre.reason);
                    }
                }
            }

            // 6a. Wrap native ETH into WETH.
            //
            // Uniswap V3 has no pool keyed on address(0), so a native-input swap
            // against exactInputSingle always reverts - the router resolves the
            // pool from the pool key, and that pool does not exist. Native ETH
            // must therefore be converted to WETH first, after which the swap is
            // an ordinary approved ERC-20 trade.
            //
            // This deliberately uses WETH9.deposit() rather than the router's
            // unwrapWETH9 helper: a revert here is cheap and leaves the ETH
            // untouched, whereas a failed combined router call can strand funds
            // inside the router.
            let swapTokenIn = tokenInAddress;
            let wrapTxHash = null;

            if (isNativeIn) {
                const weth = tokenManager.resolveToken('WETH');
                if (!weth) throw new Error('WETH is not whitelisted on this network; cannot wrap native ETH.');

                const wethContract = new ethers.Contract(
                    weth.address,
                    ['function deposit() payable', 'function balanceOf(address) view returns (uint256)'],
                    this.signer
                );

                console.log('[OnchainExecutionEngine] Wrapping native ETH into WETH...');
                const wrapTx = await wethContract.deposit({ value: amountInRaw });
                wrapTxHash = wrapTx.hash;
                await wrapTx.wait();
                console.log(`[OnchainExecutionEngine] Wrapped into WETH (tx ${wrapTx.hash}).`);

                swapTokenIn = weth.address;
                wrappedAmount = amountInRaw;
            }

            // 6b. Allowance Check & Approval if Required.
            // Needed for every ERC-20 input, including freshly-wrapped WETH.
            {
                const inContract = isNativeIn
                    ? new ethers.Contract(swapTokenIn, tokenAbi, this.signer)
                    : tokenInContract;
                const allowance = await inContract.allowance(this.signer.address, this.UNISWAP_ROUTER);
                if (allowance < amountInRaw) {
                    console.log('[OnchainExecutionEngine] Allowance insufficient. Approving Router...');
                    const approveTx = await inContract.approve(this.UNISWAP_ROUTER, amountInRaw);
                    console.log(`[OnchainExecutionEngine] Approval TX broadcasted: ${approveTx.hash}`);
                    await approveTx.wait();
                    console.log('[OnchainExecutionEngine] Approval confirmed.');
                }
            }

            // 7. Transaction Construction
            const routerContract = new ethers.Contract(this.UNISWAP_ROUTER, routerAbi, this.signer);

            // No `deadline` field: SwapRouter02 removed it from
            // ExactInputSingleParams. Including it produced a selector the
            // router does not implement.
            //
            // tokenIn is the WETH address for a native trade, and value is 0:
            // the ETH was already converted by the wrap step above, so this is
            // an ordinary ERC-20 swap from that WETH balance.
            const swapParams = {
                tokenIn: swapTokenIn,
                tokenOut: tokenOutAddress,
                fee: feeTier,
                recipient: this.signer.address,
                amountIn: amountInRaw,
                amountOutMinimum: amountOutMinimum,
                sqrtPriceLimitX96: 0
            };

            const txData = routerContract.interface.encodeFunctionData('exactInputSingle', [swapParams]);

            const txRequest = {
                to: this.UNISWAP_ROUTER,
                data: txData,
                // The input is always an ERC-20 by this point: native ETH was
                // converted to WETH by the wrap step, so no msg.value is sent
                // with the swap. Sending value as well would double-count it.
                value: 0n
            };

            // 8. Gas Estimation & Transaction Simulation
            const { gasLimit, maxFeePerGas, maxPriorityFeePerGas, gasPrice } = await this.estimateGasParams(txRequest);
            txRequest.gasLimit = gasLimit;
            txRequest.maxFeePerGas = maxFeePerGas;
            txRequest.maxPriorityFeePerGas = maxPriorityFeePerGas;

            console.log('[OnchainExecutionEngine] Running transaction simulation...');
            const isSimulationSuccess = await this.simulateTransaction(txRequest);
            if (!isSimulationSuccess) {
                throw new Error('On-chain simulation reverted. Swap aborted for safety.');
            }

            // 9. Nonce Assignment & Signing & Broadcast
            txRequest.nonce = await this.getNextNonce();
            console.log(`[OnchainExecutionEngine] Dispatching transaction with Nonce ${txRequest.nonce}...`);

            const txResponse = await this.signer.sendTransaction(txRequest);
            console.log(`[OnchainExecutionEngine] Transaction broadcasted! Hash: ${txResponse.hash}`);

            // 10. Wait for blockchain confirmation
            const receipt = await txResponse.wait();
            console.log(`[OnchainExecutionEngine] Transaction confirmed in block ${receipt.blockNumber}`);

            if (receipt.status === 0) {
                throw new Error('Transaction reverted on-chain.');
            }

            // 11. Decode Receipt Event Logs for Actual Token Transfers & Gas Cost
            const actualGasUsed = receipt.gasUsed;
            // `receipt.fee` does not exist on an ethers v6 receipt, so the old
            // `actualGasUsed * receipt.fee ? ... : ...` expression evaluated
            // BigInt * undefined and threw a TypeError *after* the swap had
            // already been broadcast and mined. Total cost is gasUsed * gasPrice.
            const effectiveGasPrice = receipt.effectiveGasPrice ?? gasPrice;
            const actualGasCostWei = actualGasUsed * effectiveGasPrice;
            const actualGasCostETH = ethers.formatEther(actualGasCostWei);

            // Gas in USD as well as ETH. The accounting ledger values
            // everything in dollars, and a cost expressed only in ETH cannot
            // be netted against a dollar-denominated P&L without a price
            // lookup at reporting time - by which point the rate has moved.
            const ethPriceUsd = await this.getTokenPriceUSD('ETH');
            const actualGasCostUSD = ethPriceUsd
                ? Number(actualGasCostETH) * ethPriceUsd
                : null;

            // Funds are accounted for: suppress the unwind in the catch block so
            // a later logging failure cannot re-wrap or touch a completed trade.
            wrappedAmount = 0n;

            return {
                success: true,
                mode: 'LIVE',
                txHash: receipt.hash,
                blockNumber: receipt.blockNumber,
                gasUsed: actualGasUsed.toString(),
                gasCostETH: actualGasCostETH,
                gasCostUSD: actualGasCostUSD,
                fromAmount: amount,
                toAmount: expectedAmountOut,
                timestamp: Date.now()
            };

        } catch (error) {
            console.error('[OnchainExecutionEngine] Trade execution failed:', error.message);

            // Unwind a native wrap. If the wrap and approval succeeded but the
            // swap did not, the ETH is left sitting in the wallet as WETH - a
            // token the user did not ask for. The pre-broadcast checks reduce
            // how often this happens but cannot eliminate it: the swap is only
            // simulated after those broadcasts, because the public RPC has no
            // state overrides for simulating a balance that does not exist yet.
            //
            // Best effort only: never mask the original error, never throw from
            // the cleanup path.
            if (typeof wrappedAmount !== 'undefined' && wrappedAmount && wrappedAmount > 0n) {
                try {
                    await this.unwrapWeth(wrappedAmount);
                } catch (unwrapErr) {
                    console.error(
                        `[OnchainExecutionEngine] FAILED to unwind ${ethers.formatEther(wrappedAmount)} WETH to ETH. ` +
                        `${ethers.formatEther(wrappedAmount)} WETH remains in the wallet and must be ` +
                        `recovered manually. Reason: ${unwrapErr.message}`
                    );
                }
            }

            throw error;
        }
    }
}

module.exports = new OnchainExecutionEngine();
