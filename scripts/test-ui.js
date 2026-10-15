#!/usr/bin/env node
/**
 * UI regression tests for the trading floor.
 *
 * tests.js exercises server code and static text in index.html but never
 * RENDERS the page. Both recent regressions lived exactly there and shipped
 * green:
 *
 *   - currency.js was loaded with `defer`, so fmtUSD/fmtAUD were undefined
 *     while the inline script rendered money. addBot()'s call site swallows
 *     the ReferenceError in a try/catch, so the + button "did nothing" and
 *     trade logs silently stopped drawing.
 *   - the exit timer force-closed every position via a scheduled checkExit.
 *
 * jsdom is unavailable here, so this harness extracts the functions under
 * test straight out of index.html and runs them against a minimal document
 * stub. That keeps the test honest - it exercises the shipped source, not a
 * copy - and it fails loudly on either regression.
 *
 *   node scripts/test-ui.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let failures = 0;
const check = (label, cond, detail) => {
    if (cond) console.log(`  [OK]   ${label}`);
    else { failures++; console.log(`  [FAIL] ${label}${detail ? '  ' + detail : ''}`); }
};

/** Pull a top-level `function name(...) {...}` out of the source. */
function extractFunction(src, name) {
    const start = src.indexOf(`function ${name}(`);
    if (start === -1) return null;
    let i = src.indexOf('{', start);
    let depth = 0;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
    }
    return null;
}

function makeEl(id) {
    const el = {
        id: id || '', style: {}, dataset: {}, children: [], _text: '', _html: '',
        get textContent() { return el._text; },
        set textContent(v) { el._text = String(v); },
        get innerHTML() { return el._html; },
        set innerHTML(v) { el._html = String(v); },
        appendChild(c) { el.children.push(c); return c; },
        remove() {}, setAttribute() {},
        querySelector() { return null; },
        querySelectorAll() { return []; },
        addEventListener() {}
    };
    el.classList = {
        _s: new Set(),
        add(...c) { c.forEach(x => el.classList._s.add(x)); },
        remove(...c) { c.forEach(x => el.classList._s.delete(x)); },
        contains(c) { return el.classList._s.has(c); },
        toggle(c, on) { on ? el.classList._s.add(c) : el.classList._s.delete(c); }
    };
    return el;
}

function makeSandbox(extra) {
    const els = {};
    const doc = {
        getElementById: (id) => (id in els ? els[id] : null),
        createElement: () => makeEl(''),
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: () => {},
        body: makeEl('body'),
        readyState: 'complete',
        visibilityState: 'visible'
    };
    const scheduled = [];
    const ctx = Object.assign({
        document: doc, console,
        setTimeout: (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; },
        clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
        fetch: async () => ({ ok: true, json: async () => ({}) }),
        Date, Math, Number, isNaN, parseFloat, parseInt, String, JSON,
        Array, Object, Boolean, RegExp, Promise, Error, Set, Map
    }, extra || {});
    ctx.globalThis = ctx;
    ctx.window = ctx;
    vm.createContext(ctx);
    return { ctx, els, doc, scheduled };
}


// Comments explain the old code, so they legitimately contain the patterns we
// forbid. Strip line and block comments before scanning, otherwise a note
// describing a bug trips the very guard that documents it.
const CODE = HTML
    .replace(/\/\*[\s\S]*?\*\//g, ' ')     // block comments
    .replace(/(^|[^:])\/\/.*$/gm, '$1');   // line comments (not inside URLs)

console.log('\n=== UI regression tests ===\n');

// ── 1. formatters must exist before any render ────────────────────────────
{
    console.log('formatters available before render');
    const { ctx } = makeSandbox();
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'currency.js'), 'utf8'), ctx);
    check('fmtUSD defined', typeof ctx.fmtUSD === 'function');
    check('fmtAUD defined', typeof ctx.fmtAUD === 'function');
    check('fmtNum defined', typeof ctx.fmtNum === 'function');
    check('audToUsd defined', typeof ctx.audToUsd === 'function');
}

// ── 2. addBot adds a bot and renders without throwing ─────────────────────
{
    console.log('\naddBot');
    const { ctx } = makeSandbox();
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'currency.js'), 'utf8'), ctx);

    const addBotSrc = extractFunction(HTML, 'addBot');
    const syncSrc = extractFunction(HTML, '_syncHeaderBotBtns');
    check('addBot() found in index.html', !!addBotSrc);
    check('_syncHeaderBotBtns() found', !!syncSrc);

    const pre = 'const MAX_BOTS = 99;\n'
        + 'let bots=[]; let botCounter=0;\n'
        + 'const rendered=[];\n'
        + 'function renderBot(b){ rendered.push(b); }\n';

    vm.runInContext(pre + syncSrc + '\n' + addBotSrc, ctx);

    let threw = null;
    try { vm.runInContext('addBot();', ctx); } catch (e) { threw = e; }
    check('addBot() does not throw', threw === null, threw ? `(threw ${threw.message})` : '');

    const bots = vm.runInContext('bots', ctx);
    check('a bot was added', Array.isArray(bots) && bots.length === 1, `(got ${bots && bots.length})`);

    if (Array.isArray(bots) && bots[0]) {
        // Default stake is A$0.50. audToUsd is identity until a rate loads,
        // so the stored USD is <= 0.50 either way - never the old hardcoded 10.
        check('default stake is not 10 USD', bots[0].bet !== 10, `(got ${bots[0].bet})`);
        check('default stake <= 0.50 USD', bots[0].bet > 0 && bots[0].bet <= 0.5, `(got ${bots[0].bet})`);
        check('bot has an id', typeof bots[0].id === 'number');
    }

    const n = vm.runInContext('rendered.length', ctx);
    check('renderBot() was called', n === 1, `(got ${n})`);
}

// ── 3. the exit timer must not force-close positions ──────────────────────
{
    console.log('\nexit timer');
    const forced = /setTimeout\s*\(\s*\(\s*\)\s*=>\s*checkExit\s*\(/;
    check('no scheduled checkExit auto-close', !forced.test(CODE));

    const ticker = extractFunction(HTML, 'startLivePnlTicker') || '';
    check('ticker counts elapsed time from openedAt',
        /openedAt/.test(ticker) && /Date\.now\(\)\s*-\s*openedAt/.test(ticker));
    check('ticker no longer clamps a countdown at 0',
        !/Math\.max\(\s*0\s*,\s*pos\.exitTime\s*-\s*Date\.now\(\)\s*\)/.test(ticker));
    check('openedAt is set when a position opens', /openedAt\s*:\s*Date\.now\(\)/.test(CODE));
}

// ── 4. no money site left rendering raw USD ───────────────────────────────
{
    console.log('\ncurrency display');
    const concat = CODE.match(/['"`]\s*\+\s*'\$'\s*\+|'\$'\s*\+\s*[\w.]+\.toFixed/g) || [];
    check('no concatenated raw-USD money strings', concat.length === 0,
        concat.length ? `(${concat.length} left: ${[...new Set(concat)].slice(0, 3).join(' ')})` : '');
}

// ── 5. logout must survive the in-flight silent-reconnect race ─────────────
// Regression: on page load autoReconnectWallet() awaits silentReconnect() and
// a multi-second balance sync. Clicking LOGOUT while those are pending used to
// be silently undone - the continuations re-seeded the balance, restarted the
// poller and re-persisted the session key, so "logged out." was followed by
// "Silent wallet reconnect successful" in the console and the wallet came
// back by itself. Every continuation must now re-check the stored key.
(async () => {
{
    console.log('\nlogout vs silent-reconnect race');

    // Source-level guards in wallet-core.js: sync() must discard results when
    // the session changed mid-fetch, and accountsChanged must be ignored when
    // no session is live.
    const WC = fs.readFileSync(path.join(ROOT, 'wallet-core.js'), 'utf8');
    check('sync() captures the address at entry', /const syncAddress = state\.address/.test(WC));
    check('sync() discards results after session teardown',
        /sync result discarded - session changed during fetch/.test(WC));
    check('accountsChanged ignored without a live session',
        /ignoring accountsChanged - no active session/.test(WC));

    // TA_onWalletAccountChanged must not re-persist the key after logout.
    check('TA_onWalletAccountChanged guards on session key',
        /account change ignored - no active session/.test(HTML));

    const autoSrc = extractFunction(HTML, 'autoReconnectWallet');
    check('autoReconnectWallet() found in index.html', !!autoSrc);
    if (!autoSrc) return;
    // extractFunction starts at `function`; keep it async so awaits parse.
    const asyncAuto = autoSrc.replace(/^function/, 'async function');

    function runScenario({ dropKeyDuring }) {
        const store = new Map([['ta_wallet_address', '0xabc']]);
        const calls = { setupApp: 0, sync: 0, startPolling: 0, stopPolling: 0, disconnect: 0, syncOpts: null };
        let resolveReconnect, resolveSync;
        const silentReconnect = () => new Promise((res) => { resolveReconnect = res; });
        const sync = (opts) => { calls.sync++; calls.syncOpts = opts; return new Promise((res) => { resolveSync = res; }); };

        const extra = {
            localStorage: {
                getItem: (k) => (store.has(k) ? store.get(k) : null),
                setItem: (k, v) => store.set(k, String(v)),
                removeItem: (k) => store.delete(k),
            },
            WalletCore: {
                hasWallet: () => true,
                silentReconnect,
                sync,
                startPolling: () => { calls.startPolling++; },
                stopPolling: () => { calls.stopPolling++; },
                disconnect: () => { calls.disconnect++; },
            },
            walletState: {},
            refreshSettingsUI: () => {},
            setupApp: () => { calls.setupApp++; },
            _log: [],
        };
        extra.console = { log: (...a) => extra._log.push(a.join(' ')), info: () => {}, warn: () => {}, error: () => {} };

        const { ctx } = makeSandbox(extra);
        vm.runInContext(asyncAuto + '\nautoReconnectWallet();', ctx);

        // Resolve silentReconnect; optionally simulate logout() clearing the
        // stored key while the continuation is still pending.
        resolveReconnect({ address: '0xabc', provider: {}, signer: {} });
        if (dropKeyDuring === 'reconnect') store.delete('ta_wallet_address');

        return new Promise((r) => setImmediate(async () => {
            if (dropKeyDuring === 'sync' && resolveSync) {
                store.delete('ta_wallet_address'); // logout() mid-sync
                resolveSync({ address: '0xabc', totalUsd: 12, holdings: [] });
            } else if (resolveSync) {
                resolveSync({ address: '0xabc', totalUsd: 12, holdings: [] });
            }
            // let the remaining continuations flush
            await new Promise((r2) => setImmediate(r2));
            await new Promise((r2) => setImmediate(r2));
            r({ calls, log: extra._log, store });
        }));
    }

    // Happy path: a returning wallet user still gets the full resume.
    {
        const { calls, log } = await runScenario({});
        check('valid session: setupApp() runs', calls.setupApp === 1, `(got ${calls.setupApp})`);
        check('valid session: sync({initial:true}) runs',
            calls.sync === 1 && calls.syncOpts && calls.syncOpts.initial === true);
        check('valid session: poller starts', calls.startPolling === 1, `(got ${calls.startPolling})`);
        check('valid session: success is logged',
            log.some((l) => l.includes('Silent wallet reconnect successful')));
    }

    // Logout during silentReconnect: everything must abort.
    {
        const { calls, log } = await runScenario({ dropKeyDuring: 'reconnect' });
        check('logout during reconnect: setupApp() does NOT run', calls.setupApp === 0, `(got ${calls.setupApp})`);
        check('logout during reconnect: sync() does NOT run', calls.sync === 0, `(got ${calls.sync})`);
        check('logout during reconnect: poller does NOT start', calls.startPolling === 0, `(got ${calls.startPolling})`);
        check('logout during reconnect: connection is dropped', calls.disconnect >= 1, `(got ${calls.disconnect})`);
        check('logout during reconnect: no success is logged',
            !log.some((l) => l.includes('Silent wallet reconnect successful')));
    }

    // Logout during the (slow) balance sync: poller must not restart.
    {
        const { calls } = await runScenario({ dropKeyDuring: 'sync' });
        check('logout during sync: poller does NOT start', calls.startPolling === 0, `(got ${calls.startPolling})`);
        check('logout during sync: poller is stopped', calls.stopPolling >= 1, `(got ${calls.stopPolling})`);
        check('logout during sync: connection is dropped', calls.disconnect >= 1, `(got ${calls.disconnect})`);
    }
}

console.log('\n---');
console.log(failures === 0 ? 'All UI regression checks passed.' : `${failures} check(s) failed.`);
console.log('');
process.exit(failures === 0 ? 0 : 1);
})();
