/**
 * MM Wallet Adapter for Real-Wallet Module
 * Trade Arena v4 • Bridges mm CLI wallet to existing real-wallet.js interface
 * 
 * This adapter allows the existing trading engine to use mm CLI managed wallet
 * without changing the real-wallet.js API that the rest of the app depends on.
 * 
 * Usage:
 *   import { MMWalletAdapter } from './mm-wallet-adapter.js';
 *   const adapter = new MMWalletAdapter();
 *   await adapter.initialize();
 *   // Now use real-wallet.js functions as before - they'll use mm CLI backend
 */

const { MMAgentWalletIntegration } = require('./mm-wallet-integration');

class MMWalletAdapter {
  constructor(options = {}) {
    this.mmWallet = new MMAgentWalletIntegration(options);
    this.chainId = options.defaultChainId || 8453;
    this.initialized = false;
    this.balanceUpdateInterval = null;
  }

  /**
   * Initialize the adapter and connect to mm CLI wallet
   */
  async initialize() {
    if (this.initialized) return this.getState();

    try {
      const walletInfo = await this.mmWallet.initialize();
      
      // Update the global walletState to match mm CLI wallet
      this.updateGlobalWalletState(walletInfo);
      
      this.initialized = true;
      console.log('[MMWalletAdapter] Initialized with address:', walletInfo.address);
      
      // Start periodic balance updates
      this.startBalanceUpdates();
      
      return this.getState();
    } catch (error) {
      console.error('[MMWalletAdapter] Initialization failed:', error);
      throw error;
     }
  }

  /**
   * Update the global walletState object used by real-wallet.js
   */
  updateGlobalWalletState(walletInfo) {
    if (typeof window === 'undefined') return;

    const chain = walletInfo.balances.chains[this.chainId];
    const ethToken = chain ? Object.values(chain.tokens).find(t => t.symbol === 'ETH' || t.type === 'native') : null;

    window.walletState = {
      isConnected: true,
      address: walletInfo.address,
      balanceETH: ethToken?.amount || 0,
      balanceUSD: walletInfo.totalUSD,
      networkId: this.chainId,
      isCorrectNetwork: true,
      provider: null, // Not used with mm CLI
      signer: null,   // Not used with mm CLI
      nonce: 0,
      transactions: window.walletState?.transactions || [],
      // MM CLI specific
      mmWallet: {
        address: walletInfo.address,
        tradingMode: walletInfo.tradingMode,
        chains: walletInfo.chains
      }
    };

    // Also update REAL_WALLET_CONFIG if needed
    if (window.REAL_WALLET_CONFIG) {
      window.REAL_WALLET_CONFIG.network.id = this.chainId;
    }
  }

  /**
   * Get current wallet state
   */
  getState() {
    return window.walletState || {};
  }

  /**
   * Start periodic balance updates
   */
  startBalanceUpdates(intervalMs = 30000) {
    if (this.balanceUpdateInterval) {
      clearInterval(this.balanceUpdateInterval);
    }

    this.balanceUpdateInterval = setInterval(async () => {
      try {
        await this.refreshBalances();
      } catch (e) {
        console.warn('[MMWalletAdapter] Balance refresh failed:', e.message);
      }
    }, intervalMs);
  }

  /**
   * Stop periodic balance updates
   */
  stopBalanceUpdates() {
    if (this.balanceUpdateInterval) {
      clearInterval(this.balanceUpdateInterval);
      this.balanceUpdateInterval = null;
    }
  }

  /**
   * Refresh balances from mm CLI
   */
  async refreshBalances(chainIds = [8453, 42161, 10]) {
    const balances = await this.mmWallet.getBalances(chainIds);
    this.updateGlobalWalletState({
      address: await this.mmWallet.getWalletAddress(),
      balances,
      totalUSD: balances.totalUSD,
      tradingMode: await this.mmWallet.getTradingMode().catch(() => ({ mode: 'guard' })).then(r => r.mode),
      chains: Object.keys(balances.chains).map(Number)
    });
    return balances;
  }

  /**
   * Get wallet balance (compatible with real-wallet.js getWalletBalance)
   */
  async getWalletBalance() {
    const balances = await this.mmWallet.getBalances([this.chainId]);
    const chain = balances.chains[this.chainId];
    const ethToken = chain ? Object.values(chain.tokens).find(t => t.symbol === 'ETH' || t.type === 'native') : null;
    const ethPrice = ethToken ? ethToken.usdValue / ethToken.amount : 3200;

    return {
      eth: ethToken?.amount || 0,
      usd: chain?.totalUSD || 0,
      ethPrice
    };
  }

  /**
   * Estimate gas price (compatible with real-wallet.js estimateGasPrice)
   */
  async estimateGasPrice() {
    // mm CLI doesn't expose gas price directly, return reasonable defaults
    // In production, could call mm swap quote to infer gas
    return {
      gasPrice: BigInt(1000000000), // 1 gwei in wei
      baseFee: BigInt(1000000000),
      maxPriorityFee: BigInt(1000000000),
      maxFee: BigInt(2000000000)
    };
  }

  /**
   * Estimate swap gas cost (compatible with real-wallet.js estimateSwapGasCost)
   */
  async estimateSwapGasCost(method = 'ARBITRAGE') {
    const feeData = await this.estimateGasPrice();
    const gasEstimates = {
      'ARBITRAGE': 150000,
      'SPOT LONG': 120000,
      'SPOT SHORT': 120000,
      'FLASH LOAN': 200000,
      'NFT FLIP': 150000,
      'YIELD FARM': 150000,
      'PERP LONG': 150000,
      'PERP SHORT': 150000
    };
    
    const gasEstimate = gasEstimates[method] || 120000;
    const gasPrice = feeData.maxFee || feeData.gasPrice;
    const gasCostWei = gasPrice * BigInt(gasEstimate);
    const gasCostETH = parseFloat(this.formatEther(gasCostWei));
    const balance = await this.getWalletBalance();
    const gasCostUSD = gasCostETH * (balance.ethPrice || 3200);

    return {
      gasLimit: gasEstimate,
      gasPrice: parseFloat(this.formatUnits(gasPrice, 'gwei')),
      costETH: gasCostETH,
      costUSD: gasCostUSD,
      totalGasWei: gasCostWei
    };
  }

  /**
   * Validate sufficient balance (compatible with real-wallet.js validateSufficientBalance)
   */
  async validateSufficientBalance(betUSD) {
    return this.mmWallet.checkSufficientBalance({ betUSD, chainId: this.chainId });
  }

  /**
   * Simulate real trade (compatible with real-wallet.js simulateRealTrade)
   */
  async simulateRealTrade(betUSD, method, volatility, pnlMultiplier) {
    const validation = await this.validateSufficientBalance(betUSD);
    
    if (!validation.hasEnoughBalance) {
      return {
        success: false,
        error: `Insufficient balance. Need ${validation.requiredETH.toFixed(4)} ETH, have ${validation.balanceETH.toFixed(4)} ETH`,
        validation
      };
    }

    const gasCost = await this.estimateSwapGasCost(method);
    const slippage = this.calculateSlippage(betUSD, volatility, method);
    
    const totalCostUSD = gasCost.costUSD + parseFloat(slippage.usd);
    const pnl = betUSD * pnlMultiplier;
    const netPnL = pnl - totalCostUSD;

    const transaction = {
      timestamp: new Date().toISOString(),
      bot: null,
      betUSD,
      method,
      volatility,
      gasCostUSD: gasCost.costUSD.toFixed(4),
      slippageUSD: slippage.usd,
      totalCostUSD: totalCostUSD.toFixed(4),
      grossPnL: pnl.toFixed(4),
      netPnL: netPnL.toFixed(4),
      pnlMultiplier,
      outcome: pnlMultiplier >= 1 ? 'WIN' : 'LOSS',
      status: 'SIMULATED',
      txHash: null
    };

    // Add to transaction history
    if (window.walletState) {
      window.walletState.transactions.push(transaction);
    }

    return {
      success: true,
      transaction,
      validation
    };
  }

  /**
   * Calculate slippage (copied from real-wallet.js)
   */
  calculateSlippage(betUSD, volatility = 5, method = 'ARBITRAGE') {
    const methodSlippage = {
      'ARBITRAGE': 0.005,
      'SPOT LONG': 0.01,
      'SPOT SHORT': 0.015,
      'FLASH LOAN': 0.003,
      'NFT FLIP': 0.02,
      'YIELD FARM': 0.005,
      'PERP LONG': 0.02,
      'PERP SHORT': 0.025,
    }[method] || 0.01;

    const volatilityAdjustment = (volatility / 100) * 0.001;
    const sizeMultiplier = Math.min(1 + (betUSD / 1000), 2);
    const totalSlippagePercent = (methodSlippage + volatilityAdjustment) * sizeMultiplier;
    const slippageCapped = Math.min(totalSlippagePercent, 0.02); // 2% max
    const slippageUSD = betUSD * slippageCapped;

    return {
      percent: (slippageCapped * 100).toFixed(3),
      usd: slippageUSD.toFixed(4),
      method
    };
  }

  /**
   * Execute real transaction via mm CLI
   */
  async executeRealTransaction({ to, data, value = '0', chainId = 8453 }) {
    return this.mmWallet.sendTransaction({ to, data, value, chainId, wait: true });
  }

  /**
   * Execute swap via mm CLI
   */
  async executeSwap({ fromToken, toToken, amount, chainId = 8453, slippage = 0.005 }) {
    return this.mmWallet.swap({ fromToken, toToken, amount, chainId, slippage, wait: true });
  }

  /**
   * Transfer tokens via mm CLI
   */
  async transfer({ to, amount, token = 'native', chainId = 8453 }) {
    return this.mmWallet.transfer({ to, amount, token, chainId, wait: true });
  }

  /**
   * Get swap quote via mm CLI
   */
  async getSwapQuote({ fromToken, toToken, amount, chainId = 8453 }) {
    return this.mmWallet.getSwapQuote({ fromToken, toToken, amount, chainId });
  }

  /**
   * Sign message via mm CLI
   */
  async signMessage(message) {
    return this.mmWallet.signMessage(message);
  }

  /**
   * Sign typed data via mm CLI
   */
  async signTypedData(domain, types, message) {
    return this.mmWallet.signTypedData(domain, types, message);
  }

  /**
   * Get trading mode
   */
  async getTradingMode() {
    return this.mmWallet.getTradingMode();
  }

  /**
   * Set trading mode
   */
  async setTradingMode(mode) {
    return this.mmWallet.setTradingMode(mode);
  }

  /**
   * Get wallet policy
   */
  async getPolicy() {
    return this.mmWallet.getPolicy();
  }

  /**
   * Set wallet policy
   */
  async setPolicy(policyYaml) {
    return this.mmWallet.setPolicy(policyYaml);
  }

  /**
   * Switch network (mm CLI handles this server-side, but we can update local state)
   */
  async switchToNetwork(chainId) {
    this.chainId = chainId;
    await this.refreshBalances([chainId]);
    return true;
  }

  /**
   * Check if mm CLI is available
   */
  isAvailable() {
    return this.mmWallet.isAvailable;
  }

  /**
   * Utility: format wei to ether
   */
  formatEther(wei) {
    return (Number(wei) / 1e18).toString();
  }

  /**
   * Utility: format units
   */
  formatUnits(value, unit) {
    const units = { wei: 1, gwei: 1e9, ether: 1e18 };
    return (Number(value) / (units[unit] || 1)).toString();
  }

  /**
   * Clean up
   */
  destroy() {
    this.stopBalanceUpdates();
    this.initialized = false;
  }
}

// Make available globally
if (typeof window !== 'undefined') {
  window.MMWalletAdapter = MMWalletAdapter;
}

module.exports = { MMWalletAdapter };