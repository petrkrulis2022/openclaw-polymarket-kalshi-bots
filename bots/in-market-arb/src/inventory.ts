/**
 * inventory.ts — tracks locked YES+NO arb pairs.
 * A "locked" pair is a pending or filled arb where both legs have been placed.
 */

export type PairStatus = "pending" | "filled" | "partial" | "cancelled";

export interface ArbPair {
  id: string;
  marketId: string;
  marketQuestion: string;
  yesTokenId: string;
  noTokenId: string;
  yesOrderId: string;
  noOrderId: string;
  yesPrice: number;
  noPrice: number;
  sizeUsd: number;
  status: PairStatus;
  createdAt: string;
  settledAt?: string;
  realizedPnl?: number;
}

const pairs = new Map<string, ArbPair>();
let totalRealizedPnl = 0;

export function addPair(pair: ArbPair): void {
  pairs.set(pair.id, pair);
}

export function updatePair(id: string, updates: Partial<ArbPair>): void {
  const existing = pairs.get(id);
  if (existing) pairs.set(id, { ...existing, ...updates });
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
    settledAt: new Date().toISOString(),
    realizedPnl,
  });
  totalRealizedPnl += realizedPnl;
}

export function cancelPair(id: string): void {
  const pair = pairs.get(id);
  if (!pair) return;
  pairs.set(id, { ...pair, status: "cancelled" });
}

export function getTotalRealizedPnl(): number {
  return totalRealizedPnl;
}

export function getOpenPositionsCount(): number {
  return getOpenPairs().length;
}
