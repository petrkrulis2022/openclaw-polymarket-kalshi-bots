import { Router, Request, Response } from "express";
import { supabase, WDK_TREASURY_URL } from "../db.js";
import { inMemoryMetrics } from "../store.js";

export const portfolioRouter = Router();

type BotDef = {
  id: number;
  name: string;
  strategy?: string;
  description?: string;
};

const DEFAULT_BOTS: BotDef[] = [
  { id: 1, name: "Market Maker", strategy: "Liquidity Provision" },
  { id: 2, name: "Kalshi Arb", strategy: "Kalshi ↔ Polymarket Arb" },
  { id: 3, name: "Copy Trader", strategy: "Trader Mirroring" },
  { id: 4, name: "In-Market Arb", strategy: "YES+NO Arb" },
  { id: 5, name: "Resolution Lag", strategy: "Oracle Delay" },
  { id: 6, name: "Microstructure", strategy: "Low-Price MM" },
  { id: 7, name: "BTC Lag", strategy: "CEX Candle Lag" },
  {
    id: 8,
    name: "Football Bot",
    strategy: "Goalserve Football Data-Lag Arb",
  },
  {
    id: 10,
    name: "Hockey Bot",
    strategy: "Goalserve Hockey Data-Lag Arb",
  },
];

function mergeBotsWithDefaults(dbBots: BotDef[]): BotDef[] {
  const byId = new Map<number, BotDef>();
  for (const bot of DEFAULT_BOTS) byId.set(bot.id, bot);
  for (const bot of dbBots) {
    // Keep canonical names/strategies for known bot ids; only include unknown ids from DB.
    if (!byId.has(bot.id)) byId.set(bot.id, bot);
  }
  return Array.from(byId.values()).sort((a, b) => a.id - b.id);
}

// 30-second cache to avoid hammering Supabase on every portfolio request
let metricsCache: { rows: Awaited<ReturnType<typeof fetchLatestMetrics>>; ts: number } | null = null;
const METRICS_CACHE_TTL_MS = 30_000;

async function fetchLatestMetrics() {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("metrics")
    .select(
      "bot_id, equity, pnl, realized_pnl, unrealized_pnl, volatility, max_drawdown, utilization, open_positions, recorded_at",
    )
    .gte("recorded_at", oneDayAgo)
    .order("recorded_at", { ascending: false })
    .limit(1000);

  if (error) throw error;

  // Keep only the most recent row per bot
  const seen = new Set<number>();
  const latest: typeof data = [];
  for (const row of data ?? []) {
    if (!seen.has(row.bot_id)) {
      seen.add(row.bot_id);
      latest.push(row);
    }
  }
  return latest;
}

async function latestMetrics() {
  if (metricsCache && Date.now() - metricsCache.ts < METRICS_CACHE_TTL_MS) {
    return metricsCache.rows;
  }
  const rows = await fetchLatestMetrics();
  metricsCache = { rows, ts: Date.now() };
  return rows;
}

// GET /portfolio/summary
portfolioRouter.get("/summary", async (_req: Request, res: Response) => {
  try {
    let rows: Awaited<ReturnType<typeof latestMetrics>> = [];
    let bots: BotDef[] = [];

    try {
      rows = await latestMetrics();
      const { data } = await supabase
        .from("bots")
        .select("id, name, strategy")
        .order("id");
      bots = data ?? [];
    } catch (dbErr) {
      console.warn(
        "portfolio/summary: DB unavailable, using in-memory metrics",
        (dbErr as Error).message,
      );
    }

    // Merge in-memory metrics for any bots not covered by DB rows
    if (inMemoryMetrics.size > 0) {
      for (const [, mem] of inMemoryMetrics) {
        const alreadyHave = rows.some((r) => r.bot_id === mem.bot_id);
        if (!alreadyHave) rows.push(mem);
        else {
          // Replace with fresher in-memory data
          const idx = rows.findIndex((r) => r.bot_id === mem.bot_id);
          if (idx !== -1) rows[idx] = mem;
        }
      }
    }

    bots = mergeBotsWithDefaults(bots);

    const totalEquity = rows.reduce((s, r) => s + Number(r.equity), 0);
    const totalPnl = rows.reduce((s, r) => s + Number(r.pnl ?? 0), 0);

    const botSummaries = bots.map((b) => {
      const m = rows.find((r) => r.bot_id === b.id);
      const equity = m ? Number(m.equity) : 0;
      return {
        id: b.id,
        name: b.name,
        strategy: b.strategy ?? "",
        equity: equity.toFixed(6),
        allocationPct:
          totalEquity > 0 ? ((equity / totalEquity) * 100).toFixed(2) : "0.00",
        pnl: m ? Number(m.pnl).toFixed(6) : "0.000000",
        utilization:
          m?.utilization != null ? Number(m.utilization).toFixed(4) : null,
        openPositions: m?.open_positions ?? 0,
        updatedAt: m?.recorded_at ?? null,
      };
    });

    res.json({
      totalEquity: totalEquity.toFixed(6),
      totalPnl: totalPnl.toFixed(6),
      bots: botSummaries,
    });
  } catch (err) {
    console.error("portfolio/summary error", err);
    res.status(500).json({ error: "Failed to fetch portfolio summary" });
  }
});

// GET /portfolio/bot/:id
portfolioRouter.get("/bot/:id", async (req: Request, res: Response) => {
  const botId = parseInt(req.params["id"] ?? "", 10);
  if (![1, 2, 3, 4, 5, 6, 7, 8, 10].includes(botId)) {
    res.status(400).json({ error: "botId must be one of 1,2,3,4,5,6,7,8,10" });
    return;
  }

  const limit = Math.min(
    parseInt((req.query["limit"] as string) ?? "100", 10),
    1000,
  );

  const { data, error } = await supabase
    .from("metrics")
    .select(
      "recorded_at, equity, pnl, realized_pnl, unrealized_pnl, volatility, max_drawdown, utilization, open_positions",
    )
    .eq("bot_id", botId)
    .order("recorded_at", { ascending: false })
    .limit(limit);

  if (error) {
    res.status(500).json({ error: "Failed to fetch bot metrics" });
    return;
  }

  res.json({ botId, series: (data ?? []).reverse() });
});

// GET /portfolio/agent-context
portfolioRouter.get("/agent-context", async (_req: Request, res: Response) => {
  try {
    const [rows, botsResult, walletsRes] = await Promise.all([
      latestMetrics(),
      supabase.from("bots").select("id, name, description").order("id"),
      fetch(`${WDK_TREASURY_URL}/wallets`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ]);

    const bots = mergeBotsWithDefaults((botsResult.data ?? []) as BotDef[]);
    const wallets: Array<{
      name: string;
      address: string;
      balanceUsdT: string;
    }> = walletsRes?.wallets ?? [];

    const totalEquity = rows.reduce((s, r) => s + Number(r.equity), 0);

    const botContext = bots.map((b) => {
      const m = rows.find((r) => r.bot_id === b.id);
      const w = wallets.find((wl) => wl.name === `bot${b.id}`);
      const equity = m ? Number(m.equity) : 0;
      return {
        id: b.id,
        name: b.name,
        description: b.description,
        equity: equity.toFixed(6),
        allocationPct:
          totalEquity > 0 ? ((equity / totalEquity) * 100).toFixed(2) : "0.00",
        pnl: m ? Number(m.pnl).toFixed(6) : "0.000000",
        realizedPnl: m ? Number(m.realized_pnl).toFixed(6) : "0.000000",
        unrealizedPnl: m ? Number(m.unrealized_pnl).toFixed(6) : "0.000000",
        volatility:
          m?.volatility != null ? Number(m.volatility).toFixed(6) : null,
        maxDrawdown:
          m?.max_drawdown != null ? Number(m.max_drawdown).toFixed(6) : null,
        utilization:
          m?.utilization != null ? Number(m.utilization).toFixed(4) : null,
        openPositions: m?.open_positions ?? 0,
        walletAddress: w?.address ?? null,
        walletBalanceUsdT: w?.balanceUsdT ?? null,
        metricsUpdatedAt: m?.recorded_at ?? null,
      };
    });

    const treasury = wallets.find((w) => w.name === "treasury");

    res.json({
      timestamp: new Date().toISOString(),
      treasury: {
        address: treasury?.address ?? null,
        balanceUsdT: treasury?.balanceUsdT ?? null,
      },
      totalBotEquity: totalEquity.toFixed(6),
      bots: botContext,
      wdkTreasuryAvailable: walletsRes !== null,
    });
  } catch (err) {
    console.error("portfolio/agent-context error", err);
    res.status(500).json({ error: "Failed to fetch agent context" });
  }
});
