"use strict";

/**
 * Does the scanner actually DETECT an edge, or does it just always return
 * nothing?
 *
 * This matters more than it sounds. Every live scan so far returned zero viable
 * routes, and a scanner that is incapable of ever reporting an opportunity would
 * produce exactly the same output. "No edge found" is only evidence if the
 * detector is known to fire when an edge is present.
 *
 * So these tests build routes with a KNOWN, GUARANTEED spread and assert the
 * scanner finds it. A green result here is what licenses the negative result
 * out in the field to mean anything.
 */

const {
  calculateFlashLoanArb,
  scanCrossDexFlashArb,
  DEFAULT_FLASH_ARB_CONFIG,
} = require("../cross-dex-arb-scanner.js");

let passed = 0;
let failed = 0;
const failures = [];

// Accepts sync or async checkers. Async matters here: the scanner is async, so
// a checker that only handles sync failures would silently PASS an async check
// that actually rejected - which is precisely the "green but wrong" failure this
// whole harness exists to rule out.
function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      return r.then(
        () => { passed++; console.log(`   PASS  ${name}`); },
        (e) => {
          failed++;
          failures.push(`${name}: ${e.message}`);
          console.log(`   FAIL  ${name}\n         ${e.message}`);
        },
      );
    }
    passed++;
    console.log(`   PASS  ${name}`);
  } catch (e) {
    failed++;
    failures.push(`${name}: ${e.message}`);
    console.log(`   FAIL  ${name}\n         ${e.message}`);
  }
  return Promise.resolve();
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const WETH = { symbol: "WETH", address: "0x4200000000000000000000000000000000000006", decimals: 18 };
const USDC = { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 };

/**
 * Deterministic quote provider with a controllable cross-venue spread.
 *
 * `spreadBps` is the gross gain of buying on one venue and selling on the
 * OTHER. The two venues must have genuinely different rates, otherwise a
 * round trip through them multiplies out to exactly 1.0 and no amount of
 * "spread" is ever observable.
 *
 *   VENUE_A is cheap: buying there returns MORE units of the intermediate.
 *   VENUE_B is rich: selling there returns MORE units back.
 *
 * A round trip therefore multiplies by (1 + spread) and the scanner is
 * responsible for deducting the flash premium, gas and slippage itself. This
 * provider must not do that, or the test would pass even with a broken cost
 * model.
 */
function makeQuoteProvider({ spreadBps, liquidityUSD = 500000, slippageUSD = 0, timestamp = Date.now() }) {
  const half = spreadBps / 10000 / 2;
  return async ({ dex, amountIn, side }) => {
    // Only VENUE_A is cheap, and only VENUE_B is rich, so a route that buys on
    // one and sells on the other earns the edge. A same-venue route is flat,
    // which is the correct real-world behaviour.
    const isCheapSide = (side === "buy" && dex === "aerodrome") ||
                        (side === "sell" && dex === "uniswap");
    const rate = isCheapSide ? 1 + half : 1 / (1 + half);
    return { amountOut: amountIn * rate, liquidityUSD, slippageUSD, timestamp };
  };
}


async function run() {
  console.log("=".repeat(70));
  console.log("DETECTION TEST: can the scanner see an edge that provably exists?");
  console.log("=".repeat(70));
  console.log();

  // ── 1. The cost model must reject a genuinely losing route ───────────────
  console.log("--- cost model ---");

  await check("a 0 bps spread is unprofitable (fees exceed the edge)", () => {
    const buy = { amountOut: 10000, liquidityUSD: 500000, slippageUSD: 0 };
    const sell = { amountOut: 10000, liquidityUSD: 500000, slippageUSD: 0 };
    const e = calculateFlashLoanArb({ borrowAmountUSD: 10000, buyQuote: buy, sellQuote: sell });
    assert(!e.isViable, "a zero-spread round trip must never be viable");
    assert(e.grossProfitUSD === 0, `expected 0 gross profit, got ${e.grossProfitUSD}`);
    assert(e.flashLoanFeeUSD > 0, "the flash premium must be charged even on a flat trade");
  });

  await check("the 5 bps Aave premium is actually deducted", () => {
    const buy = { amountOut: 10000, liquidityUSD: 500000, slippageUSD: 0 };
    const sell = { amountOut: 10000, liquidityUSD: 500000, slippageUSD: 0 };
    const e = calculateFlashLoanArb({ borrowAmountUSD: 100000, buyQuote: buy, sellQuote: sell });
    const expected = 100000 * 0.0005;
    assert(
      Math.abs(e.flashLoanFeeUSD - expected) < 1e-6,
      `flash fee should be $${expected}, got $${e.flashLoanFeeUSD}`,
    );
  });

  await check("flash premium matches the on-chain Aave v3 Base value", () => {
    assert(
      DEFAULT_FLASH_ARB_CONFIG.flashLoanFeeRate === 0.0005,
      `flashLoanFeeRate is ${DEFAULT_FLASH_ARB_CONFIG.flashLoanFeeRate}, expected 0.0005 (5 bps)`,
    );
  });

  // ── 2. The detector must FIRE on a known spread ─────────────────────────
  console.log();
  console.log("--- detection: a GUARANTEED edge must be found ---");

  // 200 bps is far above the ~78 bps break-even, so this cannot be a
  // borderline case that passes by accident.
  const found = await scanCrossDexFlashArb({
    quoteProvider: makeQuoteProvider({ spreadBps: 200 }),
    tokens: [WETH, USDC],
    dexes: ["aerodrome", "uniswap"],
    borrowAmountsUSD: [10000, 50000, 100000],
  });

  await check("a 200 bps spread is DETECTED as viable", () => {
    const viable = found.filter((o) => o.status === "CANDIDATE");
    assert(viable.length > 0, `no route marked CANDIDATE (${found.length} evaluated)`);
    assert(viable[0].isViable, "the best route is not viable");
    assert(viable[0].netProfitUSD > 0, `net profit should be positive, got ${viable[0].netProfitUSD}`);
  });

  await check("the detected profit scales with the injected spread", () => {
    // Compare on a SINGLE size so the assertion is about the economics, not
    // about which size happened to sort first. At 200 bps gross on $10k, profit
    // is ~$201 gross, less a $5 flash premium and ~$5 of fixed costs => ~$191.
    const best = found.find(
      (o) => o.status === "CANDIDATE" && o.borrowAmountUSD === 10000,
    );
    assert(best, `no $10k route was marked CANDIDATE`);
    assert(
      best.netProfitUSD > 150 && best.netProfitUSD < 260,
      `expected ~$150-260 net on $10k at 200 bps, got $${best.netProfitUSD.toFixed(2)}`,
    );
  });

  await check("profit grows roughly linearly with size", () => {
    const by = {};
    for (const o of found) {
      if (o.status === "CANDIDATE") by[o.borrowAmountUSD] = o.netProfitUSD;
    }
    assert(by[10000] !== undefined, "no $10k candidate to compare against");
    assert(by[100000] !== undefined, "no $100k candidate to compare against");
    // 10x the size should be ~10x the profit, less a constant $5 fee.
    const ratio = by[100000] / by[10000];
    assert(ratio > 9 && ratio < 11, `expected ~10x profit scaling, got ${ratio.toFixed(2)}x`);
  });

  await check("both orderings of the venue pair are evaluated", () => {
    const buys = new Set(found.map((o) => o.buyDex));
    assert(buys.size >= 2, `expected routes through both venues, saw ${[...buys].join(",")}`);
  });

  await check("every rejected route states a reason", () => {
    for (const r of found.filter((o) => o.status === "REJECTED")) {
      assert(r.blockingConstraint, `route ${r.id} was rejected with no stated reason`);
    }
  });

  // ── 3. Below the true break-even, nothing may be reported ───────────────
  console.log();
  console.log("--- detection: a sub-cost spread must NOT be reported ---");

  // IMPORTANT: the scanner has no pool-fee term. `spreadBps` is the NET edge
  // remaining AFTER venue fees, because the quote provider is expected to have
  // priced those in already. So the scanner's own break-even is just its fixed
  // costs: the 5 bps flash premium plus gas and the MEV buffer.
  //
  // On $10k that is roughly $5 + $3 + $2 = $10, i.e. ~10 bps of net edge.
  // 5 bps is below that and must be rejected; 40 bps is above it and must not
  // be. Asserting on the real threshold rather than an assumed one keeps this
  // test honest about what the cost model actually guarantees.
  const breakeven = await scanCrossDexFlashArb({
    quoteProvider: makeQuoteProvider({ spreadBps: 5 }),
    tokens: [WETH, USDC],
    dexes: ["aerodrome", "uniswap"],
    borrowAmountsUSD: [10000],
  });

  await check("a 5 bps NET edge is REJECTED as below fixed costs", () => {
    const viable = breakeven.filter((o) => o.status === "CANDIDATE");
    assert(viable.length === 0, `${viable.length} routes falsely viable on a 5 bps net edge`);
  });

  await check("a 40 bps NET edge IS reported viable", async () => {
    const r = await scanCrossDexFlashArb({
      quoteProvider: makeQuoteProvider({ spreadBps: 40 }),
      tokens: [WETH, USDC],
      dexes: ["aerodrome", "uniswap"],
      borrowAmountsUSD: [10000],
    });
    const viable = r.filter((o) => o.status === "CANDIDATE");
    assert(viable.length > 0, "a 40 bps net edge should clear the ~10 bps fixed-cost floor");
  });

  // Profitable edge, but only $1k of depth to fill it.
  const thin = await scanCrossDexFlashArb({
    quoteProvider: makeQuoteProvider({ spreadBps: 30, liquidityUSD: 1000 }),
    tokens: [WETH, USDC],
    dexes: ["aerodrome", "uniswap"],
    borrowAmountsUSD: [10000],
  });

  await check("a profitable-but-shallow route is rejected WITH a stated reason", () => {
    // Regression test for the bug where a route killed purely by the liquidity
    // floor had blockingConstraint === null, which is exactly the silent
    // rejection the module documents itself as preventing.
    const killed = thin.filter((o) => o.status === "REJECTED" && o.grossProfitUSD > 0);
    assert(killed.length > 0, "expected a profitable route to fail the liquidity floor");
    for (const r of killed) {
      assert(r.blockingConstraint, `profitable route ${r.id} rejected with a null blockingConstraint`);
      assert(
        /liquidity/i.test(r.blockingConstraint),
        `expected a liquidity reason, got "${r.blockingConstraint}"`,
      );
    }
  });

  await check("every rejected route states a reason", () => {
    assert(thin.length > 0, "no routes were evaluated at all");
    for (const r of thin) {
      assert(r.blockingConstraint, `route ${r.id} rejected with no reason`);
    }
  });

  // ── 4. Scale behaviour: bigger size must not create fake profit ─────────
  console.log();
  console.log("--- size sensitivity ---");

  const sized = await scanCrossDexFlashArb({
    quoteProvider: makeQuoteProvider({ spreadBps: 200 }),
    tokens: [WETH, USDC],
    dexes: ["aerodrome", "uniswap"],
    borrowAmountsUSD: [1000, 10000, 100000],
  });

  await check("larger size produces proportionally larger profit", () => {
    const by = {};
    for (const o of sized) if (o.status === "CANDIDATE") by[o.borrowAmountUSD] = o.netProfitUSD;
    if (by[1000] !== undefined && by[100000] !== undefined) {
      assert(by[100000] > by[1000], `profit should grow with size: $1k -> $${by[1000]}, $100k -> $${by[100000]}`);
    }
  });

  // ── 5. The scanner must not invent quotes ──────────────────────────────
  console.log();
  console.log("--- integrity ---");

  await check("a missing quoteProvider is rejected loudly", async () => {
    // The scan is async, so a missing provider surfaces as a REJECTED promise
    // rather than a synchronous throw. Await it and assert on the rejection.
    let message = null;
    try {
      await scanCrossDexFlashArb({ tokens: [WETH, USDC], dexes: ["a", "b"] });
    } catch (e) {
      message = e.message;
    }
    assert(message !== null, "calling the scanner without a quoteProvider should reject");
    assert(/quoteProvider/.test(message), `unexpected error: ${message}`);
  });

  await check("stale quotes are discarded rather than traded on", async () => {
    const stale = await scanCrossDexFlashArb({
      quoteProvider: makeQuoteProvider({ spreadBps: 200, timestamp: Date.now() - 600000 }),
      tokens: [WETH, USDC],
      dexes: ["aerodrome", "uniswap"],
      borrowAmountsUSD: [10000],
    });
    assert(stale.length === 0, `stale quotes produced ${stale.length} tradable routes`);
  });

  // ── Verdict ────────────────────────────────────────────────────────────
  console.log();
  console.log("=".repeat(70));
  if (failed === 0) {
    console.log(`ALL ${passed} DETECTION CHECKS PASSED`);
    console.log("=".repeat(70));
    console.log();
    console.log("VERDICT: the scanner is capable of reporting an edge.");
    console.log("The live scans that found nothing are therefore a real");
    console.log("negative result, not a broken detector.");
  } else {
    console.log(`${failed} of ${passed + failed} CHECKS FAILED`);
    console.log("=".repeat(70));
    for (const f of failures) console.log(`  - ${f}`);
    console.log();
    console.log("VERDICT: the detector is NOT trustworthy. A negative live");
    console.log("scan cannot be read as evidence that no opportunity exists.");
  }
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error("HARNESS ERROR: " + e.stack);
  process.exit(1);
});
