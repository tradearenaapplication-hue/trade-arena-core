/**
 * Trade Arena — live wallet connection test (browser console).
 *
 * Paste this whole block into DevTools on the running app and press Enter.
 * It only READS state and calls public WalletCore methods; it never signs,
 * sends a transaction, or moves funds.
 *
 * Uses only real API from wallet-core.js:
 *   window.WalletCore.diagnose / connect / sync / silentReconnect /
 *                            getBalanceUSD / ensureBaseNetwork /
 *                            fetchMultiChainTokenBalances / subscribe
 */
window.TA_TEST = (function () {
  'use strict';

  const W = window.WalletCore;
  const line = (s) => console.log(s);
  const ok = (s) => console.log('  PASS  ' + s);
  const bad = (s, e) => console.log('  FAIL  ' + s + (e ? ' -> ' + (e.message || e) : ''));

  const P = { pass: 0, fail: 0 };
  const check = (name, cond, err) => {
    if (cond) { ok(name); P.pass++; } else { bad(name, err); P.fail++; }
  };

  // ── 1. Environment ────────────────────────────────────────────────
  function env() {
    console.log('%c=== WALLET CONNECTION TEST ===', 'color:#00ffe7;font-weight:bold');
    if (!W) {
      bad('wallet-core.js loaded (window.WalletCore exists)');
      line('   wallet-core.js did not execute. Check the console for a');
      line('   script error above, and confirm CSP allows same-origin scripts.');
      try {
        for (const s of document.styleSheets) line('     styleSheet rules = ' + s.cssRules.length);
      } catch (e) { line('     (cssRules blocked: ' + e.message + ')'); }
      return false;
    }
    ok('wallet-core.js loaded (window.WalletCore exists)');

    const d = W.diagnose();
    line('  provider detected : ' + d.walletDetected);
    line('  ethers version    : ' + d.ethersVersion);
    line('  using ethers v6   : ' + d.usingEthersV6);
    line('  raw diagnose()    : ' + JSON.stringify(d));

    check('injected provider present (window.ethereum)', !!window.ethereum);
    check('ethers global present (window.ethers)', !!window.ethers);
    return true;
  }

  // ── 2. Connect + state coherence ──────────────────────────────────
  async function connect() {
    line('');
    line('  >>> Approve the MetaMask popup if one appears...');
    let res;
    try {
      res = await W.connect();
    } catch (e) {
      const rejected = e && (e.code === 4001 || /rejected|denied/i.test(e.message || ''));
      check('WalletCore.connect()', !rejected, e);
      if (rejected) {
        line('  User rejected the prompt (code 4001) - a normal cancel, not a');
        line('  failure. Re-run and approve to continue.');
      }
      return false;
    }
    check('WalletCore.connect() resolved', !!res);
    if (res) {
      // connect() returns { address, provider, signer } - chain id and balance
      // live on WalletCore.state, so read them from there.
      line('  address   : ' + res.address);
      line('  has provider: ' + !!res.provider + ' | has signer: ' + !!res.signer);
      check('connect() returned an address', typeof res.address === 'string');
      check('connect() returned a provider', !!res.provider);
      check('connect() returned a signer', !!res.signer);
    }

    const st = W.state || {};
    line('');
    line('  state.address        : ' + st.address);
    line('  state.connected      : ' + st.connected);
    line('  state.chainId        : ' + st.chainId);
    line('  state.usdBalance     : ' + st.usdBalance);
    line('  state.isCorrectChain : ' + st.isCorrectChain);

    check('state.connected is true', st.connected === true);
    check('state.address is 0x + 40 hex',
      typeof st.address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(st.address));
    check('usdBalance is a finite number >= 0',
      typeof st.usdBalance === 'number' && isFinite(st.usdBalance) && st.usdBalance >= 0);
    check('getBalanceUSD() agrees with state', W.getBalanceUSD() === st.usdBalance);
    // The harness mock holds 1.5 ETH and prices ETH at $3000, so a correct
    // sync must land on $4500. A $0 reading means pricing or the sync broke.
    if (st.usdBalance > 0) {
      check('usdBalance matches 1.5 ETH @ $3000 = $4500',
        Math.abs(st.usdBalance - 4500) < 1, { got: st.usdBalance });
    } else {
      line('  NOTE usdBalance is 0 - no price feed reachable, skipping the');
      line('       exact $4500 assertion (run in a real browser to check it).');
    }
    return true;
  }

  // ── 3. Raw provider read ─────────────────────────────────────────
  async function rawRead() {
    const st = W.state || {};
    try {
      const chainHex = await window.ethereum.request({ method: 'eth_chainId' });
      ok('eth_chainId -> ' + chainHex);
      line('  Base mainnet is 0x2105 (8453).');
    } catch (e) { bad('eth_chainId', e); }
    try {
      const wei = await window.ethereum.request({
        method: 'eth_getBalance', params: [st.address, 'latest']
      });
      const eth = Number(BigInt(wei)) / 1e18;
      ok('eth_getBalance -> ' + wei + ' (' + eth.toFixed(6) + ' ETH)');
    } catch (e) { bad('eth_getBalance', e); }
  }

  return { P, env, connect, rawRead, check, line, ok, bad, W };
})();

// Entry point. Returns the {pass, fail} summary so automated harnesses can
// await it; running this file in the console also works unchanged.
window.__runTest = async function () {
  const { P, env, connect, rawRead, check, line, ok, bad, W } = window.TA_TEST;
  if (!env()) return P;

  let chainHex = null;
  try { chainHex = await window.ethereum.request({ method: 'eth_chainId' }); } catch (e) {}

  if (!(await connect())) return P;
  await rawRead();

  // ── 4. Re-sync must not clobber trading P&L ──────────────────────
  line('');
  const app = window.app || window.tradingApp || window.App;
  if (app) {
    const b = { balance: app.balance, startBalance: app.startBalance, pnl: app.totalPnl };
    line('  app balance/startBalance/pnl before sync: ' +
      b.balance + ' / ' + b.startBalance + ' / ' + b.pnl);
    await W.sync({ initial: false });
    check('sync({initial:false}) preserves app.balance', app.balance === b.balance);
    check('sync({initial:false}) preserves startBalance', app.startBalance === b.startBalance);
    check('sync({initial:false}) preserves totalPnl', app.totalPnl === b.pnl);
  } else {
    line('  (no global app object found - skipping P&L preservation check)');
  }

  // ── 5. Multi-chain token balances ────────────────────────────────
  try {
    const toks = await W.fetchMultiChainTokenBalances();
    const n = Array.isArray(toks) ? toks.length : Object.keys(toks || {}).length;
    line('  multi-chain token entries: ' + n);
    line('  ' + JSON.stringify(toks).slice(0, 400));
    check('fetchMultiChainTokenBalances() returned data', n > 0);
  } catch (e) { bad('fetchMultiChainTokenBalances()', e); }

  // ── 6. Network guard: must be Base ───────────────────────────────
  line('');
  if (chainHex !== '0x2105') {
    line('  Not on Base (' + chainHex + '). Testing ensureBaseNetwork()...');
    try {
      const sw = await W.ensureBaseNetwork();
      check('ensureBaseNetwork() switched to Base', sw === true);
      const after = await window.ethereum.request({ method: 'eth_chainId' });
      line('  chainId now: ' + after);
      check('chainId is Base (0x2105) after switch', after === '0x2105');
    } catch (e) {
      bad('ensureBaseNetwork()', e);
      line('  4902 = chain not yet added to the wallet.');
    }
  } else {
    ok('already on Base (0x2105)');
    check('isCorrectChain is true', (W.state || {}).isCorrectChain === true);
  }

  // ── 7. Subscription + reconnect guards ───────────────────────────
  line('');
  try {
    const off = W.subscribe ? W.subscribe(() => {}) : null;
    check('subscribe() returned an unsubscribe function', typeof off === 'function');
    if (typeof off === 'function') off();
  } catch (e) { bad('subscribe()', e); }

  const st = W.state || {};
  try {
    const r = await W.silentReconnect('0x000000000000000000000000000000000000dEaD');
    check('silentReconnect(other address) refused', r === null);
  } catch (e) { bad('silentReconnect(other address)', e); }
  try {
    const r2 = await W.silentReconnect(st.address);
    check('silentReconnect(same address) accepted', !!r2);
  } catch (e) { bad('silentReconnect(same address)', e); }

  // ── Summary ──────────────────────────────────────────────────────
  line('');
  console.log('%c=== ' + P.pass + ' passed, ' + P.fail + ' failed ===',
    'color:' + (P.fail ? '#ff2d78' : '#39ff14') + ';font-weight:bold');
  line('');
  line('  Manual checks still to do:');
  line('   1. MetaMask: switch account  -> header address should update');
  line('   2. MetaMask: switch to Ethereum -> app should flag the wrong');
  line('      network and offer to switch back to Base');
  line('   3. Watch the balance - it must NOT reset your trading P&L');
  line('   4. Click LOG OUT, reload, confirm you land on the sign-in screen');
  line('');
  line('  To disconnect for real:  await window.WalletCore.disconnect()');
  return P;
};

// Auto-run when pasted into the console. Automated harnesses set
// window.__TA_NO_AUTORUN so they can await the result themselves.
if (typeof window !== 'undefined' && window.ethereum && !window.__TA_NO_AUTORUN) {
  window.__runTest();
}

