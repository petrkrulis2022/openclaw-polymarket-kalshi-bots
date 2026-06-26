/**
 * venue/limitless.ts — Limitless backend (CLOB on Base) for in-market-arb,
 * normalized to the same clob contract (getOrderBook(ref) → {bids,asks}).
 *
 * Built with plain fetch + viem (both already deps) + crypto — NO new SDK, so
 * importing this module is lightweight and the live polymarket/kalshi processes
 * load no extra dependency.
 *
 * Public reads (market list, order book) need no auth. Trading uses a scoped API
 * token (HMAC headers lmts-api-key/lmts-timestamp/lmts-signature) + an EIP-712
 * CTF-Exchange order signed against the per-market venue `exchange` address — that
 * write path is scaffolded behind dryRun and is NOT live until Phase 3 review.
 *
 * Market reference: "<slug>:<yes|no>". /markets/:slug/orderbook returns only the
 * YES token's book; the NO side is the CTF mirror (NO ask = 1 − YES bid), same as
 * the Kalshi adapter.
 */

import { createPublicClient, http, erc20Abi, getAddress } from "viem";
import { base } from "viem/chains";
import { config } from "../config.js";
import type { OrderBook, OrderResult } from "../clob.js";
import type { BinaryMarket } from "../scanner.js";

const API = config.limitless.apiBase;

// ── Ref helpers ─────────────────────────────────────────────────────────────
export function makeRef(slug: string, side: "yes" | "no"): string {
  return `${slug}:${side}`;
}
function parseRef(ref: string): { slug: string; side: "yes" | "no" } {
  const idx = ref.lastIndexOf(":");
  const side = ref.slice(idx + 1) === "no" ? "no" : "yes";
  return { slug: ref.slice(0, idx), side };
}

// Per-market metadata captured during discovery — needed for order placement
// (tokenId + the venue exchange that is the EIP-712 verifyingContract).
interface MarketMeta {
  slug: string;
  conditionId: string;
  yesToken: string;
  noToken: string;
  exchange: string; // venue.exchange — EIP-712 verifyingContract
  adapter: string | null; // venue.adapter — NegRisk SELL adapter (null = none)
  collateralDecimals: number;
}
const meta = new Map<string, MarketMeta>();

// ── Public fetch (no auth) ──────────────────────────────────────────────────
async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok)
    throw new Error(`Limitless GET ${path} → ${res.status}: ${await res.text().catch(() => "")}`);
  return res.json() as Promise<T>;
}

// ── Market discovery ────────────────────────────────────────────────────────
interface RawMarket {
  id?: number;
  slug?: string;
  title?: string;
  conditionId?: string;
  negRiskRequestId?: string | null;
  tradeType?: string; // "clob" | "amm"
  marketType?: string; // "single" | group
  status?: string;
  expired?: boolean;
  hidden?: boolean;
  expirationDate?: string;
  prices?: number[]; // [yes, no]
  tokens?: { yes?: string; no?: string };
  venue?: { exchange?: string; adapter?: string | null };
  collateralToken?: { address?: string; decimals?: number; symbol?: string };
}

/**
 * Active single-binary CLOB markets, normalized to BinaryMarket. NegRisk groups
 * (negRiskRequestId set) are deferred — single markets only for the probe.
 */
export async function listBinaryMarkets(): Promise<BinaryMarket[]> {
  const out: BinaryMarket[] = [];
  try {
    const raw = await get<{ data?: RawMarket[] }>("/markets/active");
    for (const m of raw.data ?? []) {
      const slug = m.slug ?? "";
      if (!slug) continue;
      if (m.tradeType !== "clob") continue; // skip AMM markets
      if (m.marketType && m.marketType !== "single") continue; // defer neg-risk
      if (m.expired || m.hidden) continue;
      if (!m.tokens?.yes || !m.tokens?.no || !m.venue?.exchange) continue;
      meta.set(slug, {
        slug,
        conditionId: m.conditionId ?? "",
        yesToken: m.tokens.yes,
        noToken: m.tokens.no,
        exchange: m.venue.exchange,
        adapter: m.venue.adapter ?? null,
        collateralDecimals: m.collateralToken?.decimals ?? 6,
      });
      out.push({
        id: slug,
        conditionId: m.conditionId ?? "",
        question: (m.title ?? slug).trim(),
        yesTokenId: makeRef(slug, "yes"),
        noTokenId: makeRef(slug, "no"),
        endDate: m.expirationDate ?? "",
        feeRate: config.limitless.feeRate,
      });
    }
  } catch (err) {
    console.error("[limitless] listBinaryMarkets error:", (err as Error).message);
  }
  return out;
}

// ── Order book (normalized to {bids, asks}) ─────────────────────────────────
interface RawLevel {
  price: number;
  size: number; // base units (collateral decimals)
  side?: string;
}
interface RawOrderBook {
  bids?: RawLevel[];
  asks?: RawLevel[];
}

/**
 * Book for one side. /markets/:slug/orderbook returns the YES token book;
 * the NO book is the CTF mirror (a NO ask = sell-NO = buy-YES at 1−price).
 */
export async function getOrderBook(ref: string): Promise<OrderBook> {
  const { slug, side } = parseRef(ref);
  const dec = meta.get(slug)?.collateralDecimals ?? 6;
  const unit = 10 ** dec;
  try {
    const raw = await get<RawOrderBook>(`/markets/${encodeURIComponent(slug)}/orderbook`);
    const lvl = (a: RawLevel[] = []) =>
      a
        .map((l) => ({ price: l.price, size: l.size / unit }))
        .filter((l) => l.price > 0 && l.price < 1 && l.size > 0);
    const yesBids = lvl(raw.bids);
    const yesAsks = lvl(raw.asks);
    if (side === "yes") {
      return {
        bids: [...yesBids].sort((a, b) => b.price - a.price),
        asks: [...yesAsks].sort((a, b) => a.price - b.price),
      };
    }
    // NO mirror
    return {
      bids: yesAsks
        .map((a) => ({ price: 1 - a.price, size: a.size }))
        .sort((a, b) => b.price - a.price),
      asks: yesBids
        .map((b) => ({ price: 1 - b.price, size: b.size }))
        .sort((a, b) => a.price - b.price),
    };
  } catch (err) {
    console.error(`[limitless] getOrderBook(${ref}) error:`, (err as Error).message);
    return { bids: [], asks: [] };
  }
}

// ── Collateral balance (USDC on Base, read-only via viem) ────────────────────
function makePub() {
  return createPublicClient({ chain: base, transport: http(config.limitless.baseRpcUrl) });
}
let _pub: ReturnType<typeof makePub> | null = null;
function pub(): ReturnType<typeof makePub> {
  if (!_pub) _pub = makePub();
  return _pub;
}
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // Base USDC (from market data)

export async function getCollateralBalance(): Promise<number> {
  try {
    const addr = config.limitless.walletAddress;
    if (!addr) return 0;
    const bal = (await pub().readContract({
      address: USDC_BASE,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [getAddress(addr)],
    })) as bigint;
    return Number(bal) / 1e6;
  } catch (err) {
    console.warn("[limitless] getCollateralBalance error:", (err as Error).message);
    return 0;
  }
}

// ── Order placement (real, via @limitless-exchange/sdk) ─────────────────────
// The SDK + ethers are dynamic-imported so the live polymarket bot (which never
// calls these) loads neither. The SDK handles EIP-712 order signing; we just
// pass {tokenId, price, size, side, orderType, marketSlug}.
function normKey(k: string): string {
  return k.startsWith("0x") ? k : `0x${k}`;
}

let _oc: { createOrder: (a: unknown) => Promise<unknown>; cancel: (id: string) => Promise<unknown> } | null = null;
async function orderClient() {
  if (_oc) return _oc;
  const { HttpClient, OrderClient } = await import("@limitless-exchange/sdk");
  const { Wallet, JsonRpcProvider } = await import("ethers");
  const provider = new JsonRpcProvider(config.limitless.baseRpcUrl);
  const wallet = new Wallet(normKey(config.limitless.signerKey), provider);
  const httpClient = new HttpClient({
    baseURL: config.limitless.apiBase,
    apiKey: config.limitless.apiKey,
    hmacCredentials: {
      tokenId: config.limitless.apiKey,
      secret: config.limitless.apiSecret,
    },
  });
  _oc = new OrderClient({ httpClient, wallet }) as unknown as NonNullable<typeof _oc>;
  return _oc;
}

async function place(
  ref: string,
  bookSide: "BUY" | "SELL",
  price: number,
  sizeShares: number,
): Promise<OrderResult> {
  const { slug, side } = parseRef(ref);
  const m = meta.get(slug);
  if (!m) throw new Error(`[limitless] unknown market ${slug}`);
  const tokenId = side === "yes" ? m.yesToken : m.noToken;
  const { Side, OrderType } = await import("@limitless-exchange/sdk");
  const oc = await orderClient();
  try {
    // FAK (fill-and-kill): marketable limit — takes available depth at ≤ price,
    // kills the remainder. No naked resting leg → the right primitive for arb.
    const res = (await oc.createOrder({
      tokenId,
      price,
      size: sizeShares,
      side: bookSide === "BUY" ? Side.BUY : Side.SELL,
      orderType: OrderType.FAK,
      marketSlug: slug,
    })) as Record<string, unknown>;
    const orderId = String(res?.["id"] ?? res?.["orderId"] ?? "unknown");
    console.log(
      `[limitless] order ok ${bookSide} ${sizeShares.toFixed(2)}@${price.toFixed(4)} ${side} ${slug} → ${orderId}`,
    );
    return { orderId };
  } catch (err) {
    console.error(
      `[limitless] order rejected ${bookSide} ${side} ${slug} @ ${price.toFixed(4)}: ${(err as Error).message}`,
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
    const oc = await orderClient();
    await oc.cancel(orderId);
  } catch (err) {
    console.warn(`[limitless] cancelOrder(${orderId}) error:`, (err as Error).message);
  }
}

/** One-time USDC approval for a market's exchange (CTF Exchange) — needs ETH gas. */
const approved = new Set<string>();
export async function ensureUsdcApproval(slug: string): Promise<void> {
  const m = meta.get(slug);
  if (!m || !m.exchange || approved.has(m.exchange)) return;
  const { Wallet, JsonRpcProvider, Contract, MaxUint256 } = await import("ethers");
  const provider = new JsonRpcProvider(config.limitless.baseRpcUrl);
  const wallet = new Wallet(normKey(config.limitless.signerKey), provider);
  const usdc = new Contract(
    USDC_BASE,
    [
      "function allowance(address,address) view returns (uint256)",
      "function approve(address,uint256) returns (bool)",
    ],
    wallet,
  );
  const owner = await wallet.getAddress();
  const cur: bigint = await usdc["allowance"]!(owner, m.exchange);
  if (cur < 10n ** 12n) {
    console.log(`[limitless] approving USDC → exchange ${m.exchange}`);
    const tx = await usdc["approve"]!(m.exchange, MaxUint256);
    await tx.wait();
  }
  approved.add(m.exchange);
}

/**
 * Merge equal YES+NO back to USDC collateral (capital recovery) via the Gnosis
 * CTF on Base. Returns the tx hash, or null if skipped (no LIMITLESS_CTF_ADDRESS
 * yet → the hedged position is simply held to resolution).
 */
export async function mergeYesNo(
  slug: string,
  amountShares: number,
): Promise<string | null> {
  const m = meta.get(slug);
  if (!m || !(amountShares > 0)) return null;
  if (!config.limitless.ctfAddress) {
    console.warn(
      `[limitless] merge skipped (LIMITLESS_CTF_ADDRESS unset) — ${slug} holds ${amountShares.toFixed(2)} hedged`,
    );
    return null;
  }
  const { Wallet, JsonRpcProvider, Contract } = await import("ethers");
  const provider = new JsonRpcProvider(config.limitless.baseRpcUrl);
  const wallet = new Wallet(normKey(config.limitless.signerKey), provider);
  const ctf = new Contract(
    config.limitless.ctfAddress,
    [
      "function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)",
    ],
    wallet,
  );
  const ZERO32 = `0x${"0".repeat(64)}`;
  const amount = BigInt(Math.floor(amountShares * 10 ** (meta.get(slug)?.collateralDecimals ?? 6)));
  console.log(
    `[limitless] mergePositions ${slug} cond=${m.conditionId.slice(0, 10)} amount=${amountShares.toFixed(2)}`,
  );
  const tx = await ctf["mergePositions"]!(USDC_BASE, ZERO32, m.conditionId, [1n, 2n], amount);
  await tx.wait();
  return tx.hash as string;
}

/** FAK arb orders don't rest; nothing to reconcile. */
export async function getOpenOrders(): Promise<
  Array<{ id: string; side: string; tokenId: string; remainingSize: number; originalSize: number }>
> {
  return [];
}
