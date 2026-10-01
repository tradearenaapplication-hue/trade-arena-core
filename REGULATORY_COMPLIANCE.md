# Trade Arena - ASIC Regulatory Compliance Framework & Gate 3 Criteria

## Executive Summary
This document defines Trade Arena's Australian Securities and Investments Commission (ASIC) regulatory compliance framework, Australian Financial Services Licence (AFSL) exposure assessment, and Gate 3 clearance criteria prior to enabling real user funds or live trading execution.

---

## 1. ASIC Regulatory Focus (2024–2026)
ASIC has increased enforcement scrutiny surrounding automated trading tools, AI trading bots, and crypto-asset financial products:
* **Financial Product Classification:** Autonomous bots executing trades with pooled or individual user funds may be classified as dealing in a financial product or managing a Managed Investment Scheme (MIS) under the *Corporations Act 2001* (Cth).
* **AFSL Requirements:** Operating a financial service or providing automated financial advice/execution without an AFSL (or an appropriate exemption/authorised representative arrangement) carries significant civil and criminal penalties.
* **Licensing Timeline & Cost:** Obtaining an AFSL typically requires A$10,000–A$30,000+ in legal fees and 6–12 months of review.

---

## 2. Gate 3 Clearance Criteria
Real-money execution and automated on-chain swaps with real user funds are **HARD-LOCKED** by default. Gate 3 clearance requires fulfilling the following conditions:

1. **Formal Legal Advice:**
   * A written opinion from a qualified Australian financial services lawyer confirming either:
     a) Trade Arena's non-custodial software interface does not constitute an MIS or financial service requiring an AFSL; OR
     b) An AFSL exemption or Authorised Representative framework has been established.
2. **Technical Hard-Lock Verification:**
   * Real-money execution endpoints in `server.js`, `trading-engine.js`, and `execution-engine.js` MUST check `process.env.AFSL_COMPLIANT === 'true'`.
   * When `AFSL_COMPLIANT` is not explicitly set to `'true'`, all real-money execution calls are blocked with error:
     `AFSL Compliance Gate 3 Lock: Real-money execution requires AFS license clearance or AFSL_COMPLIANT=true`.
3. **Explicit User Acknowledgment:**
   * The frontend MUST enforce non-custodial and risk disclosures via modal (`#goLiveModal` / `checkGoLiveAck()`) persisted in `localStorage` under `ta_golive_ack`.

---

## 3. Boundary Definition: Demo Mode vs. Live Execution
* **Demo Mode / Simulation:** Uses zero real funds, synthetic trading logs, and rule-based or server-proxied LLM signals. Does not touch real-world DEX smart contracts or custodial accounts.
* **Live Execution (Gate 3 Protected):** Involves real-money swaps, DEX aggregator calls, or wallet signature triggers. Hard-locked until AFSL compliance is certified.

---

## 4. Immediate Action Items Before Gate 3 Release
1. Schedule a 30-minute consultation with an AFSL legal specialist.
2. Maintain `AFSL_COMPLIANT=false` in all staging and production environment configs until legal sign-off.
3. Keep full automated test coverage asserting that real-money execution fails whenever `AFSL_COMPLIANT` is unset or false.
