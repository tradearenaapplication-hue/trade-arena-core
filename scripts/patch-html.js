#!/usr/bin/env node
/**
 * Small helper used to patch index.html without shell-quoting hazards.
 * Reads a JSON list of {find, replace} and applies them in order.
 *   node scripts/patch-html.js patches.json
 */
const fs = require('fs');
const path = require('path');

const specPath = process.argv[2];
const target = path.join(__dirname, '..', 'index.html');

const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
let src = fs.readFileSync(target, 'utf8');

let applied = 0;
const missed = [];

for (const { find, replace, label } of spec) {
    const before = src;
    src = src.split(find).join(replace);
    if (src !== before) {
        applied++;
        console.log(`[ok]   ${label || find.slice(0, 50)}`);
    } else {
        missed.push(label || find.slice(0, 60));
    }
}

if (missed.length) {
    console.log('\nNOT FOUND:');
    missed.forEach(m => console.log('  ' + m));
    process.exit(1);
}

fs.writeFileSync(target, src, 'utf8');
console.log(`\napplied ${applied} patch(es) to index.html`);
