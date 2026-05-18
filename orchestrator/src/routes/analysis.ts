/**
 * analysis.ts — serves per-bot trade analysis markdown files and provides
 * a helper that auto-appends an AI-generated trade entry when a position closes.
 *
 * GET /analysis/:botId — returns the bot's analysis markdown as text/plain
 *
 * appendTradeAnalysis(row) — fire-and-forget; generates a markdown entry via
 *   Claude and appends it to bots_analysis/{slug}.md at the repo root.
 */

import { Router, type Request, type Response } from "express";
import { readFileSync, appendFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";

export const analysisRouter = Router();

// ── Bot metadata ──────────────────────────────────────────────────────────────

const BOT_META: Record<
  number,
  { name: string; strategy: string; slug: string }
> = {
  1: {
    name: "Market Maker",
    strategy:
      "Posts resting limit orders on both sides of the CLOB, earns bid-ask spread",
    slug: "1_market_maker",
  },
  2: {
    name: "Arb Bot",
    strategy:
      "Cross-platform arbitrage between Kalshi and Polymarket price divergence",
    slug: "2_arb_bot",
  },
  3: {
    name: "Copy Trader",
    strategy:
      "Mirrors high-performing Polymarket traders at a scaled position size",
    slug: "3_copy_trader",
  },
  4: {
    name: "In-Market Arb",
    strategy:
      "Buys YES+NO shares when combined ask < $1 (risk-free profit at resolution)",
    slug: "4_in_market_arb",
  },
  5: {
    name: "Resolution Lag",
    strategy:
      "Buys winning token at a discount during the oracle settlement delay (Gamma→CLOB lag)",
    slug: "5_resolution_lag",
  },
  6: {
    name: "Microstructure",
    strategy: "Posts resting bids at 0.1¢ across hundreds of illiquid markets",
    slug: "6_microstructure",
  },
  7: {
    name: "BTC Lag",
    strategy:
      "Exploits CEX candle lag signals on BTC to front-run Polymarket price adjustments",
    slug: "7_btc_lag",
  },
};

function botFilePath(botId: number): string | null {
  const meta = BOT_META[botId];
  if (!meta) return null;
  const __dirname = dirname(fileURLToPath(import.meta.url));
  return resolve(__dirname, "../../../bots_analysis", `${meta.slug}.md`);
}

// ── GET /analysis/:botId ──────────────────────────────────────────────────────

analysisRouter.get("/:botId", (req: Request, res: Response) => {
  const botId = Number(req.params["botId"]);
  if (!Number.isInteger(botId) || botId < 1 || botId > 7) {
    res.status(400).send("# Invalid bot ID");
    return;
  }

  const filePath = botFilePath(botId);
  if (!filePath || !existsSync(filePath)) {
    res
      .status(404)
      .send("# No analysis yet\nNo trades have been recorded for this bot.");
    return;
  }

  try {
    const content = readFileSync(filePath, "utf8");
    res.type("text/plain").send(content);
  } catch {
    res.status(500).send("# Error reading analysis file");
  }
});

// ── appendTradeAnalysis — fire-and-forget helper ──────────────────────────────

export interface TradeRow {
  bot_id: number;
  market_question: string;
  outcome?: string | null;
  shares: number;
  avg_price: number;
  settled_price: number;
  realized_pnl: number;
  opened_at?: string | null;
  closed_at: string;
  status?: string | null;
}

const anthropic = new Anthropic({
  apiKey: process.env["ANTHROPIC_API_KEY"],
});

async function generateAnalysisParagraph(
  row: TradeRow,
  meta: { name: string; strategy: string },
): Promise<string> {
  const won = row.realized_pnl > 0;
  const prompt =
    `You are analyzing a single closed trade by a Polymarket prediction-market trading bot.\n` +
    `Write ONE concise paragraph (3–5 sentences) covering:\n` +
    `1. Why the trade won or lost\n` +
    `2. Whether the bot's strategy was correctly applied\n` +
    `3. One concrete lesson for future trades\n\n` +
    `Bot: ${meta.name} — Strategy: ${meta.strategy}\n` +
    `Market: ${row.market_question}\n` +
    `Outcome token held: ${row.outcome ?? "unknown"} — Result: ${won ? "WON" : "LOST"}\n` +
    `Buy price: $${row.avg_price.toFixed(4)} → Settled: $${row.settled_price.toFixed(4)}\n` +
    `Shares: ${row.shares} | Realized P&L: ${won ? "+" : ""}$${row.realized_pnl.toFixed(2)}\n` +
    (row.opened_at
      ? `Opened: ${row.opened_at} | Closed: ${row.closed_at}\n`
      : `Closed: ${row.closed_at}\n`) +
    `\nWrite only the analysis paragraph — no headers, no lists, no markdown formatting inside the paragraph.`;

  const message = await anthropic.messages.create({
    model: "claude-3-5-haiku-20241022",
    max_tokens: 300,
    temperature: 0.3 as never,
    messages: [{ role: "user", content: prompt }],
  });

  const block = message.content[0];
  if (block?.type === "text") return block.text.trim();
  return fallbackParagraph(row);
}

function fallbackParagraph(row: TradeRow): string {
  const won = row.realized_pnl > 0;
  return (
    `This position ${won ? "closed profitably" : "closed at a loss"} with a realized P&L of ` +
    `${won ? "+" : ""}$${row.realized_pnl.toFixed(2)}. ` +
    `The bot held ${row.shares} ${row.outcome ?? ""} shares bought at $${row.avg_price.toFixed(4)}, ` +
    `which settled at $${row.settled_price.toFixed(4)}. ` +
    `Review the entry timing and market conditions to improve future entries.`
  );
}

export async function appendTradeAnalysis(row: TradeRow): Promise<void> {
  const meta = BOT_META[row.bot_id];
  if (!meta) return;

  const filePath = botFilePath(row.bot_id);
  if (!filePath) return;

  let paragraph: string;
  try {
    paragraph = await generateAnalysisParagraph(row, meta);
  } catch (e) {
    console.error("[analysis] Claude call failed, using fallback:", e);
    paragraph = fallbackParagraph(row);
  }

  const won = row.realized_pnl > 0;
  const pnlStr = `${won ? "+" : ""}$${row.realized_pnl.toFixed(2)}`;
  const entry =
    `\n---\n\n` +
    `## ${row.market_question}\n\n` +
    `**Closed**: ${row.closed_at}` +
    (row.opened_at ? ` | **Opened**: ${row.opened_at}` : "") +
    ` | **P&L**: ${pnlStr}\n` +
    `**Outcome**: ${row.outcome ?? "unknown"} (${won ? "WON" : "LOST"}) | ` +
    `**Buy price**: $${row.avg_price.toFixed(4)} → **Settled**: $${row.settled_price.toFixed(4)} | ` +
    `**Shares**: ${row.shares}\n\n` +
    `${paragraph}\n`;

  try {
    appendFileSync(filePath, entry, "utf8");
    console.log(`[analysis] appended trade entry for bot ${row.bot_id}`);
  } catch (e) {
    console.error("[analysis] failed to append to file:", e);
  }
}
