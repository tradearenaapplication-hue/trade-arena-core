"use strict";

const { applyRiskControls } = require("./arb-risk-engine.js");

const DEFAULT_FLASH_ARB_CONFIG = {
  // Aave v3 flash loan premium. VERIFIED ON-CHAIN via
  // AavePool FLASHLOAN_PREMIUM_TOTAL() on Base = 5 bps.
  // Previously set to 0.0009 (9 bps), which overstated the cost by 80% and
  // rejected routes that were in fact viable. At $100k that was a $40 error
  // per scan. Re-verify before changing - a wrong value here silently biases
  // every profitability verdict this scanner produces.
  flashLoanFeeRate: 0.0005,
  minNetProfitUSD: 10,
  minROI: 0.0015,
  defaultGasUSD: 3,
  mevBufferUSD: 2,
  maxQuoteAgeMs: 3000,
  maxBorrowUSD: 250000,
  minLiquidityUSD: 50000,
  // Below this, fixed costs (gas plus the MEV buffer) dominate regardless of
  // the edge, so no route can ever be viable. Stated explicitly rather than
  // left as an emergent property of the arithmetic.
  minViableBorrowUSD: 100,
};

function calculateFlashLoanArb({ borrowAmountUSD, buyQuote, sellQuote, config = {} }) {
  const cfg = { ...DEFAULT_FLASH_ARB_CONFIG, ...config };
  const amount = Number(borrowAmountUSD || 0);
  const buyOut = Number(buyQuote?.amountOut || 0);
  const finalOut = Number(sellQuote?.amountOut || 0);
  const flashLoanFeeUSD = amount * cfg.flashLoanFeeRate;
  const gasUSD = Number(cfg.gasUSD ?? cfg.defaultGasUSD);
  const slippageUSD = Number(buyQuote?.slippageUSD || 0) + Number(sellQuote?.slippageUSD || 0);
  const mevBufferUSD = Number(cfg.mevBufferUSD || 0);
  const grossProfitUSD = finalOut - amount;
  const netProfitUSD = grossProfitUSD - flashLoanFeeUSD - gasUSD - slippageUSD - mevBufferUSD;
  const roi = amount > 0 ? netProfitUSD / amount : 0;

  const reasons = [];
  if (netProfitUSD < cfg.minNetProfitUSD) {
    reasons.push(
      "net USD " + netProfitUSD.toFixed(2) + " is below the USD " + cfg.minNetProfitUSD + " floor"
    );
  }
  if (roi < cfg.minROI) {
    reasons.push(
      "ROI " + (roi * 100).toFixed(3) + "% is below the " + (cfg.minROI * 100).toFixed(3) + "% floor"
    );
  }
  if (grossProfitUSD > 0 && gasUSD > grossProfitUSD) {
    reasons.push(
      "gas USD " + gasUSD.toFixed(2) + " exceeds gross profit USD " + grossProfitUSD.toFixed(2)
    );
  }
  if (amount < (cfg.minViableBorrowUSD || 0)) {
    reasons.push(
      "borrow USD " + amount + " is below the USD " + cfg.minViableBorrowUSD +
      " at which fixed costs can be covered at all"
    );
  }

  return {
    borrowAmountUSD: amount,
    intermediateAmount: buyOut,
    finalAmountUSD: finalOut,
    grossProfitUSD,
    flashLoanFeeUSD,
    gasUSD,
    slippageUSD,
    mevBufferUSD,
    netProfitUSD,
    roi,
    isViable: netProfitUSD >= cfg.minNetProfitUSD && roi >= cfg.minROI,
    // Why it was rejected. A scanner returning an empty array is
    // indistinguishable from a broken one; naming the binding constraint stops
    // someone concluding "no arbitrage exists" when the truth is "gas ate it",
    // and makes it explicit that a small bankroll can never clear a flat floor.
    rejectReasons: reasons,
    blockingConstraint: reasons.length ? reasons[0] : null,
  };
}

function quoteIsFresh(quote, now, maxQuoteAgeMs) {
  if (!quote?.timestamp) return true;
  return now - quote.timestamp <= maxQuoteAgeMs;
}

function buildRoutes(tokens, dexes) {
  const routes = [];
  for (const borrowToken of tokens) {
    for (const intermediateToken of tokens) {
      if (borrowToken.symbol === intermediateToken.symbol) continue;
      for (const buyDex of dexes) {
        for (const sellDex of dexes) {
          if (buyDex === sellDex) continue;
          routes.push({ borrowToken, intermediateToken, buyDex, sellDex });
        }
      }
    }
  }
  return routes;
}

async function scanCrossDexFlashArb({
  quoteProvider,
  tokens = [],
  dexes = [],
  borrowAmountsUSD = [10000],
  riskState = null,
  config = {},
  now = Date.now(),
} = {}) {
  if (typeof quoteProvider !== "function") {
    throw new Error("scanCrossDexFlashArb requires an injected quoteProvider");
  }

  const cfg = { ...DEFAULT_FLASH_ARB_CONFIG, ...config };
  const opportunities = [];
  const routes = buildRoutes(tokens, dexes);

  for (const route of routes) {
    for (const borrowAmountUSD of borrowAmountsUSD) {
      if (borrowAmountUSD > cfg.maxBorrowUSD) continue;

      const buyQuote = await quoteProvider({
        dex: route.buyDex,
        tokenIn: route.borrowToken,
        tokenOut: route.intermediateToken,
        amountIn: borrowAmountUSD,
        side: "buy",
      });
      if (!quoteIsFresh(buyQuote, now, cfg.maxQuoteAgeMs)) continue;

      const sellQuote = await quoteProvider({
        dex: route.sellDex,
        tokenIn: route.intermediateToken,
        tokenOut: route.borrowToken,
        amountIn: buyQuote.amountOut,
        side: "sell",
      });
      if (!quoteIsFresh(sellQuote, now, cfg.maxQuoteAgeMs)) continue;

      const minLiquidity = Math.min(
        Number(buyQuote.liquidityUSD || Infinity),
        Number(sellQuote.liquidityUSD || Infinity),
      );
      const economics = calculateFlashLoanArb({ borrowAmountUSD, buyQuote, sellQuote, config: cfg });
      const opportunity = {
        id: `flash-${route.borrowToken.symbol}-${route.intermediateToken.symbol}-${route.buyDex}-${route.sellDex}-${borrowAmountUSD}`,
        type: "FLASH_LOAN_DEX_ARB",
        strategy: "CROSS_DEX_FLASH_LOAN_ARB",
        chain: cfg.chain || "base",
        borrowToken: route.borrowToken.symbol,
        intermediateToken: route.intermediateToken.symbol,
        borrowAmountUSD,
        route: [
          `${route.borrowToken.symbol} -> ${route.intermediateToken.symbol} on ${route.buyDex}`,
          `${route.intermediateToken.symbol} -> ${route.borrowToken.symbol} on ${route.sellDex}`,
        ],
        buyDex: route.buyDex,
        sellDex: route.sellDex,
        liquidityUSD: Number.isFinite(minLiquidity) ? minLiquidity : 0,
        netEdge: economics.roi,
        recommendedSizeUSD: borrowAmountUSD,
        executionMode: "FLASH_LOAN",
        dryRunOnly: true,
        ...economics,
      };

      const risk = riskState
        ? applyRiskControls(
            opportunity,
            riskState,
            { minNetProfitUSD: cfg.minNetProfitUSD, minNetEdge: cfg.minROI },
            now,
          )
        : { approved: economics.isViable, reasons: [] };

      opportunity.risk = risk;
      opportunity.status = risk.approved && economics.isViable ? "CANDIDATE" : "REJECTED";
      if (opportunity.liquidityUSD && opportunity.liquidityUSD < cfg.minLiquidityUSD) {
        opportunity.status = "REJECTED";
        opportunity.risk.reasons = [...(opportunity.risk.reasons || []), "liquidity_below_minimum"];
        // Record the liquidity floor in rejectReasons too, not only in risk.reasons.
        // A profitable route killed purely by shallow liquidity otherwise has a
        // NULL blockingConstraint, which defeats the whole point of stating why a
        // route was rejected - a "REJECTED" line with no reason reads the same as
        // a scanner that silently dropped the opportunity.
        opportunity.rejectReasons = [
          ...(opportunity.rejectReasons || []),
          "liquidity USD " + opportunity.liquidityUSD.toFixed(0) + " is below the USD " +
            cfg.minLiquidityUSD + " floor",
        ];
        opportunity.blockingConstraint =
          opportunity.rejectReasons[0] || opportunity.blockingConstraint;
      }

      opportunities.push(opportunity);
    }
  }

  return opportunities.sort((a, b) => b.netProfitUSD - a.netProfitUSD);
}

module.exports = {
  DEFAULT_FLASH_ARB_CONFIG,
  calculateFlashLoanArb,
  buildRoutes,
  scanCrossDexFlashArb,
};
