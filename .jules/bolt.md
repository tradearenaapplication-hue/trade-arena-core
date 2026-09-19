## 2026-09-13 - Avoid Intermediate Array Allocations in Hot Indicator Loops
**Learning:** In hot calculation paths like `calculateIndicators` in `crucible-real-trading.js`, functional array methods (`map`, `slice`, `reduce`, `filter`) create multiple short-lived intermediate arrays per invocation. Replacing them with direct indexed loops and accumulating values in a single pass reduced indicator calculation execution time by over 80%.
**Action:** When computing indicators over candles/time series data, compute moving averages, gains/losses, and variance in direct loop passes without allocating temporary array projections.

## 2026-09-17 - Avoid Array.prototype.sort In Hot Iteration Loops
**Learning:** In hot trade simulation loops like `selectStrategyAI` in `crucible-ai-learning.js`, calling `Array.prototype.sort()` mutates arrays in place on every trade invocation, causing significant callback and array re-indexing overhead (~44x slowdown vs linear scan).
**Action:** Replace `Array.prototype.sort()` with a single-pass linear scan (`for` loop) when selecting top elements in hot loops to avoid array mutations and comparator callback overhead.

## 2026-09-18 - Memoize Static Candidate Pools and Model Lookups in Selection Routines
**Learning:** In model selection strategies like `MODEL_SELECTION.eloWeighted`, `costEfficient`, and `speedOptimal`, rebuilding candidate arrays and sorting static data on every invocation allocates temporary objects/arrays and runs sorting overhead (~11x to 35x slowdown).
**Action:** Pre-compute flat lookup maps and lazily memoize static candidate pools for static configuration objects to make selection operations O(1) array index lookups.
