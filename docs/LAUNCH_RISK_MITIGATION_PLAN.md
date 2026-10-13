# 🛡️ Trade Arena — Launch Risk Mitigation & Gate 3 Readiness Plan

## 📌 Overview & Risk Hierarchy

Accepting real user capital on an automated trading platform introduces systemic legal, financial, behavioral, and technical risks. This Launch Risk Mitigation Plan establishes a prioritized framework to eliminate existential threats before Gate 3 (Live Real-Money Trading Launch).

---

## 🎯 Priority Risk Matrix

| Priority | Risk Category | Threat Level | Primary Mitigation Strategy | Hard Deadline |
| :---: | :--- | :---: | :--- | :--- |
| **1** | **ASIC Regulatory Exposure** | 🛑 Existential | Programmatic Gate 3 Hard-Lock (`AFSL_COMPLIANT=true`) + 30-min Legal Counsel Briefing | Pre-Gate 3 Clearance |
| **2** | **Gambling-Brain UX Liability** | ⚠️ High | Engine-Level Safety Controls (Daily Loss Caps, Cooling-Off, Session Warnings) | Pre-Gate 3 Clearance |
| **3** | **Strategy Regime Risk** | ⚠️ Medium | Bear/Chop Regime Backtests & Strategy Transparency Warnings | Pre-Gate 3 Launch |
| **4** | **Cold Audience Acquisition** | 🟡 Medium | A$200 Meta Ads Funnel Test (Landing → Demo → Wallet Connect → Deposit) | Post-Gate 2 / Pre-Gate 3 |
| **5** | **Technical Infrastructure** | 🔵 Low / Ongoing | Railway Rollback Strategy, UptimeRobot Monitoring & Incident Protocol | Ongoing |

---

## 1. 🏛️ Risk 1: ASIC Regulatory Exposure (Existential Risk)

### Threat Analysis
Operating an automated trading platform in Australia where bots make autonomous decisions or manage user funds can trigger classification as a **Managed Investment Scheme (MIS)** under Chapter 5C of the *Corporations Act 2001 (Cth)* or a **Financial Service** requiring an Australian Financial Services Licence (AFSL) under s 911A. Unlicensed operation carries severe civil penalties (up to A$11M+) and statutory shutdown orders.

### Mitigation Framework & Programmatic Locks
1. **Gate 3 Hard-Lock (`trading-engine.js` & `execution-engine.js`):**
   - Real-money swaps and order execution are programmatically blocked unless `process.env.AFSL_COMPLIANT === 'true'`.
   - Backend swap endpoints (`/api/execute/swap`) return HTTP `403 Forbidden` when `AFSL_COMPLIANT` is false.
2. **30-Minute Legal Counsel Briefing Framework:**
   - Detailed in `docs/30_MINUTE_REGULATORY_COUNSEL_BRIEFING.md` and `docs/REGULATORY_AFSL_ASSESSMENT.md`.
   - Core objectives: Determine non-custodial software exemption, evaluate Corporate Authorised Representative (CAR) umbrella model, and finalize Target Market Determination (TMD).
3. **Regulatory Status API (`/api/regulatory/status`):**
   - Publicly reports jurisdiction (`Australia (ASIC)`), AFSL status (`PENDING_LEGAL_REVIEW`), and clearance flags.

---

## 2. 🎰 Risk 2: Gambling-Brain UX Liability (Public & Regulatory Protection)

### Threat Analysis
Trade Arena's engaging arcade/pokies visual framing accelerates user onboarding but creates significant liability if loss-chasing leads to user harm, press scrutiny, or Australian Consumer Law (ACL) regulatory attention.

### Mitigation Framework & Engine Guardrails
1. **Engine-Level Daily Loss Limits:**
   - $50 default daily net loss cap enforced at the core engine level (`trading-engine.js`).
   - Compulsory 24-hour delay required for any user-requested limit increase.
2. **Cooling-Off & Escalating Self-Exclusion:**
   - Hitting daily loss limits twice within 7 days triggers an un-overrideable 7-day execution lock.
   - Users can manually trigger 24-hour "Take-a-Break" or 7-day self-exclusion locks at any time.
3. **Session Interruption & Time Warnings:**
   - Automated periodic session notifications at 30, 60, and 90 minutes to break psychological loss-chasing loops.
4. **Defensible Legal Disclaimers:**
   - Prominent UI disclaimers clarifying simulated algorithmic trading vs financial product advice.

---

## 3. 📈 Risk 3: Strategy Regime Risk (Bear & Chop Market Robustness)

### Threat Analysis
The core strategy (69% oversold-buying) was backtested during a bullish market window (12 August – 11 September 2026). Long-biased strategies underperform severely in flat or choppy market regimes, leading to user churn and chargeback risks upon live deposit.

### Mitigation Framework
1. **Regime Backtesting Suite (`engine/crucible-v2.js`):**
   - Crucible V2 framework tests bot strategies across simulated `BULL`, `BEAR`, and `CHOP` market regimes.
2. **Dynamic Regime Adaptation & Warnings:**
   - Bot configuration panels surface strategy bias (e.g. "Long-Biased Mean Reversion") and regime suitability ratings.
   - Real-time volatility and trend regime detection automatically throttles bot trade frequency during unfavorable regime conditions.

---

## 4. 🎯 Risk 4: Cold Audience Acquisition Funnel (Conversion Proof)

### Threat Analysis
Warm lead interest does not equal cold audience conversion. High drop-off rates across any step of the conversion funnel (Landing Page → Demo Mode → Wallet Connection → First Deposit) can render customer acquisition unit economics unviable.

### Mitigation Framework & Pilot Campaign
1. **Meta Ads Pilot Campaign (A$200 Budget):**
   - Target demographic: Australian crypto enthusiasts aged 25–45 on Facebook and Instagram.
2. **Conversion Tracking Pipeline:**
   - Step 1: Landing Page view to Demo Mode activation.
   - Step 2: Demo Mode engagement to Wallet Connection (`checkGoLiveAck()` regulatory modal).
   - Step 3: Wallet Connection to initial deposit intention.
3. **Funnel Benchmarks & Rapid Iteration:**
   - Establish baseline conversion metrics within 48 hours to identify funnel friction points before scaling paid acquisition.

---

## 5. 🛠️ Risk 5: Technical Single Points of Failure & Infrastructure Hardening

### Threat Analysis
Deployment glitches, RPC node failures, or unmonitored outages during active user trades can cause unexecuted stop-losses or broken wallet states.

### Mitigation Framework
1. **Deployment & Rollback Standard:**
   - Single-command Railway deployment (`Dockerfile` / `nixpacks.toml`) with automated git commit rollback procedures.
2. **Uptime & Health Monitoring:**
   - Ping `/api/regulatory/status` and `/health` endpoints via UptimeRobot at 1-minute intervals.
   - PagerAlert notifications configured for HTTP non-200 responses.
3. **Graceful Fallbacks:**
   - Secondary Web3 RPC provider fallbacks for Base Mainnet.
   - Client-side error handling in `index.html` preventing UI lockups on API network timeouts.

---

## 📋 Pre-Gate 3 Checklist & Gate Clearance Summary

- [x] Programmatic AFSL Gate 3 Hard-Lock active in core engine & backend endpoints.
- [x] Engine-level Safety Controls & Responsible Gambling limits operational.
- [ ] 30-minute regulatory counsel briefing completed with Australian financial legal counsel.
- [ ] Crucible V2 regime backtests completed for Bear and Chop market scenarios.
- [ ] A$200 Meta Ads cold conversion funnel test completed.
- [ ] UptimeRobot monitoring active for Railway backend production instance.
