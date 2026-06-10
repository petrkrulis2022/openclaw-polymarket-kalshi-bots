/**
 * scanner.ts — polls Gamma API for active markets.
 *
 * Returns two market types:
 *  1. BinaryMarket   — single YES/NO market; arb = YES ask + NO ask < $1
 *  2. NegRiskGroup   — N markets sharing the same neg_risk_market_id;
 *                      arb = sum(YES asks for all N outcomes) < $1 after fees
 */

import { config } from "./config.js";

const GAMMA_API = "https://gamma-api.polymarket.com/markets";

export interface BinaryMarket {
  id: string;
  conditionId: string;
  question: string;
  yesTokenId: string;
  noTokenId: string;
  endDate: string;
  feeRate: number;
}

export interface NegRiskGroup {
  negRiskMarketId: string;
  groupQuestion: string;
  outcomes: Array<{
    marketId: string;
    question: string;
    yesTokenId: string;
    noTokenId: string;
  }>;
  feeRate: number;
  endDate: string;
}

interface GammaToken {
  token_id: string;
  outcome: string;
}

interface GammaMarket {
  id: string;
  question: string;
  active: boolean;
  closed: boolean;
  tokens?: GammaToken[];
  /** JSON-encoded string array of CLOB token IDs, e.g. "[\"123...\",\"456...\"]" */
  clobTokenIds?: string;
  /** JSON-encoded string array of outcome names, e.g. "[\"Yes\",\"No\"]" */
  outcomes?: string;
  end_date_iso?: string;
  endDateIso?: string;
  endDate?: string;
  neg_risk?: boolean;
  negRisk?: boolean;
  neg_risk_market_id?: string;
  negRiskMarketID?: string;
  conditionId?: string;
  condition_id?: string;
  // Polymarket fee fields — various API versions use different names
  feeRate?: number;
  fee_rate?: number;
  makerBaseFee?: number;
  takerBaseFee?: number;
  feesEnabled?: boolean;
}

function extractFeeRate(m: GammaMarket): number {
  if (m.feesEnabled === false) return 0;
  const raw =
    m.feeRate ??
    m.fee_rate ??
    m.takerBaseFee ??
    m.makerBaseFee;
  if (typeof raw === "number" && raw >= 0) {
    // Decimal form (0.02 = 2%) or basis points (1000 = 0.10 multiplier)
    if (raw <= 1) return raw;
    if (raw <= 10_000) return raw / 10_000;
  }
  return config.defaultFeeRate;
}

/** Gamma /markets returns clobTokenIds + outcomes as JSON-encoded strings. */
function extractYesNo(
  m: GammaMarket,
): { yesTokenId: string; noTokenId: string } | null {
  if (m.clobTokenIds) {
    try {
      const ids = JSON.parse(m.clobTokenIds) as string[];
      const outcomes = JSON.parse(m.outcomes ?? '["Yes","No"]') as string[];
      const yi = outcomes.findIndex((o) => o?.toLowerCase() === "yes");
      const ni = outcomes.findIndex((o) => o?.toLowerCase() === "no");
      if (yi !== -1 && ni !== -1 && ids[yi] && ids[ni]) {
        return { yesTokenId: ids[yi], noTokenId: ids[ni] };
      }
    } catch {
      /* fall through to tokens array */
    }
  }
  const tokens = m.tokens ?? [];
  const yes = tokens.find((t) => t.outcome?.toLowerCase() === "yes");
  const no = tokens.find((t) => t.outcome?.toLowerCase() === "no");
  if (yes && no) return { yesTokenId: yes.token_id, noTokenId: no.token_id };
  return null;
}

export interface ScanResult {
  binary: BinaryMarket[];
  negRisk: NegRiskGroup[];
}

let cachedBinary: BinaryMarket[] = [];
let cachedNegRisk: NegRiskGroup[] = [];
let lastFetch = 0;
const CACHE_TTL_MS = 55_000;

export async function scanActiveMarkets(): Promise<ScanResult> {
  const now = Date.now();
  if (now - lastFetch < CACHE_TTL_MS && (cachedBinary.length > 0 || cachedNegRisk.length > 0)) {
    return { binary: cachedBinary, negRisk: cachedNegRisk };
  }

  try {
    // Gamma caps each page at 100 — paginate to scan up to 500 markets
    const markets: GammaMarket[] = [];
    for (let offset = 0; offset < 500; offset += 100) {
      const url = `${GAMMA_API}?active=true&closed=false&limit=100&offset=${offset}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`Gamma API ${res.status}`);
      const page = (await res.json()) as GammaMarket[];
      if (!Array.isArray(page) || page.length === 0) break;
      markets.push(...page);
      if (page.length < 100) break;
    }

    const binary: BinaryMarket[] = [];
    const negRiskMap = new Map<string, NegRiskGroup>();

    for (const m of markets) {
      if (!m.active || m.closed) continue;
      const pair = extractYesNo(m);
      if (!pair) continue;

      const feeRate = extractFeeRate(m);
      const endDate = m.endDateIso ?? m.end_date_iso ?? m.endDate ?? "";
      const isNegRisk = m.negRisk ?? m.neg_risk ?? false;
      const negRiskGroupId = m.negRiskMarketID ?? m.neg_risk_market_id ?? "";

      if (isNegRisk && negRiskGroupId) {
        if (!negRiskMap.has(negRiskGroupId)) {
          negRiskMap.set(negRiskGroupId, {
            negRiskMarketId: negRiskGroupId,
            groupQuestion: m.question,
            outcomes: [],
            feeRate,
            endDate,
          });
        }
        negRiskMap.get(negRiskGroupId)!.outcomes.push({
          marketId: m.id,
          question: m.question,
          yesTokenId: pair.yesTokenId,
          noTokenId: pair.noTokenId,
        });
      } else {
        binary.push({
          id: m.id,
          conditionId: m.conditionId ?? m.condition_id ?? "",
          question: m.question,
          yesTokenId: pair.yesTokenId,
          noTokenId: pair.noTokenId,
          endDate,
          feeRate,
        });
      }
    }

    cachedBinary = binary;
    // Only keep groups with at least 2 outcomes (single-outcome groups are just binary)
    cachedNegRisk = Array.from(negRiskMap.values()).filter(
      (g) => g.outcomes.length >= 2,
    );
    lastFetch = now;
    console.log(
      `[scanner] ${binary.length} binary markets, ${cachedNegRisk.length} negRisk groups`,
    );
    return { binary: cachedBinary, negRisk: cachedNegRisk };
  } catch (err) {
    console.error("[scanner] Gamma API error:", (err as Error).message);
    return { binary: cachedBinary, negRisk: cachedNegRisk };
  }
}
