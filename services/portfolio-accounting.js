/**
 * Portfolio accounting for on-chain fills.
 *
 * Why this exists
 * ---------------
 * The swap handler used to log every on-chain trade with `pnl: 0`. Nothing
 * reconciled an exit against the entry that opened it, so the arena could spend
 * real money while reporting every result as break-even. That is the worst
 * possible failure mode for a trading app: it looks like it is working.
 *
 * This module rebuilds an accounting ledger from the swap records already
 * written to the trade log, so it works retrospectively over trades that have
 * already happened rather than only for new ones.
 *
 * Precision
 * ---------
 * Token quantities are held as BigInt in base units. A Base swap routinely
 * returns amounts like 0.000000000000000001, and IEEE-754 silently rounds
 * those to zero, which would corrupt a lot's cost basis. USD values are carried
 * as fixed-point BigInt so a large notional cannot drift either. Floats appear
 * only at the presentation boundary.
 *
 * Cost basis methods
 * ------------------
 *   FIFO  first-in, first-out. The common default.
 *   LIFO  last-in, first-out. Realises the other side of FIFO's timing.
 *   HIFO  highest-in, first-out. Tax-lot selection; defers the largest gain.
 *   WAC   weighted average cost. One blended basis, no per-lot selection.
 *
 *   The choice changes realised P&L, not total P&L. It only changes WHEN gains
 *   and losses are recognised, which is what makes it a tax question.
 */

'use strict';

const COST_BASIS_METHODS = ['FIFO', 'LIFO', 'HIFO', 'WAC'];
const DEFAULT_COST_BASIS = 'FIFO';

// Fixed-point scale for USD amounts, so cents are tracked exactly and gains
// are only converted back to a float at the presentation boundary.
const USD_SCALE = 1000000n;
const ZERO_USD = 0n;

/** Convert a USD number to fixed-point BigInt without float error. */
function usdToFixed(usd) {
  if (usd === null || usd === undefined) return ZERO_USD;
  const n = Number(usd);
  if (!Number.isFinite(n)) return ZERO_USD;
  // Round rather than truncate, so a tiny value does not silently become zero.
  return BigInt(Math.round(n * 1e6)) * (USD_SCALE / 1000000n);
}

/** Convert fixed-point BigInt back to a JS number for display. */
function fixedToUsd(fixed) {
  if (fixed === null || fixed === undefined) return 0;
  return Number(BigInt(fixed)) / Number(USD_SCALE);
}

/** Parse a decimal string into BigInt base units without float rounding. */
function toBaseUnits(value, decimals) {
  if (value === null || value === undefined || value === '') return 0n;
  let s = String(value).trim();
  if (s.startsWith('0x')) return BigInt(s);
  const negative = s.startsWith('-');
  if (negative) s = s.slice(1);
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return 0n;
  const [whole, frac = ''] = s.split('.');
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  const out = BigInt((whole || '0') + padded);
  return negative ? -out : out;
}

/** Format BigInt base units back to a decimal string. */
function fromBaseUnits(units, decimals) {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const s = abs.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  let frac = decimals > 0 ? s.slice(s.length - decimals) : '';
  // Strip trailing zeros: "1.50000000" is noisier to read and to compare than
  // "1.5", and the zeros carry no information the integer part does not.
  frac = frac.replace(/0+$/, '');
  return (neg ? '-' : '') + whole + (frac ? '.' + frac : '');
}

// Token decimals on Base Mainnet. Anything unlisted defaults to 18, which is
// wrong rather than fatal: a wrong scale shows up loudly in the P&L, whereas
// throwing would lose the whole trade record.
const TOKEN_DECIMALS = {
  USDC: 6,
  WETH: 18,
  WBTC: 8,
  CBBTC: 8,
  PEPE: 18,
  SOL: 9,
  ETH: 18
};

function decimalsFor(token) {
  return TOKEN_DECIMALS[String(token || '').toUpperCase()] ?? 18;
}

class PortfolioLedger {
  constructor(opts = {}) {
    this.method = COST_BASIS_METHODS.includes(opts.method) ? opts.method : DEFAULT_COST_BASIS;
    // key = `${botId}:${token}` -> array of open lots
    this.lots = new Map();
    // Completed matches, kept for realised reporting and tax lots.
    this.closedLots = [];
    this.realizedByToken = new Map();
    this.realizedByBot = new Map();
    this.gasUsdTotal = ZERO_USD;
    // The arena's working currency. Spent to open positions and received on
    // exit, so its legs move cash rather than realise gains.
    this.cashToken = String(opts.cashToken || 'USDC').toUpperCase();
    // Net change in the cash balance from the applied trades, for reconciling
    // the ledger against the wallet's real balance.
    this.cashDelta = ZERO_USD;
    this.warnings = [];
  }

  _key(botId, token) {
    return `${botId || 'manual'}:${String(token || '').toUpperCase()}`;
  }

  _bump(map, key, fixed) {
    map.set(key, (map.get(key) || ZERO_USD) + fixed);
  }

  /**
   * Apply one swap.
   *
   * A swap is a simultaneous disposal of `fromToken` and acquisition of
   * `toToken` at one instant, which is what actually happens on-chain: there is
   * no moment where only one leg has moved.
   */
  applyTrade(trade) {
    if (!trade) return null;
    const from = String(trade.fromToken || '').toUpperCase();
    const to = String(trade.toToken || '').toUpperCase();
    if (!from || !to) {
      this.warnings.push('Trade missing token symbols; skipped.');
      return null;
    }

    const botId = trade.botId || 'manual';
    const ts = trade.timestamp || new Date().toISOString();
    const fromUnits = toBaseUnits(trade.fromAmount, decimalsFor(from));
    const toUnits = toBaseUnits(trade.toAmount, decimalsFor(to));
    const fromUsd = usdToFixed(trade.fromUsd);
    const toUsd = usdToFixed(trade.toUsd);
    const gasUsd = usdToFixed(trade.gasUsd);
    this.gasUsdTotal += gasUsd;

    const result = {
      timestamp: ts, botId, from, to,
      fromUnits, toUnits, fromUsd, toUsd, gasUsd,
      realizedUsd: ZERO_USD, matchedLots: []
    };

    // The cash leg is a transfer, not a trade.
    //
    // The arena holds USDC as its working balance, so spending USDC to open a
    // position is cash moving into an investment, and receiving USDC on exit is
    // that investment turning back into cash. Neither leg opens a lot or
    // realises a gain by itself - only the non-cash leg does.
    //
    // Treating cash as a position to be disposed of was wrong twice over: it
    // invented a cost basis of zero for money the arena was handed, and it
    // charged gas against a disposal that never happened.
    const fromIsCash = from === this.cashToken;
    const toIsCash = to === this.cashToken;
    const opensPosition = !toIsCash;

    if (!fromIsCash && fromUnits > 0n && fromUsd > ZERO_USD) {
      // Gas is charged to P&L only when this trade has no acquired leg to
      // carry it. When a position IS opened below, the gas is added to that
      // lot's basis instead, so it is charged exactly once - when the lot is
      // eventually realised. Adding it in both places double-counted it.
      result.realizedUsd = this._dispose(this._key(botId, from), fromUnits, fromUsd, {
        token: from, botId, ts,
        gasUsd: opensPosition ? ZERO_USD : gasUsd
      });
    } else if (!fromIsCash && fromUnits > 0n) {
      // Disposing something with no basis usually means the ledger predates the
      // opening fill, not that a profit occurred.
      this.warnings.push(
        `Disposal of ${fromUnits} base units of ${from} with no cost basis ` +
        `(bot ${botId}, ${ts}); valued at zero cost. Ledger may predate this trade.`
      );
    }

    if (opensPosition && toUnits > 0n && toUsd > ZERO_USD) {
      this._acquire(this._key(botId, to), {
        token: to, botId, acquiredAt: ts, units: toUnits,
        costUsd: toUsd + gasUsd, rawCostUsd: toUsd
      });
    }

    // Cash in/out, tracked so the arena's balance can be reconciled against
    // what the chain actually holds.
    if (fromIsCash) this.cashDelta -= fromUsd;
    if (toIsCash) this.cashDelta += toUsd;
    this.cashDelta -= gasUsd;

    this._bump(this.realizedByToken, from, result.realizedUsd);
    this._bump(this.realizedByBot, botId, result.realizedUsd);
    return result;
  }

  /**
   * Open a new tax lot.
   *
   * Under WAC the new fill is blended into whatever is already open for this
   * key rather than becoming a separate lot. Without this, WAC would be FIFO
   * with a different label and would report a different number for no reason.
   * The blended lot keeps the EARLIEST acquisition date, so the CGT holding
   * period reflects the true age of the position rather than resetting on
   * every top-up.
   */
  _acquire(key, lot) {
    if (!this.lots.has(key)) this.lots.set(key, []);
    const open = this.lots.get(key);

    if (this.method === 'WAC') {
      const existing = open.filter(l => l.remaining > 0n);
      if (existing.length) {
        const existingUnits = existing.reduce((n, l) => n + l.remaining, 0n);
        const existingCost = existing.reduce((n, l) => n + l.remainingCostUsd, ZERO_USD);
        const totalUnits = existingUnits + lot.units;
        const earliest = existing
          .map(l => l.acquiredAt)
          .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
        const earliestOf = Date.parse(lot.acquiredAt) < Date.parse(earliest) ? lot.acquiredAt : earliest;

        this.lots.set(key, [{
          token: lot.token,
          botId: lot.botId,
          acquiredAt: earliestOf,
          units: totalUnits,
          costUsd: existingCost + lot.costUsd,
          rawCostUsd: lot.rawCostUsd,
          remaining: totalUnits,
          remainingCostUsd: existingCost + lot.costUsd
        }]);
        return;
      }
    }

    open.push({
      ...lot,
      remaining: lot.units,
      remainingCostUsd: lot.costUsd
    });
  }

  /**
   * Close lots to realise a disposal of `units`; returns realised P&L.
   *
   * Gas is added to the cost side so the true economics include what the trade
   * cost to run, rather than hiding it in a separate column.
   */
  _dispose(key, units, proceedsUsd, ctx) {
    const open = this.lots.get(key) || [];
    let remaining = units;
    const matched = [];
    let costBasis = ZERO_USD;

    for (const lot of this._selectLots(open)) {
      if (remaining <= 0n) break;
      if (lot.remaining <= 0n) continue;

      // Proportional slice: taking half a lot takes half its cost.
      const take = remaining < lot.remaining ? remaining : lot.remaining;
      const fraction = (lot.remainingCostUsd * take) / lot.remaining;

      costBasis += fraction;
      remaining -= take;
      lot.remaining -= take;
      lot.remainingCostUsd -= fraction;

      matched.push({
        token: ctx.token,
        botId: ctx.botId,
        acquiredAt: lot.acquiredAt,
        units: take,
        costUsd: fraction,
        proceedsUsd: (proceedsUsd * take) / units,
        method: this.method
      });
    }

    if (remaining > 0n) {
      this.warnings.push(
        `Disposal of ${remaining} base units of ${ctx.token} exceeded the open ` +
        `lots for bot ${ctx.botId} at ${ctx.ts}. Shortfall valued at zero cost.`
      );
    }

    // Scale proceeds to only what was actually disposed, so a partial sale
    // reports its own result rather than the whole position's.
    const disposed = units - remaining;
    const proceeds = disposed === units ? proceedsUsd : (proceedsUsd * disposed) / units;
    const realized = proceeds - costBasis - ctx.gasUsd;

    this.closedLots.push(...matched);
    this.lots.set(key, open.filter(l => l.remaining > 0n));
    return realized;
  }

  /** Lot selection order for the configured method. */
  _selectLots(open) {
    const lots = open.filter(l => l.remaining > 0n);
    switch (this.method) {
      case 'LIFO':
        return lots.slice().sort((a, b) => Date.parse(b.acquiredAt) - Date.parse(a.acquiredAt));
      case 'HIFO': {
        // Highest cost per unit first, so the largest gain is deferred and the
        // loss recognised first is the larger one. Ties fall back to oldest
        // first so the result is deterministic rather than sort-order luck.
        const costPerUnit = (l) => (l.remaining > 0n ? (l.remainingCostUsd * 1000000n) / l.remaining : 0n);
        return lots.slice().sort((a, b) => {
          const diff = costPerUnit(b) - costPerUnit(a);
          if (diff !== 0n) return diff > 0n ? 1 : -1;
          return Date.parse(a.acquiredAt) - Date.parse(b.acquiredAt);
        });
      }
      case 'WAC':
      case 'FIFO':
      default:
        // WAC blends as it goes in _acquire (see wacAverage), so its selection
        // order only needs to be stable and oldest-first.
        return lots.slice().sort((a, b) => Date.parse(a.acquiredAt) - Date.parse(b.acquiredAt));
    }
  }

  /** Mark open positions to current prices for unrealised P&L. */
  unrealized(priceOf) {
    const out = [];
    for (const [key, lots] of this.lots.entries()) {
      if (!lots.length) continue;
      const sep = key.indexOf(':');
      const botId = key.slice(0, sep);
      const token = key.slice(sep + 1);

      let units = 0n;
      let cost = ZERO_USD;
      let earliest = null;
      for (const l of lots) {
        units += l.remaining;
        cost += l.remainingCostUsd;
        if (!earliest || Date.parse(l.acquiredAt) < Date.parse(earliest)) earliest = l.acquiredAt;
      }
      const decimals = decimalsFor(token);
      const price = typeof priceOf === 'function' ? Number(priceOf(token) || 0) : 0;
      const qty = Number(fromBaseUnits(units, decimals));
      const valueUsd = usdToFixed(Number.isFinite(qty) ? qty * price : 0);

      out.push({
        botId, token,
        units: units.toString(),
        unitsFormatted: fromBaseUnits(units, decimals),
        costBasisUsd: fixedToUsd(cost),
        valueUsd: fixedToUsd(valueUsd),
        unrealizedUsd: fixedToUsd(valueUsd - cost),
        priceUsd: price,
        heldSince: earliest
      });
    }
    return out;
  }

  /**
   * Split closed lots into short- and long-term for Australian CGT.
   *
   * A CGT discount generally requires the asset to be held 12 months or more.
   * The boundary is a genuine tax question, so it is reported rather than
   * assumed. This is a report, not tax advice.
   */
  taxLotSplit(asOf = new Date()) {
    const cutoff = Date.parse(asOf) - 365 * 24 * 60 * 60 * 1000;
    let shortTerm = ZERO_USD;
    let longTerm = ZERO_USD;
    let shortCount = 0;
    let longCount = 0;
    for (const lot of this.closedLots) {
      const gain = lot.proceedsUsd - lot.costUsd;
      if (Date.parse(lot.acquiredAt) <= cutoff) {
        longTerm += gain;
        longCount++;
      } else {
        shortTerm += gain;
        shortCount++;
      }
    }
    return {
      shortTermGainUsd: fixedToUsd(shortTerm),
      longTermGainUsd: fixedToUsd(longTerm),
      shortTermLots: shortCount,
      longTermLots: longCount,
      note: 'Indicative only. Australian CGT discount eligibility and cost-base rules are a matter for a registered tax practitioner.'
    };
  }

  summary() {
    let realizedTotal = ZERO_USD;
    for (const v of this.realizedByToken.values()) realizedTotal += v;

    return {
      costBasisMethod: this.method,
      realizedPnlUsd: fixedToUsd(realizedTotal),
      realizedByToken: Object.fromEntries(
        [...this.realizedByToken].map(([k, v]) => [k, fixedToUsd(v)])
      ),
      realizedByBot: Object.fromEntries(
        [...this.realizedByBot].map(([k, v]) => [k, fixedToUsd(v)])
      ),
      openPositions: [...this.lots.values()].reduce((n, l) => n + l.length, 0),
      closedLots: this.closedLots.length,
      gasUsd: fixedToUsd(this.gasUsdTotal),
      cashToken: this.cashToken,
      cashDeltaUsd: fixedToUsd(this.cashDelta),
      warnings: this.warnings
    };
  }

  /**
   * Reconcile the ledger against balances read from the chain.
   *
   * Two independent systems track the same money: this ledger and the wallet.
   * They should agree, and when they do not, one of them is wrong. Reporting
   * the drift is far more useful than silently preferring either one - a
   * reconciliation that always "passes" is not checking anything.
   *
   * @param {object} observed map of token -> quantity actually held on-chain
   * @param {object} opts
   *   priceOf      token -> USD price, used to value the drift
   *   toleranceUsd absolute tolerance below which drift is not worth reporting
   */
  reconcile(observed, opts = {}) {
    const tolerance = Number(opts.toleranceUsd ?? 0.01);
    const priceOf = opts.priceOf;

    const expected = new Map();
    for (const [key, lots] of this.lots.entries()) {
      const token = key.slice(key.indexOf(':') + 1);
      let units = 0n;
      for (const l of lots) units += l.remaining;
      if (units > 0n) expected.set(token, (expected.get(token) || 0n) + units);
    }

    const symbols = new Set([...expected.keys(), ...Object.keys(observed || {})]);
    const positions = [];
    let totalDriftUsd = 0;

    for (const token of symbols) {
      const expUnits = expected.get(token) || 0n;
      const obsRaw = observed ? observed[token] : undefined;
      const obsUnits = obsRaw === undefined || obsRaw === null
        ? null
        : toBaseUnits(obsRaw, decimalsFor(token));

      if (obsUnits === null) {
        positions.push({ token, status: 'UNKNOWN', expected: expUnits.toString() });
        continue;
      }

      const diff = obsUnits - expUnits;
      if (diff === 0n) {
        positions.push({ token, status: 'OK', expected: expUnits.toString(), observed: obsUnits.toString() });
        continue;
      }

      const decimals = decimalsFor(token);
      const qty = Number(fromBaseUnits(diff, decimals));
      const price = typeof priceOf === 'function' ? Number(priceOf(token) || 0) : 0;
      const driftUsd = Math.abs(Number.isFinite(qty) ? qty * price : 0);
      totalDriftUsd += driftUsd;

      positions.push({
        token,
        status: driftUsd > tolerance ? 'DRIFT' : 'MINOR',
        expected: expUnits.toString(),
        observed: obsUnits.toString(),
        diffBaseUnits: diff.toString(),
        diffFormatted: (diff > 0n ? '+' : '') + fromBaseUnits(diff, decimals),
        driftUsd
      });
    }

    return {
      ok: totalDriftUsd <= tolerance,
      totalDriftUsd,
      toleranceUsd: tolerance,
      positions
    };
  }
}

/**
 * Rebuild a ledger from stored swap records.
 *
 * Ordering is enforced here rather than trusted from the caller: the trade log
 * is stored newest-first for display, which is exactly the wrong order for
 * FIFO. Sorting ascending is what makes a rebuilt ledger match the one that
 * would have been built live.
 */
function buildLedger(trades, opts = {}) {
  const ledger = new PortfolioLedger(opts);
  const ordered = (Array.isArray(trades) ? trades : [])
    .filter(Boolean)
    .filter((t) => {
      // Simulated paper trades are excluded, but only when they SAY they are.
      //
      // The browser now stamps every position it writes with
      // details.onchain = false, so that flag is the reliable marker. An
      // earlier version of this filter instead required a tx hash to be
      // present, which silently dropped every record that lacked one -
      // including the ledger's own historical fixtures - and reported a P&L
      // of zero. Absence of a hash is not proof of simulation.
      if (opts.includePaper) return true;
      const d = t.details || {};
      return d.onchain !== false;
    })
    .slice()
    .sort((a, b) => Date.parse(a.timestamp || 0) - Date.parse(b.timestamp || 0));

  for (const t of ordered) {
    const d = t.details || {};
    const fromToken = d.fromToken || (String(t.symbol || '').split('/')[0]);
    const toToken = d.toToken || (String(t.symbol || '').split('/')[1]);
    const derive = opts.deriveUsd;

    ledger.applyTrade({
      fromToken,
      toToken,
      fromAmount: d.fromAmount ?? t.amount,
      toAmount: d.toAmount,
      // USD legs are stored on the record when known; deriveUsd covers rows
      // logged before this existed.
      fromUsd: d.fromUsd ?? (typeof derive === 'function'
        ? derive(fromToken, d.fromAmount ?? t.amount, t.timestamp)
        : null),
      toUsd: d.toUsd ?? (typeof derive === 'function'
        ? derive(toToken, d.toAmount, t.timestamp)
        : null),
      gasUsd: d.gasCostUsd ?? d.gasUsd ?? 0,
      botId: t.agentId,
      timestamp: t.timestamp
    });
  }
  return ledger;
}

module.exports = {
  PortfolioLedger,
  buildLedger,
  COST_BASIS_METHODS,
  DEFAULT_COST_BASIS,
  usdToFixed,
  fixedToUsd,
  toBaseUnits,
  fromBaseUnits,
  decimalsFor
};

