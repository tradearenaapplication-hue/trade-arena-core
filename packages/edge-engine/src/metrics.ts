// Pure functions for calculating edge metrics
import { TradeRecord } from 'shared-types';

export function calculateWinRate(trades: TradeRecord[]): number {
  if (trades.length === 0) return 0;
  const winningTrades = trades.filter(t => t.netPnl > 0);
  return (winningTrades.length / trades.length) * 100;
}

export function calculateProfitFactor(trades: TradeRecord[]): number {
  const grossProfit = trades
    .filter(t => t.netPnl > 0)
    .reduce((sum, t) => sum + t.netPnl, 0);
  const grossLoss = trades
    .filter(t => t.netPnl < 0)
    .reduce((sum, t) => sum + Math.abs(t.netPnl), 0);
  return grossLoss === 0 ? Infinity : grossProfit / grossLoss;
}

export function calculateExpectancy(trades: TradeRecord[]): number {
  if (trades.length === 0) return 0;
  const avgWin = trades
    .filter(t => t.netPnl > 0)
    .reduce((sum, t) => sum + t.netPnl, 0) /
    Math.max(1, trades.filter(t => t.netPnl > 0).length);
  const avgLoss = trades
    .filter(t => t.netPnl < 0)
    .reduce((sum, t) => sum + Math.abs(t.netPnl), 0) /
    Math.max(1, trades.filter(t => t.netPnl < 0).length);
  const winRate = calculateWinRate(trades) / 100;
  return (winRate * avgWin) - ((1 - winRate) * avgLoss);
}

export function calculateAverageR(trades: TradeRecord[]): number {
  // Assuming R is the risk-reward ratio, we need to know the risk per trade.
  // For simplicity, we'll use the average profit per trade divided by average loss per trade.
  // But the master prompt doesn't specify. Let's assume we have a risk field.
  // Since we don't have risk in TradeRecord, we'll approximate using netPnl and assume risk is constant.
  // Alternatively, we can use the average trade Pnl.
  // Let's change: we'll calculate the average trade Pnl (which is expectancy) and divide by average loss.
  // Actually, average R is average profit divided by average loss.
  const avgProfit = trades
    .filter(t => t.netPnl > 0)
    .reduce((sum, t) => sum + t.netPnl, 0) /
    Math.max(1, trades.filter(t => t.netPnl > 0).length);
  const avgLoss = trades
    .filter(t => t.netPnl < 0)
    .reduce((sum, t) => sum + Math.abs(t.netPnl), 0) /
    Math.max(1, trades.filter(t => t.netPnl < 0).length);
  return avgLoss === 0 ? 0 : avgProfit / avgLoss;
}

export function calculateDrawdown(trades: TradeRecord[]): number {
  let cumulative = 0;
  let peak = 0;
  let drawdown = 0;
  for (const trade of trades) {
    cumulative += trade.netPnl;
    if (cumulative > peak) {
      peak = cumulative;
    }
    const dd = (peak - cumulative) / peak * 100;
    if (dd > drawdown) drawdown = dd;
  }
  return drawdown;
}

export function calculateVolatilityAdjustedReturn(trades: TradeRecord[]): number {
  // We don't have volatility per trade, so we'll use the standard deviation of returns divided by average return.
  // For simplicity, we'll use the expectancy divided by the standard deviation of netPnl.
  if (trades.length === 0) return 0;
  const mean = trades.reduce((sum, t) => sum + t.netPnl, 0) / trades.length;
  const variance = trades.reduce((sum, t) => sum + Math.pow(t.netPnl - mean, 2), 0) / trades.length;
  const volatility = Math.sqrt(variance);
  return volatility === 0 ? 0 : mean / volatility;
}

// Edge score calculation
export function calculateEdgeScore(metrics: {
  winRate: number;
  profitFactor: number;
  expectancy: number;
  drawdown: number;
  volatilityAdjustedReturn: number;
  sampleSize: number;
}): number {
  // Normalize each metric to a 0-100 scale
  // Win rate: already 0-100
  // Profit factor: cap at 3, then map 1-3 to 0-100 (1=0, 3=100)
  // Expectancy: we need to map to 0-100, but expectancy can be negative. We'll shift and scale.
  // For simplicity, we'll use a weighted sum as described in the EdgeScore interface.
  // Weights are defined in the EdgeScore interface, but we'll hardcode here for the function.
  const weights = {
    winRate: 0.2,
    profitFactor: 0.3,
    expectancy: 0.2,
    drawdown: 0.1, // inverted: lower drawdown is better
    volatilityAdjustedReturn: 0.1,
    sampleSize: 0.1
  };

  // Normalize each metric to 0-100
  const winRateScore = Math.min(100, Math.max(0, metrics.winRate)); // already 0-100
  const profitFactorScore = Math.min(100, Math.max(0, (metrics.profitFactor - 1) * 50)); // 1->0, 3->100
  // For expectancy, we'll assume a range of -1 to 2 (in R) and map to 0-100
  const expectancyScore = Math.min(100, Math.max(0, (metrics.expectancy + 1) * 33.33)); // -1->0, 2->100
  // Drawdown: lower is better, so we invert (0% drawdown = 100, 50% drawdown = 0)
  const drawdownScore = Math.min(100, Math.max(0, 100 - metrics.drawdown * 2)); // 0%->100, 50%->0
  // Volatility adjusted return: we'll assume a range of 0 to 2 ( Sharpe-like) and map to 0-100
  const volAdjReturnScore = Math.min(100, Math.max(0, metrics.volatilityAdjustedReturn * 50)); // 0->0, 2->100
  // Sample size: we'll cap at 100 trades for scoring, log scale? Let's do linear: 0->0, 100->100
  const sampleSizeScore = Math.min(100, Math.max(0, metrics.sampleSize));

  return (
    winRateScore * weights.winRate +
    profitFactorScore * weights.profitFactor +
    expectancyScore * weights.expectancy +
    drawdownScore * weights.drawdown +
    volAdjReturnScore * weights.volatilityAdjustedReturn +
    sampleSizeScore * weights.sampleSize
  );
}