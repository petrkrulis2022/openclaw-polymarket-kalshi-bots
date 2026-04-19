/**
 * monitor.ts — polls Gamma API for markets that are closed but not yet
 * resolved on the CLOB (the "resolution lag" window).
 */

const GAMMA_API = "https://gamma-api.polymarket.com/markets";

export interface ClosedMarket {
  id: string;
  question: string;
  /** The outcome Gamma believes is correct (1 = YES winner, 0 = NO winner) */
  gammaOutcome: "YES" | "NO" | "UNKNOWN";
  gammaResolved: boolean;
  clobResolved: boolean;
  yesTokenId: string;
  noTokenId: string;
  endDate: string;
}

interface GammaMarket {
  id: string;
  question: string;
  closed: boolean;
  active: boolean;
  resolved: boolean;
  winner?: string;
  tokens?: Array<{ token_id: string; outcome: string }>;
  end_date_iso?: string;
}

export async function fetchClosedUnresolvedMarkets(): Promise<ClosedMarket[]> {
  try {
    // Fetch recently closed markets
    const url = `${GAMMA_API}?closed=true&active=false&limit=100`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Gamma API ${res.status}`);

    const data = (await res.json()) as GammaMarket[];
    const markets = Array.isArray(data) ? data : [];

    const result: ClosedMarket[] = [];
    for (const m of markets) {
      const tokens = m.tokens ?? [];
      const yes = tokens.find((t) => t.outcome?.toLowerCase() === "yes");
      const no = tokens.find((t) => t.outcome?.toLowerCase() === "no");
      if (!yes || !no) continue;

      // Gamma says resolved but CLOB may not have processed it yet
      // We mark clobResolved=false here; the oracle module confirms via CLOB
      let gammaOutcome: ClosedMarket["gammaOutcome"] = "UNKNOWN";
      if (m.winner) {
        gammaOutcome = m.winner.toLowerCase() === "yes" ? "YES" : "NO";
      }

      result.push({
        id: m.id,
        question: m.question,
        gammaOutcome,
        gammaResolved: !!m.resolved,
        clobResolved: false, // oracle.ts will fill this in
        yesTokenId: yes.token_id,
        noTokenId: no.token_id,
        endDate: m.end_date_iso ?? "",
      });
    }
    return result;
  } catch (err) {
    console.error("[monitor] Gamma API error:", (err as Error).message);
    return [];
  }
}
