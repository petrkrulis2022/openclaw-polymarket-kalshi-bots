/**
 * index.ts — Kalshi ↔ Polymarket Cross-Platform Arb Bot (Bot 2)
 *
 * Every scan cycle:
 *   1. Fetch open Kalshi markets
 *   2. Match them to Polymarket markets (mapper.ts)
 *   3. For each pair, compute arb signals (orderbook.ts)
 *   4. Execute best signals up to maxOpenPairs (executor.ts)
 *
 * DRY_RUN=true by default — no real orders placed until explicitly disabled.
 */

import express, { type Request, type Response } from "express";
import { config } from "./config.js";
import { getKalshiMarkets, getKalshiOrderBook, getKalshiBalance, getKalshiStatus } from "./kalshi.js";
import { getPolyOrderBook, getPolyCollateralBalance } from "./clob.js";
import { findMarketPairs } from "./mapper.js";
import { computeArbSignals, type ArbSignal } from "./orderbook.js";
import { executeArb } from "./executor.js";
import { loadInventory, getOpenPairs, getAllPairs } from "./inventory.js";
import {
  loadWhitelist,
  isWhitelisted,
  addToWhitelist,
  removeFromWhitelist,
  getWhitelist,
} from "./whitelist.js";
import { reportMetrics, buildSnapshot, getLastSnapshot } from "./metrics.js";
import { checkAndClosePositions } from "./closer.js";

let lastSignals: ArbSignal[] = [];
let lastScanAt: string | null = null;
let scannedPairs = 0;

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
    return (await getPolyCollateralBalance()) / botCount;
  } catch {
    return 0;
  }
}

// ── Main scan cycle ───────────────────────────────────────────────────────────

async function runScanCycle(): Promise<void> {
  const kalshiStatus = await getKalshiStatus();
  if (!kalshiStatus.trading_active) {
    console.log("[kalshi-arb] Kalshi trading not active, skipping cycle");
    return;
  }

  const kalshiMarkets = await getKalshiMarkets();
  console.log(`[kalshi-arb] Kalshi: ${kalshiMarkets.length} markets`);

  const pairs = await findMarketPairs(kalshiMarkets);
  scannedPairs = pairs.length;

  if (pairs.length === 0) {
    console.log("[kalshi-arb] No matched pairs this cycle");
    lastScanAt = new Date().toISOString();
    return;
  }

  const cycleSignals: ArbSignal[] = [];

  // Fetch orderbooks in batches of 5 to avoid Kalshi 429 rate limits
  const BATCH = 5;
  for (let i = 0; i < pairs.length; i += BATCH) {
    await Promise.allSettled(
      pairs.slice(i, i + BATCH).map(async (pair) => {
        const [kalshiBook, polyBook] = await Promise.all([
          getKalshiOrderBook(pair.kalshiTicker),
          getPolyOrderBook(pair.polyYesTokenId),
        ]);
        const signals = computeArbSignals(pair, kalshiBook, polyBook);
        cycleSignals.push(...signals);
      }),
    );
    if (i + BATCH < pairs.length) await new Promise((r) => setTimeout(r, 300));
  }

  cycleSignals.sort((a, b) => b.netEdgePct - a.netEdgePct);
  lastSignals = cycleSignals;
  lastScanAt = new Date().toISOString();

  if (cycleSignals.length === 0) {
    console.log(`[kalshi-arb] Scanned ${pairs.length} pairs, no signals above ${config.minNetSpreadPct}% threshold`);
    return;
  }

  console.log(`[kalshi-arb] ${cycleSignals.length} signal(s) found across ${pairs.length} pairs`);

  const openCount = getOpenPairs().length;
  const availableSlots = config.maxOpenPairs - openCount;
  if (availableSlots <= 0) {
    console.log(`[kalshi-arb] maxOpenPairs=${config.maxOpenPairs} reached, skipping execution`);
    return;
  }

  const toFire = cycleSignals
    .filter((s) => isWhitelisted(s.pair.kalshiTicker))
    .slice(0, availableSlots);
  for (const signal of toFire) {
    await executeArb(signal).catch((err) => {
      console.error("[kalshi-arb] executeArb error:", (err as Error).message);
    });
  }
}

// ── Self-rescheduling loops ───────────────────────────────────────────────────

async function scheduleScan(): Promise<void> {
  try {
    await runScanCycle();
  } catch (err) {
    console.error("[kalshi-arb] Scan error:", (err as Error).message);
  }
  setTimeout(scheduleScan, config.scanIntervalMs);
}

async function scheduleCloser(): Promise<void> {
  try {
    await checkAndClosePositions();
  } catch (err) {
    console.error("[kalshi-arb] Closer error:", (err as Error).message);
  }
  setTimeout(scheduleCloser, 60_000);
}

async function scheduleMetrics(): Promise<void> {
  try {
    const eq = await fetchAllocatedEquity();
    await reportMetrics(eq);
  } catch (err) {
    console.error("[kalshi-arb] Metrics error:", (err as Error).message);
  }
  setTimeout(scheduleMetrics, 30_000);
}

// ── Express API ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, botId: config.botId, name: "kalshi-arb" });
});

app.get("/diagnostics", async (_req: Request, res: Response) => {
  const openPairs = getOpenPairs();
  const eq = await fetchAllocatedEquity();
  const [kalshiStatus, kalshiBalance] = await Promise.allSettled([
    getKalshiStatus(),
    getKalshiBalance(),
  ]);

  res.json({
    ok: true,
    botId: config.botId,
    name: "kalshi-arb",
    healthy: true,
    dryRun: config.dryRun,
    allocatedEquity: eq,
    kalshiTradingActive: kalshiStatus.status === "fulfilled" ? kalshiStatus.value.trading_active : false,
    kalshiBalanceUsd: kalshiBalance.status === "fulfilled" ? kalshiBalance.value : 0,
    lastScanAt,
    metrics: getLastSnapshot() ?? buildSnapshot(eq),
    reconciliation: {
      openPairs: openPairs.length,
      lastSignals: lastSignals.length,
      scannedPairs,
    },
  });
});

app.get("/metrics", async (_req: Request, res: Response) => {
  const eq = await fetchAllocatedEquity();
  res.json(getLastSnapshot() ?? buildSnapshot(eq));
});

app.get("/positions", (_req: Request, res: Response) => {
  const allPairs = getAllPairs();
  const totalPnl = allPairs.reduce((s, p) => s + (p.realizedPnl ?? 0), 0);
  res.json({ pairs: allPairs, totalRealizedPnl: totalPnl });
});

app.get("/scan-results", (_req: Request, res: Response) => {
  res.json({
    signals: lastSignals,
    scannedAt: lastScanAt,
    scannedPairs,
  });
});

app.get("/config", (_req: Request, res: Response) => {
  res.json({
    botId: config.botId,
    dryRun: config.dryRun,
    scanIntervalMs: config.scanIntervalMs,
    minNetSpreadPct: config.minNetSpreadPct,
    maxPositionUsd: config.maxPositionUsd,
    maxOpenPairs: config.maxOpenPairs,
    pairTimeoutMs: config.pairTimeoutMs,
  });
});

app.post("/orders/cancel-all", async (_req: Request, res: Response) => {
  // FOK orders don't persist; this clears open pair tracking
  const open = getOpenPairs();
  res.json({ ok: true, openPairs: open.length, message: "FOK orders self-cancel; no live orders to cancel" });
});

// ── Whitelist endpoints ────────────────────────────────────────────────────────

app.get("/pairs/candidates", (_req: Request, res: Response) => {
  res.json({ signals: lastSignals, scannedAt: lastScanAt, scannedPairs });
});

app.get("/pairs/whitelist", (_req: Request, res: Response) => {
  res.json({ whitelist: getWhitelist() });
});

app.post("/pairs/whitelist", (req: Request, res: Response) => {
  const { ticker } = req.body as { ticker?: string };
  if (!ticker || typeof ticker !== "string") {
    res.status(400).json({ error: "ticker required" });
    return;
  }
  addToWhitelist(ticker);
  res.json({ ok: true, ticker, whitelist: getWhitelist() });
});

app.delete("/pairs/whitelist/:ticker", (req: Request, res: Response) => {
  const ticker = decodeURIComponent(req.params["ticker"] ?? "");
  removeFromWhitelist(ticker);
  res.json({ ok: true, ticker, whitelist: getWhitelist() });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(config.port, () => {
  console.log(
    `[kalshi-arb] Kalshi-Arb Bot (id=${config.botId}) listening on :${config.port} | dryRun=${config.dryRun}`,
  );
  loadInventory();
  loadWhitelist();
  scheduleScan();
  scheduleCloser();
  scheduleMetrics();
});
