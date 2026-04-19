/**
 * inventory.ts — tracks our own copy-trade positions in memory.
 * Same shape as market-maker but also tracks which trader triggered each position.
 */

export interface InventoryPosition {
  tokenId: string;
  /** Label of the trader whose signal created this position */
  sourceTrader: string;
  netSize: number;
  avgPrice: number;
  realizedPnl: number;
}

// keyed by tokenId
const positions = new Map<string, InventoryPosition>();

export function recordFill(
  tokenId: string,
  sourceTrader: string,
  side: "BUY" | "SELL",
  price: number,
  size: number,
): void {
  const pos = positions.get(tokenId) ?? {
    tokenId,
    sourceTrader,
    netSize: 0,
    avgPrice: 0,
    realizedPnl: 0,
  };

  if (side === "BUY") {
    const totalCost = pos.netSize * pos.avgPrice + size * price;
    pos.netSize += size;
    pos.avgPrice = pos.netSize > 0 ? totalCost / pos.netSize : price;
  } else {
    const pnl = (price - pos.avgPrice) * size;
    pos.realizedPnl += pnl;
    pos.netSize = Math.max(0, pos.netSize - size);
    if (pos.netSize === 0) pos.avgPrice = 0;
  }

  if (pos.netSize > 0.001) {
    positions.set(tokenId, pos);
  } else {
    // Zero-out but keep realized PnL record if non-trivial
    if (Math.abs(pos.realizedPnl) > 0.001) {
      pos.netSize = 0;
      pos.avgPrice = 0;
      positions.set(tokenId, pos);
    } else {
      positions.delete(tokenId);
    }
  }
}

export function getPosition(tokenId: string): InventoryPosition | undefined {
  return positions.get(tokenId);
}

export function getAllPositions(): InventoryPosition[] {
  return Array.from(positions.values());
}

export function getTotalRealizedPnl(): number {
  let total = 0;
  for (const p of positions.values()) total += p.realizedPnl;
  return total;
}

export function initFromTrades(
  trades: Array<{
    asset_id: string;
    side: string;
    price: string;
    size: string;
    maker_address: string;
  }>,
): void {
  positions.clear();
  for (const t of trades) {
    recordFill(
      t.asset_id,
      "restored",
      t.side.toUpperCase() === "BUY" ? "BUY" : "SELL",
      parseFloat(t.price),
      parseFloat(t.size),
    );
  }
}
