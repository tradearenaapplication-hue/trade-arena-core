# 🛡️ Trade Arena — Top 5 Launch Risks & Comprehensive Mitigation Plan

## 📌 Executive Overview & Priority Hierarchy

Launching Trade Arena involves specific regulatory, reputational, technical, financial, and audience acquisition risks. To ensure platform viability, survival, and defensibility, launch risks are prioritized based on existential severity:

1. **ASIC Regulatory Exposure (Existential Risk — Hard Deadline before Gate 3 Real User Funds)**
2. **Gambling-Brain UX & Legal Liability (Reputational & Regulatory Protective Guardrails)**
3. **Strategy Regime Risk (Bear & Chop Market Validation)**
4. **Cold Audience Acquisition Funnel (Unproven Conversion Metrics)**
5. **Technical Single Points of Failure & Infrastructure Hardening (Deployment & Operational Resiliency)**

---

## 🏛️ Risk 1: ASIC Regulatory Exposure & AFSL Gate 3 Clearance (Priority 1 — Existential)

### Problem Definition
ASIC has intensified scrutiny on automated trading platforms, crypto financial products, and AI-driven trade execution since 2024. If Trade Arena's bots execute autonomous trading decisions on behalf of retail users with real funds (pooled or individual), ASIC may classify the service as:
1. **A Managed Investment Scheme (MIS)** under Chapter 5C of the *Corporations Act 2001 (Cth)*.
2. **An Unlicenced Financial Service Provider** dealing in financial products or providing automated financial product advice under section 911A.

Operating without an AFSL when required carries civil penalties (up to A$11M+), criminal liability, and immediate platform shutdown.

### Mitigation & Gate 3 Hard-Lock Architecture
- **30-Minute Regulatory Briefing:** A structured 30-minute consultation with Australian financial services counsel must occur before any real user funds touch platform smart contracts or execution endpoints (see `docs/30_MINUTE_REGULATORY_COUNSEL_BRIEFING.md` and `docs/REGULATORY_AFSL_ASSESSMENT.md`).
- **Software-Enforced Gate 3 Hard-Lock:** Real-money execution is programmatically blocked across all layers unless explicitly authorized (`process.env.AFSL_COMPLIANT === 'true'`):
  - `TradingEngine.executeTrade()` in `trading-engine.js`: Rejects real-money bot orders with `status: 'BLOCKED_AFSL_COMPLIANCE_GATE'`.
  - `executeOnChainTrade()` in `execution-engine.js`: Throws `Error('AFSL Compliance Gate 3 Lock...')`.
  - `/api/execute/swap` in `server.js`: Returns HTTP `403 Forbidden` with Gate 3 error message.
- **Regulatory Status API:** Exposes `/api/regulatory/status` confirming jurisdiction (`Australia (ASIC)`), assessment status (`PENDING_LEGAL_REVIEW`), and active Gate 3 locks (`afslCompliant: false`).

---

## 🎰 Risk 2: Gambling-Brain UX & Public Reputation Liability (Priority 2 — Protective)

### Problem Definition
Trade Arena's arcade/pokies framing provides a strong product differentiator, but creates immediate exposure under Australia's aggressive gambling harm framework and press scrutiny if a user suffers significant losses.

### Mitigation & Engine-Level Safety Controls
- **Engine-Level Daily Loss Limits:** Net daily loss limits (default $50.00 cap) enforced in `trading-engine.js` rather than client-side UI, preventing client bypasses.
- **Compulsory 24-Hour Delay on Limit Increases:** Lowering loss limits takes effect immediately, but increasing limits requires a mandatory 24-hour cooling window.
- **Self-Exclusion & Escalating Cool-Offs:**
  - "Take-a-Break" (24h) and 7-day self-exclusion options.
  - Automatic escalation to an un-overrideable 7-day cool-off if a user breaches their daily loss limit twice within 7 days.
- **Periodic Session Duration Warnings:** Non-intrusive notifications at 30m, 60m, and 90m session intervals to interrupt loss-chasing behaviour.

---

## 📈 Risk 3: Strategy Regime Risk — Bear & Chop Market Backtests (Priority 3 — Product Confidence)

### Problem Definition
Current backtests cover bullish BTC/ETH market conditions (e.g., Aug–Sep 2026). Oversold-buying strategies (69% long-biased) risk severe drawdown during market chop or bear regimes, leading to user loss, churn, and potential chargebacks.

### Mitigation & Crucible V2 Multi-Regime Framework
- **Crucible V2 Backtesting (`crucible-test.js`):** Multi-regime validation covering `BULL`, `BEAR`, `CHOP`, and `HIGH_VOL` regimes with realistic fee/slippage models (`REALISTIC_1X`, `STRESS_1_5X`).
- **Transparent Regime Labeling & Adaptive Risk Sizing:**
  - Automated market regime classification based on RSI, ATR, and SMA indicators.
  - Adaptive position sizing (`CrucibleRealTrading`) reducing exposure automatically during high volatility or consecutive strategy drawdowns.
- **User Disclosure:** Explicit UI reporting on strategy suitability across different market regimes.

---

## 🎯 Risk 4: Cold Audience Acquisition Funnel (Priority 4 — Funnel Validation)

### Problem Definition
Interest from warm contacts does not prove cold audience conversion. Converting strangers from social ads (Meta / TikTok) to wallet connection and crypto deposit involves multi-step friction where drop-off rates can exceed 90%.

### Mitigation & Low-Cap Test Plan
- **A$200 Targeted Test Campaign:** Run localized Meta ad campaign targeting Australian crypto enthusiasts (aged 25–45) to measure exact conversion drop-offs.
- **Funnel Tracking Milestones:**
  1. Landing Page Click → Demo / Paper Trading Start
  2. Paper Trading Start → Web3 Wallet Connect (MetaMask / Privy)
  3. Wallet Connect → First Testnet/Mainnet Deposit
- **Optimized Onboarding:** Frictionless Web3 onboarding via Privy/MoonPay integration alongside paper trading sandbox defaults.

---

## ⚙️ Risk 5: Technical Single Points of Failure & Infrastructure Hardening (Priority 5 — Continuous)

### Problem Definition
Deployment glitches, single-server downtime on Railway, or unmonitored server crashes could freeze active positions during market swings.

### Mitigation & Resiliency Architecture
- **Railway Production Deployment:** Configured via `Dockerfile`, `nixpacks.toml`, `railway.json`, and `Procfile` targeting Railway Node.js environment.
- **Uptime Monitoring:** External health monitoring via `/api/regulatory/status` and `/healthcheck` pinging endpoints.
- **Deployment Rollback Plan:** Instant rollback capability via Railway CLI / GitHub release tagging.
- **Error Boundaries & Logging:** Circuit breakers in `proxy.js` and `server.js` with structured maintenance logging (`/api/maintenance/log`).

---

## 📋 Launch Gate Summary Matrix

| Launch Gate | Permitted Activity | Real User Funds? | Legal / Compliance Requirement |
| :--- | :--- | :--- | :--- |
| **Gate 1 (Demo / Backtest)** | Local paper trading & Crucible V2 simulation | ❌ Prohibited | General terms & simulated capital warning |
| **Gate 2 (Testnet / Warm Leads)** | Testnet execution & non-custodial wallet link | ❌ Prohibited | ASIC regulatory disclosure modal (`#goLiveModal`) |
| **Gate 3 (Public Beta / Real Funds)** | Live mainnet swap & bot trading | ⚠️ ONLY WITH SIGN-OFF | **30-min legal counsel review & AFSL_COMPLIANT=true sign-off** |
