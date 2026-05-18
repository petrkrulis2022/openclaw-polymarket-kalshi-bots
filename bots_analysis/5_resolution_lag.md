# Resolution-Lag Bot — Trade Analysis

**Generated:** May 18, 2026  
**Bot ID:** 5 (resolution-lag)  
**Total closed trades:** 7  
**Net P&L:** +$299.73  
**Win rate:** 2 / 7 (28.6%)

---

## How the Bot Works

The resolution-lag bot (`bots/resolution-lag/`) exploits a timing gap between two independent resolution systems on Polymarket:

1. **Gamma API** — Polymarket's off-chain oracle, resolves markets quickly after the real-world event concludes.
2. **CLOB** — Polymarket's Central Limit Order Book, settles the winning token price to exactly $1.00, but lags behind Gamma by minutes to hours.

During this lag window, the winning token can still be bought below $1 on the open market from traders who haven't seen the resolution yet (or have priced in residual uncertainty). The bot buys it cheap, waits for CLOB to catch up, and collects $1 per share at settlement.

### Execution Pipeline

```
monitor.ts  →  oracle.ts  →  executor.ts  →  inventory.ts
```

1. **monitor.ts** — Polls Gamma every 5 minutes for recently closed markets (`resolved=true`). Maps the winning outcome label to the correct ERC-1155 token ID.
2. **oracle.ts** — Fetches the CLOB best ask price on the winning token. If ask is meaningfully below $1 and above the minimum threshold, calculates expected yield = `(1 - ask) / ask`. Requires 2 consecutive passing scans before acting.
3. **executor.ts** — Places a CLOB limit buy order for `maxPositionUsd / currentAsk` shares (targeting ~$100 spent per trade). Records the position in memory.
4. **inventory.ts** — Polls every 60 seconds; when the token price reaches $1 (CLOB resolved), calls `resolvePosition()` to record the closed trade in Supabase.

> **⚠️ Known gap:** `resolvePosition()` records the trade internally but **never calls the blockchain** to redeem CTF tokens. Winning positions must be manually redeemed via the `/redeem` HTTP endpoint or a separate script. This caused the ceasefire $331 to sit unredeemed for 41 days.

### Wallet Usage

| Period           | Wallet                                       | Type                                 |
| ---------------- | -------------------------------------------- | ------------------------------------ |
| Apr 7 – Apr 22   | `0xD7CA8219C8AfA07b455Ab7e004FC5381B3727B1e` | Old EOA ("cube-pay.eth")             |
| May 12 – present | `0xa31e372e43C8D7d106d9a1A465C79a58e834cA1A` | Proxy wallet (Gnosis-style contract) |

### Config at Time of Trades

The server (`/home/krulda/...`) was running an older version of the code than what is in the current git repo. The key difference:

| Parameter                | Old code (server)            | Current code (repo)                        |
| ------------------------ | ---------------------------- | ------------------------------------------ |
| `MIN_ASK_PRICE`          | _(not present — no minimum)_ | 0.85                                       |
| `MAX_ASK_PRICE`          | 0.99                         | 0.99                                       |
| Market types             | Binary YES/NO only           | Binary + non-binary (team names)           |
| CLOB winner confirmation | Not required                 | Required (`requireClobWinnerConfirmation`) |

The `MIN_ASK_PRICE=0.85` safety filter was added in commit `e43555e` on **May 14, 2026**. Without it, the bot would attempt any market where Gamma=resolved and CLOB ask < $0.99 — including markets where the winning token was priced at a few cents (normal for live uncertain markets).

---

## Trade-by-Trade Analysis

### 1. US x Iran Ceasefire by April 7? ✅ WON +$326.16

| Field         | Value         |
| ------------- | ------------- |
| Wallet        | Old EOA       |
| Shares bought | 331.03        |
| Avg buy price | $0.0147       |
| Total cost    | ~$4.87        |
| Settled price | $1.00         |
| Net PnL       | **+$326.16**  |
| Date          | April 7, 2026 |

**What happened:** A US-brokered ceasefire between Israel and Hamas was confirmed on April 7. Gamma resolved the "US x Iran ceasefire by April 7?" market YES almost immediately. The CLOB, however, still had the YES token trading at just **$0.0147** — 98.5% below its fair value.

**Why the price was so low:** Before the ceasefire was announced, the market had been pricing the outcome as very unlikely (~1-2% probability). When Gamma resolved YES, many market makers hadn't yet updated their quotes, creating a brief window where the winning token was essentially free.

**Bot behavior:** The executor targeted `$100 / $0.0147 = 6,803 shares`, but only 331 shares were available at that price level across 7 partial fills (visible in the on-chain NFT transfer history). The bot also sold some shares back to the market at near-$1 prices via 2 SELL transactions on April 5-6 (before/during resolution), capturing partial profit at market price while keeping 331 tokens for CTF redemption.

**Resolution lag:** The bot's `resolvePosition()` recorded the win internally but never redeemed the CTF tokens. The 331 YES tokens sat in the CTF contract for **41 days** until manually redeemed today (May 18) via the `redeem-ceasefire.ts` script, collecting ~$331 USDC.e.

**Return on capital:** $326.16 profit on $4.87 invested = **~6,600% ROI**. This single trade accounts for **99% of all profits** across the bot's history.

---

### 2. Sunrisers Hyderabad vs Lucknow Super Giants ❌ LOST -$2.12

| Field         | Value          |
| ------------- | -------------- |
| Wallet        | Old EOA        |
| Shares bought | 20             |
| Avg buy price | $0.1062        |
| Total cost    | $2.12          |
| Settled price | $0.00          |
| Net PnL       | **-$2.12**     |
| Date          | April 12, 2026 |

**What happened:** IPL cricket match — Sunrisers Hyderabad vs Lucknow Super Giants. **Lucknow Super Giants won the match.** The bot's Sunrisers Hyderabad tokens settled at $0.

**Why the bot entered:** Gamma reported Sunrisers Hyderabad as the winner. The CLOB still had the Sunrisers token at $0.1062 — the bot saw this as a resolution lag (paying $0.1062 for a token that should be worth $1.00 = 841% expected yield). The old monitor.ts code (pre-May 14) that handled non-binary team-name markets was likely already running on the server.

**Why it lost:** Gamma either briefly mis-resolved the market (reading incorrect interim data) or the result was contested/updated after the bot entered. The actual final result was Lucknow winning.

**Risk factor demonstrated:** At only $0.1062 per share, the token was already priced extremely cheaply — this is a signal that the market consensus was NOT pricing Sunrisers as a heavy favourite, suggesting the resolution was uncertain. The `MIN_ASK_PRICE=0.85` safety filter (added later) would have blocked this trade entirely.

---

### 3. Cameron Norrie vs Alex de Minaur ❌ LOST -$1.90

| Field         | Value          |
| ------------- | -------------- |
| Wallet        | Old EOA        |
| Shares bought | 5              |
| Avg buy price | $0.3800        |
| Total cost    | $1.90          |
| Settled price | $0.00          |
| Net PnL       | **-$1.90**     |
| Date          | April 15, 2026 |

**What happened:** Rolex Monte Carlo Masters tennis match — **Alex de Minaur won**, not Norrie. The bot bought Cameron Norrie shares expecting the CLOB to settle to $1, but instead they settled to $0.

**Why the bot entered:** Gamma indicated Cameron Norrie as the winner and the CLOB had the token at $0.38 — still in the sub-$0.99 zone the bot was scanning. At 38 cents, the expected yield would have been 163%.

**Why it lost:** De Minaur actually won the match. The $0.38 price point indicates Norrie was priced as a moderate underdog in real-time, meaning the CLOB market may not have actually been in a "lag" state — it may have correctly priced Norrie's real winning chances at ~38%. The bot treated it as a lag opportunity when it may have been normal pre-resolution live pricing.

**Note:** The `MIN_ASK_PRICE=0.85` filter would have blocked this trade (0.38 < 0.85).

---

### 4. US x Iran Permanent Peace Deal by April 22, 2026? ❌ LOST -$2.70

| Field         | Value          |
| ------------- | -------------- |
| Wallet        | Old EOA        |
| Shares bought | 15             |
| Avg buy price | $0.1800        |
| Total cost    | $2.70          |
| Settled price | $0.00          |
| Net PnL       | **-$2.70**     |
| Date          | April 22, 2026 |

**What happened:** A distinct market from the ceasefire (Trade #1). This asked whether the US and Iran would reach a **permanent peace deal** by April 22. **No permanent peace deal occurred.** The market resolved NO.

**Why the bot entered:** This market was likely swept up in the same resolution-lag opportunity that produced the ceasefire win. After the ceasefire was announced (April 7), Gamma may have temporarily resolved this related "permanent peace" market as YES as well — or the bot's Gamma poll picked it up while scanning for the ceasefire resolution. The token was at $0.18 which represents a 456% expected yield if it were to settle at $1.

**Why it lost:** A ceasefire ≠ a permanent peace deal. This market correctly resolved NO. This is the clearest example of the bot misidentifying a related but distinct market as a resolution-lag opportunity.

**Risk factor demonstrated:** The `MIN_ASK_PRICE=0.85` filter would have blocked this (0.18 < 0.85). The very low price ($0.18) should have been a warning sign — a genuine resolution-lag token on the verge of settling would be trading near $0.95–$0.99, not $0.18.

---

### 5. Gujarat Titans vs Sunrisers Hyderabad ✅ WON +$17.37

| Field         | Value        |
| ------------- | ------------ |
| Wallet        | Proxy wallet |
| Shares bought | 55           |
| Avg buy price | $0.6842      |
| Total cost    | ~$37.63      |
| Settled price | $1.00        |
| Net PnL       | **+$17.37**  |
| Date          | May 12, 2026 |

**What happened:** IPL cricket match — **Gujarat Titans won**. The bot bought Gujarat Titans shares at $0.68 and the token settled to $1.00 once CLOB caught up with Gamma's resolution.

**Why the bot entered:** Gujarat was priced at 68 cents — a meaningful discount from $1. After the match ended and Gamma resolved Gujarat as the winner, the CLOB lagged. The bot correctly identified this as a resolution-lag window.

**Why it won:** Gujarat genuinely won the match. The $0.68 price represents a realistic post-resolution lag — the token was already priced near its fair value, with a 46% expected yield still on the table.

**Note:** $0.68 is still below the `MIN_ASK_PRICE=0.85` filter that was added on May 14. This trade occurred on May 12, before the server pulled the updated code with the price filter. It happened to be correct.

---

### 6. New York Yankees vs Baltimore Orioles ❌ LOST -$36.68

| Field         | Value           |
| ------------- | --------------- |
| Wallet        | Proxy wallet    |
| Shares bought | 66.70           |
| Avg buy price | $0.5499         |
| Total cost    | $36.68          |
| Settled price | $0.00           |
| Net PnL       | **-$36.68**     |
| Date          | May 13–14, 2026 |

**What happened:** MLB baseball game — **Baltimore Orioles won**. The bot bought 66.70 Yankees shares at $0.5499 each, which settled to $0. This is the **largest single loss** in the bot's history.

**Why the bot entered:** The Yankees token was priced at $0.5499 — 55 cents. The bot saw this as a resolution-lag opportunity (Gamma said Yankees won, CLOB still below $1). However, a price of 55 cents for the "winning" token is a major red flag: in a genuine post-game resolution lag, the winning token should already be priced at $0.90–$0.99 as the market incorporates the known result. A price of 55 cents indicates **the game was very likely still in progress or the result was genuinely uncertain** when the bot entered.

**Why it lost:** The Baltimore Orioles won. The bot incorrectly identified a live or recently-resolved market as a lag opportunity, probably because Gamma briefly showed Yankees as the winner (inning-by-inning provisional resolution?) or the market data was stale.

**Critical failure mode:** This is exactly the false-positive scenario the `MIN_ASK_PRICE=0.85` filter was designed to prevent. A token at 55 cents is NOT in a lag — it's either live or uncertain. Had the filter been active on the server, this $36.68 trade would have been skipped entirely.

---

### 7. Philadelphia Phillies vs Boston Red Sox ❌ LOST -$0.40

| Field         | Value           |
| ------------- | --------------- |
| Wallet        | Proxy wallet    |
| Shares bought | 5               |
| Avg buy price | $0.0800         |
| Total cost    | $0.40           |
| Settled price | $0.00           |
| Net PnL       | **-$0.40**      |
| Date          | May 13–14, 2026 |

**What happened:** MLB baseball game — **Boston Red Sox won** (or the Phillies market resolved NO). Phillies shares settled to $0.

**Why the bot entered:** At $0.08 per share, Phillies was priced similarly to the ceasefire trade (#1). Gamma must have briefly indicated Phillies as the winner with the CLOB still at 8 cents. Very low ask + Gamma-resolved = bot buys.

**Why it lost:** The actual game result went against Phillies. The very low price (8 cents) again signals that the CLOB market consensus did NOT agree with Gamma — this was likely another brief Gamma misfire or a market that was not yet definitively resolved.

**Note:** Despite the pattern being identical to the ceasefire trade (very low price, Gamma-resolved), the outcome was the opposite. The key difference: the ceasefire was a geopolitical event with unambiguous resolution data; baseball game results can have ambiguous interim states.

---

## Summary

### Financial Overview

| Trade                  | Result   | Cost       | P&L          | ROI       |
| ---------------------- | -------- | ---------- | ------------ | --------- |
| Iran Ceasefire (Apr 7) | ✅ WON   | $4.87      | +$326.16     | +6,695%   |
| Sunrisers (Apr 12)     | ❌ LOST  | $2.12      | -$2.12       | -100%     |
| Norrie (Apr 15)        | ❌ LOST  | $1.90      | -$1.90       | -100%     |
| Iran Peace (Apr 22)    | ❌ LOST  | $2.70      | -$2.70       | -100%     |
| Gujarat (May 12)       | ✅ WON   | $37.63     | +$17.37      | +46%      |
| Yankees (May 13–14)    | ❌ LOST  | $36.68     | -$36.68      | -100%     |
| Phillies (May 13–14)   | ❌ LOST  | $0.40      | -$0.40       | -100%     |
| **TOTAL**              | 2/7 wins | **$86.30** | **+$299.73** | **+347%** |

### Without the Ceasefire Trade

| Metric           | Value       |
| ---------------- | ----------- |
| Capital deployed | $81.43      |
| Net P&L          | **-$26.43** |
| Return           | **-32%**    |

The ceasefire trade ($4.87 invested, +$326 returned) accounts for 99% of all profits. Excluding it, the bot has been a net loser — primarily due to the Yankees trade (-$36.68) which was almost certainly a live-game false positive.

### Root Causes of Losses

1. **No minimum ask price filter (server running old code):** The `MIN_ASK_PRICE=0.85` guard was added to the codebase on May 14 but was never deployed to the server via `git pull`. All 5 losing trades had ask prices ≤ $0.55 — all would have been blocked by the filter.

2. **Live game detection gap:** At $0.5499 (Yankees), the bot entered what was likely a live or disputed market. A genuine post-resolution lag token should be priced ≥ $0.90. The bot cannot distinguish "Gamma resolved too early" from "genuine lag".

3. **False Gamma resolutions:** Gamma sometimes resolves markets provisionally, especially for sports with complex results or geopolitical events with overlapping news. The bot treated any Gamma `resolved=true` as ground truth.

4. **No on-chain redemption:** Winning positions must be manually redeemed from the CTF contract. The ceasefire $331 sat uncollected for 41 days. The `/redeem` HTTP endpoint exists but was never called automatically.

### Recommended Fixes

| Priority | Fix                                                                               | Impact                                         |
| -------- | --------------------------------------------------------------------------------- | ---------------------------------------------- |
| 🔴 HIGH  | `git pull` on the server — deploy `MIN_ASK_PRICE=0.85` filter                     | Blocks live-game false positives               |
| 🔴 HIGH  | Add automatic CTF redemption loop — call `/redeem` when `resolvePosition()` fires | Never misses winning payouts                   |
| 🟡 MED   | Add `minPostEndMinutes=45` buffer (in code, confirm on server)                    | Prevents entry during in-progress games        |
| 🟡 MED   | Require `requireClobWinnerConfirmation=true` on server                            | Cross-checks Gamma with CLOB winner API        |
| 🟢 LOW   | Tune `MIN_ASK_PRICE` to 0.90+ for sports markets                                  | Tighter filter reduces false positives further |
