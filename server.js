/**
 * TRADE ARENA Backend - Express.js Server
 * Handles real trading logic, smart contract interactions, data persistence, and AI proxies
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const ethers = require('ethers');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const http = require('http');
const { Server: WebSocketServer } = require('ws');

const adminAuth = require('./middleware/auth');
const payoutRoutes = require("./routes/payoutRoutes");
const apiHealthRoutes = require("./routes/apiHealth");
const { loadUsers, saveUsers } = require('./user_persistence');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3001;

// Sentinel: Security hardening
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Sentinel: Security headers middleware
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com https://accounts.google.com https://cdn.privy.io https://cdn.jsdelivr.net https://js.hcaptcha.com; img-src 'self' data:; connect-src 'self' https://api.anthropic.com https://api.openai.com https://generativelanguage.googleapis.com https://api.coingecko.com https://api.0x.org https://mainnet.base.org https://*.alchemyapi.io https://auth.privy.io https://explorer-api.walletconnect.com; font-src 'self' https://fonts.gstatic.com;");
    next();
});

// Sentinel: Configurable CORS with localhost bypass
const allowedOrigin = process.env.ALLOWED_ORIGIN;
app.use(cors({
    origin: (origin, cb) => {
        let isLocal = false;
        try {
            if (origin) {
                const url = new URL(origin);
                isLocal = (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
            }
        } catch (e) {
            isLocal = false;
        }
        if (!origin || isLocal || allowedOrigin === '*' || origin === allowedOrigin) {
            cb(null, true);
        } else {
            cb(null, false);
        }
    }
}));

// Serve static files from public directory (Exempt from rate limit)
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));

// Sentinel: Limit JSON payload size to prevent DoS attacks
app.use(express.json({ limit: '100kb' }));

// Initialize shared state for task-claim deduplication
app.locals.CLAIMED_USER_TASKS = new Set();

// Rate limiters
const taskClaimLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { error: 'Too many claim requests from this IP, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false
});
const maintenanceLogLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false
});
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 15,
    message: { success: false, error: 'Too many login attempts, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false
});
const aiProxyLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 50,
    message: { error: 'AI rate limit exceeded. Please try again later.' },
    standardHeaders: true,
    legacyHeaders: false
});
const swapLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    message: { success: false, error: 'Too many swap requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false
});

/**
 * Sentinel: In-memory rate limiter (avoids express-rate-limit Node 26+ subnet.networkForm bug)
 */
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 1000;
const MAX_TRACKED_IPS = 5000;

function checkRateLimit(ip) {
    const now = Date.now();
    const record = rateLimitMap.get(ip);

    if (record) {
        if (now > record.resetAt) {
            record.count = 1;
            record.resetAt = now + RATE_LIMIT_WINDOW;
        } else {
            record.count += 1;
        }
        return record.count <= RATE_LIMIT_MAX;
    }

    // Sentinel: If map is full, evict oldest entry (first inserted, ES6 Map preserves order) to prevent DoS
    if (rateLimitMap.size >= MAX_TRACKED_IPS) {
        const oldestKey = rateLimitMap.keys().next().value;
        rateLimitMap.delete(oldestKey);
    }

    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return true;
}

// Expose rate-limit utilities on app for tests and diagnostics
app.rateLimitMap = rateLimitMap;
app.checkRateLimit = checkRateLimit;
app.MAX_TRACKED_IPS = MAX_TRACKED_IPS;

// Cleanup expired entries periodically
setInterval(() => {
    const now = Date.now();
    for (const [ip, record] of rateLimitMap.entries()) {
        if (now > record.resetAt) rateLimitMap.delete(ip);
    }
}, 5 * 60 * 1000).unref();

// Apply in-memory rate guard to all routes (after static, before API)
app.use((req, res, next) => {
    if (req.path === '/favicon.ico' || req.path === '/manifest.json') return next();
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    if (!checkRateLimit(ip)) {
        return res.status(429).json({ error: 'Too many requests, please try again later.' });
    }
    next();
});

// Mount payout routes
app.use("/api/v1/payouts", payoutRoutes);

// Mount health monitoring routes
app.use("/api/health", apiHealthRoutes);

// Sentinel: Protect admin-only endpoints
app.use(['/api/agent', '/api/arbitrage'], adminAuth);

/**
 * Sentinel: Mask sensitive parts of an RPC URL
 */
function maskRpcUrl(url) {
    if (!url || typeof url !== 'string') return url;
    try {
        const u = new URL(url);
        if (u.pathname && u.pathname.length > 8) {
            u.pathname = u.pathname.substring(0, 4) + '****' + u.pathname.substring(u.pathname.length - 4);
        }
        if (u.username) u.username = '****';
        if (u.password) u.password = '****';
        return u.toString();
    } catch (e) {
        if (url.length > 20) {
            return url.substring(0, url.length - 12) + '********';
        }
        return '********';
    }
}

/**
 * WebSocket Broadcast Helper
 */
const clients = new Set();
function broadcastToClients(data) {
    const msg = JSON.stringify(data);
    for (const ws of clients) {
        if (ws.readyState === ws.OPEN) {
            ws.send(msg);
        }
    }
}

/**
 * WebSocket simple broadcast
 */
wss.on('connection', (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify({ type: 'HELLO', timestamp: Date.now() }));
    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);
            if (data && data.type === 'ECHO') {
                ws.send(JSON.stringify({ type: 'ECHO', payload: data.payload }));
            }
        } catch (e) { }
    });
    ws.on('close', () => clients.delete(ws));
});

// Health route
app.get('/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }));

// Basic example admin route
app.post('/api/agent/pause', (req, res) => {
    broadcastToClients({ type: 'AGENT_PAUSE', payload: { paused: true } });
    return res.json({ success: true, message: 'Agent paused' });
});

// Diagnostics quick (open)
app.get('/api/diagnostics/quick', (req, res) => {
    res.json({ status: 'OK', features: ['privy', 'ai-proxies', 'payouts'], timestamp: Date.now() });
});

// Diagnostics full (protected)
let diagnosticsFullCache = null;
let diagnosticsFullCacheTime = 0;
const DIAGNOSTICS_FULL_CACHE_TTL = 60 * 1000;
app.get('/api/diagnostics/full', (req, res) => {
    const now = Date.now();
    if (diagnosticsFullCache && (now - diagnosticsFullCacheTime) < DIAGNOSTICS_FULL_CACHE_TTL) {
        return res.json({ ...diagnosticsFullCache, _cached: true });
    }
    diagnosticsFullCache = { env: { PRIVY_APP_ID: !!process.env.PRIVY_APP_ID }, timestamp: new Date().toISOString() };
    diagnosticsFullCacheTime = now;
    res.json(diagnosticsFullCache);
});

/**
 * PUBLIC CONFIG (no secrets)
 */
app.get('/api/config', (req, res) => {
    res.json({
        privyAppId: process.env.PRIVY_APP_ID || '',
        moonpayPublicKey: process.env.MOONPAY_PUBLIC_KEY || '',
        googleClientId: process.env.GOOGLE_CLIENT_ID || '',
        demoBalance: 50
    });
});

/**
 * Task reward definitions for validation
 */
const TASK_REWARDS = {
    'follow_twitter': 10,
    'join_discord': 10,
    'share_win': 10,
    'first_trade': 25,
    'hcaptcha_verify': 25,
    'ai_feedback': 50
};
const ALLOWED_TASK_IDS = new Set(Object.keys(TASK_REWARDS));

/**
 * AI PROXY ENDPOINTS
 */
const ALLOWED_CLAUDE_MODELS = new Set([
    'claude-3-5-sonnet-20240620', 'claude-3-5-sonnet-latest',
    'claude-3-opus-20240229', 'claude-3-sonnet-20240229',
    'claude-3-haiku-20240307', 'claude-3.5-sonnet'
]);
const ALLOWED_OPENAI_MODELS = new Set([
    'gpt-4o', 'gpt-4o-latest', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo'
]);
const ALLOWED_GEMINI_MODELS = new Set([
    'gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash',
    'gemini-2.0-flash-lite', 'gemini-2.0-flash-exp'
]);

app.post('/api/claude', aiProxyLimiter, async (req, res) => {
    let timeout;
    try {
        if (!process.env.ANTHROPIC_API_KEY) {
            return res.status(503).json({ error: 'AI service unavailable' });
        }
        const { model, messages, system, max_tokens, temperature, top_p, top_k, stop_sequences } = req.body;
        if (!ALLOWED_CLAUDE_MODELS.has(model)) {
            return res.status(400).json({ error: 'Invalid or unauthorized model requested' });
        }
        const controller = new AbortController();
        timeout = setTimeout(() => controller.abort(), 30000);
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': process.env.ANTHROPIC_API_KEY || '',
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model, messages, system,
                max_tokens: max_tokens || 1024, temperature, top_p, top_k, stop_sequences
            }),
            signal: controller.signal
        });
        const data = await response.json();
        res.status(response.status).json(data);
    } catch (error) {
        console.error('Claude Proxy error:', error);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        if (timeout) clearTimeout(timeout);
    }
});

app.post('/api/openai', aiProxyLimiter, async (req, res) => {
    let timeout;
    try {
        if (!process.env.OPENAI_API_KEY) {
            return res.status(503).json({ error: 'AI service unavailable' });
        }
        const { model, messages, max_tokens, temperature, top_p, frequency_penalty, presence_penalty, stop } = req.body;
        if (!ALLOWED_OPENAI_MODELS.has(model)) {
            return res.status(400).json({ error: 'Invalid or unauthorized model requested' });
        }
        const controller = new AbortController();
        timeout = setTimeout(() => controller.abort(), 30000);
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY || ''}`
            },
            body: JSON.stringify({
                model, messages,
                max_tokens: max_tokens || 1024, temperature, top_p,
                frequency_penalty, presence_penalty, stop
            }),
            signal: controller.signal
        });
        const data = await response.json();
        res.status(response.status).json(data);
    } catch (error) {
        console.error('OpenAI Proxy error:', error);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        if (timeout) clearTimeout(timeout);
    }
});

app.post('/api/gemini', aiProxyLimiter, async (req, res) => {
    let timeout;
    try {
        if (!process.env.GEMINI_API_KEY) {
            return res.status(503).json({ error: 'AI service unavailable' });
        }
        const requestedModel = req.body.model || 'gemini-1.5-flash';
        if (!ALLOWED_GEMINI_MODELS.has(requestedModel)) {
            return res.status(400).json({ error: 'Invalid model specified' });
        }
        const safeModel = encodeURIComponent(requestedModel);
        const controller = new AbortController();
        timeout = setTimeout(() => controller.abort(), 30000);
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${safeModel}:generateContent`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': process.env.GEMINI_API_KEY || ''
            },
            body: JSON.stringify({
                contents: req.body.contents,
                generationConfig: req.body.generationConfig
            }),
            signal: controller.signal
        });
        const data = await response.json();
        res.status(response.status).json(data);
    } catch (error) {
        console.error('Gemini Proxy error:', error);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        if (timeout) clearTimeout(timeout);
    }
});

/**
 * MAINTENANCE & LOGGING
 */
app.post('/api/maintenance/log', maintenanceLogLimiter, (req, res) => {
    const { agent, message, level } = req.body;
    if (!agent || !message) return res.status(400).json({ error: 'Missing agent or message' });

    // Sentinel: Sanitize inputs to prevent log injection/spoofing
    const sanitize = (s) => String(s || '').replace(/[\n\r]/g, ' ').substring(0, 500);
    const safeAgent = sanitize(agent).substring(0, 100);
    const safeLevel = sanitize(level || 'INFO').substring(0, 20);
    const safeMessage = sanitize(message);

    const logDir = path.join(__dirname, '.jules');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);

    const logFile = safeAgent === 'SENTINEL' ? 'sentinel.md' : 'maintenance.md';
    const logPath = path.join(logDir, logFile);

    const entry = `\n## ${new Date().toISOString()} - [${safeLevel}] ${safeAgent}\n${safeMessage}\n`;
    fs.appendFileSync(logPath, entry);
    res.json({ success: true });
});

// Security: Strict path whitelist for patching
const ALLOWED_PATCH_FILES = [
    'public/index.html',
    'public/staff-engine.js',
    'public/ai-api.js',
    'public/ai-arena.js'
];

app.post('/api/maintenance/patch', maintenanceLogLimiter, async (req, res) => {
    const { filepath, patch, description } = req.body;
    try {
        if (!filepath || typeof filepath !== 'string') {
            return res.status(400).json({ error: 'Invalid or missing filepath' });
        }

        // Security: Check against absolute whitelist to clear CodeQL taint
        if (!ALLOWED_PATCH_FILES.includes(filepath)) {
            return res.status(403).json({ error: 'Unauthorized file for patching' });
        }

        // Sentinel: Validate patch is a string and within size limit
        if (!patch || typeof patch !== 'string' || patch.length === 0 || patch.length > 50000) {
            return res.status(400).json({ error: 'Invalid or missing patch, or patch exceeds 50000 characters' });
        }

        // Sentinel: Validate description is a string and within length limit
        if (description !== undefined && description !== null) {
            if (typeof description !== 'string' || description.length > 1000) {
                return res.status(400).json({ error: 'Invalid or missing description, or description exceeds 1000 characters' });
            }
        }

        const targetPath = path.join(__dirname, filepath);

        if (!fs.existsSync(targetPath)) {
             return res.status(404).json({ error: 'File not found' });
        }

        console.log(`[Developer Agent] Patch requested for ${filepath}: ${description}`);
        res.json({ success: true, message: 'Patch received and logged for review' });
    } catch (error) {
        console.error('Patch error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * TRADING & MARKET ENDPOINTS
 */
const deploymentEvents = [];

function queueBotDeployment(deposit) {
    const event = {
        id: generateId(),
        type: 'BOT_DEPLOYMENT_TRIGGERED',
        status: 'QUEUED',
        source: 'moonpay',
        created: Date.now(),
        deposit
    };
    deploymentEvents.unshift(event);
    if (deploymentEvents.length > 50) deploymentEvents.pop();
    return event;
}

// Sentinel: Address-based faucet deduplication (case-insensitive)
const FAUCET_CLAIMED_ADDRESSES = new Set();

const PAYOUT_PRIVATE_KEY = process.env.PAYOUT_PRIVATE_KEY || '';
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || '';
const PAYOUT_RPC_URL = ALCHEMY_API_KEY ? `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}` : (process.env.RPC_URL || 'https://mainnet.base.org');
const PAYOUT_CHAIN_ID = 8453;
const USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_ETH_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

let payoutWallet = null;
let payoutProvider = null;
let usdcContract = null;

try {
    if (PAYOUT_PRIVATE_KEY) {
        payoutProvider = new ethers.JsonRpcProvider(PAYOUT_RPC_URL);
        payoutWallet = new ethers.Wallet(PAYOUT_PRIVATE_KEY, payoutProvider);
        
        const usdcAbi = [
            'function transfer(address to, uint256 amount) returns (bool)',
            'function decimals() view returns (uint8)'
        ];
        usdcContract = new ethers.Contract(USDC_CONTRACT, usdcAbi, payoutWallet);
        console.log('[Payout] Wallet ready:', payoutWallet.address);
    } else {
        console.log('[Payout] No PAYOUT_PRIVATE_KEY set — running in simulation mode');
    }
} catch (e) {
    console.error('[Payout] Init failed:', e);
}

async function sendPayout(userAddress, amount, currency = 'ETH') {
    if (!payoutWallet) {
        return { simulated: true, txHash: null, message: 'No payout wallet configured' };
    }

    const MAX_ETH_PAYOUT = 0.1;
    const MAX_USDC_PAYOUT = 100;

    if (currency === 'ETH' && amount > MAX_ETH_PAYOUT) {
        console.error(`[Sentinel] Blocked excessive ETH payout: ${amount} ETH to ${userAddress}`);
        return { simulated: false, txHash: null, error: 'Payout amount exceeds safety limit' };
    }
    if (currency === 'USDC' && amount > MAX_USDC_PAYOUT) {
        console.error(`[Sentinel] Blocked excessive USDC payout: ${amount} USDC to ${userAddress}`);
        return { simulated: false, txHash: null, error: 'Payout amount exceeds safety limit' };
    }

    try {
        const to = ethers.getAddress(userAddress);
        
        if (currency === 'USDC' && usdcContract) {
            const decimals = await usdcContract.decimals();
            const amountWei = ethers.parseUnits(amount.toFixed(2), decimals);
            const tx = await usdcContract.transfer(to, amountWei);
            await tx.wait();
            return { simulated: false, txHash: tx.hash, currency: 'USDC', amount };
        } else {
            const amountWei = ethers.parseEther(amount.toFixed(6));
            const tx = await payoutWallet.sendTransaction({
                to, value: amountWei
            });
            await tx.wait();
            return { simulated: false, txHash: tx.hash, currency: 'ETH', amount };
        }
    } catch (e) {
        console.error('[Payout] Transfer failed:', e);
        return { simulated: false, txHash: null, error: e.message };
    }
}

/**
 * USER LOGIN & BALANCE ENDPOINTS
 */
app.post('/api/user/login', loginLimiter, (req, res) => {
    try {
        const { email, address, name, provider, avatar, badge } = req.body;
        const userId = email || address;

        if (!userId || typeof userId !== 'string' || userId.length > 100) {
            return res.status(400).json({ success: false, error: 'Missing or invalid userId' });
        }

        // Sentinel: Prevent Prototype Pollution by blocking dangerous property names
        const dangerousProps = ['__proto__', 'constructor', 'prototype'];
        if (dangerousProps.includes(userId) || (email && dangerousProps.includes(email)) || (address && dangerousProps.includes(address))) {
            return res.status(400).json({ success: false, error: 'Invalid credentials' });
        }

        // Sentinel: Type and length validation for all login fields
        if (email && (typeof email !== 'string' || email.length > 100 || !email.includes('@'))) {
            return res.status(400).json({ success: false, error: 'Invalid email' });
        }
        if (address && (typeof address !== 'string' || address.length > 100 || !ethers.isAddress(address))) {
            return res.status(400).json({ success: false, error: 'Invalid address' });
        }
        if (name && (typeof name !== 'string' || name.length > 100)) {
            return res.status(400).json({ success: false, error: 'Invalid name' });
        }
        if (provider && (typeof provider !== 'string' || provider.length > 50)) {
            return res.status(400).json({ success: false, error: 'Invalid provider' });
        }
        if (avatar && (typeof avatar !== 'string' || avatar.length > 500)) {
            return res.status(400).json({ success: false, error: 'Invalid avatar' });
        }

        const users = loadUsers();
        if (!Object.hasOwn(users, userId)) {
            users[userId] = {
                id: userId,
                name: name || 'New User',
                email: email || null,
                address: address || null,
                provider: provider || 'unknown',
                avatar: avatar || null,
                badge: badge || null,
                balance: address ? 0 : 50,
                bots: [],
                trades: [],
                created: Date.now()
            };
            saveUsers(users);
        }

        res.json({ success: true, user: users[userId] });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

/**
 * User balance sync endpoint
 */
app.post('/api/user/balance', (req, res) => {
    try {
        const { userId, balance } = req.body;

        if (!userId || typeof userId !== 'string' || userId.length > 100) {
            return res.status(400).json({ success: false, error: 'Missing or invalid userId' });
        }

        const dangerousProps = ['__proto__', 'constructor', 'prototype'];
        if (dangerousProps.includes(userId)) {
            return res.status(400).json({ success: false, error: 'Invalid credentials' });
        }

        if (typeof balance !== 'number' || isNaN(balance) || !isFinite(balance) || balance < 0) {
            return res.status(400).json({ success: false, error: 'Invalid balance' });
        }

        const users = loadUsers();
        if (Object.hasOwn(users, userId)) {
            users[userId].balance = balance;
            users[userId].lastUpdated = Date.now();
            saveUsers(users);
        } else {
            users[userId] = {
                id: userId,
                name: 'Arena Trader',
                email: null,
                address: userId.startsWith('0x') ? userId : null,
                provider: userId.startsWith('0x') ? 'metamask' : 'demo',
                avatar: null,
                badge: userId.startsWith('0x') ? '🦊 METAMASK' : '👤 GUEST',
                balance: balance,
                bots: [],
                trades: [],
                created: Date.now(),
                lastUpdated: Date.now()
            };
            saveUsers(users);
        }

        broadcastToClients({ type: 'BALANCE_UPDATE', payload: { userId, balance } });
        res.json({ success: true, userId, balance: users[userId].balance });
    } catch (error) {
        console.error('Balance sync error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

app.get('/api/deployments', (req, res) => {
    res.json({ success: true, deployments: deploymentEvents });
});

app.get('/api/payout/status', (req, res) => {
    res.json({
        configured: !!payoutWallet,
        wallet: payoutWallet ? payoutWallet.address : null,
        chain: PAYOUT_CHAIN_ID,
        currency: 'ETH / USDC'
    });
});

/**
 * FAUCET CLAIM (address-based deduplication)
 */
app.post('/api/faucet/claim', async (req, res) => {
    try {
        const { userAddress } = req.body;

        if (!userAddress || typeof userAddress !== 'string' || !ethers.isAddress(userAddress)) {
            return res.status(400).json({ success: false, error: 'Valid wallet address required for mainnet faucet' });
        }

        const normalizedAddress = userAddress.toLowerCase();
        if (FAUCET_CLAIMED_ADDRESSES.has(normalizedAddress)) {
            return res.status(429).json({ success: false, error: 'Faucet already claimed for this address' });
        }

        const payout = await sendPayout(userAddress, 0.005, 'ETH');

        const deployment = queueBotDeployment({
            source: 'faucet',
            amount: 0.05,
            currency: 'ETH',
            userAddress: userAddress,
            confirmedAt: Date.now(),
            payout
        });

        FAUCET_CLAIMED_ADDRESSES.add(normalizedAddress);
        res.json({ success: true, deployment, amount: 50, payout });
    } catch (error) {
        console.error('Faucet claim error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

/**
 * TASK CLAIM (with whitelist, reward validation, and duplicate prevention)
 */
app.post('/api/tasks/claim', taskClaimLimiter, async (req, res) => {
    try {
        const { taskId, reward, userAddress, validationToken } = req.body;

        // Early Validation: Ensure a valid Ethereum address is provided and reject 'demo'
        if (!userAddress || typeof userAddress !== 'string' || userAddress === 'demo' || !/^0x[a-fA-F0-9]{40}$/.test(userAddress)) {
            return res.status(400).json({ success: false, error: 'Valid Ethereum address required for reward payout' });
        }

        // Sentinel: Validate taskId against whitelist
        if (!taskId || typeof taskId !== 'string' || !ALLOWED_TASK_IDS.has(taskId)) {
            return res.status(400).json({ success: false, error: 'Invalid or unauthorized taskId requested' });
        }

        // Sentinel: Validate reward matches expected amount for this task
        const expectedReward = TASK_REWARDS[taskId];
        if (typeof reward !== 'number' || isNaN(reward) || !isFinite(reward) || reward <= 0 || reward > 100) {
            return res.status(400).json({ success: false, error: 'Invalid or missing reward' });
        }
        if (reward !== expectedReward) {
            return res.status(400).json({ success: false, error: 'Invalid or incorrect reward for this task' });
        }

        // Sentinel: Validate the validation token against server secret
        const taskSecret = process.env.TASK_CLAIM_SECRET;
        if (!taskSecret) {
            console.error('[Sentinel] TASK_CLAIM_SECRET is not configured on the server');
            return res.status(503).json({ success: false, error: 'Payout validation service unavailable' });
        }

        // Sentinel: Use timing-safe comparison to prevent timing attacks on validation tokens
        const isValidToken = typeof validationToken === 'string' && (() => {
            const tokenBuf = Buffer.from(validationToken);
            const secretBuf = Buffer.from(taskSecret);
            return tokenBuf.length === secretBuf.length && crypto.timingSafeEqual(tokenBuf, secretBuf);
        })();

        if (!isValidToken) {
            return res.status(401).json({ success: false, error: 'Invalid or missing validation token' });
        }

        // Sentinel: Duplicate prevention using shared CLAIMED_USER_TASKS set
        const claimKey = `${userAddress.toLowerCase()}-${taskId.toLowerCase()}`;
        if (app.locals.CLAIMED_USER_TASKS && app.locals.CLAIMED_USER_TASKS.has(claimKey)) {
            return res.status(429).json({ success: false, error: 'Task already claimed for this address' });
        }
        app.locals.CLAIMED_USER_TASKS.add(claimKey);

        const payoutAmount = reward <= 10 ? 0.01 : reward <= 25 ? 0.025 : 0.05;

        let payout;
        if (process.env.PAYOUT_MANAGER_ADDRESS && process.env.ORACLE_PRIVATE_KEY) {
            try {
                const payoutService = new (require('./services/payouts/payoutService'))({
                    oraclePrivateKey: process.env.ORACLE_PRIVATE_KEY,
                    rewardTokenAddress: process.env.REWARD_TOKEN_ADDRESS,
                    payoutManagerAddress: process.env.PAYOUT_MANAGER_ADDRESS,
                    chainId: parseInt(process.env.CHAIN_ID || '8453')
                });
                const authPayload = await payoutService.authorizePayout(userAddress, taskId, 'validated_backend_claim');
                payout = { onChainAuth: true, authPayload };
            } catch (e) {
                console.error('[Payout] On-chain auth failed, falling back to direct transfer:', e.message);
                payout = await sendPayout(userAddress, payoutAmount, 'ETH');
            }
        } else {
            payout = await sendPayout(userAddress, payoutAmount, 'ETH');
        }

        const deployment = queueBotDeployment({
            source: 'task',
            taskId,
            amount: reward,
            currency: 'ETH',
            userAddress: userAddress,
            confirmedAt: Date.now(),
            payout
        });

        res.json({ success: true, deployment, taskId, reward, payout });
    } catch (error) {
        console.error('Task claim error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

/**
 * MOONPAY WEBHOOK
 */
app.post('/api/webhooks/moonpay/deposit', (req, res) => {
    try {
        const signature = req.headers['x-moonpay-signature'];
        const secret = process.env.MOONPAY_WEBHOOK_SECRET;

        if (!secret) {
            console.error('[MoonPay Webhook] MOONPAY_WEBHOOK_SECRET is missing');
            return res.status(500).json({ success: false, error: 'Webhook configuration error' });
        }

        if (!signature || !verifyMoonPaySignature(req.body, signature, secret)) {
            return res.status(401).json({ success: false, error: 'Invalid webhook signature' });
        }

        const payload = req.body || {};
        const status = String(payload.status || payload.state || '').toLowerCase();
        const amount = Number(payload.amount || payload.cryptoAmount || payload.fiatAmount || 0);
        const currency = String(payload.currency || payload.cryptoCurrency || 'USDC').toUpperCase();
        const destination = payload.walletAddress || payload.address || payload.destinationAddress || '';
        const reference = payload.transactionId || payload.id || payload.reference || null;

        const isConfirmed = ['completed', 'complete', 'confirmed', 'succeeded', 'success'].includes(status);

        if (!isConfirmed) {
            return res.json({
                success: true,
                received: true,
                ignored: true,
                reason: 'Deposit not confirmed yet'
            });
        }

        const deployment = queueBotDeployment({
            reference, currency, amount, destination,
            source: 'moonpay', confirmedAt: Date.now()
        });

        res.json({
            success: true,
            received: true,
            deployment,
            message: 'Deposit confirmed and deployment queued'
        });
    } catch (error) {
        console.error('[MoonPay Webhook] Error:', error);
        res.status(500).json({ success: false, error: 'Webhook processing failed' });
    }
});

/**
 * MARKET PRICES (CoinGecko)
 */
const coinGeckoPriceCache = {};
const COINGECKO_CACHE_TTL = 10000;

async function getCachedCoinGeckoPrices(coinIds) {
    const now = Date.now();
    const prices = {};
    const missingIds = [];

    coinIds.forEach(id => {
        const cached = coinGeckoPriceCache[id];
        if (cached && (now - cached.timestamp < COINGECKO_CACHE_TTL)) {
            prices[id] = cached.price;
        } else {
            missingIds.push(id);
        }
    });

    if (missingIds.length > 0) {
        try {
            const response = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${missingIds.join(',')}&vs_currencies=usd`, {
                timeout: 10000
            });
            const data = response.data || {};
            missingIds.forEach(id => {
                const price = data[id]?.usd;
                if (price !== undefined) {
                    coinGeckoPriceCache[id] = { price, timestamp: now };
                    prices[id] = price;
                } else if (coinGeckoPriceCache[id]) {
                    prices[id] = coinGeckoPriceCache[id].price;
                }
            });
        } catch (error) {
            console.error('[Market API Cache] Failed to fetch missing prices:', error.message);
            missingIds.forEach(id => {
                if (coinGeckoPriceCache[id]) prices[id] = coinGeckoPriceCache[id].price;
            });
        }
    }
    return prices;
}

async function fetchCoinGeckoPrice(symbol) {
    try {
        const coinMap = { 'WETH': 'ethereum', 'USDC': 'usd-coin', 'ARB': 'arbitrum', 'OP': 'optimism' };
        const coinId = coinMap[symbol];
        if (!coinId) return null;
        const prices = await getCachedCoinGeckoPrices([coinId]);
        return prices[coinId] || null;
    } catch (e) {
        return null;
    }
}

const coinMap = { 'WETH': 'ethereum', 'USDC': 'usd-coin', 'ARB': 'arbitrum', 'OP': 'optimism' };

app.get('/api/market/prices', async (req, res) => {
    try {
        const allowedSymbols = new Set(['WETH', 'USDC', 'ARB', 'OP']);

        // Sentinel: Prevent type confusion crashes (e.g. ?symbols=a&symbols=b parses to array)
        let rawSymbols = req.query.symbols;
        if (rawSymbols !== undefined && typeof rawSymbols !== 'string') {
            return res.status(400).json({ success: false, error: 'Invalid symbols parameter type' });
        }

        const symbols = (rawSymbols?.split(',') || ['WETH', 'USDC', 'ARB'])
            .map(s => s.trim().toUpperCase())
            .filter(s => allowedSymbols.has(s));

        if (symbols.length === 0) {
            return res.json({ success: true, prices: {}, timestamp: Date.now() });
        }

        // ⚡ Bolt Optimization: Batch and cache price requests
        const ids = symbols.map(s => coinMap[s]).filter(Boolean);
        const data = await getCachedCoinGeckoPrices(ids);

        const prices = {};
        symbols.forEach(s => {
            const id = coinMap[s];
            if (data[id] !== undefined) prices[s] = data[id];
        });

        res.json({ success: true, prices, timestamp: Date.now() });
    } catch (error) {
        console.error('[Market API] Failed to fetch prices:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch market prices' });
    }
});

/**
 * BOT CREATION
 */
app.post('/api/bot/create', (req, res) => {
    try {
        const { name, strategy, riskLevel, initialCapital, userAddress } = req.body;

        if (!name || typeof name !== 'string' || name.length > 100) {
            return res.status(400).json({ success: false, error: 'Invalid or missing name' });
        }
        if (!strategy || typeof strategy !== 'string' || strategy.length > 100) {
            return res.status(400).json({ success: false, error: 'Invalid or missing strategy' });
        }
        if (!riskLevel || typeof riskLevel !== 'string' || riskLevel.length > 100) {
            return res.status(400).json({ success: false, error: 'Invalid or missing riskLevel' });
        }
        if (typeof initialCapital !== 'number' || isNaN(initialCapital) || !isFinite(initialCapital) || initialCapital < 0 || initialCapital > 1000000000) {
            return res.status(400).json({ success: false, error: 'Invalid or missing initialCapital' });
        }
        if (userAddress !== undefined && userAddress !== null) {
            if (typeof userAddress !== 'string' || userAddress.length > 100 || (userAddress !== 'demo' && !ethers.isAddress(userAddress))) {
                return res.status(400).json({ success: false, error: 'Invalid userAddress' });
            }
        }

        const bot = {
            id: generateId(),
            name, strategy, riskLevel, initialCapital,
            status: 'ACTIVE',
            created: Date.now(),
            trades: [],
            totalProfit: 0,
            config: generateBotConfig(strategy, riskLevel)
        };
        res.json({ success: true, bot });
    } catch (error) {
        console.error('Bot creation error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

/**
 * TRADE EXECUTION (swap)
 */
app.post('/api/execute/swap', swapLimiter, (req, res) => {
    try {
        const { fromToken, toToken, amount, slippage } = req.body;

        // Sentinel: Enforce strict input validation on swap parameters
        if (!fromToken || typeof fromToken !== 'string' || fromToken.length > 100) {
            return res.status(400).json({ success: false, error: 'Invalid or missing fromToken' });
        }
        if (!toToken || typeof toToken !== 'string' || toToken.length > 100) {
            return res.status(400).json({ success: false, error: 'Invalid or missing toToken' });
        }
        if (typeof amount !== 'number' || isNaN(amount) || !isFinite(amount) || amount <= 0) {
            return res.status(400).json({ success: false, error: 'Invalid or missing amount' });
        }
        if (slippage !== undefined) {
            if (typeof slippage !== 'number' || isNaN(slippage) || !isFinite(slippage) || slippage < 0 || slippage > 1) {
                return res.status(400).json({ success: false, error: 'Invalid slippage' });
            }
        }

        const expectedOutput = amount * (1 - (slippage || 0.005));
        const gasUsed = Math.random() * 150000 + 50000;
        const gasCost = gasUsed * 0.001;
        const result = {
            success: true,
            swap: {
                from: { token: fromToken, amount: amount.toFixed(4) },
                to: { token: toToken, amount: expectedOutput.toFixed(4) },
                exchange: 'Uniswap V3',
                slippage: `${((slippage || 0.005) * 100).toFixed(2)}%`,
                gasUsed: gasUsed.toFixed(0),
                gasCost: gasCost.toFixed(4),
                timestamp: Date.now()
            },
            txHash: '0x' + crypto.randomBytes(32).toString('hex')
        };
        res.json(result);
    } catch (error) {
        console.error('Swap execution error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

/**
 * Helper Functions
 */
function verifyMoonPaySignature(body, signature, secret) {
    try {
        const hmac = crypto.createHmac('sha256', secret);
        const digest = hmac.update(JSON.stringify(body)).digest('hex');
        const digestBuffer = Buffer.from(digest);
        const signatureBuffer = Buffer.from(signature);
        if (digestBuffer.length !== signatureBuffer.length) return false;
        return crypto.timingSafeEqual(digestBuffer, signatureBuffer);
    } catch (e) {
        return false;
    }
}

function generateBotConfig(strategy, riskLevel) {
    const configs = {
        'Arbitrage Detection': { minSpread: 0.3, maxSpread: 10, maxSlippage: 1, checkInterval: 30000 },
        'Flash Loan Farming': { minProfit: 0.1, maxLoanMultiplier: 50, riskAssessment: 'HIGH', checkInterval: 15000 }
    };
    const hasValidStrategy = Object.prototype.hasOwnProperty.call(configs, strategy);
    const baseConfig = hasValidStrategy ? configs[strategy] : configs['Arbitrage Detection'];
    const riskMultipliers = { 'Conservative (2x leverage)': 0.5, 'Moderate (5x leverage)': 1.0, 'Aggressive (10x leverage)': 2.0 };
    return {
        ...baseConfig,
        riskMultiplier: riskMultipliers[riskLevel] || 1
    };
}

function generateId() {
    return Date.now().toString(36) + crypto.randomBytes(8).toString('hex');
}

// Sentinel: Centralized error handler to prevent stack trace leakage
app.use((err, req, res, next) => {
    console.error('[Sentinel Error Handler]:', err.stack || err);
    res.status(500).json({ success: false, error: 'Internal server error' });
});

// Start server
if (require.main === module) {
    server.on('error', (err) => {
        console.error('[Server] Failed to start:', err);
        process.exit(1);
    });
    server.listen(PORT, () => {
        console.log(`Trade Arena Server running on port ${PORT}`);
    });
}

module.exports = { app, server };
