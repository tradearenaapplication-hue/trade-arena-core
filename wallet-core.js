/**
 * WALLET CORE - Trade Arena
 * ------------------------------------------------------------------
 * Single source of truth for EIP-1193 (MetaMask / injected wallet)
 * connection and on-chain balance synchronisation.
 *
 * Why this file exists:
 *   The app originally mixed ethers v5 APIs (ethers.providers.Web3Provider,
 *   provider.getSigner() as a sync call, ethers.utils.formatEther) with an
 *   ethers v6 UMD bundle. Every one of those calls throws at runtime, so the
 *   wallet never connected and the balance never synced.
 *
 * This module is deliberately version tolerant: it detects v5 vs v6 at
 * runtime and uses the correct API for whichever is present.
 *
 * Design note on balances:
 *   The on-chain wallet balance and the in-app trading balance are two
 *   different things. Refreshing the wallet balance must NOT overwrite the
 *   user's trading balance or P&L baseline. applyToApp() delegates to the
 *   host page (index.html), which owns those variables.
 */

const WalletCore = (() => {
  'use strict';

  // ═══════════════════════════════════════════════════════════
  // CONFIGURATION
  // ═══════════════════════════════════════════════════════════

  const CHAIN = {
    id: 8453,
    hex: '0x2105',
    name: 'Base Mainnet',
    rpcUrl: 'https://mainnet.base.org',
    explorerUrl: 'https://basescan.org',
  };

  // Networks scanned for the user's real holdings.
  /**
   * Public RPC endpoints, in preference order, per network.
   *
   * These are free, unauthenticated endpoints and they rot: `polygon-rpc.com`
   * now returns 401 ("tenant disabled") and `cloudflare-eth.com` returns
   * "Internal error" for every method. When that happened the balance scan
   * silently dropped those chains, because the callers below swallow errors
   * and return 0. So each network now carries several endpoints and rpcCall
   * walks the list until one answers.
   *
   * Keep this in sync with the CSP connect-src list in server.js.
   */
  const NETWORKS = [
    { name: 'Base',      chainId: 8453,  rpc: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com', 'https://base.drpc.org'],         nativeSymbol: 'ETH', coingeckoId: 'ethereum' },
    { name: 'Ethereum',  chainId: 1,     rpc: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://1rpc.io/eth'],              nativeSymbol: 'ETH', coingeckoId: 'ethereum' },
    { name: 'Arbitrum',  chainId: 42161, rpc: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com', 'https://arbitrum.drpc.org'],      nativeSymbol: 'ETH', coingeckoId: 'ethereum' },
    { name: 'Optimism',  chainId: 10,    rpc: ['https://mainnet.optimism.io', 'https://optimism-rpc.publicnode.com', 'https://optimism.drpc.org'],      nativeSymbol: 'ETH', coingeckoId: 'ethereum' },
    { name: 'Polygon',   chainId: 137,   rpc: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.drpc.org', 'https://1rpc.io/matic'],            nativeSymbol: 'POL', coingeckoId: 'matic-network' },
    { name: 'BSC',       chainId: 56,    rpc: ['https://bsc-dataseed.binance.org', 'https://bsc-rpc.publicnode.com', 'https://bsc.drpc.org'],                nativeSymbol: 'BNB', coingeckoId: 'binancecoin' },
  ];

  const TOKENS = {
    8453: [
      { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6,  coingeckoId: 'usd-coin' },
      { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18, coingeckoId: 'ethereum' },
      { symbol: 'DAI',  address: '0x50c5725949A6F0c72afAA8647BC0D4a6d7c15e50', decimals: 18, coingeckoId: 'dai' },
    ],
    1: [
      { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6,  coingeckoId: 'usd-coin' },
      { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6,  coingeckoId: 'tether' },
      { symbol: 'WBTC', address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8,  coingeckoId: 'wrapped-bitcoin' },
    ],
  };

  const STABLES = ['USDC', 'USDT', 'DAI'];
  const PRICE_TTL_MS = 60_000;    // reuse spot prices for 60s
  const REQUEST_TIMEOUT = 6000;   // per-network RPC timeout

  // ═══════════════════════════════════════════════════════════
  // STATE
  // ═══════════════════════════════════════════════════════════

  const state = {
    connected: false,
    address: null,
    chainId: null,
    chainName: CHAIN.name,
    isCorrectChain: false,
    provider: null,
    signer: null,
    ethBalance: 0,
    ethPrice: 0,
    usdBalance: 0,
    holdings: [],
    lastSync: 0,
    syncing: false,
    error: null,
  };

  const listeners = new Set();

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function emit(event, detail) {
    for (const fn of listeners) {
      try { fn(state, event, detail); }
      catch (e) { console.warn('[WalletCore] subscriber error:', e); }
    }
    try {
      window.dispatchEvent(new CustomEvent('walletStateChanged', {
        detail: { ...state, event },
      }));
    } catch (e) { /* non-browser context */ }
  }

  // ═══════════════════════════════════════════════════════════
  // ETHERS ACCESS (tolerates the defer / CDN load race)
  // ═══════════════════════════════════════════════════════════

  async function getEthers(timeoutMs = 20000) {
    const started = Date.now();
    for (;;) {
      const e = globalThis.ethers || (typeof ethers !== 'undefined' ? ethers : null);
      if (e) return e;
      if (Date.now() - started > timeoutMs) {
        throw new Error('ethers.js did not load. Check your connection to the CDN.');
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const isEthersV6 = (e) => typeof e.BrowserProvider === 'function';

  /**
   * Create a provider for the injected wallet using the API matching the loaded
   * ethers major version. v5 -> ethers.providers.Web3Provider,
   * v6 -> ethers.BrowserProvider.
   */
  async function makeProvider() {
    const e = await getEthers();
    if (!window.ethereum) throw new Error('No injected wallet found. Install MetaMask.');
    // 'any' lets the provider answer for any chain id, which matters while the
    // user sits on a chain other than Base.
    return isEthersV6(e)
      ? new e.BrowserProvider(window.ethereum, 'any')
      : new e.providers.Web3Provider(window.ethereum);
  }

  /** getSigner() is async in v6 and sync in v5 - awaiting handles both. */
  async function makeSigner(provider) {
    return await provider.getSigner();
  }

  const getInjected = () => window.ethereum || null;
  const hasWallet = () => !!(window.ethereum && typeof window.ethereum.request === 'function');

  // ═══════════════════════════════════════════════════════════
  // FORMAT HELPERS (v5 + v6 safe)
  // ═══════════════════════════════════════════════════════════

  const toBigInt = (v) => {
    if (typeof v === 'bigint') return v;
    if (v == null) return 0n;
    if (typeof v === 'number') return Number.isFinite(v) ? BigInt(Math.floor(v)) : 0n;
    if (typeof v === 'string') return v.trim() === '' ? 0n : BigInt(v);
    // ethers v5 BigNumber
    if (typeof v === 'object' && v._isBigNumber === true) return BigInt(v.toString());
    return 0n;
  };

  const formatEther = (wei) => {
    try {
      const e = globalThis.ethers;
      if (e && typeof e.formatEther === 'function') return e.formatEther(toBigInt(wei));
      if (e && e.utils && typeof e.utils.formatEther === 'function') {
        return e.utils.formatEther(toBigInt(wei));
      }
    } catch (err) { /* fall through to manual */ }
    const n = Number(toBigInt(wei)) / 1e18;
    return Number.isFinite(n) ? n.toString() : '0';
  };

  const formatUnits = (value, decimals) => {
    try {
      const e = globalThis.ethers;
      if (e && typeof e.formatUnits === 'function') {
        return e.formatUnits(toBigInt(value), decimals);
      }
      if (e && e.utils && typeof e.utils.formatUnits === 'function') {
        return e.utils.formatUnits(toBigInt(value), decimals);
      }
    } catch (err) { /* fall through */ }
    const d = Number(decimals);
    return (Number(toBigInt(value)) / Math.pow(10, d)).toString();
  };

  // ═══════════════════════════════════════════════════════════
  // HTTP HELPERS
  // ═══════════════════════════════════════════════════════════

  /**
   * Real timeout via AbortController. (The old code passed a bogus
   * `timeout` option to fetch(), which browsers ignore - so requests could
   * hang indefinitely and stall the balance sync.)
   */
  async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const res = await fetch(url, { ...options, signal: controller ? controller.signal : options.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  let priceCache = { at: 0, map: {} };
  let priceInFlight = null;

  /**
   * Cached CoinGecko spot prices. Never throws - on rate limit / offline it
   * degrades to whatever is already cached, and stablecoins fall back to $1.
   */
  async function getPrices(ids) {
    const unique = [...new Set((ids || []).filter(Boolean))];
    if (unique.length === 0) return {};

    const missing = unique.filter((id) => priceCache.map[id] == null);
    if (missing.length > 0) {
      // Coalesce concurrent callers onto a single in-flight request.
      priceInFlight = priceInFlight || (async () => {
        try {
          const url = 'https://api.coingecko.com/api/v3/simple/price?ids='
            + encodeURIComponent(missing.join(',')) + '&vs_currencies=usd';
          const res = await fetchWithTimeout(url, {}, 5000);
          const data = await res.json();
          priceCache = { at: Date.now(), map: { ...priceCache.map, ...data } };
        } catch (e) {
          console.warn('[WalletCore] price fetch failed:', e.message);
        } finally {
          priceInFlight = null;
        }
      })();
      await priceInFlight;
    }

    const out = {};
    for (const id of unique) {
      const p = priceCache.map[id]?.usd;
      if (p != null) out[id] = p;
    }
    return out;
  }

  /** ETH spot price in USD, with a sane fallback so pricing never NaNs out. */
  async function getEthPrice() {
    const prices = await getPrices(['ethereum']);
    return prices.ethereum || priceCache.map.ethereum?.usd || 0;
  }

  // ═══════════════════════════════════════════════════════════
  // RAW JSON-RPC READS (multi-chain holdings)
  // ═══════════════════════════════════════════════════════════

  /**
   * Try each endpoint for a network in turn until one answers.
   * Accepts a single URL or the NETWORKS array of fallbacks.
   */
  async function rpcCall(rpc, method, params) {
    const list = Array.isArray(rpc) ? rpc : [rpc];
    let lastErr = null;
    for (const endpoint of list) {
      try {
        const res = await fetchWithTimeout(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        }, 4000);
        const data = await res.json();
        if (data && data.error) throw new Error(data.error.message || 'RPC error');
        return data ? data.result : null;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('All RPC endpoints failed');
  }

  /**
   * Balance reads return 0n on failure so one bad chain cannot break the
   * whole sync - but that also meant a dead RPC looked identical to an empty
   * wallet. Warn when every endpoint for a chain failed, so a rotted endpoint
   * is visible in the console instead of silently zeroing a balance.
   */
  async function getNativeBalance(net, address) {
    try {
      return toBigInt(await rpcCall(net.rpc, 'eth_getBalance', [address, 'latest']));
    } catch (e) {
      console.warn(`[WalletCore] ${net.name}: native balance unavailable -`, e.message);
      return 0n;
    }
  }

  // ERC-20 balanceOf(address) selector 0x70a08231
  const BALANCE_OF_SELECTOR = '0x70a08231';

  async function getErc20Balance(net, tokenAddress, address) {
    try {
      const arg = address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
      const result = await rpcCall(
        net.rpc, 'eth_call',
        [{ to: tokenAddress, data: BALANCE_OF_SELECTOR + arg }, 'latest'],
      );
      if (!result || result === '0x') return 0n;
      return toBigInt(result);
    } catch (e) {
      console.warn(`[WalletCore] ${net.name}/${token.symbol}: balance unavailable -`, e.message);
      return 0n;
    }
  }

  /**
   * Scan the user's holdings across every supported network in parallel and
   * value them at spot. A single unreachable RPC no longer fails the whole
   * sync - each network settles independently.
   */
  async function fetchMultiChainTokenBalances(address) {
    const addr = address || state.address;
    if (!addr) return { address: null, totalUsd: 0, holdings: [] };

    const scans = NETWORKS.map(async (net) => {
      const found = [];

      const nativeWei = await getNativeBalance(net, addr);
      const nativeAmount = parseFloat(formatEther(nativeWei)) || 0;
      if (nativeAmount > 0) {
        found.push({
          network: net.name,
          symbol: net.nativeSymbol,
          amount: nativeAmount,
          coingeckoId: net.coingeckoId,
          contractAddress: null,
        });
      }

      for (const token of TOKENS[net.chainId] || []) {
        const raw = await getErc20Balance(net, token.address, addr);
        if (raw <= 0n) continue;
        const amount = parseFloat(formatUnits(raw, token.decimals)) || 0;
        if (amount > 0) {
          found.push({
            network: net.name,
            symbol: token.symbol,
            amount,
            coingeckoId: token.coingeckoId,
            contractAddress: token.address,
          });
        }
      }
      return found;
    });

    const settled = await Promise.allSettled(scans);
    const holdings = [];
    for (const r of settled) {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) holdings.push(...r.value);
    }

    const prices = await getPrices(holdings.map((h) => h.coingeckoId));
    let totalUsd = 0;
    for (const h of holdings) {
      const price = prices[h.coingeckoId] || (STABLES.includes(h.symbol) ? 1 : 0);
      h.priceUsd = price;
      h.valueUsd = h.amount * price;
      totalUsd += h.valueUsd;
    }

    return { address: addr, totalUsd, holdings };
  }

  // ═══════════════════════════════════════════════════════════
  // NETWORK / CHAIN
  // ═══════════════════════════════════════════════════════════

  const KNOWN_CHAINS = {
    8453: CHAIN.name,
    1: 'Ethereum Mainnet',
    42161: 'Arbitrum One',
    10: 'OP Mainnet',
    137: 'Polygon',
    56: 'BNB Smart Chain',
  };

  /** Chain id as a Number, regardless of whether the provider returns bigint/string. */
  function toChainIdNumber(v) {
    if (typeof v === 'bigint') return Number(v);
    if (typeof v === 'string') return parseInt(v, v.startsWith('0x') ? 16 : 10);
    if (typeof v === 'number') return v;
    return NaN;
  }

  async function refreshChainInfo() {
    const injected = getInjected();
    if (!injected) return;
    try {
      const hex = await injected.request({ method: 'eth_chainId' });
      const id = toChainIdNumber(hex);
      state.chainId = id;
      state.chainName = KNOWN_CHAINS[id] || `Chain ${id}`;
      state.isCorrectChain = id === CHAIN.id;
    } catch (e) {
      console.warn('[WalletCore] could not read chain id:', e.message);
    }
  }

  /**
   * Switch the wallet to Base Mainnet, adding the network first if the
   * wallet does not know it yet (EIP-3085 error 4902).
   * Returns true on success. Never throws.
   */
  async function ensureBaseNetwork() {
    const injected = getInjected();
    if (!injected) return false;

    try {
      await injected.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: CHAIN.hex }],
      });
      await refreshChainInfo();
      return true;
    } catch (switchError) {
      if (switchError && switchError.code === 4902) {
        try {
          await injected.request({
            method: 'wallet_addEthereumChain',
            params: [{
              chainId: CHAIN.hex,
              chainName: CHAIN.name,
              rpcUrls: [CHAIN.rpcUrl],
              blockExplorerUrls: [CHAIN.explorerUrl],
              nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
            }],
          });
          await refreshChainInfo();
          return true;
        } catch (addError) {
          console.warn('[WalletCore] could not add Base:', addError.message);
          return false;
        }
      }
      // 4001 = user rejected the switch. Not fatal: read-only features still work.
      console.warn('[WalletCore] chain switch failed:', switchError?.code || switchError?.message);
      await refreshChainInfo();
      return false;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // BALANCE SYNC
  // ═══════════════════════════════════════════════════════════

  /**
   * Refresh all wallet-derived state and push it to the app.
   *
   * `initial` is true only on a fresh login, and is what tells the app it may
   * seed its trading balance from the wallet. Subsequent syncs deliberately
   * do NOT touch the trading balance or the P&L baseline - doing so was the
   * bug that reset the user's balance and re-armed the drawdown breaker on
   * every refresh.
   */
  async function sync({ initial = false } = {}) {
    if (!state.address) return null;
    if (state.syncing) return { address: state.address, totalUsd: state.usdBalance, holdings: state.holdings };

    state.syncing = true;
    state.error = null;

    try {
      await refreshChainInfo();

      // Native balance on the connected chain, straight from the provider.
      let ethBalance = 0;
      if (state.provider) {
        try {
          const wei = await state.provider.getBalance(state.address);
          ethBalance = parseFloat(formatEther(wei)) || 0;
        } catch (e) {
          console.warn('[WalletCore] native balance read failed:', e.message);
        }
      }

      const ethPrice = await getEthPrice();
      const { totalUsd, holdings } = await fetchMultiChainTokenBalances(state.address);

      state.ethBalance = ethBalance;
      state.ethPrice = ethPrice;
      // Prefer the multi-chain total; fall back to valuing the native balance
      // if the cross-chain scan came back empty.
      state.usdBalance = totalUsd > 0
        ? totalUsd
        : (ethPrice > 0 ? ethBalance * ethPrice : 0);
      state.holdings = holdings;
      state.lastSync = Date.now();
      state.connected = true;

      if (typeof window !== 'undefined') {
        window.userTokenHoldings = holdings;
        mirrorToLegacyState();
      }

      applyToApp({ initial });
      emit('sync', { initial, usdBalance: state.usdBalance });
      return { address: state.address, totalUsd: state.usdBalance, holdings };
    } catch (e) {
      state.error = e.message || String(e);
      console.warn('[WalletCore] sync failed:', state.error);
      emit('sync-error', { error: state.error });
      return null;
    } finally {
      state.syncing = false;
    }
  }

  /**
   * Keep the legacy real-wallet.js `walletState` object in step.
   * index.html still reads walletState in several places, so we mirror rather
   * than force a full refactor of every call site.
   */
  function mirrorToLegacyState() {
    if (typeof window === 'undefined') return;
    const ws = window.walletState;
    if (!ws || typeof ws !== 'object') return;
    ws.isConnected = state.connected;
    ws.address = state.address;
    ws.provider = state.provider;
    ws.signer = state.signer;
    ws.networkId = state.chainId;
    ws.isCorrectNetwork = state.isCorrectChain;
    ws.balanceETH = state.ethBalance;
    ws.balanceUSD = state.usdBalance;
    ws.tokenHoldings = state.holdings;
  }

  /**
   * Hand the synced values to the host page.
   * The page owns `balance` / `startBalance` as script-scoped `let` bindings,
   * so it must expose an explicit setter; there is no way to assign them from
   * here without clobbering live trading state.
   */
  function applyToApp({ initial = false } = {}) {
    if (typeof window === 'undefined') return;
    try {
      if (typeof window.TA_syncWalletBalance === 'function') {
        window.TA_syncWalletBalance({
          usdBalance: state.usdBalance,
          ethBalance: state.ethBalance,
          holdings: state.holdings,
          address: state.address,
          initial,
        });
      }
      if (typeof window.refreshSettingsUI === 'function') window.refreshSettingsUI();
    } catch (e) {
      console.warn('[WalletCore] applyToApp failed:', e);
    }
  }

  function setConnected(address, provider, signer) {
    state.address = address;
    state.provider = provider || null;
    state.signer = signer || null;
    state.connected = !!address;
    mirrorToLegacyState();
  }

  function clear() {
    state.connected = false;
    state.address = null;
    state.provider = null;
    state.signer = null;
    state.ethBalance = 0;
    state.usdBalance = 0;
    state.holdings = [];
    state.chainId = null;
    state.isCorrectChain = false;
    mirrorToLegacyState();
  }

  // ═══════════════════════════════════════════════════════════
  // CONNECT / RECONNECT
  // ═══════════════════════════════════════════════════════════

  function walletMissingError() {
    const e = new Error('MetaMask was not detected. Install the extension, then reload this page.');
    e.code = 'NO_WALLET';
    return e;
  }

  /**
   * Interactive connect: prompts the wallet for accounts, builds the
   * provider/signer with the version-correct ethers API, moves the wallet to
   * Base, then performs a full balance sync.
   */
  async function connect() {
    if (!hasWallet()) throw walletMissingError();

    const injected = getInjected();

    // eth_requestAccounts prompts the MetaMask popup. This must go through the
    // injected provider directly - provider.send() does not exist on an
    // ethers v6 BrowserProvider and silently broke the old flow.
    const accounts = await injected.request({ method: 'eth_requestAccounts' });
    if (!accounts || accounts.length === 0) {
      const e = new Error('No account was selected in MetaMask.');
      e.code = 'NO_ACCOUNTS';
      throw e;
    }

    const address = accounts[0];
    const provider = await makeProvider();
    const signer = await makeSigner(provider);

    setConnected(address, provider, signer);
    await refreshChainInfo();

    // Preferred network, but a rejected switch must not abort the connection:
    // read-only portfolio features still work on any chain.
    if (!state.isCorrectChain) await ensureBaseNetwork();

    await sync({ initial: true });
    emit('connect', { address });
    return { address, provider, signer };
  }

  /**
   * Silent reconnect on page load. Only proceeds if the wallet still has the
   * exact account we last persisted - a mismatch means the user switched
   * accounts, which must be treated as a fresh authorisation, not a resume.
   */
  async function silentReconnect(expectedAddress) {
    if (!hasWallet()) return null;
    try {
      const accounts = await getInjected().request({ method: 'eth_accounts' });
      if (!accounts || accounts.length === 0) return null;

      const address = accounts[0];
      if (expectedAddress && address.toLowerCase() !== expectedAddress.toLowerCase()) {
        console.info('[WalletCore] stored account differs from connected account; skipping silent reconnect.');
        return null;
      }

      const provider = await makeProvider();
      const signer = await makeSigner(provider);

      setConnected(address, provider, signer);
      await refreshChainInfo();
      emit('reconnect', { address });
      return { address, provider, signer };
    } catch (e) {
      console.warn('[WalletCore] silent reconnect failed:', e.message);
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // EVENT LISTENERS
  // ═══════════════════════════════════════════════════════════

  let listenersBound = false;

  /**
   * React to wallet-side changes.
   *
   * The previous implementation only logged these events (and on chainChanged
   * it told the user to refresh manually), which is why switching accounts or
   * networks left a stale provider and a frozen balance on screen. Every
   * handler now rebuilds state and re-syncs automatically.
   */
  function bindWalletEvents() {
    if (listenersBound) return;
    const injected = getInjected();
    if (!injected || typeof injected.on !== 'function') return;
    listenersBound = true;

    injected.on('accountsChanged', async (accounts) => {
      try {
        if (!accounts || accounts.length === 0) {
          clear();
          emit('disconnect', { reason: 'accounts-empty' });
          if (typeof window.TA_onWalletDisconnected === 'function') {
            window.TA_onWalletDisconnected('accounts-empty');
          }
          return;
        }

        const address = accounts[0];
        console.info('[WalletCore] account changed ->', address);

        // Rebuild provider and signer: the old ones are bound to the
        // previous account and will fail or sign with the wrong key.
        const provider = await makeProvider();
        const signer = await makeSigner(provider);
        const accountChanged = !state.address
          || address.toLowerCase() !== state.address.toLowerCase();

        setConnected(address, provider, signer);
        await refreshChainInfo();

        if (accountChanged) {
          // New account == new portfolio. Seed the app balance from the wallet.
          await sync({ initial: true });
          if (typeof window.TA_onWalletAccountChanged === 'function') {
            window.TA_onWalletAccountChanged(address);
          }
        } else {
          await sync({ initial: false });
        }
        emit('accountsChanged', { address });
      } catch (e) {
        console.warn('[WalletCore] accountsChanged handler failed:', e);
      }
    });

    injected.on('chainChanged', async (chainHex) => {
      try {
        console.info('[WalletCore] chain changed ->', chainHex);
        // v6 providers cache the network; rebuild so reads hit the new chain.
        if (state.address) {
          const provider = await makeProvider();
          const signer = await makeSigner(provider);
          setConnected(state.address, provider, signer);
        }
        await refreshChainInfo();
        if (state.address) await sync({ initial: false });
        emit('chainChanged', { chainId: state.chainId });
      } catch (e) {
        console.warn('[WalletCore] chainChanged handler failed:', e);
      }
    });

    injected.on('disconnect', (error) => {
      console.warn('[WalletCore] wallet disconnected:', error?.message || error);
      clear();
      emit('disconnect', { reason: 'provider-disconnect', error: error?.message });
      if (typeof window.TA_onWalletDisconnected === 'function') {
        window.TA_onWalletDisconnected('provider-disconnect');
      }
    });
  }

  // ═══════════════════════════════════════════════════════════
  // DIAGNOSTICS & PERIODIC SYNC
  // ═══════════════════════════════════════════════════════════

  function diagnose() {
    const injected = getInjected();
    let ethersVersion = 'not loaded';
    try {
      const e = globalThis.ethers;
      if (e && e.version) ethersVersion = e.version;
    } catch (e) { /* ignore */ }

    const report = {
      walletDetected: !!injected,
      isMetaMask: !!(injected && injected.isMetaMask),
      hasRequest: !!(injected && typeof injected.request === 'function'),
      hasEvents: !!(injected && typeof injected.on === 'function'),
      ethersVersion,
      usingEthersV6: isEthersV6(globalThis.ethers || {}),
      connected: state.connected,
      address: state.address,
      chainId: state.chainId,
      chainName: state.chainName,
      isCorrectChain: state.isCorrectChain,
      ethBalance: state.ethBalance,
      ethPrice: state.ethPrice,
      usdBalance: state.usdBalance,
      holdingCount: state.holdings.length,
      lastSync: state.lastSync ? new Date(state.lastSync).toISOString() : null,
      lastError: state.error,
    };

    console.group('🔍 WALLET DIAGNOSIS');
    console.table(report);
    console.groupEnd();
    return report;
  }

  let pollTimer = null;

  /**
   * Keep the displayed wallet balance fresh. Prices are cached, so this is
   * cheap; the cross-chain scan is what does the real work.
   * Uses document.visibilityState to avoid burning cycles on a hidden tab.
   */
  function startPolling(intervalMs = 60_000) {
    stopPolling();
    pollTimer = setInterval(() => {
      if (!state.address || state.syncing) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      sync({ initial: false }).catch(() => {});
    }, intervalMs);
    return pollTimer;
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // ═══════════════════════════════════════════════════════════
  // BOOTSTRAP
  // ═══════════════════════════════════════════════════════════

  /**
   * wallet-core.js is loaded with `defer`, so it may run before MetaMask has
   * injected window.ethereum. Wait briefly for injection, then bind.
   */
  function init(timeoutMs = 8000) {
    if (hasWallet()) { bindWalletEvents(); return; }
    const started = Date.now();
    const timer = setInterval(() => {
      if (hasWallet()) {
        clearInterval(timer);
        bindWalletEvents();
        console.info('[WalletCore] injected wallet detected; listeners bound.');
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        console.warn('[WalletCore] no injected wallet detected within timeout.');
      }
    }, 150);
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  } else if (typeof window !== 'undefined') {
    // Node/worker context: bind immediately if possible.
    init();
  }

  // ═══════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════

  const api = {
    CHAIN,
    state,
    getInjected,
    hasWallet,
    connect,
    silentReconnect,
    disconnect: clear,
    sync,
    getBalanceUSD: () => state.usdBalance,
    fetchMultiChainTokenBalances,
    ensureBaseNetwork,
    switchToBaseNetwork: ensureBaseNetwork,
    refreshChainInfo,
    getPrices,
    getEthPrice,
    formatEther,
    formatUnits,
    toBigInt,
    toChainIdNumber,
    subscribe,
    emit,
    bindWalletEvents,
    startPolling,
    stopPolling,
    diagnose,
    checkMetaMaskStatus: diagnose,
  };

  if (typeof window !== 'undefined') {
    window.WalletCore = api;
    // Legacy globals other modules / console debugging still expect.
    window.getWalletBalanceUSD = async () => {
      if (!state.address) return 0;
      await sync({ initial: false });
      return state.usdBalance;
    };
    window.switchToBaseNetwork = ensureBaseNetwork;
    window.diagnoseMetaMask = diagnose;
    window.checkMetaMaskStatus = diagnose;
  }

  return api;
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = WalletCore;
}
