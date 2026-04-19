/**
 * clob.ts — thin wrapper around @polymarket/clob-client for the copy-trader bot.
 * Mirrors the market-maker clob.ts exactly.
 */

import {
  ClobClient,
  Chain,
  Side,
  AssetType,
  type ApiKeyCreds,
} from "@polymarket/clob-client";
import { SignatureType } from "@polymarket/order-utils";
import { config } from "./config.js";

export interface OrderBook {
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
}

export interface OrderResult {
  orderId: string;
  paper: boolean;
}

// ── Client singletons ─────────────────────────────────────────────────────────

let _client: ClobClient | null = null;

function getClient(): ClobClient {
  if (_client) return _client;
  const creds: ApiKeyCreds = {
    key: config.polymarket.apiKey,
    secret: config.polymarket.apiSecret,
    passphrase: config.polymarket.apiPassphrase,
  };
  _client = new ClobClient(
    config.polymarket.host,
    Chain.POLYGON,
    undefined,
    creds,
  );
  return _client;
}

async function getSigningClient(): Promise<ClobClient> {
  const { Wallet } = await import("ethers");
  const creds: ApiKeyCreds = {
    key: config.polymarket.apiKey,
    secret: config.polymarket.apiSecret,
    passphrase: config.polymarket.apiPassphrase,
  };
  return new ClobClient(
    config.polymarket.host,
    Chain.POLYGON,
    new Wallet(config.polymarket.signerKey),
    creds,
    SignatureType.EOA,
  );
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

let _paperOrderCounter = 0;

export async function placeLimitOrder(
  tokenId: string,
  side: "BUY" | "SELL",
  price: number,
  size: number,
  marketQuestion: string,
): Promise<OrderResult> {
  if (config.paperTrading) {
    const orderId = `PAPER-COPY-${++_paperOrderCounter}`;
    console.log(
      `[paper] ${side} ${size.toFixed(2)} @ ${price.toFixed(4)} | ${marketQuestion.slice(0, 50)} | id=${orderId}`,
    );
    return { orderId, paper: true };
  }

  const c = await getSigningClient();
  const order = await c.createAndPostOrder({
    tokenID: tokenId,
    side: side === "BUY" ? Side.BUY : Side.SELL,
    price,
    size,
  });
  const orderId = (order as { orderID?: string }).orderID ?? "unknown";
  return { orderId, paper: false };
}

export async function cancelOrder(orderId: string): Promise<void> {
  if (config.paperTrading || orderId.startsWith("PAPER")) {
    console.log(`[paper] CANCEL ${orderId}`);
    return;
  }
  try {
    const c = await getSigningClient();
    await c.cancelOrder({ orderID: orderId });
  } catch (err) {
    console.warn("[clob] cancelOrder error:", (err as Error).message);
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
  asset_id: string;
  side: string;
  size: string;
  price: string;
  status: string;
  maker_address: string;
}

export async function fetchTradeHistory(): Promise<TradeRecord[]> {
  if (config.paperTrading) return [];
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
