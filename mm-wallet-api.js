/**
 * MM Wallet API Routes
 * Express.js routes to expose mm CLI wallet functionality to the frontend
 * 
 * Mount this in server.js: app.use('/api/wallet', require('./mm-wallet-api'));
 */

const express = require('express');
const { MMAgentWalletIntegration } = require('./mm-wallet-integration');

const router = express.Router();

// Initialize MM wallet integration
const mmWallet = new MMAgentWalletIntegration({
  mmPath: process.env.MM_CLI_PATH || 'mm',
  defaultChainId: parseInt(process.env.DEFAULT_CHAIN_ID) || 8453,
  cacheTimeout: parseInt(process.env.WALLET_CACHE_TIMEOUT) || 30000
});

// Middleware to check wallet availability
const checkWalletAvailable = async (req, res, next) => {
  if (!mmWallet.isAvailable) {
    return res.status(503).json({
      success: false,
      error: 'MetaMask Agent Wallet CLI not available or not authenticated',
      hint: 'Run `mm doctor` to check status, then `mm login` and `mm init` if needed'
    });
  }
  next();
};

/**
 * GET /api/wallet/status - Get wallet connection status and basic info
 */
router.get('/status', checkWalletAvailable, async (req, res) => {
  try {
    const state = await mmWallet.getWalletState();
    res.json({ success: true, wallet: state });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/wallet/initialize - Initialize wallet connection and get full state
 */
router.get('/initialize', checkWalletAvailable, async (req, res) => {
  try {
    const init = await mmWallet.initialize();
    res.json({ success: true, wallet: init });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/wallet/address - Get wallet address
 */
router.get('/address', checkWalletAvailable, async (req, res) => {
  try {
    const address = await mmWallet.getWalletAddress();
    res.json({ success: true, address });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/wallet/balances - Get balances for specified chains
 * Query params: chainIds=8453,42161,10 (comma-separated)
 */
router.get('/balances', checkWalletAvailable, async (req, res) => {
  try {
    const chainIds = req.query.chainIds 
      ? req.query.chainIds.split(',').map(id => parseInt(id.trim()))
      : [8453, 42161, 10];
    
    const balances = await mmWallet.getBalances(chainIds);
    res.json({ success: true, balances });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/wallet/balance/:chainId - Get balance for specific chain
 */
router.get('/balance/:chainId', checkWalletAvailable, async (req, res) => {
  try {
    const chainId = parseInt(req.params.chainId);
    const balances = await mmWallet.getBalances([chainId]);
    const chain = balances.chains[chainId];
    
    if (!chain) {
      return res.status(404).json({ success: false, error: `Chain ${chainId} not found` });
    }
    
    res.json({ success: true, chain });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/wallet/native-balance/:chainId - Get native ETH balance
 */
router.get('/native-balance/:chainId', checkWalletAvailable, async (req, res) => {
  try {
    const chainId = parseInt(req.params.chainId);
    const balance = await mmWallet.getNativeBalance(chainId);
    res.json({ success: true, chainId, balanceETH: balance });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/wallet/usdc-balance/:chainId - Get USDC balance
 */
router.get('/usdc-balance/:chainId', checkWalletAvailable, async (req, res) => {
  try {
    const chainId = parseInt(req.params.chainId);
    const balance = await mmWallet.getUSDCBalance(chainId);
    res.json({ success: true, chainId, balanceUSDC: balance });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/wallet/check-balance - Check if sufficient balance for trade
 * Body: { betUSD, chainId?, estimatedGasUSD? }
 */
router.post('/check-balance', checkWalletAvailable, async (req, res) => {
  try {
    const { betUSD, chainId = 8453, estimatedGasUSD = 5 } = req.body;
    
    if (!betUSD || betUSD <= 0) {
      return res.status(400).json({ success: false, error: 'betUSD is required and must be > 0' });
    }
    
    const result = await mmWallet.checkSufficientBalance({ betUSD, chainId, estimatedGasUSD });
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/wallet/transfer - Execute transfer
 * Body: { to, amount, token?, chainId?, wait? }
 */
router.post('/transfer', checkWalletAvailable, async (req, res) => {
  try {
    const { to, amount, token = 'native', chainId = 8453, wait = true } = req.body;
    
    if (!to || !amount) {
      return res.status(400).json({ success: false, error: 'to and amount are required' });
    }
    
    const result = await mmWallet.transfer({ to, amount, token, chainId, wait });
    res.json({ success: true, transfer: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/wallet/swap - Execute swap
 * Body: { fromToken, toToken, amount, chainId?, slippage?, wait? }
 */
router.post('/swap', checkWalletAvailable, async (req, res) => {
  try {
    const { fromToken, toToken, amount, chainId = 8453, slippage = 0.005, wait = true } = req.body;
    
    if (!fromToken || !toToken || !amount) {
      return res.status(400).json({ success: false, error: 'fromToken, toToken, and amount are required' });
    }
    
    const result = await mmWallet.swap({ fromToken, toToken, amount, chainId, slippage, wait });
    res.json({ success: true, swap: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/wallet/swap/quote - Get swap quote
 * Body: { fromToken, toToken, amount, chainId? }
 */
router.post('/swap/quote', checkWalletAvailable, async (req, res) => {
  try {
    const { fromToken, toToken, amount, chainId = 8453 } = req.body;
    
    if (!fromToken || !toToken || !amount) {
      return res.status(400).json({ success: false, error: 'fromToken, toToken, and amount are required' });
    }
    
    const result = await mmWallet.getSwapQuote({ fromToken, toToken, amount, chainId });
    res.json({ success: true, quote: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/wallet/send-transaction - Send raw transaction
 * Body: { to, data, value?, chainId?, wait? }
 */
router.post('/send-transaction', checkWalletAvailable, async (req, res) => {
  try {
    const { to, data, value = '0', chainId = 8453, wait = true } = req.body;
    
    if (!to || !data) {
      return res.status(400).json({ success: false, error: 'to and data are required' });
    }
    
    const result = await mmWallet.sendTransaction({ to, data, value, chainId, wait });
    res.json({ success: true, transaction: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/wallet/sign-message - Sign a message
 * Body: { message }
 */
router.post('/sign-message', checkWalletAvailable, async (req, res) => {
  try {
    const { message } = req.body;
    
    if (!message) {
      return res.status(400).json({ success: false, error: 'message is required' });
    }
    
    const result = await mmWallet.signMessage(message);
    res.json({ success: true, signature: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/wallet/sign-typed-data - Sign EIP-712 typed data
 * Body: { domain, types, message }
 */
router.post('/sign-typed-data', checkWalletAvailable, async (req, res) => {
  try {
    const { domain, types, message } = req.body;
    
    if (!domain || !types || !message) {
      return res.status(400).json({ success: false, error: 'domain, types, and message are required' });
    }
    
    const result = await mmWallet.signTypedData(domain, types, message);
    res.json({ success: true, signature: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/wallet/trading-mode - Get current trading mode
 */
router.get('/trading-mode', checkWalletAvailable, async (req, res) => {
  try {
    const mode = await mmWallet.getTradingMode();
    res.json({ success: true, mode });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/wallet/trading-mode - Set trading mode
 * Body: { mode } (guard or beast)
 */
router.post('/trading-mode', checkWalletAvailable, async (req, res) => {
  try {
    const { mode } = req.body;
    
    if (!mode || !['guard', 'beast'].includes(mode)) {
      return res.status(400).json({ success: false, error: 'mode must be "guard" or "beast"' });
    }
    
    const result = await mmWallet.setTradingMode(mode);
    res.json({ success: true, mode: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/wallet/policy - Get wallet policy
 */
router.get('/policy', checkWalletAvailable, async (req, res) => {
  try {
    const policy = await mmWallet.getPolicy();
    res.json({ success: true, policy });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/wallet/policy - Set wallet policy
 * Body: { policy } (YAML string)
 */
router.post('/policy', checkWalletAvailable, async (req, res) => {
  try {
    const { policy } = req.body;
    
    if (!policy) {
      return res.status(400).json({ success: false, error: 'policy YAML is required' });
    }
    
    const result = await mmWallet.setPolicy(policy);
    res.json({ success: true, policy: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/wallet/list - List all wallets
 */
router.get('/list', checkWalletAvailable, async (req, res) => {
  try {
    const wallets = await mmWallet.listWallets();
    res.json({ success: true, wallets });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/wallet/auth - Get auth status
 */
router.get('/auth', checkWalletAvailable, async (req, res) => {
  try {
    const auth = await mmWallet.getAuthStatus();
    res.json({ success: true, auth });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/wallet/clear-cache - Clear wallet cache
 */
router.post('/clear-cache', checkWalletAvailable, (req, res) => {
  mmWallet.clearCache();
  res.json({ success: true, message: 'Cache cleared' });
});

module.exports = router;