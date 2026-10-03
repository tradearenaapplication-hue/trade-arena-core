# 🏛️ Trade Arena - 30-Minute Regulatory Counsel Briefing Framework
**Target Jurisdiction:** Australia (ASIC)
**Applicable Statute:** *Corporations Act 2001* (Cth), RG 104, RG 175, RG 240, INFO 225
**Objective:** Gate 3 Real-Money Launch Legal Classification & AFSL Relief Assessment

---

## 📋 Consultation Agenda (30 Minutes)

### 1. Platform & Product Architecture Briefing (10 Mins)
- **Non-Custodial Interface:** Users connect self-custodial Web3 wallets (e.g. Base Mainnet / MetaMask / Privy). Trade Arena never holds user funds or private keys.
- **Automated Algorithmic Agents:** AI bots execute trading strategies based on user-configured risk thresholds and rules.
- **Paper Trading vs Live Execution:** Default mode is virtual paper trading. Live trading requires explicit user wallet transaction signing.

### 2. Regulatory Classification & Threshold Assessment (10 Mins)
- **Financial Product Advice (s 766B):** Does automated signal generation or bot recommendation trigger General or Personal Advice under s 766B?
- **Dealing in Financial Products (s 766C):** Does automated wallet execution constitute "dealing" on behalf of users?
- **Managed Investment Scheme (s 9):** Does user participation in automated strategy vaults constitute a pooled scheme or common enterprise under Chapter 5C?

### 3. Exemption Routes & Corporate Structure Options (5 Mins)
- **Software Provider Relief:** Viability of operating under non-custodial software/fintech tool exemptions.
- **Corporate Authorised Representative (CAR):** Operating under an existing AFSL holder's licence umbrella to lower initial compliance overhead (A$10,000–A$30,000 application vs CAR agreement).
- **AUSTRAC Assessment:** AML/CTF registration requirements for fiat on-ramp integrations (MoonPay/Ramp).

### 4. Action Plan & Gate 3 Clearance Sign-Off (5 Mins)
- Review required platform disclaimers and Target Market Determination (TMD).
- Establish formal criteria for enabling `AFSL_COMPLIANT=true` flag.

---

## 🔒 Programmatic Hard-Locks Active Prior to Gate 3
- `TradingEngine.executeTrade()` blocks real-money execution unless `afslCompliant === true`.
- `/api/execute/swap` endpoint enforces HTTP `403 Forbidden` hardstop.
- Daily Loss Limits ($50 cap default, 24h delay on increases) and Self-Exclusion mechanics active at engine level.
