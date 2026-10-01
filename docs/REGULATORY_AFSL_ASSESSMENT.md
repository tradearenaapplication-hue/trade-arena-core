# Trade Arena - AFSL Exposure & Regulatory Assessment

## Overview
This document assesses Trade Arena's regulatory exposure under Australian law (ASIC enforcement guidelines and the *Corporations Act 2001*) and outlines the legal preparation checklist prior to Gate 3 real-money launch.

---

## Key Risk Factors

### 1. Autonomous Trading & Financial Services Definition
* **Risk:** Automated AI bots taking trading actions on behalf of users with real funds can be interpreted as providing a financial service or managing discretionary accounts.
* **Mitigation:**
  - Non-custodial architecture: Trade Arena never holds user funds or private keys.
  - Parameter control: User sets parameters (trade size, daily loss limit, stop-loss).
  - Hard-locked live execution until AFSL clearance (`process.env.AFSL_COMPLIANT === 'true'`).

### 2. Managed Investment Scheme (MIS) Exposure
* **Risk:** If funds are pooled or bot strategies operate as a collective investment vehicle, ASIC RG 240 / Corporations Act s 9 may apply.
* **Mitigation:**
  - Individual wallet execution only; no pooling of capital or shared liquidity vaults.

### 3. AFSL Legal Preparation Checklist
- [ ] Consult AFSL legal counsel (A$10,000–A$30,000 budget, 30-minute scoping call).
- [ ] Review Regulatory Guide 255 (Automated financial software).
- [ ] Verify non-custodial UI disclosures in `index.html` modal (`ta_golive_ack`).
- [ ] Maintain engine and server-level hard lock (`AFSL_COMPLIANT`).

---

## Gate 3 Status
**STATUS: LOCKED (AFSL Clearance Pending)**
Real-money trade execution is blocked by default until `process.env.AFSL_COMPLIANT='true'`.
