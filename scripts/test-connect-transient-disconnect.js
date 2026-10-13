/**
 * Regression test for the "wallet connects then instantly vanishes" bug.
 *
 * MetaMask emits a transient `disconnect` ("Disconnected from chain.
 * Attempting to connect.") the instant wallet_switchEthereumChain runs during
 * connect(), immediately before chainChanged. The old handler honoured that
 * disconnect and clear()ed the freshly-connected state, so sync({initial:true})
 * found no address and the wallet appeared not to load.
 *
 * This drives the real WalletCore.connect() against a mock injected provider
 * that reproduces the MetaMask event ordering, and asserts the session survives.
 */
const assert = require('assert');

// Minimal ethers shim: only what WalletCore's makeProvider/makeSigner need.
global.ethers = {
  version: '6.13.2',
  BrowserProvider: class { constructor(p) { this.p = p; } getSigner() { return { _signer: true }; } getBalance() { return Promise.resolve(1000000000000000000n); } },
};

// Mock injected provider reproducing MetaMask's connect() event sequence.
// Mock injected provider reproducing MetaMask's connect() event sequence.
function makeMockInjected(startOnWrongChain = true) {
  const listeners = {};
  const accounts = ['0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa'];
  let chainId = startOnWrongChain ? '0x1' : '0x2105';
  const injected = {
    isMetaMask: true,
    request: async ({ method }) => {
      if (method === 'eth_requestAccounts') return accounts;
      if (method === 'eth_accounts') return accounts;
      if (method === 'eth_chainId') return chainId;
      if (method === 'wallet_switchEthereumChain') {
        // MetaMask fires a TRANSIENT disconnect then chainChanged on switch.
        setTimeout(() => {
          (listeners['disconnect'] || []).forEach((f) => f(new Error('MetaMask: Disconnected from chain. Attempting to connect.')));
          setTimeout(() => { chainId = '0x2105'; (listeners['chainChanged'] || []).forEach((f) => f('0x2105')); }, 0);
        }, 0);
        return null;
      }
      if (method === 'eth_call') return '0x';
      throw new Error('unhandled ' + method);
    },
    on: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
    removeListener: () => {},
  };
  injected._fire = (ev, arg) => (listeners[ev] || []).forEach((f) => f(arg));
  return injected;
}


// Load WalletCore source and execute in a controlled window/document context.
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'wallet-core.js'), 'utf8');

function loadWalletCore(injected) {
  const win = {
    ethers: global.ethers,
    ethereum: injected,
    dispatchEvent: () => {},
    CustomEvent: class {},
  };
  win.window = win;
  global.window = win;
  global.document = { hidden: false };
  // getInjected() reads window.ethereum; expose hasWallet/connect via the IIFE.
  const fn = new Function('window', 'document', 'globalThis', src + '\n;return WalletCore;');
  return fn(win, global.document, global.ethers);
}

(async () => {
  // --- Scenario A: wallet starts on the wrong chain, MetaMask switch emits
  //     transient disconnect during connect(). Session must survive. ---
  const injectedA = makeMockInjected(true);
  const WalletCore = loadWalletCore(injectedA);

  let disconnectNotified = false;
  global.window.TA_onWalletDisconnected = () => { disconnectNotified = true; };

  const result = await WalletCore.connect();
  assert.ok(result && result.address, 'connect() should resolve with an address');
  assert.strictEqual(WalletCore.state.connected, true, 'wallet must stay connected');
  assert.ok(WalletCore.state.address, 'state.address must survive the transient disconnect');
  assert.strictEqual(disconnectNotified, false, 'transient disconnect must NOT tear down the session');

  // Let the deferred guard clear + chainChanged settle, then confirm still connected.
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(WalletCore.state.connected, true, 'wallet still connected after chainChanged settles');
  assert.strictEqual(WalletCore.state.chainId, 8453, 'chain should now be Base (8453)');

  // --- Scenario B: a REAL disconnect after connect must still tear down. ---
  const injectedB = makeMockInjected(false); // already on Base, no switch fired
  const WalletCoreB = loadWalletCore(injectedB);
  let realDisconnectNotified = false;
  global.window.TA_onWalletDisconnected = () => { realDisconnectNotified = true; };

  await WalletCoreB.connect();
  assert.strictEqual(WalletCoreB.state.connected, true, 'B connected');
  await new Promise((r) => setTimeout(r, 10)); // let guard clear

  // Now fire a genuine disconnect event.
  injectedB._fire('disconnect', new Error('user disconnected'));
  assert.strictEqual(WalletCoreB.state.connected, false, 'real disconnect must clear state');
  assert.strictEqual(realDisconnectNotified, true, 'real disconnect must notify the app');

  console.log('\n✅ connect() survives MetaMask transient disconnect; real disconnect still honoured.');
  console.log('   A: connected=' + WalletCore.state.connected + ' chainId=' + WalletCore.state.chainId);
  console.log('   B: after real disconnect connected=' + WalletCoreB.state.connected + ' notified=' + realDisconnectNotified);
})().catch((e) => { console.error('❌ FAIL:', e.message); process.exit(1); });
