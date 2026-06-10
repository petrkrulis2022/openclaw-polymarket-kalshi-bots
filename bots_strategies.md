# OpenClaw Bot Fleet — Strategy & Architecture Reference

Full description of every running bot: what it does, how it decides, how it executes, and its current live configuration. Covers all non-sport bots and all three sport bots (hockey, football, tennis).

---

## Bot Fleet at a Glance

| Bot | Name | Port (u9) | PM2 ID | Status | Strategy Type |
|-----|------|-----------|--------|--------|---------------|
| 1 | market-maker-u9 | 4100 | 32 | stopped | Bid-ask spread capture |
| 2 | kalshi-arb-u9 | 4108 | 43 | online | Cross-platform arb (Kalshi ↔ Poly) |
| 3 | copy-trader-u9 | 4101 | 31 | online | Trade copying |
| 4 | in-market-arb-u9 | 4102 | 30 | online | Same-market YES+NO arb |
| 5 | resolution-lag-u9 | 4103 | 40 | online | Post-resolution lag buying |
| 6 | microstructure-u9 | 4104 | 29 | online | Sub-$0.003 speculative longs |
| 8 | football-bot-u9 | 4106 | 38 | stopped | Sports score-lag (football) |
| 10 | hockey-bot-u9 | 4105 | 27 | stopped | Sports score-lag (hockey) |
| 11 | tennis-bot-u9 | — | 39 | stopped | Sports score-lag (tennis) |

Sport bots stop when no match is scheduled — they are restarted per match via the dashboard's watched-game controls. The `stopped` status is normal outside match windows.

---

## Infrastructure Stack

All bots share this foundation:

- **Runtime**: Node.js + TypeScript via `tsx` (no compile step)
- **Process manager**: PM2 (ecosystem file per user: `orchestrator/data/envs/ecosystem-u9.json`)
- **Capital routing**: Treasury service (port 3001) allocates USD per bot per user
- **Orchestrator** (port 3002): user management, PM2 control, per-user allocations, watched-game control
- **Web dashboard**: React SPA proxied through Cloudflare tunnel; shows all bot states, positions, diagnostics
- **Polymarket CLOB**: `https://clob.polymarket.com` — order placement, order book reads
- **Polymarket Gamma API**: `https://gamma-api.polymarket.com` — market metadata, lifecycle, token IDs, fee rates
- **Polymarket Data API**: `https://data-api.polymarket.com` — trader position snapshots (copy-trader), closed market scanning (resolution-lag)
- **Goalserve**: external live sports score feed (hockey, football bots only)
- **Wallet**: single Gnosis Safe proxy wallet per user; all bots share it (`POLY_1271` or `POLY_GNOSIS_SAFE` signature type)
- **State persistence**: each bot writes a JSON state file to `orchestrator/data/positions/` — survives restarts

---

## Non-Sport Bots

---

### Bot 1 — Market Maker (`market-maker-u9`, port 4100)

**Strategy**: Bid-ask spread capture on mid-range prediction markets.

#### Core Idea

Post resting limit orders on both sides of the CLOB in liquid political markets. Earn the bid-ask spread when both legs fill. The bot never takes a directional view — it profits only when it successfully quotes both sides.

#### Market Selection Logic

Every poll cycle the bot pulls the top-volume Polymarket markets from the Gamma API and applies these filters:

1. **Non-sports, non-crypto** — avoids high-fee categories and volatile intraday repricing
2. **Price range 10¢–90¢** — explicitly excludes near-resolved markets; the bot only quotes when there is genuine uncertainty and two-sided liquidity
3. **Minimum 24-hour volume ≥ $1,000** — ensures the book is active enough for fills to happen
4. **End date > 48 hours away** — prevents getting stuck in closing markets with one-sided books
5. **Top `numMarkets` = 5 by volume** — concentrates capital in the most liquid markets

#### Quoting Logic

For each selected market the bot reads the Gamma API bid/ask as the mid-price reference, then posts:

- **Buy order**: `mid − halfWidth` (default: `mid − 0.03`, i.e. 3 cents below mid)
- **Sell order**: `mid + halfWidth` (default: `mid + 0.03`, i.e. 3 cents above mid)

The full bid-ask spread captured per round-trip is `2 × halfWidth = 6 cents` at default settings. A `widthMultiplier = 1.2` can widen both sides proportionally when inventory is skewed.

Orders are re-quoted when:
- Mid moves more than 0.5% (`reQuoteThreshold = 0.005`)
- An existing order drifts more than 1% from market (`orderStalenessThreshold = 0.01`)
- Inventory skew exceeds 60% (`maxInventorySkew = 0.6`) — the overloaded side is widened

#### Inventory Management

The bot tracks net inventory per market. A `getSkew()` function measures how far the inventory has drifted from flat. When skew is positive (long YES), the sell order is moved tighter to encourage offloading; when negative (short), the buy order moves tighter. This prevents the bot from building an unhedged directional position.

#### Fees

Polymarket taker fee at mid (`0.5`) for a politics market is `0.04 × 0.5 × 0.5 = 1%`. The 6-cent gross spread needs to exceed 2 × 1% = 2% of capital to net positive — at 50¢ per share the threshold is comfortably met at default settings.

#### Key Parameters (live defaults)

| Parameter | Default | Effect |
|-----------|---------|--------|
| `quoteHalfWidth` | 0.03 | 3¢ each side, 6¢ total spread |
| `widthMultiplier` | 1.2 | 20% spread expansion under skew |
| `numMarkets` | 5 | Number of markets quoted simultaneously |
| `minVolume24h` | $1,000 | Minimum 24h volume for market selection |
| `pollIntervalMs` | 5,000 ms | Re-quote check frequency |
| `maxInventorySkew` | 0.60 | Trigger widening when 60% one-sided |
| `reQuoteThreshold` | 0.005 | Re-quote on 0.5% mid move |

---

### Bot 2 — Kalshi Arb (`kalshi-arb-u9`, port 4108)

**Strategy**: Cross-platform arbitrage between Kalshi and Polymarket on identical binary events.

**Current status**: Live with `dryRun=false`. Requires funding — Polymarket wallet needs USDC on Polygon, Kalshi account needs USD deposit.

#### Core Idea

The same binary question (election outcome, Fed rate decision, economic data release) trades simultaneously on Kalshi and Polymarket as independent markets. If `YES_Kalshi + NO_Polymarket < $1.00` after fees, buying both sides guarantees a $1.00 payout regardless of outcome — locked profit at entry with zero directional risk.

Example: Kalshi YES at 0.62 + Polymarket NO at 0.31 = $0.93 total cost → $0.07 locked profit per share.

#### Authentication

Kalshi uses RSA-PSS/SHA-256. Every request signs a message of `timestamp_ms + METHOD + path_without_query`. The private key is stored as `KALSHI_PRIVATE_KEY_PEM` (literal `\n` in env, restored at runtime). Signature type is PSS, NOT PKCS1v15.

#### Market Discovery (Mapper)

The mapper runs every 15-second scan cycle and produces the set of Kalshi↔Polymarket pairs:

**Polymarket side — Gamma API parallel fetch:**
- Fetches 15 pages × 100 markets = up to 1,500 active markets in parallel
- Parses `feeSchedule.rate` (NOT `takerBaseFee` which is a legacy field) as the real V2 rate
- Applies fee filter: `feeRate ≤ 0.08` (catches all categories: geopolitics 0%, politics 4%, sports 3%, crypto 7%)
- Actual effective fees at 50¢: politics 1%, sports 0.75%, crypto 1.75%

**Kalshi side — REST pagination:**
- Fetches up to 1,000 markets via `status=open` cursor pagination (5 pages × 200)
- Also explicitly fetches known low-volume economic series: KXFED, KXCPI, KXUNEMPLOY, KXGDP, KXPCE, KXINFL (these don't appear in top-volume results)
- Status filter: skips only `"settled"` and `"closed"` — Kalshi returns `"active"` not `"open"` in the status field, so filtering on `status !== "open"` incorrectly drops all markets

**Matching algorithm (two layers):**
1. **Static overrides**: known keyword pairs that need score boosting:
   - `"federal funds rate"` ↔ `"fed funds rate"`
   - `"fomc"` ↔ `"fomc"`
   - `"cpi"` ↔ `"cpi"`
   - `"unemployment rate"` ↔ `"unemployment"`
   - `"gdp"` ↔ `"gdp"`
   - Override boost (score → 0.7) applies only when **both** sides contain the keyword, preventing false matches
2. **Auto-match**: token overlap score on normalized titles (lowercase, strip punctuation, ignore short words), plus date proximity check (end dates within ±168 hours)
3. Minimum score threshold: 0.3 to form a pair

#### Order Book & Signal Calculation

Kalshi does not return asks — only bids. Asks are reconstructed: `YES_ask = 1 − best_NO_bid`, `NO_ask = 1 − best_YES_bid`.

For each direction (YES-on-Kalshi/NO-on-Polymarket and vice versa):
1. Walk both order books depth-first up to `maxPositionUsd = $200`
2. Compute VWAP for each side (not just top-of-book)
3. Subtract fees from both venues: `kalshiFee = feeRate × price × (1 − price)`, same formula for Polymarket
4. `netEdge = 1.00 − VWAP_kalshi − VWAP_poly − fees`
5. Signal fires only if `netEdge > minNetSpreadPct = 1.0%`

Walking the full book is critical — using only the top-of-book price produces phantom edge that disappears when you try to fill volume.

#### Execution

Both legs fire concurrently via `Promise.all`. Either failure cancels both immediately. Orders are Fill-or-Kill (FOK) — no resting orders, no partial fills.

Rate limiting: Kalshi orderbook calls are batched in groups of 5 with 300ms between batches to avoid 429 errors.

Kalshi order `count` field must be an integer (not a decimal string) — `Math.max(1, Math.round(sizeUsd / price))`.

#### Exit

Two paths (monitored by `closer.ts`, runs every 60 seconds):
- **Early exit**: if spread on open pair compresses to < 0.25% net, sell both legs — frees capital in days
- **Hold to resolution**: both legs pay out $1 at resolution regardless of winner — profit locked at entry

#### Key Parameters (live defaults)

| Parameter | Default | Effect |
|-----------|---------|--------|
| `scanIntervalMs` | 15,000 ms | Full market scan + signal check frequency |
| `minNetSpreadPct` | 1.0% | Minimum edge after all fees to enter |
| `maxPositionUsd` | $200 | Max capital per pair |
| `maxOpenPairs` | 5 | Concurrent open positions cap |
| `dryRun` | false (live) | Real orders enabled |

---

### Bot 3 — Copy Trader (`copy-trader-u9`, port 4101)

**Strategy**: Mirror the position changes of tracked high-performing Polymarket traders.

#### Core Idea

Poll the Polymarket Data API (`data-api.polymarket.com/positions?user={address}`) for a tracked trader's current positions every 10 seconds. When their position in any market increases or decreases, generate a copy signal and trade a proportionally scaled version on our wallet.

#### Trader Tracking

Traders are stored in `orchestrator/data/positions/copy-trader-u9-traders.json` (persisted across restarts via `TRADERS_STATE_FILE` env var). Each tracked trader has:
- `address`: Polymarket proxy wallet address (0x)
- `label`: human-readable name
- `allocationUsd`: maximum USD allocated to copying this trader
- `copyRatio`: fraction of their delta to replicate (0.0–1.0, where 1.0 = copy 1:1)
- `mode`: `manual` (user approves each trade), `auto` (execute immediately), or `orchestrator` (AI decides)
- `enabled`: pause without removing

Adding a trader via the dashboard accepts three URL formats: `polymarket.com/@username` (auto-resolved via API), `polymarket.com/profile/0x...`, or a raw `0x...` address.

#### Signal Generation

Every 10-second poll cycle (`pollIntervalMs`):
1. Fetch current positions snapshot for each enabled trader
2. Diff against previous snapshot: `delta = currSize − prevSize` per token
3. Skip if `|delta| × curPrice < minSignalUsd = $3.00` (prevents dust trades)
4. Scale our order: `ourShares = min(|delta| × copyRatio, allocationUsd / curPrice)`
5. Skip if `ourShares × curPrice < minSignalUsd` after scaling

**Critical first-poll suppression**: On a trader's very first poll, all existing positions are recorded as the baseline snapshot. Signals are NOT generated from the first snapshot — this prevents the bot from blindly copying a trader's entire existing portfolio the moment they are added.

#### Execution Modes

- **Manual**: signal added to pending queue, user approves or rejects via dashboard
- **Auto**: executed immediately on detection
- **Orchestrator**: sent to orchestrator for AI review; result posted back via `/pending/:id/orchestrator-decision`

Pending trades expire after 5 minutes (`pendingExpiryMs`) if not approved.

#### State Persistence

Positions stored in `POSITIONS_STATE_FILE`. The bot rebuilds its inventory exclusively from this persisted state on restart — it never re-reads CLOB trade history, which would mix in trades from other bots sharing the same wallet.

#### Key Parameters

| Parameter | Default | Effect |
|-----------|---------|--------|
| `pollIntervalMs` | 10,000 ms | Trader position check frequency |
| `pendingExpiryMs` | 300,000 ms (5 min) | Auto-expire unapproved trades |
| `minSignalUsd` | $3.00 | Minimum trade size to act on |
| `maxSignalDriftPct` | 15% | Max price drift allowed from signal price |

---

### Bot 4 — In-Market Arb (`in-market-arb-u9`, port 4102)

**Strategy**: Pure mathematical arbitrage within a single Polymarket market where YES + NO < $1.00.

#### Core Idea

On any binary Polymarket market, YES + NO = exactly $1.00 at resolution. If the CLOB temporarily shows `YES_ask + NO_ask < $1.00` (due to illiquidity, impatient sellers, or delayed repricing), buying both is a risk-free profit regardless of outcome.

#### Signal Formula

```
spread = 1.00 − (YES_ask + NO_ask)
```

Enter only when `spread > fees + slippage_buffer`. At current fee rates (e.g. politics 4% formula rate, effective ~1% at mid), the threshold is approximately 2–3% gross spread.

#### Order Book Walk

The bot does not use only the top-of-book price. It walks both books:

```
for each YES level:
  for each NO level:
    if YES_price + NO_price < 1.00:
      profitable_volume += min(YES_volume, NO_volume)
```

This prevents entering a signal that looks profitable at the top of the book but disappears after the first few shares.

#### Execution

Both legs fire simultaneously via `Promise.all`. If either leg fails or returns a zero fill, the other leg is cancelled immediately. Both orders are FOK.

#### Multi-Outcome Extension

The same logic extends to multi-outcome markets:
- **Multi-binary**: buy all outcomes if sum of asks < $1.00
- **Negative risk (NO sweep)**: on a neg-risk event with N outcomes, `sum of all NO_asks < N − 1` means buy all NOs

#### Risk Profile

- **Directional risk**: zero if both legs fill simultaneously
- **Execution risk**: one leg fills, other doesn't → brief directional exposure
- **Resolution risk**: none — guaranteed $1.00 regardless of outcome

---

### Bot 5 — Resolution Lag (`resolution-lag-u9`, port 4103)

**Strategy**: Buy confirmed-winner tokens from impatient sellers while the Polymarket oracle is delayed.

#### Core Idea

After an event resolves in the real world (game ends, election called), Polymarket's UMA oracle takes 24–72 hours to officially settle. During this window, holders of winning tokens who don't want to wait sell at a discount — 95¢–99¢ instead of the $1.00 they'll receive at settlement.

The bot continuously scans for these windows and buys the discount.

#### Detection Logic

The bot polls the Gamma API for markets with `closed=true&active=false` (the recently-closed bucket). For each closed market:

1. **Gamma winner check**: Gamma's `winner` field identifies the winning outcome token
2. **CLOB winner confirmation** (`requireClobWinnerConfirmation=true`): calls `getResolvedWinnerTokenId()` which asks the CLOB if it also considers the market resolved with that winner — this is the safety gate that prevents buying a token the CLOB hasn't confirmed yet
3. **Time buffer**: requires `minPostEndMinutes = 45` minutes after `end_date` before entering — avoids acting on Gamma data before it has had time to stabilize
4. **Price check**: reads the CLOB ask price on the winning token
5. **Yield check**: `expectedYield = (1.00 − ask) / ask`; enters only if yield ≥ `minYieldPct = 0.5%`

#### Price Range

- `minAskPrice = 0.01` (1¢) — will buy winning tokens as cheap as 1¢
- `maxAskPrice = 0.99` (99¢) — won't buy above 99¢
- Effective ceiling: `minYieldPct = 0.5%` means the bot won't pay more than `1 / 1.005 ≈ 0.995` (99.5¢)

This captures the full range that bobe2-style manual traders work: from very cheap winners (high yield, likely very long lag) down to 99.5¢ (0.5% yield, very short lag).

#### Return Profile

| Ask Price | Yield | Annualized at 3-day lag |
|-----------|-------|------------------------|
| 97¢ | 3.1% | ~375% APY |
| 98¢ | 2.0% | ~245% APY |
| 99¢ | 1.0% | ~122% APY |
| 99.5¢ | 0.5% | ~61% APY |

The actual APY depends on how long the oracle takes to settle. Faster settlement = higher effective APY.

#### Key Parameters

| Parameter | Default | Effect |
|-----------|---------|--------|
| `minYieldPct` | 0.5% | Minimum yield to enter |
| `minAskPrice` | 0.01 | Price floor — buy down to 1¢ |
| `maxAskPrice` | 0.99 | Price ceiling |
| `minPostEndMinutes` | 45 min | Wait after market end before acting |
| `maxPositionUsd` | $100 | Per-position size cap |
| `maxOpenPositions` | 20 | Simultaneous open position cap |
| `requireClobWinnerConfirmation` | true | Only buy if CLOB also confirms winner |

---

### Bot 6 — Microstructure (`microstructure-u9`, port 4104)

**Strategy**: Speculative long-shot buying on ultra-cheap tokens (below 0.3¢) with 2× exit targets.

**Note**: This is a fundamentally different strategy from the resolution-lag bot. The microstructure bot buys on *active, unresolved* markets where the token is cheap because the outcome is unlikely — not because the oracle is delayed.

#### Core Idea

In illiquid Polymarket markets, a YES share trading at 0.1–0.3¢ (0.1–0.3% implied probability) has a bid-ask spread that is large relative to its price. The bot posts resting bids at the bottom of the market (≤ 0.3¢), then immediately posts a sell at 2× entry price when filled. On a 0.2¢ buy + 0.4¢ sell, that's a 100% return if the exit fills.

#### Screener Criteria

Every 30 minutes the bot scans all active Polymarket markets for tokens meeting all of:
- `curPrice < 0.003` (below 0.3¢)
- Time to expiry > 90 days (reduces total-loss risk; long enough for the price to move)
- Some 24h volume (proves liquidity exists)
- Market not approaching resolution

Screened markets are cached and re-quoted every 30 seconds.

#### Quoting Logic

- Post limit bid at current top bid (≤ 0.3¢)
- On fill: immediately post sell at 2× entry price
- Track positions independently per token

#### Risk

The primary risk is **total loss**: if the event unexpectedly resolves YES while the bot holds a cheap NO token (or vice versa), the entire position goes to zero. This is mitigated by:
- Only entering markets with >90 days remaining (reduces resolution risk per unit time)
- Small position size cap per market
- Diversification across many markets (expected-value positive if spread capture outweighs total-loss events)

This is a high-expected-value, high-variance strategy at the position level, but diversification across 50–100 positions smooths the variance.

---

## Sport Bots

All three sport bots exploit the same fundamental edge: **Polymarket markets don't instantly reprice after a real-world scoring event**. The few seconds to minutes between a goal/point being scored and the order book fully adjusting creates a window to buy at stale prices.

### Shared Three-Layer Data Architecture

Every sport bot uses exactly three data sources with distinct roles:

| Source | Role | Why |
|--------|------|-----|
| **Goalserve** (hockey, football) | Score trigger only | Detects goals before order book reprices |
| **Polymarket Gamma API** | Market lifecycle truth | Tells us if market is still active, token IDs, official resolution |
| **Polymarket CLOB** | Pricing and execution | Actual bids/asks, order placement |

Goalserve status strings (e.g. "1st Period", "HT") are **not trusted for game-over decisions** — Goalserve sometimes lags or mislabels transitions. Game lifecycle (active/closed/resolved) is always confirmed via Gamma API. Tennis has no Goalserve at all.

### Shared Market Structure

All sport bots trade the **moneyline win market** (also called "home team wins" or "player A wins"). The market structure varies by sport:

- **Hockey**: 2-way market — YES (home wins) / NO (home doesn't win; includes draw/overtime)
- **Football**: 3-way neg-risk moneyline — Home Win / Draw / Away Win (three separate tokens)
- **Tennis**: 2-way market — YES (player A wins) / NO (player B wins)

The market is identified by an event `slug` in the Gamma API. Slugs are either:
- Entered manually via the dashboard
- Auto-resolved by entering team/player names — the bot searches all active Gamma events for a title that fuzzy-matches both team names

### Shared Execution Flow

1. **Pre-game phase** (preGamePollMs = 1s polling): Wait for Gamma `active=true` and CLOB accepting orders; locate token IDs via `fetchHomeTeamMarket()`
2. **Live phase** (livePollMs = 1s): Poll Goalserve for score changes; on delta, map scoring side to token, confirm via Gamma, check CLOB depth, fire FOK buy
3. **Sell phase** (sellPollMs = 1s): Monitor best bid on held position; exit when:
   - Profit target reached (`minProfitCents = 0.04`, i.e. 4¢ per share)
   - Stop-loss hit (`stopLossRatio = 0.9`, i.e. position worth <90% of entry)
   - Hard loss cap reached (`maxLossCents = 0.03`)
   - Hold timeout expired (`sellTimeoutMinutes = 15`)
   - Gamma/CLOB shows game is over

### Shared FOK Order Handling

All sport bots place **Fill-or-Kill market orders** via `placeMarketOrder()`. The CLOB client (`clob-client-v2`) posts the order with a worst-acceptable-price parameter:
- BUY: worst price = 0.99 (will pay any ask up to 99¢)
- SELL: worst price = 0.01 (will accept any bid down to 1¢)

The CLOB occasionally returns `status="delayed"` on market-moving events (Polymarket's anti-manipulation brief pause). When detected, the bot polls the order's status every 2 seconds for up to 30 seconds until it fills or is cancelled.

### Shared Team Name Normalization

Team names from Goalserve (e.g. "Czech Republic") and from Gamma (e.g. "Czechia") don't always match. The bots maintain alias tables:
- `"czech republic"` ↔ `"czechia"`
- `"slovak republic"` ↔ `"slovakia"`
- `"united states"` ↔ `"usa"`, `"us"`
- Strip prefixes: `FC`, `SK`, `HC`, `AC`, etc.

Tennis additionally adds first name and last name as standalone aliases — Gamma might say "Carlos Alcaraz wins" while Goalserve says "Alcaraz".

---

### Hockey Bot (`hockey-bot-u9`, port 4105, Bot ID 10)

**Status**: Stopped (normal — restarts per match). 18 restarts total (heavy in-season usage).

#### Sport-Specific Details

- **Score source**: Goalserve `hockey/home?json=1` and `hockey/d1?json=1` feeds (polls both, picks best)
- **Market type**: 2-way moneyline — YES token = home team wins, NO token = home team does not win
- **Periods**: Hockey has 3 periods + potential OT/shootout. The bot treats all inter-period pauses (`"1st Period"`, `"2nd Period"`, `"3rd Period"`, `"Period Break"`, `"Intermission"`) as live game states — game-over detection only from Gamma
- **Full-time detection**: `"FT"`, `"AET"`, `"Final"`, `"Final/OT"`, `"After Shootout"`, `"After Penalties"` etc.

#### Goalserve Feed Details

The `hockey/home?json=1` endpoint returns a JSON tree with variable nesting depending on league. The bot uses recursive tree traversal to find the match node by team name (not just by pre-known static ID). This is necessary because Goalserve's structure varies between leagues (IIHF World Championship vs club hockey).

Match identification uses two IDs: `@static_id` (stable across a tournament) and `@fix_id` (per-fixture). Both are tracked; the one with more live data (score + running clock) is preferred.

#### Known Alias Issues

Hockey regularly produces team name mismatches between Goalserve and Gamma:
- World Championship: "Czech Republic" (Goalserve) vs "Czechia" (Gamma)
- Some eastern European clubs have Cyrillic transliterations ("Praha" vs "Prague")
- Club names with prefixes: "HC Sparta Prague" vs "Sparta Prague"

All handled by the alias system in both `goalserve.ts` and `polymarket.ts`.

---

### Football Bot (`football-bot-u9`, port 4106, Bot ID 8)

**Status**: Stopped (normal — restarts per match). 6 restarts total.

#### Sport-Specific Details

- **Score source**: Goalserve football feeds (analogous paths to hockey but for football leagues)
- **Market type**: 3-way neg-risk moneyline — Home Win / Draw / Away Win
- **Halftime**: Football has a halftime break. The bot treats `"HT"`, `"Half-time"`, `"Break Time"` as live game states (game not over during halftime)
- **Draw handling**: The draw outcome is a separate token in the 3-way market. A goal for the home team means buying the Home Win token, not just "YES"

#### Key Difference from Hockey

Football's 3-way market means the mapping from "team scored" to "token to buy" is more nuanced:
- Home goal → buy Home Win token
- Away goal → buy Away Win token
- Goal leading to a draw state → the Draw token may be relevant

The `fetchHomeTeamMarket()` function in football's `polymarket.ts` specifically finds the home-team moneyline sub-market within the neg-risk event by filtering `sportsMarketType` containing `"moneyline"` and matching the team name against `groupItemTitle` / `question`.

---

### Tennis Bot (`tennis-bot-u9`, port —, Bot ID 11)

**Status**: Stopped. Not currently in the ecosystem config (not auto-started). Was registered in PM2 separately.

#### Key Difference: No Goalserve

Tennis does not use Goalserve. The tennis bot has only `config.ts` and `polymarket.ts` — no `goalserve.ts`. This means tennis lacks a dedicated external score-trigger feed.

Likely mechanisms (from code structure):
- The bot may watch for large sudden movements in the CLOB bid/ask as a proxy for a set being won
- Or it awaits a future integration with an ATP/WTA live score API

Until the score feed is added, the tennis bot is only capable of the Polymarket-side operations: finding the match, loading token IDs, reading the order book, and placing orders. The score-triggered entry logic requires an external trigger source.

#### Tennis Market Structure

Tennis markets are 2-way: YES = Player A wins the match, NO = Player B wins. The `polymarket.ts` for tennis identifies the match via team name aliases that include:
- Full name: `"Carlos Alcaraz"`
- Last name only: `"alcaraz"`
- First name only: `"carlos"`

This handles Polymarket's various question formats ("Will Alcaraz win?", "Carlos Alcaraz vs Djokovic" etc.)

---

## Shared Risk Parameters (Sport Bots)

All three sport bots use the same config defaults:

| Parameter | Default | Effect |
|-----------|---------|--------|
| `maxPositionUsd` | $10 | Max capital per goal signal |
| `minProfitCents` | 0.04 | Exit sell when bid ≥ entry + 4¢ |
| `stopLossRatio` | 0.90 | Exit sell when bid < 90% of entry |
| `maxLossCents` | 0.03 | Hard stop: exit if loss > 3¢/share |
| `sellTimeoutMinutes` | 15 | Force-exit after 15 minutes regardless |
| `holdBeforeSellSeconds` | 30 | Minimum hold before starting to monitor exit |
| `preGamePollMs` | 1,000 ms | Pre-kickoff check frequency |
| `livePollMs` | 1,000 ms | In-game score check frequency |
| `sellPollMs` | 1,000 ms | Sell-phase bid monitoring frequency |

---

## Data Source Summary

| Source | Used By | Purpose |
|--------|---------|---------|
| Gamma API (`gamma-api.polymarket.com`) | All bots | Market metadata, token IDs, fee rates, lifecycle flags |
| Polymarket CLOB (`clob.polymarket.com`) | All bots | Order book reads, order placement, collateral balance |
| Polymarket Data API (`data-api.polymarket.com`) | Copy Trader, Resolution Lag | Trader position snapshots, closed market scanning |
| Goalserve | Hockey, Football | Live score triggers (goals, halftime, FT) |
| Kalshi REST API | Kalshi Arb | Market listing, order books, order placement |
| Orchestrator (`localhost:3002`) | All bots | Capital allocation, user config, watched-game data |
| Treasury (`localhost:3001`) | All bots | USD allocation per bot, equity tracking |

---

## Fee Reference

All Polymarket fees use the V2 formula: `fee = feeRate × price × (1 − price)`. Maximum at `price = 0.50`.

| Category | Formula Rate | Max Effective Fee (at 50¢) |
|----------|-------------|---------------------------|
| Geopolitics | 0% | 0% |
| Sports | 3% | 0.75% |
| Politics | 4% | 1.00% |
| Crypto (general) | 7% | 1.75% |
| Crypto (5-min, 15-min) | 12.6% | 3.15% |

Kalshi fee is computed as: `feeRate × price × (1 − price)` — same formula. Typical Kalshi feeRate is 0.7% for political markets.

For the Kalshi arb bot to be profitable, the locked spread must exceed the sum of both venues' effective fees. At 50¢ with politics + Kalshi: `1.0% + ~0.175% = ~1.175%` minimum required edge.

---

## Strategy Comparison Matrix

| Bot | Edge Source | Directional Risk | Resolution Risk | Capital Turnover | Typical Hold |
|-----|-------------|-----------------|-----------------|-----------------|--------------|
| Market Maker | Bid-ask spread | Inventory skew | None | High (fills → recycle) | Seconds–minutes |
| Kalshi Arb | Cross-venue spread | None (both sides) | None (hedged) | Low (wait for resolution) | Days–weeks |
| Copy Trader | Skilled trader alpha | Mirrors trader | Mirrors trader | Medium | Variable |
| In-Market Arb | YES+NO < $1 spread | None (both sides) | None (hedged) | Medium | Minutes–hours |
| Resolution Lag | Oracle settlement delay | None (winner confirmed) | Oracle dispute (rare) | Low (wait for oracle) | 24–72 hours |
| Microstructure | Low-price spread capture | Full position risk | Resolution = total loss | High (fill → 2× exit) | Hours–days |
| Hockey/Football | Score-lag repricing | Full (one token) | None (exit before resolve) | Very high (per goal) | <15 minutes |
| Tennis | Price-lag repricing | Full (one token) | None | Very high | <15 minutes |
