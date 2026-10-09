# 🛡️ Trade Arena — Top 5 Launch Risks Mitigation Plan

## Executive Overview
This document outlines the priority mitigation framework for Trade Arena's top five existential launch risks. The priority order reflects urgency and potential business impact:

1. **ASIC Regulatory Exposure** (Hard deadline prior to accepting real funds at Gate 3)
2. **Responsible Gambling Mechanics** (Engine-level user protection & brand defense)
3. **Strategy Regime Risk** (Bear & choppy market performance validation)
4. **Cold Audience Acquisition Funnel** (Conversion metric validation)
5. **Technical Single Points of Failure** (Infrastructure resiliency & rollback readiness)

---

## Risk 1: ASIC Regulatory Exposure (Existential / Gate 3 Hardstop)

### Context & Impact
ASIC has increased scrutiny on automated trading platforms and crypto-asset financial products. If Trade Arena bots execute autonomous orders on behalf of users with real funds, ASIC may classify the service as:
- A **Managed Investment Scheme (MIS)** under Chapter 5C of the *Corporations Act 2001 (Cth)*.
- An **AFSL-regulated financial service** (automated financial advice or dealing).

Operating without an AFSL when required risks severe civil penalties and immediate shutdown.

### Mitigation & Gate 3 Clearance Protocol
1. **Legal Counsel Briefing:** Execute a 30-minute consultation with Australian financial services regulatory counsel using `docs/30_MINUTE_REGULATORY_COUNSEL_BRIEFING.md` and `docs/REGULATORY_AFSL_ASSESSMENT.md`.
2. **Software-Enforced Hard Locks:**
   - Real-money execution in `trading-engine.js`, `execution-engine.js`, and `/api/execute/swap` is hard-locked behind `process.env.AFSL_COMPLIANT === 'true'`.
   - Rejection status: `BLOCKED_AFSL_COMPLIANCE_GATE`.
3. **Paper Trading & Software Tool Classification:** Maintain non-custodial user-directed simulation and demo modes until formal legal clearance is obtained.

---

## Risk 2: Responsible Gambling Mechanics & Safety Controls

### Context & Impact
The gamified / pokies-inspired UX provides strong differentiation but creates target exposure with regulators and media if users experience uncontrolled losses.

### Mitigation & Technical Implementation
1. **Engine-Level Safety Controls:**
   - Safety rules are enforced inside `trading-engine.js` (not client-side only).
   - **Daily Loss Limits:** User-configurable daily drawdown limits.
   - **Cooling-Off Delays:** Compulsory 24-hour delay when attempting to increase daily loss limits.
   - **Self-Exclusion & Cool-Off Locks:** 24-hour "Take-A-Break" and 7-day self-exclusion modes.
   - **Automatic Escalation:** Triggering daily loss limit twice within 7 days forces an un-overrideable 7-day cool-off.
2. **Session & Transparency Controls:**
   - Display session duration warnings and clear risk disclaimers across the platform (`checkGoLiveAck` and `ta_golive_ack` localStorage key).

---

## Risk 3: Strategy Regime Risk (Bear & Chop Validation)

### Context & Impact
Historical backtesting covering August–September 2026 reflects a bullish market. Because 69% of automated strategies rely on oversold buying, performance in flat or choppy markets must be proven before scaling real user deposits.

### Mitigation & Strategy Hardening
1. **Multi-Regime Backtesting (`runCrucibleV2`):**
   - Execute Crucible backtests against simulated BEAR and CHOP market regimes (`runCrucibleV2({ regime: "BEAR", weeks: 4, costModel: "REALISTIC_1X" })`).
2. **Dynamic Regime Detection & Guardrails:**
   - Integrate market regime detection to adjust position sizing or pause long-biased bots during prolonged downtrends.
3. **Transparent Performance Expectations:**
   - Display historical drawdown metrics and market condition suitability directly on strategy selection cards.

---

## Risk 4: Cold Audience Acquisition Funnel

### Context & Impact
Conversion metrics from warm contacts (friends/network) do not represent cold traffic behavior. Dropped conversion rates at key steps can severely impede scaling.

### Mitigation & Conversion Testing
1. **Funnel Stage Tracking:**
   - Track micro-conversions: `Landing Page Visit` ➔ `Demo Mode Start` ➔ `Wallet Connection` ➔ `First Deposit / Trial Trade`.
2. **A/B Meta Ad Testing:**
   - Allocate A$200 in targeted Meta ads (Australian crypto enthusiasts, ages 25–45) to measure exact acquisition costs (CAC) and funnel drop-off rates within 48 hours.
3. **Friction Reduction:**
   - Streamline MetaMask / Web3 onboarding and provide instant feedback messages on wallet status (`checkMetaMaskStatus` & `diagnoseMetaMask`).

---

## Risk 5: Technical Single Points of Failure & Infrastructure

### Context & Impact
Running on Railway with recent deployment migrations presents risks of deployment outages while open positions are active.

### Mitigation & Production Hardening
1. **Rollback Readiness:**
   - Maintain clean Git release tags and automated rollback steps in Railway.
2. **Uptime Monitoring:**
   - Integrate HTTP & WebSocket health ping monitoring (e.g., UptimeRobot pinging `/api/regulatory/status` and `/health`).
3. **Incident Response Process:**
   - Pre-define operational procedures for emergency trading pause, user notification status banners, and mobile alert routing.
