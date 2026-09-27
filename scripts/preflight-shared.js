/**
 * Shared config + reporting helpers for the live-trading preflight check.
 * Kept separate so the check itself has no side effects on import.
 */

require('dotenv').config();

/**
 * Per-network deployment table. Uniswap V3 addresses are chain-specific: a
 * mainnet router/quoter address pointed at Sepolia returns no code and
 * reverts every call. Each entry was verified to return deployed bytecode.
 */
const NETWORKS = {
    8453: {
        name: 'Base Mainnet',
        rpc: 'https://mainnet.base.org',
        router: '0x2626664c2603336E57B271c5C0b26F421741e481',
        quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a'
    },
    84532: {
        name: 'Base Sepolia',
        rpc: 'https://sepolia.base.org',
        router: '0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4',
        quoter: '0xC5290058841028F1614F3A6F0F5816cAd0df5E27'
    }
};

let failures = 0;
const ok = (m) => console.log(`  [OK]   ${m}`);
const bad = (m) => { failures++; console.log(`  [FAIL] ${m}`); };
const warn = (m) => console.log(`  [WARN] ${m}`);

module.exports = { NETWORKS, ok, bad, warn, get failures() { return failures; } };