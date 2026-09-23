// Edge statement generator
import { RegimeTag } from 'shared-types';

export interface EdgeStatementData {
  strategyId: string;
  setupName: string;
  timeWindow: string; // e.g., '09:30-10:30'
  regime: RegimeTag;
  metrics: {
    winRate: number;
    profitFactor: number;
    expectancy: number;
    averageR: number;
    drawdown: number;
    volatilityAdjustedReturn: number;
  };
  sampleSize: number;
}

export function generateEdgeStatement(data: EdgeStatementData): string {
  const {
    strategyId,
    setupName,
    timeWindow,
    regime,
    metrics: { winRate, profitFactor, expectancy },
    sampleSize
  } = data;

  return `This strategy (${strategyId}) shows a validated edge trading ${setupName} during ${timeWindow} in ${regime} conditions, with a profit factor of ${profitFactor.toFixed(2)}, expectancy of ${expectancy.toFixed(4)}, and sample size of ${sampleSize} trades.`;
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

export function createEdgeStatementObject(data: EdgeStatementData): EdgeStatement {
  const statement = generateEdgeStatement(data);
  return {
    statement,
    setupName: data.setupName,
    timeWindow: data.timeWindow,
    regime: data.regime,
    profitFactor: data.metrics.profitFactor,
    expectancy: data.metrics.expectancy,
    sampleSize: data.sampleSize
  };
}