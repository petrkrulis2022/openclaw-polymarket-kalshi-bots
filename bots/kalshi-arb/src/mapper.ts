/**
 * mapper.ts — matches Kalshi markets to Polymarket markets by question + end date.
 *
 * Two-layer approach:
 *   1. Static overrides: hardcoded known pairs (Fed rate decisions, etc.)
 *   2. Auto-match: normalize titles, token overlap ≥ 30%, end dates within ±168h
 *
 * Polymarket data: Gamma API, 15 parallel pages × 100 = up to 1500 markets.
 * Only pairs where Polymarket fee rate ≤ 2% are returned (excludes crypto).
 */

import { config } from "./config.js";
import type { KalshiMarket } from "./kalshi.js";

const GAMMA_API = "https://gamma-api.polymarket.com";
let polyCache: PolyMarket[] | null = null;
let polyCacheAt = 0;
const POLY_CACHE_TTL = 300_000; // 5 min — 15 parallel fetches is heavier

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

// ── Polymarket fetcher (Gamma API) ────────────────────────────────────────────

async function fetchOnePage(offset: number): Promise<Array<Record<string, unknown>>> {
  const url = `${GAMMA_API}/markets?active=true&closed=false&limit=100&offset=${offset}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function fetchPolyMarkets(): Promise<PolyMarket[]> {
  const now = Date.now();
  if (polyCache && now - polyCacheAt < POLY_CACHE_TTL) return polyCache;

  try {
    // 15 pages × 100 = up to 1500 current active markets, fetched in parallel
    const pages = await Promise.allSettled(
      Array.from({ length: 15 }, (_, i) => fetchOnePage(i * 100)),
    );

    const seen = new Set<string>();
    const arr: PolyMarket[] = [];

    for (const page of pages) {
      if (page.status !== "fulfilled") continue;
      for (const m of page.value) {
        const conditionId = String(m["conditionId"] ?? "");
        if (!conditionId || seen.has(conditionId)) continue;

        // outcomes and clobTokenIds are JSON-encoded strings in Gamma API
        let outcomes: string[] = [];
        let tokenIds: string[] = [];
        try {
          outcomes = JSON.parse(m["outcomes"] as string ?? "[]");
          tokenIds = JSON.parse(m["clobTokenIds"] as string ?? "[]");
        } catch {
          continue;
        }

        const yesIdx = outcomes.findIndex((o) => o.toLowerCase() === "yes");
        const noIdx = outcomes.findIndex((o) => o.toLowerCase() === "no");
        if (yesIdx === -1 || noIdx === -1) continue;

        const yesTokenId = tokenIds[yesIdx] ?? "";
        const noTokenId = tokenIds[noIdx] ?? "";
        if (!yesTokenId || !noTokenId) continue;

        // feeSchedule.rate is the actual per-formula rate (e.g. 0.03 for sports).
        // takerBaseFee is a legacy field and does NOT represent the real rate.
        // Effective fee = rate × p × (1-p); max at p=0.5 → rate × 0.25.
        // So sports 3% → max 0.75%, politics 4% → max 1.0%, crypto 7% → max 1.75%.
        const sched = m["feeSchedule"] as { rate?: number } | undefined;
        const feeRate = (sched?.rate != null && Number.isFinite(sched.rate))
          ? sched.rate
          : 0; // geopolitics has no feeSchedule → 0% fee

        seen.add(conditionId);
        arr.push({
          id: String(m["id"] ?? ""),
          conditionId,
          question: String(m["question"] ?? ""),
          yesTokenId,
          noTokenId,
          endDate: String(m["endDate"] ?? ""),
          feeRate,
          active: Boolean(m["active"]),
          closed: Boolean(m["closed"]),
        });
      }
    }

    console.log(`[mapper] Polymarket: ${arr.length} total via Gamma API`);
    polyCache = arr;
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

/**
 * Numeric "strikes" in free text (rate thresholds, price levels, …), excluding
 * 4-digit years so "2026" in a question isn't treated as a strike.
 */
function extractStrikes(s: string): number[] {
  return (s.match(/\d+(?:\.\d+)?/g) ?? [])
    .map((n) => parseFloat(n))
    .filter((n) => Number.isFinite(n) && !(n >= 1900 && n <= 2100));
}

/**
 * The threshold of a Kalshi scalar market, taken from the `-T<num>` segment of
 * the ticker (e.g. KXFED-26JUN-T3.50 → 3.50). Parsing the ticker avoids the
 * year digits ("26JUN") that a raw number scan would pick up. Null when the
 * market isn't a threshold ladder.
 */
function kalshiStrike(ticker: string): number | null {
  const m = ticker.match(/-T(\d+(?:\.\d+)?)/i);
  return m ? parseFloat(m[1]!) : null;
}

/**
 * Reject threshold-ladder false-positives. If the Kalshi market is a scalar
 * threshold (has a -T strike, or a strike in its title), the Polymarket market
 * MUST reference that same number — otherwise a Fed-rate ≥3.50% rung matches an
 * unrelated market that merely shares a year/keyword (governor races, Ballon
 * d'Or, …). Non-threshold Kalshi markets are left unconstrained.
 */
function strikesCompatible(
  kalshiTitle: string,
  kalshiTicker: string,
  polyQuestion: string,
): boolean {
  const tStrike = kalshiStrike(kalshiTicker);
  const kalshiStrikes = [
    ...extractStrikes(kalshiTitle),
    ...(tStrike != null ? [tStrike] : []),
  ];
  if (kalshiStrikes.length === 0) return true; // not a threshold market
  const polyStrikes = extractStrikes(polyQuestion);
  return kalshiStrikes.some((x) =>
    polyStrikes.some((y) => Math.abs(x - y) < 1e-6),
  );
}

// ── Main matcher ──────────────────────────────────────────────────────────────

export async function findMarketPairs(
  kalshiMarkets: KalshiMarket[],
): Promise<MarketPair[]> {
  const polyMarkets = await fetchPolyMarkets();
  const pairs: MarketPair[] = [];
  const usedPolyIds = new Set<string>();

  // feeRate is the Polymarket V2 formula rate (e.g. 0.03 sports, 0.04 politics).
  // Effective fee = rate × p × (1-p), max 0.0175 for 7% crypto at p=0.5.
  // All current categories are under 2% effective; exclude only extreme outliers.
  const cheapPoly = polyMarkets.filter((m) => m.feeRate <= 0.08);
  console.log(`[mapper] Polymarket: ${cheapPoly.length} fee≤2% available for matching`);

  for (const km of kalshiMarkets) {
    // kalshiMarkets is already filtered to status=open by the API query;
    // Kalshi returns "active" not "open" in the status field, so skip only settled/closed.
    if (km.status === "settled" || km.status === "closed") continue;

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
      // Reject threshold-ladder false-positives (e.g. Fed rate 2.75 vs a
      // governor race). A Kalshi scalar market must share its strike with Poly.
      if (!strikesCompatible(km.title, km.ticker, pm.question)) continue;

      let score = tokenOverlap(km.title, pm.question);

      // Only boost when BOTH sides contain the keyword — prevents false matches
      // where a Kalshi FOMC market spuriously matches unrelated Polymarket markets.
      if (
        override &&
        normalize(pm.question).includes(override.polyKeyword)
      ) {
        score = Math.max(score, 0.7);
      }

      if (score > bestScore) {
        bestScore = score;
        best = pm;
      }
    }

    const MIN_SCORE = 0.3;
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
