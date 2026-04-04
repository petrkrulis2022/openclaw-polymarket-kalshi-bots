// Tracks net inventory per market token to detect imbalance
export interface InventoryPosition {
  tokenId: string;
  netSize: number; // positive = long YES, negative = short/long NO
  avgPrice: number;
  realizedPnl: number;
}

const inventory = new Map<string, InventoryPosition>();

export function recordFill(
  tokenId: string,
  side: "BUY" | "SELL",
  price: number,
  size: number,
): void {
  const pos = inventory.get(tokenId) ?? {
    tokenId,
    netSize: 0,
    avgPrice: 0,
    realizedPnl: 0,
  };

  if (side === "BUY") {
    const totalCost = pos.netSize * pos.avgPrice + size * price;
    pos.netSize += size;
    pos.avgPrice = pos.netSize > 0 ? totalCost / pos.netSize : 0;
  } else {
    const pnl = (price - pos.avgPrice) * Math.min(size, pos.netSize);
    pos.realizedPnl += pnl;
    pos.netSize -= size;
    if (pos.netSize < 0) pos.netSize = 0; // clamp
  }

  inventory.set(tokenId, pos);
}

export function getPosition(tokenId: string): InventoryPosition {
  return (
    inventory.get(tokenId) ?? {
      tokenId,
      netSize: 0,
      avgPrice: 0,
      realizedPnl: 0,
    }
  );
}

export function getTotalRealizedPnl(): number {
  let total = 0;
  for (const pos of inventory.values()) total += pos.realizedPnl;
  return total;
}

export function getSkew(
  tokenId: string,
  totalAllocated: number,
): { yesRatio: number; noRatio: number } {
  const pos = getPosition(tokenId);
  if (totalAllocated <= 0) return { yesRatio: 0, noRatio: 0 };
  const yesRatio = (pos.netSize * pos.avgPrice) / totalAllocated;
  return { yesRatio, noRatio: 1 - yesRatio };
}

export function getAllPositions(): InventoryPosition[] {
  return Array.from(inventory.values());
}

/**
 * Seed inventory from historical trade records (e.g., fetched from CLOB on startup).
 * Replaces any existing in-memory state so we survive bot restarts.
 */
export function initFromTrades(
  trades: {
    asset_id: string;
    side: string;
    size: string;
    price: string;
    status: string;
  }[],
): void {
  inventory.clear();
  for (const t of trades) {
    if (t.status !== "CONFIRMED") continue;
    recordFill(
      t.asset_id,
      t.side as "BUY" | "SELL",
      parseFloat(t.price),
      parseFloat(t.size),
    );
  }
  const positions = Array.from(inventory.values()).filter((p) => p.netSize > 0);
  if (positions.length > 0) {
    console.log(
      `[inventory] Seeded ${positions.length} position(s) from trade history:`,
    );
    for (const p of positions) {
      console.log(
        `  tokenId=${p.tokenId.slice(0, 16)}… netSize=${p.netSize} avgPrice=${p.avgPrice.toFixed(4)}`,
      );
    }
  } else {
    console.log("[inventory] No open positions found in trade history.");
  }
}
