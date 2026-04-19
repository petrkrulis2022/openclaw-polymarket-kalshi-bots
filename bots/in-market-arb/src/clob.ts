/**
 * clob.ts — thin wrapper around @polymarket/clob-client for in-market-arb bot.
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
}

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

export async function placeLimitOrder(
  tokenId: string,
  side: "BUY" | "SELL",
  price: number,
  size: number,
): Promise<OrderResult> {
  const c = await getSigningClient();
  const order = await c.createAndPostOrder({
    tokenID: tokenId,
    side: side === "BUY" ? Side.BUY : Side.SELL,
    price,
    size,
  });
  const orderId = (order as { orderID?: string }).orderID ?? "unknown";
  return { orderId };
}

export async function cancelOrder(orderId: string): Promise<void> {
  try {
    const c = await getSigningClient();
    await c.cancelOrder({ orderID: orderId });
  } catch (err) {
    console.warn("[clob] cancelOrder error:", (err as Error).message);
  }
}

export async function getCollateralBalance(): Promise<number> {
  try {
    const c = await getSigningClient();
    const result = (await c.getBalanceAllowance({
      asset_type: AssetType.COLLATERAL,
    })) as { balance?: string };
    return parseFloat(result.balance ?? "0") / 1e6;
  } catch (err) {
    console.warn("[clob] getCollateralBalance error:", (err as Error).message);
    return 0;
  }
}
