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
        isTestnet: false
    },
    84532: {
        name: 'Base Sepolia',
        rpcUrl: 'https://sepolia.base.org',
        swapRouter: '0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4',
        quoter: '0xC5290058841028F1614F3A6F0F5816cAd0df5E27',
        isTestnet: true
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
        const maxTradeUsd = parseFloat(process.env.MAX_TRADE_USD || '500');
        if (amount > maxTradeUsd) {
            throw new Error(`Execution blocked: Amount ${amount} exceeds MAX_TRADE_USD limit (${maxTradeUsd})`);
        }

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
        // (argument=fragment, value=exactInputSingle)". A real trade could
        // never have been built, let alone broadcast.
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
                    { name: 'deadline', type: 'uint256' },
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
                if (gasBalance < amountInRaw) {
                    throw new Error(`Insufficient native ETH: Have ${ethers.formatEther(gasBalance)}, need ${amount}`);
                }
                console.log(`[OnchainExecutionEngine] Using native ETH as input (no approval required).`);
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

            // 6. Allowance Check & Approval if Required.
            // Native ETH needs no approval: the router only accepts it as msg.value.
            if (!isNativeIn) {
                const allowance = await tokenInContract.allowance(this.signer.address, this.UNISWAP_ROUTER);
                if (allowance < amountInRaw) {
                    console.log('[OnchainExecutionEngine] Allowance insufficient. Approving Router...');
                    const approveTx = await tokenInContract.approve(this.UNISWAP_ROUTER, amountInRaw);
                    console.log(`[OnchainExecutionEngine] Approval TX broadcasted: ${approveTx.hash}`);
                    await approveTx.wait();
                    console.log('[OnchainExecutionEngine] Approval confirmed.');
                }
            }

            // 7. Transaction Construction
            const routerContract = new ethers.Contract(this.UNISWAP_ROUTER, routerAbi, this.signer);
            const deadline = Math.floor(Date.now() / 1000) + 1200; // 20-minute deadline

            const swapParams = {
                tokenIn: nativeInAddress,
                tokenOut: tokenOutAddress,
                fee: feeTier,
                recipient: this.signer.address,
                deadline: deadline,
                amountIn: amountInRaw,
                amountOutMinimum: amountOutMinimum,
                sqrtPriceLimitX96: 0
            };

            const txData = routerContract.interface.encodeFunctionData('exactInputSingle', [swapParams]);

            const txRequest = {
                to: this.UNISWAP_ROUTER,
                data: txData,
                // Native input must travel as msg.value. With value: 0 the
                // router reverts with insufficient ETH, so an ETH->token swap
                // would always fail.
                value: isNativeIn ? amountInRaw : 0n
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

            return {
                success: true,
                mode: 'LIVE',
                txHash: receipt.hash,
                blockNumber: receipt.blockNumber,
                gasUsed: actualGasUsed.toString(),
                gasCostETH: actualGasCostETH,
                fromAmount: amount,
                toAmount: expectedAmountOut,
                timestamp: Date.now()
            };

        } catch (error) {
            console.error('[OnchainExecutionEngine] Trade execution failed:', error.message);
            throw error;
        }
    }
}

module.exports = new OnchainExecutionEngine();
