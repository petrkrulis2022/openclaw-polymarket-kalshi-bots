/**
 * kalshi.ts — thin wrapper around the Kalshi REST API.
 *
 * Auth: RSA-PSS / SHA-256.  Sign string = timestamp_ms + METHOD + path (no query).
 * Order book: only bids returned; asks reconstructed as 1 − opposite best bid.
 * Prices are decimal strings ("0.4200"). Sorted ascending; best bid = last element.
 */

import crypto from "crypto";
import { config } from "./config.js";

// ── Auth ──────────────────────────────────────────────────────────────────────

// Kalshi signing path = full URL path after hostname (includes /trade-api/v2 prefix)
const _hostPathPrefix = new URL(config.kalshi.host).pathname; // "/trade-api/v2"

function kalshiHeaders(
  method: string,
  path: string,
): Record<string, string> {
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
  const url = `${config.kalshi.host}${path}`;
  const res = await fetch(url, {
    headers: kalshiHeaders("GET", path),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Kalshi GET ${path} → ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

async function kalshiPost<T>(path: string, body: unknown): Promise<T> {
  const url = `${config.kalshi.host}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: kalshiHeaders("POST", path),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Kalshi POST ${path} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

async function kalshiDelete(path: string): Promise<void> {
  const url = `${config.kalshi.host}${path}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: kalshiHeaders("DELETE", path),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Kalshi DELETE ${path} → ${res.status}: ${text}`);
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface KalshiMarket {
  ticker: string;
  title: string;
  category: string;
  closeTime: string;   // ISO string
  feeRate: number;     // decimal, e.g. 0.007
  status: string;      // "open" | "closed" | "settled"
}

export interface KalshiOrderBook {
  // Sorted descending (best bid first). Only bids are returned by Kalshi.
  yesBids: Array<{ price: number; size: number }>;
  noBids: Array<{ price: number; size: number }>;
}

export interface KalshiOrderResult {
  orderId: string;
}

interface RawMarket {
  ticker?: string;
  title?: string;
  event_title?: string;
  subtitle?: string;
  category?: string;
  close_time?: string;
  fee_rate?: number | string;
  status?: string;
}

// Strip Kalshi's "yes "/"no " outcome prefix so titles match Polymarket questions.
// e.g. "yes Alex de Minaur wins Wimbledon" → "Alex de Minaur wins Wimbledon"
function cleanTitle(raw: string): string {
  return raw.replace(/^(yes|no)\s+/i, "").trim();
}

interface RawOrderBook {
  orderbook_fp?: {
    yes_dollars?: [string, string][];
    no_dollars?: [string, string][];
  };
}

interface RawOrderResponse {
  order?: { order_id?: string };
  order_id?: string;
}

// ── Market listing ────────────────────────────────────────────────────────────

// Known Kalshi series tickers for economics/politics events that may match Polymarket
const ECON_SERIES = ["KXFED", "KXCPI", "KXUNEMPLOY", "KXGDP", "KXPCE", "KXINFL"];

function parseRawMarket(m: RawMarket): KalshiMarket {
  const rawTitle = m.title ?? m.event_title ?? "";
  return {
    ticker: m.ticker ?? "",
    title: cleanTitle(rawTitle),
    category: (m.category ?? "").toLowerCase(),
    closeTime: m.close_time ?? "",
    feeRate: typeof m.fee_rate === "string"
      ? parseFloat(m.fee_rate)
      : (m.fee_rate ?? 0.007),
    status: m.status ?? "open",
  };
}

export async function getKalshiMarkets(): Promise<KalshiMarket[]> {
  const seen = new Set<string>();
  const all: KalshiMarket[] = [];

  const addMarkets = (markets: RawMarket[]) => {
    for (const m of markets) {
      const ticker = m.ticker ?? "";
      if (ticker && !seen.has(ticker)) {
        seen.add(ticker);
        all.push(parseRawMarket(m));
      }
    }
  };

  // General pagination (top 1000 by volume)
  try {
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const qs = `status=open&limit=200${cursor ? `&cursor=${cursor}` : ""}`;
      const raw = await kalshiGet<{ markets?: RawMarket[]; cursor?: string }>(`/markets?${qs}`);
      addMarkets(raw.markets ?? []);
      cursor = raw.cursor;
      if (!cursor || (raw.markets ?? []).length < 200) break;
    }
  } catch (err) {
    console.error("[kalshi] getKalshiMarkets general error:", (err as Error).message);
  }

  // Explicit series fetches for economics/politics (low volume → not in top 1000)
  await Promise.allSettled(
    ECON_SERIES.map(async (series) => {
      try {
        const raw = await kalshiGet<{ markets?: RawMarket[] }>(
          `/markets?status=open&limit=100&series_ticker=${series}`,
        );
        addMarkets(raw.markets ?? []);
      } catch {
        // series may not exist; ignore
      }
    }),
  );

  return all;
}

// ── Order book ────────────────────────────────────────────────────────────────

export async function getKalshiOrderBook(
  ticker: string,
): Promise<KalshiOrderBook> {
  try {
    const path = `/markets/${encodeURIComponent(ticker)}/orderbook`;
    const raw = await kalshiGet<RawOrderBook>(path);
    const fp = raw.orderbook_fp ?? {};

    // Parse and sort descending (best bid first = highest price first)
    const parseBids = (arr: [string, string][] = []) =>
      arr
        .map(([p, s]) => ({ price: parseFloat(p), size: parseFloat(s) }))
        .filter((b) => b.price > 0 && b.size > 0)
        .sort((a, b) => b.price - a.price);

    return {
      yesBids: parseBids(fp.yes_dollars),
      noBids: parseBids(fp.no_dollars),
    };
  } catch (err) {
    console.error(
      `[kalshi] getKalshiOrderBook(${ticker}) error:`,
      (err as Error).message,
    );
    return { yesBids: [], noBids: [] };
  }
}

// ── Balance ───────────────────────────────────────────────────────────────────

export async function getKalshiBalance(): Promise<number> {
  try {
    const raw = await kalshiGet<{
      balance?: { available?: string | number };
    }>("/portfolio/balance");
    const avail = raw.balance?.available;
    if (avail === undefined) return 0;
    // Kalshi returns balance in cents as integer or string
    const raw_num = typeof avail === "string" ? parseFloat(avail) : avail;
    return raw_num / 100; // convert cents → dollars
  } catch (err) {
    console.error("[kalshi] getKalshiBalance error:", (err as Error).message);
    return 0;
  }
}

// ── Order placement ───────────────────────────────────────────────────────────

export async function placeKalshiOrder(
  ticker: string,
  outcomeSide: "yes" | "no",
  price: number,
  sizeUsd: number,
  clientOrderId: string,
  action: "buy" | "sell" = "buy",
): Promise<KalshiOrderResult> {
  // Kalshi count = number of contracts. Each contract pays $1 on win.
  // At price P, cost per contract = P dollars. Count = sizeUsd / price.
  const count = sizeUsd / price;
  // Dollar-denominated (fixed-point) order API — see kalshi.md "Order Placement".
  // The reads already use the dollar book (orderbook_fp.yes_dollars); the write
  // side must use the matching endpoint/format. The old /portfolio/orders path
  // with a dollar-string price rejects, which is why every Kalshi leg failed.
  const body = {
    ticker,
    action,
    outcome_side: outcomeSide,
    price: price.toFixed(4),
    count: Math.max(1, Math.round(count)).toFixed(2),
    time_in_force: "fill_or_kill",
    client_order_id: clientOrderId,
  };
  const raw = await kalshiPost<RawOrderResponse>("/portfolio/events/orders", body);
  const orderId =
    raw.order?.order_id ?? (raw as Record<string, unknown>)["order_id"] as string ?? "unknown";
  return { orderId };
}

// ── Cancel order ──────────────────────────────────────────────────────────────

export async function cancelKalshiOrder(orderId: string): Promise<void> {
  try {
    await kalshiDelete(`/portfolio/orders/${encodeURIComponent(orderId)}`);
  } catch (err) {
    console.warn(
      `[kalshi] cancelKalshiOrder(${orderId}) error:`,
      (err as Error).message,
    );
  }
}

// ── Positions ─────────────────────────────────────────────────────────────────

interface RawPositionsResponse {
  market_positions?: Array<{ ticker?: string; position?: number }>;
}

/**
 * Net contracts held for one side of a market.
 * Kalshi reports `position` signed: positive = yes contracts, negative = no.
 * Returns null when the API call fails (unknown ≠ zero — callers must retry).
 */
export async function getKalshiPosition(
  ticker: string,
  side: "yes" | "no",
): Promise<number | null> {
  try {
    const raw = await kalshiGet<RawPositionsResponse>(
      `/portfolio/positions?ticker=${encodeURIComponent(ticker)}`,
    );
    const entry = (raw.market_positions ?? []).find((p) => p.ticker === ticker);
    const signed = entry?.position ?? 0;
    return side === "yes" ? Math.max(0, signed) : Math.max(0, -signed);
  } catch (err) {
    console.warn(`[kalshi] getKalshiPosition(${ticker}) error:`, (err as Error).message);
    return null;
  }
}

// ── Exchange status (health check) ────────────────────────────────────────────

export async function getKalshiStatus(): Promise<{ trading_active: boolean }> {
  try {
    const raw = await kalshiGet<{
      exchange_active?: boolean;
      trading_active?: boolean;
    }>("/exchange/status");
    return {
      trading_active:
        (raw.trading_active ?? raw.exchange_active) === true,
    };
  } catch {
    return { trading_active: false };
  }
}
