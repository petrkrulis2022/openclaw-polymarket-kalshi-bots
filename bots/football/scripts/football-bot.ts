/**
 * football-bot.ts — Live Score-Triggered Trading Bot
 *
 * Strategy (manual score-trigger arbitrage):
 *   1. User confirms score event in dashboard before Gamma/CLOB reprices
 *   2. Bot immediately buys at the stale CLOB price
 *   3. Waits for CLOB bid to move up as market reprices
 *   4. Sells for profit as soon as bid clears the profit threshold
 *
 * Tokens traded (Home team binary YES/NO):
 *   Home scores → buy Home WIN YES, sell after repricing up
 *   Away scores → buy Home WIN NO  (away win / draw), sell after repricing up
 *
 * Run:
 *   cd bots/football && npx tsx scripts/football-bot.ts
 *   Ctrl+C to exit early (prints P&L and closes any open position)
 */

import "../src/config.js"; // side-effect: loads dotenv
import express from "express";
import { config } from "../src/config.js";

// MatchState payload used by manual-trigger endpoint.
interface MatchState {
  staticId: string;
  status: string;
  minute: string;
  scoreHome: number;
  scoreAway: number;
  teamHome: string;
  teamAway: string;
}

let runtimeMaxPositionUsd: number = config.maxPositionUsd;
import {
  fetchEventLifecycle,
  fetchHomeTeamMarket,
  findEventSlugByTeams,
  getAvailableCollateralBalanceUsdc,
  getOrderBook,
  getBestBid,
  placeMarketOrder,
  type EventLifecycle,
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

interface MarketLifecycleSnapshot {
  gamma: EventLifecycle;
  yesBookHasLiquidity: boolean;
  noBookHasLiquidity: boolean;
  tradable: boolean;
  checkedAt: string;
}

// ── State ─────────────────────────────────────────────────────────────────────

// Resolved user address — starts from env var, then overridden by orchestrator
// reverse-lookup on startup so any connected wallet works dynamically.
let resolvedUserAddress = config.orchestrator.userAddress;

let market: HomeTeamMarket;
let staticId = "";
let fixId: string | undefined;
let activeMatchSlug = resolvedUserAddress ? "" : config.matchSlug;
let activeTeamHome = resolvedUserAddress
  ? "HOME"
  : config.matchTeamHome || "HOME";
let activeTeamAway = resolvedUserAddress
  ? "AWAY"
  : config.matchTeamAway || "AWAY";
let activeMarketBindingKey = "";
let watchedGames: WatchedGame[] = [];
let selectedWatchedGameKey: string | null = null;
const watchlistLiveState = new Map<string, WatchlistStateRow>();
let marketReady = false;
let signingClientReady = false;
let lastSetupError: string | null = null;

let lastScoreHome = NaN;
let lastScoreAway = NaN;
let gameIsOver = false;
let openPosition: OpenPosition | null = null;
let consecutiveEndedLifecyclePolls = 0;
let lastMarketLifecycle: MarketLifecycleSnapshot | null = null;

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

function getBuyWorstPriceCap(): number {
  const fallbackTick = 0.001;
  const tick =
    market.orderPriceMinTickSize && market.orderPriceMinTickSize > 0
      ? market.orderPriceMinTickSize
      : fallbackTick;
  const rawCap = 1 - tick;
  // Clamp to a safe market range and keep deterministic formatting for logs/orders.
  return Number(Math.min(0.999, Math.max(0.9, rawCap)).toFixed(6));
}

function parseInsufficientBalanceUsdc(message: string): number | null {
  const match = message.match(/balance:\s*(\d+),\s*order amount:\s*(\d+)/i);
  if (!match) return null;
  const balanceMicros = Number(match[1]);
  if (!Number.isFinite(balanceMicros) || balanceMicros <= 0) return null;
  return balanceMicros / 1e6;
}

function bookHasLiquidity(book: {
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
}): boolean {
  return (
    book.bids.some((l) => l.price > 0 && l.size > 0) ||
    book.asks.some((l) => l.price > 0 && l.size > 0)
  );
}

function lifecycleLooksEnded(snapshot: MarketLifecycleSnapshot): boolean {
  return (
    snapshot.gamma.resolved ||
    snapshot.gamma.closed ||
    (!snapshot.gamma.active && !snapshot.gamma.acceptingOrders)
  );
}

async function readMarketLifecycleSnapshot(): Promise<MarketLifecycleSnapshot | null> {
  if (!activeMatchSlug || !marketReady) return null;
  try {
    const [gamma, yesBook, noBook] = await Promise.all([
      fetchEventLifecycle(activeMatchSlug),
      getOrderBook(market.yesTokenId),
      getOrderBook(market.noTokenId),
    ]);

    const yesBookHasLiquidity = bookHasLiquidity(yesBook);
    const noBookHasLiquidity = bookHasLiquidity(noBook);
    const snapshot: MarketLifecycleSnapshot = {
      gamma,
      yesBookHasLiquidity,
      noBookHasLiquidity,
      tradable: yesBookHasLiquidity || noBookHasLiquidity,
      checkedAt: new Date().toISOString(),
    };
    lastMarketLifecycle = snapshot;
    return snapshot;
  } catch (err) {
    console.warn(`[pm] lifecycle probe failed: ${(err as Error).message}`);
    return null;
  }
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

async function resolveUserAddressFromOrchestrator(): Promise<void> {
  // Always ask the orchestrator which user owns this bot's port.
  // This lets any connected wallet work without a hardcoded USER_METAMASK_ADDRESS.
  try {
    const res = await fetch(
      `${config.orchestrator.baseUrl}/users/bots/identify?port=${config.port}`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (res.ok) {
      const data = (await res.json()) as { userAddress?: string };
      if (data.userAddress) {
        resolvedUserAddress = data.userAddress;
        console.log(
          `[setup] User address resolved from orchestrator: ${resolvedUserAddress}`,
        );
        if (!activeMatchSlug) activeMatchSlug = "";
      }
    } else {
      console.warn(
        `[setup] Could not resolve user address from orchestrator (HTTP ${res.status})`,
      );
    }
  } catch (err) {
    console.warn(
      `[setup] Could not resolve user address: ${(err as Error).message}`,
    );
  }
}

async function fetchTradeAmountFromOrchestrator(): Promise<void> {
  const userAddress = resolvedUserAddress;
  if (!userAddress) return;
  try {
    const res = await fetch(
      `${config.orchestrator.baseUrl}/users/${userAddress}/bots/football-bot/trade-amount`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (res.ok) {
      const data = (await res.json()) as { amountUsd?: number };
      if (typeof data.amountUsd === "number" && data.amountUsd >= 0) {
        runtimeMaxPositionUsd = data.amountUsd;
        console.log(
          `[config] Trade amount fetched from orchestrator: ${runtimeMaxPositionUsd} USDC`,
        );
      }
    } else {
      console.warn(
        `[config] Could not fetch trade amount from orchestrator (HTTP ${res.status})`,
      );
    }
  } catch (err) {
    console.warn(
      `[config] Trade amount fetch failed: ${(err as Error).message}`,
    );
  }
}

async function loadWatchedGamesFromOrchestrator(): Promise<void> {
  const userAddress = resolvedUserAddress;
  if (!userAddress) return;

  try {
    const res = await fetch(
      `${config.orchestrator.baseUrl}/users/${userAddress}/bots/football-bot/watched-games`,
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
        market = await fetchHomeTeamMarket(
          activeMatchSlug,
          activeTeamHome,
          activeTeamAway,
        );
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

function startWatchedGamesWatcher(): void {
function startWatchedGamesWatcher(): void {
  const ms = Math.max(2_000, config.orchestrator.watchedGamesPollMs);
  setInterval(async () => {
    // If address wasn't resolved at startup, keep retrying (orchestrator may have been updating)
    if (!resolvedUserAddress) {
      await resolveUserAddressFromOrchestrator();
      if (resolvedUserAddress) await fetchTradeAmountFromOrchestrator();
    }
    void loadWatchedGamesFromOrchestrator();
  }, ms);
}

async function ensureMarketReady(): Promise<void> {
  while (true) {
    if (!activeMatchSlug) {
      marketReady = false;
      lastSetupError = "No match slug configured yet";
      console.warn(
        "[setup] No match slug configured yet; waiting for watched game selection...",
      );
    } else {
      try {
        console.log(
          `[setup] Fetching ${activeTeamHome} YES/NO tokens from Gamma (slug=${activeMatchSlug})...`,
        );
        market = await fetchHomeTeamMarket(
          activeMatchSlug,
          activeTeamHome,
          activeTeamAway,
        );
        activeMarketBindingKey = `${activeMatchSlug}|${activeTeamHome.toLowerCase()}`;
        marketReady = true;
        lastSetupError = null;
        console.log(
          `[setup] Market: \"${market.question}\" | conditionId=${market.conditionId.slice(0, 12)}...`,
        );
        return;
      } catch (err) {
        marketReady = false;
        lastSetupError = (err as Error).message;
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
      signingClientReady = true;
      lastSetupError = null;
      return;
    } catch (err) {
      signingClientReady = false;
      lastSetupError = (err as Error).message;
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
): Promise<
  | { ok: true; reason: "executed"; message: string }
  | {
      ok: false;
      reason: "ignored_open_position" | "rejected_market_state" | "error";
      message: string;
    }
> {
  const lifecycle = await readMarketLifecycleSnapshot();
  if (!lifecycle) {
    const message = "Lifecycle probe unavailable — skipping manual trigger";
    console.warn(`[trade] ⚠️  ${message}`);
    return { ok: false, reason: "rejected_market_state", message };
  }
  if (
    lifecycleLooksEnded(lifecycle) ||
    !lifecycle.gamma.acceptingOrders ||
    !lifecycle.tradable
  ) {
    const message =
      `Market not tradable (status=${lifecycle.gamma.rawStatus} active=${lifecycle.gamma.active} ` +
      `closed=${lifecycle.gamma.closed} resolved=${lifecycle.gamma.resolved} tradable=${lifecycle.tradable})`;
    console.warn(`[trade] ⚠️  ${message}`);
    return { ok: false, reason: "rejected_market_state", message };
  }

  if (openPosition) {
    const message = `Position already open (${openPosition.label})`;
    console.log(`[trade] ⚠️  ${message} — skipping`);
    return { ok: false, reason: "ignored_open_position", message };
  }

  if (runtimeMaxPositionUsd === 0) {
    const message = "Bot disabled: trade amount is 0";
    console.log(`[trade] ⚠️  ${message} — skipping`);
    return { ok: false, reason: "error", message };
  }

  const isHomeGoal = scorer === "home";
  const tokenId = isHomeGoal ? market.yesTokenId : market.noTokenId;
  const label = isHomeGoal ? `${activeTeamHome} WIN` : `${activeTeamAway} WIN`;
  const scoringTeam = scorer === "home" ? state.teamHome : state.teamAway;

  console.log(
    `\n[trade] 🚨 SCORE: ${scoringTeam} update detected. Score: ${state.scoreHome}-${state.scoreAway} (${state.minute}')`,
  );
  console.log(
    `[trade] → Market BUY ${label} (${fmt(runtimeMaxPositionUsd, 2)} USDC, FOK)`,
  );
  const buyWorstPriceCap = getBuyWorstPriceCap();
  const tickSize = market.orderPriceMinTickSize ?? 0.001;
  console.log(
    `[trade] BUY cap config: tick=${fmt(tickSize, 6)} worstPriceCap=${fmt(buyWorstPriceCap, 6)}`,
  );

  const MAX_BUY_ATTEMPTS = 4;
  const BUY_RETRY_DELAY_MS = 3_000;
  const BUY_BALANCE_BUFFER_USD = 0.05;

  // CLOB collateral probes can occasionally lag right after balance changes.
  // Treat probe result as advisory and let exchange-side order validation decide.
  const availableCollateralUsd = await getAvailableCollateralBalanceUsdc();
  let spendAmountUsd = Number(runtimeMaxPositionUsd.toFixed(6));
  if (availableCollateralUsd > BUY_BALANCE_BUFFER_USD) {
    spendAmountUsd = Number(
      Math.max(
        0,
        Math.min(
          runtimeMaxPositionUsd,
          availableCollateralUsd - BUY_BALANCE_BUFFER_USD,
        ),
      ).toFixed(6),
    );
  } else {
    console.warn(
      `[trade] ⚠️  Collateral probe returned ${fmt(availableCollateralUsd, 6)} USDC; proceeding with configured spend ${fmt(spendAmountUsd, 6)} USDC and relying on exchange-side balance checks.`,
    );
  }
  if (spendAmountUsd <= 0) {
    const message = "Configured trade amount is non-positive";
    console.warn(`[trade] ⚠️  Skipping BUY: ${message}`);
    return { ok: false, reason: "error", message };
  }
  console.log(
    `[trade] BUY spend precheck: available=${fmt(availableCollateralUsd, 6)} buffer=${fmt(BUY_BALANCE_BUFFER_USD, 4)} spend=${fmt(spendAmountUsd, 6)}`,
  );

  let fill: Awaited<ReturnType<typeof placeMarketOrder>> | null = null;
  for (let attempt = 1; attempt <= MAX_BUY_ATTEMPTS; attempt++) {
    try {
      const book = await getOrderBook(tokenId);
      const bestAsk = book.asks[0]?.price ?? 0;
      const bestAskSize = book.asks[0]?.size ?? 0;
      const askSummary =
        bestAsk > 0
          ? `bestAsk=${fmt(bestAsk, 6)} size=${fmt(bestAskSize, 4)}`
          : "bestAsk=none";

      console.log(
        `[trade] BUY attempt ${attempt}/${MAX_BUY_ATTEMPTS}: ${askSummary} cap=${fmt(buyWorstPriceCap, 6)} spend=${fmt(spendAmountUsd, 6)}`,
      );

      const f = await placeMarketOrder(tokenId, "BUY", spendAmountUsd, {
        worstPrice: buyWorstPriceCap,
      });
      if (f.filledShares > 0) {
        fill = f;
        break;
      }

      const missReason =
        bestAsk <= 0
          ? "empty_ask_book"
          : bestAsk > buyWorstPriceCap
            ? "best_ask_above_cap"
            : "fok_zero_fill";
      console.warn(
        `[trade] ⚠️  BUY attempt ${attempt}/${MAX_BUY_ATTEMPTS}: zero fill (${missReason})` +
          (attempt < MAX_BUY_ATTEMPTS
            ? ` — retrying in ${BUY_RETRY_DELAY_MS / 1000}s...`
            : ""),
      );
    } catch (err) {
      const message = (err as Error).message;
      const availableBalanceUsd = parseInsufficientBalanceUsdc(message);
      if (availableBalanceUsd !== null) {
        const resizedSpend = Number(
          Math.max(0, availableBalanceUsd - BUY_BALANCE_BUFFER_USD).toFixed(6),
        );
        if (resizedSpend > 0 && resizedSpend < spendAmountUsd) {
          spendAmountUsd = resizedSpend;
          console.warn(
            `[trade] BUY attempt ${attempt}/${MAX_BUY_ATTEMPTS} rejected for insufficient balance; resizing spend to ${fmt(spendAmountUsd, 6)} USDC` +
              (attempt < MAX_BUY_ATTEMPTS ? " and retrying..." : ""),
          );
        } else {
          console.error(
            `[trade] BUY attempt ${attempt}/${MAX_BUY_ATTEMPTS} failed: insufficient balance (${fmt(availableBalanceUsd, 6)} USDC available)`,
          );
          break;
        }
      } else {
        console.error(
          `[trade] BUY attempt ${attempt}/${MAX_BUY_ATTEMPTS} failed:`,
          message,
        );
      }
    }

    if (attempt < MAX_BUY_ATTEMPTS) {
      await new Promise((res) => setTimeout(res, BUY_RETRY_DELAY_MS));
    }
  }

  if (!fill || !(fill.filledShares > 0)) {
    const message = `All ${MAX_BUY_ATTEMPTS} BUY attempts returned zero fill — no position opened`;
    console.warn(`[trade] ⚠️  ${message}`);
    return { ok: false, reason: "error", message };
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

  const hybridStopBid = Math.max(
    avgPrice * config.stopLossRatio,
    avgPrice - config.maxLossCents,
  );
  console.log(
    `[trade]    Sell plan: hold ${config.holdBeforeSellSeconds}s then monitor | ` +
      `profit bid≥${fmt(avgPrice + config.minProfitCents)} | ` +
      `stop-loss bid≤${fmt(hybridStopBid)} | ` +
      `timeout ${config.sellTimeoutMinutes}min`,
  );

  return {
    ok: true,
    reason: "executed",
    message: `Bought ${fill.filledShares} shares of ${label} at avg ${fmt(avgPrice)}`,
  };
}

function getOrCreateWatchlistRow(key: string): WatchlistStateRow {
  const existing = watchlistLiveState.get(key);
  if (existing) return existing;

  const selected = watchedGames.find((g) => g.key === key) ?? watchedGames[0];
  const row: WatchlistStateRow = {
    key,
    staticId: selected?.staticId,
    fixId: selected?.fixId,
    homeTeam: selected?.homeTeam ?? activeTeamHome,
    awayTeam: selected?.awayTeam ?? activeTeamAway,
    leagueName: selected?.leagueName,
    country: selected?.country,
    status: "Manual Trigger",
    timer: "manual",
    scoreHome: 0,
    scoreAway: 0,
    periodScores: [],
    events: [],
    updatedAt: new Date().toISOString(),
  };
  watchlistLiveState.set(key, row);
  return row;
}

async function checkAndSell(forceSell = false): Promise<void> {
  if (!openPosition) return;

  const bestBid = await getBestBid(openPosition.tokenId);
  const elapsed = Date.now() - openPosition.boughtAtMs;
  const timeoutMs = config.sellTimeoutMinutes * 60_000;
  const holdMs = config.holdBeforeSellSeconds * 1_000;

  if (!forceSell && elapsed < holdMs) {
    console.log(
      `[sell]  ${openPosition.label} | hold phase ${Math.round(elapsed / 1000)}s/${config.holdBeforeSellSeconds}s | bid=${fmt(bestBid)} entry=${fmt(openPosition.entryAsk)}`,
    );
    return;
  }

  const hitProfit = bestBid >= openPosition.entryAsk + config.minProfitCents;
  const stopLossBid = Math.max(
    openPosition.entryAsk * config.stopLossRatio,
    openPosition.entryAsk - config.maxLossCents,
  );
  const hitStopLoss = bestBid > 0 && bestBid <= stopLossBid;
  const hitTimeout = elapsed >= timeoutMs;

  if (!forceSell && !hitProfit && !hitStopLoss && !hitTimeout) {
    console.log(
      `[sell]  ${openPosition.label} | bid=${fmt(bestBid)} entry=${fmt(openPosition.entryAsk)} | ` +
        `need bid≥${fmt(openPosition.entryAsk + config.minProfitCents)} | ` +
        `stop bid≤${fmt(stopLossBid)} | ` +
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
  console.log("FOOTBALL BOT SESSION REPORT");
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
 * Polymarket lifecycle monitor — detects game-over from Polymarket market status.
 * Runs every LIVE_POLL_MS during the game.
 */
async function lifecycleMonitorLoop(): Promise<void> {
  while (!gameIsOver) {
    const lifecycle = await readMarketLifecycleSnapshot();
    if (lifecycle) {
      if (lifecycleLooksEnded(lifecycle)) {
        consecutiveEndedLifecyclePolls += 1;
        if (consecutiveEndedLifecyclePolls < 3) {
          console.log(
            `[pm] ⚠️  Ended lifecycle state seen (${lifecycle.gamma.rawStatus}) — confirming (${consecutiveEndedLifecyclePolls}/3)`,
          );
          await sleep(config.livePollMs);
          continue;
        }
        console.log(
          `[pm] ⏱️  Market lifecycle indicates game over (status=${lifecycle.gamma.rawStatus}, closed=${lifecycle.gamma.closed}, resolved=${lifecycle.gamma.resolved})`,
        );
        gameIsOver = true;
        break;
      }
      consecutiveEndedLifecyclePolls = 0;
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
    `[bot]  Polling Polymarket lifecycle every ${config.preGamePollMs / 1000}s for kickoff...\n`,
  );

  while (true) {
    const lifecycle = await readMarketLifecycleSnapshot();
    if (lifecycle) {
      console.log(
        `[pre]   pm status=${lifecycle.gamma.rawStatus} active=${lifecycle.gamma.active} closed=${lifecycle.gamma.closed} resolved=${lifecycle.gamma.resolved} accepting=${lifecycle.gamma.acceptingOrders} tradable=${lifecycle.tradable}`,
      );

      if (lifecycleLooksEnded(lifecycle)) {
        console.log(
          `[bot]  Match market already ended on Polymarket (status=${lifecycle.gamma.rawStatus}) — skipping live loop`,
        );
        gameIsOver = true;
        return;
      }

      if (
        lifecycle.gamma.active &&
        lifecycle.gamma.acceptingOrders &&
        lifecycle.tradable
      ) {
        consecutiveEndedLifecyclePolls = 0;
        console.log(
          "\n[bot]  ✅ Polymarket lifecycle indicates live tradable market — entering live mode",
        );
        return;
      }

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
    name: "football-bot",
    gameOver: gameIsOver,
    matchSlug: activeMatchSlug,
    watchedGamesCount: watchedGames.length,
    selectedWatchedGameKey,
    marketReady,
    signingClientReady,
    ready: marketReady && signingClientReady,
    lastSetupError,
  });
});

httpApp.get("/ready", (_req, res) => {
  const hasSelection = watchedGames.length > 0;
  const missing: string[] = [];
  if (!hasSelection) missing.push("watchlist");
  if (!activeMatchSlug) missing.push("matchSlug");
  if (!marketReady) missing.push("market");
  if (!signingClientReady) missing.push("signing");

  const ready = missing.length === 0;
  res.json({
    ok: true,
    botId: config.botId,
    name: "football-bot",
    ready,
    stage: ready ? "ready" : "initializing",
    missing,
    details: {
      hasSelection,
      matchSlug: activeMatchSlug,
      marketReady,
      signingClientReady,
      selectedWatchedGameKey,
      watchedGamesCount: watchedGames.length,
    },
    lastSetupError,
  });
});

httpApp.get("/diagnostics", (_req, res) => {
  res.json({
    ok: true,
    botId: config.botId,
    name: "football-bot",
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
    marketReady,
    signingClientReady,
    ready: marketReady && signingClientReady,
    lastSetupError,
    lastMarketLifecycle,
    openPositions: openPosition ? 1 : 0,
    totalPnl,
    tradesExecuted: trades.length,
  });
});

httpApp.get("/metrics", (_req, res) => {
  const spent = trades.reduce((s, t) => s + t.entryAsk * t.size, 0);
  const walletBalance = parseFloat(
    process.env["WALLET_BALANCE"] ?? String(runtimeMaxPositionUsd),
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
    games: Array.from(watchlistLiveState.values()),
    marketReady,
    signingClientReady,
    ready: marketReady && signingClientReady,
    lastSetupError,
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
    game: row,
  });
});

httpApp.post("/manual-trigger", async (req, res) => {
  const sideRaw = String((req.body as { side?: unknown })?.side ?? "").trim();
  const keyRaw = String((req.body as { key?: unknown })?.key ?? "").trim();
  if (sideRaw !== "home" && sideRaw !== "away") {
    return res.status(400).json({
      ok: false,
      reason: "invalid_request",
      error: "side must be 'home' or 'away'",
    });
  }

  const key = keyRaw || selectedWatchedGameKey || watchedGames[0]?.key;
  if (!key) {
    return res.status(400).json({
      ok: false,
      reason: "invalid_request",
      error: "No watched game selected",
    });
  }

  const row = getOrCreateWatchlistRow(key);
  const nextScoreHome = sideRaw === "home" ? row.scoreHome + 1 : row.scoreHome;
  const nextScoreAway = sideRaw === "away" ? row.scoreAway + 1 : row.scoreAway;
  const manualState: MatchState = {
    staticId: row.staticId ?? staticId,
    status: "Manual Trigger",
    minute: "manual",
    scoreHome: nextScoreHome,
    scoreAway: nextScoreAway,
    teamHome: row.homeTeam,
    teamAway: row.awayTeam,
  };

  const triggerResult = await onGoalDetected(sideRaw, manualState);

  if (triggerResult.ok) {
    watchlistLiveState.set(key, {
      ...row,
      status: "Manual Trigger",
      timer: "manual",
      scoreHome: nextScoreHome,
      scoreAway: nextScoreAway,
      updatedAt: new Date().toISOString(),
    });
    lastScoreHome = nextScoreHome;
    lastScoreAway = nextScoreAway;
    return res.json({
      ok: true,
      reason: triggerResult.reason,
      side: sideRaw,
      key,
      scoreHome: nextScoreHome,
      scoreAway: nextScoreAway,
      message: triggerResult.message,
    });
  }

  return res.status(409).json({
    ok: false,
    reason: triggerResult.reason,
    side: sideRaw,
    key,
    scoreHome: row.scoreHome,
    scoreAway: row.scoreAway,
    message: triggerResult.message,
  });
});

httpApp.post("/set-trade-amount", (req, res) => {
  const amount = Number((req.body as { amountUsd?: unknown })?.amountUsd);
  if (!Number.isFinite(amount) || amount < 0) {
    return res.status(400).json({ error: "amountUsd must be >= 0" });
  }
  runtimeMaxPositionUsd = amount;
  console.log(`[config] Trade amount updated to ${runtimeMaxPositionUsd} USDC`);
  return res.json({ ok: true, maxPositionUsd: runtimeMaxPositionUsd });
});

httpApp.listen(config.port, () => {
  console.log(`[api]  Football Bot HTTP API listening on :${config.port}`);
});

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("═".repeat(60));
  console.log("FOOTBALL BOT — Live Score Arbitrage");
  console.log("═".repeat(60) + "\n");

  // Step 1: Resolve user address from orchestrator (dynamic — works for any wallet)
  await resolveUserAddressFromOrchestrator();

  // Step 2: Fetch current trade amount from orchestrator (overrides env MAX_POSITION_USD)
  await fetchTradeAmountFromOrchestrator();

  // Step 3: Load watched games once, then keep polling in background
  await loadWatchedGamesFromOrchestrator();
  startWatchedGamesWatcher();

  // Step 4: Warm up signing client once — survives across games
  console.log("\n[setup] Initialising CLOB signing client...");
  await ensureSigningClientReady();

  // Game loop — runs continuously; no process.exit between games
  while (true) {
    // Reset per-game state
    gameIsOver = false;
    lastScoreHome = NaN;
    lastScoreAway = NaN;
    openPosition = null;
    fixId = undefined;
    staticId = "";
    marketReady = false;
    activeMarketBindingKey = "";
    lastSetupError = null;
    consecutiveEndedLifecyclePolls = 0;

    console.log("═".repeat(60));
    console.log(
      `FOOTBALL BOT — ${activeTeamHome} vs ${activeTeamAway} | Live Score Arbitrage`,
    );
    console.log(
      `match=${activeMatchSlug || "(awaiting watched game slug)"} | budget=${runtimeMaxPositionUsd} USDC`,
    );
    console.log("═".repeat(60) + "\n");

    // Step 2: Resolve market — loops until a watched game with slug is selected
    await ensureMarketReady();

    // Step 3: Log initial CLOB prices
    await logPrices();

    // Step 4: Wait for kickoff
    await waitForKickoff();

    if (gameIsOver) {
      // Game was already FT when we connected — print report and loop
      printReport();
      console.log("[bot]  Game already over — waiting for next game...\n");
      await sleep(30_000);
      continue;
    }

    // Step 5: Run live loops concurrently
    console.log(
      `[bot]  Live polling: Polymarket lifecycle every ${config.livePollMs / 1000}s | CLOB sell check every ${config.sellPollMs / 1000}s\n`,
    );
    await Promise.all([lifecycleMonitorLoop(), sellMonitorLoop()]);

    // Step 8: Print report then loop back for next game
    printReport();
    console.log("[bot]  Game over — resetting for next watched game...\n");
    await sleep(15_000);
  }
}

main().catch((err) => {
  console.error("[bot] Fatal error:", (err as Error).message);
  process.exit(1);
});
