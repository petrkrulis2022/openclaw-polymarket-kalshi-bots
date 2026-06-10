/**
 * inventory.ts — tracks locked YES+NO arb pairs and negRisk multi-leg pairs.
 */
import fs from "fs";

export type PairStatus = "pending" | "filled" | "partial" | "cancelled";

export interface ArbPair {
  id: string;
  type: "binary";
  marketId: string;
  conditionId: string;
  marketQuestion: string;
  yesTokenId: string;
  noTokenId: string;
  yesOrderId: string;
  noOrderId: string;
  yesPrice: number;
  noPrice: number;
  yesRemainingSize: number;
  noRemainingSize: number;
  sizeUsd: number;
  status: PairStatus;
  createdAt: string;
  settledAt?: string;
  realizedPnl?: number;
  mergeAttempted?: boolean;
  mergeTxHash?: string;
}

export interface NegRiskPair {
  id: string;
  type: "neg_risk";
  negRiskMarketId: string;
  groupQuestion: string;
  legs: Array<{
    marketId: string;
    yesTokenId: string;
    orderId: string;
    price: number;
    size: number;
    remainingSize: number;
  }>;
  totalCostUsd: number;
  status: PairStatus;
  createdAt: string;
  settledAt?: string;
  realizedPnl?: number;
}

export type AnyPair = ArbPair | NegRiskPair;

const pairs = new Map<string, ArbPair>();
const negRiskPairs = new Map<string, NegRiskPair>();
let totalRealizedPnl = 0;

// ── Persistence ───────────────────────────────────────────────────────────────
const STATE_FILE = process.env["POSITIONS_STATE_FILE"] ?? "";

function persistState(): void {
  if (!STATE_FILE) return;
  try {
    const data = {
      pairs: Array.from(pairs.values()),
      negRiskPairs: Array.from(negRiskPairs.values()),
      totalRealizedPnl,
      savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch {
    /* non-fatal */
  }
}

export function loadPersistedState(): void {
  if (!STATE_FILE || !fs.existsSync(STATE_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as {
      pairs: ArbPair[];
      negRiskPairs?: NegRiskPair[];
      totalRealizedPnl: number;
    };
    pairs.clear();
    for (const p of raw.pairs ?? []) pairs.set(p.id, p);
    negRiskPairs.clear();
    for (const p of raw.negRiskPairs ?? []) negRiskPairs.set(p.id, p);
    totalRealizedPnl = raw.totalRealizedPnl ?? 0;
    console.log(
      `[inventory] Loaded ${pairs.size} binary pair(s), ${negRiskPairs.size} negRisk pair(s)`,
    );
  } catch (err) {
    console.warn(
      "[inventory] Failed to load persisted state:",
      (err as Error).message,
    );
  }
}

// ── Binary pairs ──────────────────────────────────────────────────────────────

export function addPair(pair: ArbPair): void {
  pairs.set(pair.id, pair);
  persistState();
}

export function updatePair(id: string, updates: Partial<ArbPair>): void {
  const existing = pairs.get(id);
  if (existing) {
    pairs.set(id, { ...existing, ...updates });
    persistState();
  }
}

export function getPair(id: string): ArbPair | undefined {
  return pairs.get(id);
}

export function getAllPairs(): ArbPair[] {
  return Array.from(pairs.values());
}

export function getOpenPairs(): ArbPair[] {
  return getAllPairs().filter(
    (p) => p.status === "pending" || p.status === "partial",
  );
}

export function settlePair(id: string, realizedPnl: number): void {
  const pair = pairs.get(id);
  if (!pair) return;
  pairs.set(id, {
    ...pair,
    status: "filled",
    yesRemainingSize: 0,
    noRemainingSize: 0,
    settledAt: new Date().toISOString(),
    realizedPnl,
  });
  totalRealizedPnl += realizedPnl;
  persistState();
}

export function cancelPair(id: string): void {
  const pair = pairs.get(id);
  if (!pair) return;
  pairs.set(id, { ...pair, status: "cancelled" });
  persistState();
}

// ── NegRisk pairs ─────────────────────────────────────────────────────────────

export function addNegRiskPair(pair: NegRiskPair): void {
  negRiskPairs.set(pair.id, pair);
  persistState();
}

export function updateNegRiskPair(
  id: string,
  updates: Partial<NegRiskPair>,
): void {
  const existing = negRiskPairs.get(id);
  if (existing) {
    negRiskPairs.set(id, { ...existing, ...updates });
    persistState();
  }
}

export function getNegRiskPair(id: string): NegRiskPair | undefined {
  return negRiskPairs.get(id);
}

export function getAllNegRiskPairs(): NegRiskPair[] {
  return Array.from(negRiskPairs.values());
}

export function getOpenNegRiskPairs(): NegRiskPair[] {
  return getAllNegRiskPairs().filter(
    (p) => p.status === "pending" || p.status === "partial",
  );
}

export function settleNegRiskPair(id: string, realizedPnl: number): void {
  const pair = negRiskPairs.get(id);
  if (!pair) return;
  negRiskPairs.set(id, {
    ...pair,
    status: "filled",
    legs: pair.legs.map((l) => ({ ...l, remainingSize: 0 })),
    settledAt: new Date().toISOString(),
    realizedPnl,
  });
  totalRealizedPnl += realizedPnl;
  persistState();
}

export function cancelNegRiskPair(id: string): void {
  const pair = negRiskPairs.get(id);
  if (!pair) return;
  negRiskPairs.set(id, { ...pair, status: "cancelled" });
  persistState();
}

// ── Aggregates ────────────────────────────────────────────────────────────────

export function getTotalRealizedPnl(): number {
  return totalRealizedPnl;
}

export function getOpenPositionsCount(): number {
  return getOpenPairs().length + getOpenNegRiskPairs().length;
}
