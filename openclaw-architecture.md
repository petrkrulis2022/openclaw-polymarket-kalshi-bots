# WDK / OpenClaw Multi‑Bot DeFi Agent – Architecture

## 1. Problem & Goal

Build an **Autonomous DeFi Agent** for the Tether WDK + OpenClaw hackathon:

- User interacts with a frontend (mobile app) that shows portfolio state, three trading bots, and risk parameters.
- An **OpenClaw agent** (with Tether WDK skills) holds a USD₮ treasury on Polygon and **decides when and why** to allocate capital across three bots based on performance and risk.
- Three **strategy bots** trade on Polymarket (and Kalshi for arb) using funds allocated by the treasury.

This satisfies the hackathon requirements:

- WDK used as the wallet/transaction layer.
- USD₮ is the base asset on Polygon.
- OpenClaw handles strategy and planning; bots handle execution.

## 2. Components Overview

### 2.1 Frontend (React Native WDK App)

User‑facing point of interaction, built with the **React Native WDK starter**:

- Uses `@tetherto/wdk-react-native-provider` and the WDK React Native quickstart patterns.
- Configures **Polygon** in the chains config with **USD₮ as paymaster token**.
- Screens:
  - **Dashboard**: total USD₮ treasury, per‑bot allocation (% and notional), recent PnL.
  - **Bot Detail** (for each of 3 bots): equity curve, positions, utilization, basic parameters.
  - **Agent Policy**: user‑set risk sliders (max per‑bot weight, target volatility, max daily drawdown) and autonomy level (manual / semi‑auto / full auto).
- Talks only to the **Orchestrator API** (no direct connection to OpenClaw or raw WDK).

### 2.2 WDK Core Treasury Service (Node.js Bare)

Backend service that owns on‑chain wallets via Tether WDK (Node Bare quickstart):

- Uses `@tetherto/wdk` + `@tetherto/wdk-wallet-evm`.
- Creates a **master seed** and derives Polygon EVM wallets:
  - Index 0: **Treasury wallet** (Polygon, holds USD₮ as base asset).
  - Index 1: **Bot 1 wallet** – Polymarket Market‑Making / Spread.
  - Index 2: **Bot 2 wallet** – Polymarket–Kalshi Arbitrage.
  - Index 3: **Bot 3 wallet** – Polymarket Copy‑Trader.
- Uses WDK’s indexer to read balances; no raw RPC.
- Exposes REST API:
  - `GET /wallets` → addresses + USD₮ balances for treasury and all bot wallets.
  - `POST /allocate { botId, amountUsdT }` → transfer that amount of USD₮ from treasury to bot wallet.
  - `POST /recall { botId, amountUsdT }` → transfer that amount from bot wallet back to treasury.
- All transfers are executed via WDK / EVM wallet abstractions and Polygon+USD₮ chain config.

This service is the **only place** that moves on‑chain funds between treasury and bots.

### 2.3 Strategy Bots (Execution Layer)

Three independent Node/TypeScript services, each with its own bot wallet and trading logic. They never move funds between wallets; they only trade with what is currently allocated to them.

Common patterns:

- Hold a Polygon private key (from WDK‑derived bot wallet) and relevant API keys:
  - Polymarket CLOB API (all bots).
  - Kalshi trading API (arb bot only).
- Poll or subscribe to market data (Polymarket Gamma + CLOB websockets; Kalshi REST/websockets for arb).
- Maintain their own internal risk parameters (max exposure, allowed markets, etc.).
- Periodically emit **metrics** to the Orchestrator: positions, realized/unrealized PnL, volatility proxy, drawdown, utilization.
- Provide configuration endpoints:
  - `GET /metrics`
  - `GET /config` and `POST /config`

#### Bot 1 – Polymarket Market‑Making / Spread

- Selects a universe of liquid Polymarket markets (by volume, open interest, time to expiry).
- For each market:
  - Subscribes to the Polymarket CLOB orderbook.
  - Computes best bid, best ask, mid, and spread.
  - Places limit **bids below mid** and **asks above mid** with configurable width and size.
  - Cancels and re‑quotes when the mid/spread change or its own inventory becomes unbalanced.
- Objective: earn bid‑ask spread + possible Polymarket liquidity incentives, subject to inventory and exposure caps.

#### Bot 2 – Polymarket–Kalshi Arbitrage

- Maintains a mapping of “equivalent” markets on Polymarket and Kalshi (same event, resolution date, and outcome semantics).
- Monitors orderbooks on both venues:
  - Polymarket CLOB (YES/NO prices as probabilities).
  - Kalshi orderbooks (YES/NO contracts in cents).
- When the implied probabilities diverge beyond a configured threshold (after fees and slippage), opens **hedged positions**:
  - Long underpriced side on one venue, short/hedged on the other.
- Uses:
  - **Polymarket bot wallet** funds on Polygon (USDC) for on‑chain side.
  - A separate, fixed cash balance on Kalshi managed by a central backend (non‑WDK, off‑chain). The OpenClaw agent only influences this via target‑allocation signals, not direct transfers.

#### Bot 3 – Polymarket Copy‑Trader

- Watches trades of selected “leader” wallets on Polymarket using public trade feeds.
- For each new leader trade that passes filters (market allowed, size, category):
  - Mirrors the trade from the bot’s own wallet with a configurable **copy ratio** (e.g., 0.2× notional).
- Enforces per‑market and global caps, and implements basic exit rules (time‑based, leader exit, stop‑loss / take‑profit).

### 2.4 Orchestrator + Analytics Backend

Shared analytics layer for bots and frontend:

- Node/TypeScript service with Postgres.
- Data model:
  - `bots` table (id, name, description).
  - `metrics` table (botId, timestamp, pnl, equity, volatility, max_drawdown, utilization, etc.).
- Endpoints:
  - `POST /metrics` → bots push their latest metrics snapshots.
  - `GET /portfolio/summary` → aggregate total equity, per‑bot equity, allocation %, recent PnL.
  - `GET /portfolio/bot/:id` → time‑series metrics for charting.
  - `GET /portfolio/agent-context` → consolidated snapshot for OpenClaw (bot metrics + wallet balances fetched from the WDK core service).

This backend is **read‑only** with respect to funds; it does not move money, only aggregates data.

### 2.5 OpenClaw Agent (Strategy & Planning)

The OpenClaw agent is the **brain** that decides **when and why** to rebalance capital across bots. It uses the Tether WDK agent skill for wallet operations.

- OpenClaw is configured with:
  - `tetherto/wdk-agent-skills` so it can call WDK to:
    - Inspect balances.
    - Create and send transactions on Polygon with USD₮.
  - Custom tools that call:
    - Orchestrator endpoints: `/portfolio/agent-context`.
    - WDK Core Treasury Service endpoints: `/wallets`, `/allocate`, `/recall`.
- System prompt (conceptual):
  - Objective: maximize risk‑adjusted PnL over time, under user‑defined risk constraints.
  - Inputs: current portfolio context, bot metrics, user‑set risk parameters (from frontend).
  - Actions:
    - Periodically fetch latest metrics.
    - Compute a simple score per bot (e.g., Sharpe‑like: recent PnL vs drawdown/volatility).
    - Decide target allocation per bot (subject to constraints like max 50% per bot, min 10%, max 10% reallocation per hour).
    - Use WDK tools to call `/allocate` and `/recall` to actually move USD₮ between treasury and bot wallets.
    - Log a short **natural‑language rationale** with each rebalance (for the UI and for the “when and why” hackathon criterion).

The strategy/execution split is clear:

- OpenClaw: strategy, planning, risk‑aware allocation decisions.
- Bots: low‑level trading and order execution.
- WDK core: funds movement between wallets.
- Frontend: visualization and user preferences.

## 3. Recommended Build Order

1. **WDK Core Treasury Service**
   - Implement Node Bare WDK service, Polygon+USD₮ config, wallet derivation, `/wallets`, `/allocate`, `/recall`.
   - Test on testnet/low amounts.

2. **Orchestrator + Metrics API**
   - Stand up Postgres and the orchestrator API.
   - Stub metrics ingestion from a fake bot to verify dashboards.

3. **Bot 1 – Polymarket Market‑Maker**
   - Implement CLOB connectivity, simple quoting logic, and metrics emission.
   - Confirm capital separation (bot only uses its wallet balance).

4. **OpenClaw Integration**
   - Install WDK agent skills in OpenClaw.
   - Implement tools that hit orchestrator + WDK core.
   - Implement a first, simple allocation policy (e.g., keep MM bot within 30–70% of treasury based on 24h PnL).

5. **React Native Frontend**
   - Clone WDK RN starter, configure Polygon+USD₮.
   - Implement Dashboard + Bot Detail screens using orchestrator APIs.

6. **Bots 2 and 3**
   - Implement Polymarket–Kalshi Arb bot and Polymarket Copy‑Trader bot.
   - Extend orchestrator metrics and OpenClaw allocation policy to consider all three bots.

## 4. Example Task Prompts (For Coding Agent)

### Task 1 – Implement WDK Core Treasury Service

- Follow WDK Node.js Bare quickstart.
- Add Polygon+USD₮ chain config.
- Derive wallets (treasury + 3 bots).
- Implement `/wallets`, `/allocate`, `/recall` endpoints.

### Task 2 – Orchestrator + Metrics

- Create TypeScript service with Postgres.
- Schema: `bots`, `metrics`.
- Endpoints: `POST /metrics`, `GET /portfolio/summary`, `GET /portfolio/bot/:id`, `GET /portfolio/agent-context`.

### Task 3 – Polymarket MM Bot

- Create Node/TS service.
- Connect to Polymarket Gamma + CLOB.
- Implement simple spread‑trading / market‑making logic.
- Emit metrics to orchestrator.

### Task 4 – OpenClaw Tools + Policy

- Configure OpenClaw with WDK agent skills.
- Add tools for orchestrator + WDK core.
- Implement periodic allocation decisions and rationale logging.

### Task 5 – React Native Frontend

- Start from WDK RN starter.
- Add dashboard and per‑bot views using orchestrator APIs.

This document is your reference architecture and task roadmap for implementing the full system.
