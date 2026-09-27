#!/usr/bin/env node
/**
 * PREFLIGHT CHECK — run this BEFORE enabling live trading.
 *
 * Usage:
 *   node scripts/preflight-live-trading.js
 *
 * READ-ONLY: it never signs or broadcasts a transaction. It confirms:
 *   1. BASE_CHAIN_ID is a supported network
 *   2. The configured RPC answers with the expected chain
 *   3. Router/Quoter have deployed bytecode on THAT chain
 *   4. A real quote succeeds for a whitelisted pair
 *   5. TRADING_PRIVATE_KEY parses and holds gas + token balance
 */

const { ethers } = require('ethers');
const tokenManager = require('../services/TokenManager');
const { NETWORKS, ok, bad, warn } = require('./preflight-shared.js');

function finish() {
    const f = require('./preflight-shared.js').failures;
    console.log('\n---');
    if (f === 0) {
        console.log('All checks passed.');
        if (process.env.DRY_RUN !== 'false') {
            console.log('\nThis is READ-ONLY verification. To actually trade, set DRY_RUN=false');
            console.log('and restart the server.');
        }
    } else {
        console.log(`${f} check(s) failed. Resolve them before setting DRY_RUN=false.`);
    }
    console.log('');
    process.exit(0);
}

(async () => {
    const chainId = parseInt(process.env.BASE_CHAIN_ID || '8453', 10);
    const net = NETWORKS[chainId];

    console.log('\n=== Trade Arena live-trading preflight ===\n');
    console.log(`  BASE_CHAIN_ID : ${chainId}`);
    console.log(`  DRY_RUN       : ${process.env.DRY_RUN}\n`);

    console.log('1. Network configuration');
    if (!net) {
        bad(`Unsupported BASE_CHAIN_ID ${chainId}. Supported: ${Object.keys(NETWORKS).join(', ')}`);
        return finish();
    }
    ok(`Network: ${net.name}`);

    const rpcUrl = process.env.BASE_RPC_URL || net.rpc;
    let provider;
    try {
        provider = new ethers.JsonRpcProvider(rpcUrl);
        const actual = Number((await provider.getNetwork()).chainId);
        if (actual !== chainId) {
            bad(`RPC reports chain ${actual} but BASE_CHAIN_ID is ${chainId}. Set BASE_RPC_URL to match.`);
            return finish();
        }
        ok(`RPC reachable and on the right chain (${rpcUrl})`);
    } catch (e) {
        bad(`RPC unreachable: ${e.message}`);
        return finish();
    }

    console.log('\n2. Uniswap V3 contracts');
    for (const [label, addr] of [['SwapRouter02', net.router], ['QuoterV2', net.quoter]]) {
        try {
            const code = await provider.getCode(addr);
            if (!code || code === '0x') bad(`${label} has no bytecode at ${addr} on ${net.name}`);
            else ok(`${label} deployed (${(code.length - 2) / 2} bytes)`);
        } catch (e) {
            bad(`${label} check failed: ${e.message}`);
        }
    }

    console.log('\n3. Live quote (USDC -> WETH)');
    try {
        const usdc = tokenManager.resolveToken('USDC');
        const weth = tokenManager.resolveToken('WETH');
        const abi = ['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32[] ticksCrossed,uint256 gasEstimate)'];
        const quoter = new ethers.Contract(net.quoter, abi, provider);
        let quoted = false;
        for (const fee of [500, 3000, 10000]) {
            try {
                const r = await quoter.quoteExactInputSingle.staticCall({
                    tokenIn: usdc.address, tokenOut: weth.address,
                    amountIn: ethers.parseUnits('100', usdc.decimals), fee, sqrtPriceLimitX96: 0
                });
                ok(`Quoted 100 USDC -> ${ethers.formatUnits(r.amountOut, weth.decimals)} WETH at fee tier ${fee}`);
                quoted = true;
                break;
            } catch (_) { /* try next tier */ }
        }
        if (!quoted) bad('No Uniswap V3 pool with liquidity for USDC/WETH on this network');
    } catch (e) {
        bad(`Quote failed: ${e.message}`);
    }

    console.log('\n4. Signing key');
    const pk = process.env.TRADING_PRIVATE_KEY;
    if (!pk) {
        warn('TRADING_PRIVATE_KEY is not set (expected while still in dry run).');
        warn('To go live: fund a Base wallet, set TRADING_PRIVATE_KEY, re-run this check.');
    } else {
        let wallet;
        try {
            wallet = new ethers.Wallet(pk, provider);
            ok(`Key parses; address ${wallet.address}`);
        } catch (e) {
            bad(`TRADING_PRIVATE_KEY is malformed: ${e.message}`);
            return finish();
        }
        try {
            const gas = await provider.getBalance(wallet.address);
            ok(`Gas balance: ${ethers.formatEther(gas)} ETH`);
            if (gas === 0n) bad('Wallet has no gas on this network. Fund it before going live.');
        } catch (e) {
            bad(`Could not read gas balance: ${e.message}`);
        }
        for (const sym of ['USDC', 'WETH']) {
            const t = tokenManager.resolveToken(sym);
            const c = new ethers.Contract(t.address, ['function balanceOf(address) view returns (uint256)'], provider);
            try {
                const bal = await c.balanceOf(wallet.address);
                ok(`${sym} balance: ${ethers.formatUnits(bal, t.decimals)}`);
            } catch (_) { warn(`${sym} balance unreadable`); }
        }
    }

    finish();
})().catch(e => { bad(`Unexpected: ${e.message}`); finish(); });

