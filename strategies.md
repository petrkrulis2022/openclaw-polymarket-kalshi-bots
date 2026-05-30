# Trading Strategy Reference

All strategies run on Polymarket (CLOB) unless noted. Bots are numbered by implementation priority.

---

## Bot 1 — Market Maker

**Status**: Live (port :3003)  
**Strategy**: Bid-Ask Spread Capture

### How It Works

Post resting limit orders on both sides of the book in liquid prediction markets. Earn the spread when both legs fill. Never take directional risk — immediately hedge or flatten when inventory becomes unbalanced.

### Entry Logic

- Select markets with sufficient CLOB liquidity (top-of-book spread > 1¢)
- Post bids at `mid - half_spread`, asks at `mid + half_spread`
- Reprice orders when mid moves by more than 0.5¢

### Exit / Risk

- If net inventory exceeds threshold, widen spread on the overloaded side
- Cancel all orders if utilization > 90%
- Hard stop: cancel everything if unrealized PnL drops > $X per session

### Key Metrics

- Spread captured per fill
- Inventory imbalance ratio
- Fill rate (how often both legs fill)

### Implemented Changes

- Added exchange-truth order reconciliation from live open-order snapshots.
- Tracks remaining size per resting order so partial fills are reflected immediately.
- Clears stale order IDs when the exchange says an order is gone.
- Reports live diagnostics to the dashboard, including health, equity, and reconciliation timestamps.
- Responds to per-user allocation toggles: if the bot is unticked, the orchestrator stops that PM2 process and keeps it disabled until re-enabled.

### Ylop Integration

- Borrow against existing inventory positions to fund additional MM depth
- Locked YES+NO pairs ≈ $1 guaranteed → ideal Ylop collateral

---

## Bot 2 — Cross-Platform Arb (Kalshi ↔ Polymarket)

**Status**: Designed, not yet built (needs Kalshi account)  
**Target**: Next week

### How It Works

The same binary event trades on both Kalshi and Polymarket. When the same outcome is priced differently across venues, buy the cheaper side and (synthetically) sell the expensive side. Capture the convergence.

### Entry Logic

1. Fetch YES price on both venues for the same underlying event
2. Compute net spread: `polymarket_yes_ask - kalshi_yes_bid` (or vice versa)
3. Walk both order books to find the volume-weighted actual spread — **do not use top-of-book only**
4. Enter only if volume-weighted spread > fees on both sides + slippage buffer

### Critical Warning

The naive version **lost money** in testing: saw a 13% quoted spread, but consuming it filled the order and left a 0% actual spread. Always walk the full book before entering.

### Fees / Costs

- Polymarket: taker fee on CLOB
- Kalshi: maker/taker fee schedule
- Gas: Polygon (minimal)
- Net threshold: must clear all fees by at least 1% to enter

### Exit

- Close both legs simultaneously when spread compresses to < 0.1%
- Or hold to resolution if both sides are the same outcome

### Ylop Integration

- Leg A (cheaper venue) can be posted as collateral to borrow for leg B
- Reduces upfront capital required by ~50%

---

## Bot 3 — Copy Trader

**Status**: Live (port :3004)  
**Strategy**: Copy high-performing Polymarket traders with configurable scaling

### How It Works

Poll the Polymarket Data API for a tracked trader's positions every N seconds. When they increase or decrease a position, mirror the trade at a scaled size (`copyRatio × traderDelta`). Supports manual approval mode or fully automatic.

### Entry Logic

1. Compare current snapshot vs previous snapshot for each tracked trader
2. Compute delta: `currSize - prevSize` per tokenId
3. If `|delta| × curPrice > minSignalUsd`, generate a signal
4. Scale our order: `ourShares = min(|delta| × copyRatio, allocationUsd / curPrice)`
5. In manual mode: queue as pending — user approves/rejects
6. In auto mode: execute immediately

### Trader Selection

- Add traders by Polymarket profile URL (auto-extracts 0x address)
- Configure per-trader: allocation ($), copy ratio (0–2×), mode (manual/auto)
- Remove at any time — snapshot cleared, no new signals

### Position Tracking

Dashboard shows for each open position:

- **Ours**: size, capital (size × avgPrice), unrealized PnL, realized PnL
- **Trader**: size, capital, unrealized PnL (from live snapshot)

### Risk

- Each trader gets an independent allocation cap
- copyRatio caps our per-trade size relative to theirs
- minSignalUsd prevents dust signals

### Ylop Integration

- Copy positions with high conviction can be used as Ylop collateral
- Borrow against a confirmed position to fund additional copy signals

### Implemented Changes

- Reconciles fills from confirmed trade history so positions survive restarts without optimistic local state.
- Exposes live diagnostics for the dashboard: tracked traders, pending approvals, approved queue, realized PnL, and open positions.
- Allocation is now user-controllable from the dashboard; unticking the bot prevents further capital allocation and stops the running PM2 process.
- Keeps manual approval, auto, and orchestrator approval modes intact while making the inventory state exchange-backed.

---

## Bot 4 — In-Market Arb (YES + NO < $1)

**Status**: Live / implemented  
**Strategy**: Pure mathematical arbitrage within a single market

### How It Works

On a binary Polymarket market, YES + NO must equal exactly $1 at resolution. If the market is illiquid or disjointed, sometimes `YES_ask + NO_ask < $1`. Buying both guarantees a profit regardless of outcome.

### Entry Formula

```
spread = 1.0 - (YES_ask + NO_ask)
```

Enter when `spread > fees + slippage buffer` (typically need spread > 0.5–1%).

### Order Book Depth Check

Don't just check the top price. Walk the book:

```
for each YES level:
  for each NO level:
    if YES_price + NO_price < 1.0:
      profitable_volume += min(YES_volume, NO_volume)
```

Only enter if profitable volume is large enough to justify the trade.

### Multi-Outcome Extension

Works on multi-outcome markets too:

- **Multi-binary**: `YES_A + YES_B + ... < $1` → buy all outcomes
- **Negative risk**: `NO × N < N - 1` → buy all NOs

### Execution

1. Subscribe to CLOB websocket for target markets
2. On each orderbook update, re-run the spread formula
3. If positive spread detected and depth check passes → fire both legs simultaneously (use limit orders priced at the spread)
4. Both legs must fill within a short window — cancel unpaired leg immediately

### Risk

- Execution risk: one leg fills, other doesn't → directional exposure until cancelled
- Resolution risk: none (guaranteed $1 return)
- Liquidity risk: thin book means limited volume

### Ylop Integration

- A paired YES+NO position ≈ $1 guaranteed at resolution
- Ideal collateral for Ylop loans — borrow against the locked pair while waiting for resolution

### Implemented Changes

- Tracks both legs of each arb pair with exchange-truth remaining size.
- Marks pairs as partial when one leg fills or disappears, and cancels the remaining leg immediately.
- Surfaces live scan results and reconciliation timestamps through a diagnostics endpoint.
- Reports metrics from reconciled state so the dashboard shows the true open-pair and utilization picture.
- Can be disabled per user through the allocation checkbox, which stops the PM2 process and prevents new capital from being routed to it.

---

## Bot 5 — Resolution Lag Buyer

**Status**: Live / implemented  
**Strategy**: Buy "won" shares from impatient sellers while oracle is delayed

### How It Works

After an event resolves in the real world (game ends, election called, price crosses level), Polymarket's oracle takes 24–72 hours to officially settle. During that window, impatient winning ticket holders sell at a discount — 97–99¢ instead of waiting for $1.

Buy those discounted shares, collect $1 at oracle resolution.

### Return Profile

- 1–3% return in 24–72 hours
- Annualized: 1% per 2 days ≈ 180% APY on deployed capital
- Even 0.5% per 3 days = ~60% APY

### Entry Logic

1. Monitor event outcomes via news feed / X API / sports API
2. When outcome is confirmed (e.g., team wins game), check Polymarket oracle status
3. If resolution is still pending (`resolved: false`, outcome confirmed externally):
   - Check YES price for the winning outcome — if `price < 0.99`, compute expected yield
   - Buy up to position limit if `yield > threshold` (e.g., > 0.5%)
4. Hold until oracle settles, collect $1

### Data Sources Needed

- Sports: ESPN / Sportradar API for game results
- Politics: Associated Press / Reuters election feeds
- Crypto: Chainlink / CoinGecko for price-triggered markets
- Polymarket oracle status: GraphQL or REST API

### Risk

- Oracle dispute: outcome is challenged → resolution delayed or reversed (rare)
- Misidentification: bot thinks event resolved when it hasn't → buys wrong side
- Mitigation: require 2+ independent confirmation sources before entering

### Capital Efficiency

- Position size limited by oracle resolution timeline — can't recycle capital until settled
- Ylop borrow against held positions to redeploy capital before oracle settles

### Ylop Integration

- Hold 99¢ positions as Ylop collateral
- Borrow against them to fund new trades while waiting for the $1 payout
- Effectively recycles capital that would otherwise sit idle for 1–3 days

### Implemented Changes

- Uses live Gamma-to-CLOB reconciliation to track unresolved markets and winning-token opportunities.
- Exposes diagnostics for scan time, open position count, and current opportunity count.
- Keeps position tracking exchange-backed and resolution-aware instead of relying on optimistic local state.
- Shows the current state in the dashboard with a health badge and reconciliation timestamp.
- Can be individually unticked so the orchestrator stops allocating new capital to it until it is re-enabled.

---

## Bot 6 — Sports Score-Lag Arbitrage

**Status**: Live / implemented for hockey and football  
**Strategy**: Use external sports score updates to trade before Polymarket fully reprices the game market

### One-Page Explainer

The sports bots are event-driven trading agents designed to exploit the short delay between a real-world scoring event being published by a sports data feed and Polymarket's market price fully adjusting on the CLOB. The edge comes from reacting to a goal before the order book completely reprices the scoring team's win probability.

The system uses three different data sources, each with a separate role:

- **Sports API (Goalserve)**: score trigger only. We poll live match data and compare the latest score to the previous snapshot. If the score changes, the bot treats that as a trade signal.
- **Polymarket Gamma API**: market metadata and lifecycle truth. Gamma provides the event slug, token IDs, tick size, active/closed/resolved state, whether the market is accepting orders, and the official resolution source.
- **Polymarket CLOB**: execution and price truth. The CLOB provides bids, asks, liquidity, fills, and the actual venue where the bot buys and sells shares.

### Core Trading Idea

When a team scores, the real-world probability of that team winning rises immediately. Polymarket market makers and traders usually reprice very quickly, but not always instantly. The bot tries to capture that lag:

1. Goalserve reports a scoring event.
2. The bot maps the scorer to the correct Polymarket outcome token.
3. It checks Gamma to confirm the market is still active and CLOB to confirm the book is still tradable.
4. It buys shares of the scoring team's side with a marketable FOK order.
5. It monitors the best bid and sells after repricing, using profit, stop-loss, timeout, or market-end rules.

For a home goal, the bot buys the home-win side. For an away goal, the bot buys the away-win side or the corresponding NO side depending on the market structure.

### Why We Split the Sources

The sports feed is best at detecting goals first, but it is not reliable enough for lifecycle control. Goalserve status fields can regress or mislabel breaks and end-of-game transitions. Because of that, the bots no longer use Goalserve to determine whether a game is live or over.

Instead:

- Goalserve tells us **that a goal happened**
- Gamma tells us **whether the market should still be active**
- CLOB tells us **whether a trade can actually be executed**

This separation makes the system more robust and aligns the bot with Polymarket's own market state.

### Entry Logic

1. Resolve the watched match to a Polymarket event slug and token IDs.
2. Poll Goalserve for score changes.
3. On score delta:

- determine the scoring side
- map to the correct token ID
- confirm via Gamma that the market is active / not resolved
- confirm via CLOB that liquidity exists

4. Submit a FOK buy order.
5. Retry briefly if liquidity disappears during the repricing window.

### Exit Logic

After a fill, the bot watches the CLOB bid and exits when one of the following happens:

- profit target reached
- stop-loss threshold reached
- maximum hold timeout reached
- Gamma/CLOB lifecycle indicates the game market is over

### Technical Stack

- **TypeScript**
- **Node.js**
- **Express** for health, diagnostics, and dashboard integration
- **PM2** for process management
- **Polymarket Gamma API** for event and market metadata
- **Polymarket CLOB API** via `@polymarket/clob-client-v2` for order placement and order book reads
- **viem** for wallet and signing support
- **Goalserve** for live score triggers
- **Orchestrator + web dashboard** for per-user watched-game control and bot monitoring

### Architecture Notes

The bots run in a multi-user architecture. A central orchestrator tracks watched games and passes selections to individual per-user bot processes. Each bot process resolves the market, monitors the selected game, exposes diagnostics over HTTP, and reports status back to the dashboard.

### Risks and Constraints

- Market makers can pull liquidity immediately after a goal, causing FOK orders to miss.
- If the post-goal ask jumps above the configured price cap, fills will fail even when liquidity exists.
- Sports feeds can still be late relative to Polymarket repricing, which compresses the edge.
- This strategy depends on extremely fast detection, low-latency execution, and disciplined exit logic.

### Current Design Principle

- **Goalserve = score trigger**
- **Gamma = market lifecycle and resolution metadata**
- **CLOB = pricing, liquidity, and execution**

That is the current production architecture for the sports bots. The edge exists in the brief window between the sports feed's score update and Polymarket's full repricing of the relevant win market.

---

## Bot 6 — Low-Price Microstructure ("0.1¢ Bot")

**Status**: Live / implemented  
**Strategy**: Market making at extreme low prices on illiquid markets

### How It Works

In illiquid prediction markets, a YES share trading at 0.1¢ (0.1% implied probability) often has a bid-ask spread of 0.1¢ → 0.3¢. Post resting bids at 0.1¢ across many markets, sell at 0.2–0.3¢ when price moves. Very small profit per trade, but scaled across 100+ markets.

### Entry Logic

1. Screen for markets with:
   - Top bid < 0.3¢
   - Time to expiry > 90 days (reduces total-loss risk)
   - Any volume in last 7 days (proves liquidity exists)
2. Post limit bids at 0.1¢ (or current top bid)
3. When filled, immediately post ask at 0.2–0.3¢
4. Repeat

### Market Screener Criteria

- `curPrice < 0.003` (< 0.3¢)
- `expiry > now + 90d`
- `volume_7d > 0`
- Not in blacklist (markets approaching resolution, controversial outcomes)

### Risk Profile

- **Total loss risk**: if event resolves YES while holding NO at 0.1¢ → lose the entire position
- **Mitigation**:
  - Only enter markets with > 3 months to expiry
  - Spread bets across 100+ positions — diversification reduces variance
  - Cap position size at $1–5 per market
  - Maximum total exposure: `N_positions × avg_price × avg_size`
- **Expected value per position**: slightly positive (spread) with occasional total-loss events

### Position Management

- Track each position independently (separate from main inventory)
- Automatic cancel-all on any position approaching 30-day expiry
- Realized PnL tracked separately from other bots

### Scalability

- Profit scales with number of markets covered
- 100 positions × $2 avg cost × 50% fill rate × 100% markup = rough target
- Main constraint: finding enough markets meeting criteria

### Ylop Integration

- Less suitable for Ylop collateral (low individual position value, uncertain outcome)
- Can use Ylop to fund the initial capital deployment across many small positions

### Implemented Changes

- Syncs open orders from the exchange and applies per-order remaining-size adjustments from confirmed fills.
- Tracks quote refresh and reconciliation timestamps for dashboard diagnostics.
- Keeps the low-price screener, quote refresh loop, and inventory state aligned with exchange truth.
- Surfaces health and reconciliation state in the bot detail view.
- Supports per-user allocation toggles so it can be paused independently during bot-by-bot testing.

---

## CEX Latency Arb (Not Implemented — Future)

**Strategy**: Binance/Coinbase price move → Polymarket BTC/ETH odds lag by 30–90s

### Why It's Deferred

- Fees introduced specifically to kill naive taker bots — margin disappears unless maker-only
- Requires co-location or very fast infrastructure
- Need maker order strategy: predict the move, pre-place the order, wait for fill

### When It Becomes Viable

- When we have maker-only execution path (rebates instead of fees)
- After validating latency < 1s from price feed to order submission
- Entry only when BTC has **already moved significantly** (confirmed trend, not prediction)

---

## Strategy Priority Matrix

| #   | Bot                | Risk     | Complexity | Capital Req | Ylop Fit  |
| --- | ------------------ | -------- | ---------- | ----------- | --------- |
| 1   | Market Maker       | Medium   | Medium     | Medium      | High      |
| 2   | Cross-Platform Arb | Medium   | High       | High        | High      |
| 3   | Copy Trader        | Medium   | Low        | Low         | Medium    |
| 4   | In-Market Arb      | Low      | Medium     | Low         | Very High |
| 5   | Resolution Lag     | Very Low | Medium     | Medium      | Very High |
| 6   | Microstructure     | Low-Med  | Low        | Low         | Low       |
| —   | CEX Latency Arb    | High     | Very High  | High        | Medium    |

---

## Shared Technical Infrastructure

- **CLOB Websocket**: Order book subscriptions for bots 1, 4
- **Data API polling**: Position snapshots for bots 3, 5
- **Event monitoring**: News/sports/oracle feed for bot 5
- **Market screener**: Batch position scan for bot 6
- **Orchestrator**: Capital routing, Ylop integration, risk limits for all bots
- **Treasury**: USDC balance tracking, lending via Ylop
- **Dashboard controls**: Per-user bot allocation toggles, health badges, diagnostics, and admin visibility into enabled/disabled bots
