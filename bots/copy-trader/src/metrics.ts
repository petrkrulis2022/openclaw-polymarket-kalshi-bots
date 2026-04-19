/**
 * metrics.ts — build and push snapshots to the orchestrator.
 * Mirrors market-maker pattern exactly.
 */

import { config } from "./config.js";
import { getTotalRealizedPnl, getAllPositions } from "./inventory.js";

export interface MetricsSnapshot {
  botId: number;
  equity: number;
  pnl: number;
  unrealizedPnl: number;
  utilization: number;
  openPositions: number;
  recordedAt: string;
}

let lastSnapshot: MetricsSnapshot | null = null;

export function buildSnapshot(allocatedEquity: number): MetricsSnapshot {
  const positions = getAllPositions();
  const realizedPnl = getTotalRealizedPnl();

  // Unrealized PnL: we don't track live prices here, so report 0
  // (the dashboard can compute it from position data + tracker snapshots)
  const unrealizedPnl = 0;
  const openPositions = positions.filter((p) => p.netSize > 0.001).length;

  const utilization =
    allocatedEquity > 0
      ? Math.min(100, (openPositions * 10) / allocatedEquity) * 100
      : 0;

  return {
    botId: config.botId,
    equity: allocatedEquity,
    pnl: realizedPnl,
    unrealizedPnl,
    utilization,
    openPositions,
    recordedAt: new Date().toISOString(),
  };
}

export async function reportMetrics(allocatedEquity: number): Promise<void> {
  const snapshot = buildSnapshot(allocatedEquity);
  lastSnapshot = snapshot;

  try {
    const res = await fetch(`${config.orchestratorUrl}/metrics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        botId: snapshot.botId,
        equity: snapshot.equity,
        pnl: snapshot.pnl,
        realizedPnl: snapshot.pnl,
        unrealizedPnl: snapshot.unrealizedPnl,
        utilization: snapshot.utilization,
        openPositions: snapshot.openPositions,
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      console.warn(`[metrics] Orchestrator returned ${res.status}`);
    }
  } catch {
    // Orchestrator offline — non-fatal
  }
}

export function getLastSnapshot(): MetricsSnapshot | null {
  return lastSnapshot;
}
