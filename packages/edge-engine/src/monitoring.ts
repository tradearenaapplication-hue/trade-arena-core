// Edge monitoring module
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

export interface EdgeHistory {
  [date: string]: {
    metrics: {
      winRate: number;
      profitFactor: number;
      expectancy: number;
      averageR: number;
      drawdown: number;
      volatilityAdjustedReturn: number;
    };
    edgeScore: number;
    sampleSize: number;
  };
}

export interface EdgeDecayAlert {
  strategyId: string;
  setupName: string;
  timeWindow: string;
  regime: string;
  currentScore: number;
  previousScore: number;
  decayRate: number; // per day
  alert: 'decay' | 'stable' | 'improving';
}

export function detectEdgeDecay(history: EdgeHistory, threshold: number = 0.02): EdgeDecayAlert[] {
  const alerts: EdgeDecayAlert[] = [];
  const dates = Object.keys(history).sort(); // oldest to newest

  // We need at least two data points to compare
  if (dates.length < 2) return alerts;

  // Compare each consecutive pair
  for (let i = 1; i < dates.length; i++) {
    const prevDate = dates[i-1];
    const currDate = dates[i];
    const prev = history[prevDate];
    const curr = history[currDate];

    // Calculate decay rate per day (assuming dates are one day apart)
    const timeDiff = 1; // day
    const scoreDiff = curr.edgeScore - prev.edgeScore;
    const decayRate = -scoreDiff / (prev.edgeScore * timeDiff); // negative if decaying

    let alert: 'decay' | 'stable' | 'improving' = 'stable';
    if (decayRate > threshold) {
      alert = 'decay';
    } else if (decayRate < -threshold) {
      alert = 'improving';
    }

    alerts.push({
      strategyId: 'unknown', // We don't have strategyId in history, so we'll use placeholder
      setupName: 'unknown',
      timeWindow: 'unknown',
      regime: 'unknown',
      currentScore: curr.edgeScore,
      previousScore: prev.edgeScore,
      decayRate,
      alert
    });
  }

  return alerts;
}

export function compareMonthlyMetrics(current: {
  winRate: number;
  profitFactor: number;
  expectancy: number;
  averageR: number;
  drawdown: number;
  volatilityAdjustedReturn: number;
  sampleSize: number;
}, previous: {
  winRate: number;
  profitFactor: number;
  expectancy: number;
  averageR: number;
  drawdown: number;
  volatilityAdjustedReturn: number;
  sampleSize: number;
}) {
  return {
    winRate: {
      current: current.winRate,
      previous: previous.winRate,
      change: current.winRate - previous.winRate
    },
    profitFactor: {
      current: current.profitFactor,
      previous: previous.profitFactor,
      change: current.profitFactor - previous.profitFactor
    },
    expectancy: {
      current: current.expectancy,
      previous: previous.expectancy,
      change: current.expectancy - previous.expectancy
    },
    averageR: {
      current: current.averageR,
      previous: previous.averageR,
      change: current.averageR - previous.averageR
    },
    drawdown: {
      current: current.drawdown,
      previous: previous.drawdown,
      change: current.drawdown - previous.drawdown
    },
    volatilityAdjustedReturn: {
      current: current.volatilityAdjustedReturn,
      previous: previous.volatilityAdjustedReturn,
      change: current.volatilityAdjustedReturn - previous.volatilityAdjustedReturn
    },
    sampleSize: {
      current: current.sampleSize,
      previous: previous.sampleSize,
      change: current.sampleSize - previous.sampleSize
    }
  };
}

export function flagUnderperformingStrategies(edges: {
  strategyId: string;
  edgeScore: number;
  profitFactor: number;
  expectancy: number;
}[], scoreThreshold: number = 40, profitFactorThreshold: number = 1.5) {
  return edges.filter(edge =>
    edge.edgeScore < scoreThreshold || edge.profitFactor < profitFactorThreshold
  );
}

export function recommendScalingStrategies(edges: {
  strategyId: string;
  edgeScore: number;
  profitFactor: number;
  expectancy: number;
}[], scoreThreshold: number = 70, profitFactorThreshold: number = 2.0) {
  return edges.filter(edge =>
    edge.edgeScore > scoreThreshold && edge.profitFactor > profitFactorThreshold
  );
}