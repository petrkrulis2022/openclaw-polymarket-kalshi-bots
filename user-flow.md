# OpenClaw — Complete User Flow

⚠️ **FRESH START — SINGLE IDENTITY ONLY**

This flow uses **Eda MetaMask** (`0x8727...B2B6`) exclusively. Do NOT mix multiple MetaMask addresses or bot identities during this fresh start. If you previously used "Main MetaMask" or "Mybot", disconnect those from OpenClaw completely before starting this flow.

---

## 1. Connect MetaMask

Open the dashboard at `:4001`. Click **Connect Wallet** — MetaMask pops up, you approve. This is your **personal identity** on the platform. Each MetaMask address gets its own isolated trading bot.

---

## 2. Step 1 — Fund Your Bot Wallet

The system automatically generates a **dedicated bot wallet** (an HD wallet derived server-side) — this is the wallet that will actually trade on Polymarket. It is NOT your MetaMask wallet.

You'll see its address displayed. You need to send **USDT on Polygon** to it:

### Option A — Send via MetaMask button (recommended)

1. Type the USDT amount into the input field
2. Click **Send USDT** → MetaMask popup appears
3. Confirm the transaction in MetaMask
4. USDT goes from your MetaMask wallet → bot wallet on Polygon

### Option B — Manual copy

1. Click **Copy** to copy the bot wallet address
2. Open MetaMask → Send → paste the address → choose USDT on Polygon → confirm

**Live balances** (USDT / USDC.e / POL gas) update every 30 seconds automatically. The **Next** button unlocks once the bot wallet has any USDT or USDC.e balance.

> ⚠️ The bot wallet also needs a small amount of **POL** (Polygon native token) for gas. Send ~0.5–1 POL to the same bot wallet address.

---

## 3. Step 2 — Deposit Collateral to Polymarket

The bot trades on Polymarket using your **WDK Deposit Wallet** (shown in the dashboard as "Deposit Wallet (Polymarket POLY_1271)"). Funds must be moved there from the Bot EOA before bots can trade.

### Convert USDT → USDC.e

Click **Convert X USDT → USDC.e** in the dashboard. This triggers a Uniswap V3 swap on Polygon. Wait ~10–30 seconds for confirmation.

### Deposit USDC.e to Polymarket

Click **Deposit USDC.e → Polymarket**. This moves USDC.e from the Bot EOA into the WDK Deposit Wallet (`0x50f0aC2...`). The bots trade directly from this wallet using POLY_1271 signing — **no Polymarket API keys are needed and you should NOT connect any wallet to polymarket.com for this flow.**

> ⚠️ Never connect the Bot EOA or any OpenClaw wallet directly to polymarket.com. The bot handles Polymarket interaction automatically via the POLY_1271 signature standard.

---

## 4. Step 3 — Configure and Start Bots

### Autonomous Mode (optional)

Toggle **Autonomous Mode** ON to have the orchestrator automatically convert any future USDT deposits → USDC.e every 5 minutes. Useful if you plan to top up funds regularly without manual conversion.

### Start Bots

Click **Start Bots** — the orchestrator launches 5 trading strategies simultaneously for your wallet:

| #   | Strategy                 | What it does                                                                                  |
| --- | ------------------------ | --------------------------------------------------------------------------------------------- |
| 1   | **Market Maker**         | Places limit orders on both sides of the order book, captures the bid-ask spread              |
| 2   | **Copy Trader**          | Mirrors trades from top Polymarket traders at a configurable scale                            |
| 3   | **In-Market Arb**        | Buys YES+NO when their combined ask price < $1 — guaranteed profit regardless of outcome      |
| 4   | **Resolution Lag Buyer** | Buys winning shares at 97–99¢ discount during the 24–72h oracle settlement delay, collects $1 |
| 5   | **Microstructure**       | Market makes on very low-price (0.1¢) illiquid markets, scaled across 100+ positions          |

Each bot runs as a separate PM2 process with its own port range (`4010+`).

---

## 5. After Activation

Once bots are running, the onboarding screen is replaced by the **Agent Wallet Card** showing live balances, and the main dashboard with portfolio tracking and the AI chat assistant.

### Stopping Bots

Use the **Stop Bots** button in the Agent Wallet Card. This gracefully shuts down all 5 PM2 processes for your wallet. Funds remain in the bot wallet — nothing is automatically withdrawn.

### Re-funding

Send more USDT to the same bot wallet address at any time. The bot wallet is **permanent and deterministic** — reconnecting the same MetaMask address always recovers the exact same bot wallet. If Autonomous Mode is on, new USDT is converted to USDC.e automatically within 5 minutes.

---

## Key Concepts

| Term                | Meaning                                                                              |
| ------------------- | ------------------------------------------------------------------------------------ |
| **MetaMask wallet** | Your personal identity — used only to identify you and optionally send funds         |
| **Bot wallet**      | Server-generated HD wallet that actually holds funds and places trades on Polymarket |
| **USDT**            | What you send from MetaMask; must be on Polygon network                              |
| **USDC.e**          | What the bots actually trade with on Polymarket (converted via Uniswap V3)           |
| **POL**             | Polygon native token needed for gas fees on the bot wallet (~0.5–1 POL)              |
| **Autonomous Mode** | Auto-converts incoming USDT → USDC.e every 5 minutes without manual action           |
