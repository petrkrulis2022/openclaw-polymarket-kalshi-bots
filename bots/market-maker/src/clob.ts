import { ClobClient, Chain, Side, type ApiKeyCreds } from "@polymarket/clob-client";
import { config } from "./config.js";

export interface OrderBook {
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
}

export interface OrderResult {
  orderId: string;
  paper: boolean;
}

// Lazy-init client — L1 creds only (no private key needed for reads)
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

// For live order signing we need an ethers Wallet signer
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
    new Wallet(config.polymarket.privateKey),
    creds,
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
    await getClient().cancelOrder({ orderID: orderId });
  } catch (err) {
    console.warn(`[clob] cancelOrder error:`, (err as Error).message);
  }
}

export async function getOpenOrders(): Promise<
  Array<{ id: string; tokenId: string; side: string; price: number; size: number }>
> {
  if (config.paperTrading) return [];
  try {
    const result = await getClient().getOpenOrders();
    const orders = Array.isArray(result) ? result : ((result as { data?: unknown[] }).data ?? []);
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
