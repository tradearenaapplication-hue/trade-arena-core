## 2025-06-15 - Redundant UI and DOM updates
**Learning:** The Trade Arena codebase exhibited a pattern where expensive UI updates (O(N) calculations, SVG rendering, and DOM manipulation) were performed for a hidden "Quant Report" panel on every trade closure. Additionally, redundant DOM structures with duplicate IDs were present, bloating the document and causing unnecessary element processing.
**Action:** Always implement early return checks in UI update functions to verify visibility (e.g., via CSS classes like `open`) before executing heavy computations. Audit the HTML for copy-paste redundancies that lead to duplicate IDs and bloated DOM trees.

## 2026-06-18 - High-frequency UI Churn and Redundant Lookups
**Learning:** Trade P&L tickers were performing redundant `bots.find` O(N) lookups and `getElementById` calls every 2 seconds. Global balance updates were being triggered by every individual ticker, causing O(N^2) total work when multiple positions were open.
**Action:** Cache DOM elements and pass object references (e.g., `bot`) to tickers to avoid repeated lookups. Centralize global updates (like balance) in a fixed-frequency timer rather than individual async loops. Use dirty-checking/state-caching to skip DOM writes when values haven't changed.

## 2026-09-21 - Intermediate Array Allocations in High-Frequency Technical Indicator Functions
**Learning:** High-frequency technical indicator calculations in `CrucibleRealTrading.calculateIndicators` were instantiating multiple temporary intermediate arrays per candle evaluation (`candles.map`, `closes.slice`, `changes.filter`), causing significant CPU overhead and GC pressure during trading cycles.
**Action:** Replace functional array pipelines (`map`/`filter`/`reduce`) in high-frequency numerical analysis routines with single-pass loops over input data structures using scalar accumulators and typed arrays (`Float64Array`).

## 2026-10-14 - Redundant DOM Matrix Redraws in Acoustic Core Pad Grid Updates
**Learning:** `renderPadGrid` in `trading-engine.js` was executing `.map().join()` string building and full `grid.innerHTML` overwrites on every timer tick regardless of whether bot P&L states had actually changed. In a multi-bot live environment, this caused frequent layout recalcs and DOM churn.
**Action:** Implement lightweight state hashing across entity values (`${bot.id}:${pnl};`) to perform fast scalar dirty checking. Return early to bypass string concatenation and DOM `innerHTML` assignments when values are identical.

## 2026-11-04 - Redundant Array Allocations and Sorting in Summary Reporting
**Learning:** `TRADE_OLYMPICS.getSummary()` was triggering full leaderboard array allocations and sorting (`getLeaderboard("elo")`), multiple array `.reduce()` passes, and `Object.keys()` calls every time ELO summaries were rendered or queried.
**Action:** Cache total static entity counts (`_bracketCount`) during initialization/load and perform single-pass `for...in` loop accumulation over standings objects to gather totals and max values in a single O(N) scalar pass without array allocations or sorting overhead.

## 2026-11-18 - Redundant Config Object Clones in High-Frequency Opportunity Scanners
**Learning:** Arbitrage and sports prediction scanners (`calculatePredictionMarketEdge`, `calculateFlashLoanArb`, `removeVig`) were executing redundant object spread cloning (`{ ...DEFAULT_CONFIG, ...config }`) and intermediate array projections for every market outcome and quote pair in high-frequency loops. This caused significant object allocation overhead and GC pressure during multi-market scanning passes.
**Action:** Access configuration properties directly with nullish coalescing defaults (`config.prop ?? DEFAULT.prop`) and construct output objects in a single pass without intermediate array or object spread allocations.

## 2026-12-02 - Redundant Object Entry/Value Array Allocations in Tournament Bracket Summaries
**Learning:** `getTopBrackets()` and `getGlobalWeights()` in `TRADE_OLYMPICS` were allocating intermediate tuple arrays (`Object.entries()`) and executing multiple array `.filter()` / `.map()` / `.reduce()` passes over 700+ bracket objects on every ranking query, causing noticeable GC pressure and execution latency (~7.4s / 50k calls).
**Action:** Use guarded `for...in` loops (`hasOwnProperty`) over target hash objects to accumulate active entries in a single pass before sorting, reducing loop overhead by ~1.9x while preserving object property spreads.

## 2026-12-16 - Redundant Array Allocations in Bot Strategy State Updates and Insight Queries
**Learning:** `updateBotStateAfterTrade`, `getBotStrategyInsights`, and `getIntelligentAutoTradeRecommendation` in `ai-strategies.js` were allocating temporary arrays and callback closures on every trade cycle and UI query via `.filter()`, `.reduce()`, and `Object.entries().sort()`. In high-frequency bot execution loops, this created unnecessary GC pressure.
**Action:** Replace intermediate array methods (`.filter()`, `.reduce()`, `Object.entries().sort()`) in strategy tracking and insight routines with single-pass scalar `for` and `for...in` loops to accumulate win counts, sum totals, and find best methods in scalar time (~20.4% speedup).

## 2026-12-30 - Array Slicing and Filtering Overhead in High-Frequency Volatility Regime Evaluation
**Learning:** `updateAIState()` in `crucible-ai-learning.js` was creating temporary sub-arrays via `.slice(-50)` and `.filter()` on every AI state update during 1000-trade evaluation loops, generating unnecessary heap allocations and GC pauses.
**Action:** Replace `.slice(-50)` array copy and `.filter()` callback passes in sliding window calculations with bounded backward `for` loops over target array indices (~3.2x speedup and 0 array allocations).

## 2027-01-14 - Object Entries and Array Chaining in ELO Tournament Arena UI Updates
**Learning:** `renderEloArena()` in `elo-tournament-engine.js` was allocating key-value tuple arrays on every render pass via `Object.entries(eloState.agents)` and chaining `.map().join('')` to format agent status HTML rows, generating heap churn and garbage collection pressure during continuous ELO tournament updates.
**Action:** Replace `Object.entries()` array allocations and `.map().join()` method chaining in UI render loops with key collection arrays and direct string accumulation (`+=`) in a scalar `for` loop.

## 2027-01-28 - Intermediate Array Allocations and Slice Chaining in AI Arena Tournament Prompt Building & Insights
**Learning:** `getAIModelDecision` and `getArenaInsights` in `ai-arena.js` were executing duplicate `.slice(0, 8)` sub-array copies, `.map().join()` string building, `.reduce()` callback passes, and `Object.entries(perf).map()` tuple array allocations on every tournament cycle and performance query.
**Action:** Consolidate sub-array slicing and reduction into a single-pass indexed `for` loop accumulating prompt summaries and volatility averages in scalar time, and replace `Object.entries()` with guarded `for...in` loops prior to sorting (~20.8% - 35.7% speedup).
