/**
 * clob.ts — thin wrapper around @polymarket/clob-client-v2 for the copy-trader bot.
 */

import {
  ClobClient,
  Chain,
  Side,
  AssetType,
  SignatureTypeV2,
  createL1Headers,
  type ApiKeyCreds,
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

async function createOrDeriveApiKeyPoly1271(
  signer: any,
  chainId: Chain,
  host: string,
  funderAddress: string,
): Promise<ApiKeyCreds> {
  const nonce = 0;
  const l1Headers = await createL1Headers(signer, chainId, nonce, undefined, funderAddress);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    POLY_ADDRESS: l1Headers.POLY_ADDRESS,
    POLY_SIGNATURE: l1Headers.POLY_SIGNATURE,
    POLY_TIMESTAMP: l1Headers.POLY_TIMESTAMP,
    POLY_NONCE: l1Headers.POLY_NONCE,
  };
  const createResp = await fetch(`${host}/auth/api-key`, { method: "POST", headers });
  if (createResp.ok) {
    const raw = (await createResp.json()) as { apiKey: string; secret: string; passphrase: string };
    return { key: raw.apiKey, secret: raw.secret, passphrase: raw.passphrase };
  }
  const deriveResp = await fetch(`${host}/auth/derive-api-key`, { method: "GET", headers });
  if (!deriveResp.ok) {
    const errBody = await deriveResp.text();
    throw new Error(`POLY_1271 API key create/derive failed: ${errBody}`);
  }
  const raw = (await deriveResp.json()) as { apiKey: string; secret: string; passphrase: string };
  return { key: raw.apiKey, secret: raw.secret, passphrase: raw.passphrase };
}

async function getSigningClient(): Promise<ClobClient> {
  if (_signingClient) return _signingClient;
  const key = config.polymarket.signerKey;
  const account = privateKeyToAccount(
    (key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`,
  );
  const signer = createWalletClient({
    account,
    chain: polygon,
    transport: http(),
  });
  let creds: ApiKeyCreds;
  if (config.polymarket.signatureType === SignatureTypeV2.POLY_1271) {
    if (!config.polymarket.funderAddress) {
      throw new Error("POLY_1271 requires funderAddress (deposit wallet address) to be set");
    }
    creds = await createOrDeriveApiKeyPoly1271(
      signer as any,
      Chain.POLYGON,
      config.polymarket.host,
      config.polymarket.funderAddress,
    );
  } else {
    const tempClient = new ClobClient({
      host: config.polymarket.host,
      chain: Chain.POLYGON,
      signer: signer as any,
      signatureType: config.polymarket.signatureType,
      funderAddress: config.polymarket.funderAddress,
    });
    creds = await tempClient.createOrDeriveApiKey();
  }
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

export async function placeLimitOrder(
  tokenId: string,
  side: "BUY" | "SELL",
  price: number,
  size: number,
  _marketQuestion: string,
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
