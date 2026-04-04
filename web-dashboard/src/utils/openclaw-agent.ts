/**
 * OpenClaw Agent — client-side natural language parser for bot configuration.
 *
 * Converts plain-English user messages into config patches or answers.
 * No API key or backend required: all processing happens in the browser.
 */
import type { QuotingParams } from "../hooks/use-bot-config";

export interface AgentResponse {
  reply: string;
  patch?: Partial<QuotingParams>;
  action?: "reset";
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractNumber(text: string): number | null {
  const m = text.match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

function fmtSpread(v: number) {
  return `${(v * 100).toFixed(1)}¢`;
}

function summariseConfig(p: QuotingParams): string {
  return [
    `📐 Spread: ±${fmtSpread(p.quoteHalfWidth)} per side (${fmtSpread(p.quoteHalfWidth * 2)} total)`,
    `📊 Markets: ${p.numMarkets} simultaneously`,
    `💧 Min 24h volume: $${p.minVolume24h.toLocaleString()}`,
    `⏱ Quote cycle: every ${(p.pollIntervalMs / 1000).toFixed(0)}s`,
    `⚖ Skew limit: ${(p.maxInventorySkew * 100).toFixed(0)}% one-sided inventory`,
    `🔁 Re-quote threshold: ${(p.reQuoteThreshold * 100).toFixed(2)}% mid movement`,
    `🗑 Stale order threshold: ${(p.orderStalenessThreshold * 100).toFixed(2)}% off market`,
    `💰 Paper equity: $${p.paperEquity.toFixed(2)}`,
    `✖ Width multiplier: ${p.widthMultiplier.toFixed(2)}x`,
  ].join("\n");
}

const HELP = `I can configure the market maker in plain English. Examples:

• **"set spread to 4 cents"** — quote half-width per side
• **"quote 3 markets"** — number of simultaneous markets
• **"min volume 5000"** — 24h volume floor for market selection
• **"requote every 10 seconds"** — quoting cycle frequency
• **"skew limit 70%"** — inventory imbalance tolerance
• **"re-quote threshold 1%"** — mid movement that triggers refresh
• **"make it aggressive"** — preset: tight spread, more markets
• **"make it conservative"** — preset: wide spread, fewer markets
• **"show settings"** — display all current parameters
• **"reset"** — revert everything to startup defaults`;

// ── Main parser ───────────────────────────────────────────────────────────────

export function processAgentMessage(
  raw: string,
  current: QuotingParams,
): AgentResponse {
  const msg = raw.toLowerCase().trim();

  // ── Reset ──────────────────────────────────────────────────────────────────
  if (/\breset\b/.test(msg)) {
    return {
      reply: "↩ Resetting all parameters to their startup defaults.",
      action: "reset",
    };
  }

  // ── Help ───────────────────────────────────────────────────────────────────
  if (/\b(help|what can you|how do i|commands?)\b/.test(msg)) {
    return { reply: HELP };
  }

  // ── Show current settings ──────────────────────────────────────────────────
  if (
    /\b(show|current|what are|list|display|get|status)\b/.test(msg) &&
    /\b(setting|config|param|spread|market|volume|interval|skew|equity)\b/.test(
      msg,
    )
  ) {
    return { reply: "**Current settings:**\n" + summariseConfig(current) };
  }

  // ── Presets ────────────────────────────────────────────────────────────────
  if (/\baggressive\b/.test(msg)) {
    return {
      reply:
        "⚡ Aggressive mode: tighter spread (1.5¢), 8 markets, lower volume floor ($500). Higher fill rate but more directional risk.",
      patch: { quoteHalfWidth: 0.015, numMarkets: 8, minVolume24h: 500 },
    };
  }

  if (/\bconservative\b/.test(msg)) {
    return {
      reply:
        "🛡 Conservative mode: wider spread (5¢), 3 markets, higher volume floor ($5,000). Fewer fills but each one earns more.",
      patch: { quoteHalfWidth: 0.05, numMarkets: 3, minVolume24h: 5_000 },
    };
  }

  if (/\bbalanced\b/.test(msg) || /\bdefault\b/.test(msg)) {
    return {
      reply:
        "⚖ Balanced mode: 3¢ spread, 5 markets, $1,000 volume floor — the original defaults.",
      patch: {
        quoteHalfWidth: 0.03,
        numMarkets: 5,
        minVolume24h: 1_000,
        pollIntervalMs: 5_000,
        maxInventorySkew: 0.6,
        reQuoteThreshold: 0.005,
      },
    };
  }

  // ── Spread / quoteHalfWidth ────────────────────────────────────────────────
  if (/\b(spread|half.?width|quote width|width)\b/.test(msg)) {
    const num = extractNumber(msg);
    if (num !== null) {
      let hw: number;
      if (/cent|¢/.test(msg)) hw = num / 100;
      else if (/%/.test(msg)) hw = num / 100;
      else hw = num <= 0.5 ? num : num / 100; // >0.5 assumed to be cents
      hw = Math.max(0.001, Math.min(0.49, hw));
      return {
        reply: `📐 Spread set to ±${fmtSpread(hw)} per side (${fmtSpread(hw * 2)} total). Each filled round-trip earns ${fmtSpread(hw * 2)} per share.`,
        patch: { quoteHalfWidth: hw },
      };
    }
    if (/\b(wider|bigger|increase|raise|more)\b/.test(msg)) {
      const hw = Math.min(0.49, current.quoteHalfWidth * 1.5);
      return {
        reply: `📐 Spread widened: ${fmtSpread(current.quoteHalfWidth)} → ${fmtSpread(hw)} per side.`,
        patch: { quoteHalfWidth: hw },
      };
    }
    if (/\b(tighter|narrower|smaller|decrease|reduce|less)\b/.test(msg)) {
      const hw = Math.max(0.001, current.quoteHalfWidth * 0.67);
      return {
        reply: `📐 Spread tightened: ${fmtSpread(current.quoteHalfWidth)} → ${fmtSpread(hw)} per side.`,
        patch: { quoteHalfWidth: hw },
      };
    }
    return {
      reply: `Current spread: ±${fmtSpread(current.quoteHalfWidth)} per side. Say "set spread to 4 cents" to change it.`,
    };
  }

  // ── Number of markets ──────────────────────────────────────────────────────
  if (/\b(market|num market|number of market|how many market)\b/.test(msg)) {
    const num = extractNumber(msg);
    if (num !== null) {
      const n = Math.max(1, Math.min(20, Math.round(num)));
      const eq = current.paperEquity;
      return {
        reply: `📊 Quoting ${n} market${n === 1 ? "" : "s"} simultaneously — $${(eq / n).toFixed(2)} allocated per market.`,
        patch: { numMarkets: n },
      };
    }
    return {
      reply: `Currently quoting ${current.numMarkets} markets. Say "quote 3 markets" to change.`,
    };
  }

  // ── Min volume ─────────────────────────────────────────────────────────────
  if (/\b(volume|vol|min vol|minimum vol)\b/.test(msg)) {
    const num = extractNumber(msg);
    if (num !== null) {
      return {
        reply: `💧 Min 24h volume set to $${num.toLocaleString()}. Markets below this threshold will be skipped.`,
        patch: { minVolume24h: num },
      };
    }
    return {
      reply: `Min 24h volume: $${current.minVolume24h.toLocaleString()}. Say "min volume 5000" to change.`,
    };
  }

  // ── Poll / quoting interval ────────────────────────────────────────────────
  if (
    /\b(poll|cycle|interval|frequency|every|requote every|quote every)\b/.test(
      msg,
    )
  ) {
    const num = extractNumber(msg);
    if (num !== null) {
      let ms: number;
      if (/\b(second|sec|s)\b/.test(msg)) ms = num * 1_000;
      else if (/\b(minute|min)\b/.test(msg)) ms = num * 60_000;
      else ms = num; // assume milliseconds
      ms = Math.max(1_000, Math.min(300_000, ms));
      return {
        reply: `⏱ Quoting cycle set to every ${(ms / 1_000).toFixed(0)}s. Takes effect on the next tick.`,
        patch: { pollIntervalMs: ms },
      };
    }
    return {
      reply: `Quoting cycle: every ${(current.pollIntervalMs / 1_000).toFixed(0)}s.`,
    };
  }

  // ── Inventory skew ─────────────────────────────────────────────────────────
  if (/\b(skew|inventory|imbalance|one.?side)\b/.test(msg)) {
    const num = extractNumber(msg);
    if (num !== null) {
      let skew = num > 1 ? num / 100 : num; // 70 → 0.70
      skew = Math.max(0.5, Math.min(0.99, skew));
      return {
        reply: `⚖ Inventory skew limit: ${(skew * 100).toFixed(0)}%. The bot will reduce bid size when YES exposure exceeds this.`,
        patch: { maxInventorySkew: skew },
      };
    }
    return {
      reply: `Skew limit: ${(current.maxInventorySkew * 100).toFixed(0)}%. Say "skew limit 70%" to change.`,
    };
  }

  // ── Re-quote threshold ─────────────────────────────────────────────────────
  if (/\b(re.?quote threshold|drift threshold|move threshold)\b/.test(msg)) {
    const num = extractNumber(msg);
    if (num !== null) {
      let t = num > 0.1 ? num / 100 : num;
      t = Math.max(0.001, Math.min(0.1, t));
      return {
        reply: `🔁 Re-quote threshold: ${(t * 100).toFixed(2)}% mid movement.`,
        patch: { reQuoteThreshold: t },
      };
    }
    return {
      reply: `Re-quote threshold: ${(current.reQuoteThreshold * 100).toFixed(2)}% mid movement.`,
    };
  }

  // ── Paper equity ───────────────────────────────────────────────────────────
  if (/\b(equity|paper equity|capital|budget)\b/.test(msg)) {
    const num = extractNumber(msg);
    if (num !== null) {
      return {
        reply: `💰 Paper equity set to $${num.toFixed(2)}. Allocates $${(num / current.numMarkets).toFixed(2)} per market.`,
        patch: { paperEquity: num },
      };
    }
    return {
      reply: `Paper equity: $${current.paperEquity.toFixed(2)} ($${(current.paperEquity / current.numMarkets).toFixed(2)} per market).`,
    };
  }

  // ── Fallthrough ────────────────────────────────────────────────────────────
  return {
    reply: `I'm not sure how to help with that. Type **"help"** to see what I can do, or **"show settings"** to see current parameters.`,
  };
}
