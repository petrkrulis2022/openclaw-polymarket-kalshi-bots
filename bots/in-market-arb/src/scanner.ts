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
  end_date_iso?: string;
  neg_risk?: boolean;
  neg_risk_market_id?: string;
  // Polymarket fee fields — various API versions use different names
  feeRate?: number;
  fee_rate?: number;
  makerBaseFee?: number;
  takerBaseFee?: number;
}

function extractFeeRate(m: GammaMarket): number {
  // Try each known field name; all are expected to be decimals (0.02 = 2%)
  const raw =
    m.feeRate ??
    m.fee_rate ??
    m.takerBaseFee ??
    m.makerBaseFee;
  if (typeof raw === "number" && raw >= 0 && raw <= 1) return raw;
  return config.defaultFeeRate;
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
    const url = `${GAMMA_API}?active=true&closed=false&limit=500`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Gamma API ${res.status}`);

    const data = (await res.json()) as GammaMarket[];
    const markets = Array.isArray(data) ? data : [];

    const binary: BinaryMarket[] = [];
    const negRiskMap = new Map<string, NegRiskGroup>();

    for (const m of markets) {
      if (!m.active || m.closed) continue;
      const tokens = m.tokens ?? [];
      const yes = tokens.find((t) => t.outcome?.toLowerCase() === "yes");
      const no = tokens.find((t) => t.outcome?.toLowerCase() === "no");
      if (!yes || !no) continue;

      const feeRate = extractFeeRate(m);

      if (m.neg_risk && m.neg_risk_market_id) {
        const groupId = m.neg_risk_market_id;
        if (!negRiskMap.has(groupId)) {
          negRiskMap.set(groupId, {
            negRiskMarketId: groupId,
            groupQuestion: m.question,
            outcomes: [],
            feeRate,
            endDate: m.end_date_iso ?? "",
          });
        }
        negRiskMap.get(groupId)!.outcomes.push({
          marketId: m.id,
          question: m.question,
          yesTokenId: yes.token_id,
          noTokenId: no.token_id,
        });
      } else {
        binary.push({
          id: m.id,
          question: m.question,
          yesTokenId: yes.token_id,
          noTokenId: no.token_id,
          endDate: m.end_date_iso ?? "",
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
