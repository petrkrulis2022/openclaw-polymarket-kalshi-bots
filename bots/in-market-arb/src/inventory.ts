/**
 * inventory.ts — tracks locked YES+NO arb pairs.
 * A "locked" pair is a pending or filled arb where both legs have been placed.
 */
import fs from "fs";

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
  yesRemainingSize: number;
  noRemainingSize: number;
  sizeUsd: number;
  status: PairStatus;
  createdAt: string;
  settledAt?: string;
  realizedPnl?: number;
}

const pairs = new Map<string, ArbPair>();
let totalRealizedPnl = 0;

// ── Persistence ───────────────────────────────────────────────────────────────
const STATE_FILE = process.env["POSITIONS_STATE_FILE"] ?? "";

function persistState(): void {
  if (!STATE_FILE) return;
  try {
    const data = {
      pairs: Array.from(pairs.values()),
      totalRealizedPnl,
      savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch { /* non-fatal */ }
}

export function loadPersistedState(): void {
  if (!STATE_FILE || !fs.existsSync(STATE_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as {
      pairs: ArbPair[];
      totalRealizedPnl: number;
    };
    pairs.clear();
    for (const p of raw.pairs ?? []) pairs.set(p.id, p);
    totalRealizedPnl = raw.totalRealizedPnl ?? 0;
    console.log(`[inventory] Loaded ${pairs.size} arb pair(s) from disk.`);
  } catch (err) {
    console.warn("[inventory] Failed to load persisted state:", (err as Error).message);
  }
}

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

export function getTotalRealizedPnl(): number {
  return totalRealizedPnl;
}

export function getOpenPositionsCount(): number {
  return getOpenPairs().length;
}
