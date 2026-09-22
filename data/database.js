const fs = require('fs');
const path = require('path');

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
    if (!address) return null;
    const cleanAddr = address.toLowerCase();
    const existing = this.data.users[cleanAddr] || {};

    const updatedUser = {
      ...existing,
      address: cleanAddr,
      provider: provider || existing.provider || 'unknown',
      name: name || existing.name || cleanAddr,
      holdings: holdings || existing.holdings || [],
      lastLogin: new Date().toISOString(),
      sessionData: sessionData || existing.sessionData || {}
    };

    this.data.users[cleanAddr] = updatedUser;
    this.save();
    return updatedUser;
  }

  getUser(address) {
    if (!address) return null;
    return this.data.users[address.toLowerCase()] || null;
  }

  createSession(address, initialBalance = 0) {
    if (!address) return null;
    const cleanAddr = address.toLowerCase();
    const sessionId = 'session_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);

    const session = {
      id: sessionId,
      address: cleanAddr,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      balance: initialBalance,
      status: 'ACTIVE'
    };

    this.data.sessions[sessionId] = session;
    this.save();
    return session;
  }

  getSession(sessionId) {
    return this.data.sessions[sessionId] || null;
  }

  addTradeLog(tradeData) {
    const { address, agentId, botName, action, symbol, amount, pnl, details } = tradeData;
    if (!address) return null;

    const tradeLog = {
      id: 'trade_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
      address: address.toLowerCase(),
      agentId: agentId || 'agent-default',
      botName: botName || 'Trade Bot',
      action: action || 'TRADE',
      symbol: symbol || 'ETH/USD',
      amount: amount || 0,
      pnl: pnl || 0,
      details: details || {},
      timestamp: new Date().toISOString()
    };

    this.data.tradeLogs.push(tradeLog);
    this.save();
    return tradeLog;
  }

  getTradeLogs(address, limit = 100) {
    if (!address) return [];
    const cleanAddr = address.toLowerCase();
    return this.data.tradeLogs
      .filter(log => log.address === cleanAddr)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, limit);
  }
}

const db = new FileDatabase();
module.exports = db;
