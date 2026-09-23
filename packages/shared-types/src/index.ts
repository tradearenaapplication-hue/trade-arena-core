// Shared TypeScript interfaces for the Trade Arena Edge System

export interface TradeRecord {
  id: string;
  strategyId: string;
  setupName: string;
  timestamp: Date;
  entryPrice: number;
  exitPrice: number;
  size: number;
  side: 'long' | 'short';
  pnl: number;
  slippage: number;
  gasFees: number;
  latency: number; // in milliseconds
  liquidityProfile: string; // e.g., 'high', 'medium', 'low'
  volatilityRegime: string; // e.g., 'high', 'medium', 'low'
  whaleFlowIndicator: number; // 0 to 1 score
  arbitrageSpread?: number; // for arbitrage strategies
  fees: number; // total fees paid
  netPnl: number; // pnl minus fees and slippage
}

export interface MarketSnapshot {
  timestamp: Date;
  symbol: string;
  price: number;
  volume: number;
  volatility: number;
  liquidity: number;
  regime: RegimeTag;
  orderBook: {
    bids: Array<[price: number, size: number]>;
    asks: Array<[price: number, size: number]>;
  };
}

export interface ExecutionMetrics {
  winRate: number;
  profitFactor: number;
  expectancy: number;
  averageR: number;
  drawdown: number;
  volatilityAdjustedReturn: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  largestWin: number;
  largestLoss: number;
  averageWin: number;
  averageLoss: number;
  sharpeRatio: number;
  sortinoRatio: number;
  calmarRatio: number;
}

export interface StrategyEdge {
  strategyId: string;
  setupName: string;
  timeWindow: string; // e.g., '09:30-10:30'
  regime: RegimeTag;
  metrics: ExecutionMetrics;
  edgeScore: number;
  edgeStatement: string;
  sampleSize: number;
  isValid: boolean;
  lastUpdated: Date;
  decayRate: number; // per day, 0 to 1
}

export interface EdgeStatement {
  statement: string;
  setupName: string;
  timeWindow: string;
  regime: RegimeTag;
  profitFactor: number;
  expectancy: number;
  sampleSize: number;
}

export interface EdgeScore {
  score: number; // 0 to 100
  components: {
    winRate: number; // weight 0.2
    profitFactor: number; // weight 0.3
    expectancy: number; // weight 0.2
    drawdown: number; // weight 0.1 (inverted)
    volatilityAdjustedReturn: number; // weight 0.1
    sampleSize: number; // weight 0.1 (normalized)
  };
  weights: {
    winRate: number;
    profitFactor: number;
    expectancy: number;
    drawdown: number;
    volatilityAdjustedReturn: number;
    sampleSize: number;
  };
}

export type RegimeTag = 
  | 'trending'
  | 'ranging'
  | 'high-volatility'
  | 'low-volatility'
  | 'whale-driven'
  | 'news-driven'
  | 'liquidity-crunch'
  | 'normal';

export interface Agent {
  id: string;
  strategyId: string;
  name: string;
  status: 'active' | 'paused' | 'scaling' | 'disabled';
  riskBudget: number; // percentage of capital allocated
  regimeTag: RegimeTag;
  edgeScore: number;
  lastEdgeUpdate: Date;
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, any>;
}