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

---

## Bot 4 — In-Market Arb (YES + NO < $1)

**Status**: Planned (next implementation)  
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

---

## Bot 5 — Resolution Lag Buyer

**Status**: Planned  
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

---

## Bot 6 — Low-Price Microstructure ("0.1¢ Bot")

**Status**: Planned  
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
