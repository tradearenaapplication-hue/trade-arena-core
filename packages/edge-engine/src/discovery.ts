// Edge discovery pipeline
import { TradeRecord } from 'shared-types';
import { filterTrades, TradeFilter } from './filter';
import {
  calculateWinRate,
  calculateProfitFactor,
  calculateExpectancy,
  calculateAverageR,
  calculateDrawdown,
  calculateVolatilityAdjustedReturn,
  calculateEdgeScore
} from './metrics';
import { generateEdgeStatement } from './statement';

export interface EdgeDiscoveryConfig {
  minTotalTrades?: number;
  minSegmentTrades?: number;
  minProfitFactor?: number;
  requirePositiveExpectancy?: number;
  // Additional config for filtering
  setupName?: string;
  timeWindowStart?: string;
  timeWindowEnd?: string;
  regime?: RegimeTag;
  volatilityCluster?: string;
  liquidityProfile?: string;
}

export interface EdgeDiscoveryResult {
  filteredSegments: TradeRecord[];
  metrics: {
    winRate: number;
    profitFactor: number;
    expectancy: number;
    averageR: number;
    drawdown: number;
    volatilityAdjustedReturn: number;
    totalTrades: number;
  };
  edgeScore: number;
  edgeStatement: string;
}

export function discoverEdge(trades: TradeRecord[], config: EdgeDiscoveryConfig = {}): EdgeDiscoveryResult {
  // Apply filters from config
  let filtered = trades;
  if (config.setupName) {
    filtered = filterBySetup(filtered, config.setupName);
  }
  if (config.timeWindowStart && config.timeWindowEnd) {
    filtered = filterByTimeWindow(filtered, config.timeWindowStart, config.timeWindowEnd);
  }
  if (config.regime) {
    filtered = filterByRegime(filtered, config.regime);
  }
  if (config.volatilityCluster) {
    filtered = filterByVolatilityCluster(filtered, config.volatilityCluster);
  }
  if (config.liquidityProfile) {
    filtered = filterByLiquidityProfile(filtered, config.liquidityProfile);
  }

  // Check minimum trades
  const minTotalTrades = config.minTotalTrades ?? 50;
  if (filtered.length < minTotalTrades) {
    throw new Error(`Insufficient trades: ${filtered.length} < ${minTotalTrades}`);
  }

  // Calculate metrics
  const winRate = calculateWinRate(filtered);
  const profitFactor = calculateProfitFactor(filtered);
  const expectancy = calculateExpectancy(filtered);
  const averageR = calculateAverageR(filtered);
  const drawdown = calculateDrawdown(filtered);
  const volatilityAdjustedReturn = calculateVolatilityAdjustedReturn(filtered);

  // Check profit factor and expectancy
  const minProfitFactor = config.minProfitFactor ?? 1.5;
  if (profitFactor < minProfitFactor) {
    throw new Error(`Profit factor too low: ${profitFactor} < ${minProfitFactor}`);
  }
  const requirePositiveExpectancy = config.requirePositiveExpectancy ?? 0;
  if (expectancy <= requirePositiveExpectancy) {
    throw new Error(`Expectancy not positive: ${expectancy} <= ${requirePositiveExpectancy}`);
  }

  // Calculate edge score
  const edgeScore = calculateEdgeScore({
    winRate,
    profitFactor,
    expectancy,
    drawdown,
    volatilityAdjustedReturn,
    sampleSize: filtered.length
  });

  // Generate edge statement
  const edgeStatement = generateEdgeStatement({
    strategyId: 'unknown', // We don't have strategyId in the filter, so we'll use placeholder
    setupName: config.setupName ?? 'unknown',
    timeWindow: `${config.timeWindowStart ?? '00:00'}-${config.timeWindowEnd ?? '23:59'}`,
    regime: config.regime ?? 'normal',
    metrics: {
      winRate,
      profitFactor,
      expectancy,
      averageR,
      drawdown,
      volatilityAdjustedReturn
    },
    sampleSize: filtered.length
  });

  return {
    filteredSegments: filtered,
    metrics: {
      winRate,
      profitFactor,
      expectancy,
      averageR,
      drawdown,
      volatilityAdjustedReturn,
      totalTrades: filtered.length
    },
    edgeScore,
    edgeStatement
  };
}

// For historical decay detection, we would need to compare with previous windows.
// We'll leave that to the monitoring module.