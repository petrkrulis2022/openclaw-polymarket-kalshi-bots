/**
 * clob.ts — thin wrapper around @polymarket/clob-client-v2 for the copy-trader bot.
 */

import { ClobClient, Chain, Side, AssetType } from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { config } from "./config.js";

export interface OrderBook {
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
}

export interface OrderResult {
  orderId: string;
}

// ── Client singletons ─────────────────────────────────────────────────────────

let _client: ClobClient | null = null;

function getClient(): ClobClient {
  if (_client) return _client;
  _client = new ClobClient({
    host: config.polymarket.host,
    chain: Chain.POLYGON,
  });
  return _client;
}

let _signingClient: ClobClient | null = null;

async function getSigningClient(): Promise<ClobClient> {
  if (_signingClient) return _signingClient;
  const key = config.polymarket.signerKey;
  const account = privateKeyToAccount(
    (key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`,
  );

  // For POLY_PROXY (signatureType=1), POLY_ADDRESS must be the EOA address.
  // The SDK passes funderAddress as the maker on orders, but the signature
  // verification in L1 headers uses POLY_ADDRESS = EOA.
  const signer = createWalletClient({
    account,
    chain: polygon,
    transport: http(),
  });

  const tempClient = new ClobClient({
    host: config.polymarket.host,
    chain: Chain.POLYGON,
    signer: signer as any,
    signatureType: config.polymarket.signatureType,
    funderAddress: config.polymarket.funderAddress,
  });
  console.log(
    `[clob] creating API key sig_type=${config.polymarket.signatureType} poly_address=${account.address} funder=${config.polymarket.funderAddress || "(none)"}`,
  );
  const creds = await tempClient.createOrDeriveApiKey();
  if (!creds || !(creds as Record<string, unknown>)["key"]) {
    throw new Error(
      `createOrDeriveApiKey returned empty creds: ${JSON.stringify(creds)}. ` +
        `sig_type=${config.polymarket.signatureType}, funder=${config.polymarket.funderAddress || "(none)"}. ` +
        `If using POLY_1271/POLY_GNOSIS_SAFE, funderAddress must be a deployed EIP-1271 contract on Polygon.`,
    );
  }
  console.log(
    `[clob] API key created/derived ok: key=${(creds as Record<string, unknown>)["key"]}`,
  );

  _signingClient = new ClobClient({
    host: config.polymarket.host,
    chain: Chain.POLYGON,
    signer: signer as any,
    creds,
    signatureType: config.polymarket.signatureType,
    funderAddress: config.polymarket.funderAddress,
  });
  return _signingClient;
}

// ── Orderbook ─────────────────────────────────────────────────────────────────

export async function getOrderBook(tokenId: string): Promise<OrderBook> {
  try {
    const raw = await getClient().getOrderBook(tokenId);
    return {
      bids: (raw.bids ?? []).map((b) => ({
        price: parseFloat(b.price),
        size: parseFloat(b.size),
      })),
      asks: (raw.asks ?? []).map((a) => ({
        price: parseFloat(a.price),
        size: parseFloat(a.size),
      })),
    };
  } catch (err) {
    console.error("[clob] getOrderBook error:", (err as Error).message);
    return { bids: [], asks: [] };
  }
}

/** Best ask price (what we pay when BUYing) */
export async function getBestAsk(tokenId: string): Promise<number> {
  const { asks } = await getOrderBook(tokenId);
  if (!asks.length) return 0.99;
  return asks[0].price;
}

/** Best bid price (what we receive when SELLing) */
export async function getBestBid(tokenId: string): Promise<number> {
  const { bids } = await getOrderBook(tokenId);
  if (!bids.length) return 0.01;
  return bids[0].price;
}

// ── Order placement ────────────────────────────────────────────────────────────

/** Marketable buffer so a one-tick move between the price probe and the post
 * doesn't kill the whole order. */
const MARKETABLE_SLIPPAGE = 0.02;

/**
 * Place a marketable Fill-And-Kill order and return the ACTUAL fill.
 *
 * Why not a plain limit (createAndPostOrder)? That posts a GTC limit which can
 * rest unfilled — yet the caller used to book the full size as a position
 * regardless, producing phantom inventory. createAndPostMarketOrder with FAK
 * takes whatever liquidity is available right now, cancels the unfilled
 * remainder (never rests), and reports the matched amounts so we record only
 * what truly filled.
 *
 * `sizeShares` is the target share count; `limitPrice` is the reference price
 * (best ask for BUY / best bid for SELL). Returns filledShares = 0 when the
 * order killed without a fill (no marketable liquidity, or insufficient funds).
 */
export async function placeMarketableOrder(
  tokenId: string,
  side: "BUY" | "SELL",
  sizeShares: number,
  limitPrice: number,
): Promise<{ orderId: string; filledShares: number; filledUsdc: number }> {
  const c = await getSigningClient();

  const worstPrice =
    side === "BUY"
      ? Math.min(0.99, limitPrice + MARKETABLE_SLIPPAGE)
      : Math.max(0.01, limitPrice - MARKETABLE_SLIPPAGE);

  // createAndPostMarketOrder amount = USDC to spend (BUY) or shares to sell (SELL).
  const amount =
    side === "BUY"
      ? Number((sizeShares * worstPrice).toFixed(6))
      : Number(sizeShares.toFixed(6));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await (c as any).createAndPostMarketOrder(
    {
      tokenID: tokenId,
      side: side === "BUY" ? Side.BUY : Side.SELL,
      amount,
      price: worstPrice,
    },
    undefined,
    "FAK",
  );

  const r = result as Record<string, unknown>;
  const rejection = String(r["errorMsg"] ?? r["error"] ?? "").trim();
  if (rejection && rejection !== "null" && rejection !== "undefined") {
    throw new Error(`Order rejected: ${rejection}`);
  }
  const statusCode = Number(r["status"] ?? 0);
  if (Number.isFinite(statusCode) && statusCode >= 400) {
    throw new Error(`Order rejected with status ${statusCode}`);
  }

  const orderId = String(r["orderID"] ?? "unknown");
  // Amounts are micro-units (1e6). BUY: making=USDC paid, taking=shares received.
  // SELL: making=shares given, taking=USDC received.
  const makingAmt = (parseFloat(String(r["makingAmount"] || "0")) || 0) / 1e6;
  const takingAmt = (parseFloat(String(r["takingAmount"] || "0")) || 0) / 1e6;
  const filledUsdc = side === "BUY" ? makingAmt : takingAmt;
  const filledShares = side === "BUY" ? takingAmt : makingAmt;

  return { orderId, filledShares, filledUsdc };
}

export async function cancelOrder(orderId: string): Promise<void> {
  try {
    const c = await getSigningClient();
    await c.cancelOrder({ orderID: orderId });
  } catch (err) {
    console.warn("[clob] cancelOrder error:", (err as Error).message);
  }
}

export async function getOpenOrders(): Promise<
  Array<{
    id: string;
    tokenId: string;
    side: string;
    price: number;
    size: number;
  }>
> {
  try {
    const c = await getSigningClient();
    const result = await c.getOpenOrders();
    const orders = Array.isArray(result)
      ? result
      : ((result as { data?: unknown[] }).data ?? []);
    return orders.map((o: unknown) => {
      const order = o as Record<string, string>;
      const size = parseFloat(
        order["size_remaining"] ??
          order["remaining_size"] ??
          order["size"] ??
          "0",
      );
      return {
        id: order["id"] ?? "",
        tokenId: order["asset_id"] ?? "",
        side: order["side"] ?? "",
        price: parseFloat(order["price"] ?? "0"),
        size: Number.isFinite(size) ? size : 0,
      };
    });
  } catch (err) {
    console.error("[clob] getOpenOrders error:", (err as Error).message);
    return [];
  }
}

// ── Balance & fills ────────────────────────────────────────────────────────────

export async function getCollateralBalance(): Promise<number> {
  try {
    const c = await getSigningClient();
    const result = (await c.getBalanceAllowance({
      asset_type: AssetType.COLLATERAL,
    })) as {
      balance?: string;
    };
    return parseFloat(result.balance ?? "0") / 1e6;
  } catch (err) {
    console.warn("[clob] getCollateralBalance error:", (err as Error).message);
    return 0;
  }
}

export interface TradeRecord {
  id: string;
  created_at: string;
  asset_id: string;
  side: string;
  size: string;
  price: string;
  status: string;
  maker_address: string;
}

export async function fetchTradeHistory(): Promise<TradeRecord[]> {
  try {
    const c = await getSigningClient();
    const result = await c.getTrades({
      maker_address: config.polymarket.walletAddress,
    });
    const trades = Array.isArray(result)
      ? result
      : ((result as { data?: unknown[] }).data ?? []);
    const ourAddress = config.polymarket.walletAddress.toLowerCase();
    return trades
      .filter((t: unknown) => {
        const trade = t as Record<string, string>;
        return (trade["maker_address"] ?? "").toLowerCase() === ourAddress;
      })
      .map((t: unknown) => {
        const trade = t as Record<string, string>;
        return {
          id: trade["id"] ?? "",
          created_at: trade["created_at"] ?? "",
          asset_id: trade["asset_id"] ?? "",
          side: trade["side"] ?? "BUY",
          size: trade["size"] ?? "0",
          price: trade["price"] ?? "0",
          status: trade["status"] ?? "",
          maker_address: trade["maker_address"] ?? "",
        };
      });
  } catch (err) {
    console.warn("[clob] fetchTradeHistory error:", (err as Error).message);
    return [];
  }
}
