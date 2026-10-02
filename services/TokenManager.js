/**
 * TOKEN MANAGER (Backend)
 * Trade Arena • Manages whitelisted trading assets and pool fees.
 *
 * Token addresses are network-specific. USDC in particular has different
 * contracts on Base Mainnet and Base Sepolia, so a single hardcoded whitelist
 * silently points at an address with no liquidity on the other network. The
 * whitelist is therefore selected by BASE_CHAIN_ID, matching the engine.
 */

const chainId = parseInt(process.env.BASE_CHAIN_ID || '8453', 10);

// Native ETH, valid as swap INPUT only (it can never be the output token).
// Represented by the zero address, which is how Uniswap's router identifies it.
const NATIVE_ETH = {
    address: '0x0000000000000000000000000000000000000000',
    decimals: 18,
    symbol: 'ETH',
    name: 'Native Ether',
    native: true
};

// Base Mainnet canonical tokens.
const MAINNET_TOKENS = {
    'USDC': {
        address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        decimals: 6,
        symbol: 'USDC',
        name: 'USD Coin'
    },
    'WETH': {
        address: '0x4200000000000000000000000000000000000006',
        decimals: 18,
        symbol: 'WETH',
        name: 'Wrapped Ethereum'
    },
    'WBTC': {
        // VERIFIED ON-CHAIN: getCode() returns 13649 bytes and the token
        // responds to symbol()/decimals() as WBTC/8.
        //
        // The previous address (0x03C6...BCE62) was checksum-valid but had NO
        // CODE on Base - it was never a contract here. That made every WBTC
        // quote revert, which silently poisoned every route pairing WBTC with
        // any other token and was the largest single cause of failed quotes in
        // the flash-arb scan. A valid checksum is NOT evidence a token exists;
        // only eth_getCode is.
        address: '0x0555e30da8f98308edb960aa94c0db47230d2b9c',
        decimals: 8,
        symbol: 'WBTC',
        name: 'Wrapped Bitcoin'
    },
    'CBBTC': {
        address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
        decimals: 8,
        symbol: 'cbBTC',
        name: 'Coinbase Wrapped BTC'
    },
    'PEPE': {
        address: '0x698dc45e4f10966f6d1d98e3bfd7071d8144c233',
        decimals: 18,
        symbol: 'PEPE',
        name: 'Pepe'
    },
    'SOL': {
        // VERIFIED ON-CHAIN: getCode() returns 82 bytes (an ERC-20 proxy
        // wrapper) and the token reports SOL/9.
        //
        // The previous address (0x2968...3366) was checksum-valid but had NO
        // CODE on Base. Fixing the checksum earlier only made a non-existent
        // address well-formed, which is a different bug wearing the same
        // disguise: it turned a loud "bad checksum" into a silent
        // "missing revert data" on every SOL quote.
        address: '0x311935cd80b76769bf2ecc9d8ab7635b2139cf82',
        decimals: 9,
        symbol: 'SOL',
        name: 'Wrapped SOL'
    }
};

// Base Sepolia tokens. WETH is the same address on both networks; USDC is
// the Circle testnet deployment and is NOT the mainnet USDC address.
const SEPOLIA_TOKENS = {
    'USDC': {
        address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        decimals: 6,
        symbol: 'USDC',
        name: 'USD Coin (Sepolia)'
    },
    'WETH': {
        address: '0x4200000000000000000000000000000000000006',
        decimals: 18,
        symbol: 'WETH',
        name: 'Wrapped Ethereum'
    }
};

const WHITELISTS = {
    8453: MAINNET_TOKENS,
    84532: SEPOLIA_TOKENS
};

class TokenManager {
    constructor() {
        // Base Mainnet Whitelisted Tokens
        this.whitelist = WHITELISTS[chainId] || MAINNET_TOKENS;
        this.chainId = WHITELISTS[chainId] ? chainId : 8453;

        // Configuration-driven whitelisted pairs and Uniswap V3 fee tiers (3000 = 0.3%, 500 = 0.05%)
        this.pairs = {
            'WETH/USDC': { tokenIn: 'USDC', tokenOut: 'WETH', fee: 500 },
            'WBTC/WETH': { tokenIn: 'WETH', tokenOut: 'WBTC', fee: 3000 },
            'CBBTC/USDC': { tokenIn: 'USDC', tokenOut: 'cbBTC', fee: 3000 },
            'PEPE/WETH': { tokenIn: 'WETH', tokenOut: 'PEPE', fee: 10000 },
            'SOL/USDC': { tokenIn: 'USDC', tokenOut: 'SOL', fee: 3000 }
        };
    }

    /**
     * Checks if a token symbol or address is in the whitelist.
     */
    isTokenWhitelisted(symbolOrAddress) {
        if (!symbolOrAddress) return false;

        const clean = symbolOrAddress.trim().toUpperCase();
        if (this.whitelist[clean]) return true;

        const addrLower = symbolOrAddress.trim().toLowerCase();
        return Object.values(this.whitelist).some(t => t.address.toLowerCase() === addrLower);
    }

    /**
     * Resolves token symbol or address to its whitelisted metadata.
     *
     * Native ETH is always resolvable as a symbol or the zero address, but it
     * is a valid INPUT only. resolveToken(token, { asInput: false }) rejects
     * it, which keeps a nonsensical "buy ETH with ETH" request from reaching
     * the router and reverting.
     */
    resolveToken(symbolOrAddress, opts = {}) {
        if (!symbolOrAddress) return null;

        const clean = symbolOrAddress.trim().toUpperCase();
        const addrLower = symbolOrAddress.trim().toLowerCase();
        const wantsNative = clean === 'ETH' || clean === 'NATIVE'
            || addrLower === NATIVE_ETH.address;

        let found = this.whitelist[clean]
            || Object.values(this.whitelist).find(t => t.address.toLowerCase() === addrLower)
            || null;

        if (!found && wantsNative) found = NATIVE_ETH;

        if (found && found.native && opts.asInput === false) return null;

        return found;
    }

    /**
     * Gets verified fee tier for a given pair.
     */
    getPairFee(tokenA, tokenB) {
        const symbolA = this.resolveToken(tokenA)?.symbol;
        const symbolB = this.resolveToken(tokenB)?.symbol;

        if (!symbolA || !symbolB) return null;

        const key1 = `${symbolA}/${symbolB}`;
        const key2 = `${symbolB}/${symbolA}`;

        if (this.pairs[key1]) return this.pairs[key1].fee;
        if (this.pairs[key2]) return this.pairs[key2].fee;

        return 3000; // default to standard 0.3% pool tier
    }
}

module.exports = new TokenManager();
