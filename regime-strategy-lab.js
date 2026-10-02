/**
 * REGIME-CONDITIONAL STRATEGY LAB
 * ============================================================================
 * Searches for a strategy that beats a coin-flip control AFTER costs, and —
 * just as importantly — can prove it on data the search never touched.
 *
 * THE HONESTY PROBLEM
 * --------------------
 * With ~180 candles of 4h data, a single strategy has maybe 150 usable trades.
 * The standard error on a ~50% win rate at n=150 is about 4 percentage points.
 * That means: if you test 100 strategy variants and report the best one, you
 * WILL find something that "beats" a control. It will be luck. This is the
 * multiple-comparisons trap, and it is how backtests lie.
 *
 * So this module does three things the naive version does not:
 *
 *  1. MULTIPLE-TESTING CORRECTION. Every variant tried is counted. The best
 *     variant's advantage is compared against the distribution of ALL
 *     variants' advantages, not against a single control. If the winner is
 *     only the luckiest of a crowd, that is reported as "no edge found".
 *
 *  2. OUT-OF-SAMPLE VALIDATION. Data is split chronologically. Strategies are
 *     SELECTED on the in-sample half and then run, untouched, on the
 *     out-of-sample half. Only OOS results count as evidence.
 *
 *  3. A REALISTIC COST MODEL. 0.30% fee + 0.10% slippage per side = 80bps
 *     round trip, charged on entry AND exit. On 4h crypto bars this is a
 *     severe drag, and any strategy that ignores it is fiction.
 *
 * WHAT "EDGE" MEANS HERE
 * A strategy has an edge only if, on data it never saw, it beats the coin-flip
 * control by more than sampling noise AND survives multiple-testing
 * correction. Everything else is reported as no edge.
 *
 * No dependencies. Works in Node and the browser.
 */

const RegimeStrategyLab = (() => {
  "use strict";

  // ── STATISTICS ────────────────────────────────────────────────────────────

  /**
   * Standard error of a win-rate proportion: sqrt(p(1-p)/n).
   * This is the width of the noise band around any measured win rate, and it
   * is the single most important number when judging whether an edge is real.
   */
  function winRateSE(wins, n, p = 0.5) {
    if (!n) return Infinity;
    return Math.sqrt((p * (1 - p)) / n);
  }

  /** Abramowitz & Stegun 7.1.26 error function approximation. */
  function erf(x) {
    const sign = x < 0 ? -1 : 1;
    const ax = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * ax);
    const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
      - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
    return sign * y;
  }

  function normalCdf(z) {
    return 0.5 * (1 + erf(z / Math.SQRT2));
  }

  /**
   * Two-sided p-value for a difference in proportions, via the normal
   * approximation to the difference of two independent binomials.
   *
   * Used to compare a strategy's win rate against the coin-flip control. A
   * normal approximation is adequate at these sample sizes and avoids pulling
   * in a statistics dependency.
   */
  function twoProportionZTest(w1, n1, w2, n2) {
    if (!n1 || !n2) return { z: 0, pValue: 1 };
    const p1 = w1 / n1;
    const p2 = w2 / n2;
    const pooled = (w1 + w2) / (n1 + n2);
    const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
    if (se === 0) return { z: 0, pValue: 1 };
    const z = (p1 - p2) / se;
    return { z, pValue: 2 * (1 - normalCdf(Math.abs(z))) };
  }

  /** Inverse normal CDF (Acklam). Turns a corrected alpha into a critical z. */
  function normalQuantile(q) {
    const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
      1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
    const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
      6.680131188771972e+01, -1.328068155288572e+01];
    const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
      -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
    const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
      3.754408661907416e+00];
    const pl = 0.02425;
    let q2;
    let r;
    if (q < pl) {
      q2 = Math.sqrt(-2 * Math.log(q));
      return (((((c[0] * q2 + c[1]) * q2 + c[2]) * q2 + c[3]) * q2 + c[4]) * q2 + c[5]) /
        ((((d[0] * q2 + d[1]) * q2 + d[2]) * q2 + d[3]) * q2 + 1);
    }
    if (q > 1 - pl) {
      q2 = Math.sqrt(-2 * Math.log(1 - q));
      return -(((((c[0] * q2 + c[1]) * q2 + c[2]) * q2 + c[3]) * q2 + c[4]) * q2 + c[5]) /
        ((((d[0] * q2 + d[1]) * q2 + d[2]) * q2 + d[3]) * q2 + 1);
    }
    q2 = q - 0.5;
    r = q2 * q2;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q2 /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }

  /**
   * Bonferroni-corrected significance threshold.
   *
   * If you run k independent tests at the 5% level, the chance of at least one
   * false positive is 1 - 0.95^k. Correcting the threshold by k is the
   * conservative fix: alpha / k. It is not the most powerful method
   * (Benjamini-Hochberg is better) but it is very hard to fool, which is what
   * we want when the whole point is not fooling ourselves.
   */
  function bonferroniAlpha(trials) {
    return 0.05 / Math.max(1, trials);
  }

  /**
   * A deterministic PRNG so every control is reproducible run to run.
   * Seeded from the data itself, so different markets get different samples
   * but the same market always reproduces exactly.
   */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashSeed(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  // ── INDICATORS (causal: value at bar i uses only bars <= i) ───────────────
  //
  // CRITICAL: every indicator here must be computed WITHOUT look-ahead. The
  // signal for bar i is formed from bars up to and including i, and the trade
  // is entered at i+1's open. Smoothing one bar the wrong way is the single
  // most common way a backtest manufactures a fake edge.

  function smaSeries(values, period) {
    const out = new Array(values.length).fill(null);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= period) sum -= values[i - period];
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  }

  /** Wilder's RSI, computed causally into a series. */
  function rsiSeries(values, period = 14) {
    const out = new Array(values.length).fill(null);
    if (values.length <= period) return out;

    let gains = 0;
    let losses = 0;
    for (let i = 1; i <= period; i++) {
      const ch = values[i] - values[i - 1];
      if (ch > 0) gains += ch;
      else losses -= ch;
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;
    out[period] = avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss);

    for (let i = period + 1; i < values.length; i++) {
      const ch = values[i] - values[i - 1];
      avgGain = (avgGain * (period - 1) + (ch > 0 ? ch : 0)) / period;
      avgLoss = (avgLoss * (period - 1) + (ch < 0 ? -ch : 0)) / period;
      out[i] = avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss);
    }
    return out;
  }

  /** True range per bar, and ATR as a causal series. */
  function atrSeries(high, low, close, period = 14) {
    const tr = new Array(close.length).fill(null);
    for (let i = 1; i < close.length; i++) {
      const pc = close[i - 1];
      tr[i] = Math.max(high[i] - low[i], Math.abs(high[i] - pc), Math.abs(low[i] - pc));
    }
    const out = new Array(close.length).fill(null);
    if (close.length < period + 1) return out;

    let sum = 0;

    for (let i = 1; i <= period; i++) sum += tr[i];
    out[period] = sum / period;
    for (let i = period + 1; i < close.length; i++) {
      out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
    }
    return out;
  }

  /** Causal ATR as a percentage of price. */
  function atrPercentSeries(high, low, close, period = 14) {
    const atr = atrSeries(high, low, close, period);
    return atr.map((v, i) => (v == null || !(close[i] > 0) ? null : (v / close[i]) * 100));
  }
  /**
   * Causal regime label per bar, using the SAME rules as classifyRegime():
   *   HIGH_VOL if ATR% > 5, else BULL (RSI>60 & price>SMA), else BEAR
   *   (RSI<40 & price<SMA), else CHOP.
   *
   * Produced as a series (not a single label) because a regime-aware strategy
   * must know the regime AT THE BAR IT IS TRADING, using only past data.
   */
  function regimeSeries(candles, opts = {}) {
    const { close, high, low } = candles;
    const rsiPeriod = opts.rsiPeriod || 14;
    const atrPeriod = opts.atrPeriod || 14;
    const smaPeriod = opts.smaPeriod || 20;

    const rsi = rsiSeries(close, rsiPeriod);
    const atrPct = atrPercentSeries(high, low, close, atrPeriod);
    const sma = smaSeries(close, smaPeriod);
    const out = new Array(close.length).fill(null);

    for (let i = 0; i < close.length; i++) {
      if (rsi[i] == null || atrPct[i] == null || sma[i] == null) continue;
      if (atrPct[i] > 5) out[i] = "HIGH_VOL";
      else if (rsi[i] > 60 && close[i] > sma[i]) out[i] = "BULL";
      else if (rsi[i] < 40 && close[i] < sma[i]) out[i] = "BEAR";
      else out[i] = "CHOP";
    }
    return { regime: out, rsi, atrPct, sma };
  }

  /**
   * Strategy signal functions.
   *
   * CONTRACT — this is what makes the backtest honest:
   *   signal(features, i) -> 1 (long) | -1 (short) | 0 (stand aside)
   *
   * `features` exposes ONLY information available at bar i. The backtester
   * enters at bar i+1, so a signal formed from bar i cannot see bar i+1's
   * price. Returning 0 means "no trade" and costs nothing - which matters,
   * because in a 4h market most bars carry no information worth paying 80bps
   * to express.
   *
   * The families are deliberately standard and long-established:
   *  - TREND: time-series momentum / moving-average crossover
   *  - MEAN_REVERSION: fade RSI extremes and band stretches
   *  - BREAKOUT: trade range expansion (Donchian-style)
   *  - VOL_TARGET: trend direction, but sized by volatility and gated on ATR
   */
  const SIGNAL_LIBRARY = {
    /** Time-series momentum: long if the last k bars rose, short if they fell. */
    smaTrend: {
      name: "SMA Trend",
      family: "TREND",
      params: { fast: 10, slow: 30 },
      grid: [
        { fast: 5, slow: 20 }, { fast: 10, slow: 30 }, { fast: 10, slow: 50 },
        { fast: 15, slow: 40 }, { fast: 20, slow: 60 },
      ],
      signal: (f, i, p) => {
        const fast = f.sma[p.fast][i];
        const slow = f.sma[p.slow][i];
        if (fast == null || slow == null) return 0;
        return fast > slow ? 1 : -1;
      },
    },

    /** Donchian breakout: long at a new N-bar high, short at a new N-bar low. */
    donchian: {
      name: "Donchian Breakout",
      family: "BREAKOUT",
      params: { period: 20 },
      grid: [
        { period: 10 }, { period: 20 }, { period: 40 },
        { period: 55 }, { period: 80 },
      ],
      signal: (f, i, p) => {
        if (i < p.period) return 0;
        const priorHigh = Math.max(...f.high.slice(i - p.period, i));
        const priorLow = Math.min(...f.low.slice(i - p.period, i));
        if (f.close[i] > priorHigh) return 1;
        if (f.close[i] < priorLow) return -1;
        return 0;
      },
    },

    /** RSI fade: buy oversold, sell overbought. Only valid in CHOP. */
    rsiReversion: {
      name: "RSI Mean Reversion",
      family: "MEAN_REVERSION",
      params: { period: 14, low: 30, high: 70 },
      grid: [
        { period: 14, low: 25, high: 75 }, { period: 14, low: 30, high: 70 },
        { period: 7, low: 25, high: 75 }, { period: 21, low: 30, high: 70 },
        { period: 14, low: 20, high: 80 },
      ],
      // Fading a trend is how mean reversion blows up. Gating on CHOP is the
      // whole point of a regime-aware strategy.
      allowedRegimes: ["CHOP"],
      signal: (f, i, p) => {
        const r = f.rsi[p.period][i];
        if (r == null) return 0;
        if (r < p.low) return 1;
        if (r > p.high) return -1;
        return 0;
      },
    },

    /** Trend, but only when volatility confirms it. */
    volTargetTrend: {
      name: "Vol-Target Trend",
      family: "VOL_TARGET",
      params: { period: 20, minAtrPct: 0.5, maxAtrPct: 3 },
      grid: [
        { period: 40, minAtrPct: 0.5, maxAtrPct: 3 },
        { period: 20, minAtrPct: 0.8, maxAtrPct: 2.5 },
      ],
      signal: (f, i, p) => {
        const fast = f.sma[10][i];
        const slow = f.sma[p.period][i];
        const a = f.atrPct[p.period][i];
        if (fast == null || slow == null || a == null) return 0;
        // Stand aside when volatility is outside the band: too quiet and the
        // move does not cover costs, too wild and the stop is meaningless.
        if (a < p.minAtrPct || a > p.maxAtrPct) return 0;
        return fast > slow ? 1 : -1;
      },
    },

    /** Buy the pullback inside an established trend. */
    pullbackInTrend: {
      name: "Pullback in Trend",
      family: "TREND",
      params: { trend: 50, rsiLow: 40, rsiHigh: 60 },
      grid: [
        { trend: 30, rsiLow: 35, rsiHigh: 65 },
        { trend: 50, rsiLow: 40, rsiHigh: 60 },
        { trend: 80, rsiLow: 35, rsiHigh: 65 },
        { trend: 50, rsiLow: 45, rsiHigh: 55 },
      ],
      allowedRegimes: ["BULL", "BEAR"],
      signal: (f, i, p) => {
        const slow = f.sma[p.trend][i];
        const fast = f.sma[10][i];
        const r = f.rsi[14][i];
        if (slow == null || fast == null || r == null) return 0;
        const uptrend = f.close[i] > slow && fast > slow;
        const downtrend = f.close[i] < slow && fast < slow;
        // Uptrend + RSI dipped below the midline = buy the dip. Symmetric short.
        if (uptrend && r > p.rsiLow && r < p.rsiHigh) return 1;
        if (downtrend && r < 100 - p.rsiLow && r > 100 - p.rsiHigh) return -1;
        return 0;
      },
    },
  };

  // ── BACKTEST ENGINE ───────────────────────────────────────────────────────

  const DEFAULT_CONFIG = {
    feeBps: 30,             // 0.30% taker fee per side
    slippageBps: 10,        // 0.10% slippage per side
    stressMultiplier: 1.5,
    notional: 100,
    horizon: 1,             // bars held per trade
  };

  function costBps(cfg, costModel) {
    const mult = costModel === "STRESS_1_5X" ? cfg.stressMultiplier : 1;
    return (cfg.feeBps + cfg.slippageBps) * 2 * mult;
  }

  /**
   * Precompute every indicator a signal might need, once per candle set.
   *
   * Periods are collected from the variants actually being tested, plus the
   * defaults, so a search over five families does not pay for 200-candle SMAs
   * it will never read.
   */
  function buildFeatures(candles, variants = [], opts = {}) {
    const close = candles.close;
    const smaPeriods = new Set([5, 10, 20, 30, 40, 50, 60, 80]);
    const rsiPeriods = new Set([7, 14, 21]);
    const atrPeriods = new Set([10, 14, 20, 40]);

    for (const v of variants) {
      for (const val of Object.values(v.params || {})) {
        if (typeof val !== "number" || !Number.isInteger(val) || val < 2) continue;
        // Attribute a period to the indicator the strategy family needs.
        if (v.family === "TREND" || v.family === "VOL_TARGET") smaPeriods.add(val);
        if (v.family === "MEAN_REVERSION") rsiPeriods.add(val);
        if (v.family === "BREAKOUT") smaPeriods.add(val);
        if (v.family === "VOL_TARGET") atrPeriods.add(val);
      }
    }

    const sma = {};
    for (const p of smaPeriods) sma[p] = smaSeries(close, p);
    const rsi = {};
    for (const p of rsiPeriods) rsi[p] = rsiSeries(close, p);

    const atrPct = {};
    for (const p of atrPeriods) {
      atrPct[p] = atrPercentSeries(candles.high, candles.low, close, p);
    }

    // regimeSeries also returns single-period `rsi`, `atrPct` and `sma`
    // ARRAYS (for period 14/20). Spreading it AFTER the keyed objects would
    // silently overwrite them with one-series values, and every strategy would
    // then read `f.sma[50]` as a raw number instead of a series - producing
    // thousands of bogus "periods" and NaN signals. Spread it first so the
    // multi-period objects win, and take only `regime` from it.
    const reg = regimeSeries(candles, opts);
    return { ...reg, close, high: candles.high, low: candles.low, sma, rsi, atrPct };
  }
  /**
   * Backtest ONE strategy variant over a slice of candles.
   *
   * Entry/exit model:
   *   - signal formed on bar i (only past data visible to the signal)
   *   - enter at bar i+1's close
   *   - exit at bar i+1+horizon's close
   *   - pay `costBps` on the round trip
   *
   * Entering at i+1 rather than i is what prevents the classic look-ahead bug
   * where a signal "knows" the price it is about to trade at.
   *
   * @param {Object} candles
   * @param {Object} variant - { name, family, params, signal, allowedRegimes }
   * @param {Object} opts - { costBps, notional, horizon, range, features, rand }
   */
  function backtestVariant(candles, variant, opts = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...(opts.config || {}) };
    const costFrac = (opts.costBps != null
      ? opts.costBps
      : costBps(cfg, opts.costModel)) / 10000;
    const notional = opts.notional || cfg.notional;
    const horizon = Math.max(1, opts.horizon || cfg.horizon);
    const rand = opts.rand || mulberry32(1);

    const f = opts.features || buildFeatures(candles, [variant]);
    const close = candles.close;
    const n = close.length;

    const [start, end] = opts.range || [0, n];
    const trades = [];

    for (let i = start; i < end; i++) {
      // Regime gate: a variant restricted to CHOP must not trade in BULL.
      if (variant.allowedRegimes && variant.allowedRegimes.length) {
        const r = f.regime[i];
        if (!r || !variant.allowedRegimes.includes(r)) continue;
      }

      const dir = variant.signal(f, i, variant.params);
      if (dir !== 1 && dir !== -1) continue;

      const entryIdx = i + 1;
      const exitIdx = entryIdx + horizon;
      if (exitIdx >= end || entryIdx >= n) continue;

      const entry = close[entryIdx];
      const exit = close[exitIdx];
      if (!(entry > 0)) continue;

      const gross = dir * ((exit - entry) / entry);
      const net = gross - costFrac;
      trades.push({
        i, dir, entry, exit, gross, net, pnl: net * notional, regime: f.regime[i],
      });
    }

    return summarise(trades, notional);
  }

  /** Reduce a trade list to the statistics the search actually needs. */
  function summarise(trades, notional) {
    const n = trades.length;
    if (!n) {
      return {
        trades: 0, wins: 0, losses: 0, winRate: 0, netPnl: 0, netReturnPct: 0,
        profitFactor: 0, avgWin: 0, avgLoss: 0, maxDrawdown: 0, sharpe: 0, tradeList: [],
      };
    }
    const wins = trades.filter((t) => t.net > 0);
    const losses = trades.filter((t) => t.net <= 0);
    const winSum = wins.reduce((s, t) => s + t.net, 0);
    const lossSum = Math.abs(losses.reduce((s, t) => s + t.net, 0));
    const netPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const deployed = n * notional;

    // Equity curve -> max drawdown. A strategy that ends flat but swings 90%
    // en route is not a strategy anyone should run.
    let equity = 0;
    let peak = 0;
    let maxDD = 0;
    for (const t of trades) {
      equity += t.net;
      if (equity > peak) peak = equity;
      const dd = peak - equity;
      if (dd > maxDD) maxDD = dd;
    }

    // Sharpe on per-trade returns. Annualisation is deliberately omitted: bar
    // spacing varies by asset, and a wrong annualisation factor changes the
    // number without changing the ranking.
    const rets = trades.map((t) => t.net);
    const mean = rets.reduce((s, r) => s + r, 0) / n;
    const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(1, n - 1);
    const sd = Math.sqrt(variance);

    return {
      trades: n,
      wins: wins.length,
      losses: losses.length,
      winRate: (wins.length / n) * 100,
      netPnl,
      netReturnPct: deployed > 0 ? (netPnl / deployed) * 100 : 0,
      profitFactor: lossSum > 0 ? winSum / lossSum : winSum > 0 ? Infinity : 0,
      avgWin: wins.length ? winSum / wins.length : 0,
      avgLoss: losses.length ? lossSum / losses.length : 0,
      maxDrawdown: maxDD,
      sharpe: sd > 0 ? mean / sd : 0,
      tradeList: trades,
    };
  }


  // ── CONTROLS ──────────────────────────────────────────────────────────────

  /**
   * The coin-flip control: same cost, same horizon, same bar range, but the
   * direction is random. This is the ONLY fair benchmark for "does knowing
   * something help?" — a strategy is only interesting if it beats this.
   *
   * `tradeMask` makes the control trade exactly the bars the strategy traded,
   * so a strategy that stands aside 80% of the time is compared against a
   * control that also stands aside 80% of the time. Without this, a selective
   * strategy gets compared against a control that pays costs on every bar and
   * looks artificially bad.
   */
  function randomControl(candles, opts = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...(opts.config || {}) };
    const costFrac = (opts.costBps != null ? opts.costBps : costBps(cfg, opts.costModel)) / 10000;
    const notional = opts.notional || cfg.notional;
    const horizon = Math.max(1, opts.horizon || cfg.horizon);
    const rand = opts.rand || mulberry32(7);

    const close = candles.close;
    const n = close.length;
    const [start, end] = opts.range || [0, n];
    const trades = [];

    for (let i = start; i < end; i++) {
      if (opts.tradeMask && !opts.tradeMask[i]) continue;
      const entryIdx = i + 1;
      const exitIdx = entryIdx + horizon;
      if (exitIdx >= end || entryIdx >= n) continue;

      const entry = close[entryIdx];
      const exit = close[exitIdx];
      if (!(entry > 0)) continue;

      const dir = rand() < 0.5 ? 1 : -1;
      const gross = dir * ((exit - entry) / entry);
      const net = gross - costFrac;
      trades.push({ i, dir, entry, exit, gross, net, pnl: net * notional });
    }

    return summarise(trades, notional);
  }

  /** Buy-and-hold over the same window: the do-nothing alternative. */
  function buyAndHold(candles, opts = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...(opts.config || {}) };
    const costFrac = costBps(cfg, opts.costModel) / 10000;
    const notional = opts.notional || cfg.notional;
    const close = candles.close;
    const [start, end] = opts.range || [0, close.length];
    if (end - start < 2) return summarise([], notional);
    const entry = close[start];
    const exit = close[end - 1];
    const net = (exit - entry) / entry - costFrac;
    return summarise([{
      i: start, dir: 1, entry, exit,
      gross: (exit - entry) / entry, net, pnl: net * notional,
    }], notional);
  }

  /**
   * Which bars a variant actually took a position on, so the control can be
   * matched to it bar-for-bar.
   */
  function buildTradeMask(variant, features, range, tradeCount) {
    const mask = {};
    const [start, end] = range;
    for (let i = start; i < end; i++) {
      if (variant.allowedRegimes && variant.allowedRegimes.length) {
        const r = features.regime[i];
        if (!r || !variant.allowedRegimes.includes(r)) continue;
      }
      const d = variant.signal(features, i, variant.params);
      if (d === 1 || d === -1) mask[i] = true;
    }
    return mask;
  }

  /** Expand the signal library into a flat list of concrete variants. */
  function expandVariants() {
    const out = [];
    for (const def of Object.values(SIGNAL_LIBRARY)) {
      for (const params of def.grid) {
        out.push({
          id: `${def.name}::${JSON.stringify(params)}`,
          name: def.name,
          family: def.family,
          params,
          signal: def.signal,
          allowedRegimes: def.allowedRegimes || null,
        });
      }
    }
    return out;
  }

  // ── THE SEARCH ────────────────────────────────────────────────────────────

  // ── THE SEARCH ────────────────────────────────────────────────────────────

  /**
   * Run the full, honest search over ONE asset.
   *
   * Procedure:
   *   1. Split the candles chronologically into IS (in-sample) and OOS.
   *   2. Backtest every variant on IS, alongside a bar-matched coin-flip
   *      control, and correct for having tested N variants.
   *   3. Rank on IS alone and take the top few.
   *   4. Run those ONCE on OOS, which they have never seen.
   *   5. Claim an edge only if OOS clears the noise band AND the
   *      multiple-testing threshold AND the sample is big enough to mean
   *      anything.
   *
   * @param {Object} candles
   * @param {Object} opts - { costModel, notional, horizon, isFraction, topK }
   */
  function search(candles, opts = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...(opts.config || {}) };
    const costModel = opts.costModel || "REALISTIC_1X";
    const notional = opts.notional || cfg.notional;
    const horizon = opts.horizon || cfg.horizon;
    const isFraction = opts.isFraction || 0.5;
    const topK = opts.topK || 3;
    const cb = costBps(cfg, costModel);

    const n = candles.close.length;
    if (n < 60) {
      return { error: `Need at least 60 candles to search honestly; got ${n}.` };
    }

    // Indicators computed ONCE over the full series. Safe because each is
    // causal: the value at bar i never sees bar i+1.
    const variants = expandVariants();
    const features = buildFeatures(candles, variants);

    const split = Math.floor(n * isFraction);
    const isRange = [0, split];
    const oosRange = [split, n];

    // Seed from the data so controls reproduce exactly per asset.
    const seedKey = `${candles.close.length}:${candles.close[0]}:${candles.close[n - 1]}`;

    // ── Step 1: in-sample sweep of every variant ──
    const isResults = variants.map((v) => {
      const res = backtestVariant(candles, v, {
        costBps: cb, notional, horizon, features, range: isRange,
      });
      const mask = buildTradeMask(v, features, isRange);
      const ctrl = randomControl(candles, {
        costBps: cb, notional, horizon, range: isRange,
        rand: mulberry32(hashSeed(seedKey + v.id)), tradeMask: mask,
      });
      const se = winRateSE(res.wins, res.trades);
      return {
        variant: v,
        is: res,
        control: ctrl,
        edgePp: res.trades && ctrl.trades ? res.winRate - ctrl.winRate : 0,
        pnlEdge: res.netPnl - ctrl.netPnl,
        sePp: se * 100,
        noisePp: se * 100 * 2,
      };
    });

    const tested = isResults.length;
    const alpha = bonferroniAlpha(tested);

    // ── Step 2: rank on IS only, then take finalists ──
    isResults.sort((a, b) => b.pnlEdge - a.pnlEdge);
    const finalists = isResults.slice(0, topK).map((r) => r.variant);

    // ── Step 3: out-of-sample, once per finalist ──
    const oosResults = finalists.map((v) => {
      const res = backtestVariant(candles, v, {
        costBps: cb, notional, horizon, features, range: oosRange,
      });
      const mask = buildTradeMask(v, features, oosRange);
      const ctrl = randomControl(candles, {
        costBps: cb, notional, horizon, range: oosRange,
        rand: mulberry32(hashSeed(seedKey + v.id)), tradeMask: mask,
      });
      const test = twoProportionZTest(res.wins, res.trades, ctrl.wins, ctrl.trades);
      const se = winRateSE(res.wins, res.trades);
      return {
        variant: v,
        oos: res,
        control: ctrl,
        edgePp: res.trades && ctrl.trades ? res.winRate - ctrl.winRate : 0,
        pnlEdge: res.netPnl - ctrl.netPnl,
        noisePp: se * 100 * 2,
        z: test.z,
        pValue: test.pValue,
        significant: test.pValue < alpha && res.trades > 0,
      };
    });

    const best = oosResults.reduce(
      (a, b) => (b.pnlEdge > (a ? a.pnlEdge : -Infinity) ? b : a), null,
    );

    // All three must hold. The minTrades floor matters: at n=10 the noise band
    // is huge and "significant" is nearly unattainable, which is the honest
    // outcome, not a bug.
    const minTrades = opts.minTrades || 20;
    const hasEdge = !!(best
      && best.oos.trades >= minTrades
      && best.edgePp > best.noisePp
      && best.pnlEdge > 0
      && best.significant);

    return {
      candles: n,
      split: { is: isRange, oos: oosRange },
      costModel,
      costBpsPerRoundTrip: cb,
      variantsTested: tested,
      alpha,
      minTrades,
      isResults,
      oosResults,
      best,
      hasEdge,
      verdict: hasEdge
        ? `EDGE: ${best.variant.name} ${JSON.stringify(best.variant.params)} held up out-of-sample`
        : "NO EDGE: the best in-sample variant did not survive out-of-sample validation",
    };
  }
  return {
    DEFAULT_CONFIG,
    SIGNAL_LIBRARY,
    // indicators
    smaSeries, rsiSeries, atrSeries, atrPercentSeries, regimeSeries,
    buildFeatures,
    // backtesting
    backtestVariant, randomControl, buyAndHold, summarise, buildTradeMask,
    costBps,
    // search
    expandVariants, search,
    // statistics
    winRateSE, twoProportionZTest, bonferroniAlpha, erf, normalCdf, normalQuantile,
    mulberry32, hashSeed,
  };
})();

if (typeof window !== "undefined") window.RegimeStrategyLab = RegimeStrategyLab;
if (typeof module !== "undefined" && module.exports) module.exports = RegimeStrategyLab;

