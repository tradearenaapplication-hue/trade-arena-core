/**
 * MM Wallet Setup & Configuration Script
 * Trade Arena v4 • Run this to configure mm CLI wallet for trading
 * 
 * Usage: node mm-wallet-setup.js
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

class MMWalletSetup {
  constructor() {
    this.mmPath = 'mm';
    this.configDir = path.join(process.env.HOME || process.env.USERPROFILE, '.metamask');
  }

  async runCommand(cmd, options = {}) {
    try {
      const result = execSync(cmd, { 
        encoding: 'utf-8', 
        stdio: 'pipe',
        timeout: options.timeout || 60000,
        ...options
      });
      return { success: true, output: result };
    } catch (error) {
      return { 
        success: false, 
        output: error.stdout || error.message,
        error: error.message 
      };
    }
  }

  async checkNodeVersion() {
    console.log('🔍 Checking Node.js version...');
    const { output } = await this.runCommand('node --version');
    const version = output.trim().replace('v', '');
    const major = parseInt(version.split('.')[0]);
    
    if (major < 20) {
      console.log(`❌ Node.js ${version} detected. Need v20+ (LTS recommended)`);
      return false;
    }
    
    console.log(`✅ Node.js ${version} - OK`);
    return true;
  }

  async checkMMInstalled() {
    console.log('🔍 Checking MetaMask Agent Wallet CLI...');
    const result = await this.runCommand(`${this.mmPath} --version`);
    
    if (!result.success) {
      console.log('❌ mm CLI not found');
      return false;
    }
    
    console.log(`✅ mm CLI v${result.output.trim()} - OK`);
    return true;
  }

  async installMM() {
    console.log('📦 Installing MetaMask Agent Wallet CLI...');
    const result = await this.runCommand('npm install -g @metamask/agent-wallet@latest', { timeout: 120000 });
    
    if (!result.success) {
      console.log('❌ Installation failed:', result.error);
      return false;
    }
    
    console.log('✅ MetaMask Agent Wallet CLI installed');
    return true;
  }

  async runDoctor() {
    console.log('🏥 Running mm doctor...');
    const result = await this.runCommand(`${this.mmPath} doctor --json`);
    
    if (!result.success) {
      console.log('❌ Doctor check failed:', result.error);
      return null;
    }
    
    try {
      const doctor = JSON.parse(result.output);
      console.log('✅ Doctor check passed');
      return doctor;
    } catch (e) {
      console.log('⚠️ Could not parse doctor output:', result.output);
      return null;
    }
  }

  async checkAuth() {
    console.log('🔐 Checking authentication...');
    const result = await this.runCommand(`${this.mmPath} wallet address --json`);
    
    if (!result.success) {
      console.log('❌ Not authenticated or no wallet');
      return null;
    }
    
    try {
      const wallet = JSON.parse(result.output);
      console.log(`✅ Authenticated: ${wallet.address}`);
      return wallet;
    } catch (e) {
      console.log('⚠️ Could not parse wallet address');
      return null;
    }
  }

  async loginBrowser() {
    console.log('🌐 Opening browser for authorization...');
    console.log('   Please complete authorization in the browser window');
    const result = await this.runCommand(`${this.mmPath} login browser --no-wait`, { timeout: 10000 });
    
    if (!result.success) {
      console.log('❌ Browser login failed:', result.error);
      return false;
    }
    
    console.log('✅ Browser login initiated');
    return true;
  }

  async waitForAuth(timeoutMs = 120000) {
    console.log(`⏳ Waiting for authorization (${timeoutMs/1000}s timeout)...`);
    
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const wallet = await this.checkAuth();
      if (wallet) return wallet;
      
      await new Promise(r => setTimeout(r, 3000));
    }
    
    console.log('❌ Authorization timeout');
    return null;
  }

  async initWallet() {
    console.log('🔧 Initializing wallet...');
    const result = await this.runCommand(`${this.mmPath} init`);
    
    if (!result.success) {
      console.log('❌ Wallet init failed:', result.error);
      return false;
    }
    
    console.log('✅ Wallet initialized');
    return true;
  }

  async checkBalances() {
    console.log('💰 Checking balances...');
    const result = await this.runCommand(`${this.mmPath} wallet balance --chain-ids 8453,42161,10 --json`);
    
    if (!result.success) {
      console.log('❌ Balance check failed:', result.error);
      return null;
    }
    
    try {
      const balances = JSON.parse(result.output);
      console.log('✅ Balances retrieved');
      
      for (const [chainId, chain] of Object.entries(balances.chains)) {
        const chainNames = { '8453': 'Base', '42161': 'Arbitrum', '10': 'Optimism' };
        console.log(`   ${chainNames[chainId] || chainId}: $${chain.totalUSD?.toFixed(2) || '0.00'}`);
        for (const [symbol, token] of Object.entries(chain.tokens)) {
          if (token.amount > 0) {
            console.log(`      ${symbol}: ${token.amount.toFixed(6)} ($${token.usdValue?.toFixed(2) || '0.00'})`);
          }
        }
      }
      
      return balances;
    } catch (e) {
      console.log('⚠️ Could not parse balances');
      return null;
    }
  }

  async createEnvFile() {
    const envPath = path.join(__dirname, '.env');
    const envContent = `# Trade Arena v4 - MM Wallet Configuration
# Generated by mm-wallet-setup.js

# MM CLI Path (default: mm)
MM_CLI_PATH=mm

# Default chain for trading (8453=Base, 42161=Arbitrum, 10=Optimism)
DEFAULT_CHAIN_ID=8453

# Wallet cache timeout in ms
WALLET_CACHE_TIMEOUT=30000

# Server port
PORT=3001

# RPC URLs (optional - mm CLI uses its own)
# BASE_RPC_URL=https://mainnet.base.org
# ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc
# OPTIMISM_RPC_URL=https://mainnet.optimism.io
`;

    if (fs.existsSync(envPath)) {
      console.log('⚠️ .env file already exists, skipping creation');
      return false;
    }
    
    fs.writeFileSync(envPath, envContent);
    console.log('✅ Created .env file with default configuration');
    return true;
  }

  async run() {
    console.log('═══════════════════════════════════════════════');
    console.log('   Trade Arena v4 • MM Wallet Setup');
    console.log('═══════════════════════════════════════════════\n');

    // Step 1: Check Node version
    if (!(await this.checkNodeVersion())) {
      console.log('\n❌ Setup failed: Node.js v20+ required');
      process.exit(1);
    }

    // Step 2: Check/install mm CLI
    if (!(await this.checkMMInstalled())) {
      console.log('\n📦 Installing mm CLI...');
      if (!(await this.installMM())) {
        console.log('\n❌ Setup failed: Could not install mm CLI');
        process.exit(1);
      }
    }

    // Step 3: Run doctor
    await this.runDoctor();

    // Step 4: Check auth
    let wallet = await this.checkAuth();
    
    if (!wallet) {
      console.log('\n🔐 No authenticated wallet found.');
      console.log('   Starting browser authorization...');
      
      if (await this.loginBrowser()) {
        wallet = await this.waitForAuth();
      }
    }

    if (!wallet) {
      console.log('\n❌ Setup failed: Could not authenticate wallet');
      console.log('   Try running manually: mm login browser --no-wait');
      process.exit(1);
    }

    // Step 5: Initialize wallet if needed
    const doctor = await this.runDoctor();
    if (doctor && doctor.wallets && doctor.wallets.length === 0) {
      await this.initWallet();
    }

    // Step 6: Check balances
    await this.checkBalances();

    // Step 7: Create .env file
    await this.createEnvFile();

    console.log('\n═══════════════════════════════════════════════');
    console.log('   ✅ Setup Complete!');
    console.log('═══════════════════════════════════════════════\n');
    console.log('Next steps:');
    console.log('  1. Start the server: npm start');
    console.log('  2. Open http://localhost:3001');
    console.log('  3. The wallet will connect automatically via mm CLI');
    console.log('\nUseful commands:');
    console.log('  mm wallet address          # Show wallet address');
    console.log('  mm wallet balance --json   # Show balances (JSON)');
    console.log('  mm wallet list             # List all wallets');
    console.log('  mm policy get              # Get current policy');
    console.log('  mm policy set <yaml>       # Set policy');
  }
}

// Run if called directly
if (require.main === module) {
  const setup = new MMWalletSetup();
  setup.run().catch(console.error);
}

module.exports = { MMWalletSetup };