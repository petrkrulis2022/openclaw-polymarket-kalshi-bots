/**
 * index.ts — In-Market Arb Bot (Bot 4)
 *
 * Scans Polymarket markets every ~15s (was 60s).
 * Two arb types:
 *   1. Binary   — YES ask + NO ask < $1 after per-market taker fees
 *   2. NegRisk  — sum(all YES asks in group) < $1 after fees
 *                 (exactly one YES wins → guaranteed $1 return)
 */

import express, { type Request, type Response } from "express";
import { config } from "./config.js";
import { scanActiveMarkets, type BinaryMarket } from "./scanner.js";
import {
  computeArbSignal,
  computeNegRiskArbSignal,
  computeNegRiskNoSweepSignal,
  type ArbSignal,
  type NegRiskArbSignal,
} from "./orderbook.js";
import { executeArbPair, executeNegRiskArbPair } from "./executor.js";
import {
  getAllPairs,
  getOpenPairs,
  getAllNegRiskPairs,
  getOpenNegRiskPairs,
  getTotalRealizedPnl,
  loadPersistedState,
  settlePair,
  updatePair,
} from "./inventory.js";
import { reportMetrics, buildSnapshot, getLastSnapshot } from "./metrics.js";
import {
  cancelOrder,
  getCollateralBalance,
  getOpenOrders,
  VENUE,
} from "./venue/index.js";
import { listBinaryMarkets as listKalshiBinary } from "./venue/kalshi.js";
import { executeKalshiArbPair } from "./executor-kalshi.js";
import { listBinaryMarkets as listLimitlessBinary } from "./venue/limitless.js";
import { executeLimitlessArbPair } from "./executor-limitless.js";
import { listBinaryMarkets as listOpinionBinary } from "./venue/opinion.js";
import { executeOpinionArbPair } from "./executor-opinion.js";
import { loadAnalysis, scheduleAnalysisRefresh } from "./analysis.js";
import { logActivity, getActivity } from "./activity.js";

type AnySignal = ArbSignal | NegRiskArbSignal;

let lastScanSignals: AnySignal[] = [];
let lastScanAt: string | null = null;
let lastReconcileAt: string | null = null;
const activeMarkets = new Set<string>();
const activeNegRiskGroups = new Set<string>();

// ── Equity helper ─────────────────────────────────────────────────────────────

async function fetchAllocatedEquity(): Promise<number> {
  try {
    const res = await fetch(
      `${config.treasuryUrl}/allocations/${config.botId}`,
      { signal: AbortSignal.timeout(3_000) },
    );
    if (res.ok) {
      const data = (await res.json()) as { allocatedUsd: number };
      return data.allocatedUsd ?? 0;
    }
  } catch {
    /* Treasury offline */
  }
  try {
    const botCount = parseInt(process.env["BOT_COUNT"] ?? "1", 10);
    return (await getCollateralBalance()) / botCount;
  } catch {
    return 0;
  }
}

// ── Main scan cycle ───────────────────────────────────────────────────────────

// ── Kalshi scan cycle (binary only — no neg-risk, no merge) ──────────────────

let kalshiMarketsCache: BinaryMarket[] = [];
let kalshiMarketsAt = 0;
let kalshiScanCursor = 0;
const KALSHI_MARKET_CACHE_MS = 55_000;

async function runKalshiScanCycle(): Promise<void> {
  const now = Date.now();
  if (now - kalshiMarketsAt > KALSHI_MARKET_CACHE_MS || kalshiMarketsCache.length === 0) {
    kalshiMarketsCache = await listKalshiBinary();
    kalshiMarketsAt = now;
  }

  const all = kalshiMarketsCache.filter((m) => !activeMarkets.has(m.id));
  // Rotate a window across the full market list so every market is covered over time.
  const N = config.maxConcurrentMarkets;
  const window: BinaryMarket[] = [];
  for (let i = 0; i < Math.min(N, all.length); i++) {
    window.push(all[(kalshiScanCursor + i) % all.length]!);
  }
  kalshiScanCursor = all.length > 0 ? (kalshiScanCursor + N) % all.length : 0;

  const signals: ArbSignal[] = [];
  await Promise.allSettled(
    window.map(async (m) => {
      const signal = await computeArbSignal(
        m.id,
        m.conditionId,
        m.question,
        m.yesTokenId,
        m.noTokenId,
        m.feeRate,
      );
      if (signal) signals.push(signal);
    }),
  );

  lastScanSignals = signals;
  lastScanAt = new Date().toISOString();
  logActivity("scan_complete", {
    binaryMarkets: kalshiMarketsCache.length,
    negRiskGroups: 0,
    signals: signals.length,
  });

  if (signals.length === 0) {
    console.log("[arb] No profitable Kalshi signals this cycle");
    return;
  }

  signals.sort((a, b) => b.expectedProfitUsd - a.expectedProfitUsd);
  for (const signal of signals) {
    if (activeMarkets.has(signal.marketId)) continue;
    activeMarkets.add(signal.marketId);
    console.log(
      `[arb] Kalshi binary signal: ${signal.marketQuestion} | spread=${signal.netSpread.toFixed(4)} ` +
        `profit=$${signal.expectedProfitUsd.toFixed(4)}`,
    );
    logActivity("signal_found", {
      kind: "binary",
      venue: "kalshi",
      market: signal.marketQuestion,
      spread: signal.netSpread,
      profitUsd: signal.expectedProfitUsd,
    });
    await executeKalshiArbPair(signal).catch((err) => {
      console.error("[arb] executeKalshiArbPair error:", (err as Error).message);
      activeMarkets.delete(signal.marketId);
    });
    setTimeout(
      () => activeMarkets.delete(signal.marketId),
      config.pairTimeoutMs + 1_000,
    );
  }
}

// ── Limitless scan cycle (binary single markets; CTF merge after entry) ──────

let limitlessMarketsCache: BinaryMarket[] = [];
let limitlessMarketsAt = 0;
let limitlessScanCursor = 0;
const LIMITLESS_MARKET_CACHE_MS = 55_000;

async function runLimitlessScanCycle(): Promise<void> {
  const now = Date.now();
  if (
    now - limitlessMarketsAt > LIMITLESS_MARKET_CACHE_MS ||
    limitlessMarketsCache.length === 0
  ) {
    limitlessMarketsCache = await listLimitlessBinary();
    limitlessMarketsAt = now;
  }

  const all = limitlessMarketsCache.filter((m) => !activeMarkets.has(m.id));
  const N = config.maxConcurrentMarkets;
  const window: BinaryMarket[] = [];
  for (let i = 0; i < Math.min(N, all.length); i++) {
    window.push(all[(limitlessScanCursor + i) % all.length]!);
  }
  limitlessScanCursor = all.length > 0 ? (limitlessScanCursor + N) % all.length : 0;

  const signals: ArbSignal[] = [];
  await Promise.allSettled(
    window.map(async (m) => {
      const signal = await computeArbSignal(
        m.id,
        m.conditionId,
        m.question,
        m.yesTokenId,
        m.noTokenId,
        m.feeRate,
      );
      if (signal) signals.push(signal);
    }),
  );

  lastScanSignals = signals;
  lastScanAt = new Date().toISOString();
  logActivity("scan_complete", {
    binaryMarkets: limitlessMarketsCache.length,
    negRiskGroups: 0,
    signals: signals.length,
  });

  if (signals.length === 0) {
    console.log("[arb] No profitable Limitless signals this cycle");
    return;
  }

  signals.sort((a, b) => b.expectedProfitUsd - a.expectedProfitUsd);
  for (const signal of signals) {
    if (activeMarkets.has(signal.marketId)) continue;
    activeMarkets.add(signal.marketId);
    console.log(
      `[arb] Limitless binary signal: ${signal.marketQuestion} | spread=${signal.netSpread.toFixed(4)} ` +
        `profit=$${signal.expectedProfitUsd.toFixed(4)}`,
    );
    logActivity("signal_found", {
      kind: "binary",
      venue: "limitless",
      market: signal.marketQuestion,
      spread: signal.netSpread,
      profitUsd: signal.expectedProfitUsd,
    });
    await executeLimitlessArbPair(signal).catch((err) => {
      console.error("[arb] executeLimitlessArbPair error:", (err as Error).message);
      activeMarkets.delete(signal.marketId);
    });
    setTimeout(
      () => activeMarkets.delete(signal.marketId),
      config.pairTimeoutMs + 1_000,
    );
  }
}

// ── Opinion scan cycle (binary single markets; SDK merge after entry) ────────

let opinionMarketsCache: BinaryMarket[] = [];
let opinionMarketsAt = 0;
let opinionScanCursor = 0;
const OPINION_MARKET_CACHE_MS = 55_000;

async function runOpinionScanCycle(): Promise<void> {
  const now = Date.now();
  if (
    now - opinionMarketsAt > OPINION_MARKET_CACHE_MS ||
    opinionMarketsCache.length === 0
  ) {
    opinionMarketsCache = await listOpinionBinary();
    opinionMarketsAt = now;
  }

  const all = opinionMarketsCache.filter((m) => !activeMarkets.has(m.id));
  const N = config.maxConcurrentMarkets;
  const window: BinaryMarket[] = [];
  for (let i = 0; i < Math.min(N, all.length); i++) {
    window.push(all[(opinionScanCursor + i) % all.length]!);
  }
  opinionScanCursor = all.length > 0 ? (opinionScanCursor + N) % all.length : 0;

  const signals: ArbSignal[] = [];
  await Promise.allSettled(
    window.map(async (m) => {
      const signal = await computeArbSignal(
        m.id,
        m.conditionId,
        m.question,
        m.yesTokenId,
        m.noTokenId,
        m.feeRate,
      );
      if (signal) signals.push(signal);
    }),
  );

  lastScanSignals = signals;
  lastScanAt = new Date().toISOString();
  logActivity("scan_complete", {
    binaryMarkets: opinionMarketsCache.length,
    negRiskGroups: 0,
    signals: signals.length,
  });

  if (signals.length === 0) {
    console.log("[arb] No profitable Opinion signals this cycle");
    return;
  }

  signals.sort((a, b) => b.expectedProfitUsd - a.expectedProfitUsd);
  for (const signal of signals) {
    if (activeMarkets.has(signal.marketId)) continue;
    activeMarkets.add(signal.marketId);
    console.log(
      `[arb] Opinion binary signal: ${signal.marketQuestion} | spread=${signal.netSpread.toFixed(4)} ` +
        `profit=$${signal.expectedProfitUsd.toFixed(4)}`,
    );
    logActivity("signal_found", {
      kind: "binary",
      venue: "opinion",
      market: signal.marketQuestion,
      spread: signal.netSpread,
      profitUsd: signal.expectedProfitUsd,
    });
    await executeOpinionArbPair(signal).catch((err) => {
      console.error("[arb] executeOpinionArbPair error:", (err as Error).message);
      activeMarkets.delete(signal.marketId);
    });
    setTimeout(
      () => activeMarkets.delete(signal.marketId),
      config.pairTimeoutMs + 1_000,
    );
  }
}

async function runScanCycle(): Promise<void> {
  if (VENUE === "kalshi") return runKalshiScanCycle();
  if (VENUE === "limitless") return runLimitlessScanCycle();
  if (VENUE === "opinion") return runOpinionScanCycle();
  const { binary, negRisk } = await scanActiveMarkets();
  const signals: AnySignal[] = [];

  // Binary arb
  const binaryCandidates = binary
    .filter((m) => !activeMarkets.has(m.id))
    .slice(0, config.maxConcurrentMarkets);

  await Promise.allSettled(
    binaryCandidates.map(async (m) => {
      const signal = await computeArbSignal(
        m.id,
        m.conditionId,
        m.question,
        m.yesTokenId,
        m.noTokenId,
        m.feeRate,
      );
      if (signal) signals.push(signal);
    }),
  );

  // NegRisk arb
  const negRiskCandidates = negRisk.filter(
    (g) => !activeNegRiskGroups.has(g.negRiskMarketId),
  );

  await Promise.allSettled(
    negRiskCandidates.map(async (g) => {
      // YES-sweep and NO-sweep trade independent books — both can fire.
      const [yesSweep, noSweep] = await Promise.all([
        computeNegRiskArbSignal(g),
        computeNegRiskNoSweepSignal(g),
      ]);
      if (yesSweep) signals.push(yesSweep);
      if (noSweep) signals.push(noSweep);
    }),
  );

  lastScanSignals = signals;
  lastScanAt = new Date().toISOString();
  logActivity("scan_complete", {
    binaryMarkets: binary.length,
    negRiskGroups: negRisk.length,
    signals: signals.length,
  });

  if (signals.length === 0) {
    console.log("[arb] No profitable signals this cycle");
    return;
  }

  signals.sort((a, b) => b.expectedProfitUsd - a.expectedProfitUsd);

  for (const signal of signals) {
    if (signal.type === "binary") {
      if (activeMarkets.has(signal.marketId)) continue;
      activeMarkets.add(signal.marketId);
      console.log(
        `[arb] Binary signal: ${signal.marketQuestion} | spread=${signal.netSpread.toFixed(4)} ` +
          `fee=${signal.feeRate} profit=$${signal.expectedProfitUsd.toFixed(4)}`,
      );
      logActivity("signal_found", {
        kind: "binary",
        market: signal.marketQuestion,
        spread: signal.netSpread,
        profitUsd: signal.expectedProfitUsd,
      });
      await executeArbPair(signal).catch((err) => {
        console.error("[arb] executeArbPair error:", (err as Error).message);
        logActivity(
          "execute_error",
          { market: signal.marketQuestion, message: (err as Error).message },
          "error",
        );
        activeMarkets.delete(signal.marketId);
      });
      setTimeout(
        () => activeMarkets.delete(signal.marketId),
        config.pairTimeoutMs + 1_000,
      );
    } else {
      if (activeNegRiskGroups.has(signal.negRiskMarketId)) continue;
      activeNegRiskGroups.add(signal.negRiskMarketId);
      console.log(
        `[arb] NegRisk ${signal.sweep.toUpperCase()}-sweep signal: ${signal.groupQuestion} | ` +
          `${signal.legs.length} legs spread=${signal.netSpread.toFixed(4)} ` +
          `profit=$${signal.expectedProfitUsd.toFixed(4)}`,
      );
      logActivity("signal_found", {
        kind: "neg_risk",
        sweep: signal.sweep,
        group: signal.groupQuestion,
        legs: signal.legs.length,
        profitUsd: signal.expectedProfitUsd,
      });
      await executeNegRiskArbPair(signal).catch((err) => {
        console.error(
          "[arb] executeNegRiskArbPair error:",
          (err as Error).message,
        );
        logActivity(
          "execute_error",
          { group: signal.groupQuestion, message: (err as Error).message },
          "error",
        );
        activeNegRiskGroups.delete(signal.negRiskMarketId);
      });
      setTimeout(
        () => activeNegRiskGroups.delete(signal.negRiskMarketId),
        config.pairTimeoutMs + 1_000,
      );
    }
  }
}

function estimateLockedProfitUsd(pair: {
  sizeUsd: number;
  yesPrice: number;
  noPrice: number;
}): number {
  const combinedPrice = pair.yesPrice + pair.noPrice;
  if (combinedPrice <= 0 || pair.sizeUsd <= 0) return 0;
  const shares = pair.sizeUsd / combinedPrice;
  return shares - pair.sizeUsd;
}

async function reconcilePairs(): Promise<void> {
  const openPairs = getOpenPairs();
  if (openPairs.length === 0) {
    lastReconcileAt = new Date().toISOString();
    return;
  }

  const openOrdersById = new Map((await getOpenOrders()).map((o) => [o.id, o]));

  for (const pair of openPairs) {
    const yesOrder = openOrdersById.get(pair.yesOrderId);
    const noOrder = openOrdersById.get(pair.noOrderId);
    const yesOpen = Boolean(yesOrder);
    const noOpen = Boolean(noOrder);

    if (yesOrder || noOrder) {
      updatePair(pair.id, {
        yesRemainingSize: yesOrder?.remainingSize ?? 0,
        noRemainingSize: noOrder?.remainingSize ?? 0,
        status: yesOpen && noOpen ? "pending" : "partial",
      });
    }

    if (yesOpen && noOpen) continue;

    if (!yesOpen && !noOpen) {
      const pnl = estimateLockedProfitUsd(pair);
      settlePair(pair.id, pnl);
      logActivity("pair_settled", { pairId: pair.id, pnlUsd: pnl });
      continue;
    }

    const remainingOrderId = yesOpen ? pair.yesOrderId : pair.noOrderId;
    await cancelOrder(remainingOrderId);
    logActivity("leg_cancelled", { pairId: pair.id }, "warn");
    updatePair(pair.id, {
      status: "partial",
      yesRemainingSize: yesOpen ? (yesOrder?.remainingSize ?? pair.yesRemainingSize) : 0,
      noRemainingSize: noOpen ? (noOrder?.remainingSize ?? pair.noRemainingSize) : 0,
    });
  }

  lastReconcileAt = new Date().toISOString();
}

// ── Self-rescheduling loops ───────────────────────────────────────────────────

async function scheduleScan(): Promise<void> {
  try {
    await runScanCycle();
    if (VENUE === "polymarket") await reconcilePairs();
  } catch (err) {
    console.error("[arb] Scan error:", (err as Error).message);
    logActivity("scan_error", { message: (err as Error).message }, "error");
  }
  setTimeout(scheduleScan, config.scanIntervalMs);
}

async function scheduleMetrics(): Promise<void> {
  try {
    const eq = await fetchAllocatedEquity();
    await reportMetrics(eq);
  } catch (err) {
    console.error("[arb] Metrics error:", (err as Error).message);
  }
  setTimeout(scheduleMetrics, 30_000);
}

// ── Express API ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, botId: config.botId, name: "in-market-arb" });
});

app.get("/diagnostics", async (_req: Request, res: Response) => {
  const openPairs = getOpenPairs();
  const openNegRisk = getOpenNegRiskPairs();
  const eq = await fetchAllocatedEquity();

  res.json({
    ok: true,
    botId: config.botId,
    name: "in-market-arb",
    healthy: true,
    allocatedEquity: eq,
    lastScanAt,
    lastReconcileAt,
    metrics: getLastSnapshot() ?? buildSnapshot(eq),
    reconciliation: {
      openBinaryPairs: openPairs.length,
      openNegRiskPairs: openNegRisk.length,
      activeMarkets: activeMarkets.size,
      activeNegRiskGroups: activeNegRiskGroups.size,
      lastSignals: lastScanSignals.length,
    },
  });
});

app.get("/metrics", async (_req: Request, res: Response) => {
  const eq = await fetchAllocatedEquity();
  res.json(getLastSnapshot() ?? buildSnapshot(eq));
});

app.get("/positions", (_req: Request, res: Response) => {
  res.json({
    pairs: getAllPairs(),
    negRiskPairs: getAllNegRiskPairs(),
    totalRealizedPnl: getTotalRealizedPnl(),
  });
});

app.get("/scan-results", (_req: Request, res: Response) => {
  res.json({ signals: lastScanSignals, scannedAt: lastScanAt });
});

app.get("/activity", (req: Request, res: Response) => {
  const limit = Number(req.query["limit"] ?? 100);
  const afterSeq = Number(req.query["afterSeq"] ?? 0);
  res.json({
    entries: getActivity(
      Number.isFinite(limit) ? limit : 100,
      Number.isFinite(afterSeq) ? afterSeq : 0,
    ),
  });
});

app.get("/config", (_req: Request, res: Response) => {
  res.json({
    botId: config.botId,
    scanIntervalMs: config.scanIntervalMs,
    feeThreshold: config.feeThreshold,
    defaultFeeRate: config.defaultFeeRate,
    pairTimeoutMs: config.pairTimeoutMs,
    maxPositionUsd: config.maxPositionUsd,
    maxConcurrentMarkets: config.maxConcurrentMarkets,
  });
});

app.post("/orders/cancel-all", async (_req: Request, res: Response) => {
  const orders = await getOpenOrders();
  let cancelled = 0;
  const errors: string[] = [];
  for (const order of orders) {
    try {
      await cancelOrder(order.id);
      cancelled++;
    } catch (err) {
      errors.push(`${order.id}: ${(err as Error).message}`);
    }
  }
  res.json({ ok: true, cancelled, total: orders.length, errors });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(config.port, () => {
  console.log(
    `[arb] In-Market Arb Bot (id=${config.botId}) listening on :${config.port}`,
  );
  loadPersistedState();
  loadAnalysis()
    .then(() => scheduleAnalysisRefresh())
    .catch(() => {});
  scheduleScan();
  scheduleMetrics();
});
