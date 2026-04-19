/**
 * screener.ts — finds low-price, long-duration markets suitable for
 * microstructure market-making (resting bids at sub-$0.003 prices).
 */

import { getBestAsk } from "./clob.js";
import { config } from "./config.js";

const GAMMA_API = "https://gamma-api.polymarket.com/markets";

export interface ScreenedMarket {
  id: string;
  question: string;
  yesTokenId: string;
  endDate: string;
  daysToExpiry: number;
  bestAsk: number;
}

interface GammaMarket {
  id: string;
  question: string;
  active: boolean;
  closed: boolean;
  volume?: string;
  tokens?: Array<{ token_id: string; outcome: string }>;
  end_date_iso?: string;
}

let screened: ScreenedMarket[] = [];
let lastScreenAt = 0;

export function getScreenedMarkets(): ScreenedMarket[] {
  return screened;
}

export async function runScreener(): Promise<void> {
  const now = Date.now();
  // Don't re-screen more than once per interval unless forced
  if (now - lastScreenAt < config.screenIntervalMs - 5_000) return;

  try {
    const url = `${GAMMA_API}?active=true&closed=false&limit=500`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Gamma API ${res.status}`);

    const data = (await res.json()) as GammaMarket[];
    const markets = Array.isArray(data) ? data : [];

    const candidates: ScreenedMarket[] = [];

    for (const m of markets) {
      if (!m.active || m.closed) continue;
      if (!m.end_date_iso) continue;

      const endMs = new Date(m.end_date_iso).getTime();
      const daysToExpiry = (endMs - now) / (1000 * 60 * 60 * 24);
      if (daysToExpiry < config.minDaysToExpiry) continue;

      // Must have some volume (not zombie market)
      if (!m.volume || parseFloat(m.volume) <= 0) continue;

      const tokens = m.tokens ?? [];
      const yes = tokens.find((t) => t.outcome?.toLowerCase() === "yes");
      if (!yes) continue;

      candidates.push({
        id: m.id,
        question: m.question,
        yesTokenId: yes.token_id,
        endDate: m.end_date_iso,
        daysToExpiry,
        bestAsk: 999, // will be populated below
      });

      if (candidates.length >= config.maxMarkets) break;
    }

    // Fetch live ask prices in batches to filter by maxAskPrice
    const withAsks: ScreenedMarket[] = [];
    for (let i = 0; i < candidates.length; i += 20) {
      const batch = candidates.slice(i, i + 20);
      const results = await Promise.allSettled(
        batch.map(async (c) => {
          const ask = await getBestAsk(c.yesTokenId);
          return { ...c, bestAsk: ask };
        }),
      );
      for (const r of results) {
        if (r.status === "fulfilled" && r.value.bestAsk <= config.maxAskPrice) {
          withAsks.push(r.value);
        }
      }
    }

    screened = withAsks;
    lastScreenAt = now;
    console.log(`[screener] ${screened.length} markets pass filter`);
  } catch (err) {
    console.error("[screener] Error:", (err as Error).message);
  }
}
