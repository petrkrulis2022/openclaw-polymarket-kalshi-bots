/**
 * index.ts — Resolution Lag Buyer Bot (Bot 5)
 *
 * Every 5 minutes, fetches markets that Gamma has resolved but the CLOB has
 * not yet settled. Buys the winning token at the stale ask price and holds
 * until the CLOB resolves to $1.
 */

import express, { type Request, type Response } from "express";
import { config } from "./config.js";
import { fetchClosedUnresolvedMarkets } from "./monitor.js";
import { findResolutionOpportunities, type ResolutionOpportunity } from "./oracle.js";
import { enterPosition } from "./executor.js";
import {
  getAllPositions,
  getTotalRealizedPnl,
  hasOpenPosition,
  getOpenPositionsCount,
} from "./inventory.js";
import { reportMetrics, buildSnapshot, getLastSnapshot } from "./metrics.js";
import { getCollateralBalance } from "./clob.js";

let lastOpportunities: ResolutionOpportunity[] = [];
let lastScanAt: string | null = null;

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

// ── Main monitor cycle ────────────────────────────────────────────────────────

async function runMonitorCycle(): Promise<void> {
  if (getOpenPositionsCount() >= config.maxOpenPositions) {
    console.log("[lag] Max open positions reached — skipping scan");
    return;
  }

  const closedMarkets = await fetchClosedUnresolvedMarkets();
  const opportunities = await findResolutionOpportunities(closedMarkets);

  lastOpportunities = opportunities;
  lastScanAt = new Date().toISOString();

  // Filter by yield threshold and no existing position
  const actionable = opportunities.filter(
    (o) =>
      o.expectedYield * 100 >= config.minYieldPct &&
      !hasOpenPosition(o.market.id),
  );

  if (actionable.length === 0) {
    console.log("[lag] No actionable resolution-lag opportunities");
    return;
  }

  // Sort by highest yield first
  actionable.sort((a, b) => b.expectedYield - a.expectedYield);

  for (const opp of actionable) {
    if (getOpenPositionsCount() >= config.maxOpenPositions) break;
    console.log(
      `[lag] Opportunity: ${opp.market.question} | ` +
        `ask=${opp.currentAsk.toFixed(4)} yield=${(opp.expectedYield * 100).toFixed(2)}%`,
    );
    await enterPosition(opp).catch((err) =>
      console.error("[lag] enterPosition error:", (err as Error).message),
    );
  }
}

// ── Self-rescheduling loops ───────────────────────────────────────────────────

async function scheduleMonitor(): Promise<void> {
  try {
    await runMonitorCycle();
  } catch (err) {
    console.error("[lag] Monitor error:", (err as Error).message);
  }
  setTimeout(scheduleMonitor, config.monitorIntervalMs);
}

async function scheduleMetrics(): Promise<void> {
  try {
    const eq = await fetchAllocatedEquity();
    await reportMetrics(eq);
  } catch (err) {
    console.error("[lag] Metrics error:", (err as Error).message);
  }
  setTimeout(scheduleMetrics, 30_000);
}

// ── Express API ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, botId: config.botId, name: "resolution-lag" });
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

app.get("/opportunities", (_req: Request, res: Response) => {
  res.json({ opportunities: lastOpportunities, scannedAt: lastScanAt });
});

app.get("/config", (_req: Request, res: Response) => {
  res.json({
    botId: config.botId,
    monitorIntervalMs: config.monitorIntervalMs,
    minYieldPct: config.minYieldPct,
    maxPositionUsd: config.maxPositionUsd,
    maxOpenPositions: config.maxOpenPositions,
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(config.port, () => {
  console.log(
    `[lag] Resolution Lag Bot (id=${config.botId}) listening on :${config.port}`,
  );
  scheduleMonitor();
  scheduleMetrics();
});
