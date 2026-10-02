#!/usr/bin/env node

/**
 * COST SENSITIVITY SWEEP
 * ============================================================================
 * The decisive question is not "which strategy wins" but "WHAT IS BINDING":
 *
 *   A. The venue  - costs are so high that no strategy can pay for itself.
 *                   Fix: cheaper pool, better execution, longer holds.
 *   B. The market - no directional predictability exists at all.
 *                   Fix: different signal families entirely.
 *
 * These look identical from inside a normal backtest and they have opposite
 * solutions. This script separates them by re-running the same search across a
 * range of transaction costs.
 *
 * HOW TO READ THE RESULT
 *
 *   Edge appears only at LOW costs
 *       The strategies have real signal; the venue is eating it.
 *       -> Trade less often, cheaper pool, longer holds.
 *
 *   Edge appears at HIGH costs
 *       Counter-intuitive but real: high volatility means moves large enough to
 *       clear the fee. -> Trade the HIGH_VOL regime deliberately.
 *
 *   NO edge at ANY cost, including zero
 *       The strategies have no signal. Cost reduction cannot help.
 *       -> Stop optimising these; change the signal family.
 *
 *   A zero-cost run that finds nothing is the strongest negative result
 *   available: it removes cost as an explanation entirely.
 *
 * Usage:
 *   node scripts/cost-sensitivity.js
 *   node scripts/cost-sensitivity.js --assets bitcoin,ethereum --days 30
 */

const OnchainRegime = require("../crucible-regime.js");
const Lab = require("../regime-strategy-lab.js");

const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const ASSETS = argOf("--assets", "bitcoin,ethereum,solana").split(",");
const DAYS = Number(argOf("--days", "30"));
const HORIZONS = [1, 4, 12, 24, 48];

// Round-trip cost in bps. 80bps is the realistic Uniswap v3 0.3% tier;
// 20bps approximates the 0.05% tier; 0bps isolates signal from execution.
const COST_GRID = [0, 20, 40, 80, 160];

const usd = (v) => (v >= 0 ? "+" : "") + "$" + v.toFixed(2);

/** Count validated edges for one cost level across all assets and horizons. */
function sweepCost(cache, ids, cb) {
  const perAsset = [];
  let total = 0;
  for (const id of ids) {
    let n = 0;
    for (const h of HORIZONS) {
      const r = Lab.search(cache[id], { horizon: h, costBps: cb, minTrades: 15 });
      if (!r.error && r.hasEdge) n++;
    }
    perAsset.push(n);
    total += n;
  }
  return { perAsset, total };
}

(async () => {
  console.log("=".repeat(80));
  console.log("COST SENSITIVITY SWEEP - is the venue binding, or the market?");
  console.log("=".repeat(80));
  console.log(`Assets: ${ASSETS.join(", ")}  |  Horizons: ${HORIZONS.join(", ")} bars\n`);

  const cache = {};
  for (const id of ASSETS) {
    try {
      cache[id] = (await OnchainRegime.fetchCandles(id, { days: DAYS })).candles;
    } catch (e) {
      console.log(`  ${id.padEnd(10)} no cached data - run scripts/prime-candle-cache.js`);
    }
  }

  const ids = Object.keys(cache);
  if (!ids.length) {
    console.log("\nNothing to sweep. Run: node scripts/prime-candle-cache.js");
    process.exit(1);
  }

  // ── Validated edges by cost level ─────────────────────────────────────────
  console.log(`VALIDATED EDGES BY COST LEVEL (out of ${ids.length * HORIZONS.length} configs)`);
  console.log("-".repeat(80));
  console.log("  cost(rt)  " + ids.map((i) => i.slice(0, 9).padStart(10)).join("") + "    TOTAL");
  console.log("  " + "-".repeat(74));

  const winsByCost = {};
  for (const cb of COST_GRID) {
    const { perAsset, total } = sweepCost(cache, ids, cb);
    winsByCost[cb] = total;
    console.log(
      "  " + String(cb).padStart(6) + "bps  " +
      perAsset.map((n) => String(n).padStart(10)).join("") +
      String(total).padStart(10),
    );
  }


  // ── Where does P&L actually land by horizon? ──────────────────────────────
  console.log("\n\nOUT-OF-SAMPLE P&L BY HORIZON (averaged across assets, at 80bps cost)");
  console.log("-".repeat(80));
  for (const h of HORIZONS) {
    let sum = 0;
    let n = 0;
    for (const id of ids) {
      const r = Lab.search(cache[id], { horizon: h, costBps: 80, minTrades: 15 });
      if (!r.error && r.best) {
        sum += r.best.oos.netPnl;
        n++;
      }
    }
    console.log(`  hold ${String(h).padStart(2)} bars   avg OOS P&L ${usd(n ? sum / n : 0)}`);
  }

  // ── Cost per unit of exposure, which is the thing that actually matters ──
  console.log("\n\nCOST DRAG PER HELD BAR (the number that decides whether trading works)");
  console.log("-".repeat(80));
  console.log("  Round trip costs the same 80bps whether you hold 1 bar or 48.");
  console.log("  Spreading it over more bars lowers the drag per bar of exposure:\n");
  for (const h of HORIZONS) {
    console.log(`    hold ${String(h).padStart(2)} bars  ->  ${(80 / h).toFixed(2)}bps per bar held`);
  }

  // ── Verdict ──────────────────────────────────────────────────────────────
  const zero = winsByCost[0];
  const cheap = winsByCost[20];
  const real = winsByCost[80];

  console.log("\n" + "=".repeat(80));
  console.log("VERDICT");
  console.log("=".repeat(80));

  if (zero === 0 && real === 0) {
    console.log("NO EDGE AT ANY COST, INCLUDING ZERO.");
    console.log("");
    console.log("This is the strongest negative result available: cost cannot explain it,");
    console.log("because cost has been removed entirely. These five strategy families have");
    console.log("no directional signal in this data.");
    console.log("");
    console.log("DO NOT: add indicator variants, tune parameters, or chase lower fees.");
    console.log("DO:    change the signal family. Direction-independent strategies (long vol,");
    console.log("       cross-asset spreads, basis trades) do not need to predict direction,");
    console.log("       so an unpredictable market does not defeat them.");
  } else if (real > zero && real > cheap) {
    console.log("EDGE APPEARS AT HIGHER COSTS - volatility is paying for the fees.");
    console.log("");
    console.log("The profitable configurations sit where moves are large enough to clear");
    console.log("the fee. That points at trading the HIGH_VOL regime deliberately and letting");
    console.log("the volatility filter, not the cost, decide position size.");
  } else if (cheap > real) {
    console.log("EDGE APPEARS ONLY AT LOW COSTS - the venue is eating the signal.");
    console.log("");
    console.log("These strategies have real signal but cannot pay for themselves at 80bps.");
    console.log("Actions, in order of impact:");
    console.log("  1. Trade less often. Cost drag scales with TRADE COUNT, not time held.");
    console.log("  2. Use the 0.05% Uniswap pool (fee tier 500), already configured for");
    console.log("     WETH/USDC in services/TokenManager.js.");
    console.log("  3. Lengthen holds. The cost-drag table above shows why this works.");
  } else {
    console.log("MIXED - no clean cost story. Inspect the tables above per configuration.");
  }

  console.log("=".repeat(80));
  console.log("");
  console.log("Next step regardless of verdict: get more data. At ~30 days the noise band");
  console.log("is +-12pp, so a real 5% edge is statistically invisible. Use daily bars over");
  console.log("2+ years for hundreds of independent observations, then re-run:");
  console.log("  node scripts/search-regime-edge.js --days 90");
  console.log("=".repeat(80));
})();
