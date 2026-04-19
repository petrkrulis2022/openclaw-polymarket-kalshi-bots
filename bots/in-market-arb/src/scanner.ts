/**
 * scanner.ts — polls Gamma API for active binary markets.
 * A binary market has exactly two outcome tokens: YES and NO.
 */

const GAMMA_API = "https://gamma-api.polymarket.com/markets";

export interface BinaryMarket {
  id: string;
  question: string;
  yesTokenId: string;
  noTokenId: string;
  endDate: string;
}

interface GammaMarket {
  id: string;
  question: string;
  active: boolean;
  closed: boolean;
  tokens?: Array<{ token_id: string; outcome: string }>;
  end_date_iso?: string;
}

let cachedMarkets: BinaryMarket[] = [];
let lastFetch = 0;
const CACHE_TTL_MS = 55_000; // slightly under scan interval

export async function scanActiveMarkets(): Promise<BinaryMarket[]> {
  const now = Date.now();
  if (now - lastFetch < CACHE_TTL_MS && cachedMarkets.length > 0) {
    return cachedMarkets;
  }

  try {
    const url = `${GAMMA_API}?active=true&closed=false&limit=500`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Gamma API ${res.status}`);

    const data = (await res.json()) as GammaMarket[];
    const markets = Array.isArray(data) ? data : [];

    const binary: BinaryMarket[] = [];
    for (const m of markets) {
      if (!m.active || m.closed) continue;
      const tokens = m.tokens ?? [];
      const yes = tokens.find(
        (t) => t.outcome?.toLowerCase() === "yes",
      );
      const no = tokens.find(
        (t) => t.outcome?.toLowerCase() === "no",
      );
      if (!yes || !no) continue;
      binary.push({
        id: m.id,
        question: m.question,
        yesTokenId: yes.token_id,
        noTokenId: no.token_id,
        endDate: m.end_date_iso ?? "",
      });
    }

    cachedMarkets = binary;
    lastFetch = now;
    console.log(`[scanner] Found ${binary.length} active binary markets`);
    return binary;
  } catch (err) {
    console.error("[scanner] Gamma API error:", (err as Error).message);
    return cachedMarkets; // return stale cache on error
  }
}
