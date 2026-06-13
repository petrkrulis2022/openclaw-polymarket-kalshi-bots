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
  } catch {
    /* non-fatal */
  }
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
    console.warn(
      "[inventory] Failed to load persisted state:",
      (err as Error).message,
    );
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

/**
 * Record an on-chain CTF merge of `amount` matched YES+NO pairs into USDC.
 * Each merged pair returns exactly $1, so realized profit is
 * 1 − (yesAvg + noAvg) per pair — the spread we captured by acquiring both
 * legs below $1. Reduces both legs and books the profit on the YES leg.
 * Returns the number of pairs actually merged (capped by held inventory).
 */
export function recordMerge(
  yesTokenId: string,
  noTokenId: string,
  amount: number,
): number {
  const yes = inventory.get(yesTokenId);
  const no = inventory.get(noTokenId);
  if (!yes || !no) return 0;
  const merged = Math.min(amount, yes.netSize, no.netSize);
  if (merged <= 0) return 0;

  yes.realizedPnl += merged * (1 - yes.avgPrice - no.avgPrice);
  yes.netSize -= merged;
  no.netSize -= merged;
  if (yes.netSize < 1e-9) yes.netSize = 0;
  if (no.netSize < 1e-9) no.netSize = 0;

  inventory.set(yesTokenId, yes);
  inventory.set(noTokenId, no);
  persistState();
  return merged;
}

/**
 * Net directional skew across both legs of a binary market, as a signed
 * fraction of the per-market allocation. Positive = net long YES exposure,
 * negative = net long NO. Used to throttle the side that would grow our
 * existing imbalance further.
 */
export function getNetSkew(
  yesTokenId: string,
  noTokenId: string,
  allocated: number,
): number {
  if (allocated <= 0) return 0;
  const yes = getPosition(yesTokenId);
  const no = getPosition(noTokenId);
  const yesValue = yes.netSize * yes.avgPrice;
  const noValue = no.netSize * no.avgPrice;
  return (yesValue - noValue) / allocated;
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
