# WALLET FUNDING GUIDE

**Network: Base Mainnet (chain ID 8453).** Everything below is on Base unless
stated otherwise. Funding the wrong chain is the single most common reason the
app shows a `$0.00` wallet balance while holding real money.

---

## 1. What you actually need to fund

| Token | Contract (Base Mainnet) | Minimum | Recommended | Why |
|-------|------------------------|---------|-------------|-----|
| **ETH** | native gas | 0.002 ETH | **0.01 ETH** | Every swap, wrap/unwrap and approval costs gas. |
| **USDC** | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | $5 | **$50** | The arena's working balance — quotes are denominated in USDC. |

### Why ETH is a hard requirement

`OnchainExecutionEngine` estimates gas with a 20% buffer over `provider.estimateGas`,
falling back to a 300,000 gas limit. A Base swap realistically lands near
150k–300k gas. At typical Base gas prices a single swap costs on the order of
$0.01–$0.05 in ETH. A balance under ~0.002 ETH will run out mid-session and the
transaction will revert with no useful error.

### Why USDC is the trading balance

The quote path is `USDC -> WETH` on Uniswap V3 (`services/TokenManager.js`).
Every configured pair is anchored to USDC:

```
WETH/USDC  CBBTC/USDC  SOL/USDC  WBTC/WETH  PEPE/WETH
```

A wallet holding only ETH and no USDC cannot open a position at all — the
balance display will show your ETH's USD value, but no trade can be quoted.

---

## 2. Optional tokens

These are only needed if you trade those specific pairs. Without them the app
still runs; those pairs simply will not quote.

| Token | Contract (Base) | Decimals |
|-------|-----------------|----------|
| WETH | `0x4200000000000000000000000000000000000006` | 18 |
| WBTC | `0x03C6B3903b65151371b9541b59367468160BCE62` | 8 |
| cbBTC | `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` | 8 |
| PEPE | `0x698dc45e4f10966f6d1d98e3bfd7071d8144c233` | 18 |
| SOL | `0x29683838D64Ab2Eb75757D59048A60f9e15f3366` | 9 |

> **Checksum matters.** A single wrong-case character makes ethers throw
> `bad address checksum` on every quote and balance read, so the token appears
> permanently unpriceable. These are the verified values.

---

## 3. Position sizing limits

Configured in `.env`. Exceeding these blocks execution, it does not warn.

```
MAX_TRADE_USD=0.50          max per trade
MAX_POSITION_USD=1000       max per position
MAX_DAILY_LOSS_USD=2.00     daily loss circuit breaker
MAX_SLIPPAGE_BPS=100        1% slippage tolerance
MAX_OPEN_POSITIONS=999
```

So a **$10 USDC balance is comfortably sufficient** to exercise the full
pipeline. You do not need to fund the wallet with the size of your intended
trades — the limits are what gate execution.

---

## 4. Testnet instead of mainnet

To avoid real funds entirely:

```bash
# .env
BASE_CHAIN_ID=84532
BASE_RPC_URL=https://sepolia.base.org
```

Then fund the **Base Sepolia** USDC contract instead — it is a *different*
contract from mainnet:

```
Sepolia USDC: 0x036CbD53842c5426634e7929541eC2318f3dCF7e
```

Get Sepolia ETH from any Base Sepolia faucet, then run the preflight:

```bash
npm run preflight:live
```

The preflight verifies RPC reachability, contract deployment, a live
`USDC -> WETH` quote, and that `TRADING_PRIVATE_KEY` holds gas + token balance.

---

## 5. Checking your balance

```bash
# The four wallets this repo has been tracking, on Base Mainnet
node check_balance.js
```

Or in the browser console:

```js
getWalletBalanceUSD()   // refresh and return the live USD total
WalletCore.state.holdings   // per-token, per-chain breakdown
```

The header shows two figures:

- **Large figure** — the app's *trading* balance (paper ledger, moves with P&L)
- **`🔗 $x.xx`** — the *live on-chain* wallet value, which never moves with P&L

If those disagree, that is intentional. To re-sync the trading balance to the
chain:

```js
resetTradingBalance()   // re-seeds from the on-chain value
```

---

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `$0.00` but you hold funds | Funded the wrong chain | Confirm the network badge in the header reads `BASE` |
| Quotes revert, no error | No ETH for gas | Fund ≥0.01 ETH on Base |
| `bad address checksum` | Token address casing | Use the verified addresses in §2 |
| Balance stale after funding | Sync not re-run | `getWalletBalanceUSD()`, or reconnect |
| Header shows a figure you don't recognise | Stale persisted demo balance | `resetTradingBalance()` or log out (logout now clears it) |

---

## 7. Security note

`.env` currently contains a populated `TRADING_PRIVATE_KEY`. The
`/api/wallet/swap` endpoint spends a server-held key, so anyone who can reach
that endpoint can move funds. It is safe only while the server is bound to
localhost and not exposed publicly. If that key has ever been committed or
exposed, rotate it before funding any real balance.
