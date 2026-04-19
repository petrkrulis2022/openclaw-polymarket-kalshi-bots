/**
 * inventory.ts — tracks per-market positions for microstructure bot.
 */

export interface MicroPosition {
  marketId: string;
  marketQuestion: string;
  yesTokenId: string;
  endDate: string;
  daysToExpiry: number;
  /** Current resting bid order ID (null if not placed) */
  bidOrderId: string | null;
  bidPrice: number;
  /** Current resting ask order ID after fill (null if not placed) */
  askOrderId: string | null;
  askPrice: number;
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

export function upsertPosition(
  marketId: string,
  update: Partial<MicroPosition> & Pick<MicroPosition, "marketId">,
): void {
  const existing = positions.get(marketId);
  if (existing) {
    positions.set(marketId, { ...existing, ...update, lastUpdated: new Date().toISOString() });
  } else {
    positions.set(marketId, {
      marketQuestion: "",
      yesTokenId: "",
      endDate: "",
      daysToExpiry: 0,
      bidOrderId: null,
      bidPrice: 0,
      askOrderId: null,
      askPrice: 0,
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

export function recordFill(marketId: string, fillPrice: number, fillSize: number): void {
  const pos = positions.get(marketId);
  if (!pos) return;
  const cost = fillPrice * fillSize;
  positions.set(marketId, {
    ...pos,
    heldShares: pos.heldShares + fillSize,
    totalCost: pos.totalCost + cost,
    bidOrderId: null, // filled — clear bid
    lastUpdated: new Date().toISOString(),
  });
}

export function recordSell(marketId: string, sellPrice: number, sellSize: number): void {
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
    askOrderId: null,
    lastUpdated: new Date().toISOString(),
  });
}

export function getTotalRealizedPnl(): number {
  return totalRealizedPnl;
}

export function getOpenPositionsCount(): number {
  return getAllPositions().filter(
    (p) => p.bidOrderId !== null || p.heldShares > 0,
  ).length;
}
