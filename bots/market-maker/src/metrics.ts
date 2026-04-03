import { config } from "./config.js";
import { getStates } from "./quoter.js";
import { getTotalRealizedPnl } from "./inventory.js";

export interface MetricsSnapshot {
  botId: number;
  equity: number;
  pnl: number;
  unrealizedPnl: number;
  utilization: number;
  openPositions: number;
  recordedAt: string;
}

// State shared with Express /metrics endpoint
let lastSnapshot: MetricsSnapshot = {
  botId: config.botId,
  equity: 0,
  pnl: 0,
  unrealizedPnl: 0,
  utilization: 0,
  openPositions: 0,
  recordedAt: new Date().toISOString(),
};

export function getLastSnapshot(): MetricsSnapshot {
  return lastSnapshot;
}

export function buildSnapshot(allocatedEquity: number): MetricsSnapshot {
  const states = getStates();
  const openPositions = states.reduce((s, st) => s + st.openPositions, 0);

  // Approx unrealized: sum of mid * position size for all active markets
  const unrealizedPnl = states.reduce((s, st) => {
    const mid = st.mid;
    return s + mid * 0; // placeholder until fill tracking is complete
  }, 0);

  const realizedPnl = getTotalRealizedPnl();
  const totalPnl = realizedPnl + unrealizedPnl;

  // Utilization = fraction of allocated capital currently quoted
  const capitalQuoted = states.reduce((s, st) => {
    const bidValue = st.ourBidId
      ? st.ourBidPrice *
        (allocatedEquity / Math.max(1, states.length) / 2 / st.mid)
      : 0;
    const askValue = st.ourAskId
      ? st.ourAskPrice *
        (allocatedEquity / Math.max(1, states.length) / 2 / st.mid)
      : 0;
    return s + bidValue + askValue;
  }, 0);

  const utilization =
    allocatedEquity > 0 ? Math.min(1, capitalQuoted / allocatedEquity) : 0;

  const snapshot: MetricsSnapshot = {
    botId: config.botId,
    equity: parseFloat((allocatedEquity + totalPnl).toFixed(6)),
    pnl: parseFloat(totalPnl.toFixed(6)),
    unrealizedPnl: parseFloat(unrealizedPnl.toFixed(6)),
    utilization: parseFloat(utilization.toFixed(4)),
    openPositions,
    recordedAt: new Date().toISOString(),
  };

  lastSnapshot = snapshot;
  return snapshot;
}

export async function reportMetrics(allocatedEquity: number): Promise<void> {
  const snapshot = buildSnapshot(allocatedEquity);

  try {
    const res = await fetch(`${config.orchestratorUrl}/metrics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        botId: snapshot.botId,
        equity: snapshot.equity,
        pnl: snapshot.pnl,
        unrealizedPnl: snapshot.unrealizedPnl,
        utilization: snapshot.utilization,
        openPositions: snapshot.openPositions,
      }),
    });

    if (!res.ok) {
      console.warn(`[metrics] Orchestrator returned ${res.status}`);
    } else {
      console.log(
        `[metrics] Reported — equity: $${snapshot.equity.toFixed(2)}, pnl: $${snapshot.pnl.toFixed(2)}, openPos: ${snapshot.openPositions}, util: ${(snapshot.utilization * 100).toFixed(1)}%`,
      );
    }
  } catch (err) {
    console.warn("[metrics] Failed to report:", (err as Error).message);
  }
}
