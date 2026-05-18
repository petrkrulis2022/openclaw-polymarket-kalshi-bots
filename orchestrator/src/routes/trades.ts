/**
 * trades.ts — persists and retrieves closed bot trades from Supabase.
 *
 * Required Supabase table (run once in Supabase SQL editor):
 *
 *   create table if not exists trades (
 *     id            bigserial primary key,
 *     bot_id        integer not null,
 *     market_id     text,
 *     market_question text not null,
 *     condition_id  text,
 *     token_id      text,
 *     outcome       text,
 *     shares        numeric not null,
 *     avg_price     numeric not null,
 *     settled_price numeric not null,
 *     realized_pnl  numeric not null,
 *     opened_at     timestamptz,
 *     closed_at     timestamptz not null default now(),
 *     status        text not null default 'closed'
 *   );
 *   create index on trades(bot_id);
 *   create index on trades(closed_at desc);
 */

import { Router, type Request, type Response } from "express";
import { supabase } from "../db.js";

export const tradesRouter = Router();

// ── POST /trades — bots record a closed position ─────────────────────────────
tradesRouter.post("/", async (req: Request, res: Response) => {
  const {
    botId,
    marketId,
    marketQuestion,
    conditionId,
    tokenId,
    outcome,
    shares,
    avgPrice,
    settledPrice,
    realizedPnl,
    openedAt,
    closedAt,
    status,
  } = req.body as {
    botId?: unknown;
    marketId?: unknown;
    marketQuestion?: unknown;
    conditionId?: unknown;
    tokenId?: unknown;
    outcome?: unknown;
    shares?: unknown;
    avgPrice?: unknown;
    settledPrice?: unknown;
    realizedPnl?: unknown;
    openedAt?: unknown;
    closedAt?: unknown;
    status?: unknown;
  };

  if (
    typeof botId !== "number" ||
    typeof marketQuestion !== "string" ||
    typeof shares !== "number" ||
    typeof avgPrice !== "number" ||
    typeof settledPrice !== "number" ||
    typeof realizedPnl !== "number"
  ) {
    res.status(400).json({
      error:
        "Required: botId (number), marketQuestion (string), shares, avgPrice, settledPrice, realizedPnl (numbers)",
    });
    return;
  }

  const row = {
    bot_id: botId,
    market_id: typeof marketId === "string" ? marketId : null,
    market_question: marketQuestion,
    condition_id: typeof conditionId === "string" ? conditionId : null,
    token_id: typeof tokenId === "string" ? tokenId : null,
    outcome: typeof outcome === "string" ? outcome : null,
    shares,
    avg_price: avgPrice,
    settled_price: settledPrice,
    realized_pnl: realizedPnl,
    opened_at: typeof openedAt === "string" ? openedAt : null,
    closed_at:
      typeof closedAt === "string" ? closedAt : new Date().toISOString(),
    status: typeof status === "string" ? status : "closed",
  };

  const { data, error } = await supabase
    .from("trades")
    .insert(row)
    .select("id")
    .single();

  if (error) {
    console.error("[trades] insert error:", error.message);
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ id: (data as { id: number }).id });
});

// ── GET /trades?botId=n&limit=100 — fetch closed trades per bot (or all) ─────
tradesRouter.get("/", async (req: Request, res: Response) => {
  const botId = req.query["botId"] ? Number(req.query["botId"]) : null;
  const limit = Math.min(Number(req.query["limit"] ?? 200), 500);

  let query = supabase
    .from("trades")
    .select("*")
    .order("closed_at", { ascending: false })
    .limit(limit);

  if (botId !== null && !Number.isNaN(botId)) {
    query = query.eq("bot_id", botId);
  }

  const { data, error } = await query;

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ trades: data ?? [] });
});

// ── GET /trades/summary — aggregate PnL, win rate across all bots ─────────────
tradesRouter.get("/summary", async (_req: Request, res: Response) => {
  const { data, error } = await supabase
    .from("trades")
    .select("bot_id, realized_pnl, shares, avg_price, status");

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  const rows = (data ?? []) as {
    bot_id: number;
    realized_pnl: number;
    shares: number;
    avg_price: number;
    status: string;
  }[];

  const totalPnl = rows.reduce((s, r) => s + Number(r.realized_pnl), 0);
  const totalInvested = rows.reduce(
    (s, r) => s + Number(r.shares) * Number(r.avg_price),
    0,
  );
  const winners = rows.filter((r) => Number(r.realized_pnl) > 0).length;
  const winRate = rows.length > 0 ? winners / rows.length : 0;

  // Per-bot breakdown
  const byBot: Record<
    number,
    { totalPnl: number; trades: number; winners: number }
  > = {};
  for (const r of rows) {
    const b = byBot[r.bot_id] ?? { totalPnl: 0, trades: 0, winners: 0 };
    b.totalPnl += Number(r.realized_pnl);
    b.trades++;
    if (Number(r.realized_pnl) > 0) b.winners++;
    byBot[r.bot_id] = b;
  }

  res.json({
    totalTrades: rows.length,
    totalPnl,
    totalInvested,
    winRate,
    byBot,
  });
});
