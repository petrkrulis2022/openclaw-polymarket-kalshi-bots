/**
 * polymarket.ts — Gamma + CLOB client for sports bot.
 *
 * fetchHomeTeamMarket  — fetch YES/NO token IDs from Gamma events API
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

export interface HomeTeamMarket {
  /** Home team wins YES */
  yesTokenId: string;
  /** Home team does NOT win (Draw or Away win) NO */
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

// ── Gamma — fetch home team YES/NO token IDs ─────────────────────────────────

export async function fetchHomeTeamMarket(
  slug: string,
): Promise<HomeTeamMarket> {
  const url = `${config.polymarket.gammaApi}/events?slug=${slug}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Gamma API ${res.status} for slug=${slug}`);

  const events = (await res.json()) as Array<Record<string, unknown>>;
  if (!events.length) throw new Error(`No Gamma event found for slug=${slug}`);

  const event = events[0];
  const markets = (event["markets"] as Array<Record<string, unknown>>) ?? [];

  // Find the home-team sub-market in the 3-way neg-risk moneyline.
  // Identify by sportsMarketType containing "moneyline" + groupItemTitle / question
  // containing the home team name (case-insensitive).
  const homeTeam = config.matchTeamHome.toLowerCase();
  let homeTeamMarket: Record<string, unknown> | null = null;

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

    const isHomeTeam =
      groupTitle.includes(homeTeam) || question.includes(homeTeam);

    if (isMoneyline && isHomeTeam) {
      homeTeamMarket = m;
      break;
    }
  }

  if (!homeTeamMarket) {
    throw new Error(
      `Could not find ${config.matchTeamHome} moneyline market in event ${slug}. ` +
        `Markets found: ${markets.map((m) => m["question"]).join(", ")}`,
    );
  }

  // clobTokenIds is a JSON-encoded string: "[\"tokenId1\",\"tokenId2\"]"
  const rawTokenIds = String(homeTeamMarket["clobTokenIds"] ?? "[]");
  const tokenIds = JSON.parse(rawTokenIds) as string[];

  if (tokenIds.length < 2) {
    throw new Error(
      `Unexpected clobTokenIds for ${config.matchTeamHome} market: ${rawTokenIds}`,
    );
  }

  const conditionId = String(
    homeTeamMarket["conditionId"] ?? homeTeamMarket["condition_id"] ?? "",
  );
  const question = String(homeTeamMarket["question"] ?? "");

  console.log(
    `[polymarket] ${config.matchTeamHome} market: "${question}" YES=${tokenIds[0].slice(0, 12)}... NO=${tokenIds[1].slice(0, 12)}...`,
  );

  return {
    yesTokenId: tokenIds[0], // Home team wins
    noTokenId: tokenIds[1], // Home team doesn't win
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
      // Sort to guarantee correct order regardless of what the CLOB client returns
      bids: (raw.bids ?? [])
        .map((b) => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
        .sort((a, b) => b.price - a.price), // descending: best (highest) bid first
      asks: (raw.asks ?? [])
        .map((a) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
        .sort((a, b) => a.price - b.price), // ascending: best (lowest) ask first
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

  // For BUY: worst acceptable price = 0.99 (CLOB max; pay any ask up to 99¢)
  // For SELL: worst acceptable price = 0.01 (CLOB min; accept any bid down to 1¢)
  const worstPrice = side === "BUY" ? 0.99 : 0.01;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await (c as any).createAndPostMarketOrder(
    {
      tokenID: tokenId,
      side: side === "BUY" ? Side.BUY : Side.SELL,
      amount,
      price: worstPrice,
    },
    undefined, // options (tick size auto-detected by library)
    "FOK", // Fill Or Kill — fill immediately at market price or cancel
  );

  const r = result as Record<string, unknown>;
  const errorMsg = String(r["errorMsg"] ?? "");
  if (
    errorMsg &&
    errorMsg !== "" &&
    errorMsg !== "null" &&
    errorMsg !== "undefined"
  ) {
    throw new Error(`Market order rejected: ${errorMsg}`);
  }

  const orderId = String(r["orderID"] ?? "unknown");
  // Amounts are in micro-units (1e6). For BUY: making=USDC given, taking=shares received.
  // For SELL: making=shares given, taking=USDC received.
  const makingAmt = parseFloat(String(r["makingAmount"] ?? "0")) / 1e6;
  const takingAmt = parseFloat(String(r["takingAmount"] ?? "0")) / 1e6;

  const filledUsdc = side === "BUY" ? makingAmt : takingAmt;
  const filledShares = side === "BUY" ? takingAmt : makingAmt;

  return { orderId, filledShares, filledUsdc };
}
