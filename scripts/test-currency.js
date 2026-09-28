#!/usr/bin/env node
/**
 * Read-only check for the AUD display layer.
 *
 * Verifies the USD->AUD rate is the right way round, that forward and
 * inverse conversion agree, and that parseAmount tolerates what a user
 * would actually type ("A$12.50", "$1,250.75").
 *
 *   node scripts/test-currency.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'currency.js'), 'utf8');

// Stub the browser environment; the module only needs window, fetch and a timer.
const ctx = {
    window: {},
    setInterval: () => {},
    console,
    fetch,
    AbortController,
    // The module uses setTimeout/clearTimeout for its abort timeout.
    setTimeout, clearTimeout,
    Date, Math, Number, isNaN, parseFloat, String, JSON
};
vm.createContext(ctx);
vm.runInContext(src, ctx);

const C = ctx.window.Currency;

(async () => {
    console.log('\n=== AUD display layer ===\n');
    const rate = await C.refresh();
    console.log('  USD -> AUD rate :', rate);

    let failures = 0;
    const check = (label, cond, detail) => {
        if (cond) console.log(`  [OK]   ${label}`);
        else { failures++; console.log(`  [FAIL] ${label} ${detail || ''}`); }
    };

    // A USD->AUD rate must exceed 1. Below 1 the pair is inverted, which is
    // precisely the bug the CoinGecko fallback has to guard against.
    check('rate is USD->AUD, not inverted', rate > 1, `(got ${rate})`);
    check('rate is plausible (0.5 - 3)', rate > 0.5 && rate < 3, `(got ${rate})`);

    for (const usd of [0.25, 0.5, 1, 10, 100]) {
        const aud = C.toAud(usd);
        const back = C.toUsd(aud);
        check(`round trip $${usd} -> A$${aud.toFixed(2)} -> $${back.toFixed(4)}`,
            Math.abs(back - usd) < 0.01);
    }

    check('monotonic', C.toAud(10) > C.toAud(1));

    const f1 = C.fmtUSD(1);
    check('fmtUSD marks AUD', f1.startsWith('A$'), `(got "${f1}")`);
    check('fmtUSD value matches toAud', Math.abs(parseFloat(f1.slice(2)) - C.toAud(1)) < 0.01);

    check('parses "A$12.50"', C.parseAmount('A$12.50') === 12.5, `(got ${C.parseAmount('A$12.50')})`);
    check('parses "12.50"', C.parseAmount('12.50') === 12.5);
    check('parses "$1,250.75"', C.parseAmount('$1,250.75') === 1250.75, `(got ${C.parseAmount('$1,250.75')})`);
    check('rejects junk', Number.isNaN(C.parseAmount('abc')));

    // A user typing 10 AUD must buy strictly less than 10 USD of value.
    check('10 AUD < 10 USD', C.toUsd(10) < 10, `(got ${C.toUsd(10)})`);

    // Regression guard: the UI renders money while the document is still
    // parsing, so these helpers must exist the instant currency.js evaluates.
    // They previously did not, because the script tag was deferred - every
    // render then threw ReferenceError, bots stopped being added and trade
    // logs stopped drawing. Assert they are functions on window, and that a
    // template literal using them evaluates.
    check('window.fmtUSD is a function', typeof ctx.window.fmtUSD === 'function');
    check('window.fmtAUD is a function', typeof ctx.window.fmtAUD === 'function');
    check('window.fmtNum is a function', typeof ctx.window.fmtNum === 'function');
    check('window.audToUsd is a function', typeof ctx.window.audToUsd === 'function');
    check('window.usdToAud is a function', typeof ctx.window.usdToAud === 'function');

    // In a browser `window` IS the global object, so a bare `fmtUSD(...)` in a
    // template resolves. This harness makes window a plain property, so it is
    // also aliased as a bare global here - which asserts the helpers are
    // reachable exactly the way the page reaches them.
    ctx.w = ctx.window;
    ctx.globalThis = ctx;
    const rendered = vm.runInContext(
        '`<b>${w.fmtAUD(1.5)}</b><i>${w.fmtUSD(2)}</i><u>${w.fmtNum(0.1234)}</u>`', ctx);
    // 2 USD at 1.4224 is 2.8448, which toFixed(2) renders as A$2.84.
    check('template using the formatters renders',
        /A\$1\.50/.test(rendered) && /A\$2\.84/.test(rendered), `(got ${rendered})`);

    // fmtUSD must never throw on the shapes the UI passes it: undefined,
    // null, NaN, strings and objects all occur in real render paths.
    let threw = null;
    try {
        vm.runInContext(
            '[w.fmtUSD(undefined),w.fmtUSD(null),w.fmtUSD(NaN),w.fmtUSD("1.5"),w.fmtUSD(0),w.fmtUSD({})].join("|")',
            ctx);
    } catch (e) { threw = e.message; }
    check('fmtUSD tolerates bad input', threw === null, threw ? `(threw ${threw})` : '');

    console.log('\n---');
    console.log(failures === 0 ? 'All currency checks passed.' : `${failures} check(s) failed.`);
    console.log('');
    process.exit(failures === 0 ? 0 : 1);
})();
