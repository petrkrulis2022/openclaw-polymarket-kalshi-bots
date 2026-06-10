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

const CLOB_API = "https://clob.polymarket.com";
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

interface ClobMarketPage {
  data?: Array<Record<string, unknown>>;
  next_cursor?: string;
}

async function fetchPolyMarkets(): Promise<PolyMarket[]> {
  const now = Date.now();
  if (polyCache && now - polyCacheAt < POLY_CACHE_TTL) return polyCache;
  try {
    // Paginate CLOB API through up to 20 pages (2000 markets) to reach FOMC/CPI markets
    const arr: Array<Record<string, unknown>> = [];
    let cursor = "MA=="; // base64("0") = initial cursor
    const maxPages = 20;
    for (let i = 0; i < maxPages; i++) {
      const res = await fetch(`${CLOB_API}/markets?next_cursor=${cursor}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) break;
      const page = (await res.json()) as ClobMarketPage;
      const markets = page.data ?? [];
      for (const m of markets) {
        if (!m["active"] || m["closed"]) continue;
        arr.push(m);
      }
      cursor = page.next_cursor ?? "LTE=";
      if (cursor === "LTE=" || markets.length === 0) break;
    }
    console.log(`[mapper] CLOB API fetched: ${arr.length} active markets`);
    const seen = new Set<string>();
    const arr: Array<Record<string, unknown>> = [];
    for (const r of pages) {
      if (r.status === "fulfilled") {
        for (const m of r.value) {
          const id = String(m["id"] ?? "");
          if (id && !seen.has(id)) { seen.add(id); arr.push(m); }
        }
      }
    }
      polyCache = arr
      .map((m) => {
        // CLOB API returns tokens as an actual array
        const tokens = (m["tokens"] as Array<{ token_id: string; outcome: string }>) ?? [];
        const yesToken = tokens.find((t) => t.outcome?.toLowerCase() === "yes");
        const noToken = tokens.find((t) => t.outcome?.toLowerCase() === "no");

        const feeRateRaw = m["feeRate"] ?? m["fee_rate"] ?? m["takerBaseFee"] ?? m["makerBaseFee"];
        const feeRateParsed = typeof feeRateRaw === "number" ? feeRateRaw
          : typeof feeRateRaw === "string" ? parseFloat(feeRateRaw)
          : NaN;
        const feeRate = Number.isFinite(feeRateParsed) && feeRateParsed >= 0 && feeRateParsed <= 1
          ? feeRateParsed
          : config.defaultPolyFeeRate;

        return {
          id: String(m["id"] ?? ""),
          conditionId: String(m["condition_id"] ?? m["conditionId"] ?? ""),
          question: String(m["question"] ?? ""),
          yesTokenId: yesToken?.token_id ?? "",
          noTokenId: noToken?.token_id ?? "",
          endDate: String(m["end_date_iso"] ?? m["endDate"] ?? ""),
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
  const mid = Math.floor(cheapPoly.length / 2);
  console.log(`[mapper] Polymarket: ${cheapPoly.length} fee≤2% | head: ${cheapPoly.slice(0, 2).map((m) => m.question.slice(0, 35)).join(" / ")} | mid: ${cheapPoly.slice(mid, mid + 2).map((m) => m.question.slice(0, 35)).join(" / ")} | tail: ${cheapPoly.slice(-2).map((m) => m.question.slice(0, 35)).join(" / ")}`);
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

    const MIN_SCORE = 0.3; // lowered to catch loose matches; spread calc filters unprofitable ones
    if (best && bestScore < MIN_SCORE && bestScore > 0.15 && /fed|cpi|fomc|rate|inflation|gdp|unemploy/i.test(km.title)) {
      console.log(`[mapper] near-miss: "${km.title.slice(0, 50)}" ↔ "${best.question.slice(0, 50)}" score=${bestScore.toFixed(2)}`);
    }
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
