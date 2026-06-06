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
  /** Market category from Gamma API (e.g. "Sports", "Crypto", "Politics") */
  category: string;
}

// Categories excluded from market-making entirely.
// Sports: hard binary resolution + heavy adverse selection from informed bettors.
// Crypto: taker fees of 2-3%+ make fills uneconomical.
const EXCLUDED_CATEGORIES = new Set([
  "sports",
  "sport",
  "esports",
  "e-sports",
  "soccer",
  "football",
  "tennis",
  "basketball",
  "baseball",
  "hockey",
  "cricket",
  "rugby",
  "golf",
  "mma",
  "boxing",
  "racing",
  "crypto",
  "cryptocurrency",
]);

function isCategoryExcluded(category: string): boolean {
  return EXCLUDED_CATEGORIES.has(category.toLowerCase().trim());
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

    // Require market to end at least 48h from now — compare full ISO strings
    const cutoff48hMs = Date.now() + 48 * 60 * 60 * 1000;

    const markets: GammaMarket[] = [];
    for (const m of raw) {
      if (!m["enableOrderBook"]) continue;
      if (!m["active"] || m["closed"]) continue;

      // Category exclusion — sports and crypto cause adverse selection / high fees
      const category = String(m["category"] ?? m["tags"] ?? "").trim();
      if (isCategoryExcluded(category)) continue;

      // Robust end-date check using actual timestamp comparison
      const endDate = String(m["endDateIso"] ?? "");
      if (!endDate) continue;
      const endMs = new Date(endDate).getTime();
      if (!isFinite(endMs) || endMs < cutoff48hMs) continue;

      const vol24 = parseFloat(String(m["volume24hr"] ?? "0"));
      if (vol24 < params.minVolume24h) continue;

      let tokenIds: string[] = [];
      try {
        tokenIds = JSON.parse(m["clobTokenIds"] as string) as string[];
      } catch {
        continue;
      }
      if (tokenIds.length !== 2) continue;

      let yesPrice = 0.5;
      try {
        const op = JSON.parse(m["outcomePrices"] as string) as string[];
        yesPrice = parseFloat(op[0] ?? "0.5");
      } catch {
        /* keep default 0.5 */
      }

      // Skip near-resolved markets — high adverse-selection risk and skewed fees
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
        category,
      });
    }

    markets.sort((a, b) => b.volume24hr - a.volume24hr);
    cachedMarkets = markets;

    const selected = markets.slice(0, params.numMarkets);
    lastFetch = now;
    console.log(`[markets] Selected ${selected.length} non-sports/non-crypto markets:`);
    selected.forEach((m) =>
      console.log(
        `  • [${m.category || "?"}] YES=${m.yesPrice.toFixed(3)} ${m.question.slice(0, 50)} | vol24h=$${m.volume24hr.toFixed(0)}`,
      ),
    );
  } catch (err) {
    console.error("[markets] Failed to fetch:", (err as Error).message);
  }

  return cachedMarkets.slice(0, params.numMarkets);
}
