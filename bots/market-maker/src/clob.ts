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
  paper: boolean;
}

// Lazy-init client — no signer needed for reads
let _client: ClobClient | null = null;

function getClient(): ClobClient {
  if (_client) return _client;
  _client = new ClobClient({
    host: config.polymarket.host,
    chain: Chain.POLYGON,
  });
  return _client;
}

// Signing client — derives API creds from private key once at startup
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
    signatureType: SignatureTypeV2.POLY_GNOSIS_SAFE,
    funderAddress: config.polymarket.funderAddress,
  });
  const creds = await tempClient.createOrDeriveApiKey();
  _signingClient = new ClobClient({
    host: config.polymarket.host,
    chain: Chain.POLYGON,
    signer: walletClient,
    creds,
    signatureType: SignatureTypeV2.POLY_GNOSIS_SAFE,
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

let paperOrderCounter = 0;

export async function placeLimitOrder(
  tokenId: string,
  side: "BUY" | "SELL",
  price: number,
  size: number,
  marketQuestion: string,
): Promise<OrderResult> {
  if (config.paperTrading) {
    const orderId = `paper-${++paperOrderCounter}`;
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
  if (config.paperTrading || orderId.startsWith("paper-")) {
    console.log(`[paper] CANCEL ${orderId}`);
    return;
  }
  try {
    const c = await getSigningClient();
    await c.cancelOrder({ orderID: orderId });
  } catch (err) {
    console.warn(`[clob] cancelOrder error:`, (err as Error).message);
  }
}

/** Returns the CLOB collateral balance in USD (6-decimal USDC.e normalised). */
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

export async function getOpenOrders(): Promise<
  Array<{
    id: string;
    tokenId: string;
    side: string;
    price: number;
    size: number;
  }>
> {
  if (config.paperTrading) return [];
  try {
    const c = await getSigningClient();
    const result = await c.getOpenOrders();
    const orders = Array.isArray(result)
      ? result
      : ((result as { data?: unknown[] }).data ?? []);
    return orders.map((o: unknown) => {
      const order = o as Record<string, string>;
      return {
        id: order["id"] ?? "",
        tokenId: order["asset_id"] ?? "",
        side: order["side"] ?? "",
        price: parseFloat(order["price"] ?? "0"),
        size: parseFloat(order["original_size"] ?? "0"),
      };
    });
  } catch (err) {
    console.error("[clob] getOpenOrders error:", (err as Error).message);
    return [];
  }
}

export interface TradeRecord {
  asset_id: string;
  side: string;
  size: string;
  price: string;
  status: string;
}

/** Fetch full trade history for our maker address to seed inventory on startup. */
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
        };
      });
  } catch (err) {
    console.warn("[clob] fetchTradeHistory error:", (err as Error).message);
    return [];
  }
}

export async function getLastTradeMid(tokenId: string): Promise<number> {
  try {
    const c = getClient();
    const result = (await c.getLastTradePrice(tokenId)) as
      | { price?: string }
      | null
      | undefined;
    if (!result || !result.price) return 0;
    const p = parseFloat(result.price);
    return Number.isFinite(p) && p > 0 && p < 1 ? p : 0;
  } catch {
    return 0;
  }
}
