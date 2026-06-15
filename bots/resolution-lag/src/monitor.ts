/**
 * monitor.ts — polls Gamma API for recently closed markets and maps the
 * winner to a concrete tokenId. Gamma is treated as candidate discovery,
 * not as the final source of truth.
 */

import { config } from "./config.js";

const GAMMA_API = "https://gamma-api.polymarket.com/markets";

export interface ClosedMarket {
  id: string;
  conditionId: string;
  question: string;
  /** Winner label reported by Gamma (for diagnostics). */
  gammaOutcome: string;
  gammaResolved: boolean;
  clobResolved: boolean;
  winnerTokenId: string;
  endDate: string;
}

interface GammaMarket {
  id: string;
  conditionId?: string;
  condition_id?: string;
  question: string;
  closed: boolean;
  active: boolean;
  // Legacy Gamma fields (older API shape); kept for backward-compat.
  resolved?: boolean;
  winner?: string;
  tokens?: Array<{ token_id: string; outcome: string }>;
  end_date_iso?: string;
  // Current Gamma fields. Resolution is reported via umaResolutionStatus and
  // the winner is the outcome whose price settled to 1. outcomes / outcomePrices
  // / clobTokenIds are JSON-encoded string arrays.
  umaResolutionStatus?: string;
  endDate?: string;
  outcomes?: string;
  outcomePrices?: string;
  clobTokenIds?: string;
}

function isResolved(m: GammaMarket): boolean {
  if (typeof m.resolved === "boolean") return m.resolved; // legacy
  return (m.umaResolutionStatus ?? "").toLowerCase() === "resolved";
}

/** Resolve the winning outcome to a concrete tokenId across both Gamma shapes. */
function deriveWinner(
  m: GammaMarket,
): { label: string; tokenId: string } | null {
  // Current shape: parallel JSON arrays, winner = outcome priced at ~1.
  if (m.outcomePrices && m.outcomes && m.clobTokenIds) {
    try {
      const prices = (JSON.parse(m.outcomePrices) as string[]).map(parseFloat);
      const outcomes = JSON.parse(m.outcomes) as string[];
      const tokenIds = JSON.parse(m.clobTokenIds) as string[];
      const winners = prices.filter((p) => p >= 0.999).length;
      const idx = prices.findIndex((p) => p >= 0.999);
      // Require a decisive 1/0 split — skip half-resolved or tie states.
      if (winners === 1 && idx !== -1 && tokenIds[idx]) {
        return { label: outcomes[idx] ?? "", tokenId: tokenIds[idx] };
      }
    } catch {
      /* fall through to legacy */
    }
  }
  // Legacy shape: explicit winner label + tokens array.
  if (m.winner && m.tokens?.length) {
    const tid = mapWinnerToTokenId(m.winner, m.tokens);
    if (tid) return { label: m.winner, tokenId: tid };
  }
  return null;
}

function normalizeLabel(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ");
}

function mapWinnerToTokenId(
  winner: string,
  tokens: Array<{ token_id: string; outcome: string }>,
): string | null {
  if (!winner || !tokens.length) return null;

  const normalizedWinner = normalizeLabel(winner);
  const normalizedTokens = tokens.map((t) => ({
    tokenId: t.token_id,
    outcome: t.outcome,
    normalizedOutcome: normalizeLabel(t.outcome),
  }));

  const yes = normalizedTokens.find((t) => t.normalizedOutcome === "yes");
  const no = normalizedTokens.find((t) => t.normalizedOutcome === "no");

  if (normalizedWinner === "yes" && yes) return yes.tokenId;
  if (normalizedWinner === "no" && no) return no.tokenId;

  const exact = normalizedTokens.find(
    (t) => t.normalizedOutcome === normalizedWinner,
  );
  if (exact) return exact.tokenId;

  const partial = normalizedTokens.filter(
    (t) =>
      t.normalizedOutcome.includes(normalizedWinner) ||
      normalizedWinner.includes(t.normalizedOutcome),
  );
  if (partial.length === 1) return partial[0].tokenId;

  return null;
}

function hasPassedEndDateBuffer(endDateIso: string | undefined): boolean {
  if (!endDateIso) return false;
  const end = Date.parse(endDateIso);
  if (Number.isNaN(end)) return false;

  const cutoff = Date.now() - config.minPostEndMinutes * 60_000;
  return end <= cutoff;
}

export async function fetchClosedUnresolvedMarkets(): Promise<ClosedMarket[]> {
  try {
    const allMarkets: GammaMarket[] = [];
    const limit = 100;

    // Bound the query to markets that ended within the recent lookback window.
    // Without this, closed=true is dominated by far-future-dated markets (closed
    // early, end date years out) and ancient ones, so the recently-ended markets
    // that carry the lag opportunity never appear and discovery returns 0.
    const now = Date.now();
    const endMin = new Date(now - config.lookbackHours * 3_600_000).toISOString();
    const endMax = new Date(now).toISOString();

    for (let page = 0; page < 5; page++) {
      // Most-recently-ended first — resolution-lag opportunities live in the
      // short window right after close, not in the back catalogue.
      const url =
        `${GAMMA_API}?closed=true&end_date_min=${encodeURIComponent(endMin)}` +
        `&end_date_max=${encodeURIComponent(endMax)}` +
        `&limit=${limit}&offset=${page * limit}&order=endDate&ascending=false`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`Gamma API ${res.status}`);
      const data = (await res.json()) as GammaMarket[];
      const batch = Array.isArray(data) ? data : [];
      allMarkets.push(...batch);
      if (batch.length < limit) break;
    }

    const markets = allMarkets;

    const result: ClosedMarket[] = [];
    for (const m of markets) {
      if (!isResolved(m)) continue;
      // Skip high-frequency crypto "Up or Down" markets — they auto-resolve on
      // the CLOB with no lag, so they're noise that would waste hundreds of CLOB
      // checks per scan (and risk rate-limiting) for zero opportunity.
      if (/up or down/i.test(m.question ?? "")) continue;
      const endDate = m.end_date_iso ?? m.endDate ?? "";
      if (!hasPassedEndDateBuffer(endDate)) continue;

      const winner = deriveWinner(m);
      if (!winner) continue;

      result.push({
        id: m.id,
        conditionId: m.conditionId ?? m.condition_id ?? "",
        question: m.question,
        gammaOutcome: winner.label,
        gammaResolved: true,
        clobResolved: false, // oracle.ts will fill this in
        winnerTokenId: winner.tokenId,
        endDate,
      });
    }
    // Freshest closures first (markets came back endDate-desc); cap the set so
    // the downstream CLOB checks don't burst hundreds of requests per scan.
    return result.slice(0, config.maxCandidates);
  } catch (err) {
    console.error("[monitor] Gamma API error:", (err as Error).message);
    return [];
  }
}
