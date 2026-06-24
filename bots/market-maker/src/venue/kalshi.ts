/**
 * venue/kalshi.ts — Kalshi backend for market-maker, normalized to the same
 * contract clob.ts exposes (getOrderBook/placeLimitOrder/cancelOrder/
 * getOpenOrders/getCollateralBalance/fetchRawTrades/getLastTradeMid) plus
 * listMarkets() for discovery.
 *
 * Unlike in-market-arb (FOK), the market-maker rests GTC quotes, so orders are
 * placed without time_in_force (they rest in the book) and getOpenOrders +
 * fetchRawTrades (from /portfolio/fills) drive the fill loop.
 *
 * Market reference: a Kalshi "token" is (ticker, side), encoded "<ticker>:<yes|no>".
 */

import crypto from "crypto";
import { config } from "../config.js";
import type { OrderBook, OrderResult, NormalizedTrade } from "../clob.js";
import type { GammaMarket } from "../markets.js";

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
const _hostPathPrefix = new URL(config.kalshi.host).pathname;

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

// ── Order book ──────────────────────────────────────────────────────────────
interface RawOrderBook {
  orderbook_fp?: {
    yes_dollars?: [string, string][];
    no_dollars?: [string, string][];
  };
}

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
    return {
      bids: [...ourBids].sort((a, b) => b.price - a.price),
      asks: oppBids
        .map((b) => ({ price: 1 - b.price, size: b.size }))
        .filter((a) => a.price > 0 && a.price < 1)
        .sort((a, b) => a.price - b.price),
    };
  } catch (err) {
    console.error(`[kalshi] getOrderBook(${ref}) error:`, (err as Error).message);
    return { bids: [], asks: [] };
  }
}

export async function getLastTradeMid(ref: string): Promise<number> {
  const book = await getOrderBook(ref);
  const bid = book.bids[0]?.price ?? 0;
  const ask = book.asks[0]?.price ?? 0;
  return bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
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
    return n / 100;
  } catch (err) {
    console.warn("[kalshi] getCollateralBalance error:", (err as Error).message);
    return 0;
  }
}

// ── Order placement (GTC resting limit) ──────────────────────────────────────
interface RawOrderResponse {
  order?: { order_id?: string };
  order_id?: string;
}

export async function placeLimitOrder(
  ref: string,
  side: "BUY" | "SELL",
  price: number,
  size: number,
  _marketQuestion: string,
): Promise<OrderResult> {
  const { ticker, side: outcomeSide } = parseRef(ref);
  const body = {
    ticker,
    action: side === "BUY" ? "buy" : "sell",
    outcome_side: outcomeSide,
    price: price.toFixed(4),
    count: Math.max(1, Math.round(size)).toFixed(2),
    // No time_in_force → the order rests (GTC) until filled or cancelled.
    self_trade_prevention_type: "taker_at_cross",
    client_order_id: `mm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  };
  const raw = await kalshiPost<RawOrderResponse>("/portfolio/events/orders", body);
  const orderId =
    raw.order?.order_id ??
    ((raw as Record<string, unknown>)["order_id"] as string) ??
    "unknown";
  return { orderId, paper: false };
}

export async function cancelOrder(orderId: string): Promise<void> {
  if (!orderId || orderId === "unknown") return;
  try {
    await kalshiDelete(`/portfolio/orders/${encodeURIComponent(orderId)}`);
  } catch (err) {
    console.warn(`[kalshi] cancelOrder(${orderId}) error:`, (err as Error).message);
  }
}

// ── Open (resting) orders ────────────────────────────────────────────────────
interface RawRestingOrder {
  order_id?: string;
  ticker?: string;
  side?: string; // yes | no
  action?: string; // buy | sell
  yes_price?: number; // cents
  no_price?: number; // cents
  price?: number;
  remaining_count?: number;
  initial_count?: number;
}

export async function getOpenOrders(): Promise<
  Array<{
    id: string;
    tokenId: string;
    side: string;
    price: number;
    size: number;
    remainingSize: number;
    originalSize: number;
  }>
> {
  try {
    const raw = await kalshiGet<{ orders?: RawRestingOrder[] }>(
      "/portfolio/orders?status=resting",
    );
    return (raw.orders ?? []).map((o) => {
      const outcome = o.side === "no" ? "no" : "yes";
      const cents =
        (outcome === "yes" ? o.yes_price : o.no_price) ?? o.price ?? 0;
      const remaining = o.remaining_count ?? 0;
      const original = o.initial_count ?? remaining;
      return {
        id: o.order_id ?? "",
        tokenId: makeRef(o.ticker ?? "", outcome),
        // Map Kalshi action (buy/sell) to the BUY/SELL the quoter expects.
        side: (o.action ?? "buy").toUpperCase(),
        price: cents / 100,
        size: remaining,
        remainingSize: remaining,
        originalSize: original,
      };
    });
  } catch (err) {
    console.error("[kalshi] getOpenOrders error:", (err as Error).message);
    return [];
  }
}

// ── Fills (→ NormalizedTrade so the existing pollFills attribution works) ─────
interface RawFill {
  trade_id?: string;
  order_id?: string;
  ticker?: string;
  side?: string; // yes | no
  action?: string; // buy | sell
  count?: number;
  yes_price?: number; // cents
  no_price?: number; // cents
  is_taker?: boolean;
}

export async function fetchRawTrades(): Promise<NormalizedTrade[]> {
  try {
    const raw = await kalshiGet<{ fills?: RawFill[] }>("/portfolio/fills?limit=200");
    return (raw.fills ?? []).map((f): NormalizedTrade => {
      const outcome = f.side === "no" ? "no" : "yes";
      const cents = (outcome === "yes" ? f.yes_price : f.no_price) ?? 0;
      const ref = makeRef(f.ticker ?? "", outcome);
      const orderId = f.order_id ?? "";
      const sizeStr = String(f.count ?? 0);
      const priceStr = String(cents / 100);
      const actionUpper = (f.action ?? "buy").toUpperCase();
      // /portfolio/fills returns only our own fills, attributed to our order_id.
      // Model each as a single maker order (taker fills carry takerOrderId).
      return {
        id: f.trade_id ?? `${orderId}-${f.ticker}-${cents}`,
        status: "CONFIRMED",
        traderSide: outcome,
        takerOrderId: f.is_taker ? orderId : "",
        assetId: ref,
        side: actionUpper,
        size: sizeStr,
        price: priceStr,
        makerOrders: f.is_taker
          ? []
          : [
              {
                orderId,
                assetId: ref,
                side: actionUpper,
                matchedAmount: sizeStr,
                price: priceStr,
              },
            ],
      };
    });
  } catch (err) {
    console.warn("[kalshi] fetchRawTrades error:", (err as Error).message);
    return [];
  }
}

/** Startup seed not used on Kalshi (fills are attributed live by order id). */
export async function fetchTradeHistory(): Promise<
  Array<{ id: string; created_at: string; asset_id: string; side: string; size: string; price: string; status: string }>
> {
  return [];
}

// ── Market discovery (→ GammaMarket shape the quoter consumes) ───────────────
interface RawMarket {
  ticker?: string;
  title?: string;
  event_title?: string;
  yes_sub_title?: string;
  category?: string;
  close_time?: string;
  status?: string;
  volume_24h?: number;
  volume?: number;
  liquidity?: number;
  last_price?: number; // cents
  yes_bid?: number; // cents
  yes_ask?: number; // cents
}

const EXCLUDED_CATEGORIES = new Set([
  "crypto",
  "cryptocurrency",
  "sports",
  "soccer",
  "football",
  "basketball",
  "baseball",
  "hockey",
  "tennis",
]);

// Multi-game/parlay event tickers have no clean two-sided binary book to quote.
function isParlayTicker(ticker: string): boolean {
  return /^KXMVE|MULTIGAME|CROSSCATEGORY/i.test(ticker);
}

export async function listMarkets(): Promise<GammaMarket[]> {
  const out: GammaMarket[] = [];
  const seen = new Set<string>();
  const cutoff48hMs = Date.now() + 48 * 60 * 60 * 1000;
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
        if (isParlayTicker(ticker)) continue;
        const rawTitle = m.title ?? m.event_title ?? m.yes_sub_title ?? ticker;
        // Parlay/multi-outcome markets arrive as comma-joined "yes X,yes Y"
        // outcome lists with no clean two-sided book — skip regardless of ticker.
        if (/,\s*(yes|no)\s/i.test(rawTitle)) continue;
        const category = (m.category ?? "").toLowerCase().trim();
        if (EXCLUDED_CATEGORIES.has(category)) continue;
        const endDate = m.close_time ?? "";
        const endMs = new Date(endDate).getTime();
        if (!Number.isFinite(endMs) || endMs < cutoff48hMs) continue;
        // Soft two-sided check: only reject when the summary book is present and
        // clearly one-sided. Kalshi often omits yes_bid/yes_ask from the list,
        // so otherwise let the quoter's live getOrderBook check decide.
        const yesBidC = m.yes_bid;
        const yesAskC = m.yes_ask;
        if (
          yesBidC !== undefined &&
          yesAskC !== undefined &&
          !(yesBidC > 0 && yesAskC > 0 && yesAskC > yesBidC)
        )
          continue;
        const midC =
          yesBidC && yesAskC ? (yesBidC + yesAskC) / 2 : (m.last_price ?? 50);
        const yesPrice = midC / 100;
        if (yesPrice > 0.9 || yesPrice < 0.1) continue;
        seen.add(ticker);
        const vol = m.volume_24h ?? m.volume ?? 0;
        out.push({
          conditionId: ticker,
          question: rawTitle.trim(),
          endDateIso: endDate,
          volume24hr: vol,
          volumeNum: m.volume ?? vol,
          liquidityNum: m.liquidity ?? 0,
          active: true,
          closed: false,
          clobTokenIds: JSON.stringify([makeRef(ticker, "yes"), makeRef(ticker, "no")]),
          enableOrderBook: true,
          yesTokenId: makeRef(ticker, "yes"),
          noTokenId: makeRef(ticker, "no"),
          yesPrice,
          gammaBestBid: 0,
          gammaBestAsk: 1,
          category,
          gameStartTime: "",
          rewardsMaxSpread: 0, // Kalshi has no Polymarket-style rewards band
          rewardsMinSize: 0,
        });
      }
      cursor = raw.cursor;
      if (!cursor || (raw.markets ?? []).length < 200) break;
    }
    // Highest 24h volume first (most likely to have a two-sided book to quote).
    out.sort((a, b) => b.volume24hr - a.volume24hr);
  } catch (err) {
    console.error("[kalshi] listMarkets error:", (err as Error).message);
  }
  return out;
}
