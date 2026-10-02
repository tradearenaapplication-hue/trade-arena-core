#!/usr/bin/env node

/**
 * FUNDING ARB EXECUTOR - ORPHAN SAFETY TESTS
 * ============================================================================
 * The most dangerous state in a delta-neutral funding system is a filled perp
 * leg with no spot hedge: a naked short, on the only leg that can be
 * liquidated. These tests verify the executor from
 * FUNDING_ARB_BLUEPRINT.md §7.1 detects and unwinds that case rather than
 * ever returning it to the caller.
 *
 * Run: node scripts/test-funding-executor.js
 *
 * The venue adapters are mocked on purpose: the bug class being guarded
 * against lives in the barrier/orphan logic, not in REST payload shapes.
 */

'use strict';

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? `  [${detail}]` : ''}`); }
}

function withTimeout(promise, ms) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms); }),
  ]).finally(() => clearTimeout(t));
}

/**
 * Mock venue. `behaviour` decides what each submit() call does.
 *
 * `spotFill`/`perpFill` are per-leg because the orphan cases are DEFINED by
 * which leg filled. A single `fill` flag makes both legs behave identically,
 * which reproduces "neither filled" and never the interesting half-fill.
 * Leg identity comes from `postOnly` (spot) vs `reduceOnly === false` (perp).
 */
function mkVenue(behaviour) {
  const calls = [];
  return {
    calls,
    submit: async (order) => {
      calls.push(order);
      // Leg identity must be explicit. Inferring it from `reduceOnly` is
      // ambiguous because the SPOT opening order also omits reduceOnly.
      const leg = order.market || (order.postOnly ? 'spot' : 'perp');
      if (behaviour[leg + 'Hang']) return new Promise(() => {});
      if (behaviour[leg + 'Reject']) throw new Error(`${leg} exchange rejected`);
      const filled = behaviour[leg + 'Fill'] ? order.qty : 0;
      return { filledQty: filled, avgPx: order.price || 100 };
    },
    cancelAll: async () => {},
  };
}

function mkPortfolio() {
  const st = { started: [], closed: [], reconciled: 0 };
  return {
    state: st,
    beginPosition: (intent) => {
      const p = {
        id: intent.id, symbol: intent.symbol, qty: intent.qty,
        spot: { venue: intent.spotVenue, qty: 0 },
        perp: { venue: intent.perpVenue, qty: 0 },
        // delta is DERIVED, never assigned — the blueprint invariant.
        get delta() { return this.spot.qty - this.perp.qty; },
      };
      st.started.push(p);
      return p;
    },
    recordFill: (p, s, pr) => { p.spot.qty = s.filledQty; p.perp.qty = pr.filledQty; },
    reconcileAsset: async () => { st.reconciled++; return { delta: 0 }; },
    closePosition: (p, actual) => { st.closed.push({ id: p.id, delta: actual.delta }); },
  };
}

function mkRisk() {
  const r = { halted: false, hedged: 0, killed: [] };
  return {
    isHalted: () => r.halted,
    onHedged: () => { r.hedged++; },
    killSwitch: async (reason) => { r.halted = true; r.killed.push(reason); },
    state: r,
  };
}

/** TwoLegExecutor from the blueprint, private fields removed for direct construction. */
class TwoLegExecutor {
  constructor({ venues, portfolio, risk }) {
    this.venues = venues; this.portfolio = portfolio; this.risk = risk;
    this.warnings = [];
  }

  async openHedged(intent, { signal } = {}) {
    if (this.risk.isHalted()) throw new Error('risk engine halted');

    const ac = new AbortController();
    signal?.addEventListener('abort', () => ac.abort(), { once: true });

    // The position exists from intent, so a crash mid-flight leaves a visible
    // non-zero delta rather than a phantom "nothing happened".
    const position = this.portfolio.beginPosition(intent);

    const spotPromise = this.venues.get(intent.spotVenue).submit({
      symbol: intent.symbol, market: 'spot',
      qty: intent.qty, type: 'LIMIT', postOnly: true, signal: ac.signal,
    });
    // Perp is taker IOC: certainty on the liquidatable leg beats price.
    const perpPromise = this.venues.get(intent.perpVenue).submit({
      symbol: intent.symbol, market: 'perp',
      qty: intent.qty, type: 'MARKET_IOC', reduceOnly: false, signal: ac.signal,
    });

    const [spotRes, perpRes] = await Promise.allSettled([
      withTimeout(spotPromise, 120),
      withTimeout(perpPromise, 120),
    ]);

    const spotOk = spotRes.status === 'fulfilled' && spotRes.value?.filledQty > 0;
    const perpOk = perpRes.status === 'fulfilled' && perpRes.value?.filledQty > 0;

    if (spotOk && perpOk) {
      this.portfolio.recordFill(position, spotRes.value, perpRes.value);
      this.risk.onHedged(position);
      return position;
    }

    await this.unwindOrphan(position, { spotOk, perpOk });
    throw new Error(`orphan resolved: spotOk=${spotOk} perpOk=${perpOk}`);
  }

  async unwindOrphan(position, { spotOk, perpOk }) {
    const tasks = [];
    if (perpOk && !spotOk) {
      this.warnings.push('ORPHAN SHORT');
      tasks.push(this.venues.get(position.perp.venue).submit({
        symbol: position.symbol, market: 'perp',
        qty: position.perp.qty, type: 'MARKET_IOC', reduceOnly: true }));
    }
    if (spotOk && !perpOk) {
      this.warnings.push('ORPHAN LONG');
      tasks.push(this.venues.get(position.spot.venue).submit({
        symbol: position.symbol, market: 'spot',
        qty: position.spot.qty, type: 'MARKET_IOC' }));
    }
    await Promise.allSettled(tasks);
    // Verify against exchange truth rather than assuming the unwind worked.
    const actual = await this.portfolio.reconcileAsset(position.symbol);
    this.portfolio.closePosition(position, actual);
    if (Math.abs(actual.delta) > position.qty * 0.001) {
      await this.risk.killSwitch('unresolved-orphan');
    }
  }
}

const INTENT = {
  id: 't1', symbol: 'BTCUSDT', qty: 1,
  spotVenue: 'binance', perpVenue: 'binance',
};

async function run() {
  console.log('='.repeat(66));
  console.log('FUNDING ARB EXECUTOR - ORPHAN SAFETY');
  console.log('='.repeat(66) + '\n');

  // ── 1. Happy path ─────────────────────────────────────────────────────────
  console.log('1. HEDGED PATH');
  {
    const venue = mkVenue({ spotFill: true, perpFill: true });
    const venues = new Map([['binance', venue]]);
    const portfolio = mkPortfolio();
    const risk = mkRisk();
    const ex = new TwoLegExecutor({ venues, portfolio, risk });

    const pos = await ex.openHedged(INTENT);
    check('both legs filled produces delta === 0', pos.delta === 0, `delta=${pos.delta}`);
    check('counted as hedged exactly once', risk.state.hedged === 1);
    check('no orphan unwind was needed', portfolio.state.closed.length === 0);
    check('reconciliation not triggered', portfolio.state.reconciled === 0);

    // The spot leg must be post-only (maker) and the perp must be taker IOC.
    // This ordering is deliberate: certainty on the liquidatable leg beats
    // price, so we cross the spread on the perp and quote the spot.
    const spotOpen = venue.calls.find((c) => c.market === 'spot' && c.postOnly);
    const perpOpen = venue.calls.find((c) => c.market === 'perp' && c.reduceOnly === false);
    check('spot leg submitted post-only (maker)', !!spotOpen);
    check('perp leg submitted as taker IOC (reduceOnly=false)',
      !!perpOpen && perpOpen.type === 'MARKET_IOC');
  }

  // ── 2. Naked SHORT — the dangerous orphan ─────────────────────────────────
  console.log('\n2. ORPHAN SHORT (perp filled, spot did not) — DANGEROUS');
  {
    // Perp FILLS, spot does not. This is the state that gets people liquidated.
    const venue = mkVenue({ spotFill: false, perpFill: true });
    const venues = new Map([['binance', venue]]);
    const portfolio = mkPortfolio();
    const risk = mkRisk();
    const ex = new TwoLegExecutor({ venues, portfolio, risk });

    let threw = false;
    try { await ex.openHedged(INTENT); } catch { threw = true; }

    check('never returns an orphan to the caller', threw);
    check('flagged as ORPHAN SHORT', ex.warnings.includes('ORPHAN SHORT'));
    check('NOT counted as hedged', risk.state.hedged === 0);
    check('position was closed after unwind', portfolio.state.closed.length === 1);
    check('verified against exchange truth', portfolio.state.reconciled === 1);

    // The perp must be closed with reduceOnly=true so the unwind cannot
    // accidentally open a position in the opposite direction.
    const reduceOnly = venue.calls.filter((c) => c.reduceOnly === true);
    check('perp unwind used reduceOnly (cannot flip the position)',
      reduceOnly.length === 1, `reduceOnly calls=${reduceOnly.length}`);
  }

  // ── 3. Naked LONG ─────────────────────────────────────────────────────────
  console.log('\n3. ORPHAN LONG (spot filled, perp never settled)');
  {
    // Spot fills, perp hangs until the barrier trips.
    const venue = mkVenue({ spotFill: true, perpHang: true });
    const venues = new Map([['binance', venue]]);
    const portfolio = mkPortfolio();
    const risk = mkRisk();
    const ex = new TwoLegExecutor({ venues, portfolio, risk });

    let threw = false;
    try { await ex.openHedged(INTENT); } catch { threw = true; }

    check('never returns an orphan to the caller', threw);
    check('flagged as ORPHAN LONG', ex.warnings.includes('ORPHAN LONG'));
    check('position was closed after unwind', portfolio.state.closed.length === 1);
  }

  // ── 4. Kill switch escalation ─────────────────────────────────────────────
  console.log('\n4. ESCALATION when unwind cannot restore neutrality');
  {
    // Neither leg fills; the reconciler then reports a residual naked short
    // that the unwind failed to fix.
    const venue = mkVenue({ spotFill: false, perpFill: false });
    const venues = new Map([['binance', venue]]);
    const portfolio = mkPortfolio();
    // Reconciler reports a residual naked short the unwind failed to fix.
    portfolio.reconcileAsset = async () => ({ delta: 0.5 });
    const risk = mkRisk();
    const ex = new TwoLegExecutor({ venues, portfolio, risk });

    try { await ex.openHedged(INTENT); } catch { /* expected */ }

    check('kill switch triggered', risk.state.killed.length === 1);
    check('kill switch reason recorded',
      risk.state.killed[0] === 'unresolved-orphan');
    check('system left halted', risk.state.halted === true);
  }

  // ── 5. Halted system refuses new entries ──────────────────────────────────
  console.log('\n5. HALTED SYSTEM refuses entries');
  {
    const venue = mkVenue({ spotFill: true, perpFill: true });
    const venues = new Map([['binance', venue]]);
    const risk = mkRisk();
    risk.state.halted = true;
    const ex = new TwoLegExecutor({ venues, portfolio: mkPortfolio(), risk });

    let msg = '';
    try { await ex.openHedged(INTENT); } catch (e) { msg = e.message; }
    check('rejects the entry', msg === 'risk engine halted', msg);
  }

  console.log('\n' + '='.repeat(66));
  console.log(failed === 0
    ? `ALL ${passed} CHECKS PASSED`
    : `${failed} CHECK(S) FAILED (${passed} passed)`);
  console.log('='.repeat(66));

  // process.exit() discards buffered stdout when the stream is a pipe, which
  // silently swallows the whole report. Flush, then exit on the next tick.
  process.exitCode = failed === 0 ? 0 : 1;
}

// Give stdout a chance to flush before the process ends naturally.
run().catch((e) => {
  console.error('RUNNER FAILED:', e);
  process.exitCode = 1;
});
