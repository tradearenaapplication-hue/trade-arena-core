#!/usr/bin/env node

/**
 * FLASHLOAN ARB LIVE SCAN
 * ============================================================================
 * Runs flashloan arbitrage detection against REAL on-chain quotes from Uniswap
 * v3 on Base, using the production scanner (cross-dex-arb-scanner.js) and the
 * real QuoterV2 contract.
 *
 * This answers a question the docs cannot: **are there live opportunities on
 * Base right now, and if not, what is actually blocking them?**
 *
 * The scanner reports `blockingConstraint` on every rejection, so an empty
 * result is never ambiguous between "no arbitrage exists" and "gas ate it".
 *
 * Usage:
 *   node scripts/scan-flashloan-arb.js
 *   node scripts/scan-flashloan-arb.js --sizes 5000,25000,100000
 *   node scripts/scan-flashloan-arb.js --fees 500,3000
 */

'use strict';

const path = require('path');
require('dotenv').config();

const { ethers } = require('ethers');
const scanner = require(path.join(__dirname, '..', 'cross-dex-arb-scanner.js'));
const { DEFAULT_FLASH_ARB_CONFIG, scanCrossDexFlashArb, calculateFlashLoanArb } = scanner;
const tokenManager = require(path.join(__dirname, '..', 'services', 'TokenManager.js'));
const { FailoverProvider, DEFAULT_ENDPOINTS } = require('./rpc-failover.js');
const { ScanRecorder, buildSnapshot } = require('./scan-recorder.js');
const { AerodromeAdapter } = require('./aerodrome-adapter.js');

const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const RPC = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const SIZES = argOf('--sizes', '10000,50000,100000').split(',').map(Number);
const FEES = argOf('--fees', '500,3000').split(',').map(Number);

// Uniswap v3 QuoterV2 on Base mainnet (same address the engine uses).
//
// TWO DETAILS HERE ARE NOT OPTIONAL, and both were found by the production
// engine first (see services/OnchainExecutionEngine.js getUniswapV3Quote):
//
//   1. NO `view` in the ABI. The deployed contract is non-view; declaring it
//      as view makes ethers use eth_call differently and every quote reverts
//      with "missing revert data".
//   2. FIELD ORDER in the struct is (tokenIn, tokenOut, amountIn, fee,
//      sqrtPriceLimitX96). A struct is encoded positionally, so putting `fee`
//      before `amountIn` sends the wrong calldata and it reverts.
//
//   `ticksCrossed` is a uint32 COUNT, not an array - declaring it uint32[]
//      makes decoding fail with BAD_DATA on otherwise-valid quotes.
const QUOTER = '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a';
const WETH_FOR_PRICE = '0x4200000000000000000000000000000000000006';
const USDC_FOR_PRICE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 ticksCrossed, uint256 gasEstimate)',
];

function whitelisted() {
  return ['USDC', 'WETH', 'WBTC', 'CBBTC', 'PEPE', 'SOL']
    .map((s) => tokenManager.resolveToken(s))
    .filter(Boolean)
    .map((t) => ({ symbol: t.symbol, address: t.address, decimals: t.decimals }));
}

/**
 * Reject any token that is not a real contract on this chain.
 *
 * A checksum-valid address with no code is the most expensive kind of bug in a
 * scanner: it produces plausible-looking rows and silent reverts rather than an
 * error. Two of the six tokens previously configured for this scan were
 * addresses with no code at all, which is why 176 of 187 quotes failed. Any
 * token without code is dropped here, loudly, rather than poisoning every route
 * it appears in.
 */
async function validateTokensOnChain(provider, tokens) {
  const good = [];
  const rejected = [];
  for (const t of tokens) {
    let code = '0x';
    try {
      code = await provider.getCode(t.address);
    } catch (e) {
      rejected.push({ ...t, reason: 'rpc error: ' + (e.shortMessage || e.message) });
      continue;
    }
    const size = code === '0x' ? 0 : (code.length - 2) / 2;
    if (size === 0) {
      rejected.push({ ...t, reason: 'ADDRESS HAS NO CODE ON THIS CHAIN' });
    } else {
      good.push(t);
    }
  }
  return { good, rejected };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry across MULTIPLE endpoints rather than hammering one.
 *
 * The single-endpoint version of this function paced itself to stay under a
 * throttle limit. That was treating the symptom: measured 60-call runs showed
 * every free endpoint serving 60/60 with zero failures, so the limit was never
 * a hard cap - it was endpoint-specific and bursty. Routing to a different
 * provider per failure removes the bottleneck entirely and needs no artificial
 * delay, so a full scan runs at real network speed instead of being throttled
 * to a crawl.
 *
 * A run that still fails is INCONCLUSIVE, never "no opportunity here".
 */
let failover = null;

function initFailover() {
  if (failover) return failover;
  const PUBLIC = new Set(DEFAULT_ENDPOINTS.map((e) => e.url));
  const configured = process.env.BASE_RPC_URL;
  // Only honour an explicit override when it is a DIFFERENT endpoint from the
  // free public ones. A .env that merely points at mainnet.base.org - which is
  // the same slow, throttled endpoint already in the pool - must not collapse
  // the whole list down to it, or "failover" becomes a single provider with a
  // misleading name.
  const endpoints =
    configured && !PUBLIC.has(configured)
      ? [{ name: "configured", url: configured }, ...DEFAULT_ENDPOINTS]
      : DEFAULT_ENDPOINTS;
  failover = new FailoverProvider({ endpoints });
  return failover;
}

async function withRetry(fn, { attempts } = {}) {
  return initFailover().withFailover(fn, attempts ? { attempts } : {});
}

/**
 * Convert a USD budget into a raw token quantity.
 *
 * The previous code did `parseUnits(String(usd), tokenIn.decimals)`, which
 * treats a DOLLAR figure as a TOKEN QUANTITY. For a $10,000 scan size that is
 * 10,000 WETH (a $100,000,000 notional trade) or 10,000 USDC (correct by
 * accident, because USDC is a dollar). Pools cannot fill a $100m order, so
 * almost every quote reverted - 178 of 185 "failures" were this bug rather
 * than a fact about the market.
 *
 * The arithmetic is done in scaled bigints, never floats: 1e18 double maths is
 * only accurate to ~256 tokens, which is a large slice of a small trade.
 */
function usdToRawAmount(usd, decimals, usdPrice) {
  if (!Number.isFinite(usdPrice) || usdPrice <= 0) {
    return { error: 'no USD price known for this token (needed to size a USD budget)' };
  }
  const SCALE = 10n ** 18n;
  const usdScaled = BigInt(Math.round(Number(usd) * 1e6)) * SCALE; // USD at 6dp
  const priceScaled = BigInt(Math.round(usdPrice * 1e6)); // price at 6dp
  if (priceScaled <= 0n) return { error: 'degenerate price' };
  const raw = (usdScaled * 10n ** BigInt(decimals)) / (priceScaled * SCALE);
  if (raw <= 0n) return { error: 'budget rounds to zero tokens' };
  return { raw };
}

/**
 * Real on-chain quote via QuoterV2 staticCall, pinned to one block.
 *
 * `amountIn` may be EITHER a USD budget or an exact token quantity, and the two
 * must not be confused. Conflating them is what made this scan ask for a
 * $100,000,000 notional when it meant $10,000. Callers state which they mean
 * with `mode`:
 *
 *   'usd'  - amountIn is a dollar budget, converted via the token's USD price.
 *   'qty'  - amountIn is already an exact token quantity (the second leg of a
 *            round trip, which receives whatever the first leg produced).
 */
function makeQuoter(quoter, cache, blockTag, usdPrices) {
  return async ({ tokenIn, tokenOut, amountIn, fee, mode = 'usd' }) => {
    const key = `${tokenIn.address}>${tokenOut.address}:${mode}:${amountIn}:${fee}`;
    if (cache.has(key)) return cache.get(key);

    let raw;
    if (mode === 'qty') {
      try {
        raw = ethers.parseUnits(String(amountIn), tokenIn.decimals);
      } catch (e) {
        const r = { error: 'could not encode exact quantity: ' + (e.shortMessage || e.message) };
        cache.set(key, r);
        return r;
      }
    } else {
      const conv = usdToRawAmount(amountIn, tokenIn.decimals, usdPrices[tokenIn.symbol]);
      if (conv.error) {
        const r = { error: conv.error };
        cache.set(key, r);
        return r;
      }
      raw = conv.raw;
    }
    if (!(raw > 0n)) {
      const r = { error: 'amount rounds to zero raw units' };
      cache.set(key, r);
      return r;
    }

    let result;
    const r = await withRetry(() =>
      quoter.quoteExactInputSingle.staticCall(
        {
          tokenIn: tokenIn.address,
          tokenOut: tokenOut.address,
          amountIn: raw,
          fee,
          sqrtPriceLimitX96: 0,
        },
        { blockTag },
      ),
    );
    if (!r.ok) {
      // Distinguish "we were throttled" from "this route does not exist", so a
      // rate-limited run is never mistaken for a market with no opportunities.
      result = { error: 'RPC/quote failed after retries: ' + r.error, inconclusive: true };
      cache.set(key, result);
      return result;
    }
    const [amountOutRaw, , ticksCrossed, gasEstimate] = r.value;
    result = {
      // The realised QUANTITY of tokenIn sent, not the USD label. The caller
      // compares a round trip against what went in, so these must be the same
      // unit. `conv` is undefined in 'qty' mode, so derive it from `raw`.
      amountIn: Number(ethers.formatUnits(raw, tokenIn.decimals)),
      usdBudget: mode === 'usd' ? amountIn : null,
      amountOut: Number(ethers.formatUnits(amountOutRaw, tokenOut.decimals)),
      // QuoterV2 does not expose pool depth or the pre-swap price, so
      // slippage is not observable here. The MEV buffer in the cost model is
      // what covers movement between quote and inclusion - that gap is
      // precisely what makes public-mempool arb fragile, and why any result
      // from this scan is indicative rather than executable.
      slippageUSD: 0,
      ticksCrossed: Number(ticksCrossed),
      gasEstimate: Number(gasEstimate),
      feeTier: fee,
      liquidityUSD: 0,
      timestamp: Date.now(),
    };
    cache.set(key, result);
    return result;
  };
}

/**
 * Derive each token's USD price from the chain itself.
 *
 * WETH/USDC is quoted first, then every other token is priced via WETH. Using an
 * external price API would add a rate limit and a trust dependency to a scanner
 * whose entire purpose is to be trustworthy; a self-consistent on-chain price
 * is enough to size a USD budget, and it comes from the same source as the
 * quotes themselves.
 */
async function fetchUsdPrices(provider, quoter, blockTag, tokens, aeroCrossCheck = null) {
  const WETH = '0x4200000000000000000000000000000000000006';
  const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const prices = {};
  // Price discovery needs the WETH/USDC anchor, so give it extra attempts: a
  // throttle here would abort the whole scan for a reason that has nothing to
  // do with the market.
  const get = async (a, b, amt, fee, attempts = 5) => {
    const r = await withRetry(
      () =>
        quoter.quoteExactInputSingle.staticCall(
          { tokenIn: a, tokenOut: b, amountIn: amt, fee, sqrtPriceLimitX96: 0 },
          { blockTag },
        ),
      { attempts, baseDelayMs: 600 },
    );
    if (!r.ok) throw new Error(r.error);
    return r.value[0];
  };
  // Deliberately SMALL, tradeable sizes. A large order would price in its own
  // slippage and understate the token, which would then oversize every quote.
  const usdcPerWeth = Number(
    ethers.formatUnits(await get(WETH, USDC, ethers.parseEther('1'), 500), 6),
  );
  prices.WETH = usdcPerWeth;
  prices.USDC = 1;
  for (const t of tokens) {
    if (prices[t.symbol] !== undefined) continue;

    // Price with a small probe, then divide back to a per-unit price.
    //
    // The probe size is the whole difficulty. Quoting ONE WHOLE UNIT is wrong
    // in both directions: 1 PEPE is a fraction of a cent and rounds to noise,
    // while 1 WBTC is ~$79,000 and prices in its own market impact, which
    // reported a per-unit price an order of magnitude too low. Starting at
    // 0.01 units and escalating until the notional lands in a sane band gives a
    // price that is simultaneously deep enough to be real and small enough not
    // to move it. Verified on-chain: this reports WBTC ~$79.2k and cbBTC ~$85.9k.
    let price = NaN;
    const unit = 10n ** BigInt(t.decimals);
    const multipliers = [1n, 10n, 100n, 1000n, 10000n]; // 0.01, 0.1, 1, 10, 100 units
    for (const mult of multipliers) {
      const probeRaw = (unit / 100n) * mult;
      if (probeRaw <= 0n) continue;
      try {
        const wethOut = await get(t.address, WETH, probeRaw, 500);
        const wethPerProbe = Number(ethers.formatUnits(wethOut, 18));
        const units = Number(ethers.formatUnits(probeRaw, t.decimals));
        if (!(units > 0) || !(wethPerProbe > 0)) continue;
        const usdNotional = wethPerProbe * usdcPerWeth;
        const candidate = (wethPerProbe / units) * usdcPerWeth;
        // Accept once the probe is worth a few hundred dollars: enough to be
        // meaningful, small enough that impact is negligible.
        if (usdNotional >= 200) {
          price = candidate;
          break;
        }
        // Keep the last computable value as a fallback in case no probe ever
        // reaches the band (a very illiquid token).
        price = candidate;
      } catch (e) {
        // This probe reverted (no pool at this fee, or dust rounds to zero).
        // Try the next size; if all fail the token stays unpriced.
      }
    }
    // Reject implausible results rather than sizing trades on a broken price.
    // A wrong price is worse than no price: it silently over- or under-sizes
    // every quote built from it.
    if (!Number.isFinite(price) || price <= 0 || price > 1e7) price = NaN;

    // ── CROSS-PATH VALIDATION ──────────────────────────────────────────
    // A numeric sanity band is NOT sufficient, and that is a lesson this
    // scanner learned the hard way.
    //
    // Observed on live Base: WBTC priced at $77,996 and cbBTC at $84,438 while
    // WETH was $2,660 — both roughly 30x too high, and both passing every
    // "positive, finite, under 1e7" check. The fee-500 Uniswap pools for these
    // wrappers are near-dead, and QuoterV2 returns a garbage quote from a
    // one-sided pool rather than reverting.
    //
    // The general test is to price the token along TWO independent paths and
    // require agreement:
    //
    //     token -> USDC              (direct)
    //     token -> WETH -> USDC      (the path used above)
    //
    // A wrong price corrupts both legs of the round-trip economics and then
    // lands in the recorded history as fact, so a token whose two paths disagree
    // is dropped rather than trusted.
    if (Number.isFinite(price)) {
      let direct = NaN;
      try {
        const probeRaw = unit / 100n;
        const out = await get(t.address, USDC, probeRaw, 500);
        const units = Number(ethers.formatUnits(probeRaw, t.decimals));
        if (units > 0) direct = Number(ethers.formatUnits(out, 6)) / units;
      } catch (e) {
        direct = NaN; // no direct pair exists; validation is simply unavailable
      }

      if (Number.isFinite(direct) && direct > 0) {
        const ratio = price / direct;
        if (Math.abs(ratio - 1) > 0.2) {
          console.log(
            `  PRICE REJECTED ${t.symbol}: via-WETH $${price.toFixed(2)} vs direct ` +
              `$${direct.toFixed(2)} (${ratio.toFixed(2)}x apart). The fee-500 pool is ` +
              `likely one-sided - QuoterV2 returns garbage instead of reverting.`,
          );
          price = NaN;
        }
      }
    }

    // ── SECOND-VENUE VALIDATION ──────────────────────────────────────
    // The cross-path check above cannot catch a pool that is wrong but
    // CONSISTENTLY wrong, and cbBTC is exactly that case:
    //
    //     cbBTC $84,462   WETH $2,663   =>  31.7 WETH per cbBTC
    //
    // BTC/ETH is ~1.0, so that is a 31x error - yet the cbBTC quote agrees
    // with itself across three order sizes (0.1% spread), across two fee
    // tiers, across two independent pricing paths, AND with an external
    // aggregator. Every self-consistent check passes it.
    //
    // The only remaining independent witness is a different venue. The same
    // principle as the cross-venue arb pass applies to price discovery: one
    // venue cannot confirm its own price. If Aerodrome says a radically
    // different number, one of them is unusable and refusing to guess is the
    // honest move.
    if (Number.isFinite(price) && aeroCrossCheck) {
      try {
        const rawOut = await aeroCrossCheck(t, blockTag);
        if (rawOut && rawOut.units > 0) {
          const aeroPrice = rawOut.usdPerUnit;
          if (Number.isFinite(aeroPrice) && aeroPrice > 0) {
            const ratio = price / aeroPrice;
            if (Math.abs(ratio - 1) > 0.5) {
              console.log(
                `  PRICE REJECTED ${t.symbol}: Uniswap $${price.toFixed(2)} vs ` +
                  `Aerodrome $${aeroPrice.toFixed(2)} (${ratio.toFixed(2)}x apart). ` +
                  `One venue is wrong and self-consistency cannot say which.`,
              );
              price = NaN;
            }
          }
        }
      } catch (e) {
        // No Aerodrome pool for this token - cross-check unavailable, keep the price.
      }
    }

    prices[t.symbol] = price;
  }
  return prices;
}

async function main() {
  // One failover pool for the whole scan. The Quoter's contract object is bound
  // to whichever provider answered last, so the quote path goes through
  // withRetry rather than through a fixed provider - a fixed provider is
  // exactly what rate-limits.
  const fp = initFailover();
  const blockNum = await fp.getBlockNumber();
  const quoter = new ethers.Contract(QUOTER, QUOTER_ABI, fp.endpoints[0].provider);
  const tokens = whitelisted();

  // Drop tokens that are not real contracts before quoting anything.
  const { good, rejected } = await validateTokensOnChain(fp, tokens);
  // Enabled by the --record flag (npm run scan:flash:record). A flag rather
  // than an env var, because inline VAR=x is not valid on Windows.
  const record = args.includes('--record');
  console.log('='.repeat(74));
  console.log('FLASHLOAN ARB LIVE SCAN — Base mainnet, real QuoterV2 quotes');
  console.log('='.repeat(74));
  console.log(`block      : ${blockNum}  (ALL quotes pinned to this block)`);
  console.log(`rpc        : ${fp.endpoints.map((e) => e.name).join(" < ")}`);
  console.log(`tokens     : ${good.map((t) => t.symbol).join(', ')}`);
  if (rejected.length) {
    console.log(`EXCLUDED   : ${rejected.map((t) => `${t.symbol} (${t.reason})`).join('; ')}`);
  }
  console.log(`sizes (USD): ${SIZES.join(', ')}`);
  console.log(`fee tiers  : ${FEES.join(', ')}   (500=0.05%, 3000=0.3%, 10000=1%)`);
  console.log(`cost model : ${(DEFAULT_FLASH_ARB_CONFIG.flashLoanFeeRate * 100).toFixed(2)}% flash fee` +
    ` + $${DEFAULT_FLASH_ARB_CONFIG.gasUSD ?? DEFAULT_FLASH_ARB_CONFIG.defaultGasUSD} gas` +
    ` + $${DEFAULT_FLASH_ARB_CONFIG.mevBufferUSD} MEV buffer`);
  console.log('');

  // Fewer than two usable tokens makes a cross-pair round trip impossible, and
  // that must be a hard stop rather than a quiet "no opportunities found".
  if (good.length < 2) {
    console.log('SCAN ABORTED: fewer than 2 tokens have code on this chain.');
    console.log('A round trip needs two. This is NOT a finding about arbitrage.');
    process.exitCode = 1;
    return;
  }

  const cache = new Map();

  // Price every token on-chain, so a USD budget can be turned into a real
  // token quantity. A token whose price cannot be derived is reported rather
  // than silently sized at a wrong notional.
  let usdPrices = {};
  // Derive each token's USD price from Aerodrome, as an independent witness to the
  // Uniswap-derived price. Passing null disables the check.
  //
  // One venue cannot confirm its own price. This exists because a cbBTC pool on
  // Uniswap was consistently wrong by ~31x while agreeing with itself across
  // sizes, fee tiers and pricing paths - see fetchUsdPrices.
  const aeroPriceProbe = async (token, blockTag) => {
    const adapter = new AerodromeAdapter(fp);
    const probeRaw = (10n ** BigInt(token.decimals)) / 100n; // 0.01 of a unit
    const q = await adapter.quote({
      tokenIn: token,
      tokenOut: { symbol: 'WETH', address: WETH_FOR_PRICE, decimals: 18 },
      rawAmount: probeRaw,
      blockTag,
    });
    if (q.error) throw new Error(q.error);
    const units = Number(ethers.formatUnits(probeRaw, token.decimals));
    const wethOut = Number(ethers.formatUnits(q.amountOut, 18));
    if (!(units > 0)) return null;
    const ethUsd = await (async () => {
      const w = await fp.withFailover((p) => {
        const c = new ethers.Contract(
          QUOTER,
          QUOTER_ABI,
          p,
        );
        return p.call({
          to: QUOTER,
          data: c.interface.encodeFunctionData('quoteExactInputSingle', [
            {
              tokenIn: WETH_FOR_PRICE,
              tokenOut: USDC_FOR_PRICE,
              amountIn: ethers.parseEther('1'),
              fee: 500,
              sqrtPriceLimitX96: 0,
            },
          ]),
          blockTag,
        });
      });
      if (!w.ok) throw new Error(w.error);
      return Number(
        ethers.formatUnits(
          ethers.AbiCoder.defaultAbiCoder().decode(['uint256'], w.value)[0],
          6,
        ),
      );
    })();
    return { units, usdPerUnit: (wethOut / units) * ethUsd };
  };

  try {
    usdPrices = await fetchUsdPrices(fp, quoter, blockNum, good, aeroPriceProbe);
  } catch (e) {
    console.log('FATAL: could not derive on-chain USD prices: ' + (e.shortMessage || e.message));
    console.log('Without them a USD budget cannot be converted to a tradeable size.');
    process.exitCode = 1;
    return;
  }
  console.log('usd prices  : ' +
    Object.entries(usdPrices)
      .map(([s, v]) => `${s}=${Number.isFinite(v) ? '$' + v.toPrecision(6) : 'UNKNOWN'}`)
      .join('  '));
  const priceable = good.filter((t) => Number.isFinite(usdPrices[t.symbol]));
  for (const t of good) {
    if (!Number.isFinite(usdPrices[t.symbol])) {
      console.log(`UNPRICEABLE : ${t.symbol} - no on-chain price at this block, excluded`);
    }
  }
  if (priceable.length < 2) {
    console.log('SCAN ABORTED: fewer than 2 tokens have a derivable USD price.');
    console.log('This is NOT a finding about arbitrage.');
    process.exitCode = 1;
    return;
  }
  console.log('');
  // Scan accumulators. Declared BEFORE the cross-venue pass, which reports
  // into the same tallies - a scan that printed its own results separately
  // could not tell you how much of the market it actually managed to price.
  const found = [];
  const stats = { pairs: 0, ok: 0, failed: 0, inconclusive: 0, grossProfitable: 0 };
  // Why quotes failed, grouped. A bare "176 failed" is useless; the reason
  // tells you whether the market is uninteresting or the scan is broken.
  const failReasons = new Map();

  const quoteProvider = makeQuoter(quoter, cache, blockNum, usdPrices);

  // ── Cross-venue scan: Aerodrome vs Uniswap, same block ────────────────
  //
  // The fee-tier scan below compares two pools on ONE AMM, so any gap it finds
  // is a curve artifact rather than a market dislocation. This pass compares
  // two genuinely independent venues, which is what cross-venue arbitrage
  // actually means.
  //
  // Aerodrome is the venue that matters: it turns its USDC/WETH pool over ~32x
  // per day while Uniswap's sits near idle, so any real dislocation between them
  // should show up here. Measured live: ~40 bps apart on the same block.
  const crossVenue = [];
  if (process.env.SKIP_CROSS_VENUE !== '1') {
    let aero = null;
    try {
      aero = new AerodromeAdapter(fp);
      console.log('cross-venue : Aerodrome vs Uniswap v3 (both pinned to this block)');
    } catch (e) {
      console.log('cross-venue : UNAVAILABLE - ' + (e.message || e));
      aero = null;
    }

    if (aero) {
      // Convert a USD budget to a raw token amount.
      //
      // Returns 0n for a token with no derivable price, which the caller treats
      // as "skip this route". Returning NaN instead would reach parseUnits and
      // throw "The number NaN cannot be converted to a BigInt", aborting the
      // entire scan because of one bad price.
      const rawOf = (t, usd) => {
        const SCALE = 10n ** 18n;
        const price = usdPrices[t.symbol];
        if (!Number.isFinite(price) || price <= 0) return 0n;
        const usdScaled = BigInt(Math.round(Number(usd) * 1e6)) * SCALE;
        const priceScaled = BigInt(Math.round(price * 1e6));
        if (priceScaled <= 0n) return 0n;
        return (usdScaled * 10n ** BigInt(t.decimals)) / (priceScaled * SCALE);
      };

      for (const A of good) {
        for (const B of good) {
          if (A.symbol === B.symbol) continue;
          for (const size of SIZES) {
            const rawIn = rawOf(A, size);
            if (rawIn <= 0n) continue;

            // Leg 1: buy B on Uniswap, sell B back on Aerodrome.
            const uni = await quoteProvider({ tokenIn: A, tokenOut: B, amountIn: size, fee: 500 });
            if (uni.error) {
              stats.failed++;
              failReasons.set(
                `cross ${A.symbol}->${B.symbol} uniswap: ${uni.error}`,
                (failReasons.get(`cross ${A.symbol}->${B.symbol} uniswap: ${uni.error}`) || 0) + 1,
              );
              continue;
            }
            stats.ok++;

            // The second leg spends exactly what the first produced, so it is a
            // quantity, not a dollar budget. Passing a quantity through the USD
            // path would re-price it from scratch and invent an edge - which is
            // exactly how a phantom 11,000% ROI appeared in this scanner before.
            const rawMid = ethers.parseUnits(String(uni.amountOut), B.decimals);

            // Cheap pre-check: if there is no Aerodrome pool for this pair, the
            // quote cannot succeed, and letting it retry across four endpoints
            // with backoff turns a routine miss into a multi-second stall. The
            // scan runs this for every ordered pair, so a slow miss is a slow
            // scan.
            const poolInfo = await aero.getPool(B.address, A.address);
            if (!poolInfo.address) {
              stats.failed++;
              const k = `cross ${B.symbol}->${A.symbol} aerodrome: no pool`;
              failReasons.set(k, (failReasons.get(k) || 0) + 1);
              continue;
            }

            const aeroQ = await aero.quote({
              tokenIn: B, tokenOut: A, rawAmount: rawMid, blockTag: blockNum,
            });
            if (aeroQ.error) {
              stats.failed++;
              failReasons.set(
                `cross ${B.symbol}->${A.symbol} aerodrome: ${aeroQ.error}`,
                (failReasons.get(`cross ${B.symbol}->${A.symbol} aerodrome: ${aeroQ.error}`) || 0) + 1,
              );
              continue;
            }
            stats.ok++;

            const returnedQty = Number(ethers.formatUnits(aeroQ.amountOut, A.decimals));

            // Only price a pair when BOTH sides have a real USD price.
            //
            // `uni.amountOut` is a decimal STRING and parseUnits throws on
            // anything non-numeric, including "NaN". A token whose on-chain
            // price could not be derived is still a real contract and so is
            // still in `good`, so without this guard a single unpriceable pair
            // aborts the whole scan instead of skipping one route.
            const aPrice = usdPrices[A.symbol];
            const bPrice = usdPrices[B.symbol];
            if (!Number.isFinite(aPrice) || !Number.isFinite(bPrice)) {
              const k = `cross ${A.symbol}->${B.symbol}: no USD price for one side`;
              stats.failed++;
              failReasons.set(k, (failReasons.get(k) || 0) + 1);
              continue;
            }

            // Compare in the SAME unit. `uni.amountIn` is the real quantity of
            // A that was sent; `returnedQty` is how much of A came back.
            const sentQty = uni.amountIn;
            if (returnedQty > sentQty) stats.grossProfitable++;

            const borrowedUSD = sentQty * aPrice;
            const midUSD = uni.amountOut * bPrice;
            const returnedUSD = returnedQty * aPrice;

            const economics = calculateFlashLoanArb({
              borrowAmountUSD: borrowedUSD,
              buyQuote: { amountOut: midUSD, slippageUSD: 0 },
              sellQuote: { amountOut: returnedUSD, slippageUSD: 0 },
            });

            crossVenue.push({
              pair: `${A.symbol}/${B.symbol}`,
              size,
              buyVenue: 'uniswap-v3-500',
              sellVenue: 'aerodrome',
              pool: aeroQ.pool,
              grossSpreadBps: borrowedUSD > 0
                ? ((returnedUSD - borrowedUSD) / borrowedUSD) * 10000
                : 0,
              borrowedUSD,
              returnedUSD,
              ...economics,
            });
          }
        }
      }

      crossVenue.sort((a, b) => b.grossSpreadBps - a.grossSpreadBps);
      console.log('');
      console.log(`CROSS-VENUE RESULTS (${crossVenue.length} round trips):`);
      console.log('-'.repeat(74));
      if (!crossVenue.length) {
        console.log('  no cross-venue round trips could be priced');
      } else {
        const widest = crossVenue[0];
        console.log(`  widest gross spread: ${widest.grossSpreadBps.toFixed(1)} bps ` +
          `on ${widest.pair} at $${widest.size}`);
        console.log(`  break-even needs   : ~${(
          (DEFAULT_FLASH_ARB_CONFIG.flashLoanFeeRate * 10000) + 10
        ).toFixed(0)} bps of NET edge (flash premium + fixed costs)`);
        console.log('');
        const viableXV = crossVenue.filter((c) => c.isViable);
        console.log(`  viable after costs : ${viableXV.length}`);
        for (const v of crossVenue.slice(0, 8)) {
          const flag = v.isViable ? 'VIABLE' : (v.grossProfitUSD > 0 ? 'gross+' : '      ');
          console.log(
            `  ${flag}  ${v.pair.padEnd(14)} $${String(v.size).padStart(6)}  ` +
            `spread ${v.grossSpreadBps.toFixed(1).padStart(7)} bps  ` +
            `net $${v.netProfitUSD.toFixed(2).padStart(9)}`,
          );
        }
      }
      console.log('');
    }
  }

  // ── Scan: every ordered pair x size x fee-tier combination ───────────────
  // Iterate the VALIDATED list. Using the unvalidated one is what let two
  // code-less addresses generate hundreds of doomed quotes.
  for (const A of good) {
    for (const B of good) {
      if (A.symbol === B.symbol) continue;
      stats.pairs++;

      for (const size of SIZES) {
        for (const feeIn of FEES) {
          const leg1 = await quoteProvider({ tokenIn: A, tokenOut: B, amountIn: size, fee: feeIn });
          if (leg1.error) {
            // Separate a throttle from a genuinely absent route. Only the
            // former means we do not know what this market looks like.
            if (leg1.inconclusive) stats.inconclusive++;
            else stats.failed++;
            const k = `${A.symbol}->${B.symbol} @${feeIn}: ${leg1.error}`;
            failReasons.set(k, (failReasons.get(k) || 0) + 1);
            continue;
          }
          stats.ok++;

          for (const feeOut of FEES) {
            if (feeOut === feeIn) continue;
            // The second leg spends exactly what the first leg produced. That is
            // a TOKEN QUANTITY, not a dollar budget. Passing it through the USD
            // path would re-price it from scratch and inflate the round trip -
            // which is precisely how a fake 11,000% ROI appeared here.
            const leg2 = await quoteProvider({
              tokenIn: B,
              tokenOut: A,
              amountIn: leg1.amountOut,
              fee: feeOut,
              mode: 'qty',
            });
            if (leg2.error) {
              if (leg2.inconclusive) stats.inconclusive++;
              else stats.failed++;
              const k = `${B.symbol}->${A.symbol} @${feeOut}: ${leg2.error}`;
              failReasons.set(k, (failReasons.get(k) || 0) + 1);
              continue;
            }
            stats.ok++;

            // Compare in the SAME unit. `leg1.amountIn` is the real quantity of
            // A that was sent; `leg2.amountOut` is how much of A came back. The
            // old code compared a token quantity against the USD budget, which
            // is a category error and would report nonsense for every pair.
            const sentQty = leg1.amountIn;
            if (leg2.amountOut > sentQty) stats.grossProfitable++;

            // The cost model is USD-denominated, so feed it USD on both sides.
            // calculateFlashLoanArb treats buyQuote/sellQuote amountOut as USD,
            // so the intermediate token value is converted via its own price.
            const borrowedUSD = sentQty * usdPrices[A.symbol];
            const midUSD = leg1.amountOut * usdPrices[B.symbol];
            const returnedUSD = leg2.amountOut * usdPrices[A.symbol];

            const economics = calculateFlashLoanArb({
              borrowAmountUSD: borrowedUSD,
              buyQuote: { amountOut: midUSD, slippageUSD: 0 },
              sellQuote: { amountOut: returnedUSD, slippageUSD: 0 },
            });
            economics.borrowedUSD = borrowedUSD;
            economics.returnedUSD = returnedUSD;
            economics.sentQty = sentQty;
            economics.returnedQty = leg2.amountOut;

            found.push({
              pair: `${A.symbol}/${B.symbol}`, size, feeIn, feeOut,
              out: leg2.amountOut, ...economics,
            });
          }
        }
      }
    }
  }

  const viable = found.filter((f) => f.isViable).sort((a, b) => b.netProfitUSD - a.netProfitUSD);
  const gross = found.filter((f) => f.grossProfitUSD > 0)
    .sort((a, b) => b.grossProfitUSD - a.grossProfitUSD);

  console.log(`Scanned ${stats.pairs} pairs x ${SIZES.length} sizes x ${FEES.length} tiers`);
  console.log(`Quotes: ${stats.ok} succeeded, ${stats.failed} failed`);
  console.log(`Round trips returning MORE than borrowed (before costs): ${stats.grossProfitable}/${found.length}`);
  console.log('');

  if (stats.failed > 0) {
    console.log(`WHY QUOTES FAILED (${stats.failed} total, grouped):`);
    const top = [...failReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    for (const [reason, n] of top) console.log(`   ${String(n).padStart(4)}x  ${reason}`);
    console.log('');
  }

  // A scan that could barely quote anything is not evidence about the market.
  // Saying "no opportunity" off a 5% success rate would be dishonest, so this
  // states the coverage explicitly and refuses to imply a conclusion it cannot
  // support.
  //
  // `inconclusive` MUST be in the denominator. A throttled quote is an attempt
  // that did not produce an answer, so excluding it inflates the coverage
  // figure and would let a badly-throttled run read as a clean negative.
  const totalAttempts = stats.ok + stats.failed + stats.inconclusive;
  const coverage = totalAttempts > 0 ? stats.ok / totalAttempts : 0;
  console.log(`COVERAGE: ${(coverage * 100).toFixed(1)}% of quotes succeeded` +
    ` (${stats.ok}/${totalAttempts}` +
    (stats.inconclusive ? `, ${stats.inconclusive} throttled` : '') + ')');
  if (coverage < 0.5) {
    console.log('');
    console.log('!! COVERAGE BELOW 50%. This result is NOT a finding about arbitrage.');
    console.log('!! Most routes could not be priced. Fix the quote failures above before');
    console.log('!! reading anything into the absence of opportunities.');
    console.log('');
  }

  // ── Record to history ────────────────────────────────────────────────
  // Recorded for EVERY run, including inconclusive ones, and flagged as such.
  // Excluding them would silently bias the dataset toward runs that happened
  if (record) {
    // `best` falls back to the top gross route so that "closest to viable" is
    // visible in history, not just clean wins. A dataset that only ever records
    // successes cannot tell you how close the market came.
    const snapshot = buildSnapshot({
      blockNumber: blockNum,
      tokens: good.map((t) => t.symbol),
      usdPrices,
      sizes: SIZES,
      feeTiers: FEES,
      stats,
      best: viable[0] || gross[0] || null,
      viable,
      endpoints: fp.status().map((e) => ({
        name: e.name,
        failures: e.failures,
        benched: e.benched,
      })),
      scanner: {
        flashFeeRate: DEFAULT_FLASH_ARB_CONFIG.flashLoanFeeRate,
        gasUSD: DEFAULT_FLASH_ARB_CONFIG.gasUSD ?? DEFAULT_FLASH_ARB_CONFIG.defaultGasUSD,
        mevBufferUSD: DEFAULT_FLASH_ARB_CONFIG.mevBufferUSD,
        minNetProfitUSD: DEFAULT_FLASH_ARB_CONFIG.minNetProfitUSD,
        // Record what was ACTUALLY scanned, not what was originally intended.
        // A history that labels cross-venue runs as fee-tier-only would
        // misrepresent what the dataset can support conclusions about.
        venues: process.env.SKIP_CROSS_VENUE === '1'
          ? 'uniswap-v3-fee-tiers-only'
          : 'uniswap-v3-fee-tiers+aerodrome-cross-venue',
        crossVenueRoundTrips: crossVenue.length,
        crossVenueViable: crossVenue.filter((c) => c.isViable).length,
        widestCrossVenueSpreadBps: crossVenue.length
          ? Number(crossVenue[0].grossSpreadBps.toFixed(2))
          : null,
      },
    });
    const res = new ScanRecorder().record(snapshot);
    console.log(res.ok
      ? `RECORDED  : data/scan-history.jsonl (${res.bytes} bytes, conclusive=${snapshot.conclusive})`
      : `RECORD FAILED: ${res.reason}`);
    console.log('');
  }

  if (viable.length) {
    console.log('VIABLE OPPORTUNITIES (net of flash fee, gas and MEV buffer)');
    console.log('-'.repeat(74));
    for (const v of viable.slice(0, 15)) {
      console.log(`  ${v.pair.padEnd(14)} $${String(v.size).padStart(7)}  tiers ${v.feeIn}/${v.feeOut}  ` +
        `net $${v.netProfitUSD.toFixed(2)}  ROI ${(v.roi * 100).toFixed(4)}%`);
    }
    console.log('');
    console.log('These are INDICATIVE, not executable: QuoterV2 quotes are not atomic, and');
    console.log('by the time a tx lands the spread is typically gone. See the note below.');
    return 0;
  }

  console.log('NO VIABLE OPPORTUNITY. Blocking constraints, ranked by frequency:');
  console.log('-'.repeat(74));

  const reasons = {};
  for (const f of found) {
    const key = f.blockingConstraint || 'VIABLE';
    reasons[key] = (reasons[key] || 0) + 1;
  }
  for (const [reason, count] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(5)} x  ${reason}`);
  }
  console.log('');

  if (gross.length) {
    const b = gross[0];
    console.log(`Best gross-profitable route: ${b.pair} $${b.size} tiers ${b.feeIn}/${b.feeOut}`);
    console.log(`  gross +$${b.grossProfitUSD.toFixed(2)}  ->  net ${b.netProfitUSD.toFixed(2)} after ` +
      `fee $${b.flashLoanFeeUSD.toFixed(2)} + gas $${b.gasUSD.toFixed(2)} + MEV $${b.mevBufferUSD.toFixed(2)}`);
    console.log('');
    console.log('Profitable GROSS but not NET means the spread exists yet is smaller than the');
    console.log('fixed costs. That is the expected steady state on Base at retail size.');
  } else {
    console.log('No route returned more than it borrowed, even before costs.');
    console.log('The fee tiers were not mispriced at these sizes at this instant, which is');
    console.log('the normal state on a deep, heavily-arbitraged venue.');
  }

  console.log('');
  console.log('LIMITS OF THIS SCAN (read before acting on anything above):');
  console.log('  - Every quote in one run is pinned to a SINGLE block, so the two legs');
  console.log('    of a route are priced against the same market state. That removes the');
  console.log('    self-inflicted error of a round trip spanning two different heads.');
  console.log('  - It does NOT make the scan executable. By the time your transaction is');
  console.log('    mined, the state has moved, and a public-mempool submission lets a');
  console.log('    searcher see it and back-run it first.');
  console.log('  - Compares Uniswap v3 FEE TIERS on ONE venue. Real cross-venue arb needs');
  console.log('    a second DEX (SushiSwap, Aerodrome) quoted in the same block.');
  console.log('  - QuoterV2 does not expose pool depth, so the liquidity gate never runs.');
  console.log('  - The cost model has NO pool-fee term. Venue fees must already be netted');
  console.log('    out of the quote, or every route looks better than it is.');
  console.log('  - Public-mempool submission means a searcher sees your tx first and');
  console.log('    back-runs it. Private order flow (Flashbots Protect, MEV Blocker) or a');
  console.log('    direct validator bundle is required, and that changes who can compete.');
  return 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((e) => { console.error('SCAN FAILED:', e.message); process.exitCode = 1; });
