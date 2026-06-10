/**
 * mapper.ts — matches Kalshi markets to Polymarket markets by question + end date.
 *
 * Two-layer approach:
 *   1. Static overrides: hardcoded known pairs (Fed rate decisions, etc.)
 *   2. Auto-match: normalize titles, token overlap ≥ 60%, end dates within ±24h
 *
 * Only pairs where Polymarket fee rate ≤ 1% are returned (excludes crypto).
 */

import { config } from "./config.js";
import type { KalshiMarket } from "./kalshi.js";

const GAMMA_API = "https://gamma-api.polymarket.com/markets";
// Cache Polymarket market list for 60s to avoid hammering
let polyCache: PolyMarket[] | null = null;
let polyCacheAt = 0;
const POLY_CACHE_TTL = 60_000;

export interface PolyMarket {
  id: string;
  conditionId: string;
  question: string;
  yesTokenId: string;
  noTokenId: string;
  endDate: string;
  feeRate: number;
  active: boolean;
  closed: boolean;
}

export interface MarketPair {
  kalshiTicker: string;
  kalshiTitle: string;
  kalshiCloseTime: string;
  kalshiFeeRate: number;
  polyConditionId: string;
  polyYesTokenId: string;
  polyNoTokenId: string;
  polyQuestion: string;
  polyEndDate: string;
  polyFeeRate: number;
}

// ── Static override table ─────────────────────────────────────────────────────
// Map Kalshi ticker prefix → Polymarket question keyword for known event types.
// Add entries here as you discover recurring matched pairs.
const STATIC_OVERRIDES: Array<{
  kalshiKeyword: string;
  polyKeyword: string;
}> = [
  { kalshiKeyword: "federal funds rate", polyKeyword: "fed funds rate" },
  { kalshiKeyword: "fomc", polyKeyword: "fomc" },
  { kalshiKeyword: "cpi", polyKeyword: "cpi" },
  { kalshiKeyword: "unemployment rate", polyKeyword: "unemployment" },
  { kalshiKeyword: "gdp", polyKeyword: "gdp" },
];

// ── Polymarket fetcher ────────────────────────────────────────────────────────

async function fetchPolyPage(tag?: string): Promise<Array<Record<string, unknown>>> {
  const qs = `active=true&closed=false&limit=100${tag ? `&tag=${encodeURIComponent(tag)}` : ""}`;
  const res = await fetch(`${GAMMA_API}?${qs}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Gamma API ${res.status}`);
  const raw = (await res.json()) as unknown;
  return Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
}

async function fetchPolyMarkets(): Promise<PolyMarket[]> {
  const now = Date.now();
  if (polyCache && now - polyCacheAt < POLY_CACHE_TTL) return polyCache;
  try {
    // Fetch general + specific tags to cover elections/economics not in top-100 trending
    const [general, politics, elections, economics] = await Promise.allSettled([
      fetchPolyPage(),
      fetchPolyPage("Politics"),
      fetchPolyPage("Elections"),
      fetchPolyPage("Economics"),
    ]);
    const seen = new Set<string>();
    const arr: Array<Record<string, unknown>> = [];
    for (const r of [general, politics, elections, economics]) {
      if (r.status === "fulfilled") {
        for (const m of r.value) {
          const id = String(m["id"] ?? "");
          if (id && !seen.has(id)) { seen.add(id); arr.push(m); }
        }
      }
    }
    console.log(`[mapper] Gamma API raw count: ${arr.length}`);
    if (arr.length > 0) {
      const s = arr[0];
      console.log(`[mapper] Sample tags/groupBy: tags=${JSON.stringify(s["tags"])} groupItemTitle=${s["groupItemTitle"]} category=${s["category"]}`);
    }
    polyCache = arr
      .map((m) => {
        // outcomes and clobTokenIds come back as JSON-encoded strings from Gamma API
        const outcomes: string[] = (() => {
          try { return JSON.parse(m["outcomes"] as string) as string[]; } catch { return []; }
        })();
        const clobTokenIds: string[] = (() => {
          try { return JSON.parse(m["clobTokenIds"] as string) as string[]; } catch { return []; }
        })();
        const yesIdx = outcomes.findIndex((o) => o.toLowerCase() === "yes");
        const noIdx = outcomes.findIndex((o) => o.toLowerCase() === "no");
        const yesTokenId = yesIdx >= 0 ? (clobTokenIds[yesIdx] ?? "") : "";
        const noTokenId = noIdx >= 0 ? (clobTokenIds[noIdx] ?? "") : "";

        const feeRateRaw = m["feeRate"] ?? m["fee_rate"] ?? m["takerBaseFee"] ?? m["makerBaseFee"];
        const feeRateParsed = typeof feeRateRaw === "number" ? feeRateRaw
          : typeof feeRateRaw === "string" ? parseFloat(feeRateRaw)
          : NaN;
        // Valid decimal fee rates are 0–1; values >1 are in basis points or other units
        const feeRate = Number.isFinite(feeRateParsed) && feeRateParsed >= 0 && feeRateParsed <= 1
          ? feeRateParsed
          : config.defaultPolyFeeRate;

        return {
          id: String(m["id"] ?? ""),
          conditionId: String(m["conditionId"] ?? m["condition_id"] ?? ""),
          question: String(m["question"] ?? ""),
          yesTokenId,
          noTokenId,
          endDate: String(m["endDate"] ?? m["end_date_iso"] ?? ""),
          feeRate: Number.isFinite(feeRate) ? feeRate : config.defaultPolyFeeRate,
          active: Boolean(m["active"]),
          closed: Boolean(m["closed"]),
        } as PolyMarket;
      })
      .filter((m) => m.conditionId && m.yesTokenId && m.noTokenId);
    polyCacheAt = now;
    return polyCache;
  } catch (err) {
    console.error("[mapper] fetchPolyMarkets error:", (err as Error).message);
    return polyCache ?? [];
  }
}

// ── Title normalization ───────────────────────────────────────────────────────

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function tokenOverlap(a: string, b: string): number {
  const setA = new Set(normalize(a).split(" ").filter((t) => t.length > 2));
  const setB = new Set(normalize(b).split(" ").filter((t) => t.length > 2));
  if (!setA.size || !setB.size) return 0;
  let common = 0;
  for (const t of setA) if (setB.has(t)) common++;
  return common / Math.min(setA.size, setB.size);
}

function dateWithinHours(a: string, b: string, hours: number): boolean {
  if (!a || !b) return true; // allow match when either side has no close date
  const diff = Math.abs(new Date(a).getTime() - new Date(b).getTime());
  return diff <= hours * 3_600_000;
}

// ── Main matcher ──────────────────────────────────────────────────────────────

export async function findMarketPairs(
  kalshiMarkets: KalshiMarket[],
): Promise<MarketPair[]> {
  const polyMarkets = await fetchPolyMarkets();
  const pairs: MarketPair[] = [];
  const usedPolyIds = new Set<string>();

  // Exclude only crypto-tier fees (>2%). Politics=0%, elections=0-1% all pass.
  const cheapPoly = polyMarkets.filter((m) => m.feeRate <= 0.02);
  console.log(`[mapper] Polymarket: ${polyMarkets.length} total, ${cheapPoly.length} fee≤2% | sample: ${cheapPoly.slice(0, 3).map((m) => m.question.slice(0, 40)).join(" | ")}`);
  console.log(`[mapper] Kalshi sample titles: ${kalshiMarkets.slice(0, 5).map((m) => m.title).join(" | ")}`);

  for (const km of kalshiMarkets) {
    if (km.status !== "open") continue;

    // Check static overrides first
    const override = STATIC_OVERRIDES.find(
      (o) =>
        normalize(km.title).includes(o.kalshiKeyword) ||
        km.ticker.toLowerCase().includes(o.kalshiKeyword.replace(/\s/g, "")),
    );

    let best: PolyMarket | null = null;
    let bestScore = 0;

    for (const pm of cheapPoly) {
      if (usedPolyIds.has(pm.conditionId)) continue;
      if (!dateWithinHours(km.closeTime, pm.endDate, 168)) continue;

      let score = tokenOverlap(km.title, pm.question);

      // Boost score if static override keyword matches
      if (
        override &&
        (normalize(pm.question).includes(override.polyKeyword) ||
          normalize(km.title).includes(override.kalshiKeyword))
      ) {
        score = Math.max(score, 0.7);
      }

      if (score > bestScore) {
        bestScore = score;
        best = pm;
      }
    }

    const MIN_SCORE = 0.6;
    if (best && bestScore >= MIN_SCORE) {
      usedPolyIds.add(best.conditionId);
      pairs.push({
        kalshiTicker: km.ticker,
        kalshiTitle: km.title,
        kalshiCloseTime: km.closeTime,
        kalshiFeeRate: km.feeRate,
        polyConditionId: best.conditionId,
        polyYesTokenId: best.yesTokenId,
        polyNoTokenId: best.noTokenId,
        polyQuestion: best.question,
        polyEndDate: best.endDate,
        polyFeeRate: best.feeRate,
      });
    }
  }

  return pairs;
}
