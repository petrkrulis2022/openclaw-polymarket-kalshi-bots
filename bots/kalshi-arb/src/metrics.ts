import { config } from "./config.js";
import { getOpenPairs, getAllPairs } from "./inventory.js";

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
  const allPairs = getAllPairs();
  const closedPairs = allPairs.filter((p) => p.status === "closed" || p.status === "cancelled");
  const pnl = closedPairs.reduce((sum, p) => sum + (p.realizedPnl ?? 0), 0);
  const openPositions = getOpenPairs().length;
  const utilization =
    allocatedEquity > 0
      ? Math.min(1, (openPositions * config.maxPositionUsd) / allocatedEquity)
      : 0;

  return {
    botId: config.botId,
    equity: allocatedEquity,
    pnl,
    unrealizedPnl: 0,
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
        recordedAt: snapshot.recordedAt,
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      console.warn(`[metrics] Orchestrator returned ${res.status}`);
    }
  } catch {
    // Orchestrator offline — metrics buffered in lastSnapshot
  }
}

export function getLastSnapshot(): MetricsSnapshot | null {
  return lastSnapshot;
}
