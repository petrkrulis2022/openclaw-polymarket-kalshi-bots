/**
 * index.ts — In-Market Arb Bot (Bot 4)
 *
 * Scans all active Polymarket binary markets every ~60s.
 * For each market, walks YES+NO ask depth to find profitable combined spread.
 * Enters both legs simultaneously when net spread > fee threshold.
 */

import express, { type Request, type Response } from "express";
import { config } from "./config.js";
import { scanActiveMarkets } from "./scanner.js";
import { computeArbSignal, type ArbSignal } from "./orderbook.js";
import { executeArbPair } from "./executor.js";
import {
  getAllPairs,
  getOpenPairs,
  getTotalRealizedPnl,
  settlePair,
  updatePair,
} from "./inventory.js";
import { reportMetrics, buildSnapshot, getLastSnapshot } from "./metrics.js";
import { cancelOrder, getCollateralBalance, getOpenOrders } from "./clob.js";
import { loadAnalysis, scheduleAnalysisRefresh } from "./analysis.js";

// ── Track most-recent scan results for the dashboard ──────────────────────────

let lastScanResults: ArbSignal[] = [];
let lastScanAt: string | null = null;
let lastReconcileAt: string | null = null;
// Track which market IDs are already in an open arb pair
const activeMarkets = new Set<string>();

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
    // Treasury offline — fall back to CLOB balance
  }
  try {
    const botCount = parseInt(process.env["BOT_COUNT"] ?? "1", 10);
    return (await getCollateralBalance()) / botCount;
  } catch {
    return 0;
  }
}

// ── Main scan cycle ───────────────────────────────────────────────────────────

async function runScanCycle(): Promise<void> {
  const markets = await scanActiveMarkets();

  // Filter out markets already running an open arb
  const candidates = markets.filter((m) => !activeMarkets.has(m.id));

  // Limit concurrency to avoid rate-limiting
  const batch = candidates.slice(0, config.maxConcurrentMarkets);

  const signals: ArbSignal[] = [];
  await Promise.allSettled(
    batch.map(async (m) => {
      const signal = await computeArbSignal(
        m.id,
        m.question,
        m.yesTokenId,
        m.noTokenId,
      );
      if (signal) signals.push(signal);
    }),
  );

  lastScanResults = signals;
  lastScanAt = new Date().toISOString();

  if (signals.length === 0) {
    console.log("[arb] No profitable signals this cycle");
    return;
  }

  // Sort by highest profitable volume, execute top candidates
  signals.sort((a, b) => b.profitableVolumeUsd - a.profitableVolumeUsd);
  for (const signal of signals) {
    if (activeMarkets.has(signal.marketId)) continue;
    activeMarkets.add(signal.marketId);
    console.log(
      `[arb] Signal: ${signal.marketQuestion} | spread=${signal.netSpread.toFixed(4)} ` +
        `notionalUsd=${signal.profitableVolumeUsd.toFixed(4)} ` +
        `expectedPnlUsd=${signal.expectedProfitUsd.toFixed(4)}`,
    );
    await executeArbPair(signal).catch((err) => {
      console.error("[arb] executeArbPair error:", (err as Error).message);
      activeMarkets.delete(signal.marketId);
    });

    // Release market lock after the pair timeout window so the market
    // can be reconsidered on later scans.
    setTimeout(
      () => activeMarkets.delete(signal.marketId),
      config.pairTimeoutMs + 1_000,
    );
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
      // Both orders are off-book; assume hedged pair is completed.
      settlePair(pair.id, estimateLockedProfitUsd(pair));
      continue;
    }

    // One leg is off-book while the other remains open: cancel remaining leg
    // and mark pair as partial so it is visible in API/metrics.
    const remainingOrderId = yesOpen ? pair.yesOrderId : pair.noOrderId;
    await cancelOrder(remainingOrderId);
    updatePair(pair.id, {
      status: "partial",
      yesRemainingSize: yesOpen
        ? (yesOrder?.remainingSize ?? pair.yesRemainingSize)
        : 0,
      noRemainingSize: noOpen
        ? (noOrder?.remainingSize ?? pair.noRemainingSize)
        : 0,
    });
  }

  lastReconcileAt = new Date().toISOString();
}

// ── Self-rescheduling loops ───────────────────────────────────────────────────

async function scheduleScan(): Promise<void> {
  try {
    await runScanCycle();
    await reconcilePairs();
  } catch (err) {
    console.error("[arb] Scan error:", (err as Error).message);
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

app.get("/diagnostics", async (_req: Request, res) => {
  const openPairs = getOpenPairs();
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
      openPairs: openPairs.length,
      activeMarkets: activeMarkets.size,
      lastSignals: lastScanResults.length,
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
    totalRealizedPnl: getTotalRealizedPnl(),
  });
});

app.get("/scan-results", (_req: Request, res: Response) => {
  res.json({ signals: lastScanResults, scannedAt: lastScanAt });
});

app.get("/config", (_req: Request, res: Response) => {
  res.json({
    botId: config.botId,
    scanIntervalMs: config.scanIntervalMs,
    feeThreshold: config.feeThreshold,
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
  loadAnalysis()
    .then(() => scheduleAnalysisRefresh())
    .catch(() => {});
  scheduleScan();
  scheduleMetrics();
});
