// Tracks net inventory per market token to detect imbalance
import fs from "fs";

export interface InventoryPosition {
  tokenId: string;
  netSize: number; // positive = long YES, negative = short/long NO
  avgPrice: number;
  realizedPnl: number;
}

const inventory = new Map<string, InventoryPosition>();

// ── Persistence ───────────────────────────────────────────────────────────────
const STATE_FILE = process.env["POSITIONS_STATE_FILE"] ?? "";

function persistState(): void {
  if (!STATE_FILE) return;
  try {
    const data = {
      positions: Array.from(inventory.values()),
      savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch { /* non-fatal */ }
}

export function loadPersistedState(): void {
  if (!STATE_FILE || !fs.existsSync(STATE_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as {
      positions: InventoryPosition[];
    };
    inventory.clear();
    for (const p of raw.positions ?? []) inventory.set(p.tokenId, p);
    console.log(`[inventory] Loaded ${inventory.size} position(s) from disk.`);
  } catch (err) {
    console.warn("[inventory] Failed to load persisted state:", (err as Error).message);
  }
}

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
  persistState();
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
  persistState();
}
