/**
 * measurement.ts — per-fill reporting to the orchestrator's existing /fills sink
 * (orchestrator/data/fills.jsonl). Phase 2 of the venue port: measurement is
 * wired for the new venue before more strategies land.
 */
import { config } from "./config.js";

export interface FillReport {
  side: "BUY" | "SELL";
  tokenId: string; // venue ref (Limitless "slug:yes"/"slug:no", etc.)
  signalPrice: number;
  fillPrice: number;
  fillShares: number;
  fillUsdc: number;
  fillStatus: "filled" | "partial" | "failed";
  meta?: Record<string, unknown>;
}

/** Fire-and-forget POST to the single fills sink, tagged with venue + botId. */
export function reportFill(f: FillReport): void {
  fetch(`${config.orchestratorUrl}/fills`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ts: new Date().toISOString(),
      botId: `in-market-arb-${config.venue}`,
      venue: config.venue,
      side: f.side,
      tokenId: f.tokenId,
      signalPrice: f.signalPrice,
      fillPrice: f.fillPrice,
      fillShares: f.fillShares,
      fillUsdc: f.fillUsdc,
      fillStatus: f.fillStatus,
      meta: f.meta ?? {},
    }),
    signal: AbortSignal.timeout(3_000),
  }).catch(() => {
    /* measurement is best-effort */
  });
}
