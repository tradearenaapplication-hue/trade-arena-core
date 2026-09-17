/**
 * MM Wallet Frontend Integration
 * Trade Arena v4 • Browser-side client for MM Wallet API
 * 
 * Usage in index.html:
 * <script src="mm-wallet-client.js"></script>
 * <script>
 *   const mmWallet = new MMWalletClient();
 *   await mmWallet.initialize();
 *   const balance = await mmWallet.getBalances();
 * </script>
 */

class MMWalletClient {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || '/api/wallet';
    this.cacheTimeout = options.cacheTimeout || 30000;
    this.cache = {
      state: null,
      balances: {},
      lastFetch: 0
    };
    this.listeners = new Set();
  }

  /**
   * Make API request with error handling
   */
  async request(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const response = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      },
      ...options
    });

    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }

    return data;
  }

  /**
   * Notify listeners of state changes
   */
  notifyListeners(event, data) {
    this.listeners.forEach(listener => {
      try {
        listener(event, data);
      } catch (e) {
        console.error('[MMWalletClient] Listener error:', e);
      }
    });
  }

  /**
   * Subscribe to wallet state changes
   * @param {Function} listener - Callback(event, data)
   * @returns {Function} Unsubscribe function
   */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Initialize wallet connection
   */
  async initialize() {
    const data = await this.request('/initialize');
    this.cache.state = data.wallet;
    this.notifyListeners('initialized', this.cache.state);
    return this.cache.state;
  }

  /**
   * Get wallet status
   */
  async getStatus() {
    const data = await this.request('/status');
    this.cache.state = data.wallet;
    this.notifyListeners('status', this.cache.state);
    return this.cache.state;
  }

  /**
   * Get wallet address
   */
  async getAddress() {
    const data = await this.request('/address');
    if (this.cache.state) {
      this.cache.state.address = data.address;
    }
    return data.address;
  }

  /**
   * Get balances for specified chains
   * @param {number[]} chainIds - Chain IDs to fetch (default: Base, Arbitrum, Optimism)
   */
  async getBalances(chainIds = [8453, 42161, 10]) {
    const cacheKey = chainIds.sort().join(',');
    const now = Date.now();
    
    if (this.cache.balances[cacheKey] && now - this.cache.lastFetch < this.cacheTimeout) {
      return this.cache.balances[cacheKey];
    }

    const chainIdsParam = chainIds.join(',');
    const data = await this.request(`/balances?chainIds=${chainIdsParam}`);
    
    this.cache.balances[cacheKey] = data.balances;
    this.cache.lastFetch = now;
    this.notifyListeners('balances', data.balances);
    
    return data.balances;
  }

  /**
   * Get balance for a specific chain
   */
  async getChainBalance(chainId) {
    const data = await this.request(`/balance/${chainId}`);
    return data.chain;
  }

  /**
   * Get native ETH balance for a chain
   */
  async getNativeBalance(chainId = 8453) {
    const data = await this.request(`/native-balance/${chainId}`);
    return data.balanceETH;
  }

  /**
   * Get USDC balance for a chain
   */
  async getUSDCBalance(chainId = 8453) {
    const data = await this.request(`/usdc-balance/${chainId}`);
    return data.balanceUSDC;
  }

  /**
   * Check if sufficient balance for a trade
   */
  async checkSufficientBalance({ betUSD, chainId = 8453, estimatedGasUSD = 5 }) {
    const data = await this.request('/check-balance', {
      method: 'POST',
      body: JSON.stringify({ betUSD, chainId, estimatedGasUSD })
    });
    return data;
  }

  /**
   * Execute a transfer
   */
  async transfer({ to, amount, token = 'native', chainId = 8453, wait = true }) {
    const data = await this.request('/transfer', {
      method: 'POST',
      body: JSON.stringify({ to, amount, token, chainId, wait })
    });
    
    // Invalidate cache
    this.cache.lastFetch = 0;
    this.notifyListeners('transfer', data.transfer);
    
    return data.transfer;
  }

  /**
   * Execute a swap
   */
  async swap({ fromToken, toToken, amount, chainId = 8453, slippage = 0.005, wait = true }) {
    const data = await this.request('/swap', {
      method: 'POST',
      body: JSON.stringify({ fromToken, toToken, amount, chainId, slippage, wait })
    });
    
    this.cache.lastFetch = 0;
    this.notifyListeners('swap', data.swap);
    
    return data.swap;
  }

  /**
   * Get swap quote
   */
  async getSwapQuote({ fromToken, toToken, amount, chainId = 8453 }) {
    const data = await this.request('/swap/quote', {
      method: 'POST',
      body: JSON.stringify({ fromToken, toToken, amount, chainId })
    });
    return data.quote;
  }

  /**
   * Send raw transaction
   */
  async sendTransaction({ to, data, value = '0', chainId = 8453, wait = true }) {
    const result = await this.request('/send-transaction', {
      method: 'POST',
      body: JSON.stringify({ to, data, value, chainId, wait })
    });
    
    this.cache.lastFetch = 0;
    this.notifyListeners('transaction', result.transaction);
    
    return result.transaction;
  }

  /**
   * Sign a message
   */
  async signMessage(message) {
    const data = await this.request('/sign-message', {
      method: 'POST',
      body: JSON.stringify({ message })
    });
    return data.signature;
  }

  /**
   * Sign typed data (EIP-712)
   */
  async signTypedData(domain, types, message) {
    const data = await this.request('/sign-typed-data', {
      method: 'POST',
      body: JSON.stringify({ domain, types, message })
    });
    return data.signature;
  }

  /**
   * Get trading mode
   */
  async getTradingMode() {
    const data = await this.request('/trading-mode');
    return data.mode;
  }

  /**
   * Set trading mode
   */
  async setTradingMode(mode) {
    const data = await this.request('/trading-mode', {
      method: 'POST',
      body: JSON.stringify({ mode })
    });
    this.notifyListeners('tradingMode', data.mode);
    return data.mode;
  }

  /**
   * Get wallet policy
   */
  async getPolicy() {
    const data = await this.request('/policy');
    return data.policy;
  }

  /**
   * Set wallet policy
   */
  async setPolicy(policyYaml) {
    const data = await this.request('/policy', {
      method: 'POST',
      body: JSON.stringify({ policy: policyYaml })
    });
    return data.policy;
  }

  /**
   * List all wallets
   */
  async listWallets() {
    const data = await this.request('/list');
    return data.wallets;
  }

  /**
   * Get auth status
   */
  async getAuthStatus() {
    const data = await this.request('/auth');
    return data.auth;
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache = {
      state: null,
      balances: {},
      lastFetch: 0
    };
  }

  /**
   * Get cached state
   */
  getCachedState() {
    return this.cache.state;
  }

  /**
   * Get cached balances
   */
  getCachedBalances(chainIds = [8453, 42161, 10]) {
    const cacheKey = chainIds.sort().join(',');
    return this.cache.balances[cacheKey];
  }

  /**
   * Format balance for display
   */
  static formatBalance(balance, decimals = 4) {
    if (balance === null || balance === undefined) return '0.0000';
    if (balance === 0) return '0.0000';
    if (balance < 0.0001) return '<0.0001';
    return balance.toFixed(decimals);
  }

  /**
   * Format USD value for display
   */
  static formatUSD(value, decimals = 2) {
    if (value === null || value === undefined) return '$0.00';
    if (value >= 1000000) return `$${(value / 1000000).toFixed(2)}M`;
    if (value >= 1000) return `$${(value / 1000).toFixed(2)}K`;
    return `$${value.toFixed(decimals)}`;
  }

  /**
   * Get total portfolio USD value
   */
  async getTotalPortfolioUSD(chainIds = [8453, 42161, 10]) {
    const balances = await this.getBalances(chainIds);
    return balances.totalUSD || 0;
  }

  /**
   * Get token balance by symbol
   */
  async getTokenBalance(symbol, chainId = 8453) {
    const balances = await this.getBalances([chainId]);
    const chain = balances.chains[chainId];
    if (!chain) return 0;
    
    const token = chain.tokens[symbol];
    return token ? token.amount : 0;
  }
}

// Make available globally
if (typeof window !== 'undefined') {
  window.MMWalletClient = MMWalletClient;
}

module.exports = { MMWalletClient };