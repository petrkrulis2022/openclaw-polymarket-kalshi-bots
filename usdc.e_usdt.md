# USDT / USDC.e Token Architecture

## Hard Constraint: Polymarket is USDC.e Only

Polymarket's CTF Exchange contract only accepts **USDC.e** as collateral on Polygon. This cannot be changed. There are three tokens in play:

| Token                    | Contract (Polygon)                           | Used by                                       |
| ------------------------ | -------------------------------------------- | --------------------------------------------- |
| **USDT**                 | `0xc2132D05D31c914a87C6611C10748AEb04B58e8F` | WDK treasury, Ylop, Kalshi, future strategies |
| **USDC.e**               | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` | Polymarket CLOB (mandatory)                   |
| **USDC** (native Circle) | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` | Not used                                      |

## Current Wallet Gap

Two separate wallet systems run in parallel today:

```
WDK treasury service  →  HD wallets (index 0, 1, 2, 3…)  →  hold USDT
Polymarket bots       →  EOA from BOT_SIGNER_KEY in .env  →  hold USDC.e
```

These are **different addresses**. The WDK-tracked USDT and the Polymarket-ready USDC.e currently live in separate wallets.

---

## Option 1 — Direct Deposit (Simplest, Good for Demo)

Fund the bot EOA addresses directly with USDC.e from your exchange. Withdraw to the address at `config.polymarket.walletAddress` in each bot's `.env`. Treasury stays USDT-only.

**Dashboard change needed**: Add a `getTokenBalance(USDC_E_ADDRESS)` call to the treasury `/wallets` endpoint so both USDT and USDC.e balances appear per wallet.

**Pros**: Zero swap cost, zero complexity, works immediately.  
**Cons**: Manual step every time you fund a bot — no automated allocation flow.

---

## Option 2 — Treasury Swap Endpoint (Recommended for Production)

Treasury stays USDT. Add a `POST /swap` endpoint that:

1. Takes USDT from a wallet index
2. Swaps USDT → USDC.e via **Uniswap V3 on Polygon** (pool is very liquid, ~0.05% fee)
3. Resulting USDC.e stays in the same wallet or is transferred to the bot EOA

**Uniswap V3 Router on Polygon**: `0xE592427A0AEce92De3Edee1F18E0157C05861564`

The orchestrator can then call `/swap` automatically during the allocation flow when a bot needs USDC.e. A manual swap button can also be added to the dashboard.

```
POST /swap
{
  "walletIndex": 0,
  "fromToken": "USDT",
  "toToken": "USDC.e",
  "amount": "100.00"
}
```

**WDK note**: `@tetherto/wdk-protocol-swap-velora-evm` may provide a native WDK swap integration. If docs are unavailable, Uniswap V3 can be called directly via ethers.js.

**Pros**: Fully automated, treasury-driven, single allocation flow.  
**Cons**: Small swap fee (~0.05%), slightly more complex to build.

---

## Option 3 — Unified Wallets

Make the WDK HD-derived key at bot index 1, 2, 3 also serve as the Polymarket signing key (`BOT_SIGNER_KEY`). Same address holds both USDT and USDC.e.

**How**: Derive the private key for wallet index N from the WDK instance at startup, write it to `BOT_SIGNER_KEY` in the bot's env, then both systems point to the same on-chain address.

**Pros**: No wallet gap — one address per bot, both tokens in one place. Treasury allocations immediately visible as USDC.e in Polymarket.  
**Cons**: Most complex to implement; requires exporting derived private keys; changes how all bots are initialised.

---

## Recommended Path

### Short term (demo ready)

- Fund Polymarket EOAs with USDC.e directly from Binance/Coinbase (Option 1)
- Add USDC.e balance display to `/wallets` → dashboard shows both USDT and USDC.e per wallet

### Medium term (clean production)

- Build `POST /treasury/swap` using Uniswap V3 via ethers.js (Option 2)
- Orchestrator calls it automatically during allocation when bot needs USDC.e
- Manual swap button in dashboard for manual rebalancing

### USDT stays relevant for

- Ylop collateral (USDT-native)
- Kalshi funding (likely supports USDT)
- Cross-chain strategies where USDT has better liquidity
- Reserve storage in treasury

---

## Key Contract Addresses

```ts
// Polygon Mainnet
USDT_TOKEN_ADDRESS = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F";
USDC_E_TOKEN_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
USDC_TOKEN_ADDRESS = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
UNISWAP_V3_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
```
