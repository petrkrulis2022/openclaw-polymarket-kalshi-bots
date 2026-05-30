/**
 * inventory.ts — tracks per-market positions for microstructure bot.
 */
import fs from "fs";

export interface MicroPosition {
  marketId: string;
  marketQuestion: string;
  yesTokenId: string;
  endDate: string;
  daysToExpiry: number;
  /** Current resting bid order ID (null if not placed) */
  bidOrderId: string | null;
  bidPrice: number;
  /** Estimated remaining size on currently open bid order */
  bidOrderRemainingSize: number;
  /** Current resting ask order ID after fill (null if not placed) */
  askOrderId: string | null;
  askPrice: number;
  /** Estimated remaining size on currently open ask order */
  askOrderRemainingSize: number;
  /** Total shares held from fills */
  heldShares: number;
  /** Total USD spent on buys */
  totalCost: number;
  /** Total USD received from sells */
  totalRevenue: number;
  realizedPnl: number;
  lastUpdated: string;
}

const positions = new Map<string, MicroPosition>();
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
  } catch { /* non-fatal */ }
}

export function loadPersistedState(): void {
  if (!STATE_FILE || !fs.existsSync(STATE_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as {
      positions: MicroPosition[];
      totalRealizedPnl: number;
    };
    positions.clear();
    for (const p of raw.positions ?? []) positions.set(p.marketId, p);
    totalRealizedPnl = raw.totalRealizedPnl ?? 0;
    console.log(`[inventory] Loaded ${positions.size} position(s) from disk.`);
  } catch (err) {
    console.warn("[inventory] Failed to load persisted state:", (err as Error).message);
  }
}

export function upsertPosition(
  marketId: string,
  update: Partial<MicroPosition> & Pick<MicroPosition, "marketId">,
): void {
  const existing = positions.get(marketId);
  if (existing) {
    positions.set(marketId, {
      ...existing,
      ...update,
      lastUpdated: new Date().toISOString(),
    });
  } else {
    positions.set(marketId, {
      marketQuestion: "",
      yesTokenId: "",
      endDate: "",
      daysToExpiry: 0,
      bidOrderId: null,
      bidPrice: 0,
      bidOrderRemainingSize: 0,
      askOrderId: null,
      askPrice: 0,
      askOrderRemainingSize: 0,
      heldShares: 0,
      totalCost: 0,
      totalRevenue: 0,
      realizedPnl: 0,
      lastUpdated: new Date().toISOString(),
      ...update,
    });
  }
}

export function getPosition(marketId: string): MicroPosition | undefined {
  return positions.get(marketId);
}

export function getAllPositions(): MicroPosition[] {
  return Array.from(positions.values());
}

export function recordFill(
  marketId: string,
  fillPrice: number,
  fillSize: number,
  options?: { clearBidOrderId?: boolean },
): void {
  const pos = positions.get(marketId);
  if (!pos) return;
  const cost = fillPrice * fillSize;
  positions.set(marketId, {
    ...pos,
    heldShares: pos.heldShares + fillSize,
    totalCost: pos.totalCost + cost,
    bidOrderId: options?.clearBidOrderId === false ? pos.bidOrderId : null,
    bidOrderRemainingSize:
      options?.clearBidOrderId === false
        ? Math.max(0, pos.bidOrderRemainingSize - fillSize)
        : 0,
    lastUpdated: new Date().toISOString(),
  });
  persistState();
}

export function recordSell(
  marketId: string,
  sellPrice: number,
  sellSize: number,
  options?: { clearAskOrderId?: boolean },
): void {
  const pos = positions.get(marketId);
  if (!pos) return;
  const revenue = sellPrice * sellSize;
  const avgCost = pos.heldShares > 0 ? pos.totalCost / pos.heldShares : 0;
  const pnl = (sellPrice - avgCost) * sellSize;
  totalRealizedPnl += pnl;
  positions.set(marketId, {
    ...pos,
    heldShares: Math.max(0, pos.heldShares - sellSize),
    totalRevenue: pos.totalRevenue + revenue,
    realizedPnl: pos.realizedPnl + pnl,
    askOrderId: options?.clearAskOrderId === false ? pos.askOrderId : null,
    askOrderRemainingSize:
      options?.clearAskOrderId === false
        ? Math.max(0, pos.askOrderRemainingSize - sellSize)
        : 0,
    lastUpdated: new Date().toISOString(),
  });
  persistState();
}

export function getTotalRealizedPnl(): number {
  return totalRealizedPnl;
}

export function getOpenPositionsCount(): number {
  return getAllPositions().filter(
    (p) => p.bidOrderId !== null || p.heldShares > 0,
  ).length;
}
