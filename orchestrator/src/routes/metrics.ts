import { Router, Request, Response } from "express";
import { supabase } from "../db.js";
import { inMemoryMetrics, type MetricRow } from "../store.js";

export const metricsRouter = Router();

interface MetricsBody {
  botId: number;
  equity: string | number;
  pnl?: string | number;
  realizedPnl?: string | number;
  unrealizedPnl?: string | number;
  volatility?: string | number;
  maxDrawdown?: string | number;
  utilization?: string | number;
  openPositions?: number;
  extra?: Record<string, unknown>;
}

const VALID_BOT_IDS = new Set([1, 2, 3, 4, 5, 6, 7]);

metricsRouter.post("/", async (req: Request, res: Response) => {
  const body = req.body as MetricsBody;

  const botId = Number(body.botId);
  if (!VALID_BOT_IDS.has(botId)) {
    res.status(400).json({ error: "botId must be 1, 2, 3, 4, 5, 6, or 7" });
    return;
  }

  const equity = parseFloat(String(body.equity));
  if (!isFinite(equity) || equity < 0) {
    res.status(400).json({ error: "equity must be a non-negative number" });
    return;
  }

  const row = {
    bot_id: botId,
    equity,
    pnl: parseFloat(String(body.pnl ?? "0")) || 0,
    realized_pnl: parseFloat(String(body.realizedPnl ?? "0")) || 0,
    unrealized_pnl: parseFloat(String(body.unrealizedPnl ?? "0")) || 0,
    volatility:
      body.volatility != null ? parseFloat(String(body.volatility)) : null,
    max_drawdown:
      body.maxDrawdown != null ? parseFloat(String(body.maxDrawdown)) : null,
    utilization:
      body.utilization != null ? parseFloat(String(body.utilization)) : null,
    open_positions: body.openPositions ?? 0,
    extra: body.extra ?? null,
    recorded_at: new Date().toISOString(),
  };

  // Always store in memory so portfolio summary can reflect latest state
  inMemoryMetrics.set(botId, row as MetricRow);

  // Also try Supabase (best-effort)
  try {
    const { error } = await supabase.from("metrics").insert(row);
    if (error) throw error;
  } catch (dbErr) {
    console.warn(
      "[metrics] DB unavailable, in-memory only:",
      (dbErr as Error).message,
    );
  }

  res.status(201).json({ ok: true });
});
