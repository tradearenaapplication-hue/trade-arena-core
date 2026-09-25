/**
 * Trade Arena - wallet integration test harness.
 *
 * Runs wallet-core.js against a mocked EIP-1193 provider and a mocked
 * ethers v6 global, with all network I/O stubbed. Verifies the exact
 * failure modes that broke the app:
 *   1. provider/signer construction under ethers v6
 *   2. balance sync producing a real USD figure
 *   3. accountsChanged / chainChanged re-syncing automatically
 *   4. routine syncs NOT clobbering the trading balance / P&L baseline
 *
 * Run: node scripts/wallet-integration-test.js
 */
'use strict';

const assert = require('assert');
const path = require('path');

const ADDRESS = '0x1111111111111111111111111111111111111111';
const ADDRESS_2 = '0x2222222222222222222222222222222222222222';
const ETH_WEI = 1500000000000000000n; // 1.5 ETH
const USDC_RAW = 100000000n;          // 100 USDC at 6dp
const ETH_PRICE = 3000;
// 1.5 ETH * $3000 = $4500, plus 100 USDC = $4600
const EXPECTED_USD = 4600;

const listeners = {};
const store = {};
let chainHex = '0x2105';
let accounts = [ADDRESS];

const injected = {
  isMetaMask: true,
  async request({ method, params }) {
    switch (method) {
      case 'eth_requestAccounts':
        if (params) throw new Error('unexpected params');
        return accounts;
      case 'eth_accounts':
        return accounts;
      case 'eth_chainId':
        return chainHex;
      case 'wallet_switchEthereumChain':
        if (params[0].chainId !== '0x2105') {
          const e = new Error('unknown chain');
          e.code = 4902;
          throw e;
        }
        chainHex = params[0].chainId;
        return null;
      case 'wallet_addEthereumChain':
        return null;
      default:
        throw new Error('unmocked method: ' + method);
    }
  },
  on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); },
  removeListener(evt, fn) {
    listeners[evt] = (listeners[evt] || []).filter((f) => f !== fn);
  },
};


/** Minimal ethers v6-shaped global: only what wallet-core touches. */
const ethersV6 = {
  version: '6.13.2',
  BrowserProvider: class {
    constructor(eth) {
      if (!eth) throw new Error('BrowserProvider requires an EIP-1193 provider');
      this.eth = eth;
    }
    // v6 getSigner is ASYNC - this is what the old code got wrong.
    async getSigner() {
      return { getAddress: function () { return Promise.resolve(accounts[0]); } };
    }
    async getBalance(addr) {
      assert.strictEqual(addr.toLowerCase(), accounts[0].toLowerCase());
      return ETH_WEI;
    }
  },
  formatEther: (v) => (typeof v === 'bigint' ? (Number(v) / 1e18).toString() : String(v)),
  formatUnits: (v, d) => (Number(v) / Math.pow(10, d)).toString(),
};

global.window = {
  ethereum: injected,
  localStorage: {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  },
  addEventListener() {},
  dispatchEvent() {},
  setTimeout, clearTimeout, setInterval, clearInterval,
};
global.document = {
  readyState: 'complete', addEventListener() {},
  getElementById: () => null, hidden: false,
};
global.ethers = ethersV6;
global.CustomEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o); } };
global.console.table = () => {};


// ── Stub network I/O ───────────────────────────────────────────────
// Only the Base RPC reports funds. Other networks return an empty wallet,
// which is what makes the cross-chain total meaningful.
const PRICE = { ethereum: { usd: ETH_PRICE }, 'usd-coin': { usd: 1 }, dai: { usd: 1 } };
const BASE_RPC = 'https://mainnet.base.org';
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const EMPTY = { ok: true, status: 200, json: async () => ({ result: '0x' }) };

global.fetch = async (url, opts) => {
  if (String(url).includes('api.coingecko.com')) {
    return { ok: true, status: 200, json: async () => PRICE };
  }
  if (opts && opts.method === 'POST') {
    const isBase = String(url) === BASE_RPC;
    const body = JSON.parse(opts.body);

    if (!isBase) return EMPTY;

    if (body.method === 'eth_getBalance') {
      return { ok: true, status: 200, json: async () => ({ result: '0x' + ETH_WEI.toString(16) }) };
    }
    if (body.method === 'eth_call') {
      const to = (body.params[0].to || '').toLowerCase();
      if (to === BASE_USDC) {
        return { ok: true, status: 200, json: async () => ({ result: '0x' + USDC_RAW.toString(16) }) };
      }
      return EMPTY;
    }
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

// ── Load the module under test ─────────────────────────────────────
const WalletCore = require(path.join(__dirname, '..', 'wallet-core.js'));

// ── Host-page bridge that owns the trading balance ─────────────────
// Mirrors index.html: TA_syncWalletBalance must only seed on `initial`.
const app = { balance: 50, startBalance: 50, totalPnl: 0, calls: [] };
global.window.TA_syncWalletBalance = (p) => {
  app.calls.push(p);
  if (p.initial && !Number.isNaN(p.usdBalance) && p.usdBalance > 0) {
    app.balance = p.usdBalance;
    app.startBalance = p.usdBalance;
    app.totalPnl = 0;
  }
};

const fire = async (evt, arg) => {
  for (const fn of listeners[evt] || []) await fn(arg);
};

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('module loads and exposes the public API', () => {
  assert.ok(WalletCore.hasWallet(), 'injected wallet should be detected');
  assert.strictEqual(WalletCore.CHAIN.id, 8453);
  ['connect', 'silentReconnect', 'sync', 'diagnose', 'startPolling', 'subscribe']
    .forEach((k) => assert.strictEqual(typeof WalletCore[k], 'function', `missing ${k}`));
});

test('event listeners bind to the injected provider', () => {
  ['accountsChanged', 'chainChanged', 'disconnect'].forEach((e) => {
    assert.ok((listeners[e] || []).length > 0, `no listener bound for ${e}`);
  });
});

test('connect() builds a v6 provider/signer and syncs a real balance', async () => {
  const res = await WalletCore.connect();
  assert.strictEqual(res.address, ADDRESS);
  assert.ok(res.provider, 'provider must be set');
  assert.ok(res.signer, 'signer must be set');

  assert.strictEqual(WalletCore.state.connected, true);
  assert.strictEqual(WalletCore.state.chainId, 8453, 'chain id should parse from 0x2105');
  assert.strictEqual(WalletCore.state.isCorrectChain, true);
  assert.strictEqual(WalletCore.state.ethBalance, 1.5);
  assert.strictEqual(WalletCore.state.usdBalance, EXPECTED_USD);
  assert.ok(WalletCore.state.holdings.length >= 2, 'should report ETH + USDC holdings');
});

test('initial connect seeds the trading balance exactly once', () => {
  assert.strictEqual(app.balance, EXPECTED_USD);
  assert.strictEqual(app.startBalance, EXPECTED_USD);
  assert.strictEqual(app.calls.length, 1);
  assert.strictEqual(app.calls[0].initial, true);
});

test('routine sync does NOT clobber trading balance or P&L baseline', async () => {
  // Simulate trading activity after connect.
  app.balance = 4750;
  app.startBalance = EXPECTED_USD;
  app.totalPnl = 150;
  const callsBefore = app.calls.length;

  await WalletCore.sync({ initial: false });

  assert.strictEqual(app.calls.length, callsBefore + 1, 'bridge should be notified');
  assert.strictEqual(app.calls[app.calls.length - 1].initial, false);
  assert.strictEqual(app.balance, 4750, 'trading balance must be preserved');
  assert.strictEqual(app.startBalance, EXPECTED_USD, 'P&L baseline must be preserved');
  assert.strictEqual(app.totalPnl, 150, 'P&L must be preserved');
});

test('accountsChanged rebuilds state and re-seeds for a new account', async () => {
  accounts = [ADDRESS_2];
  await fire('accountsChanged', accounts);

  assert.strictEqual(WalletCore.state.address, ADDRESS_2, 'address should follow the wallet');
  assert.strictEqual(WalletCore.state.connected, true);
  assert.strictEqual(app.balance, EXPECTED_USD, 'new account seeds a fresh baseline');

  if (global.window.walletState) {
    assert.strictEqual(global.window.walletState.address, ADDRESS_2);
  }
});

test('chainChanged is handled without a manual page reload', async () => {
  const before = WalletCore.state.chainId;
  chainHex = '0x1'; // switch to Ethereum mainnet
  await fire('chainChanged', chainHex);

  assert.notStrictEqual(WalletCore.state.chainId, before, 'chain id should update');
  assert.strictEqual(WalletCore.state.chainId, 1);
  assert.strictEqual(WalletCore.state.isCorrectChain, false, 'non-Base should flag incorrect');

  const ok = await WalletCore.ensureBaseNetwork();
  assert.strictEqual(ok, true);
  assert.strictEqual(WalletCore.state.isCorrectChain, true, 'should switch back to Base');
});

test('disconnect clears state and notifies the app', async () => {
  let notified = null;
  global.window.TA_onWalletDisconnected = (reason) => { notified = reason; };
  accounts = [];
  await fire('accountsChanged', accounts);

  assert.strictEqual(WalletCore.state.connected, false);
  assert.strictEqual(WalletCore.state.address, null);
  assert.strictEqual(WalletCore.state.usdBalance, 0);
  assert.ok(notified, 'app disconnect hook should fire');
});

test('silent reconnecting a different account is refused', async () => {
  accounts = [ADDRESS_2];
  const res = await WalletCore.silentReconnect(ADDRESS);
  assert.strictEqual(res, null, 'must not resume a different account');

  accounts = [ADDRESS];
  const ok = await WalletCore.silentReconnect(ADDRESS);
  assert.ok(ok, 'should resume the same account');
  assert.strictEqual(ok.address, ADDRESS);
});

test('diagnose() reports without throwing', () => {
  const d = WalletCore.diagnose();
  assert.strictEqual(d.walletDetected, true);
  assert.strictEqual(d.ethersVersion, '6.13.2');
  assert.strictEqual(d.usingEthersV6, true);
});

// ── Runner ─────────────────────────────────────────────────────────
(async () => {
  let pass = 0, fail = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log('  PASS  ' + name);
      pass++;
    } catch (e) {
      console.log('  FAIL  ' + name);
      console.log('        ' + (e && e.message));
      fail++;
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
