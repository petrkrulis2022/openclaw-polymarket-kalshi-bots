/**
 * POST /chat
 *
 * Streams a Claude response with live portfolio context injected into the
 * system prompt. The client sends its conversation history; this endpoint
 * fetches fresh data from /portfolio/agent-context, prepends a system prompt,
 * then forwards to Claude claude-3-5-haiku-20241022 with streaming.
 *
 * Body:
 *   {
 *     botId: number,          // which bot's section the user is chatting in
 *     messages: [             // full conversation history (user + assistant turns)
 *       { role: "user"|"assistant", content: string }
 *     ]
 *   }
 *
 * Response: text/event-stream  (SSE)
 *   data: {"delta": "..."}    — partial text chunk
 *   data: [DONE]              — stream complete
 */

import { Router, Request, Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { supabase, WDK_TREASURY_URL } from "../db.js";
import { inMemoryMetrics } from "../store.js";

export const chatRouter = Router();

const client = new Anthropic({
  apiKey: process.env["ANTHROPIC_API_KEY"],
});

// ── Fetch fresh portfolio snapshot ────────────────────────────────────────────

async function fetchPortfolioContext(): Promise<string> {
  try {
    // Latest metrics per bot
    const { data: metricsData } = await supabase
      .from("metrics")
      .select(
        "bot_id, equity, pnl, realized_pnl, unrealized_pnl, volatility, max_drawdown, utilization, open_positions, recorded_at",
      )
      .order("recorded_at", { ascending: false });

    const seen = new Set<number>();
    const latestRows: typeof metricsData = [];
    for (const row of metricsData ?? []) {
      if (!seen.has(row.bot_id)) {
        seen.add(row.bot_id);
        latestRows.push(row);
      }
    }

    // Merge in-memory metrics for freshness
    const rows = [...latestRows];
    for (const [, mem] of inMemoryMetrics) {
      const idx = rows.findIndex((r) => r.bot_id === mem.bot_id);
      if (idx === -1) rows.push(mem);
      else rows[idx] = mem;
    }

    // Treasury wallets
    const walletsRes = await fetch(`${WDK_TREASURY_URL}/wallets`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);

    const totalEquity = rows.reduce((s, r) => s + Number(r.equity), 0);
    const totalPnl = rows.reduce((s, r) => s + Number(r.pnl ?? 0), 0);

    const BOT_NAMES: Record<number, string> = {
      1: "Market Maker (Bot 1)",
      2: "Cross-Platform Arb (Bot 2)",
      3: "Copy Trader (Bot 3)",
      4: "In-Market Arb (Bot 4)",
      5: "Resolution Lag Buyer (Bot 5)",
      6: "Microstructure MM (Bot 6)",
      7: "BTC Lag (Bot 7)",
    };

    const botLines = rows.map((r) => {
      const name = BOT_NAMES[r.bot_id] ?? `Bot ${r.bot_id}`;
      return (
        `  ${name}: equity=$${Number(r.equity).toFixed(2)}, pnl=$${Number(r.pnl ?? 0).toFixed(2)}` +
        ` (realized=$${Number(r.realized_pnl ?? 0).toFixed(2)}, unrealized=$${Number(r.unrealized_pnl ?? 0).toFixed(2)})` +
        `, open_positions=${r.open_positions ?? 0}` +
        (r.utilization != null
          ? `, utilization=${(Number(r.utilization) * 100).toFixed(1)}%`
          : "") +
        (r.max_drawdown != null
          ? `, max_drawdown=$${Number(r.max_drawdown).toFixed(2)}`
          : "") +
        (r.recorded_at ? `, last_update=${r.recorded_at}` : "")
      );
    });

    let treasuryLine = "";
    if (walletsRes?.treasury) {
      treasuryLine = `\nTreasury: address=${walletsRes.treasury.address}, balance=${walletsRes.treasury.usdTBalance} USDT`;
    }

    return (
      `PORTFOLIO SNAPSHOT (as of ${new Date().toISOString()}):\n` +
      `Total equity across all bots: $${totalEquity.toFixed(2)}\n` +
      `Total PnL: $${totalPnl.toFixed(2)}\n` +
      `${treasuryLine}\n` +
      `Bot breakdown:\n${botLines.join("\n")}`
    );
  } catch {
    return "Portfolio data temporarily unavailable.";
  }
}

// ── System prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt(portfolioContext: string, botId: number): string {
  const BOT_NAMES: Record<number, string> = {
    1: "Market Maker",
    2: "Cross-Platform Arb",
    3: "Copy Trader",
    4: "In-Market Arb",
    5: "Resolution Lag Buyer",
    6: "Microstructure MM",
    7: "BTC Lag",
  };
  const botName = BOT_NAMES[botId] ?? `Bot ${botId}`;

  return `You are OpenClaw, an AI trading agent embedded in the OpenClaw multi-bot Polymarket trading system. You are currently in the ${botName} (Bot ${botId}) panel.

You have access to live portfolio data shown below. Use it to answer questions about performance, PnL, positions, risk, and strategy. Be concise, analytical, and direct — you are talking to the operator, not a novice.

You can also help configure bot parameters when asked (e.g. spread, number of markets, volume threshold). For config changes, explain what you recommend and why, but note the user will apply changes using the quick commands (e.g. "set spread to 3 cents").

${portfolioContext}

TRADING STRATEGIES IN USE:
- Bot 1 (Market Maker): Posts resting limit orders on both sides of the book on Polymarket CLOB, earns bid-ask spread.
- Bot 2 (Cross-Platform Arb): Kalshi ↔ Polymarket price divergence arb (designed, not yet live).
- Bot 3 (Copy Trader): Mirrors high-performing Polymarket traders at a scaled size.
- Bot 4 (In-Market Arb): Buys YES+NO when their combined ask < $1 (guaranteed profit).
- Bot 5 (Resolution Lag): Buys winning shares at a discount during oracle settlement delay.
- Bot 6 (Microstructure MM): Posts resting bids at 0.1¢ across hundreds of illiquid markets.
- Bot 7 (BTC Lag): CEX candle lag arb (stub, not yet live).

INFRASTRUCTURE:
- All bots run on Polygon, collateral is USDC.e for Polymarket.
- Treasury holds USDT (WDK HD wallet), bot EOAs hold USDC.e for Polymarket trading.
- Orchestrator aggregates metrics and routes capital.
- Ylop integration planned: borrow against locked YES+NO positions.

Answer in plain text (no markdown headers). Keep responses focused. If you don't have enough data to answer, say so clearly.`;
}

// ── Route ─────────────────────────────────────────────────────────────────────

chatRouter.post("/", async (req: Request, res: Response) => {
  const { botId, messages } = req.body as {
    botId: number;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
  };

  // Validate
  if (
    !Array.isArray(messages) ||
    messages.length === 0 ||
    !messages.every(
      (m) =>
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string",
    )
  ) {
    res
      .status(400)
      .json({ error: "messages must be a non-empty array of {role, content}" });
    return;
  }

  if (!process.env["ANTHROPIC_API_KEY"]) {
    res.status(503).json({ error: "ANTHROPIC_API_KEY not configured" });
    return;
  }

  // Fetch live context
  const portfolioContext = await fetchPortfolioContext();
  const systemPrompt = buildSystemPrompt(portfolioContext, Number(botId) || 1);

  // Set up SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  try {
    const stream = await client.messages.stream({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    });

    for await (const chunk of stream) {
      if (
        chunk.type === "content_block_delta" &&
        chunk.delta.type === "text_delta"
      ) {
        res.write(`data: ${JSON.stringify({ delta: chunk.delta.text })}\n\n`);
      }
    }

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    console.error("[chat] Claude API error:", err);
    res.write(
      `data: ${JSON.stringify({ error: "Claude API error. Check ANTHROPIC_API_KEY." })}\n\n`,
    );
    res.end();
  }
});
