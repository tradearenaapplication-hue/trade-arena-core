// Scan the LIVE index.html inline scripts for syntax errors that would kill
// every onclick handler (the "Illegal return statement" class of bug).
const fs = require('fs');
const path = process.argv[2] || 'C:/Users/admi/AppData/Local/Temp/live-index.html';
const s = fs.readFileSync(path, 'utf8');
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
let m, i = 0, bad = 0;
while ((m = re.exec(s))) {
  i++;
  const body = m[1];
  // Skip obviously-empty / comment-only blocks
  if (!body.trim()) continue;
  try {
    new Function(body);
  } catch (e) {
    bad++;
    const approxLine = s.slice(0, m.index).split('\n').length;
    console.log(`INLINE SCRIPT #${i} (near file line ${approxLine}) SYNTAX ERROR: ${e.message}`);
    // print the offending line of the inline body
    const match = /:(\d+):/.exec(e.stack || '');
  }
}
console.log(`inline scripts scanned: ${i}, with syntax errors: ${bad}`);
