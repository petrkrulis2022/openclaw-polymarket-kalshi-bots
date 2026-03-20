import { Router, Request, Response } from "express";
import { supabase } from "../db.js";

export const metricsRouter = Router();

interface MetricsBody {
  botId: number;
  equity: string;
  pnl?: string;
  realizedPnl?: string;
  unrealizedPnl?: string;
  volatility?: string;
  maxDrawdown?: string;
  utilization?: string;
  openPositions?: number;
  extra?: Record<string, unknown>;
}

const VALID_BOT_IDS = new Set([1, 2, 3]);

metricsRouter.post("/", async (req: Request, res: Response) => {
  const body = req.body as MetricsBody;

  const botId = Number(body.botId);
  if (!VALID_BOT_IDS.has(botId)) {
    res.status(400).json({ error: "botId must be 1, 2, or 3" });
    return;
  }

  const equity = parseFloat(body.equity);
  if (!isFinite(equity) || equity < 0) {
    res.status(400).json({ error: "equity must be a non-negative number" });
    return;
  }

  const row = {
    bot_id: botId,
    equity,
    pnl: parseFloat(body.pnl ?? "0") || 0,
    realized_pnl: parseFloat(body.realizedPnl ?? "0") || 0,
    unrealized_pnl: parseFloat(body.unrealizedPnl ?? "0") || 0,
    volatility: body.volatility != null ? parseFloat(body.volatility) : null,
    max_drawdown:
      body.maxDrawdown != null ? parseFloat(body.maxDrawdown) : null,
    utilization: body.utilization != null ? parseFloat(body.utilization) : null,
    open_positions: body.openPositions ?? 0,
    extra: body.extra ?? null,
  };

  const { error } = await supabase.from("metrics").insert(row);
  if (error) {
    console.error("metrics insert error", error);
    res.status(500).json({ error: "Failed to save metrics" });
    return;
  }

  res.status(201).json({ ok: true });
});
