/**
 * hockey-bot.ts — Live Score-Triggered Trading Bot
 *
 * Strategy (data-lag arbitrage):
 *   1. Goalserve delivers a scoring update before Gamma/CLOB reprices
 *   2. Bot immediately buys at the stale CLOB price
 *   3. Waits for CLOB bid to move up as market reprices
 *   4. Sells for profit as soon as bid clears the profit threshold
 *
 * Tokens traded (Home team binary YES/NO):
 *   Home scores → buy Home WIN YES, sell after repricing up
 *   Away scores → buy Home WIN NO  (away win / draw), sell after repricing up
 *
 * Run:
 *   cd bots/hockey && npx tsx scripts/hockey-bot.ts
 *   Ctrl+C to exit early (prints P&L and closes any open position)
 */

import "../src/config.js"; // side-effect: loads dotenv
import express from "express";
import { config } from "../src/config.js";
import {
  findMatchStaticId,
  findMatchStaticIdForTeams,
  pollLiveMatch,
  isLiveStatus,
  isFullTime,
  type MatchState,
} from "../src/goalserve.js";
import {
  fetchHomeTeamMarket,
  findEventSlugByTeams,
  getOrderBook,
  getBestBid,
  placeMarketOrder,
  type HomeTeamMarket,
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

interface WatchedGame {
  key: string;
  sport: string;
  staticId?: string;
  fixId?: string;
  leagueName?: string;
  country?: string;
  homeTeam: string;
  awayTeam: string;
  date?: string;
  time?: string;
  statusAtAdd?: string;
  matchSlug?: string;
  createdAt: number;
}

interface WatchlistStateRow {
  key: string;
  staticId?: string;
  fixId?: string;
  homeTeam: string;
  awayTeam: string;
  leagueName?: string;
  country?: string;
  status: string;
  timer: string;
  scoreHome: number;
  scoreAway: number;
  periodScores: Array<{ period: string; score: string }>;
  events: string[];
  updatedAt: string;
}

// ── State ─────────────────────────────────────────────────────────────────────

let market: HomeTeamMarket;
let staticId = "";
let fixId: string | undefined;
let activeMatchSlug = config.orchestrator.userAddress ? "" : config.matchSlug;
let activeTeamHome = config.orchestrator.userAddress
  ? "HOME"
  : config.matchTeamHome || "HOME";
let activeTeamAway = config.orchestrator.userAddress
  ? "AWAY"
  : config.matchTeamAway || "AWAY";
let activeMarketBindingKey = "";
let watchedGames: WatchedGame[] = [];
let selectedWatchedGameKey: string | null = null;
const watchlistLiveState = new Map<string, WatchlistStateRow>();
let lastGoalservePollAt: string | null = null;

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

function seedWatchlistStateFromWatchedGames(): void {
  watchlistLiveState.clear();
  for (const game of watchedGames) {
    const key = game.key;
    watchlistLiveState.set(key, {
      key,
      staticId: game.staticId,
      fixId: game.fixId,
      homeTeam: game.homeTeam,
      awayTeam: game.awayTeam,
      leagueName: game.leagueName,
      country: game.country,
      status: game.statusAtAdd ?? "Not Started",
      timer: "",
      scoreHome: 0,
      scoreAway: 0,
      periodScores: [],
      events: [],
      updatedAt: new Date().toISOString(),
    });
  }
}

function updateWatchlistStateFromLive(state: MatchState): void {
  const key =
    selectedWatchedGameKey ?? staticId ?? `${state.teamHome}-${state.teamAway}`;
  const prev = watchlistLiveState.get(key);
  watchlistLiveState.set(key, {
    key,
    staticId,
    fixId: prev?.fixId,
    homeTeam: state.teamHome,
    awayTeam: state.teamAway,
    leagueName: prev?.leagueName,
    country: prev?.country,
    status: state.status,
    timer: state.minute,
    scoreHome: Number.isNaN(state.scoreHome) ? 0 : state.scoreHome,
    scoreAway: Number.isNaN(state.scoreAway) ? 0 : state.scoreAway,
    periodScores: prev?.periodScores ?? [],
    events: prev?.events ?? [],
    updatedAt: new Date().toISOString(),
  });
}

async function loadWatchedGamesFromOrchestrator(): Promise<void> {
  const userAddress = config.orchestrator.userAddress;
  if (!userAddress) return;

  try {
    const res = await fetch(
      `${config.orchestrator.baseUrl}/users/${userAddress}/bots/hockey-bot/watched-games`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!res.ok) {
      console.warn(
        `[watch] watched-games fetch failed: HTTP ${res.status} (${userAddress})`,
      );
      return;
    }

    const payload = (await res.json()) as { games?: WatchedGame[] };
    watchedGames = Array.isArray(payload.games) ? payload.games : [];
    seedWatchlistStateFromWatchedGames();
    if (watchedGames.length === 0) {
      selectedWatchedGameKey = null;
      activeMatchSlug = "";
      activeMarketBindingKey = "";
      return;
    }

    const selected = watchedGames[0];
    if (!selected) return;

    const prevKey = selectedWatchedGameKey;
    const prevStaticId = staticId;
    const prevSlug = activeMatchSlug;

    selectedWatchedGameKey = selected.key;
    activeTeamHome = selected.homeTeam || activeTeamHome;
    activeTeamAway = selected.awayTeam || activeTeamAway;

    // When a dashboard-selected game does not provide a market slug yet,
    // clear stale slug from prior games and attempt auto-resolution by teams.
    activeMatchSlug = selected.matchSlug?.trim() || "";
    if (!activeMatchSlug) {
      try {
        const resolved = await findEventSlugByTeams(
          activeTeamHome,
          activeTeamAway,
        );
        if (resolved) {
          activeMatchSlug = resolved;
          console.log(
            `[watch] Auto-resolved market slug=${activeMatchSlug} (${activeTeamHome} vs ${activeTeamAway})`,
          );
        }
      } catch (err) {
        console.warn(
          `[watch] Failed slug auto-resolution for ${activeTeamHome} vs ${activeTeamAway}: ${(err as Error).message}`,
        );
      }
    }

    const nextBindingKey = `${activeMatchSlug}|${activeTeamHome.toLowerCase()}`;
    if (activeMatchSlug && nextBindingKey !== activeMarketBindingKey) {
      try {
        market = await fetchHomeTeamMarket(activeMatchSlug, activeTeamHome);
        activeMarketBindingKey = nextBindingKey;
        console.log(
          `[watch] Using watched game market slug=${activeMatchSlug} (${activeTeamHome} vs ${activeTeamAway})`,
        );
      } catch (err) {
        console.warn(
          `[watch] Failed to resolve watched match slug=${activeMatchSlug}, keeping configured market: ${(err as Error).message}`,
        );
      }
    }

    const watchedStaticId = selected.staticId || selected.fixId;
    if (watchedStaticId) {
      const prevEffectiveStaticId = staticId;
      staticId = watchedStaticId;
      fixId = selected.fixId;
      if (
        prevEffectiveStaticId !== staticId ||
        prevKey !== selectedWatchedGameKey
      ) {
        console.log(
          `[watch] Using watched game staticId=${staticId} (${activeTeamHome} vs ${activeTeamAway})`,
        );
      }
    }

    if (
      prevKey &&
      (prevKey !== selectedWatchedGameKey ||
        prevStaticId !== staticId ||
        prevSlug !== activeMatchSlug)
    ) {
      // Reset goal-delta baseline when user switches tracked game.
      lastScoreHome = NaN;
      lastScoreAway = NaN;
      console.log(
        `[watch] Switched tracked game -> key=${selectedWatchedGameKey} staticId=${staticId} slug=${activeMatchSlug || "(none)"}`,
      );
    }
  } catch (err) {
    console.warn(
      `[watch] watched-games fetch error: ${(err as Error).message}`,
    );
  }
}

async function ensureStaticIdReady(): Promise<void> {
  while (!staticId) {
    try {
      staticId = await findMatchStaticIdForTeams(
        activeTeamHome,
        activeTeamAway,
      );
      return;
    } catch (err) {
      console.warn(
        `[setup] Static-id resolution failed for ${activeTeamHome} vs ${activeTeamAway}: ${(err as Error).message}`,
      );
    }
    await sleep(10_000);
    await loadWatchedGamesFromOrchestrator();
  }
}

function startWatchedGamesWatcher(): void {
  if (!config.orchestrator.userAddress) return;
  const ms = Math.max(2_000, config.orchestrator.watchedGamesPollMs);
  setInterval(() => {
    void loadWatchedGamesFromOrchestrator();
  }, ms);
}

async function ensureMarketReady(): Promise<void> {
  while (true) {
    if (!activeMatchSlug) {
      console.warn(
        "[setup] No match slug configured yet; waiting for watched game selection...",
      );
    } else {
      try {
        console.log(
          `[setup] Fetching ${activeTeamHome} YES/NO tokens from Gamma (slug=${activeMatchSlug})...`,
        );
        market = await fetchHomeTeamMarket(activeMatchSlug, activeTeamHome);
        activeMarketBindingKey = `${activeMatchSlug}|${activeTeamHome.toLowerCase()}`;
        console.log(
          `[setup] Market: \"${market.question}\" | conditionId=${market.conditionId.slice(0, 12)}...`,
        );
        return;
      } catch (err) {
        console.warn(
          `[setup] Market resolution failed for slug=${activeMatchSlug}: ${(err as Error).message}`,
        );
      }
    }

    await sleep(10_000);
    await loadWatchedGamesFromOrchestrator();
  }
}

async function ensureSigningClientReady(): Promise<void> {
  while (true) {
    try {
      const { getSigningClient } = await import("../src/polymarket.js");
      await getSigningClient();
      return;
    } catch (err) {
      console.warn(
        `[setup] Signing client init failed: ${(err as Error).message}`,
      );
      await sleep(10_000);
    }
  }
}

// ── Trade logic ───────────────────────────────────────────────────────────────

async function onGoalDetected(
  scorer: "home" | "away",
  state: MatchState,
): Promise<void> {
  if (openPosition) {
    console.log(
      `[trade] ⚠️  Score update by ${scorer === "home" ? state.teamHome : state.teamAway} ` +
        `but already in position (${openPosition.label}) — skipping`,
    );
    return;
  }

  const isHomeGoal = scorer === "home";
  const tokenId = isHomeGoal ? market.yesTokenId : market.noTokenId;
  const label = isHomeGoal ? `${activeTeamHome} WIN` : `${activeTeamAway} WIN`;
  const scoringTeam = scorer === "home" ? state.teamHome : state.teamAway;

  console.log(
    `\n[trade] 🚨 SCORE: ${scoringTeam} update detected. Score: ${state.scoreHome}-${state.scoreAway} (${state.minute}')`,
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

  if (!(fill.filledShares > 0)) {
    console.warn(
      `[trade] ⚠️  Market BUY got zero fill (filledShares=${fill.filledShares}) — orderbook empty or parse error, no position opened`,
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
    sellFill.filledShares > 0 ? sellFill.filledUsdc / sellFill.filledShares : 0;
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
    `[clob]  ${activeTeamHome} YES: bid=${fmt(yesBid)} ask=${fmt(yesAsk)} | ` +
      `${activeTeamAway} WIN: bid=${fmt(noBid)} ask=${fmt(noAsk)}`,
  );
}

// ── P&L Report ────────────────────────────────────────────────────────────────

function printReport(): void {
  console.log("\n" + "═".repeat(60));
  console.log("HOCKEY BOT SESSION REPORT");
  console.log("═".repeat(60));

  console.log(
    `Match: ${activeTeamHome} vs ${activeTeamAway} | slug=${activeMatchSlug}`,
  );

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
 * Goalserve poll loop — detects score changes and drives game state.
 * Runs every LIVE_POLL_MS during the game.
 */
async function goalserveLoop(): Promise<void> {
  while (!gameIsOver) {
    const state = await pollLiveMatch(
      staticId,
      activeTeamHome,
      activeTeamAway,
      fixId,
    );
    lastGoalservePollAt = new Date().toISOString();

    if (!state) {
      await sleep(config.livePollMs);
      continue;
    }

    updateWatchlistStateFromLive(state);

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

    // Safety: if status is not live (not a running-minute, not HT) it's some
    // end-of-game state we haven't seen before — treat it as game over.
    if (!isLiveStatus(state.status)) {
      console.log(
        `\n[gs] ⚠️  Unrecognised non-live status "${state.status}" — treating as game over`,
      );
      gameIsOver = true;
      break;
    }

    // Score-change detection: compare with last known valid scores
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
  const watchedSelection = watchedGames.find(
    (g) => g.key === selectedWatchedGameKey,
  );
  const kickoffHint =
    watchedSelection?.date && watchedSelection?.time
      ? `${watchedSelection.date} ${watchedSelection.time}`
      : watchedSelection?.date
        ? watchedSelection.date
        : activeMatchSlug || "unknown";

  console.log(`\n[bot]  Waiting for kickoff (match=${kickoffHint})`);
  console.log(
    `[bot]  Polling Goalserve every ${config.preGamePollMs / 1000}s for game status...\n`,
  );

  while (true) {
    const state = await pollLiveMatch(
      staticId,
      activeTeamHome,
      activeTeamAway,
      fixId,
    );

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

      if (isFullTime(state.status)) {
        console.log(
          `\n[bot]  Match already finished (status=${state.status}) — skipping live loop`,
        );
        gameIsOver = true;
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
    name: "hockey-bot",
    gameOver: gameIsOver,
    matchSlug: activeMatchSlug,
    watchedGamesCount: watchedGames.length,
    selectedWatchedGameKey,
  });
});

httpApp.get("/diagnostics", (_req, res) => {
  res.json({
    ok: true,
    botId: config.botId,
    name: "hockey-bot",
    healthy: true,
    gameOver: gameIsOver,
    matchSlug: activeMatchSlug,
    teams: {
      home: activeTeamHome,
      away: activeTeamAway,
    },
    staticId,
    fixId,
    watchedGamesCount: watchedGames.length,
    selectedWatchedGameKey,
    lastGoalservePollAt,
    openPositions: openPosition ? 1 : 0,
    totalPnl,
    tradesExecuted: trades.length,
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
    matchSlug: activeMatchSlug,
    watchedGamesCount: watchedGames.length,
    selectedWatchedGameKey,
    market: market
      ? {
          yesTokenId: market.yesTokenId,
          noTokenId: market.noTokenId,
          question: market.question,
        }
      : null,
  });
});

httpApp.get("/watchlist-state", (_req, res) => {
  res.json({
    ok: true,
    botId: config.botId,
    watchedGamesCount: watchedGames.length,
    selectedWatchedGameKey,
    lastGoalservePollAt,
    games: Array.from(watchlistLiveState.values()),
  });
});

httpApp.get("/watchlist-state/:key", (req, res) => {
  const row = watchlistLiveState.get(req.params["key"] ?? "");
  if (!row) {
    res.status(404).json({ error: "Watchlist game not found" });
    return;
  }
  res.json({
    ok: true,
    botId: config.botId,
    selectedWatchedGameKey,
    lastGoalservePollAt,
    game: row,
  });
});

httpApp.listen(config.port, () => {
  console.log(`[api]  Hockey Bot HTTP API listening on :${config.port}`);
});

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("═".repeat(60));
  console.log("HOCKEY BOT — Live Score Arbitrage");
  console.log(`budget=${config.maxPositionUsd} USDC`);
  console.log("═".repeat(60) + "\n");

  // Step 1: Load watched games (if user-scoped bot env is configured)
  await loadWatchedGamesFromOrchestrator();
  startWatchedGamesWatcher();

  console.log("═".repeat(60));
  console.log(
    `HOCKEY BOT — ${activeTeamHome} vs ${activeTeamAway} | Live Score Arbitrage`,
  );
  console.log(
    `match=${activeMatchSlug || "(awaiting watched game slug)"} | budget=${config.maxPositionUsd} USDC`,
  );
  console.log("═".repeat(60) + "\n");

  // Step 2: Resolve market and keep retrying until available.
  await ensureMarketReady();

  // Step 3: Log initial CLOB prices
  await logPrices();

  // Step 4: Warm up signing client (derive API key) before game starts
  console.log("\n[setup] Initialising CLOB signing client...");
  await ensureSigningClientReady();

  // Step 5: Find Goalserve match ID unless watched list already supplied one
  if (!staticId) {
    console.log("\n[setup] Finding Goalserve match ID...");
    await ensureStaticIdReady();
  }

  if (!staticId) {
    staticId = await findMatchStaticId();
  }

  // Step 6: Wait for kickoff
  await waitForKickoff();

  // Step 7: Run live loops concurrently
  console.log(
    `[bot]  Live polling: Goalserve every ${config.livePollMs / 1000}s | CLOB sell check every ${config.sellPollMs / 1000}s\n`,
  );
  await Promise.all([goalserveLoop(), sellMonitorLoop()]);

  // Step 8: Print final report
  printReport();
}

main().catch((err) => {
  console.error("[bot] Fatal error:", (err as Error).message);
  process.exit(1);
});
