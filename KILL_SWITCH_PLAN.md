# Kill-Switch + Hardcoded Daily Caps — T-002 Implementation Spec

Prepared 2026-11-18 (AEDT) as research, not yet built. Local clone only, nothing
pushed, demo/paper mode only. Implements BACKLOG.md T-002 (Critical).

## What was verified in the code (2026-11-18)

1. **The red EMERGENCY STOP button is browser-only.** `index.html:1891`
   (`#killBtn`, `onclick="globalKill()"`) sets a browser variable
   `globalKilled=true` (`index.html:3848-3862`), stops the browser's
   paper-trading bots and their timers, and never calls the server. A live
   swap or the server-side worker is unaffected by it.
2. **No server kill-switch exists.** `server.js` has no `/api/admin/*`
   route at all (checked the full `app.get`/`app.post` list). There is no
   global halt flag, and nothing calls `AutonomousWorker.stop()` from any
   endpoint — `stop()` exists (`services/AutonomousWorker.js:60-68`) but is
   only reachable in-process.
3. **The swap endpoints have no size cap and ignore the safety state.**
   `handleSwapRequest` (`server.js:2287`, wired at `:2513` and `:2516` as
   `/api/wallet/swap` and `/api/execute/swap`) validates that `amount` /
   `amountUSD` is a positive number, then calls the on-chain engine. It
   never reads `serverSafetyState` — that state (`server.js:1451-1466`,
   daily loss limit $50 + take-a-break cooling) is only returned by
   `GET /api/safety-controls` and written by `POST /api/safety-controls/update`.
   So cooling-off / daily-loss limits do not block a live swap today.
4. **Worker caps are env-configurable, not hardcoded, and worker-only.**
   `AutonomousWorker` defaults (`services/AutonomousWorker.js:23-32`):
   `maxTradeUsd $500`, `maxPositionUsd $1000`, `maxDailyLossUsd $100`,
   `maxSlippageBps 100`, `maxOpenPositions 5`, with a 24h sliding
   `dailySpendUsd` tracker. All are overridable via `.env`, and none of
   them apply to the manual swap endpoints. The worker is off by default
   (`AUTONOMOUS_WORKER_ENABLED=true` required, `server.js:2985-2999`).
5. **A client-side 10% drawdown breaker already exists** (`index.html:2067`,
   `drawdownPct=10`, `checkGlobalBreakers` at `:3692-3700`) — paper/demo
   only, same limitation as the kill button.

## Design (5 parts, all server-side, fail closed)

1. **Global halt flag.** In-memory `let killSwitchEngaged = false` plus
   `engagedAt` / `engagedBy` / `reason`, next to `serverSafetyState`
   (`server.js` ~line 1451). In-memory on purpose: a restart clears it
   only if that is the chosen behaviour — see open decision 3 below.
   Default at boot: disengaged.
2. **Admin endpoints** (new, next to `/api/safety-controls` ~line 1479):
   - `POST /api/admin/kill-switch` `{ action: "engage" | "disengage", reason? }`
     → engages: sets the flag, calls `AutonomousWorker.stop()` (require the
     singleton the same way the boot block does), returns
     `{ success, engaged, engagedAt }`. Must halt swap requests in under
     1 second (T-002 acceptance) — the flag check is synchronous, so this
     holds as long as no swap is mid-flight; in-flight swaps cannot be
     recalled on-chain, and the spec must say so.
   - `GET /api/admin/kill-switch/status` → `{ engaged, engagedAt, reason }`
     so the UI can show the real state instead of the browser-only one.
   - Auth: no admin auth exists in the app today. Follow the existing
     `ALLOWED_TRADERS` fail-closed pattern: require an `ADMIN_TOKEN` env
     value, sent as `x-admin-token` header; if the env var is unset the
     endpoint refuses everything (503/401). Never accept engage/disengage
     without it. Open decision 1.
3. **Gate the swap path.** At the top of `handleSwapRequest`, before any
   pricing or engine call: if `killSwitchEngaged` → `503
   { success:false, error:'TRADING_HALTED' }`; if cooling-off active
   (`Date.now() < serverSafetyState.coolingUntil`) → `503` with the
   cooling reason. This covers both `/api/wallet/swap` and
   `/api/execute/swap` because they share the handler.
4. **Hardcoded caps in the swap path** (T-002 numbers, not env overrides):
   - Max single trade 0.05 ETH. `amountUSD` trades: price via the existing
     `onchainEngine.usdToTokenAmount` and compare in ETH terms; if pricing
     fails, reject (fail closed) rather than guessing.
   - Aggregate 24h sliding-window spend cap 0.5 ETH, tracked in-memory
     (list of `{ at, eth }`, pruned to the last 24h on each check) and
     incremented only after a successful engine call. Applies to the swap
     endpoints; the worker keeps its own USD tracker for now — reconciling
     the two into one ledger is follow-up work, flagged in the code.
   - Per-bot 10% loss halt (T-002 acceptance: a simulated 11% loss halts
     the bot immediately): wire the worker tick to halt that bot when
     realised+unrealised loss exceeds 10% of its configured capital, using
     the existing `PositionManager` pricing. This is the largest sub-task;
     if it blows out, ship parts 1–3 first and do this as a second pass.
5. **Wire the UI button to the server.** `globalKill()` in `index.html`
   keeps its local behaviour (stop browser bots instantly) AND `POST`s to
   `/api/admin/kill-switch` with the admin token flow; on success the
   button state comes from `GET /api/admin/kill-switch/status` on load,
   so a refresh cannot silently show trading as live when the server is
   halted. The button must not be able to disengage without the token.

## Tests to add (`tests.js`, custom harness — follow the existing pattern)

New `describe("Global Kill-Switch & Hardcoded Caps (T-002)")`, resolving
routes from `server.router.stack` by path and handlers by name, calling
handlers with mock req/res like the existing "Swap Execution Endpoint
Security" suite does (`tests.js:2187+`):
- kill-switch route exists; engaging it makes the next `handleSwapRequest`
  call return 503 `TRADING_HALTED` without touching the engine.
- disengage without a valid admin token is refused; disengage with it
  restores swaps.
- swap with `amountUSD` pricing above the per-trade cap is rejected 400;
  spend above the 24h cap is rejected 400; both error strings are exact.
- cooling-off active → swap returns 503 (covers the currently dead
  safety-controls wiring).
- worker `stop()` clears its interval (already exists; assert via the
  singleton, no new behaviour needed).
- full suite still passes with 0 failures (`node tests.js`) and
  `/health` stays healthy after a restart.

## Open decisions for Dan (do not guess)

1. **Admin token:** create an `ADMIN_TOKEN` in `.env` (fail closed when
   unset), or is there another auth he prefers? Who holds it — only Dan?
2. **Cap units:** T-002 says 0.5 ETH/day and 0.05 ETH/trade; the worker
   already speaks USD ($500/trade, $100/day). Keep ETH per the ticket, or
   align the swap path to the worker's USD caps?
3. **Restart behaviour:** should a server restart clear an engaged
   kill-switch (in-memory, simple) or persist it to disk so a halt
   survives a reboot (safer, more code)?
4. **Scope:** ship the halt + caps first and do the per-bot 10% loss halt
   second, or all of it in one pass?

## Recommended defaults (added 2026-11-18, for one-word approval)

Dan has not answered the four open decisions yet (asked 2026-11-18
17:14 AEDT, no reply as of 17:48 AEDT). These defaults let him approve
with a single "go with defaults" instead of answering four questions.
Each follows the ticket or an existing pattern; nothing here is guessed
from thin air.

1. **Admin token: generate a fresh `ADMIN_TOKEN` in `.env`, held only
   by Dan, fail-closed when unset.** Follows the existing
   `ALLOWED_TRADERS` fail-closed pattern in the plan. The token value
   itself is never committed.
2. **Cap units: ETH, per T-002 — 0.05 ETH per trade, 0.5 ETH per 24h.**
   The ticket is explicit, and the worker's USD caps ($500/trade,
   $100/day loss) stay as-is on the worker path. Reconciling the two
   ledgers stays flagged follow-up work, as the plan already notes.
3. **Restart behaviour: persist the halt to disk so it survives a
   restart.** This is the one default that departs from the simplest
   option, and the reason is in the repo: `railway.json` sets
   `restartPolicyType: ON_FAILURE` with up to 10 retries, so a crash
   auto-restarts the server. An in-memory halt would clear on that
   restart and trading would silently resume — exactly the failure a
   kill-switch exists to prevent. Disengage stays via the admin
   endpoint with the token, so a persisted halt can always be cleared
   deliberately. Small extra code (one state file), worth it.
4. **Scope: halt + caps first, per-bot 10% loss halt second.** The
   per-bot halt is the largest sub-task (needs `PositionManager`
   pricing wired into the worker tick); parts 1–3 are shippable and
   testable on their own.

If Dan approves these defaults, build parts 1–3 (+ UI wiring) in one
pass, then the per-bot halt as a second pass.

## After building

- Local only: run `node tests.js` (0 failures), restart the server,
  verify `/health`, engage/disengage via curl against the running server.
- Do NOT push, do NOT enable live trading, do NOT set `ADMIN_TOKEN` to a
  real value in any committed file. The two PWA icons and the MoonPay fix
  are still unpushed separately — this does not change that.
