# WDK Treasury Service

A Node.js / TypeScript service built on Tether's [Wallet Development Kit (WDK)](https://docs.wdk.tether.io) that manages a treasury wallet and three bot wallets on Polygon, and exposes simple REST endpoints to allocate and recall USD₮ between them.

> **Current phase: Polygon Amoy testnet** (chainId 80002).  
> To switch to mainnet, change `POLYGON_RPC` and `USDT_TOKEN_ADDRESS` in `.env` — no code changes required.

---

## Wallet layout

| Index | Purpose                  | Notes                       |
| ----- | ------------------------ | --------------------------- |
| 0     | **Treasury**             | Holds the main USD₮ reserve |
| 1     | **Bot 1** – Market-maker | Polymarket spread-trading   |
| 2     | **Bot 2** – Arb          | Polymarket–Kalshi arbitrage |
| 3     | **Bot 3** – Copy-trader  | Polymarket copy-trading     |

All wallets are derived from a single BIP-44 seed phrase via WDK.  
**This service only moves funds — it contains no trading logic.**

---

## Prerequisites

- Node.js ≥ 20
- npm ≥ 9
- A Polygon Amoy RPC endpoint (default: `https://rpc-amoy.polygon.technology`)
- Test POL from the [Polygon Amoy faucet](https://faucet.polygon.technology) — needed by each wallet to pay gas
- A mock USDT ERC-20 token deployed on Amoy (see env vars below)

---

## Install & run

```bash
cd wdk-treasury
npm install

# Copy and fill in env vars
cp .env.example .env
# → edit .env

npm run dev        # TypeScript watch mode (tsx)
npm start          # Production (tsx, no watch)
```

---

## Env vars

| Variable             | Required | Default                               | Description                                              |
| -------------------- | -------- | ------------------------------------- | -------------------------------------------------------- |
| `SEED_PHRASE`        | ✅       | —                                     | BIP-39 mnemonic (12 or 24 words). **Never commit this.** |
| `POLYGON_RPC`        | ✅       | `https://rpc-amoy.polygon.technology` | Polygon JSON-RPC URL (Amoy or mainnet)                   |
| `USDT_TOKEN_ADDRESS` | ✅       | —                                     | ERC-20 USD₮ contract address on the target network       |
| `PORT`               | ❌       | `3001`                                | HTTP port                                                |

### Amoy → mainnet switch (Phase 2)

Only two lines in `.env` change:

```env
POLYGON_RPC=https://polygon-rpc.com
USDT_TOKEN_ADDRESS=0xc2132D05D31c914a87C6611C10748AEb04B58e8F
```

---

## API

### `GET /health`

Liveness check.

```bash
curl http://localhost:3001/health
```

```json
{ "status": "ok" }
```

---

### `GET /wallets`

Returns addresses and USD₮ balances for all four wallets.

```bash
curl http://localhost:3001/wallets
```

```json
{
  "treasury": { "address": "0xABC…", "usdTBalance": "100.000000" },
  "bots": [
    { "id": 1, "address": "0xDEF…", "usdTBalance": "0.000000" },
    { "id": 2, "address": "0xGHI…", "usdTBalance": "0.000000" },
    { "id": 3, "address": "0xJKL…", "usdTBalance": "0.000000" }
  ]
}
```

---

### `POST /allocate`

Transfer USD₮ from the **treasury** (index 0) to a **bot wallet** (index 1–3).

> **Gas**: the treasury wallet pays the EVM fee in POL. Fund it from the Amoy faucet before use.

```bash
curl -X POST http://localhost:3001/allocate \
  -H 'Content-Type: application/json' \
  -d '{"botId": 1, "amountUsdT": "10.5"}'
```

```json
{
  "txHash": "0x…",
  "from": "0xABC…",
  "to": "0xDEF…",
  "amount": "10.500000",
  "botId": 1
}
```

---

### `POST /recall`

Transfer USD₮ from a **bot wallet** back to the **treasury**.

> **Gas**: the **bot** wallet pays the EVM fee in POL. Fund bot wallets from the faucet before recalling.

```bash
curl -X POST http://localhost:3001/recall \
  -H 'Content-Type: application/json' \
  -d '{"botId": 1, "amountUsdT": "5.0"}'
```

```json
{
  "txHash": "0x…",
  "from": "0xDEF…",
  "to": "0xABC…",
  "amount": "5.000000",
  "botId": 1
}
```

---

## Error responses

| HTTP  | When                                                                    |
| ----- | ----------------------------------------------------------------------- |
| `400` | Invalid `botId`, invalid `amountUsdT`, or insufficient balance / no gas |
| `404` | Unknown route                                                           |
| `500` | WDK / Polygon RPC error                                                 |

Example 400:

```json
{
  "error": "Insufficient balance",
  "message": "Treasury has 5.000000 USD₮ but 10.000000 was requested."
}
```

---

## Security

- The seed phrase is loaded **only** from the `SEED_PHRASE` env var. It is never logged or returned in any response.
- Derived account private keys are cleared from memory via `account.dispose()` after every request.
- This service has **no authentication layer** — it is an internal service. Access must be restricted at the network level (e.g. run behind the Orchestrator or a trusted firewall; never expose it to the public internet).

---

## Project structure

```
wdk-treasury/
├── src/
│   ├── index.ts            # Express server entry point
│   ├── wdk.ts              # WDK init, wallet helpers, USD₮ amount utilities
│   └── routes/
│       ├── wallets.ts      # GET /wallets
│       ├── allocate.ts     # POST /allocate
│       └── recall.ts       # POST /recall
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```
