#!/usr/bin/env node
/**
 * Poll a Base Sepolia (or mainnet) balance until it clears a threshold.
 *
 * Run this in the background while you use a faucet, then check back:
 *   node scripts/watch-balance.js 0.05 84532
 *
 * Read-only: it never signs or sends anything.
 */

const { ethers } = require('ethers');

const RPC = {
    1: 'https://mainnet.base.org',
    8453: 'https://mainnet.base.org',
    84532: 'https://sepolia.base.org'
};

(async () => {
    const args = process.argv.slice(2);
    if (args.length < 2) {
        console.log('Usage: node scripts/watch-balance.js <thresholdETH> [chainId] [address]');
        process.exit(1);
    }

    const threshold = parseFloat(args[0]);
    const chainId = parseInt(args[1] || '84532', 10);
    const rpc = RPC[chainId];
    if (!rpc) { console.error(`No RPC known for chain ${chainId}`); process.exit(1); }

    // Default to the trading wallet, but allow an override argument.
    require('dotenv').config();
    const address = args[2] || '0x92CEAf1CA43deCfc443A34B915B45343BeE9c2DB';

    console.log(`Watching ${address}`);
    console.log(`  chain ${chainId} via ${rpc}`);
    console.log(`  waiting for >= ${threshold} ETH\n`);

    const provider = new ethers.JsonRpcProvider(rpc);
    let last = null;

    for (let i = 0; i < 60; i++) {
        let bal;
        try {
            bal = await provider.getBalance(address);
        } catch (e) {
            console.log(`  [${i}] RPC error: ${e.message.slice(0, 60)}`);
            await new Promise(r => setTimeout(r, 10000));
            continue;
        }

        const eth = Number(ethers.formatEther(bal));
        if (eth !== last) {
            console.log(`  [${new Date().toISOString().slice(11, 19)}] balance = ${eth} ETH`);
            last = eth;
        }

        if (eth >= threshold) {
            console.log(`\nFUNDED: ${eth} ETH on chain ${chainId}`);
            console.log('Next: node scripts/e2e-testnet-dryrun.js');
            process.exit(0);
        }

        await new Promise(r => setTimeout(r, 10000));
    }

    console.log(`\nTimed out after 10 minutes. Balance is still ${last} ETH.`);
    console.log('Re-run this script, or try a different faucet.');
    process.exit(1);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
