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
  resolved: boolean;
  winner?: string;
  tokens?: Array<{ token_id: string; outcome: string }>;
  end_date_iso?: string;
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

    for (let page = 0; page < 5; page++) {
      const url = `${GAMMA_API}?closed=true&active=false&limit=${limit}&offset=${page * limit}`;
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
      if (!m.resolved || !m.winner) continue;
      if (!hasPassedEndDateBuffer(m.end_date_iso)) continue;

      const tokens = m.tokens ?? [];
      const winnerTokenId = mapWinnerToTokenId(m.winner, tokens);
      if (!winnerTokenId) continue;

      result.push({
        id: m.id,
        conditionId: m.conditionId ?? m.condition_id ?? "",
        question: m.question,
        gammaOutcome: m.winner,
        gammaResolved: !!m.resolved,
        clobResolved: false, // oracle.ts will fill this in
        winnerTokenId,
        endDate: m.end_date_iso ?? "",
      });
    }
    return result;
  } catch (err) {
    console.error("[monitor] Gamma API error:", (err as Error).message);
    return [];
  }
}
