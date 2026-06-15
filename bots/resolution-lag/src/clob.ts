/**
 * clob.ts — thin wrapper around @polymarket/clob-client-v2 for resolution-lag bot.
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

interface ClobToken {
  token_id: string;
  winner?: boolean;
}

interface ClobMarket {
  condition_id?: string;
  active?: boolean;
  closed?: boolean;
  accepting_orders?: boolean;
  tokens?: ClobToken[];
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
  // No asks = nobody selling this token below $1 (the usual post-resolution
  // state). Return 0 so callers count it as "no ask" rather than a phantom
  // 0.99 price — there's nothing to buy.
  if (!asks.length) return 0;
  return asks[0].price;
}

export async function getClobMarket(
  conditionId: string,
): Promise<ClobMarket | null> {
  if (!conditionId) return null;
  try {
    const url = `${config.polymarket.host}/markets/${conditionId}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    return (await res.json()) as ClobMarket;
  } catch (err) {
    console.warn("[clob] getClobMarket error:", (err as Error).message);
    return null;
  }
}

export async function getResolvedWinnerTokenId(
  conditionId: string,
): Promise<string | null> {
  const market = await getClobMarket(conditionId);
  if (!market) return null;

  // If CLOB still shows open/active market state, treat as unresolved.
  if (market.active || market.accepting_orders) return null;

  const tokens = market.tokens ?? [];
  const winners = tokens.filter((t) => t.winner === true);
  if (winners.length !== 1) return null;
  return winners[0].token_id;
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
