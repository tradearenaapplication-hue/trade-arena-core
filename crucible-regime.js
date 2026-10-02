/**
 * ON-CHAIN REGIME ANALYTICS
 * ============================================================================
 * Derives BULL / BEAR / CHOP / HIGH_VOL from REAL market candles instead of
 * hardcoded win-rate constants.
 *
 * WHY THIS FILE EXISTS
 * The Crucible V2 panel used to call `simulateCrucibleV2Results()`, which
 * returned literal numbers from a table:
 *
 *     BULL: { winRate: 0.65, pnlPerTrade: 15 }
 *     BEAR: { winRate: 0.45, pnlPerTrade: 5  }
 *     ...
 *
 * Nothing was measured. Changing the regime selector changed nothing, because
 * `runCrucibleV2Batch()` read the button id with `.replace('regime','')`, which
 * yields "Bull"/"Bear"/"Chop"/"HighVol" - none of which match those keys - so
 * every run fell through to `baseStats.BULL`. The panel reported a BULL result
 * no matter what was selected.
 *
 * WHAT THIS DOES INSTEAD
 * 1. Fetches real OHLC candles from CoinGecko's public endpoints.
 * 2. Derives RSI(14), ATR%(14) and SMA(20) from those candles only.
 * 3. Classifies the regime with classifyRegime() from crucible-test.js.
 * 4. Backtests a directional strategy over those SAME real candles, charging a
 *    realistic fee + slippage per side, and compares it against honest
 *    baselines (buy-and-hold, short-and-hold, momentum and a coin-flip).
 *
 * Every number the UI shows therefore traces back to a price that traded.
 *
 * DATA PROVENANCE
 * CoinGecko aggregates on-chain DEX and centralized-exchange prices. It is the
 * same source index.html's getLivePrice()/getMarketData() already use, so the
 * regime shown here is consistent with the prices the bots actually trade at.
 * To use strictly single-venue DEX data, pass a different `fetchImpl`/candle
 * source to backtestRegime() - nothing below is CoinGecko specific.
 *
 * Works in the browser (fetch) and in Node >= 18 (global fetch). No imports.
 */

const OnchainRegime = (() => {
  "use strict";

  // ── CONFIG ────────────────────────────────────────────────────────────────

  const DEFAULT_CONFIG = {
    feeBps: 30,            // 0.30% taker fee per side (Uniswap v3 0.3% tier)
    slippageBps: 10,       // 0.10% execution slippage per side
    stressMultiplier: 1.5, // STRESS_1_5X scales all costs by this
    minCandles: 30,        // below this a regime read is not trustworthy
  };

  const CG_BASE = "https://api.coingecko.com/api/v3";

  // ── CANDLE CACHE ──────────────────────────────────────────────────────────
  //
  // The free CoinGecko tier allows only a handful of calls per minute and
  // answers 429 for the rest. Strategy research needs dozens of fetches, so
  // every successful response is cached on disk and reused.
  //
  // This is a correctness measure, not just a speed one: without it, a retry
  // storm silently degrades a research run into "no data", and it is easy to
  // mistake rate-limiting for "this asset has no edge".

  const CACHE_DIR = (() => {
    if (typeof process !== "undefined" && process.env.TA_CACHE_DIR) return process.env.TA_CACHE_DIR;
    if (typeof require === "function") {
      try { return require("path").join(__dirname, "data", "candle-cache"); }
      catch (_) { /* browser or bundler */ }
    }
    return null;
  })();

  const memoryCache = new Map();

  function cacheKey(id, days) {
    return `${id}_${days}d`;
  }

  function readCache(id, days) {
    const key = cacheKey(id, days);
    if (memoryCache.has(key)) return memoryCache.get(key);

    // Node: persist to disk so the cache survives between runs.
    if (CACHE_DIR && typeof require === "function") {
      try {
        const fs = require("fs");
        const p = require("path");
        const file = p.join(CACHE_DIR, cacheKey(id, days) + ".json");
        if (fs.existsSync(file)) {
          const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
          if (parsed && parsed.candles) {
            memoryCache.set(key, parsed);
            return parsed;
          }
        }
      } catch (_) { /* cache is best-effort */ }
    }
    return null;
  }

  function writeCache(id, days, entry) {
    const key = cacheKey(id, days);
    memoryCache.set(key, entry);
    if (!CACHE_DIR || typeof require !== "function") return;
    try {
      const fs = require("fs");
      const p = require("path");
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(
        p.join(CACHE_DIR, cacheKey(id, days) + ".json"),
        JSON.stringify(entry),
      );
    } catch (_) { /* cache is best-effort */ }
  }

  /** CoinGecko's optional key, sent as `x-cg-pro-api-key` when present. */
  function cgHeaders() {
    const key = (typeof process !== "undefined" && process.env.COIN_GECKO_API_KEY) || "";
    return key ? { "x-cg-pro-api-key": key } : {};
  }


  // ── OHLC FETCHING ────────────────────────────────────────────────────────

  /**
   * Derive synthetic high/low candles from a close-only price series.
   *
   * CoinGecko's free /coins/{id}/ohlc endpoint is frequently rate limited (it
   * returns HTTP 429), while /coins/{id}/market_chart is far more permissive.
   * market_chart gives only closes, so this reconstructs a conservative bar:
   *
   *   high[i] = max(close[i], close[i-1])
   *   low[i]  = min(close[i], close[i-1])
   *
   * This UNDERSTATES intrabar range, so ATR computed from it is conservative -
   * it will not manufacture a HIGH_VOL reading out of nothing. Every bar is
   * still a real traded price.
   *
   * @param {Array<[number, number]>} points - [timestampMs, price] pairs
   */
  function candlesFromCloses(points) {
    const rows = (points || [])
      .map((p) => ({ t: Number(p[0]), c: Number(p[1]) }))
      .filter((r) => Number.isFinite(r.t) && Number.isFinite(r.c) && r.c > 0)
      .sort((a, b) => a.t - b.t);

    const close = [];
    const high = [];
    const low = [];
    const timestamp = [];

    for (let i = 0; i < rows.length; i++) {
      const c = rows[i].c;
      const prev = i > 0 ? rows[i - 1].c : c;
      close.push(c);
      high.push(Math.max(c, prev));
      low.push(Math.min(c, prev));
      timestamp.push(rows[i].t);
    }

    return { open: close.slice(), high, low, close, timestamp };
  }

  /**
   * Normalise a CoinGecko /ohlc response ([t, o, h, l, c]) into our shape.
   * Kept separate so callers can pass true high/low bars when reachable.
   */
  function candlesFromOhlc(rows) {
    const clean = (rows || []).filter(
      (r) => Array.isArray(r) && Number.isFinite(Number(r[4])) && Number(r[4]) > 0,
    );
    return {
      open: clean.map((r) => Number(r[1])),
      high: clean.map((r) => Number(r[2])),
      low: clean.map((r) => Number(r[3])),
      close: clean.map((r) => Number(r[4])),
      timestamp: clean.map((r) => Number(r[0])),
    };
  }


  /**
   * Fetch real candles for a CoinGecko coin id.
   *
   * Tries /ohlc first (true high/low bars); on 429 or any failure it degrades
   * to /market_chart, which returns closes only. Both are real traded prices.
   *
   * @param {string} id - CoinGecko id, e.g. "bitcoin"
   * @param {Object} [opts] - { days = 30, fetchImpl, minCandles }
   * @returns {Promise<{candles:Object, source:string, degraded:boolean}>}
   */
  async function fetchCandles(id, opts = {}) {
    const days = opts.days || 30;
    const doFetch = opts.fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
    if (!doFetch) throw new Error("No fetch implementation available");
    const min = opts.minCandles || DEFAULT_CONFIG.minCandles;

    // Serve from cache unless the caller explicitly wants fresh data.
    if (opts.fresh !== true) {
      const hit = readCache(id, days);
      if (hit) return { ...hit, fromCache: true };
    }

    const headers = cgHeaders();

    // Try real OHLC bars first.
    try {
      const res = await doFetch(`${CG_BASE}/coins/${id}/ohlc?vs_currency=usd&days=${days}`, { headers });
      if (res.ok) {
        const rows = await res.json();
        const candles = Array.isArray(rows) ? candlesFromOhlc(rows) : null;
        if (candles && candles.close.length >= min) {
          const entry = { candles, source: "coingecko:ohlc", degraded: false, fromCache: false };
          writeCache(id, days, entry);
          return entry;
        }
      }
    } catch (_) {
      // fall through to the closes-only endpoint
    }

    // Fallback: hourly closes, reconstructed into conservative bars.
    try {
      const res = await doFetch(
        `${CG_BASE}/coins/${id}/market_chart?vs_currency=usd&days=${days}`,
        { headers },
      );
      if (res.ok) {
        const data = await res.json();
        const candles = data && Array.isArray(data.prices)
          ? candlesFromCloses(data.prices)
          : null;
        if (candles && candles.close.length >= min) {
          const entry = { candles, source: "coingecko:market_chart", degraded: true, fromCache: false };
          writeCache(id, days, entry);
          return entry;
        }
      }
    } catch (_) {
      // fall through to the throw below
    }

    throw new Error(
      `Could not fetch real market data for "${id}". The Crucible panel will not ` +
      "display a number it cannot source from real prices. CoinGecko may be " +
      "rate limiting; retry shortly or configure a COIN_GECKO_API_KEY.",
    );
  }


  // ── INDICATORS + REGIME CLASSIFICATION ────────────────────────────────────

  /**
   * classifyRegime() lives in crucible-test.js and is loaded in the browser.
   * Re-declared ONLY as a fallback so this module stands alone in Node.
   */
  const localClassifyRegime = (rsi, atrPercent, price, sma) => {
    if (atrPercent > 5) return "HIGH_VOL";
    if (rsi > 60 && price > sma) return "BULL";
    if (rsi < 40 && price < sma) return "BEAR";
    return "CHOP";
  };

  const globalScope = () => (typeof globalThis !== "undefined" ? globalThis : {});
  const getClassifier = () => {
    const g = globalScope();
    return typeof g.classifyRegime === "function" ? g.classifyRegime : localClassifyRegime;
  };
  const getIndicatorBuilder = () => {
    const g = globalScope();
    return typeof g.buildIndicators === "function" ? g.buildIndicators : null;
  };

  // Wilder RSI - identical maths to crucible-test.js's calculateRSI.
  function rsiFallback(closes, period = 14) {
    if (closes.length < period + 1) return 50;
    let gains = 0;
    let losses = 0;
    for (let i = 1; i <= period; i++) {
      const ch = closes[i] - closes[i - 1];
      if (ch > 0) gains += ch;
      else losses -= ch;
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;
    for (let i = period + 1; i < closes.length; i++) {
      const ch = closes[i] - closes[i - 1];
      avgGain = (avgGain * (period - 1) + (ch > 0 ? ch : 0)) / period;
      avgLoss = (avgLoss * (period - 1) + (ch < 0 ? -ch : 0)) / period;
    }
    if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
    return 100 - 100 / (1 + avgGain / avgLoss);
  }

  // Windowed ATR - averages over the last `period` bars only.
  function atrFallback(highs, lows, closes, period = 14) {
    const len = closes.length;
    if (len < 2 || period < 1) return 0;
    const win = Math.min(period, len - 1);
    let sum = 0;
    for (let i = len - win; i < len; i++) {
      const pc = closes[i - 1];
      sum += Math.max(highs[i] - lows[i], Math.abs(highs[i] - pc), Math.abs(lows[i] - pc));
    }
    const last = closes[len - 1];
    return last > 0 ? (sum / win / last) * 100 : 0;
  }

  function smaFallback(prices, period = 20) {
    const len = prices.length;
    if (!len) return 0;
    if (len < period) return prices[len - 1];
    let sum = 0;
    for (let i = len - period; i < len; i++) sum += prices[i];
    return sum / period;
  }

  function localIndicators(candles) {
    const { close, high, low } = candles;
    const price = close[close.length - 1];
    const sma = smaFallback(close, 20);
    return {
      price,
      rsi: rsiFallback(close, 14),
      atrPercent: atrFallback(high, low, close, 14),
      sma,
      // Distance from the SMA in percent: a secondary confirmation the UI can
      // use to tell a genuine trend apart from a single spike.
      trend: ((price - sma) / price) * 100,
    };
  }

  /**
   * Classify a candle set. Returns the regime plus the exact inputs that
   * produced it, so the panel can show its work instead of asserting a label.
   */
  function classifyCandles(candles) {
    const builder = getIndicatorBuilder();
    const ind = builder ? builder(candles) : localIndicators(candles);
    if (!ind) throw new Error("Not enough candles to classify a regime");
    const regime = getClassifier()(ind.rsi, ind.atrPercent, ind.price, ind.sma);
    return {
      regime,
      indicators: ind,
      candles: candles.close.length,
      firstTimestamp: candles.timestamp[0] || null,
      lastTimestamp: candles.timestamp[candles.timestamp.length - 1] || null,
    };
  }

  // ── BACKTEST ──────────────────────────────────────────────────────────────

  /**
   * Per-trade round-trip cost in basis points.
   * Charged on BOTH the entry and the exit, hence doubled - matching how the
   * arena charges costs in index.html's cost model.
   */
  function costBps(cfg, costModel) {
    const mult = costModel === "STRESS_1_5X" ? cfg.stressMultiplier : 1;
    return (cfg.feeBps + cfg.slippageBps) * 2 * mult;
  }

  /**
   * Deterministic PRNG (mulberry32).
   *
   * A fixed seed makes the random baseline reproducible: re-running the same
   * backtest on the same candles gives the same numbers, so a change in the
   * result always means a change in the data or the logic, never a fresh dice
   * roll.
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

  /**
   * Run one directional strategy over real closes and report honest stats.
   *
   * @param {Object} candles
   * @param {Object} opts - { direction: 'long'|'short'|'random'|'momentum', horizon, costBps, notional, rand }
   */
  function backtestStrategy(candles, opts) {
    const close = candles.close;
    const horizon = Math.max(1, opts.horizon || 1);
    const costFrac = (opts.costBps || 0) / 10000;
    const notional = opts.notional || 100;
    const rand = opts.rand || mulberry32(12345);

    const trades = [];
    // Start at `horizon` so every trade has a real entry price to compare to.
    for (let i = horizon; i < close.length; i++) {
      const entry = close[i - horizon];
      const exit = close[i];
      if (!(entry > 0)) continue;

      let direction;
      if (opts.direction === "long") direction = 1;
      else if (opts.direction === "short") direction = -1;
      else if (opts.direction === "momentum") direction = close[i - 1] > close[i - 2] ? 1 : -1;
      else direction = rand() < 0.5 ? 1 : -1;

      const gross = direction * ((exit - entry) / entry);
      // Cost is paid regardless of direction and regardless of outcome.
      const net = gross - costFrac;
      trades.push({ i, direction, gross, net, pnl: net * notional });
    }

    const wins = trades.filter((t) => t.net > 0);
    const losses = trades.filter((t) => t.net <= 0);
    const winSum = wins.reduce((s, t) => s + t.net, 0);
    const lossSum = Math.abs(losses.reduce((s, t) => s + t.net, 0));
    const netPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const deployed = trades.length * notional;

    return {
      direction: opts.direction,
      trades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
      netPnl,
      netReturnPct: deployed > 0 ? (netPnl / deployed) * 100 : 0,
      // Profit factor is undefined with zero losses; Infinity is the honest
      // answer and the UI renders it as "n/a".
      profitFactor: lossSum > 0 ? winSum / lossSum : winSum > 0 ? Infinity : 0,
      avgWin: wins.length ? winSum / wins.length : 0,
      avgLoss: losses.length ? lossSum / losses.length : 0,
    };
  }

  /**
   * Full Crucible regime backtest over REAL candles.
   *
   * `requestedRegime` selects the DIRECTION BIAS to test, because you cannot
   * manufacture a bull market that did not happen. We report the regime the
   * data actually shows, and when that differs from the button the user
   * pressed we flag it (`regimeMismatch`) rather than quietly relabelling the
   * data to match the click.
   *
   * @param {Object} candles - real OHLC candles
   * @param {Object} [opts] - { requestedRegime, costModel, notional, horizon, config }
   */
  function backtestRegime(candles, opts = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...(opts.config || {}) };
    const costModel = opts.costModel || "REALISTIC_1X";
    const notional = opts.notional || 100;
    const horizon = Math.max(1, opts.horizon || 1);

    const detected = classifyCandles(candles);
    const requested = opts.requestedRegime || null;

    // Map a regime onto the directional bias that is actually testable.
    const biasFor = (regime) => {
      switch (regime) {
        case "BULL": return "long";
        case "BEAR": return "short";
        default: return "random"; // CHOP / HIGH_VOL have no persistent direction
      }
    };

    const cBps = costBps(cfg, costModel);
    // Seed from the data itself so the same candles always reproduce the same
    // control, while a different market produces a different sample.
    const seedKey =
      `${candles.close.length}:${candles.close[0]}:${candles.close[candles.close.length - 1]}`;

    const primary = backtestStrategy(candles, {
      direction: biasFor(requested || detected.regime),
      horizon,
      costBps: cBps,
      notional,
      rand: mulberry32(hashSeed(seedKey + ":primary")),
    });

    // Buy/short-and-hold span the entire window (one single trade).
    const fullWindow = Math.max(1, candles.close.length - 1);
    const baselines = {
      buyAndHold: backtestStrategy(candles, {
        direction: "long", horizon: fullWindow, costBps: cBps, notional,
      }),
      shortAndHold: backtestStrategy(candles, {
        direction: "short", horizon: fullWindow, costBps: cBps, notional,
      }),
      // Same trade count and same costs as the strategy - the ONLY difference
      // is that direction is a coin flip. This is the fair control.
      random: backtestStrategy(candles, {
        direction: "random", horizon, costBps: cBps, notional,
        rand: mulberry32(hashSeed(seedKey + ":baseline")),
      }),
      momentum: backtestStrategy(candles, {
        direction: "momentum", horizon, costBps: cBps, notional,
      }),
    };

    // A real edge must beat the coin-flip control by more than the sampling
    // noise on n samples: 2/sqrt(n) is the standard-error band.
    const noiseBandPct = primary.trades ? (2 / Math.sqrt(primary.trades)) * 100 : 0;
    const winRateEdge = primary.winRate - baselines.random.winRate;
    const beatsRandom = primary.netPnl > baselines.random.netPnl;
    const edgeSignificant = beatsRandom && winRateEdge > noiseBandPct;

    return {
      detectedRegime: detected.regime,
      requestedRegime: requested,
      // True when the user asked for a regime the real data does not show.
      regimeMismatch: !!requested && requested !== detected.regime,
      indicators: detected.indicators,
      candles: detected.candles,
      window: { from: detected.firstTimestamp, to: detected.lastTimestamp },
      costModel,
      costBpsPerRoundTrip: cBps,
      notional,
      strategy: primary,
      baselines,
      beatsRandom,
      edgeSignificant,
      noiseBandPct,
      winRateEdgePct: winRateEdge,
    };
  }

  return {
    DEFAULT_CONFIG,
    candlesFromCloses,
    candlesFromOhlc,
    fetchCandles,
    classifyCandles,
    backtestStrategy,
    backtestRegime,
    costBps,
    mulberry32,
    hashSeed,
  };
})();

// Browser + Node export.
if (typeof window !== "undefined") window.OnchainRegime = OnchainRegime;
if (typeof module !== "undefined" && module.exports) module.exports = OnchainRegime;
