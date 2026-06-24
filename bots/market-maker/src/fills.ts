/**
 * fills.ts — live fill detection by order-ID attribution.
 *
 * The bot shares one Polymarket proxy wallet with the user's other bots, so we
 * cannot seed inventory from raw wallet trade history — it would mix in other
 * bots' fills. Instead we remember every order ID *this* bot places and, each
 * poll, match the wallet's trades against that set via `maker_orders[].order_id`
 * (and `taker_order_id`). Only our own fills update inventory.
 *
 * Without this, live fills never reach inventory: the SELL/recycle paths and
 * inventory-skew controls stay blind and the bot degrades into buy-and-hold.
 */
import fs from "fs";
import { fetchRawTrades } from "./venue/index.js";
import { recordFill } from "./inventory.js";
import { recordAttribution } from "./attribution.js";
import { logActivity } from "./activity.js";

export interface OrderMeta {
  tokenId: string;
  conditionId: string;
  question: string;
  yesTokenId: string;
  noTokenId: string;
}

// Bound memory and the persisted file. Maps/Sets preserve insertion order, so
// evicting the first key drops the oldest entry.
const MAX_TRACKED = 5000;
const ourOrders = new Map<string, OrderMeta>();
const seenTrades = new Set<string>();

const STATE_FILE =
  process.env["FILLS_STATE_FILE"] ??
  (process.env["POSITIONS_STATE_FILE"]
    ? process.env["POSITIONS_STATE_FILE"].replace(/\.json$/, "-fills.json")
    : "");

function persist(): void {
  if (!STATE_FILE) return;
  try {
    const data = {
      ourOrders: Array.from(ourOrders.entries()),
      seenTrades: Array.from(seenTrades),
      savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(data), "utf-8");
  } catch {
    /* non-fatal */
  }
}

export function loadFillsState(): void {
  if (!STATE_FILE || !fs.existsSync(STATE_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as {
      ourOrders?: Array<[string, OrderMeta]>;
      seenTrades?: string[];
    };
    ourOrders.clear();
    seenTrades.clear();
    for (const [id, meta] of raw.ourOrders ?? []) ourOrders.set(id, meta);
    for (const id of raw.seenTrades ?? []) seenTrades.add(id);
    console.log(
      `[fills] Loaded ${ourOrders.size} tracked order(s), ${seenTrades.size} seen trade(s).`,
    );
  } catch (err) {
    console.warn("[fills] Failed to load state:", (err as Error).message);
  }
}

/** Remember an order we placed so we can attribute its fills to us later. */
export function registerOrder(orderId: string, meta: OrderMeta): void {
  if (!orderId || orderId === "unknown" || orderId.startsWith("paper-")) return;
  ourOrders.set(orderId, meta);
  while (ourOrders.size > MAX_TRACKED) {
    const oldest = ourOrders.keys().next().value;
    if (oldest === undefined) break;
    ourOrders.delete(oldest);
  }
  persist();
}

function markSeen(tradeId: string): void {
  seenTrades.add(tradeId);
  while (seenTrades.size > MAX_TRACKED) {
    const oldest = seenTrades.values().next().value;
    if (oldest === undefined) break;
    seenTrades.delete(oldest);
  }
}

/**
 * Poll wallet trades and fold any fills of *our* orders into inventory.
 * Only finalised (CONFIRMED) trades are counted; non-final ones are left
 * unmarked so they're revisited once they settle. Each trade is processed once.
 */
export async function pollFills(): Promise<void> {
  if (ourOrders.size === 0) return;

  const trades = await fetchRawTrades();
  let recorded = 0;

  for (const t of trades) {
    if (!t.id || seenTrades.has(t.id)) continue;

    const status = t.status.toUpperCase();
    if (status !== "CONFIRMED") {
      if (status === "FAILED") markSeen(t.id); // terminal, never counts
      continue;
    }

    const fills: Array<{
      meta: OrderMeta;
      side: "BUY" | "SELL";
      price: number;
      size: number;
    }> = [];

    // Our resting (maker) orders that this trade matched against.
    for (const mo of t.makerOrders) {
      const meta = ourOrders.get(mo.orderId);
      if (!meta) continue;
      const size = parseFloat(mo.matchedAmount);
      const price = parseFloat(mo.price);
      if (size > 0 && price > 0) {
        fills.push({
          meta,
          side: mo.side.toUpperCase() === "SELL" ? "SELL" : "BUY",
          price,
          size,
        });
      }
    }

    // Rare: one of our orders crossed the book and took liquidity.
    if (t.takerOrderId && ourOrders.has(t.takerOrderId)) {
      const meta = ourOrders.get(t.takerOrderId)!;
      const size = parseFloat(t.size);
      const price = parseFloat(t.price);
      if (size > 0 && price > 0) {
        fills.push({
          meta,
          side: t.side.toUpperCase() === "SELL" ? "SELL" : "BUY",
          price,
          size,
        });
      }
    }

    if (fills.length === 0) {
      markSeen(t.id);
      continue;
    }

    for (const f of fills) {
      recordFill(f.meta.tokenId, f.side, f.price, f.size);
      const isYes = f.meta.tokenId === f.meta.yesTokenId;
      recordAttribution(
        f.meta.conditionId,
        f.meta.tokenId,
        isYes ? 0 : 1,
        isYes ? "YES" : "NO",
        f.meta.question,
      );
      logActivity("fill", {
        side: f.side,
        token: isYes ? "YES" : "NO",
        price: f.price,
        size: f.size,
        market: f.meta.question.slice(0, 60),
      });
      console.log(
        `[fills] ${f.side} ${f.size.toFixed(2)} ${isYes ? "YES" : "NO"} @ ${f.price.toFixed(4)} | ${f.meta.question.slice(0, 40)}`,
      );
      recorded++;
    }
    markSeen(t.id);
  }

  if (recorded > 0) persist();
}
