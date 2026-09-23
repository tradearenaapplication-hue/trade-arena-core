const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_FILE = path.join(__dirname, 'trade_arena.json');

class FileDatabase {
  constructor() {
    this.dbFile = DB_FILE;
    this.data = {
      users: {},
      sessions: {},
      tradeLogs: []
    };
    this.init();
  }

  init() {
    try {
      if (fs.existsSync(this.dbFile)) {
        const fileContent = fs.readFileSync(this.dbFile, 'utf8');
        if (fileContent.trim()) {
          this.data = JSON.parse(fileContent);
        }
      } else {
        this.save();
      }
    } catch (err) {
      console.warn('Database initialization warning:', err.message);
    }
  }

  save() {
    try {
      fs.writeFileSync(this.dbFile, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      console.error('Failed to write database file:', err.message);
    }
  }

  upsertUser(address, provider, name, holdings, sessionData) {
    if (!address || typeof address !== 'string') return null;
    const cleanAddr = address.toLowerCase();
    const existing = this.data.users[cleanAddr] || {};

    const updatedUser = {
      ...existing,
      address: cleanAddr,
      provider: typeof provider === 'string' ? provider : (existing.provider || 'unknown'),
      name: typeof name === 'string' ? name : (existing.name || cleanAddr),
      holdings: Array.isArray(holdings) ? holdings : (existing.holdings || []),
      lastLogin: new Date().toISOString(),
      sessionData: (sessionData && typeof sessionData === 'object') ? sessionData : (existing.sessionData || {})
    };

    this.data.users[cleanAddr] = updatedUser;
    this.save();
    return updatedUser;
  }

  getUser(address) {
    if (!address || typeof address !== 'string') return null;
    return this.data.users[address.toLowerCase()] || null;
  }

  createSession(address, initialBalance = 0) {
    if (!address || typeof address !== 'string') return null;
    const cleanAddr = address.toLowerCase();
    const sessionId = 'session_' + Date.now() + '_' + crypto.randomBytes(8).toString('hex');

    const session = {
      id: sessionId,
      address: cleanAddr,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      balance: typeof initialBalance === 'number' && !isNaN(initialBalance) ? initialBalance : 0,
      status: 'ACTIVE'
    };

    this.data.sessions[sessionId] = session;
    this.save();
    return session;
  }

  getSession(sessionId) {
    if (!sessionId || typeof sessionId !== 'string') return null;
    return this.data.sessions[sessionId] || null;
  }

  addTradeLog(tradeData) {
    if (!tradeData || typeof tradeData !== 'object') return null;
    const { address, agentId, botName, action, symbol, amount, pnl, details } = tradeData;
    if (!address || typeof address !== 'string') return null;

    const tradeLog = {
      id: 'trade_' + Date.now() + '_' + crypto.randomBytes(8).toString('hex'),
      address: address.toLowerCase(),
      agentId: typeof agentId === 'string' ? agentId : 'agent-default',
      botName: typeof botName === 'string' ? botName : 'Trade Bot',
      action: typeof action === 'string' ? action : 'TRADE',
      symbol: typeof symbol === 'string' ? symbol : 'ETH/USD',
      amount: typeof amount === 'number' && !isNaN(amount) ? amount : 0,
      pnl: typeof pnl === 'number' && !isNaN(pnl) ? pnl : 0,
      details: (details && typeof details === 'object') ? details : {},
      timestamp: new Date().toISOString()
    };

    this.data.tradeLogs.push(tradeLog);
    this.save();
    return tradeLog;
  }

  getTradeLogs(address, limit = 100) {
    if (!address || typeof address !== 'string') return [];
    const cleanAddr = address.toLowerCase();
    const safeLimit = typeof limit === 'number' && limit > 0 ? limit : 100;
    return this.data.tradeLogs
      .filter(log => log && log.address === cleanAddr)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, safeLimit);
  }
}

const db = new FileDatabase();
module.exports = db;
