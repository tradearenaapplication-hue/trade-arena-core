const express = require('express');
const router = express.Router();
const { execSync } = require('child_process');

// MetaMask Agent Wallet Status endpoint
router.get('/mm-status', (req, res) => {
    const mmStatus = {
        authenticated: !!process.env.MM_WALLET_AUTHENTICATED,
        mode: process.env.MM_WALLET_MODE || 'none',
        tradingMode: process.env.MM_WALLET_TRADING_MODE || 'none',
        address: process.env.MM_WALLET_ADDRESS || null,
        cliVersion: null,
        projectId: null
    };

    try {
        const mmVersion = execSync('mm --version', { encoding: 'utf8' }).trim();
        mmStatus.cliVersion = mmVersion;
        
        if (process.env.MM_WALLET_AUTHENTICATED === 'true') {
            try {
                const address = execSync('mm wallet address', { encoding: 'utf8' }).trim();
                mmStatus.address = address;
                
                // Get project info
                const projectInfo = execSync('mm init show', { encoding: 'utf8' }).trim();
                const match = projectInfo.match(/projectId:\s*(\S+)/);
                mmStatus.projectId = match ? match[1] : null;
            } catch (e) {
                console.error('[MM Wallet] Error getting wallet address:', e.message);
            }
        }
    } catch (e) {
        console.error('[MM Wallet] Error checking CLI:', e.message);
    }

    res.json(mmStatus);
});

// MetaMask Agent Wallet login check endpoint
router.get('/mm-login-status', (req, res) => {
    res.json({
        authenticated: process.env.MM_WALLET_AUTHENTICATED === 'true',
        mode: process.env.MM_WALLET_MODE || 'none',
        address: process.env.MM_WALLET_ADDRESS || null
    });
});

// Execute trade via mm wallet
router.post('/mm/execute-trade', async (req, res) => {
    try {
        const { token, amount, method } = req.body;
        
        if (!token || !amount) {
            return res.status(400).json({ error: 'Token and amount required' });
        }
        
        // Execute trade using mm CLI
        const command = `mm wallet send-transaction --amount ${amount} --token ${token}`;
        const result = execSync(command, { encoding: 'utf8', timeout: 30000 });
        
        res.json({
            success: true,
            txHash: result.match(/tx hash:? (.+)/i)?.[1] || result.trim(),
            message: 'Trade executed via mm wallet'
        });
    } catch (error) {
        console.error('[MM Wallet] Trade execution error:', error.message);
        res.status(500).json({ error: error.message || 'Trade execution failed' });
    }
});

// Get wallet balance via mm CLI
router.get('/mm/balance', (req, res) => {
    try {
        const balanceCmd = 'mm perps balance --venue base';
        const balanceResult = execSync(balanceBalanceCmd, { encoding: 'utf8', timeout: 10000 });
        res.json({
            success: true,
            balance: balanceResult.trim(),
            source: 'mm_cli'
        });
    } catch (error) {
        console.error('[MM Wallet] Balance check error:', error.message);
        res.status(500).json({ error: 'Balance check failed' });
    }
});

module.exports = router;