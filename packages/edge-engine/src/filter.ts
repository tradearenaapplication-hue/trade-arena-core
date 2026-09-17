// Trade filtering module with chainable API
import { TradeRecord } from 'shared-types';
import { RegimeTag } from 'shared-types';

export class TradeFilter {
  private trades: TradeRecord[];
  private filters: Array<(trade: TradeRecord) => boolean> = [];

  constructor(trades: TradeRecord[]) {
    this.trades = trades;
  }

  bySetup(setupName: string): TradeFilter {
    this.filters.push(t => t.setupName === setupName);
    return this;
  }

  byTimeWindow(start: string, end: string): TradeFilter {
    // Assuming start and end are in HH:mm format
    this.filters.push(t => {
      const tradeTime = new Date(t.timestamp);
      const tradeHour = tradeTime.getHours();
      const tradeMinute = tradeTime.getMinutes();
      const tradeMinutes = tradeHour * 60 + tradeMinute;
      const [startHour, startMinute] = start.split(':').map(Number);
      const [endHour, endMinute] = end.split(':').map(Number);
      const startMinutes = startHour * 60 + startMinute;
      const endMinutes = endHour * 60 + endMinute;
      return tradeMinutes >= startMinutes && tradeMinutes <= endMinutes;
    });
    return this;
  }

  byRegime(regime: RegimeTag): TradeFilter {
    this.filters.push(t => t.volatilityRegime === regime);
    return this;
  }

  byVolatilityCluster(cluster: string): TradeFilter {
    // This is a placeholder; we assume volatilityRegime is the cluster
    this.filters.push(t => t.volatilityRegime === cluster);
    return this;
  }

  byLiquidityProfile(profile: string): TradeFilter {
    this.filters.push(t => t.liquidityProfile === profile);
    return this;
  }

  execute(): TradeRecord[] {
    return this.trades.filter(t => this.filters.every(f => f(t)));
  }
}

// Helper function to start a chain
export function filterTrades(trades: TradeRecord[]): TradeFilter {
  return new TradeFilter(trades);
}

// Individual filter functions (for non-chainable use)
export function filterBySetup(trades: TradeRecord[], setupName: string): TradeRecord[] {
  return trades.filter(t => t.setupName === setupName);
}

export function filterByTimeWindow(trades: TradeRecord[], start: string, end: string): TradeRecord[] {
  return new TradeFilter(trades).byTimeWindow(start, end).execute();
}

export function filterByRegime(trades: TradeRecord[], regime: RegimeTag): TradeRecord[] {
  return trades.filter(t => t.volatilityRegime === regime);
}

export function filterByVolatilityCluster(trades: TradeRecord[], cluster: string): TradeRecord[] {
  return trades.filter(t => t.volatilityRegime === cluster);
}

export function filterByLiquidityProfile(trades: TradeRecord[], profile: string): TradeRecord[] {
  return trades.filter(t => t.liquidityProfile === profile);
}