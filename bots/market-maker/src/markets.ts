import { config } from "./config.js";
import { params } from "./runtime-config.js";

export interface GammaMarket {
  conditionId: string;
  question: string;
  endDateIso: string;
  volume24hr: number;
  volumeNum: number;
  liquidityNum: number;
  active: boolean;
  closed: boolean;
  clobTokenIds: string; // JSON-encoded array of 2 token IDs
  enableOrderBook: boolean;
  // Parsed convenience fields (added by us)
  yesTokenId: string;
  noTokenId: string;
  /** YES token probability (0–1) from Gamma outcomePrices[0] */
  yesPrice: number;
  /** Best bid for YES token from Gamma API (may be 0 if unavailable) */
  gammaBestBid: number;
  /** Best ask for YES token from Gamma API (may be 1 if unavailable) */
  gammaBestAsk: number;
}

let cachedMarkets: GammaMarket[] = []; // full filtered+sorted list (not sliced)
let lastFetch = 0;
const REFRESH_MS = 10 * 60 * 1000; // 10 minutes

export async function getActiveMarkets(): Promise<GammaMarket[]> {
  const now = Date.now();
  if (cachedMarkets.length > 0 && now - lastFetch < REFRESH_MS) {
    // Slice by current numMarkets so dashboard changes take effect immediately
    return cachedMarkets.slice(0, params.numMarkets);
  }

  try {
    const url = `${config.polymarket.gammaHost}/markets?active=true&closed=false&limit=200&order=volume24hr&ascending=false`;
    const res = await fetch(url, {
      headers: { "User-Agent": "openclaw-market-maker/1.0" },
    });
    if (!res.ok)
      throw new Error(`Gamma API ${res.status}: ${await res.text()}`);

    const raw = (await res.json()) as Array<Record<string, unknown>>;
    const cutoff48h = new Date(Date.now() + 48 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10); // "YYYY-MM-DD"

    const markets: GammaMarket[] = [];
    for (const m of raw) {
      // Skip markets that don't have CLOB orderbook support
      if (!m["enableOrderBook"]) continue;
      if (!m["active"] || m["closed"]) continue;
      // end date must be at least 48h away
      const endDate = (m["endDateIso"] as string) ?? "";
      if (endDate < cutoff48h) continue;
      // Volume filter
      const vol24 = parseFloat(String(m["volume24hr"] ?? "0"));
      if (vol24 < params.minVolume24h) continue;
      // Must have exactly 2 CLOB token IDs
      let tokenIds: string[] = [];
      try {
        tokenIds = JSON.parse(m["clobTokenIds"] as string) as string[];
      } catch {
        continue;
      }
      if (tokenIds.length !== 2) continue;

      // Parse YES price from outcomePrices[0]
      let yesPrice = 0.5;
      try {
        const op = JSON.parse(m["outcomePrices"] as string) as string[];
        yesPrice = parseFloat(op[0] ?? "0.5");
      } catch {
        /* keep default 0.5 */
      }

      // Skip near-resolved markets: YES > 90% (too expensive to buy min order)
      // or YES < 10% (our halfWidth would be larger than the price itself)
      if (yesPrice > 0.9 || yesPrice < 0.1) continue;

      const gammaBestBid = parseFloat(String(m["bestBid"] ?? "0")) || 0;
      const gammaBestAsk = parseFloat(String(m["bestAsk"] ?? "1")) || 1;

      markets.push({
        conditionId: m["conditionId"] as string,
        question: m["question"] as string,
        endDateIso: endDate,
        volume24hr: vol24,
        volumeNum: parseFloat(String(m["volumeNum"] ?? "0")),
        liquidityNum: parseFloat(String(m["liquidityNum"] ?? "0")),
        active: true,
        closed: false,
        clobTokenIds: m["clobTokenIds"] as string,
        enableOrderBook: true,
        yesTokenId: tokenIds[0]!,
        noTokenId: tokenIds[1]!,
        yesPrice,
        gammaBestBid,
        gammaBestAsk,
      });
    }

    // Sort by 24h volume descending — store full list, slice on read
    markets.sort((a, b) => b.volume24hr - a.volume24hr);
    cachedMarkets = markets; // store all, not sliced

    const selected = markets.slice(0, params.numMarkets);
    lastFetch = now;
    console.log(`[markets] Selected ${selected.length} markets:`);
    selected.forEach((m) =>
      console.log(
        `  • YES=${m.yesPrice.toFixed(3)} ${m.question.slice(0, 55)} | vol24h=$${m.volume24hr.toFixed(0)}`,
      ),
    );
  } catch (err) {
    console.error("[markets] Failed to fetch:", (err as Error).message);
    // Keep stale cache on error
  }

  return cachedMarkets.slice(0, params.numMarkets);
}
