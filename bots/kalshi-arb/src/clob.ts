/**
 * clob.ts — thin wrapper around @polymarket/clob-client-v2 for kalshi-arb bot.
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
// Don't re-derive the API key more than once per backoff window after a
// failure. Polymarket rate-limits /auth/api-key, and retrying every 30s (the
// metrics loop) just keeps the rate-limit alive. One success caches the client.
let _deriveFailedAt = 0;
const DERIVE_BACKOFF_MS = 5 * 60_000;

async function getSigningClient(): Promise<ClobClient> {
  if (_signingClient) return _signingClient;
  if (_deriveFailedAt && Date.now() - _deriveFailedAt < DERIVE_BACKOFF_MS) {
    throw new Error(
      "Polymarket API key derivation backing off after a recent failure (rate-limited)",
    );
  }
  const key = config.polymarket.signerKey;
  if (!key) throw new Error("BOT_SIGNER_KEY not set — Polymarket orders unavailable");
  const account = privateKeyToAccount(
    (key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`,
  );
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
    `[clob] creating API key sig_type=${config.polymarket.signatureType} funder=${config.polymarket.funderAddress || "(none)"}`,
  );
  let creds: unknown;
  try {
    creds = await tempClient.createOrDeriveApiKey();
  } catch (err) {
    _deriveFailedAt = Date.now();
    throw err;
  }
  if (!creds || !(creds as Record<string, unknown>)["key"]) {
    _deriveFailedAt = Date.now();
    throw new Error(
      `createOrDeriveApiKey returned empty creds: ${JSON.stringify(creds)}`,
    );
  }
  _deriveFailedAt = 0;
  _signingClient = new ClobClient({
    host: config.polymarket.host,
    chain: Chain.POLYGON,
    signer: signer as any,
    creds: creds as any,
    signatureType: config.polymarket.signatureType,
    funderAddress: config.polymarket.funderAddress,
  });
  return _signingClient;
}

export async function getPolyOrderBook(tokenId: string): Promise<OrderBook> {
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
    console.error("[clob] getPolyOrderBook error:", (err as Error).message);
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

/**
 * Shares actually filled on an order (size_matched).
 * Returns null when the lookup fails (unknown ≠ zero — callers must retry).
 */
export async function getPolyOrderSizeMatched(
  orderId: string,
): Promise<number | null> {
  try {
    const c = await getSigningClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (await (c as any).getOrder(orderId)) as Record<string, unknown>;
    const matched = parseFloat(
      String(raw?.["size_matched"] ?? raw?.["sizeMatched"] ?? "0"),
    );
    return Number.isFinite(matched) ? matched : 0;
  } catch (err) {
    console.warn("[clob] getPolyOrderSizeMatched error:", (err as Error).message);
    return null;
  }
}

export async function cancelPolyOrder(orderId: string): Promise<void> {
  try {
    const c = await getSigningClient();
    await c.cancelOrder({ orderID: orderId });
  } catch (err) {
    console.warn("[clob] cancelPolyOrder error:", (err as Error).message);
  }
}

export async function getPolyCollateralBalance(): Promise<number> {
  try {
    const c = await getSigningClient();
    const result = (await c.getBalanceAllowance({
      asset_type: AssetType.COLLATERAL,
    })) as { balance?: string };
    return parseFloat(result.balance ?? "0") / 1e6;
  } catch (err) {
    console.warn("[clob] getPolyCollateralBalance error:", (err as Error).message);
    return 0;
  }
}
