"use strict";

/**
 * Query the scan history.
 *
 * This is the payoff. Everything before it - failover, block pinning, the
 * detection test - exists to make these numbers trustworthy. The question that
 * matters is NOT "did one scan find an opportunity" but:
 *
 *   "Over N scans, how often does a real edge appear, how large is it, and
 *    how long does it last?"
 *
 * That cannot be answered from a single run, which is why the history exists.
 *
 * Usage
 *   node scripts/query-scans.js summary
 *   node scripts/query-scans.js by-pair
 *   node scripts/query-scans.js coverage
 *   node scripts/query-scans.js tail 20
 *   node scripts/query-scans.js opportunities
 */

const fs = require("fs");
const { SCAN_FILE } = require("./scan-recorder.js");

function loadAll(file = SCAN_FILE) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch (e) {
        return null; // tolerate a torn line rather than failing the read
      }
    })
    .filter(Boolean);
}

const pct = (n, d) => (d > 0 ? ((n / d) * 100).toFixed(1) + "%" : "n/a");
const fmtUsd = (n) => (n === null || n === undefined ? "n/a" : "$" + Number(n).toFixed(2));
const fmtBps = (n) => (n === null || n === undefined ? "n/a" : Number(n).toFixed(1) + " bps");
function summary(rows) {
  const conclusive = rows.filter((r) => r.conclusive);
  const withEdge = conclusive.filter((r) => (r.viableCount || 0) > 0);
  const profits = conclusive
    .map((r) => r.bestNetProfitUSD)
    .filter((n) => n !== null && n !== undefined);

  console.log("=".repeat(72));
  console.log("SCAN HISTORY SUMMARY — is there an edge on Base?");
  console.log("=".repeat(72));
  console.log();
  console.log(`scans recorded        : ${rows.length}`);
  console.log(`conclusive scans      : ${conclusive.length}   (coverage >= 50%)`);
  console.log(`inconclusive          : ${rows.length - conclusive.length}  (excluded below)`);
  console.log();

  if (!conclusive.length) {
    console.log("No conclusive scans yet. Nothing can be concluded.");
    console.log("Either the scanner is not running, or every run so far was");
    console.log("throttled below the coverage floor. Fix that first.");
    return;
  }

  console.log(`scans with an edge    : ${withEdge.length}  (${pct(withEdge.length, conclusive.length)})`);
  if (profits.length) {
    const best = Math.max(...profits);
    const avg = profits.reduce((a, b) => a + b, 0) / profits.length;
    console.log(`best net profit seen  : ${fmtUsd(best)}`);
    console.log(`mean of best-per-scan : ${fmtUsd(avg)}`);
  }
  console.log();

  const verdict =
    withEdge.length === 0
      ? "VERDICT: no edge appeared in any conclusive scan. On the pairs scanned,\n" +
        "         this market is efficient at your size and cost basis."
      : withEdge.length / conclusive.length < 0.05
        ? "VERDICT: an edge appeared rarely (<5% of scans). It is real but the\n" +
          "         expected value is thin - compare the hit rate against your\n" +
          "         per-attempt gas cost before sizing anything."
        : "VERDICT: an edge appeared in a meaningful share of scans. Worth\n" +
          "         investigating which pairs and sizes carry it.";
  console.log(verdict);
}

function byPair(rows) {
  const tally = new Map();
  for (const r of rows) {
    if (!r.conclusive) continue;
    const k = r.bestPair || "(no viable route)";
    const t = tally.get(k) || { wins: 0, best: null, bestBps: 0 };
    t.wins++;
    if (r.bestNetProfitUSD !== null && (t.best === null || r.bestNetProfitUSD > t.best)) {
      t.best = r.bestNetProfitUSD;
    }
    if (r.bestSpreadBps !== null && r.bestSpreadBps > t.bestBps) t.bestBps = r.bestSpreadBps;
    tally.set(k, t);
  }
  console.log("=".repeat(72));
  console.log("BY PAIR (conclusive scans only)");
  console.log("=".repeat(72));
  console.log();
  if (!tally.size) {
    console.log("No conclusive scans to summarise.");
    return;
  }
  console.log("best pair".padEnd(24) + "times best".padStart(12) + "best profit".padStart(14) + "max spread".padStart(13));
  for (const [k, t] of [...tally.entries()].sort((a, b) => b[1].wins - a[1].wins)) {
    console.log(
      k.padEnd(24) + String(t.wins).padStart(12) + fmtUsd(t.best).padStart(14) + fmtBps(t.bestBps).padStart(13),
    );
  }
}

function coverage(rows) {
  console.log("=".repeat(72));
  console.log("SCAN RELIABILITY — could each run actually see the market?");
  console.log("=".repeat(72));
  console.log();
  if (!rows.length) {
    console.log("No scans recorded.");
    return;
  }
  const covs = rows.map((r) => r.coverage || 0);
  const avg = covs.reduce((a, b) => a + b, 0) / covs.length;
  const bad = rows.filter((r) => !r.conclusive);
  console.log(`average coverage      : ${(avg * 100).toFixed(1)}%`);
  console.log(`lowest coverage       : ${(Math.min(...covs) * 100).toFixed(1)}%`);
  console.log(`inconclusive runs     : ${bad.length} of ${rows.length}`);
  console.log();
  if (bad.length) {
    console.log("A run below 50% coverage is EXCLUDED from every edge statistic,");
    console.log("because it did not price most routes and so cannot show their");
    console.log("absence. A high count here means the cadence is too aggressive");
    console.log("for the free endpoints.");
    console.log();
    const worst = [...rows].sort((a, b) => (a.coverage || 0) - (b.coverage || 0)).slice(0, 5);
    console.log("worst runs:");
    for (const w of worst) {
      console.log(
        `  ${w.ts}  block ${w.block}  coverage ${((w.coverage || 0) * 100).toFixed(1)}%  ` +
        `ok=${w.quotesOk} failed=${w.quotesFailed} throttled=${w.quotesInconclusive}`,
      );
    }
  }
}

function opportunities(rows) {
  const hits = rows.filter((r) => (r.viableCount || 0) > 0);
  console.log("=".repeat(72));
  console.log(`SCANS CONTAINING AN EDGE (${hits.length})`);
  console.log("=".repeat(72));
  console.log();
  if (!hits.length) {
    console.log("None. See `summary` for what follows from that.");
    return;
  }
  for (const h of [...hits].sort((a, b) => (b.bestNetProfitUSD || 0) - (a.bestNetProfitUSD || 0))) {
    console.log(
      `${h.ts}  block ${h.block}  ${h.bestPair}  net ${fmtUsd(h.bestNetProfitUSD)}  ` +
      `spread ${fmtBps(h.bestSpreadBps)}  coverage ${((h.coverage || 0) * 100).toFixed(0)}%`,
    );
  }
}

function tail(rows, n) {
  console.log("=".repeat(72));
  console.log(`LAST ${n} SCANS`);
  console.log("=".repeat(72));
  console.log();
  for (const r of rows.slice(-n)) {
    console.log(
      `${r.ts}  block ${r.block}  coverage ${((r.coverage || 0) * 100).toFixed(0)}%  ` +
      `conclusive=${r.conclusive}  edges=${r.viableCount}  best=${fmtUsd(r.bestNetProfitUSD)}`,
    );
  }
}

function main() {
  const cmd = process.argv[2] || "summary";
  const file = process.env.SCAN_FILE || SCAN_FILE;
  const rows = loadAll(file);

  if (!rows.length) {
    console.log(`No scan history at ${file}`);
    console.log("Run `npm run scan:flash:record` to start collecting.");
    return;
  }

  switch (cmd) {
    case "summary": return summary(rows);
    case "by-pair": return byPair(rows);
    case "coverage": return coverage(rows);
    case "opportunities": return opportunities(rows);
    case "tail": return tail(rows, Number(process.argv[3]) || 20);
    default:
      console.log("Commands: summary | by-pair | coverage | opportunities | tail [n]");
  }
}

if (require.main === module) main();
module.exports = { loadAll };
