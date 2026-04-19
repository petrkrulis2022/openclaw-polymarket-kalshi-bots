/**
 * inventory.ts — tracks resolution-lag positions.
 */

export type PositionStatus = "open" | "resolved" | "expired";

export interface LagPosition {
  id: string;
  marketId: string;
  marketQuestion: string;
  tokenId: string;
  boughtAt: number;
  size: number;
  costBasis: number;
  expectedYield: number;
  orderId: string;
  status: PositionStatus;
  openedAt: string;
  resolvedAt?: string;
  realizedPnl?: number;
}

const positions = new Map<string, LagPosition>();
let totalRealizedPnl = 0;

export function addPosition(pos: LagPosition): void {
  positions.set(pos.id, pos);
}

export function updatePosition(id: string, updates: Partial<LagPosition>): void {
  const existing = positions.get(id);
  if (existing) positions.set(id, { ...existing, ...updates });
}

export function getAllPositions(): LagPosition[] {
  return Array.from(positions.values());
}

export function getOpenPositions(): LagPosition[] {
  return getAllPositions().filter((p) => p.status === "open");
}

export function hasOpenPosition(marketId: string): boolean {
  return getOpenPositions().some((p) => p.marketId === marketId);
}

export function resolvePosition(id: string, settledPrice: number): void {
  const pos = positions.get(id);
  if (!pos) return;
  const realizedPnl = (settledPrice - pos.boughtAt) * pos.size;
  positions.set(id, {
    ...pos,
    status: "resolved",
    resolvedAt: new Date().toISOString(),
    realizedPnl,
  });
  totalRealizedPnl += realizedPnl;
}

export function getTotalRealizedPnl(): number {
  return totalRealizedPnl;
}

export function getOpenPositionsCount(): number {
  return getOpenPositions().length;
}
