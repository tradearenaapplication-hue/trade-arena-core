# REGIME EDGE RESEARCH

## The short version

**On 4h crypto bars, after an 80bps round trip, none of the strategies tested
demonstrated a real edge.** That is the measured result, and it is reported
honestly rather than dressed up.

```bash
npm run cache:prime      # download real candles once
npm run research:edge    # search for a validated edge
```

---

## Why "NO EDGE FOUND" is the expected output

Three facts about this market combine to make short-horizon retail strategies
close to unprofitable by construction:

| Quantity | Value | Consequence |
|---|---|---|
| Cost per round trip | 80bps (0.30% fee + 0.10% slippage, × 2 legs) | — |
| Typical 4h bar move | ~1% | A trade must move **0.8%** just to break even |
| Standard error on a win rate at n≈80 | ~11pp | Anything smaller than that is indistinguishable from luck |

So a 1-bar trade needs a directional move roughly equal to its own cost. The
search confirms this directly: BTC at horizon 1 produced a **0.0% win rate
across 5 trades** — every single trade lost more to costs than the market moved.

This is not a bug in the search, and it is not a claim that trading is
impossible. It is a statement about this cost structure at this timeframe.

---

## What the search actually does

Most "I found an edge" backtests contain the same three mistakes. This one
avoids all three by construction.

### 1. Out-of-sample validation

Data is split chronologically. All 21 variants are ranked on the **first
half** only. The top 3 are then run **once** on the second half, which the
selection never saw. Only OOS results count as evidence.

Selecting and evaluating on the same data is how a losing strategy becomes a
backtest that prints 65% win rates.

### 2. Multiple-testing correction

Testing 21 variants guarantees the best one looks good by chance — roughly a
1-in-20 shot even on pure noise. The significance threshold is Bonferroni-
adjusted:

```
alpha = 0.05 / 21 = 0.00238
```

An edge must beat that, not the naive 0.05. Without this step, a search over
21 variants on a random walk "finds" an edge about 65% of the time.

### 3. A bar-matched coin-flip control

The benchmark is not buy-and-hold and not nothing — it is **random direction,
same bars, same costs**. This matters: a selective strategy that trades 20% of
bars must not be compared against a control that pays costs on every bar, or
selectivity alone looks like skill.

### 4. No look-ahead

Every indicator is **causal**: the value at bar `i` uses only bars `≤ i`.
Signals form on bar `i`, entries execute at bar `i+1`'s close. This is verified
by a regression test that truncates the price series and asserts every
already-computed indicator value is **bit-identical**.

### 5. Realistic costs

0.30% taker fee + 0.10% slippage, charged on **entry and exit**. `STRESS_1_5X`
multiplies by 1.5. A backtest that ignores costs is fiction.

---

## Validation of the validator

The lab is tested on synthetic data where the answer is known:

| Scenario | Expected | Actual |
|---|---|---|
| Strong drift (real exploitable trend) | **find** the edge | ✅ 17.4pp, p≈0 |
| Pure random walk | **no** edge | ✅ 2.2pp inside 5.3pp noise, p=0.46 |
| Random walk, 1-bar hold (costs dominate) | **no** edge | ✅ correctly none |
| Truncated series | indicators unchanged | ✅ zero drift |

A search that always finds an edge is just a random-number generator wearing a
lab coat. These tests prove it can say "no".

---

## Measured results

30 days of real 4h candles (CoinGecko OHLC), 80bps round trip:

```
  bitcoin  h= 1   none    5 trades  WR  0.0% vs control  0.0%   edge  0.0pp (noise 44.7pp)  p=1.000
  bitcoin  h= 4   none   85 trades  WR 23.5% vs control 17.6%   edge  5.9pp (noise 10.8pp)  p=0.343
  bitcoin  h=12   none   77 trades  WR 26.0% vs control 26.0%   edge  0.0pp (noise 11.4pp)  p=1.000
  bitcoin  h=24   none   65 trades  WR 40.0% vs control 32.3%   edge  7.7pp (noise 12.4pp)  p=0.361
```

Note BTC at h=24: a 7.7pp edge is the closest anything comes to significance,
and it is still comfortably **inside** the 12.4pp noise band. That is the
signature of luck, not edge.

---

## The diagnostic that answers "where do I look?"

Run `npm run research:cost`. It re-runs the whole search across a range of
transaction costs. This separates two problems that look identical from inside
a normal backtest but have **opposite** solutions:

| Where the edge appears | What is binding | The fix |
|---|---|---|
| Only at low costs | The **venue** | Cheaper pool, trade less, longer holds |
| Only at high costs | **Volatility** is clearing the fee | Trade the HIGH_VOL regime deliberately |
| **Nowhere, including zero cost** | The **market** | Change signal family entirely |

### Measured result: nowhere, including zero

```
VALIDATED EDGES BY COST LEVEL (out of 30 configs)
  cost(rt)     bitcoin  ethereum  solana  dogecoin  arbitrum  pepe   TOTAL
       0bps          0         0       0         0         0     0      0
      20bps          0         0       0         0         0     0      0
      40bps          0         0       0         0         0     0      0
      80bps          0         0       0         0         0     0      0
     160bps          0         0       0         0         0     0      0
```

And at **zero cost**, where execution cannot be blamed:

```
bitcoin  h=24  WR=40.0%  P&L=-47.26  PF=0.65  (SMA Trend)
solana   h=24  WR=58.5%  P&L=-35.51  PF=0.80  (Vol-Target Trend)
ethereum h=24  WR=24.6%  P&L=-140.82 PF=0.20  (SMA Trend)
```

Every strategy loses money with **perfect, free execution**. A high win rate
(58.5%) paired with a profit factor of 0.80 is the classic signature of small
wins and larger losses — the market is not mispricing direction here.

For comparison, doing nothing beats all of them:

```
buy-and-hold, same window:  BTC +8.06   ETH +10.14   SOL +16.47
```

**This is the strongest negative result available.** Cost cannot explain it,
because cost has been removed entirely. These five strategy families have no
directional signal in this data, and no fee reduction will create one.

---

## What this rules out

- **Lower fees** — already tested down to 0bps. No effect.
- **More indicators** — five families / 21 variants tested. Adding a sixth
  mostly manufactures false positives, which is why the search Bonferroni-
  corrects for exactly that.
- **Parameter tuning** — the same overfitting trap in slower motion.

---

## What actually has a chance

Ranked by evidence, not by hope.

### 1. Direction-independent strategies *(the real answer)*

Every strategy tested tries to **predict direction** — will price go up or down.
That is the hard problem, and the data says it is not solvable here with these
signals.

Strategies that don't predict direction sidestep it entirely:

| Family | Why it can work without predicting direction |
|---|---|
| **Long volatility / long gamma** | Profits when price moves *either* way, only needs magnitude |
| **Cross-asset spreads** | Profits when two correlated assets diverge, market-neutral |
| **Basis / funding capture** | Collects a structural yield that exists regardless of direction |
| **Liquidation-reward farming** | Paid for a service, not a price prediction |

This is the structural shift that matters. **An unpredictable market does not
defeat a strategy that never needed predictability.**

### 2. Get more data before concluding anything

At 30 days there are ~80 out-of-sample trades, giving a **±12pp noise band**. A
real 5% edge is statistically invisible at that sample size. This limits what
the current run can detect — it does not prove a 2% edge does not exist.

Use daily bars over 2+ years: hundreds of independent observations, and the
noise band collapses to a few percentage points.

### 3. Trade less, if you keep directional trading

Cost is per round trip regardless of hold length:

```
hold  1 bar  ->  80.00bps per bar held
hold  4 bars ->  20.00bps per bar held
hold 24 bars ->   3.33bps per bar held
hold 48 bars ->   1.67bps per bar held
```

Fewer, larger trades genuinely lower the drag. That is a real effect — but it
is a *cost* reduction, not an *alpha* source, and the zero-cost table above
shows it cannot rescue these signals on its own.

---

## The uncomfortable but important part

Buy-and-hold beat every strategy tested over the same window. That is a
statement about the strategies, not about the market — someone trading this
system with real money is currently paying 80bps per trade to lose less than
simply holding.

Two honest options:

1. **Pause live trading** and gather data. Turn the arena into a research
   environment rather than a P&L machine. Nothing here says the venue or the
   concept is wrong — only that these particular strategies, at this cost, on
   this timeframe, do not have a demonstrable edge.

2. **Rebuild the signal layer** around direction-independent strategies, and
   keep this search harness as the gate. Any new strategy must beat the
   coin-flip control out-of-sample before it goes near real funds.

The search harness is the durable asset here. It is deliberately built to say
"no" — a backtest that always finds an edge is a random-number generator
wearing a lab coat. Point it at a new strategy and it will tell you the truth
about that too.



---

## Files

| File | Purpose |
|---|---|
| `regime-strategy-lab.js` | Strategy library, causal indicators, backtester, statistics |
| `crucible-regime.js` | Real candle fetching, caching, cost model, regime classification |
| `scripts/prime-candle-cache.js` | Downloads candles once (avoids CoinGecko rate limits) |
| `scripts/search-regime-edge.js` | Runs the search across assets and horizons |
| `scripts/verify-crucible-regime.js` | Verifies the panel's numbers against live data |

Strategy families tested: **SMA Trend**, **Donchian Breakout**,
**RSI Mean Reversion** (CHOP only), **Vol-Target Trend**,
**Pullback in Trend** (BULL/BEAR only) — 21 parameter variants total.
