#!/usr/bin/env node

/**
 * CRUCIBLE LIVE VERIFICATION
 * ============================================================================
 * Runs the Crucible regime backtest against REAL, currently-trading market
 * data and prints the result plus the inputs that produced it.
 *
 * This is the script to use when asking "is the Crucible regime panel actually
 * measuring anything, and are the numbers right?" It proves the pipeline
 * end-to-end against live data rather than a fixture.
 *
 * Usage:
 *   node scripts/verify-crucible-regime.js
 *   node scripts/verify-crucible-regime.js --asset ethereum --days 90
 *
 * Exit code 0 = every check passed. 1 = something failed (details on stdout).
 */

const OnchainRegime = require("../crucible-regime.js");

const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const asset = argOf("--asset", "bitcoin");
const days = parseInt(argOf("--days", "30"), 10);

let failures = 0;
const check = (label, condition, detail) => {
  if (!condition) failures++;
  console.log(`  [${condition ? "PASS" : "FAIL"}] ${label}${detail ? " - " + detail : ""}`);
};

const usd = (v) => (v >= 0 ? "+" : "") + "$" + v.toFixed(2);
const pf = (v) => (!Number.isFinite(v) ? "n/a" : v.toFixed(2));

(async () => {
  console.log("=".repeat(70));
  console.log("CRUCIBLE REGIME VERIFICATION (live market data)");
  console.log("=".repeat(70));
  console.log(`Asset: ${asset}   Window: ${days} days\n`);

  let fetched;
  try {
    fetched = await OnchainRegime.fetchCandles(asset, { days });
  } catch (e) {
    console.error(`\nFAILED to fetch real data: ${e.message}`);
    console.error("The panel will not display a number it cannot source from real prices.");
    process.exit(1);
  }

  console.log(`Data source : ${fetched.source}${fetched.degraded ? " (degraded: closes only)" : ""}`);
  console.log(`Candles     : ${fetched.candles.close.length}`);
  const first = new Date(fetched.candles.timestamp[0]).toISOString().slice(0, 16);
  const lastTs = fetched.candles.timestamp[fetched.candles.timestamp.length - 1];
  console.log(`Window      : ${first} -> ${new Date(lastTs).toISOString().slice(0, 16)}\n`);

  // ── 1. Classification integrity ──────────────────────────────────────────
  console.log("1. CLASSIFICATION");
  const detected = OnchainRegime.classifyCandles(fetched.candles);
  const ind = detected.indicators;
  console.log(`   Regime   : ${detected.regime}`);
  console.log(`   RSI(14)  : ${ind.rsi.toFixed(2)}`);
  console.log(`   ATR%(14) : ${ind.atrPercent.toFixed(3)}%`);
  console.log(`   SMA(20)  : $${ind.sma.toFixed(2)}   Price: $${ind.price.toFixed(2)}\n`);

  check("regime is one of the four known states",
    ["BULL", "BEAR", "CHOP", "HIGH_VOL"].includes(detected.regime), detected.regime);
  check("RSI is within 0-100", ind.rsi >= 0 && ind.rsi <= 100, ind.rsi.toFixed(2));
  check("ATR% is non-negative and finite",
    Number.isFinite(ind.atrPercent) && ind.atrPercent >= 0, ind.atrPercent.toFixed(3));
  check("HIGH_VOL only when ATR% actually exceeds 5",
    detected.regime !== "HIGH_VOL" || ind.atrPercent > 5, `ATR%=${ind.atrPercent.toFixed(2)}`);
  check("BULL requires RSI>60 AND price>SMA",
    detected.regime !== "BULL" || (ind.rsi > 60 && ind.price > ind.sma),
    `RSI=${ind.rsi.toFixed(1)} price=${ind.price.toFixed(2)} sma=${ind.sma.toFixed(2)}`);
  check("BEAR requires RSI<40 AND price<SMA",
    detected.regime !== "BEAR" || (ind.rsi < 40 && ind.price < ind.sma),
    `RSI=${ind.rsi.toFixed(1)} price=${ind.price.toFixed(2)} sma=${ind.sma.toFixed(2)}`);


  // ── 2. Every requested regime round-trips ────────────────────────────────
  // This is the check that catches the original bug: the panel read the regime
  // from a DOM id with .replace('regime',''), producing "Bull"/"Bear" instead of
  // "BULL"/"BEAR", so every selection fell through to the BULL default and the
  // selector had no effect on the output whatsoever.
  console.log("\n2. REGIME SELECTOR ROUND-TRIP");
  for (const regime of ["BULL", "BEAR", "CHOP", "HIGH_VOL"]) {
    const r = OnchainRegime.backtestRegime(fetched.candles, {
      requestedRegime: regime, notional: 100,
    });
    const expectedBias = regime === "BULL" ? "long" : regime === "BEAR" ? "short" : "random";
    console.log(
      `   ${regime.padEnd(9)} -> strategy runs '${r.strategy.direction}'` +
      ` (expected '${expectedBias}'), detected ${r.detectedRegime}` +
      `${r.regimeMismatch ? " [MISMATCH FLAGGED]" : ""}`,
    );
    check(`${regime} maps to the '${expectedBias}' bias`, r.strategy.direction === expectedBias);
  }

  // ── 3. Cost model behaviour ──────────────────────────────────────────────
  console.log("\n3. COST MODEL");
  const cfg = OnchainRegime.DEFAULT_CONFIG;
  const realistic = OnchainRegime.backtestRegime(fetched.candles, {
    requestedRegime: detected.regime, costModel: "REALISTIC_1X", notional: 100,
  });
  const stress = OnchainRegime.backtestRegime(fetched.candles, {
    requestedRegime: detected.regime, costModel: "STRESS_1_5X", notional: 100,
  });

  console.log(`   REALISTIC_1X : ${realistic.costBpsPerRoundTrip} bps round trip`);
  console.log(`   STRESS_1_5X  : ${stress.costBpsPerRoundTrip} bps round trip`);
  console.log(`   Strategy net : ${usd(realistic.strategy.netPnl)} -> ${usd(stress.strategy.netPnl)}`);

  check("round trip is charged on BOTH legs",
    OnchainRegime.costBps(cfg, "REALISTIC_1X") === (cfg.feeBps + cfg.slippageBps) * 2,
    `${OnchainRegime.costBps(cfg, "REALISTIC_1X")} bps`);
  check("STRESS_1_5X costs 1.5x more",
    Math.abs(OnchainRegime.costBps(cfg, "STRESS_1_5X") / OnchainRegime.costBps(cfg, "REALISTIC_1X") - 1.5) < 1e-9);
  check("higher costs never improve P&L",
    stress.strategy.netPnl <= realistic.strategy.netPnl,
    `${usd(stress.strategy.netPnl)} <= ${usd(realistic.strategy.netPnl)}`);

  // ── 4. Arithmetic self-consistency ───────────────────────────────────────
  console.log("\n4. RESULTS TABLE");
  const rows = [
    ["Strategy", realistic.strategy],
    ["Random control", realistic.baselines.random],
    ["Momentum", realistic.baselines.momentum],
    ["Buy & hold", realistic.baselines.buyAndHold],
    ["Short & hold", realistic.baselines.shortAndHold],
  ];
  console.log("   " + "Series".padEnd(16) + "Trades".padStart(7) + "Win%".padStart(8) +
    "Net P&L".padStart(12) + "PF".padStart(8));
  for (const [label, s] of rows) {
    console.log(
      "   " + label.padEnd(16) + String(s.trades).padStart(7) +
      s.winRate.toFixed(1).padStart(8) + usd(s.netPnl).padStart(12) + pf(s.profitFactor).padStart(8),
    );
  }
  console.log();

  check("win rate equals wins/trades",
    Math.abs(realistic.strategy.winRate -
      (realistic.strategy.wins / realistic.strategy.trades) * 100) < 1e-9);
  check("wins + losses equals trade count",
    realistic.strategy.wins + realistic.strategy.losses === realistic.strategy.trades);
  check("trade count is candles minus one entry bar",
    realistic.strategy.trades === fetched.candles.close.length - 1,
    `${realistic.strategy.trades} vs ${fetched.candles.close.length - 1}`);
  check("random control is reproducible across runs",
    OnchainRegime.backtestRegime(fetched.candles, { requestedRegime: detected.regime })
      .baselines.random.netPnl === realistic.baselines.random.netPnl);
  check("net P&L equals return% x deployed notional",
    Math.abs(realistic.strategy.netReturnPct / 100 * (realistic.strategy.trades * realistic.notional) -
      realistic.strategy.netPnl) < 1e-6);

  // ── 5. Verdict ───────────────────────────────────────────────────────────
  console.log("5. VERDICT");
  const verdict = realistic.edgeSignificant
    ? `SIGNIFICANT EDGE (${realistic.winRateEdgePct.toFixed(1)}pp over the coin-flip control, ` +
      `wider than the ${realistic.noiseBandPct.toFixed(1)}pp noise band)`
    : realistic.beatsRandom
      ? `Ahead of the coin-flip control but INSIDE the ${realistic.noiseBandPct.toFixed(1)}pp noise band - ` +
        "no demonstrated edge"
      : "DOES NOT beat the coin-flip control after costs - no demonstrated edge";
  console.log(`   ${verdict}\n`);

  console.log("=".repeat(70));
  console.log(failures === 0 ? "RESULT: ALL CHECKS PASSED" : `RESULT: ${failures} CHECK(S) FAILED`);
  console.log("=".repeat(70));

  process.exit(failures === 0 ? 0 : 1);
})();
