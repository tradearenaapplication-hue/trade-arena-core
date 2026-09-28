#!/usr/bin/env node
/**
 * One-off codemod: convert `$${expr}` money displays in index.html to
 * `${fmtUSD(expr)}` so amounts render in AUD.
 *
 * Deliberately conservative:
 *  - skips non-monetary sites (a sign prefix such as `pnl >= 0 ? '+' : ''`)
 *  - preserves an explicit decimal-places argument where the original had one
 *  - leaves every other `$` untouched, including CSS, ids and prices
 *
 *   node scripts/convert-money-to-aud.js          # dry run, prints a summary
 *   node scripts/convert-money-to-aud.js --write  # apply
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'index.html');
const write = process.argv.includes('--write');

let src = fs.readFileSync(FILE, 'utf8');

// A `$${...}` that is not a plain monetary value. `pnl >= 0 ? '+' : ''` is a
// sign prefix that merely sits beside a currency symbol; converting it would
// replace the sign with an amount.
function isMonetary(expr) {
    const e = expr.trim();
    if (/:\s*''/.test(e)) return false;            // ternary yielding ''
    if (/\?/.test(e) && !/toFixed/.test(e)) return false; // other ternary
    return true;
}

// `$${EXPR.toFixed(DP)}` - DP may itself contain a conditional.
const RE_TO = /\$\$\{([^{}]+?)\.toFixed\(([^{}]*)\)\}/g;
// `$${EXPR}` with no toFixed.
const RE_BARE = /\$\$\{([^{}]+?)\}(?![\w(])/g;

let changed = 0;
const skipped = [];

src = src.replace(RE_TO, (m, expr, dp) => {
    if (!isMonetary(expr)) { skipped.push(m); return m; }
    changed++;
    return '${fmtUSD(' + expr.trim() + ', ' + dp.trim() + ')}';
});

src = src.replace(RE_BARE, (m, expr) => {
    if (!isMonetary(expr)) { skipped.push(m); return m; }
    if (/^fmtUSD\(/.test(expr)) return m;           // already converted
    changed++;
    return '${fmtUSD(' + expr.trim() + ')}';
});

console.log('converted: ' + changed);
console.log('skipped  : ' + skipped.length);
[...new Set(skipped)].forEach(s => console.log('   kept: ' + s));

if (write) {
    fs.writeFileSync(FILE, src, 'utf8');
    console.log('\nwritten to ' + FILE);
} else {
    console.log('\n(dry run - pass --write to apply)');
}
