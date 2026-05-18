/**
 * analysis.ts — loads this bot's own trade analysis from the orchestrator.
 *
 * Bot 4 (In-Market Arb) can only access its own analysis file.
 * Cached in memory, refreshed every hour so the bot always has
 * up-to-date context without hitting the filesystem on every decision.
 */

import { config } from "./config.js";

let cachedAnalysis = "";
const REFRESH_MS = 60 * 60 * 1_000; // 1 hour

export async function loadAnalysis(): Promise<void> {
  try {
    const res = await fetch(
      `${config.orchestratorUrl}/analysis/${config.botId}`,
      { signal: AbortSignal.timeout(5_000) },
    );
    const text = await res.text();
    cachedAnalysis = text;
    const lines = text.split("\n").length;
    console.log(
      `[analysis] Loaded own analysis (bot ${config.botId}, ${lines} lines)`,
    );
  } catch (err) {
    console.warn("[analysis] Could not load analysis:", (err as Error).message);
  }
}

/**
 * Returns the tail of the analysis file (last maxChars characters).
 * Use this when passing context to Claude or logging decision rationale.
 */
export function getAnalysisContext(maxChars = 3_000): string {
  if (!cachedAnalysis) return "";
  return cachedAnalysis.length > maxChars
    ? cachedAnalysis.slice(cachedAnalysis.length - maxChars)
    : cachedAnalysis;
}

/** Call once at startup — sets up hourly self-rescheduling refresh. */
export function scheduleAnalysisRefresh(): void {
  setTimeout(async () => {
    await loadAnalysis().catch(() => {});
    scheduleAnalysisRefresh();
  }, REFRESH_MS);
}
