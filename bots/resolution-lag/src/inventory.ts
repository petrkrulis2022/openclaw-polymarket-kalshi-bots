/**
 * inventory.ts — tracks resolution-lag positions.
 */

import "dotenv/config";
import fs from "fs";

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

// ── Persistence ───────────────────────────────────────────────────────────────
const STATE_FILE = process.env["POSITIONS_STATE_FILE"] ?? "";

function persistState(): void {
  if (!STATE_FILE) return;
  try {
    const data = {
      positions: Array.from(positions.values()),
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
      positions: LagPosition[];
      totalRealizedPnl: number;
    };
    positions.clear();
    for (const p of raw.positions ?? []) positions.set(p.id, p);
    totalRealizedPnl = raw.totalRealizedPnl ?? 0;
    console.log(`[inventory] Loaded ${positions.size} position(s) from disk.`);
  } catch (err) {
    console.warn(
      "[inventory] Failed to load persisted state:",
      (err as Error).message,
    );
  }
}

export function addPosition(pos: LagPosition): void {
  positions.set(pos.id, pos);
  persistState();
}

export function updatePosition(
  id: string,
  updates: Partial<LagPosition>,
): void {
  const existing = positions.get(id);
  if (existing) {
    positions.set(id, { ...existing, ...updates });
    persistState();
  }
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
  persistState();
}

export function getTotalRealizedPnl(): number {
  return totalRealizedPnl;
}

export function getOpenPositionsCount(): number {
  return getOpenPositions().length;
}
