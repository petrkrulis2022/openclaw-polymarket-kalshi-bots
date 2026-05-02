/**
 * clob.ts — thin wrapper around @polymarket/clob-client-v2 for resolution-lag bot.
 */

import {
  ClobClient,
  Chain,
  Side,
  AssetType,
  SignatureTypeV2,
} from "@polymarket/clob-client-v2";
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
  const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http(),
  });
  const tempClient = new ClobClient({
    host: config.polymarket.host,
    chain: Chain.POLYGON,
    signer: walletClient,
    signatureType: config.polymarket.signatureType,
    funderAddress: config.polymarket.funderAddress,
  });
  const creds = await tempClient.createOrDeriveApiKey();
  _signingClient = new ClobClient({
    host: config.polymarket.host,
    chain: Chain.POLYGON,
    signer: walletClient,
    creds,
    signatureType: config.polymarket.signatureType,
    funderAddress: config.polymarket.funderAddress,
  });
  return _signingClient;
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

export async function getBestAsk(tokenId: string): Promise<number> {
  const { asks } = await getOrderBook(tokenId);
  if (!asks.length) return 0.99;
  return asks[0].price;
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
