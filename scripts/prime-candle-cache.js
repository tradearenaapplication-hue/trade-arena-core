#!/usr/bin/env node

/**
 * PRIME THE CANDLE CACHE
 * ============================================================================
 * Downloads real OHLC candles for each asset and writes them to
 * data/candle-cache/ so later research runs do not hit CoinGecko's free-tier
 * rate limit.
 *
 * Run this once, or after adding an asset. Then run the strategy search
 * offline as many times as you like:
 *
 *     node scripts/prime-candle-cache.js
 *     node scripts/search-regime-edge.js
 *
 * The free CoinGecko tier allows only a handful of calls per minute and answers
 * HTTP 429 for the rest. Spacing requests out is not optional here - without it
 * a research run silently degrades into "no data", which is easy to misread as
 * "no edge".
 *
 * Exit code 0 = every requested asset is now cached.
 *           1 = at least one asset could not be cached.
 */

const OnchainRegime = require("../crucible-regime.js");

const ASSETS = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const assets = ASSETS.length ? ASSETS : [
  "bitcoin", "ethereum", "solana", "dogecoin", "arbitrum", "pepe",
];
const DAYS = 30;

// CoinGecko's free tier is roughly 5-15 calls/minute. 8s between requests is
// conservative enough to stay under it while still finishing in reasonable time.
const SPACING_MS = 8000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log("=".repeat(64));
  console.log("PRIMING CANDLE CACHE");
  console.log("=".repeat(64));
  console.log(`Assets: ${assets.join(", ")}   Window: ${DAYS} days\n`);

  let failures = 0;
  const cached = [];

  for (let i = 0; i < assets.length; i++) {
    const id = assets[i];
    process.stdout.write(`  [${i + 1}/${assets.length}] ${id.padEnd(10)} ... `);
    try {
      const f = await OnchainRegime.fetchCandles(id, { days: DAYS, fresh: true });
      const first = new Date(f.candles.timestamp[0]).toISOString().slice(0, 10);
      const lastTs = f.candles.timestamp[f.candles.timestamp.length - 1];
      const last = new Date(lastTs).toISOString().slice(0, 10);
      console.log(`${f.candles.close.length} bars  ${f.source}  ${first} -> ${last}`);
      cached.push({ id, bars: f.candles.close.length, source: f.source });
    } catch (e) {
      failures++;
      console.log(`FAILED - ${e.message.slice(0, 60)}`);
    }
    if (i < assets.length - 1) await sleep(SPACING_MS);
  }

  console.log("\n" + "=".repeat(64));
  console.log(`Cached ${cached.length}/${assets.length} assets.`);
  if (failures) {
    console.log(`${failures} failed - likely rate limited. Wait a minute and re-run;`);
    console.log("already-cached assets will be skipped on the next pass.");
  } else {
    console.log("Run: node scripts/search-regime-edge.js");
  }
  console.log("=".repeat(64));
  process.exit(failures === 0 ? 0 : 1);
})();
