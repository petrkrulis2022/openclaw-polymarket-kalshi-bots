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
import { getAllPositions, getTotalRealizedPnl } from "./inventory.js";
import { reportMetrics, buildSnapshot, getLastSnapshot } from "./metrics.js";
import { getCollateralBalance } from "./clob.js";

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
    return await getCollateralBalance();
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

  // Refresh quotes in small concurrent batches to avoid CLOB rate limits
  for (let i = 0; i < markets.length; i += 10) {
    const batch = markets.slice(i, i + 10);
    await Promise.allSettled(batch.map((m) => refreshQuote(m)));
  }
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

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(config.port, () => {
  console.log(
    `[micro] Microstructure Bot (id=${config.botId}) listening on :${config.port}`,
  );
  scheduleQuotes();
  scheduleMetrics();
});
