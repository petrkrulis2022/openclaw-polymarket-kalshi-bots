/**
 * venue/opinion.ts — Opinion backend (CLOB on BNB Chain) for in-market-arb,
 * normalized to the clob contract. Uses @opinion-labs/opinion-clob-sdk, which
 * handles EIP-712 signing via the Gnosis Safe (multiSig). Dynamic-imported so
 * the live polymarket bot loads neither the SDK nor its deps.
 *
 * BLIND BUILD: Opinion's API is gated (no key yet) so none of this is live-
 * verified. The reads (getMarkets/getOrderbook) follow the documented shapes;
 * the order amount fields + some market field names are best-effort and marked
 * NEEDS-LIVE-VALIDATION — to be confirmed on the first real call once the key
 * is provisioned.
 *
 * Differences from Limitless: YES and NO have SEPARATE orderbooks (no mirror);
 * there is no FOK/IOC (orders are LIMIT or MARKET) so arb uses marketable LIMIT
 * + merge (Polymarket-style). split/merge/redeem + orders key off marketId.
 */

import { config } from "../config.js";
import type { OrderBook, OrderResult } from "../clob.js";
import type { BinaryMarket } from "../scanner.js";

// ── Ref helpers ("<marketId>:<yes|no>") ─────────────────────────────────────
export function makeRef(marketId: string | number, side: "yes" | "no"): string {
  return `${marketId}:${side}`;
}
function parseRef(ref: string): { marketId: string; side: "yes" | "no" } {
  const idx = ref.lastIndexOf(":");
  const side = ref.slice(idx + 1) === "no" ? "no" : "yes";
  return { marketId: ref.slice(0, idx), side };
}

interface MarketMeta {
  marketId: string;
  conditionId: string;
  yesToken: string;
  noToken: string;
}
const meta = new Map<string, MarketMeta>();

// ── Lazy SDK client (dynamic import; handles signing) ───────────────────────
function normKey(k: string): string {
  return k.startsWith("0x") ? k : `0x${k}`;
}
let _client: Record<string, (...a: unknown[]) => Promise<unknown>> | null = null;
async function client() {
  if (_client) return _client;
  const { Client } = await import("@opinion-labs/opinion-clob-sdk");
  _client = new Client({
    host: config.opinion.host,
    apiKey: config.opinion.apiKey,
    chainId: config.opinion.chainId as 56,
    rpcUrl: config.opinion.rpcUrl,
    privateKey: normKey(config.opinion.signerKey) as `0x${string}`,
    multiSigAddress: config.opinion.multiSigAddress as `0x${string}`,
  }) as unknown as NonNullable<typeof _client>;
  return _client;
}

// ── Market discovery ────────────────────────────────────────────────────────
export async function listBinaryMarkets(): Promise<BinaryMarket[]> {
  const out: BinaryMarket[] = [];
  try {
    const c = await client();
    const { TopicType } = await import("@opinion-labs/opinion-clob-sdk");
    // getMarkets({topicType, page, limit, status, sortBy}) → { total, list }
    const raw = (await c["getMarkets"]!({
      topicType: (TopicType as Record<string, unknown>)["ALL"] ?? undefined,
      status: "active",
      page: 1,
      limit: 200,
    })) as { list?: Array<Record<string, unknown>> };
    for (const m of raw.list ?? []) {
      // NEEDS-LIVE-VALIDATION: confirm these field names against a real payload.
      const marketId = String(m["marketId"] ?? m["id"] ?? "");
      if (!marketId) continue;
      const tokens = (m["tokens"] ?? m["outcomes"]) as
        | { yes?: string; no?: string }
        | Array<{ tokenId?: string; outcome?: string }>
        | undefined;
      let yesToken = "";
      let noToken = "";
      if (Array.isArray(tokens)) {
        yesToken = String(tokens.find((t) => /yes/i.test(String(t.outcome)))?.tokenId ?? tokens[0]?.tokenId ?? "");
        noToken = String(tokens.find((t) => /no/i.test(String(t.outcome)))?.tokenId ?? tokens[1]?.tokenId ?? "");
      } else if (tokens) {
        yesToken = String(tokens.yes ?? "");
        noToken = String(tokens.no ?? "");
      }
      if (!yesToken || !noToken) continue;
      meta.set(marketId, {
        marketId,
        conditionId: String(m["conditionId"] ?? ""),
        yesToken,
        noToken,
      });
      out.push({
        id: marketId,
        conditionId: String(m["conditionId"] ?? ""),
        question: String(m["title"] ?? m["question"] ?? marketId).trim(),
        yesTokenId: makeRef(marketId, "yes"),
        noTokenId: makeRef(marketId, "no"),
        endDate: String(m["endDate"] ?? m["expirationDate"] ?? ""),
        feeRate: config.opinion.feeRate,
      });
    }
  } catch (err) {
    console.error("[opinion] listBinaryMarkets error:", (err as Error).message);
  }
  return out;
}

// ── Order book (separate YES/NO books — no mirror) ──────────────────────────
export async function getOrderBook(ref: string): Promise<OrderBook> {
  const { marketId, side } = parseRef(ref);
  const m = meta.get(marketId);
  if (!m) return { bids: [], asks: [] };
  const tokenId = side === "yes" ? m.yesToken : m.noToken;
  try {
    const c = await client();
    // getOrderbook(tokenId) → { bids: [[price, shares]], asks: [[price, shares]] }
    const ob = (await c["getOrderbook"]!(tokenId)) as {
      bids?: [number | string, number | string][];
      asks?: [number | string, number | string][];
    };
    const lvl = (a: [number | string, number | string][] = []) =>
      a
        .map(([p, s]) => ({ price: Number(p), size: Number(s) }))
        .filter((l) => l.price > 0 && l.price < 1 && l.size > 0);
    return {
      bids: lvl(ob.bids).sort((a, b) => b.price - a.price),
      asks: lvl(ob.asks).sort((a, b) => a.price - b.price),
    };
  } catch (err) {
    console.error(`[opinion] getOrderBook(${ref}) error:`, (err as Error).message);
    return { bids: [], asks: [] };
  }
}

// ── Balance ─────────────────────────────────────────────────────────────────
export async function getCollateralBalance(): Promise<number> {
  try {
    const c = await client();
    // NEEDS-LIVE-VALIDATION: SDK balance method name.
    const fn = c["getBalance"] ?? c["getCollateralBalance"];
    if (!fn) return 0;
    const raw = (await fn.call(c)) as number | string | { available?: string };
    const n =
      typeof raw === "object" ? Number((raw as { available?: string }).available ?? 0) : Number(raw);
    // If returned in wei, scale down; if already in tokens, this is a no-op-ish guess.
    return n > 1e6 ? n / 10 ** config.opinion.collateralDecimals : n;
  } catch (err) {
    console.warn("[opinion] getCollateralBalance error:", (err as Error).message);
    return 0;
  }
}

// ── Order placement (marketable LIMIT; no FOK/IOC on Opinion) ───────────────
const enabled = { done: false };
export async function enableTrading(): Promise<void> {
  if (enabled.done) return;
  const c = await client();
  if (c["enableTrading"]) {
    const res = (await c["enableTrading"]!()) as { success?: boolean; txHash?: string };
    console.log(`[opinion] enableTrading: success=${res?.success} tx=${res?.txHash ?? "-"}`);
  }
  enabled.done = true;
}

async function place(
  ref: string,
  bookSide: "BUY" | "SELL",
  price: number,
  sizeShares: number,
): Promise<OrderResult> {
  const { marketId, side } = parseRef(ref);
  const m = meta.get(marketId);
  if (!m) throw new Error(`[opinion] unknown market ${marketId}`);
  const tokenId = side === "yes" ? m.yesToken : m.noToken;
  const { OrderSide, OrderType } = await import("@opinion-labs/opinion-clob-sdk");
  const c = await client();
  // NEEDS-LIVE-VALIDATION: amount field + units. Using base-token (shares) in wei
  // with a marketable LIMIT price; confirm makerAmountInBaseToken vs quote on the
  // first real fill.
  const amountWei = BigInt(Math.floor(sizeShares * 10 ** config.opinion.collateralDecimals)).toString();
  try {
    const res = (await c["placeOrder"]!({
      marketId: Number(marketId),
      tokenId,
      makerAmountInBaseToken: amountWei,
      price: price.toFixed(4),
      orderType: (OrderType as Record<string, unknown>)["LIMIT_ORDER"],
      side:
        bookSide === "BUY"
          ? (OrderSide as Record<string, unknown>)["BUY"]
          : (OrderSide as Record<string, unknown>)["SELL"],
    })) as Record<string, unknown>;
    const orderId = String(res?.["orderId"] ?? res?.["id"] ?? "unknown");
    console.log(
      `[opinion] order ok ${bookSide} ${sizeShares.toFixed(2)}@${price.toFixed(4)} ${side} mkt=${marketId} → ${orderId}`,
    );
    return { orderId };
  } catch (err) {
    console.error(
      `[opinion] order rejected ${bookSide} ${side} mkt=${marketId} @ ${price.toFixed(4)}: ${(err as Error).message}`,
    );
    throw err;
  }
}

export const placeBuy = (ref: string, price: number, size: number) =>
  place(ref, "BUY", price, size);
export const placeSell = (ref: string, price: number, size: number) =>
  place(ref, "SELL", price, size);

export async function cancelOrder(orderId: string): Promise<void> {
  if (!orderId || orderId === "unknown") return;
  try {
    const c = await client();
    if (c["cancelOrder"]) await c["cancelOrder"]!(orderId);
  } catch (err) {
    console.warn(`[opinion] cancelOrder(${orderId}) error:`, (err as Error).message);
  }
}

/** Merge equal YES+NO back to collateral via the SDK (capital recovery). */
export async function mergeYesNo(marketId: string, amountShares: number): Promise<string | null> {
  if (!(amountShares > 0)) return null;
  try {
    const c = await client();
    const amountWei = BigInt(Math.floor(amountShares * 10 ** config.opinion.collateralDecimals));
    const res = (await c["merge"]!(Number(marketId), amountWei, true)) as {
      txHash?: string;
    };
    console.log(`[opinion] merge mkt=${marketId} amount=${amountShares.toFixed(2)} tx=${res?.txHash ?? "-"}`);
    return res?.txHash ?? null;
  } catch (err) {
    console.error(`[opinion] merge failed mkt=${marketId}: ${(err as Error).message}`);
    return null;
  }
}

/** Marketable LIMIT remainder can rest; reconcile handled in the executor. */
export async function getOpenOrders(): Promise<
  Array<{ id: string; side: string; tokenId: string; remainingSize: number; originalSize: number }>
> {
  return [];
}
