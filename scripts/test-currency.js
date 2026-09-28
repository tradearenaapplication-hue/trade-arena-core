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

    console.log('\n---');
    console.log(failures === 0 ? 'All currency checks passed.' : `${failures} check(s) failed.`);
    console.log('');
    process.exit(failures === 0 ? 0 : 1);
})();
