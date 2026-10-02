#!/usr/bin/env node

/**
 * REGIME EDGE SEARCH
 * ============================================================================
 * Runs the honest search (regime-strategy-lab.js) over cached real candles and
 * reports, for each asset and horizon, whether ANY strategy demonstrated an
 * edge that survives out-of-sample validation and multiple-testing correction.
 *
 * THIS SCRIPT WILL PROBABLY PRINT "NO EDGE". That is the expected and correct
 * result for retail strategies on 4h crypto bars at 80bps round-trip costs.
 * The previous version of this panel printed a BULL win rate of 65% for every
 * asset because it returned a hardcoded table; nothing was measured. This
 * script measures, and the measurement is frequently negative.
 *
 * Usage:
 *   node scripts/search-regime-edge.js
 *   node scripts/search-regime-edge.js --horizons 1,4,12
 *
 * Prerequisite: node scripts/prime-candle-cache.js
 *
 * Exit code 0 = the search completed. It does NOT mean an edge was found -
 * read the output. Exit 1 = an asset had no cached data.
 */

const OnchainRegime = require("../crucible-regime.js");
const Lab = require("../regime-strategy-lab.js");

const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const ASSETS = argOf("--assets", "bitcoin,ethereum,solana,dogecoin,arbitrum").split(",");
const HORIZONS = argOf("--horizons", "1,4,12").split(",").map(Number).filter((n) => n > 0);
const DAYS = Number(argOf("--days", "30"));

const usd = (v) => (v >= 0 ? "+" : "") + "$" + v.toFixed(2);
const pf = (v) => (!Number.isFinite(v) ? "n/a" : v.toFixed(2));

(async () => {
  console.log("=".repeat(78));
  console.log("REGIME EDGE SEARCH - real candles, real costs, out-of-sample validated");
  console.log("=".repeat(78));
  console.log(`Assets : ${ASSETS.join(", ")}`);
  console.log(`Horizons (bars held): ${HORIZONS.join(", ")}`);
  console.log(`Costs  : ${Lab.costBps(Lab.DEFAULT_CONFIG, "REALISTIC_1X")}bps round trip ` +
    `(${Lab.DEFAULT_CONFIG.feeBps} fee + ${Lab.DEFAULT_CONFIG.slippageBps} slippage, per side)`);
  console.log(`Rule   : an edge requires OOS edge > 2-sigma noise band AND p < alpha\n`);

  let anyEdge = false;
  let missing = 0;
  const rows = [];

  for (const id of ASSETS) {
    let candles;
    try {
      const f = await OnchainRegime.fetchCandles(id, { days: DAYS });
      candles = f.candles;
    } catch (e) {
      missing++;
      console.log(`  ${id.padEnd(10)} NO CACHED DATA - run scripts/prime-candle-cache.js`);
      continue;
    }

    for (const h of HORIZONS) {
      const r = Lab.search(candles, { horizon: h });
      if (r.error) {
        console.log(`  ${id.padEnd(10)} h=${String(h).padStart(2)}  ${r.error}`);
        continue;
      }
      if (r.hasEdge) anyEdge = true;
      const b = r.best;
      rows.push({ id, h, hasEdge: r.hasEdge, best: b, tested: r.variantsTested, alpha: r.alpha });

      const verdict = r.hasEdge
        ? `EDGE  ${b.variant.name} ${JSON.stringify(b.variant.params)}`
        : "none ";
      const detail = b
        ? `${String(b.oos.trades).padStart(4)} trades  WR ${b.oos.winRate.toFixed(1).padStart(5)}%` +
          ` vs control ${b.control.winRate.toFixed(1).padStart(5)}%` +
          `  edge ${b.edgePp.toFixed(1).padStart(5)}pp (noise ${b.noisePp.toFixed(1)}pp)` +
          `  p=${b.pValue.toFixed(3)}`
        : "";
      console.log(`  ${id.padEnd(10)} h=${String(h).padStart(2)}  ${verdict.padEnd(46)} ${detail}`);
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log("\n" + "-".repeat(78));
  console.log("DETAIL FOR EVERY FINALIST (best 3 by in-sample P&L, per asset/horizon)");
  console.log("-".repeat(78));
  for (const row of rows) {
    const cands = row.hasEdge
      ? [row.best]
      : (row.bestOos || []);
    if (!row.hasEdge) continue;
    const b = row.best;
    console.log(`\n  ${row.id} h=${row.h}  ${b.variant.name} ${JSON.stringify(b.variant.params)}`);
    console.log(`    regime-gated: ${b.variant.allowedRegimes ? b.variant.allowedRegimes.join(",") : "any"}`);
    console.log(`    OOS strategy : ${b.oos.trades} trades, WR ${b.oos.winRate.toFixed(1)}%, ` +
      `${usd(b.oos.netPnl)}, PF ${pf(b.oos.profitFactor)}, maxDD ${(b.oos.maxDrawdown * 100).toFixed(2)}%`);
    console.log(`    OOS control  : ${b.control.trades} trades, WR ${b.control.winRate.toFixed(1)}%, ` +
      `${usd(b.control.netPnl)}, PF ${pf(b.control.profitFactor)}`);
    console.log(`    edge         : ${b.edgePp.toFixed(1)}pp win rate, ${usd(b.pnlEdge)} P&L, p=${b.pValue.toExponential(2)}`);
  }

  console.log("\n" + "=".repeat(78));
  if (missing) {
    console.log(`${missing} asset(s) had no cached data. Run: node scripts/prime-candle-cache.js`);
  }
  if (anyEdge) {
    console.log("RESULT: at least one configuration demonstrated a validated edge.");
    console.log("        Verify on a FRESH window before risking capital - this window was used to search.");
  } else {
    console.log("RESULT: NO EDGE FOUND on any asset or horizon.");
    console.log("");
    console.log("This is the honest answer, not a failure of the search. It means:");
    console.log("  - no tested strategy beat a coin-flip control by more than sampling noise,");
    console.log("  - after paying 80bps per round trip,");
    console.log("  - on data it had never been selected on.");
    console.log("");
    console.log("The cost of a 4h round trip is roughly the typical bar's entire move.");
    console.log("Trading faster cannot work here. Test longer horizons (--horizons 24,48,96)");
    console.log("or a lower-cost venue before concluding the asset class is untradeable.");
  }
  console.log("=".repeat(78));
  process.exit(missing === 0 ? 0 : 1);
})();
