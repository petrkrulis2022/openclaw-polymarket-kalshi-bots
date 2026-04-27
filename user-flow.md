# OpenClaw — Complete User Flow

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

## 3. Step 2 — Generate Polymarket API Keys

Polymarket requires API keys tied to the **bot wallet address** (not your MetaMask). This is because orders are placed from the bot wallet.

Steps:

1. Go to [polymarket.com/settings](https://polymarket.com/settings)
2. In MetaMask, **import the bot wallet** using its private key (retrievable from the treasury if needed)
3. Switch MetaMask to the bot wallet account
4. Go to **API Keys → Create Key**
5. Copy the **API Key, API Secret, and Passphrase**
6. Paste all three into the OpenClaw form and click **Save**

---

## 4. Step 3 — Activate Bots

### Convert USDT → USDC.e

Bots trade with USDC.e (Polymarket's accepted stablecoin), not USDT.

- Click **Convert X USDT → USDC.e** — this triggers a Uniswap V3 swap on-chain (stable pair, 0.01% fee)
- Wait ~10–30 seconds for the transaction to confirm on Polygon
- A PolygonScan link appears when done

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
