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
import { getAllPairs, getTotalRealizedPnl } from "./inventory.js";
import { reportMetrics, buildSnapshot, getLastSnapshot } from "./metrics.js";
import { getCollateralBalance } from "./clob.js";

// ── Track most-recent scan results for the dashboard ──────────────────────────

let lastScanResults: ArbSignal[] = [];
let lastScanAt: string | null = null;
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
    return await getCollateralBalance();
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
        `profitableUsd=${signal.profitableVolumeUsd.toFixed(4)}`,
    );
    await executeArbPair(signal).catch((err) => {
      console.error("[arb] executeArbPair error:", (err as Error).message);
      activeMarkets.delete(signal.marketId);
    });
  }
}

// ── Self-rescheduling loops ───────────────────────────────────────────────────

async function scheduleScan(): Promise<void> {
  try {
    await runScanCycle();
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

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(config.port, () => {
  console.log(
    `[arb] In-Market Arb Bot (id=${config.botId}) listening on :${config.port}`,
  );
  scheduleScan();
  scheduleMetrics();
});
