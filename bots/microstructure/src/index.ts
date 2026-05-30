/**
 * index.ts — Low-Price Microstructure Bot (Bot 6)
 *
 * Every 30 min screens all active Polymarket markets for tokens priced below
 * $0.003 with 90+ days to expiry. Every 30s refreshes resting bids on all
 * screened markets. On fill, posts a sell at 2× entry price.
 */

import express, { type Request, type Response } from "express";
import { config } from "./config.js";
import { runScreener, getScreenedMarkets } from "./screener.js";
import { refreshQuote } from "./quoter.js";
import { getAllPositions, getTotalRealizedPnl, loadPersistedState } from "./inventory.js";
import { reportMetrics, buildSnapshot, getLastSnapshot } from "./metrics.js";
import {
  fetchTradeHistory,
  getCollateralBalance,
  getOpenOrders,
  cancelOrder,
  type OpenOrder,
} from "./clob.js";
import { loadAnalysis, scheduleAnalysisRefresh } from "./analysis.js";

type TradeFill = {
  side: "BUY" | "SELL";
  size: number;
  price: number;
};

const seenTradeKeys = new Set<string>();
let lastQuoteAt: string | null = null;
let lastReconcileAt: string | null = null;

function tradeKey(t: {
  id: string;
  orderId: string;
  assetId: string;
  side: string;
  size: number;
  price: number;
  createdAt: string;
}): string {
  if (t.id) return t.id;
  return [
    t.orderId,
    t.assetId,
    t.side,
    t.size.toFixed(8),
    t.price.toFixed(8),
    t.createdAt,
  ].join("|");
}

async function getNewFillsByOrderId(): Promise<Map<string, TradeFill>> {
  const fills = new Map<string, TradeFill>();
  const trades = await fetchTradeHistory();

  for (const t of trades) {
    if (t.status !== "CONFIRMED") continue;
    const key = tradeKey(t);
    if (seenTradeKeys.has(key)) continue;
    seenTradeKeys.add(key);

    if (!t.orderId || t.size <= 0 || t.price <= 0) continue;
    const side = t.side.toUpperCase();
    if (side !== "BUY" && side !== "SELL") continue;

    const prev = fills.get(t.orderId);
    if (prev) {
      const combined = prev.size + t.size;
      const weightedPrice =
        combined > 0
          ? (prev.price * prev.size + t.price * t.size) / combined
          : t.price;
      fills.set(t.orderId, {
        side: prev.side,
        size: combined,
        price: weightedPrice,
      });
    } else {
      fills.set(t.orderId, {
        side: side as "BUY" | "SELL",
        size: t.size,
        price: t.price,
      });
    }
  }

  return fills;
}

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
    // fall back
  }
  try {
    const botCount = parseInt(process.env["BOT_COUNT"] ?? "1", 10);
    return (await getCollateralBalance()) / botCount;
  } catch {
    return 0;
  }
}

// ── Quote cycle ───────────────────────────────────────────────────────────────

async function runQuoteCycle(): Promise<void> {
  // Re-screen if needed (screener caches internally)
  await runScreener();

  const markets = getScreenedMarkets();
  if (markets.length === 0) {
    console.log("[micro] No screened markets — waiting for next screen");
    return;
  }

  const allocatedEquity = await fetchAllocatedEquity();
  const maxByCapital = Math.max(
    1,
    Math.floor((allocatedEquity * 0.8) / config.maxUsdPerMarket),
  );
  const cappedMarkets = markets.slice(
    0,
    Math.min(markets.length, maxByCapital),
  );

  const openOrders = await getOpenOrders();
  const openOrdersById = new Map<string, OpenOrder>(
    openOrders.map((o) => [o.id, o]),
  );
  const fillsByOrderId = await getNewFillsByOrderId();
  lastReconcileAt = new Date().toISOString();

  // Refresh quotes in small concurrent batches to avoid CLOB rate limits
  for (let i = 0; i < cappedMarkets.length; i += 10) {
    const batch = cappedMarkets.slice(i, i + 10);
    await Promise.allSettled(
      batch.map((m) => refreshQuote(m, openOrdersById, fillsByOrderId)),
    );
  }
  lastQuoteAt = new Date().toISOString();
}

// ── Self-rescheduling loops ───────────────────────────────────────────────────

async function scheduleQuotes(): Promise<void> {
  try {
    await runQuoteCycle();
  } catch (err) {
    console.error("[micro] Quote cycle error:", (err as Error).message);
  }
  setTimeout(scheduleQuotes, config.quoteIntervalMs);
}

async function scheduleMetrics(): Promise<void> {
  try {
    const eq = await fetchAllocatedEquity();
    await reportMetrics(eq);
  } catch (err) {
    console.error("[micro] Metrics error:", (err as Error).message);
  }
  setTimeout(scheduleMetrics, 30_000);
}

// ── Express API ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, botId: config.botId, name: "microstructure" });
});

app.get("/diagnostics", async (_req: Request, res) => {
  const eq = await fetchAllocatedEquity();

  res.json({
    ok: true,
    botId: config.botId,
    name: "microstructure",
    healthy: true,
    allocatedEquity: eq,
    lastQuoteAt,
    lastReconcileAt,
    metrics: getLastSnapshot() ?? buildSnapshot(eq),
    reconciliation: {
      screenedMarkets: getScreenedMarkets().length,
      openPositions: getAllPositions().length,
    },
  });
});

app.get("/metrics", async (_req: Request, res: Response) => {
  const eq = await fetchAllocatedEquity();
  res.json(getLastSnapshot() ?? buildSnapshot(eq));
});

app.get("/positions", (_req: Request, res: Response) => {
  res.json({
    positions: getAllPositions(),
    totalRealizedPnl: getTotalRealizedPnl(),
  });
});

app.get("/screened-markets", (_req: Request, res: Response) => {
  res.json({ markets: getScreenedMarkets() });
});

app.get("/config", (_req: Request, res: Response) => {
  res.json({
    botId: config.botId,
    screenIntervalMs: config.screenIntervalMs,
    quoteIntervalMs: config.quoteIntervalMs,
    maxAskPrice: config.maxAskPrice,
    minDaysToExpiry: config.minDaysToExpiry,
    maxMarkets: config.maxMarkets,
    maxUsdPerMarket: config.maxUsdPerMarket,
    cancelDaysBeforeExpiry: config.cancelDaysBeforeExpiry,
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
    `[micro] Microstructure Bot (id=${config.botId}) listening on :${config.port}`,
  );
  loadPersistedState();
  loadAnalysis()
    .then(() => scheduleAnalysisRefresh())
    .catch(() => {});
  scheduleQuotes();
  scheduleMetrics();
});
