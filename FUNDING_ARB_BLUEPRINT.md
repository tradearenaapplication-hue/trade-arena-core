# Market-Neutral Funding Rate Arbitrage — Architecture

Production blueprint for delta-neutral spot-perp funding arbitrage across CEX
venues (Binance, Bybit, OKX).

> **Read §0 before the code.** It decides whether this system makes money.

---

## 0. The risks that actually kill these systems

"Delta-neutral" describes **price** risk on a healthy venue with live markets.
It does not describe the five ways this trade loses money. All five are
survivorship-biased away in the backtests that make the strategy look safe.

### 0.1 Basis divergence — the one that ends careers

The hedge is only delta-neutral **while both venues are liquid**. In a crash
they are not.

```
Timeline (BTC −20% in 90 seconds):
  t=0s    spot 100.00   perp 100.00     delta = 0    ✓
  t=45s   spot  94.00   perp  88.00     delta = 0    ✓  (both legs, same size)
  t=60s   spot  85.00   perp  80.00     delta = 0    ✓
  t=70s   PERP EXCHANGE DRAWS  →  position liquidated at 80.00
  t=90s   spot  82.00   no hedge        delta = −18.00  ✗  18% naked short
```

You are liquidated on the perp while still holding spot. **The hedge does not
travel with you.** On 12 March 2020 and 9 March 2023 (SVB), BTC dropped 20–25%
in hours and perps printed large basis dislocations. Everyone running this
"market neutral" was short perp against a falling spot with collateral they
could not meet.

Mitigation (§5) is: small size, high collateral buffer, and a kill switch that
trades *liquidity*, not price.

### 0.2 Funding flips

You are short perp, collecting funding. When sentiment turns, funding goes
negative and **you pay**. Funding is not a yield product — it is a transfer
between longs and shorts that reverses. BTC funding spent stretches near zero
or negative through 2023–24. An 11% APY backtest assuming 11% forever is wrong.

### 0.3 The funding spike is usually the exit signal

Funding is highest when the crowd is most one-sided — right before a reversal.
Buying the spike means systematically selling into crowded positioning.
Filtering for *stable* funding rather than peak funding is the most valuable
single refinement, which is why §4.2 exists.

### 0.4 Liquidation math is the wrong mental model

Most people compute liquidation for the *pair*. Exchanges compute it for the
*perp position in isolation*. Your spot holding provides **zero** margin credit
on most CEX perps. Margin absorbs a move, and margin is finite.

§5.1 implements the exchange's formula, not the intuitive one.

### 0.5 Counterparty and operational risk

- Exchange insolvency or withdrawal freeze — you cannot move collateral out.
- API key compromise → someone opens a position with your funds.
- ADL (auto-deleveraging) can close your profitable perp against you.
- Cross-venue collateral is **not** shared. Balance on Binance does not margin
  a position on Bybit.

---

## 1. Relationship to the existing repo

| | Existing repo | This system |
|---|---|---|
| Venue | Uniswap v3 on Base | Binance, Bybit, OKX |
| Instruments | ERC-20 spot only | Spot + perpetual swaps |
| Execution | On-chain tx, nonce, gas | REST/WS order APIs, no gas |
| Margin | None | Cross or isolated, per-venue |
| Counterparty | Pool LPs | Exchange solvency risk |
| Latency | Block time + inclusion | Network + matching engine |

No shared code. `OnchainExecutionEngine` exposes `getUniswapV3Quote`,
`unwrapWeth`, `getNextNonce` — all on-chain. It has no concept of a position, a
fill, or a margin ratio. This is built **alongside**, not on top.

---

## 2. End-to-end data flow

```
   ┌──────────────┐   L2 book   ┌──────────────┐
   │  BINANCE WS  │────────────►│              │
   ├──────────────┤             │  MarketState │◄──── funding history (REST)
   │   BYBIT WS   │────────────►│   (singleton)│◄──── mark / index price
   ├──────────────┤             │              │
   │    OKX WS    │────────────►│              │
   └──────────────┘             └──────┬───────┘
                                        │ Observer (subscribe)
        ┌───────────────────────────────┼───────────────────────────────┐
        ▼                               ▼                               ▼
 ┌─────────────┐              ┌─────────────────┐            ┌──────────────┐
 │  SCANNER    │              │   RISK ENGINE   │            │  PORTFOLIO   │
 │ ranks pairs │─────────────►│ limits, liq,    │◄──────────►│ delta ledger │
 └─────────────┘  candidates  │ circuit breaker │  approval  │  positions   │
                     │       └─────────────────┘            └──────────────┘
                     ▼                                            ▲
              ┌─────────────┐   two-leg atomic                  │
              │  STRATEGY  │────────────────────────────────────┘
              │ funding-arb │
              └──────┬──────┘
                     │ intent (asset, size, venues)
              ┌──────▼──────┐   depth check   ┌──────────────────┐
              │ PREFLIGHT   │───────────────►│     EXECUTOR     │
              │ depth/slip  │  reject if bad │ concurrent legs  │
              └─────────────┘                └────────┬─────────┘
                                                     │ fills
                                              ┌──────▼──────┐
                                              │ RECONCILER  │ exchange truth
                                              └──────┬──────┘
                                                     │ actual delta
```


---

## 3. Directory structure

```
funding-arb/
├── src/
│   ├── core/
│   │   ├── types.js          Domain types + branded units
│   │   ├── money.js          Decimal-safe arithmetic (float dollars banned)
│   │   ├── events.js         Observer/EventBus
│   │   └── clock.js         Funding countdown, settlement calendar
│   ├── ingestion/
│   │   ├── book.js          L2 book + depth/market-impact model
│   │   ├── venue.js         VenueAdapter interface (the only contract)
│   │   └── venues/
│   │       ├── binance.js
│   │       ├── bybit.js
│   │       └── okx.js
│   ├── math/
│   │   ├── funding.js       APY matrix, net-of-everything (§4.1)
│   │   ├── reversion.js     Funding velocity, Bollinger filter (§4.2)
│   │   ├── basis.js         De-peg z-score vs rolling history (§6.2)
│   │   └── liquidation.js   Exchange-accurate liq price + buffer (§5.1)
│   ├── strategy/
│   │   ├── strategy.js      Strategy interface
│   │   ├── funding-arb.js   The delta-neutral funding strategy
│   │   └── scanner.js       Cross-asset ranking (§4.3)
│   ├── execution/
│   │   ├── preflight.js     Depth/slippage gate — refuses bad orders
│   │   ├── executor.js      Atomic two-leg execution (§7)
│   │   └── reconciler.js    Exchange-truth delta reconciliation
│   ├── risk/
│   │   ├── limits.js        Position/notional/venue caps
│   │   ├── circuit-breaker.js Basis de-peg + funding shock (§6)
│   │   └── kill-switch.js   Global halt + forced unwind
│   ├── portfolio/
│   │   ├── position.js      Delta ledger (source of truth for exposure)
│   │   └── compounding.js   Funding reinvestment
│   └── index.js             Composition root + lifecycle
├── config/
│   └── default.json         All tunables in one reviewable place
└── test/
```

---

## 4. Signal generation and filtering

### 4.1 Net APY — the formula that actually decides trades

Gross funding yield is the number that gets quoted. It is not the number you
earn. Every cost below is real and they compound badly.

```
                    fundingRatePerInterval × intervalsPerYear
   GROSS_APY  =    ────────────────────────────────────────────
                                        1

   Entry cost (paid once, amortised over the holding period):
   roundTripFeePct = feeBps(entry spot + exit spot
                          + entry perp + exit perp) / 10_000

   amortisedEntryPct = roundTripFeePct / expectedHoldDays

   BORROW_APY    = borrowRate × (marginUsed / notional)     [only if spot on margin]
   TRANSFER_APY  = oneWayWithdrawalCost / capital, annualised

            GROSS_APY
   NET_APY = ─────────── − amortisedEntryPct − BORROW_APY − TRANSFER_APY
```

Three things that matter and are usually wrong:

1. **Amortisation.** Entry fees are one-off but funding is a flow. Comparing
   an annualised rate to a one-off cost without amortising is the most common
   error in this strategy, and it makes a 0.01%/8h trade look far better than
   it is.
2. **Hold-horizon assumption.** A 90-day hold amortises entry cost over 90
   days; a 7-day hold does not. The scan must use your *actual* expected hold.
3. **Fee tier.** Maker vs taker changes entry cost by 4–5×. Post-only entry
   assumes maker fills you may never receive.

Worked example (BTC, Binance, 0.01%/8h, 8h intervals):

```
   GROSS_APY        = 0.0001 × 3 × 365        =  10.95%
   roundTripFeePct  = (2 × 10 + 2 × 5)/10000  =   0.30%   (2 taker + 2 maker)
   hold 90 days     → amortised 0.0033%/day   =   1.22%
   NET_APY          = 10.95 − 1.22            =   9.73%
   hold 7 days      → amortised 0.043%/day    =  15.6%
   NET_APY          = 10.95 − 15.6            =  −4.7%   ← LOSS
```

Same signal, opposite conclusion, purely from the hold assumption. This is why
`expectedHoldDays` is a first-class parameter and not a constant.

### 4.2 Funding reversion filter — avoid the spike before the reversal

```
   velocity = (funding_now − mean_7d) / std_7d
   zScore   = |funding_now − mean_30d| / std_30d

   RULES (any fail → do NOT enter):
     • zScore > 2.0              outlier, not a regime
     • velocity > 1.5σ           crowding accelerating
     • funding sign flipped      within last 3 intervals
     • funding below cost floor  cannot cover entry amortisation
```

`requireStable` (default true) demands funding stay within ±1σ for the last 6
consecutive intervals. This deliberately reduces trade count — that is the point.

### 4.3 Cross-asset scoring

Rank *liquidity*, not just yield. A 40% APY on a thin book is untradeable.

```
   liquidityScore = min(1, orderBookDepthUsd(targetNotional) / targetNotional)
   volScore       = clamp(realisedVol_30d / 0.50, 0, 1)
   fundingScore   = clamp(netAPY / 0.30, 0, 1)
   venueScore     = max over venues of (1 − fundingRateVolatility_24h)

   TOTAL = 0.40·liquidity + 0.25·funding + 0.20·venue + 0.15·vol
```


---

## 5. Risk engine

### 5.1 Liquidation — the exchange's formula, not the intuitive one

For an isolated-margin SHORT, the exchange liquidates when equity in the margin
account falls below maintenance margin.

```
   SHORT, entry E, size Q, maintenance rate mm, wallet balance W:

   liqPrice = E − (W − feesReserve) / (Q × mm)

   cross margin uses the whole collateral balance for W instead.

   BUFFER — distance from mark, sign-aware:
   buffer = (liqPrice − mark) / mark          (short)

   REQUIRED:  buffer > minBufferPct            (default 0.40)
```

If `buffer` drops below the floor the engine adds collateral; below the
critical floor it unwinds **both** legs. Note the asymmetry that bites people:
**a short's buffer shrinks as price rises**, so a squeeze hurts a
"delta-neutral" position exactly when everyone else's does.

### 5.2 Circuit breakers

| Trigger | Action |
|---|---|
| Basis z-score > 3σ | Halt new entries, widen buffer floor |
| Basis z-score > 4σ **or** spot/perp divergence > 2% | Halt all, unwind perp first |
| Funding flips negative while short | Halt entries; position now pays |
| Any venue WS silent > 5s | Halt entries — stale book worse than no book |
| Reconciliation delta ≠ 0 for > 2 polls | Halt, force reconcile |

### 5.3 Kill switch

Ordered shutdown, triggered by operator, breaker, or exception:

1. Cancel all open orders, all venues, **in parallel**
2. Unwind **perp leg first** (the leg that can be liquidated)
3. Then unwind spot
4. Reconcile, report actual final delta
5. Refuse restart until a human clears it

Step 2 before 3 is deliberate: the perp is the leg with the deadline.

---

## 6. Data structures

The single most important invariant:

> **`Portfolio` is the only source of truth for exposure.** Caches, the scanner
> and the UI are all derived. Nothing else may hold an authoritative position
> size, because two disagreeing copies is how a hedge silently disappears.

```js
// A position is keyed by asset and ALWAYS carries both legs.
// A one-legged position is representable (it briefly exists mid-execution)
// but is flagged, not hidden.
{
  asset: 'BTC',
  spot: { venue, side: 'LONG',  qty, avgPx },
  perp: { venue, side: 'SHORT', qty, avgPx,
          liqPrice, marginMode, walletBal },
  delta:  computed,      // spot.qty·(+1) + perp.qty·(−1)  → must be 0
  fundingAccrued: number,
  openedAt: epochMs,
  state: 'PENDING' | 'HEDGED' | 'UNWINDING' | 'BROKEN'
}
```


---

## 7. Execution — the part that must be right

Two legs cannot be atomic. There is always a window where one is filled and the
other is not. The design goal is to make that window **small, measured, and
automatically unwound** — not to pretend it does not exist.

**Concurrent submission, completion barrier, forced unwinding of any orphan.**

```
  t=0ms    submit spot  (post-only limit, maker)   ─┐
  t=0ms    submit perp  (IOC limit, taker)          ─┤ concurrent
  t=250ms  await both                              ─┘
            ├── both filled → confirm delta ≈ 0 → HEDGED
            ├── spot filled only  → ORPHAN LONG  → immediately sell spot back
            └── perp filled only  → ORPHAN SHORT → immediately buy perp back  ← URGENT
```

The two failure branches are **not symmetric**:

- **Orphan long** (spot filled, perp didn't): capped loss, time to fix.
- **Orphan short** (perp filled, spot didn't): **naked short into an unknown
  move**, on the leg that can be liquidated.

This asymmetry is why the perp is submitted as a taker IOC and the spot as a
maker post-only: **you accept crossing the spread to guarantee the dangerous
leg is covered first.** Post-only on the spot also means no fees on the unwind
path in the common case, because the resting order never traded.

### 7.1 Async skeleton

```js
// funding-arb/src/execution/executor.js
'use strict';

const LEG_TIMEOUT_MS = 250;   // completion barrier

class TwoLegExecutor {
  #venues; #portfolio; #risk; #log;
  #inflight = new Map();   // intentId -> AbortController

  constructor({ venues, portfolio, risk, log }) {
    this.#venues = venues; this.#portfolio = portfolio;
    this.#risk = risk; this.#log = log;
  }

  /**
   * Open a funding-arb entry: spot LONG + perp SHORT, delta-neutral.
   * NEVER returns without either both legs hedged, or both legs unwound.
   * An orphan is never handed back to the caller.
   */
  async openHedged(intent, { signal } = {}) {
    if (this.#risk.isHalted()) throw new Error('risk engine halted');

    const id = intent.id;
    const ac = new AbortController();
    this.#inflight.set(id, ac);
    const onOuterAbort = () => ac.abort();
    signal?.addEventListener('abort', onOuterAbort, { once: true });

    try {
      // The position exists from intent, so the reconciler sees a non-zero
      // delta if we die mid-flight. It starts BROKEN, not HEDGED.
      const position = this.#portfolio.beginPosition(intent);

      // Both legs submitted concurrently.
      const spotPromise = this.#venues.get(intent.spotVenue).submit({
        symbol: intent.symbol, market: 'spot',
        side: 'BUY', qty: intent.qty,
        type: 'LIMIT', price: intent.spotLimitPrice,
        postOnly: true,                 // never cross the spread
        clientOrderId: `${id}:spot`, signal: ac.signal,
      });

      // Perp goes as taker IOC: we WANT this filled immediately. This is the
      // leg that can be liquidated, so certainty beats price here.
      const perpPromise = this.#venues.get(intent.perpVenue).submit({
        symbol: intent.symbol, market: 'perp',
        side: 'SELL', qty: intent.qty,
        type: 'MARKET_IOC',
        reduceOnly: false,              // opening, not reducing
        clientOrderId: `${id}:perp`, signal: ac.signal,
      });

      const [spotRes, perpRes] = await Promise.allSettled([
        withTimeout(spotPromise, LEG_TIMEOUT_MS),
        withTimeout(perpPromise, LEG_TIMEOUT_MS),
      ]);

      const spotOk = spotRes.status === 'fulfilled' && spotRes.value?.filledQty > 0;
      const perpOk = perpRes.status === 'fulfilled' && perpRes.value?.filledQty > 0;

      if (spotOk && perpOk) {
        this.#portfolio.recordFill(position, spotRes.value, perpRes.value);
        this.#risk.onHedged(position);
        this.#log.info('hedged', { id, delta: position.delta });
        return position;
      }

      // ── ORPHAN PATH: this is the whole point of the design ──────────────
      await this.#unwindOrphan(position, { spotOk, perpOk });
      throw new Error(`orphan resolved: spotOk=${spotOk} perpOk=${perpOk}`);

    } finally {
      this.#inflight.delete(id);

  /**
   * Unwind whichever leg is naked. URGENT path first: a filled perp with no
   * spot is a naked short and must be closed before anything else.
   */
  async #unwindOrphan(position, { spotOk, perpOk }) {
    const tasks = [];

    if (perpOk && !spotOk) {
      // NAKED SHORT — the dangerous orphan. Buy perp back as taker, NOW.
      this.#log.warn('ORPHAN SHORT - unwinding perp immediately', { id: position.id });
      tasks.push(this.#venues.get(position.perp.venue).submit({
        symbol: position.symbol, market: 'perp',
        side: 'BUY', qty: position.perp.qty,
        type: 'MARKET_IOC', reduceOnly: true,
      }).catch((e) => this.#log.error('perp orphan unwind FAILED', e)));
    }

    if (spotOk && !perpOk) {
      // Naked long. Capped loss, still urgent. Sell spot back as taker.
      this.#log.warn('ORPHAN LONG - unwinding spot', { id: position.id });
      tasks.push(this.#venues.get(position.spot.venue).submit({
        symbol: position.symbol, market: 'spot',
        side: 'SELL', qty: position.spot.qty,
        type: 'MARKET_IOC',
      }).catch((e) => this.#log.error('spot orphan unwind FAILED', e)));
    }

    // Both run concurrently — sequential unwinds cost double.
    await Promise.allSettled(tasks);

    // Verify against exchange truth rather than assuming success.
    const actual = await this.#portfolio.reconcileAsset(position.symbol);
    this.#portfolio.closePosition(position, actual);

    if (Math.abs(actual.delta) > position.qty * 0.001) {
      // Still naked after unwind attempts. Escalate.
      this.#log.error('STILL NAKED after unwind - escalating', actual);
      await this.#risk.killSwitch('unresolved-orphan', position);
    }
    return actual;
  }

  /** Cancel everything. Safe to call twice. */
  async cancelAll() {
    await Promise.allSettled([...this.#inflight.values()].map((ac) => ac.abort()));
    await Promise.allSettled([...this.#venues.values()].map((v) => v.cancelAll()));
  }
}

function withTimeout(promise, ms) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms); }),
  ]).finally(() => clearTimeout(t));
}
```

**Why `allSettled` and not `all`:** `Promise.all` rejects on the first failure
and leaves the other leg's fate unknown. That is exactly the state you cannot
afford to be uncertain about.

---

## 8. Capital efficiency

**Unified (cross) margin** — one collateral pool per venue. Cheapest to run;
highest liquidation risk, because the spot position can be liquidated to cover
perp losses.

**Isolated margin** — separate collateral per position. Higher capital
requirement, but a bad trade cannot consume collateral backing other positions.
Required for anything above trivial size.

```js
// Sizing is constrained by the WEAKER of capital and liquidation buffer.
// Working capital alone is a bug: it ignores the only risk that can zero you.
usable = min(
  freeCollateral × maxDeployPct,
  notionalThatKeepsBufferAbove(minBufferPct)   // ← §5.1
);
```

Solving `notionalThatKeepsBufferAbove` for a short:

```
   buffer = (liqPrice − mark)/mark ≥ minBuffer
   ⟹  liqPrice ≥ mark·(1 + minBuffer)
   ⟹  E − (W − fees)/(Q·mm) ≥ mark·(1 + minBuffer)
   ⟹  Q ≤ [ E − mark·(1 + minBuffer) ] · mm / (W − fees)
```

Substituting E > mark (in profit) the numerator is positive and Q is bounded.
Substituting E < mark the numerator goes negative and **Q must be 0** — you
cannot open a leveraged short into a state that puts you under the maintenance
buffer immediately. Rejecting that case is the entire point.

---

## 9. Design patterns

| Pattern | Where | Why |
|---|---|---|
| **Strategy** | `strategy/` | Swap the alpha without touching execution or risk |
| **Observer** | `core/events.js` | One market-state publisher, many subscribers; no component polls another |
| **Adapter** | `ingestion/venues/` | Each exchange's quirks isolated behind one interface |
| **Singleton** | `MarketState`, `Portfolio` | One truth for prices and exposure (§6) |
| **Circuit Breaker** | `risk/` | Repeated failures stop being retried |
| **State Machine** | position `state` | Pending→Hedged→Unwinding→Broken; illegal transitions rejected |

---

## 10. What I would build first

**In this order:**

1. `MarketState` + ingestion, **read-only, for two weeks**. Log the basis. Do
   not trade. Confirm your funding and basis data matches the exchange UI
   exactly — if it doesn't, every downstream number is wrong.
2. `Portfolio` + `Reconciler` in dry-run. Confirm delta is always 0 when idle.
3. `Scanner` + APY maths, paper. Check the trade list against manual
   calculation on 10 assets by hand.
4. `Preflight` + `Executor` on testnet, then small size: one asset, one venue.
5. Only then multi-venue, sizing, compounding.

**Do not build until the above works:**

- **Auto-compounding.** Cosmetic until the edge is proven, and it adds a
  rebalancing path that can open fresh execution risk automatically.
- **ML/LLM signal generation.** You do not have a validated edge to feed it.
- **Cross-venue simultaneous execution.** Do single-venue (spot + perp on the
  *same* exchange) until the executor is boringly reliable. Cross-venue adds
  transfer latency and counterparty risk for no gain at this size.

---

## 11. Sizing guidance

Start with capital you can lose entirely, in full, without it affecting your
life. Not "most of it."

- 1 asset, 1 venue (spot + perp on the same exchange)
- Position sized so liquidation buffer stays **> 60%**, not 40%
- Max 10% of capital deployed
- Auto-compounding disabled
- Run ≥ 3 funding intervals (24h) before drawing any conclusion

The most common failure in this strategy is not a bad signal — it is a
correctly-signed position sized too large, held through a basis dislocation,
and liquidated while hedged.



