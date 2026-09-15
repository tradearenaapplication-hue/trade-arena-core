// Consolidated canonical server (root server.js)
// This file includes minimal hardening and wiring for admin authentication.

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

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3001;

// Basic security and headers
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com https://accounts.google.com https://cdn.privy.io https://cdn.jsdelivr.net; img-src 'self' data:; connect-src 'self' https://api.anthropic.com https://api.openai.com https://generativelanguage.googleapis.com https://api.coingecko.com https://api.0x.org https://mainnet.base.org https://*.alchemyapi.io; font-src 'self' https://fonts.gstatic.com;");
    next();
});

app.use(cors());
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate limits
const rootLimiter = rateLimit({ windowMs: 60 * 1000, max: 1000 });
app.use(rootLimiter);

// Simple in-memory rate guard
const rateLimitMap = new Map();
function checkRateLimit(ip) {
    const now = Date.now();
    const record = rateLimitMap.get(ip);
    if (record) {
        if (now > record.resetAt) {
            record.count = 1;
            record.resetAt = now + 15 * 60 * 1000;
        } else {
            record.count += 1;
        }
        return record.count <= 1000;
    }
    rateLimitMap.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return true;
}
app.checkRateLimit = checkRateLimit;

// WebSocket simple broadcast
const clients = new Set();
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

// Protect admin routes with adminAuth
app.use(['/api/agent', '/api/arbitrage', '/api/maintenance'], adminAuth);

// Basic example admin route
app.post('/api/agent/pause', (req, res) => {
    // Implement pause logic in your arbitration service
    return res.json({ success: true, message: 'Agent paused (stub)' });
});

// Diagnostics quick (open)
app.get('/api/diagnostics/quick', (req, res) => {
    res.json({ status: 'OK', features: ['privy', 'ai-proxies', 'payouts'], timestamp: Date.now() });
});

// Diagnostics full (protected)
let diagnosticsFullCache = null;
let diagnosticsFullCacheTime = 0;
const DIAGNOSTICS_FULL_CACHE_TTL = 60 * 1000;
app.get('/api/diagnostics/full', adminAuth, (req, res) => {
    const now = Date.now();
    if (diagnosticsFullCache && (now - diagnosticsFullCacheTime) < DIAGNOSTICS_FULL_CACHE_TTL) {
        return res.json({ ...diagnosticsFullCache, _cached: true });
    }
    diagnosticsFullCache = { env: { PRIVY_APP_ID: !!process.env.PRIVY_APP_ID }, timestamp: new Date().toISOString() };
    diagnosticsFullCacheTime = now;
    res.json(diagnosticsFullCache);
});

// Start server
if (require.main === module) {
    server.listen(PORT, () => {
        console.log(`Trade Arena server listening on ${PORT}`);
    });
}

module.exports = { app, server };
