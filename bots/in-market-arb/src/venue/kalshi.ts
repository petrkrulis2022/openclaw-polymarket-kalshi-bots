/**
 * venue/kalshi.ts — Kalshi backend for in-market-arb, normalized to the same
 * contract the Polymarket clob.ts exposes (getOrderBook(ref) → {bids,asks}).
 *
 * Adapted from kalshi-arb/src/kalshi.ts. Auth: RSA-PSS / SHA-256; sign string =
 * timestamp_ms + METHOD + path (no query). The Kalshi book returns bids only;
 * the ask for a side = 1 − opposite-side bid.
 *
 * Market reference scheme: a Kalshi "token" is (ticker, side), encoded as the
 * ref string "<ticker>:<yes|no>" so the rest of the bot can treat it like a
 * Polymarket tokenId.
 */

import crypto from "crypto";
import { config } from "../config.js";
import type { OrderBook, OrderResult } from "../clob.js";
import type { BinaryMarket } from "../scanner.js";

// ── Ref helpers ─────────────────────────────────────────────────────────────
export function makeRef(ticker: string, side: "yes" | "no"): string {
  return `${ticker}:${side}`;
}
function parseRef(ref: string): { ticker: string; side: "yes" | "no" } {
  const idx = ref.lastIndexOf(":");
  const side = ref.slice(idx + 1) === "no" ? "no" : "yes";
  return { ticker: ref.slice(0, idx), side };
}

// ── Auth ────────────────────────────────────────────────────────────────────
const _hostPathPrefix = new URL(config.kalshi.host).pathname; // "/trade-api/v2"

function kalshiHeaders(method: string, path: string): Record<string, string> {
  const ts = String(Date.now());
  const fullPath = _hostPathPrefix + path.split("?")[0];
  const msg = Buffer.from(ts + method.toUpperCase() + fullPath);
  const sig = crypto.sign("sha256", msg, {
    key: config.kalshi.privateKeyPem,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return {
    "KALSHI-ACCESS-KEY": config.kalshi.apiKeyId,
    "KALSHI-ACCESS-TIMESTAMP": ts,
    "KALSHI-ACCESS-SIGNATURE": sig.toString("base64"),
    "Content-Type": "application/json",
  };
}

async function kalshiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${config.kalshi.host}${path}`, {
    headers: kalshiHeaders("GET", path),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok)
    throw new Error(`Kalshi GET ${path} → ${res.status}: ${await res.text().catch(() => "")}`);
  return res.json() as Promise<T>;
}

async function kalshiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${config.kalshi.host}${path}`, {
    method: "POST",
    headers: kalshiHeaders("POST", path),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok)
    throw new Error(`Kalshi POST ${path} → ${res.status}: ${await res.text().catch(() => "")}`);
  return res.json() as Promise<T>;
}

async function kalshiDelete(path: string): Promise<void> {
  const res = await fetch(`${config.kalshi.host}${path}`, {
    method: "DELETE",
    headers: kalshiHeaders("DELETE", path),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok)
    throw new Error(`Kalshi DELETE ${path} → ${res.status}: ${await res.text().catch(() => "")}`);
}

// ── Market listing ──────────────────────────────────────────────────────────
interface RawMarket {
  ticker?: string;
  title?: string;
  event_title?: string;
  yes_sub_title?: string;
  close_time?: string;
  status?: string;
}

export async function listBinaryMarkets(): Promise<BinaryMarket[]> {
  const out: BinaryMarket[] = [];
  const seen = new Set<string>();
  try {
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const qs = `status=open&limit=200${cursor ? `&cursor=${cursor}` : ""}`;
      const raw = await kalshiGet<{ markets?: RawMarket[]; cursor?: string }>(
        `/markets?${qs}`,
      );
      for (const m of raw.markets ?? []) {
        const ticker = m.ticker ?? "";
        if (!ticker || seen.has(ticker)) continue;
        seen.add(ticker);
        out.push({
          id: ticker,
          conditionId: "", // Kalshi has no on-chain conditionId / merge
          question: (m.title ?? m.event_title ?? m.yes_sub_title ?? ticker).trim(),
          yesTokenId: makeRef(ticker, "yes"),
          noTokenId: makeRef(ticker, "no"),
          endDate: m.close_time ?? "",
          feeRate: config.kalshi.feeRate,
        });
      }
      cursor = raw.cursor;
      if (!cursor || (raw.markets ?? []).length < 200) break;
    }
  } catch (err) {
    console.error("[kalshi] listBinaryMarkets error:", (err as Error).message);
  }
  return out;
}

// ── Order book (normalized to {bids, asks}) ─────────────────────────────────
interface RawOrderBook {
  orderbook_fp?: {
    yes_dollars?: [string, string][];
    no_dollars?: [string, string][];
  };
}

/**
 * Return the {bids, asks} book for one side of a Kalshi market.
 * Kalshi only publishes bids; the ask for our side at price P is the implied
 * fill against an opposite-side bid at (1 − P).
 */
export async function getOrderBook(ref: string): Promise<OrderBook> {
  const { ticker, side } = parseRef(ref);
  try {
    const raw = await kalshiGet<RawOrderBook>(
      `/markets/${encodeURIComponent(ticker)}/orderbook`,
    );
    const fp = raw.orderbook_fp ?? {};
    const parse = (arr: [string, string][] = []) =>
      arr
        .map(([p, s]) => ({ price: parseFloat(p), size: parseFloat(s) }))
        .filter((b) => b.price > 0 && b.size > 0);

    const yesBids = parse(fp.yes_dollars);
    const noBids = parse(fp.no_dollars);

    const ourBids = side === "yes" ? yesBids : noBids;
    const oppBids = side === "yes" ? noBids : yesBids;

    // bids for our side: descending (best/highest first)
    const bids = [...ourBids].sort((a, b) => b.price - a.price);
    // asks for our side: 1 − opposite bid, ascending (best/lowest first)
    const asks = oppBids
      .map((b) => ({ price: 1 - b.price, size: b.size }))
      .filter((a) => a.price > 0 && a.price < 1)
      .sort((a, b) => a.price - b.price);

    return { bids, asks };
  } catch (err) {
    console.error(`[kalshi] getOrderBook(${ref}) error:`, (err as Error).message);
    return { bids: [], asks: [] };
  }
}

// ── Balance ─────────────────────────────────────────────────────────────────
export async function getCollateralBalance(): Promise<number> {
  try {
    const raw = await kalshiGet<{ balance?: { available?: string | number } }>(
      "/portfolio/balance",
    );
    const avail = raw.balance?.available;
    if (avail === undefined) return 0;
    const n = typeof avail === "string" ? parseFloat(avail) : avail;
    return n / 100; // cents → dollars
  } catch (err) {
    console.warn("[kalshi] getCollateralBalance error:", (err as Error).message);
    return 0;
  }
}

// ── Positions (contracts held on one side) ──────────────────────────────────
export async function getPositionContracts(ref: string): Promise<number | null> {
  const { ticker, side } = parseRef(ref);
  try {
    const raw = await kalshiGet<{
      market_positions?: Array<{ ticker?: string; position?: number }>;
    }>(`/portfolio/positions?ticker=${encodeURIComponent(ticker)}`);
    const entry = (raw.market_positions ?? []).find((p) => p.ticker === ticker);
    const signed = entry?.position ?? 0;
    return side === "yes" ? Math.max(0, signed) : Math.max(0, -signed);
  } catch (err) {
    console.warn(`[kalshi] getPositionContracts(${ref}) error:`, (err as Error).message);
    return null;
  }
}

// ── Order placement (FOK) ────────────────────────────────────────────────────
interface RawOrderResponse {
  order?: { order_id?: string };
  order_id?: string;
}

async function placeKalshiOrder(
  ticker: string,
  side: "yes" | "no",
  price: number,
  sizeUsd: number,
  action: "buy" | "sell",
): Promise<OrderResult> {
  const count = Math.max(1, Math.round(sizeUsd / price));
  const body = {
    ticker,
    action,
    outcome_side: side,
    price: price.toFixed(4),
    count: count.toFixed(2),
    time_in_force: "fill_or_kill",
    self_trade_prevention_type: "taker_at_cross",
    client_order_id: `ima-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  };
  const raw = await kalshiPost<RawOrderResponse>("/portfolio/events/orders", body);
  const orderId =
    raw.order?.order_id ??
    ((raw as Record<string, unknown>)["order_id"] as string) ??
    "unknown";
  return { orderId };
}

/** Marketable FOK BUY of `sizeShares` contracts of `ref` at up to `price`. */
export async function placeBuy(
  ref: string,
  price: number,
  sizeShares: number,
): Promise<OrderResult> {
  const { ticker, side } = parseRef(ref);
  return placeKalshiOrder(ticker, side, price, sizeShares * price, "buy");
}

/** Marketable FOK SELL of `sizeShares` contracts of `ref` at `price` (unwind). */
export async function placeSell(
  ref: string,
  price: number,
  sizeShares: number,
): Promise<OrderResult> {
  const { ticker, side } = parseRef(ref);
  return placeKalshiOrder(ticker, side, price, sizeShares * price, "sell");
}

export async function cancelOrder(orderId: string): Promise<void> {
  try {
    await kalshiDelete(`/portfolio/orders/${encodeURIComponent(orderId)}`);
  } catch (err) {
    console.warn(`[kalshi] cancelOrder(${orderId}) error:`, (err as Error).message);
  }
}

/** FOK orders never rest, so there are no open orders to reconcile. */
export async function getOpenOrders(): Promise<
  Array<{ id: string; side: string; tokenId: string; remainingSize: number; originalSize: number }>
> {
  return [];
}
