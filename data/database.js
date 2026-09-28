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
      tradeLogs: [],
      userState: {},
      taskClaims: {}
};
    this.init();
  }

  init() {
    try {
      if (fs.existsSync(this.dbFile)) {
        const fileContent = fs.readFileSync(this.dbFile, 'utf8');
        if (fileContent.trim()) {
          this.data = JSON.parse(fileContent);
          // Ensure all required fields exist (for backward compatibility)
          if (!this.data.userState) this.data.userState = {};
          if (!this.data.tradeLogs) this.data.tradeLogs = [];
          if (!this.data.users) this.data.users = {};
          if (!this.data.sessions) this.data.sessions = {};
          if (!this.data.taskClaims) this.data.taskClaims = {};
        }
      } else {
        this.save();
      }
    } catch (err) {
      console.warn('Database initialization warning:', err.message);
      this.data = {
        users: {},
        sessions: {},
        tradeLogs: [],
        userState: {},
      taskClaims: {}
};
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

  saveUserState(address, state) {
    if (!address || typeof address !== 'string') return null;
    const cleanAddr = address.toLowerCase();
    this.data.userState[cleanAddr] = {
      address: cleanAddr,
      state: (state && typeof state === 'object') ? state : {},
      updatedAt: new Date().toISOString()
    };
    this.save();
    return this.data.userState[cleanAddr];
  }

  getUserState(address) {
    if (!address || typeof address !== 'string') return null;
    const cleanAddr = address.toLowerCase();
    return this.data.userState[cleanAddr] || null;
  }

  // ===== Earn / task module =====
  //
  // Server-side and durable. The previous implementation kept task progress in
  // localStorage, which meant clearing a browser reset every claim and two
  // browsers disagreed about the same wallet. Rewards are recorded with an
  // explicit payout status so an unpaid reward can never be displayed as
  // money received.
  //
  // Keyed `${address}:${taskId}` so one record per wallet per task, which is
  // also what makes a repeat claim impossible rather than merely discouraged.

  getTaskRecord(address, taskId) {
    if (!address || !taskId) return null;
    return this.data.taskClaims[`${String(address).toLowerCase()}:${taskId}`] || null;
  }

  /**
   * Create or update a task claim.
   *
   * `payoutStatus` is one of:
   *   ELIGIBLE             verified, awaiting payout
   *   PAID                 tokens sent; txHash holds the evidence
   *   PENDING_CONFIGURATION verified, but the server cannot pay yet
   *   REJECTED             failed verification
   */
  recordTaskClaim(address, taskId, record) {
    if (!address || !taskId) return null;
    const key = `${String(address).toLowerCase()}:${taskId}`;
    const existing = this.data.taskClaims[key] || {};
    const entry = {
      ...existing,
      ...record,
      taskId,
      address: String(address).toLowerCase(),
      updatedAt: new Date().toISOString(),
      // createdAt is immutable once set, so re-saving a claim does not reset
      // the record's age or any holding-period arithmetic built on it.
      createdAt: existing.createdAt || record.createdAt || new Date().toISOString()
    };
    this.data.taskClaims[key] = entry;
    this.save();
    return entry;
  }

  getTaskClaims(address) {
    if (!address) return [];
    const clean = String(address).toLowerCase();
    return Object.values(this.data.taskClaims).filter(r => r && r.address === clean);
  }

  getAllTaskClaims() {
    return Object.values(this.data.taskClaims);
  }
}

const db = new FileDatabase();
module.exports = db;
