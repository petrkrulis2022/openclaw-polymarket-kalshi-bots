/**
 * sports-bot.ts — Live Goal-Triggered Trading Bot
 *
 * Strategy (data-lag arbitrage):
 *   1. Goalserve delivers a goal before Gamma/CLOB reprices
 *   2. Bot immediately buys at the stale CLOB price
 *   3. Waits for CLOB bid to move up as market reprices
 *   4. Sells for profit as soon as bid clears the profit threshold
 *
 * Tokens traded (Arsenal binary YES/NO):
 *   Arsenal scores → buy Arsenal YES (~89¢), sell after repricing up
 *   Burnley scores → buy Arsenal NO  (~11¢), sell after repricing up
 *
 * Run:
 *   cd bots/sports && npx tsx scripts/sports-bot.ts
 *   Ctrl+C to exit early (prints P&L and closes any open position)
 */

import "../src/config.js"; // side-effect: loads dotenv
import express from "express";
import { config } from "../src/config.js";
import {
  findArsenalBurnleyStaticId,
  pollLiveMatch,
  isLiveStatus,
  isFullTime,
  type MatchState,
} from "../src/goalserve.js";
import {
  fetchArsenalMarket,
  getOrderBook,
  getBestBid,
  placeMarketOrder,
  type ArsenalMarket,
} from "../src/polymarket.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface OpenPosition {
  tokenId: string;
  label: string;
  entryAsk: number;
  size: number;
  orderId: string;
  boughtAtMs: number;
}

interface ClosedTrade extends OpenPosition {
  sellPrice: number;
  pnl: number;
  reason: "profit" | "stop-loss" | "timeout" | "game-over";
  closedAtMs: number;
}

// ── State ─────────────────────────────────────────────────────────────────────

let market: ArsenalMarket;
let staticId: string;

let lastScoreHome = NaN;
let lastScoreAway = NaN;
let gameIsOver = false;
let openPosition: OpenPosition | null = null;

const trades: ClosedTrade[] = [];
let totalPnl = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fmt(n: number, decimals = 4): string {
  return n.toFixed(decimals);
}

function pnlStr(pnl: number): string {
  return `${pnl >= 0 ? "+" : ""}${fmt(pnl, 4)} USDC`;
}

// ── Trade logic ───────────────────────────────────────────────────────────────

async function onGoalDetected(
  scorer: "home" | "away",
  state: MatchState,
): Promise<void> {
  if (openPosition) {
    console.log(
      `[trade] ⚠️  Goal by ${scorer === "home" ? state.teamHome : state.teamAway} ` +
        `but already in position (${openPosition.label}) — skipping`,
    );
    return;
  }

  const isArsenalGoal = scorer === "home"; // Arsenal is always home (Emirates)
  const tokenId = isArsenalGoal ? market.yesTokenId : market.noTokenId;
  const label = isArsenalGoal ? "Arsenal YES" : "Arsenal NO";
  const scoringTeam = scorer === "home" ? state.teamHome : state.teamAway;

  console.log(
    `\n[trade] 🚨 GOAL: ${scoringTeam} scored! Score: ${state.scoreHome}-${state.scoreAway} (${state.minute}')`,
  );
  console.log(
    `[trade] → Market BUY ${label} (${fmt(config.maxPositionUsd, 2)} USDC, FOK)`,
  );

  let fill: Awaited<ReturnType<typeof placeMarketOrder>>;
  try {
    fill = await placeMarketOrder(tokenId, "BUY", config.maxPositionUsd);
  } catch (err) {
    console.error("[trade] BUY market order failed:", (err as Error).message);
    return;
  }

  if (fill.filledShares <= 0) {
    console.warn(
      `[trade] ⚠️  Market BUY got zero fill — orderbook empty, no position opened`,
    );
    return;
  }

  const avgPrice = fill.filledUsdc / fill.filledShares;

  openPosition = {
    tokenId,
    label,
    entryAsk: avgPrice,
    size: fill.filledShares,
    orderId: fill.orderId,
    boughtAtMs: Date.now(),
  };

  console.log(
    `[trade] ✅ Bought ${fill.filledShares} ${label} @ avg ${fmt(avgPrice)} = ${fmt(fill.filledUsdc, 2)} USDC`,
  );
  console.log(
    `[trade]    Sell targets: profit bid≥${fmt(avgPrice + config.minProfitCents)} | ` +
      `stop-loss bid≤${fmt(avgPrice * config.stopLossRatio)} | ` +
      `timeout ${config.sellTimeoutMinutes}min`,
  );
}

async function checkAndSell(forceSell = false): Promise<void> {
  if (!openPosition) return;

  const bestBid = await getBestBid(openPosition.tokenId);
  const elapsed = Date.now() - openPosition.boughtAtMs;
  const timeoutMs = config.sellTimeoutMinutes * 60_000;

  const hitProfit = bestBid >= openPosition.entryAsk + config.minProfitCents;
  const hitStopLoss =
    bestBid > 0 && bestBid <= openPosition.entryAsk * config.stopLossRatio;
  const hitTimeout = elapsed >= timeoutMs;

  if (!forceSell && !hitProfit && !hitStopLoss && !hitTimeout) {
    console.log(
      `[sell]  ${openPosition.label} | bid=${fmt(bestBid)} entry=${fmt(openPosition.entryAsk)} | ` +
        `need bid≥${fmt(openPosition.entryAsk + config.minProfitCents)} | ` +
        `elapsed=${Math.round(elapsed / 1000)}s`,
    );
    return;
  }

  const reason: ClosedTrade["reason"] = forceSell
    ? "game-over"
    : hitProfit
      ? "profit"
      : hitStopLoss
        ? "stop-loss"
        : "timeout";

  console.log(
    `\n[trade] 💰 Market SELL ${openPosition.size} ${openPosition.label} (${reason})`,
  );

  let sellFill: Awaited<ReturnType<typeof placeMarketOrder>>;
  try {
    sellFill = await placeMarketOrder(
      openPosition.tokenId,
      "SELL",
      openPosition.size,
    );
  } catch (err) {
    console.error("[trade] SELL market order failed:", (err as Error).message);
    // Don't clear position — will retry on next tick
    return;
  }

  const avgSellPrice =
    sellFill.filledShares > 0
      ? sellFill.filledUsdc / sellFill.filledShares
      : 0;
  const costBasis = openPosition.entryAsk * openPosition.size;
  const pnl = sellFill.filledUsdc - costBasis;
  totalPnl += pnl;

  trades.push({
    ...openPosition,
    sellPrice: avgSellPrice,
    pnl,
    reason,
    closedAtMs: Date.now(),
  });

  console.log(
    `[trade] ✅ Sold ${openPosition.size} shares @ avg ${fmt(avgSellPrice)} = ${fmt(sellFill.filledUsdc, 2)} USDC | pnl=${pnlStr(pnl)} | total_pnl=${pnlStr(totalPnl)}`,
  );

  openPosition = null;
}

// ── Log current prices ────────────────────────────────────────────────────────

async function logPrices(): Promise<void> {
  const [yesBook, noBook] = await Promise.all([
    getOrderBook(market.yesTokenId),
    getOrderBook(market.noTokenId),
  ]);

  const yesBid = yesBook.bids[0]?.price ?? 0;
  const yesAsk = yesBook.asks[0]?.price ?? 0;
  const noBid = noBook.bids[0]?.price ?? 0;
  const noAsk = noBook.asks[0]?.price ?? 0;

  console.log(
    `[clob]  Arsenal YES: bid=${fmt(yesBid)} ask=${fmt(yesAsk)} | ` +
      `Arsenal NO: bid=${fmt(noBid)} ask=${fmt(noAsk)}`,
  );
}

// ── P&L Report ────────────────────────────────────────────────────────────────

function printReport(): void {
  console.log("\n" + "═".repeat(60));
  console.log("SPORTS BOT SESSION REPORT");
  console.log("═".repeat(60));

  if (!trades.length) {
    console.log("No trades executed this session.");
  }

  for (const t of trades) {
    const durationSec = Math.round((t.closedAtMs - t.boughtAtMs) / 1000);
    console.log(
      `  ${t.label.padEnd(14)} | buy=${fmt(t.entryAsk)} sell=${fmt(t.sellPrice)} | ` +
        `size=${t.size} | pnl=${pnlStr(t.pnl)} | ${t.reason} | ${durationSec}s`,
    );
  }

  console.log("─".repeat(60));
  console.log(`Total P&L: ${pnlStr(totalPnl)}`);
  console.log(`Trades executed: ${trades.length}`);
  console.log("═".repeat(60) + "\n");
}

// ── Main loops ────────────────────────────────────────────────────────────────

/**
 * Goalserve poll loop — detects goals and drives game state.
 * Runs every LIVE_POLL_MS during the game.
 */
async function goalserveLoop(): Promise<void> {
  while (!gameIsOver) {
    const state = await pollLiveMatch(staticId);

    if (!state) {
      await sleep(config.livePollMs);
      continue;
    }

    // Log current state
    const scoreStr = isNaN(state.scoreHome)
      ? "?-?"
      : `${state.scoreHome}-${state.scoreAway}`;
    console.log(
      `[gs]    ${state.minute || state.status}' | ${state.teamHome} ${scoreStr} ${state.teamAway} | status=${state.status}`,
    );

    // Check for full time
    if (isFullTime(state.status)) {
      console.log("\n[gs] ⏱️  FULL TIME detected");
      gameIsOver = true;
      break;
    }

    // Goal detection: compare with last known valid scores
    if (!isNaN(state.scoreHome) && !isNaN(state.scoreAway)) {
      if (!isNaN(lastScoreHome) && !isNaN(lastScoreAway)) {
        if (state.scoreHome > lastScoreHome) {
          await onGoalDetected("home", state);
        }
        if (state.scoreAway > lastScoreAway) {
          await onGoalDetected("away", state);
        }
      }
      lastScoreHome = state.scoreHome;
      lastScoreAway = state.scoreAway;
    }

    await sleep(config.livePollMs);
  }
}

/**
 * CLOB sell monitor — watches the bid of any open position and sells when triggered.
 * Runs every SELL_POLL_MS.
 */
async function sellMonitorLoop(): Promise<void> {
  while (!gameIsOver) {
    if (openPosition) {
      await checkAndSell();
    }
    await sleep(config.sellPollMs);
  }

  // Game over — force close any remaining position
  if (openPosition) {
    console.log("[sell]  Game over — force-closing open position");
    await checkAndSell(true);
  }
}

// ── Pre-game wait ─────────────────────────────────────────────────────────────

async function waitForKickoff(): Promise<void> {
  console.log(
    `\n[bot]  Waiting for kickoff (game_start_utc=${new Date(config.matchSlug).toUTCString()})`,
  );
  console.log("[bot]  Polling Goalserve every 60s for game status...\n");

  while (true) {
    const state = await pollLiveMatch(staticId);

    if (state) {
      console.log(
        `[pre]   ${state.teamHome} vs ${state.teamAway} | status=${state.status}`,
      );

      if (isLiveStatus(state.status)) {
        // Initialize score from first live reading
        if (!isNaN(state.scoreHome) && !isNaN(state.scoreAway)) {
          lastScoreHome = state.scoreHome;
          lastScoreAway = state.scoreAway;
        }
        console.log("\n[bot]  ✅ Kickoff detected — entering live mode");
        return;
      }

      // Log CLOB prices while waiting
      await logPrices();
    }

    await sleep(config.preGamePollMs);
  }
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

process.on("SIGINT", async () => {
  console.log("\n[bot]  Interrupted — closing position if any...");
  if (openPosition) {
    await checkAndSell(true);
  }
  printReport();
  process.exit(0);
});

// ── HTTP API (dashboard integration) ─────────────────────────────────────────

const httpApp = express();
httpApp.use(express.json());

httpApp.get("/health", (_req, res) => {
  res.json({
    ok: true,
    botId: config.botId,
    name: "sports-bot",
    gameOver: gameIsOver,
    matchSlug: config.matchSlug,
  });
});

httpApp.get("/metrics", (_req, res) => {
  const spent = trades.reduce((s, t) => s + t.entryAsk * t.size, 0);
  const walletBalance = parseFloat(
    process.env["WALLET_BALANCE"] ?? String(config.maxPositionUsd),
  );
  const equity = Math.max(0, walletBalance - spent + totalPnl);
  res.json({
    botId: config.botId,
    equity: equity.toFixed(4),
    pnl: totalPnl.toFixed(4),
    realizedPnl: totalPnl.toFixed(4),
    openPositions: openPosition ? 1 : 0,
    utilization: openPosition ? 1 : 0,
  });
});

httpApp.get("/trades", (_req, res) => {
  res.json({
    trades,
    openPosition,
    totalPnl,
    gameOver: gameIsOver,
    matchSlug: config.matchSlug,
    market: market
      ? {
          yesTokenId: market.yesTokenId,
          noTokenId: market.noTokenId,
          question: market.question,
        }
      : null,
  });
});

httpApp.listen(config.port, () => {
  console.log(`[api]  Sports Bot HTTP API listening on :${config.port}`);
});

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("═".repeat(60));
  console.log("SPORTS BOT — Arsenal vs Burnley | Live Goal Arbitrage");
  console.log(
    `match=${config.matchSlug} | budget=${config.maxPositionUsd} USDC`,
  );
  console.log("═".repeat(60) + "\n");

  // Step 1: Fetch Polymarket token IDs
  console.log("[setup] Fetching Arsenal YES/NO tokens from Gamma...");
  market = await fetchArsenalMarket(config.matchSlug);
  console.log(
    `[setup] Market: "${market.question}" | conditionId=${market.conditionId.slice(0, 12)}...`,
  );

  // Step 2: Log initial CLOB prices
  await logPrices();

  // Step 3: Warm up signing client (derive API key) before game starts
  console.log("\n[setup] Initialising CLOB signing client...");
  const { getSigningClient } = await import("../src/polymarket.js");
  await getSigningClient();

  // Step 4: Find Goalserve match ID
  console.log("\n[setup] Finding Goalserve match ID...");
  staticId = await findArsenalBurnleyStaticId();

  // Step 5: Wait for kickoff
  await waitForKickoff();

  // Step 6: Run live loops concurrently
  console.log(
    `[bot]  Live polling: Goalserve every ${config.livePollMs / 1000}s | CLOB sell check every ${config.sellPollMs / 1000}s\n`,
  );
  await Promise.all([goalserveLoop(), sellMonitorLoop()]);

  // Step 7: Print final report
  printReport();
}

main().catch((err) => {
  console.error("[bot] Fatal error:", (err as Error).message);
  process.exit(1);
});
