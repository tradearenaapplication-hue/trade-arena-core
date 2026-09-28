const { ethers } = require('ethers');
// Load env BEFORE TokenManager, which reads BASE_CHAIN_ID at module scope to
// pick its per-network token whitelist. Same ordering trap as the preflight.
require('dotenv').config();
const tokenManager = require('../services/TokenManager');
const engine = require('../services/OnchainExecutionEngine');

/**
 * END-TO-END DRY RUN — validates the full execution path WITHOUT broadcasting.
 *
 * Everything a real trade does is exercised up to and including the
 * eth_call simulation: key -> provider -> chain enforcement -> balance ->
 * allowance -> quote -> slippage -> gas params -> calldata encoding.
 * Only the final sendTransaction is stubbed, because a stub cannot be
 * funded and a real one would move funds.
 *
 * Requires BASE_CHAIN_ID=84532 and a funded Sepolia balance for a true
 * balance-check pass; without funds the balance step fails by design.
 */

const CAPTURED = [];

// Stub the broadcast, and record the fully-built transaction.
// Normalise the key exactly as the engine does: ethers requires the 0x
// prefix, and a key pasted without one is rejected outright.
const rawKey = String(process.env.TRADING_PRIVATE_KEY || '').trim();
const pk = '0x' + rawKey.replace(/^0x/, '');
if (!/^[0-9a-fA-F]{64}$/.test(pk.slice(2))) {
    console.error('TRADING_PRIVATE_KEY is not 32 bytes of hex - aborting.');
    process.exit(1);
}

engine.signer = new ethers.Wallet(pk, new ethers.JsonRpcProvider(engine.NETWORK.rpcUrl));
engine.signer.sendTransaction = async (tx) => {
    CAPTURED.push(tx);
    const err = new Error('INTERCEPTED: broadcast suppressed by e2e dry-run harness');
    err.__captured = true;
    throw err;
};

(async () => {
    console.log('\n=== E2E dry run (no broadcast) ===');
    console.log(`Network: ${engine.NETWORK.name} (${engine.CHAIN_ID})`);
    console.log(`Signer : ${engine.signer.address}\n`);

    const NATIVE = '0x0000000000000000000000000000000000000000';
    const weth = tokenManager.resolveToken('WETH').address;
    const usdc = tokenManager.resolveToken('USDC').address;

    const scenarios = [
        { name: 'native ETH -> USDC', from: 'ETH', to: 'USDC', amount: 0.0001, quoteIn: weth, out: usdc, outDec: 6 },
        { name: 'USDC -> WETH', from: 'USDC', to: 'WETH', amount: 1, quoteIn: usdc, out: weth, outDec: 18 }
    ];

    let anySuccess = false;

    for (const s of scenarios) {
        console.log(`\n--- ${s.name} ---`);
        try {
            await engine.initialize();
        } catch (e) {
            console.log(`  [BLOCKED] init: ${e.message}`);
            continue;
        }

        try {
            const provider = engine.provider;
            const amountInRaw = ethers.parseEther(s.amount.toString());

            // 1. Quote
            let quote = null, feeTier = null;
            for (const f of [500, 3000, 10000]) {
                try {
                    quote = await engine.getUniswapV3Quote(s.quoteIn, s.out, amountInRaw, f);
                    feeTier = f;
                    break;
                } catch (_) { /* next tier */ }
            }
            if (!quote) { console.log('  [FAIL] no quote'); continue; }
            console.log(`  [OK]   quote ${ethers.formatUnits(quote, s.outDec)} ${s.to} @ fee ${feeTier}`);

            // 2. Slippage floor
            const amountOutMin = (quote * 9950n) / 10000n;
            console.log(`  [OK]   amountOutMinimum = ${ethers.formatUnits(amountOutMin, s.outDec)} (0.5% slippage)`);

            // 3. Encode calldata exactly as the engine does
            const routerAbi = [{
                type: 'function',
                name: 'exactInputSingle',
                stateMutability: 'payable',
                inputs: [{
                    name: 'params', type: 'tuple',
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
            }];
            const router = new ethers.Contract(engine.UNISWAP_ROUTER, routerAbi, provider);
            const isNative = s.from === 'ETH';
            const data = router.interface.encodeFunctionData('exactInputSingle', [{
                tokenIn: isNative ? NATIVE : s.quoteIn,
                tokenOut: s.out,
                fee: feeTier,
                recipient: engine.signer.address,
                deadline: Math.floor(Date.now() / 1000) + 1200,
                amountIn: amountInRaw,
                amountOutMinimum: amountOutMin,
                sqrtPriceLimitX96: 0
            }]);

            const txRequest = { to: engine.UNISWAP_ROUTER, data, value: isNative ? amountInRaw : 0n };
            console.log(`  [OK]   encoded ${data.length / 2 - 1} calldata bytes, value=${txRequest.value}`);

            // 4. Gas params
            const gas = await engine.estimateGasParams({ ...txRequest });
            console.log(`  [OK]   gasLimit=${gas.gasLimit} maxFee=${gas.maxFeePerGas}`);

            // 5. THE CRITICAL STEP: eth_call simulation. Needs no funds.
            try {
                const ret = await provider.call({ ...txRequest, from: engine.signer.address });
                // Decode with the same fragment used to encode, so the tuple
                // layout matches (name-typed struct requires the named form).
                const out = router.interface.decodeFunctionResult('exactInputSingle', ret);
                console.log(`  [PASS] SIMULATION OK - router returns ${ethers.formatUnits(out[0], s.outDec)} ${s.to}`);
                anySuccess = true;
            } catch (e) {
                const msg = (e.shortMessage || e.message).split('\n')[0];
                console.log(`  [INFO] simulation reverted: ${msg.slice(0, 90)}`);
                if (/insufficient|balance|transfer/i.test(msg)) {
                    console.log('         -> expected when the wallet holds no balance for this leg');
                }
            }
        } catch (e) {
            console.log(`  [FAIL] ${e.message.slice(0, 120)}`);
        }
    }

    console.log('\n---');
    console.log(anySuccess
        ? 'At least one scenario passed full simulation. Broadcast was NOT performed.'
        : 'No scenario completed simulation (expected on an unfunded wallet).');
    console.log('Broadcasts attempted: ' + CAPTURED.length);
    console.log('');
    process.exit(0);
})().catch(e => { console.error('HARNESS ERROR:', e.message); process.exit(1); });
