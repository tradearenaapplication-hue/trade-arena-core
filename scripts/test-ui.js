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

console.log('\n---');
console.log(failures === 0 ? 'All UI regression checks passed.' : `${failures} check(s) failed.`);
console.log('');
process.exit(failures === 0 ? 0 : 1);
