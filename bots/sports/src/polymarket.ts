/**
 * polymarket.ts — Gamma + CLOB client for sports bot.
 *
 * fetchArsenalMarket  — fetch YES/NO token IDs from Gamma events API
 * getOrderBook        — read current bids/asks for a token
 * getBestAsk / getBestBid — convenience helpers
 * placeMarketOrder    — submit FOK market order via clob-client-v2 (immediate fill or cancel)
 */

import { ClobClient, Chain, Side } from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { config } from "./config.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ArsenalMarket {
  /** Arsenal wins YES — price ~89¢ pre-game */
  yesTokenId: string;
  /** Arsenal does NOT win (Draw or Burnley) NO — price ~11¢ pre-game */
  noTokenId: string;
  conditionId: string;
  question: string;
}

export interface OrderBook {
  /** Sorted descending: best bid first */
  bids: Array<{ price: number; size: number }>;
  /** Sorted ascending: best ask first */
  asks: Array<{ price: number; size: number }>;
}

// ── Gamma — fetch Arsenal YES/NO token IDs ────────────────────────────────────

export async function fetchArsenalMarket(slug: string): Promise<ArsenalMarket> {
  const url = `${config.polymarket.gammaApi}/events?slug=${slug}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Gamma API ${res.status} for slug=${slug}`);

  const events = (await res.json()) as Array<Record<string, unknown>>;
  if (!events.length) throw new Error(`No Gamma event found for slug=${slug}`);

  const event = events[0];
  const markets = (event["markets"] as Array<Record<string, unknown>>) ?? [];

  // Find the Arsenal sub-market in the 3-way neg-risk moneyline.
  // Identify by sportsMarketType containing "moneyline" + groupItemTitle = "Arsenal FC"
  // or question containing "Arsenal" without halftime/corner/score keywords.
  let arsenalMarket: Record<string, unknown> | null = null;

  for (const m of markets) {
    const mType = String(m["sportsMarketType"] ?? "").toLowerCase();
    const groupTitle = String(m["groupItemTitle"] ?? "").toLowerCase();
    const question = String(m["question"] ?? "").toLowerCase();

    const isMoneyline =
      mType.includes("moneyline") ||
      (!mType &&
        !question.includes("halftime") &&
        !question.includes("corner") &&
        !question.includes("score"));

    const isArsenal =
      groupTitle.includes("arsenal") || question.includes("arsenal");

    if (isMoneyline && isArsenal) {
      arsenalMarket = m;
      break;
    }
  }

  if (!arsenalMarket) {
    throw new Error(
      `Could not find Arsenal moneyline market in event ${slug}. ` +
        `Markets found: ${markets.map((m) => m["question"]).join(", ")}`,
    );
  }

  // clobTokenIds is a JSON-encoded string: "[\"tokenId1\",\"tokenId2\"]"
  const rawTokenIds = String(arsenalMarket["clobTokenIds"] ?? "[]");
  const tokenIds = JSON.parse(rawTokenIds) as string[];

  if (tokenIds.length < 2) {
    throw new Error(
      `Unexpected clobTokenIds for Arsenal market: ${rawTokenIds}`,
    );
  }

  const conditionId = String(
    arsenalMarket["conditionId"] ?? arsenalMarket["condition_id"] ?? "",
  );
  const question = String(arsenalMarket["question"] ?? "");

  console.log(
    `[polymarket] Arsenal market: "${question}" YES=${tokenIds[0].slice(0, 12)}... NO=${tokenIds[1].slice(0, 12)}...`,
  );

  return {
    yesTokenId: tokenIds[0], // Arsenal wins
    noTokenId: tokenIds[1], // Arsenal doesn't win
    conditionId,
    question,
  };
}

// ── CLOB clients ──────────────────────────────────────────────────────────────

let _readClient: ClobClient | null = null;
let _signingClient: ClobClient | null = null;

function getReadClient(): ClobClient {
  if (_readClient) return _readClient;
  _readClient = new ClobClient({
    host: config.polymarket.host,
    chain: Chain.POLYGON,
  });
  return _readClient;
}

export async function getSigningClient(): Promise<ClobClient> {
  if (_signingClient) return _signingClient;

  const key = config.polymarket.signerKey;
  if (!key) throw new Error("BOT_SIGNER_KEY not set");

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
    funderAddress: config.polymarket.funderAddress || undefined,
  });

  console.log(
    `[clob] Deriving API key for ${account.address} (sig_type=${config.polymarket.signatureType})...`,
  );

  const creds = await tempClient.createOrDeriveApiKey();
  const credsObj = creds as unknown as Record<string, unknown>;
  if (!credsObj["key"]) {
    throw new Error(
      `createOrDeriveApiKey returned no key: ${JSON.stringify(creds)}`,
    );
  }
  console.log(
    `[clob] API key ready: ${String(credsObj["key"]).slice(0, 8)}...`,
  );

  _signingClient = new ClobClient({
    host: config.polymarket.host,
    chain: Chain.POLYGON,
    signer: signer as any,
    creds,
    signatureType: config.polymarket.signatureType,
    funderAddress: config.polymarket.funderAddress || undefined,
  });

  return _signingClient;
}

// ── Order book ────────────────────────────────────────────────────────────────

export async function getOrderBook(tokenId: string): Promise<OrderBook> {
  try {
    const raw = await getReadClient().getOrderBook(tokenId);
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
  return asks.length ? asks[0].price : 0;
}

export async function getBestBid(tokenId: string): Promise<number> {
  const { bids } = await getOrderBook(tokenId);
  return bids.length ? bids[0].price : 0;
}

// ── Order placement ───────────────────────────────────────────────────────────

export async function placeMarketOrder(
  tokenId: string,
  side: "BUY" | "SELL",
  amount: number, // USDC to spend (BUY) or shares to sell (SELL)
): Promise<{ orderId: string; filledShares: number; filledUsdc: number }> {
  const c = await getSigningClient();

  // For BUY: worst acceptable price = 1.0 (pay any ask)
  // For SELL: worst acceptable price = 0.01 (accept any bid)
  const worstPrice = side === "BUY" ? 1.0 : 0.01;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await (c as any).createAndPostMarketOrder(
    {
      tokenID: tokenId,
      side: side === "BUY" ? Side.BUY : Side.SELL,
      amount,
      price: worstPrice,
    },
    undefined, // options (tick size auto-detected by library)
    "FOK",     // Fill Or Kill — fill immediately at market price or cancel
  );

  const r = result as Record<string, unknown>;
  const errorMsg = String(r["errorMsg"] ?? "");
  if (errorMsg && errorMsg !== "" && errorMsg !== "null" && errorMsg !== "undefined") {
    throw new Error(`Market order rejected: ${errorMsg}`);
  }

  const orderId = String(r["orderID"] ?? "unknown");
  // Amounts are in micro-units (1e6). For BUY: making=USDC given, taking=shares received.
  // For SELL: making=shares given, taking=USDC received.
  const makingAmt = parseFloat(String(r["makingAmount"] ?? "0")) / 1e6;
  const takingAmt = parseFloat(String(r["takingAmount"] ?? "0")) / 1e6;

  const filledUsdc   = side === "BUY" ? makingAmt : takingAmt;
  const filledShares = side === "BUY" ? takingAmt : makingAmt;

  return { orderId, filledShares, filledUsdc };
}
