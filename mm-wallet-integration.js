/**
 * MetaMask Agent Wallet CLI Integration
 * Trade Arena v4 • Connects mm CLI managed wallet to trading engine
 * 
 * Provides:
 * - Wallet address resolution via mm CLI
 * - Balance fetching via mm CLI (multi-chain)
 * - Transaction execution via mm CLI
 * - Network management
 * - Real-time wallet state sync
 */

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

class MMAgentWalletIntegration {
  constructor(options = {}) {
    // Use full path to mm CLI if not in PATH
    const defaultMmPath = process.platform === 'win32' 
      ? path.join(process.env.APPDATA || '', 'npm', 'mm.cmd')
      : path.join(process.env.HOME || '', '.npm-global', 'bin', 'mm');
    
    this.mmPath = options.mmPath || process.env.MM_CLI_PATH || defaultMmPath || 'mm';
    this.defaultChainId = options.defaultChainId || 8453; // Base
    this.cacheTimeout = options.cacheTimeout || 30000; // 30s cache
    this.walletCache = {
      address: null,
      balances: {},
      lastFetch: 0,
      initialized: false
    };
    this.isAvailable = this.checkMMAvailability();
  }

  /**
   * Check if mm CLI is available and authenticated
   */
  checkMMAvailability() {
    try {
      const result = execFileSync(this.mmPath, ['doctor', '--json'], {
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'ignore'],
        shell: false
      });
      const doctor = JSON.parse(result);
      return doctor.ok && doctor.data.authenticated && doctor.data.initialized;
    } catch (e) {
      console.warn('[MM Wallet] mm CLI not available or not authenticated:', e.message);
      return false;
    }
  }

  /**
   * Validate CLI arguments to prevent shell/control-character injection
   */
  validateMMArgs(args) {
    if (!Array.isArray(args)) {
      throw new Error('Invalid mm args: expected array');
    }

    const unsafePattern = /[\r\n\0;&|`$<>]/;
    for (const arg of args) {
      if (typeof arg !== 'string') {
        throw new Error('Invalid mm arg: expected string');
      }
      if (unsafePattern.test(arg)) {
        throw new Error(`Unsafe mm argument rejected: ${arg}`);
      }
    }
  }

  /**
     * Execute mm command and parse JSON output
     */
    async executeMMCommand(args) {
      return new Promise((resolve, reject) => {
        this.validateMMArgs(args);
        const spawnArgs = [...args, '--json'];
      
        const child = spawn(this.mmPath, spawnArgs, {
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data) => stdout += data.toString());
        child.stderr.on('data', (data) => stderr += data.toString());

        child.on('close', (code) => {
          if (code !== 0) {
            reject(new Error(`mm command failed (${code}): ${stderr}`));
            return;
          }
          try {
            // Find JSON in output (mm may output warnings before JSON)
            const jsonStart = stdout.indexOf('{');
            const jsonEnd = stdout.lastIndexOf('}') + 1;
            if (jsonStart >= 0 && jsonEnd > jsonStart) {
              const jsonStr = stdout.slice(jsonStart, jsonEnd);
              resolve(JSON.parse(jsonStr));
            } else {
              reject(new Error('No JSON found in mm output'));
            }
          } catch (e) {
            reject(new Error(`Failed to parse mm output: ${e.message}\nOutput: ${stdout}`));
          }
        });

        child.on('error', (err) => reject(new Error(`Failed to spawn mm: ${err.message}`)));
      });
    }

  /**
   * Get wallet address from mm CLI
   */
  async getWalletAddress() {
    if (this.walletCache.address && Date.now() - this.walletCache.lastFetch < this.cacheTimeout) {
      return this.walletCache.address;
    }

    const result = await this.executeMMCommand(['wallet', 'address']);
    if (result.ok && result.data.address) {
      this.walletCache.address = result.data.address;
      this.walletCache.lastFetch = Date.now();
      return result.data.address;
    }
    throw new Error('Failed to get wallet address from mm CLI');
  }

  /**
   * Get balances for specified chains
   * @param {number[]} chainIds - Array of chain IDs (default: Base, Arbitrum, Optimism)
   */
  async getBalances(chainIds = [8453, 42161, 10]) {
    const now = Date.now();
    const cacheKey = chainIds.sort().join(',');
    
    if (this.walletCache.balances[cacheKey] && now - this.walletCache.lastFetch < this.cacheTimeout) {
      return this.walletCache.balances[cacheKey];
    }

    const result = await this.executeMMCommand(['wallet', 'balance', '--chain-ids', chainIds.join(',')]);
    
    if (result.ok && result.data) {
      const parsed = this.parseBalanceData(result.data, chainIds);
      this.walletCache.balances[cacheKey] = parsed;
      this.walletCache.lastFetch = now;
      return parsed;
    }
    throw new Error('Failed to get balances from mm CLI');
  }

  /**
   * Parse mm wallet balance output into normalized format
   */
  parseBalanceData(data, chainIds) {
    const chains = {};
    let totalUSD = 0;

    if (data.chains) {
      for (const chain of data.chains) {
        const chainId = parseInt(chain.chainId?.replace('eip155:', '') || chain.id);
        if (!chainIds.includes(chainId)) continue;

        const tokens = {};
        let chainTotalUSD = 0;

        if (chain.tokens) {
          for (const token of chain.tokens) {
            const symbol = token.token || token.symbol;
            const amount = parseFloat(token.amount || '0');
            const usdValue = parseFloat(token.usdValue || '0');
            
            tokens[symbol] = {
              symbol,
              amount,
              usdValue,
              address: token.assetId?.split('/').pop() || token.address,
              type: token.type || 'erc20',
              name: token.name
            };
            chainTotalUSD += usdValue;
          }
        }

        chains[chainId] = {
          chainId,
          name: chain.name,
          totalUSD: chainTotalUSD,
          tokens,
          nativeToken: chain.nativeCurrency || 'ETH'
        };
        totalUSD += chainTotalUSD;
      }
    }

    return {
      totalUSD,
      chains,
      timestamp: Date.now()
    };
  }

  /**
   * Get native ETH balance for a specific chain
   */
  async getNativeBalance(chainId = 8453) {
    const balances = await this.getBalances([chainId]);
    const chain = balances.chains[chainId];
    if (!chain) return 0;
    
    // Find native ETH token
    const ethToken = Object.values(chain.tokens).find(t => 
      t.symbol === 'ETH' || t.symbol === 'WETH' || t.type === 'native'
    );
    return ethToken ? ethToken.amount : 0;
  }

  /**
   * Get USDC balance for a specific chain
   */
  async getUSDCBalance(chainId = 8453) {
    const balances = await this.getBalances([chainId]);
    const chain = balances.chains[chainId];
    if (!chain) return 0;
    
    const usdcToken = chain.tokens['USDC'];
    return usdcToken ? usdcToken.amount : 0;
  }

  /**
   * Execute a transfer via mm CLI
   * @param {Object} params - Transfer parameters
   * @param {string} params.to - Recipient address
   * @param {number} params.amount - Amount to send
   * @param {string} params.token - Token symbol (default: native)
   * @param {number} params.chainId - Chain ID (default: Base)
   * @param {boolean} params.wait - Wait for confirmation
   */
  async transfer({ to, amount, token = 'native', chainId = 8453, wait = true }) {
    const args = ['transfer', '--to', to, '--amount', amount.toString(), '--token', token, '--chain-id', chainId.toString()];
    if (wait) args.push('--wait');
    
    const result = await this.executeMMCommand(args);
    if (result.ok) {
      // Invalidate cache after transfer
      this.walletCache.lastFetch = 0;
      return result.data;
    }
    throw new Error(result.error?.message || 'Transfer failed');
  }

  /**
   * Execute a swap via mm CLI
   * @param {Object} params - Swap parameters
   */
  async swap({ fromToken, toToken, amount, chainId = 8453, slippage = 0.005, wait = true }) {
    const args = ['swap', 'execute', '--from-token', fromToken, '--to-token', toToken, '--amount', amount.toString(), '--chain-id', chainId.toString(), '--slippage', slippage.toString()];
    if (wait) args.push('--wait');
    
    const result = await this.executeMMCommand(args);
    if (result.ok) {
      this.walletCache.lastFetch = 0;
      return result.data;
    }
    throw new Error(result.error?.message || 'Swap failed');
  }

  /**
   * Get swap quote via mm CLI
   */
  async getSwapQuote({ fromToken, toToken, amount, chainId = 8453 }) {
    const result = await this.executeMMCommand(['swap', 'quote', '--from-token', fromToken, '--to-token', toToken, '--amount', amount.toString(), '--chain-id', chainId.toString()]);
    if (result.ok) return result.data;
    throw new Error(result.error?.message || 'Quote failed');
  }

  /**
   * Send raw transaction via mm CLI
   */
  async sendTransaction({ to, data, value = '0', chainId = 8453, wait = true }) {
    const args = ['wallet', 'send-transaction', '--to', to, '--data', data, '--value', value, '--chain-id', chainId.toString()];
    if (wait) args.push('--wait');
    
    const result = await this.executeMMCommand(args);
    if (result.ok) {
      this.walletCache.lastFetch = 0;
      return result.data;
    }
    throw new Error(result.error?.message || 'Transaction failed');
  }

  /**
   * Sign a message via mm CLI
   */
  async signMessage(message) {
    const result = await this.executeMMCommand(['wallet', 'sign-message', '--message', message]);
    if (result.ok) return result.data;
    throw new Error(result.error?.message || 'Sign message failed');
  }

  /**
   * Sign typed data (EIP-712) via mm CLI
   */
  async signTypedData(domain, types, message) {
    const result = await this.executeMMCommand(['wallet', 'sign-typed-data', '--domain', JSON.stringify(domain), '--types', JSON.stringify(types), '--message', JSON.stringify(message)]);
    if (result.ok) return result.data;
    throw new Error(result.error?.message || 'Sign typed data failed');
  }

  /**
   * Get current trading mode
   */
  async getTradingMode() {
    const result = await this.executeMMCommand(['wallet', 'trading-mode', 'get']);
    if (result.ok) return result.data;
    throw new Error(result.error?.message || 'Failed to get trading mode');
  }

  /**
   * Set trading mode (guard/beast)
   */
  async setTradingMode(mode) {
    const result = await this.executeMMCommand(['wallet', 'trading-mode', 'set', mode]);
    if (result.ok) return result.data;
    throw new Error(result.error?.message || 'Failed to set trading mode');
  }

  /**
   * Get wallet policy
   */
  async getPolicy() {
    const result = await this.executeMMCommand(['wallet', 'policy', 'get']);
    if (result.ok) return result.data;
    throw new Error(result.error?.message || 'Failed to get policy');
  }

  /**
   * Set wallet policy
   */
  async setPolicy(policyYaml) {
    const result = await this.executeMMCommand(['wallet', 'policy', 'set', '--policy', policyYaml]);
    if (result.ok) return result.data;
    throw new Error(result.error?.message || 'Failed to set policy');
  }

  /**
   * List all wallets
   */
  async listWallets() {
    const result = await this.executeMMCommand(['wallet', 'list']);
    if (result.ok) return result.data;
    throw new Error(result.error?.message || 'Failed to list wallets');
  }

  /**
   * Get auth status
   */
  async getAuthStatus() {
    const result = await this.executeMMCommand(['auth', 'status']);
    if (result.ok) return result.data;
    throw new Error(result.error?.message || 'Failed to get auth status');
  }

  /**
   * Check if wallet has sufficient balance for a trade
   */
  async checkSufficientBalance({ betUSD, chainId = 8453, estimatedGasUSD = 5 }) {
    const balances = await this.getBalances([chainId]);
    const chain = balances.chains[chainId];
    if (!chain) return { sufficient: false, reason: 'Chain not found' };

    const ethToken = Object.values(chain.tokens).find(t => t.symbol === 'ETH' || t.type === 'native');
    const ethPrice = ethToken ? ethToken.usdValue / ethToken.amount : 3200;
    const requiredETH = (betUSD + estimatedGasUSD) / ethPrice + 0.001; // buffer

    return {
      sufficient: ethToken && ethToken.amount >= requiredETH,
      balanceETH: ethToken?.amount || 0,
      balanceUSD: chain.totalUSD,
      requiredETH,
      ethPrice
    };
  }

  /**
   * Initialize and verify wallet connection
   */
  async initialize() {
    if (!this.isAvailable) {
      throw new Error('mm CLI not available or not authenticated. Run `mm doctor` to check.');
    }

    const address = await this.getWalletAddress();
    const balances = await this.getBalances();
    const authStatus = await this.getAuthStatus();
    const tradingMode = await this.getTradingMode();

    this.walletCache.initialized = true;

    return {
      address,
      balances,
      authenticated: authStatus.authenticated,
      tradingMode: tradingMode.mode,
      chains: Object.keys(balances.chains).map(Number),
      totalUSD: balances.totalUSD
    };
  }

  /**
   * Clear cache to force fresh data
   */
  clearCache() {
    this.walletCache = {
      address: null,
      balances: {},
      lastFetch: 0,
      initialized: this.walletCache.initialized
    };
  }

  /**
   * Get wallet state for UI display
   */
  async getWalletState() {
    if (!this.walletCache.initialized) {
      await this.initialize();
    }
    const address = await this.getWalletAddress();
    const balances = await this.getBalances();
    
    return {
      address,
      balances,
      isConnected: true,
      isCorrectNetwork: true, // mm CLI manages this
      lastUpdate: Date.now()
    };
  }
}

module.exports = { MMAgentWalletIntegration };

// Make available globally in browser context (for index.html)
if (typeof window !== 'undefined') {
  window.MMAgentWalletIntegration = MMAgentWalletIntegration;
}