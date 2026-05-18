/**
 * inventory.ts — tracks resolution-lag positions.
 */

import "dotenv/config";

const ORCHESTRATOR_URL =
  process.env["ORCHESTRATOR_URL"] ?? "http://localhost:3002";
const BOT_ID = 5;

async function persistTrade(
  pos: LagPosition,
  settledPrice: number,
  realizedPnl: number,
) {
  try {
    await fetch(`${ORCHESTRATOR_URL}/trades`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        botId: BOT_ID,
        marketId: pos.marketId,
        marketQuestion: pos.marketQuestion,
        tokenId: pos.tokenId,
        outcome: "YES", // resolution-lag always buys YES shares
        shares: pos.size,
        avgPrice: pos.boughtAt,
        settledPrice,
        realizedPnl,
        openedAt: pos.openedAt,
        closedAt: new Date().toISOString(),
        status: realizedPnl > 0 ? "won" : "lost",
      }),
    });
  } catch (err) {
    console.warn(
      "[inventory] failed to persist trade:",
      (err as Error).message,
    );
  }
}

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

export function updatePosition(
  id: string,
  updates: Partial<LagPosition>,
): void {
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
  void persistTrade(pos, settledPrice, realizedPnl);
}

export function getTotalRealizedPnl(): number {
  return totalRealizedPnl;
}

export function getOpenPositionsCount(): number {
  return getOpenPositions().length;
}
