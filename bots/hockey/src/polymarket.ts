/**
 * polymarket.ts — Gamma + CLOB client for sports bot.
 *
 * fetchHomeTeamMarket  — fetch YES/NO token IDs from Gamma events API
 * getOrderBook        — read current bids/asks for a token
 * getBestAsk / getBestBid — convenience helpers
 * placeMarketOrder    — submit FOK market order via clob-client-v2 (immediate fill or cancel)
 */

import { AssetType, ClobClient, Chain, Side } from "@polymarket/clob-client-v2";
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
  /** Price tick size from Gamma market metadata (for dynamic caps) */
  orderPriceMinTickSize: number | null;
}

export interface OrderBook {
  /** Sorted descending: best bid first */
  bids: Array<{ price: number; size: number }>;
  /** Sorted ascending: best ask first */
  asks: Array<{ price: number; size: number }>;
}

export interface EventLifecycle {
  slug: string;
  active: boolean;
  closed: boolean;
  resolved: boolean;
  acceptingOrders: boolean;
  endDate: string | null;
  rawStatus: string;
}

function normalizeTeamName(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildTeamAliases(team: string): string[] {
  const normalized = normalizeTeamName(team);
  const aliases = new Set<string>([normalized]);

  // Generic cleanup aliases
  aliases.add(
    normalized
      .replace(/\brepublic\b/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  );

  // Hockey naming variants seen across Goalserve/Gamma feeds.
  const canon = normalized;
  if (canon === "czech republic") aliases.add("czechia");
  if (canon === "czechia") aliases.add("czech republic");
  if (canon === "slovak republic") aliases.add("slovakia");
  if (canon === "great britain") aliases.add("britain");
  if (canon === "united states") {
    aliases.add("usa");
    aliases.add("us");
  }

  // Club/city transliteration variants that also appear in hockey feeds.
  if (normalized.includes("prague")) {
    aliases.add(normalized.replace(/\bprague\b/g, "praha").trim());
  }
  if (normalized.includes("praha")) {
    aliases.add(normalized.replace(/\bpraha\b/g, "prague").trim());
  }

  // Strip common team prefixes.
  aliases.add(
    normalized
      .replace(/\b(sk|fk|fc|ac|sc|afc|cf|hc)\b/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  );

  return Array.from(aliases).filter(Boolean);
}

function textMatchesTeam(text: string, requestedTeam: string): boolean {
  const normalizedText = normalizeTeamName(text);
  const aliases = buildTeamAliases(requestedTeam);
  return aliases.some((alias) => alias && normalizedText.includes(alias));
}

function titleMatchesTeams(
  title: string,
  homeTeam: string,
  awayTeam: string,
): boolean {
  const normalizedTitle = normalizeTeamName(title);
  const homeAliases = buildTeamAliases(homeTeam);
  const awayAliases = buildTeamAliases(awayTeam);

  const hasHome = homeAliases.some((a) => a && normalizedTitle.includes(a));
  const hasAway = awayAliases.some((a) => a && normalizedTitle.includes(a));
  return hasHome && hasAway;
}

function eventMatchesTeams(
  event: Record<string, unknown>,
  homeTeam: string,
  awayTeam: string,
): boolean {
  const title = String(event["title"] ?? "");
  if (titleMatchesTeams(title, homeTeam, awayTeam)) return true;

  const markets = (event["markets"] as Array<Record<string, unknown>>) ?? [];
  for (const market of markets) {
    const q = String(market["question"] ?? "");
    const g = String(market["groupItemTitle"] ?? "");
    const combined = `${q} ${g}`.trim();
    if (combined && titleMatchesTeams(combined, homeTeam, awayTeam)) {
      return true;
    }
  }

  return false;
}

export async function findEventSlugByTeams(
  homeTeam: string,
  awayTeam: string,
): Promise<string | null> {
  const home = homeTeam.trim();
  const away = awayTeam.trim();
  if (!home || !away) return null;

  const url = `${config.polymarket.gammaApi}/events?active=true&closed=false&limit=1000`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    throw new Error(`Gamma API ${res.status} when resolving slug by teams`);
  }

  const events = (await res.json()) as Array<Record<string, unknown>>;
  for (const event of events) {
    const slug = String(event["slug"] ?? "").trim();
    if (!slug) continue;
    if (eventMatchesTeams(event, home, away)) {
      return slug;
    }
  }

  return null;
}

function asBool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "1" || s === "yes") return true;
    if (s === "false" || s === "0" || s === "no") return false;
  }
  return undefined;
}

/**
 * Fetch market lifecycle flags from Gamma.
 * Used for kickoff/game-over decisions (independent from Goalserve status strings).
 */
export async function fetchEventLifecycle(slug: string): Promise<EventLifecycle> {
  const url = `${config.polymarket.gammaApi}/events?slug=${slug}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Gamma API ${res.status} for slug=${slug}`);

  const events = (await res.json()) as Array<Record<string, unknown>>;
  if (!events.length) throw new Error(`No Gamma event found for slug=${slug}`);

  const event = events[0] as Record<string, unknown>;
  const markets = (event["markets"] as Array<Record<string, unknown>>) ?? [];

  const active = asBool(event["active"]) ?? false;
  const closed = asBool(event["closed"]) ?? false;

  const resolvedFromEvent =
    asBool(event["resolved"]) ??
    asBool(event["isResolved"]) ??
    asBool(event["archived"]) ??
    false;
  const resolvedFromMarkets =
    markets.length > 0 &&
    markets.every((m) => {
      const marketResolved =
        asBool(m["resolved"]) ?? asBool(m["isResolved"]) ?? false;
      const marketClosed = asBool(m["closed"]) ?? false;
      return marketResolved || marketClosed;
    });
  const resolved = resolvedFromEvent || resolvedFromMarkets;

  const acceptingOrders =
    asBool(event["acceptingOrders"]) ??
    asBool(event["accepting_orders"]) ??
    asBool(event["enableOrderBook"]) ??
    asBool(event["orderBookEnabled"]) ??
    !closed;

  const endDateRaw =
    event["endDate"] ??
    event["end_date"] ??
    event["endTime"] ??
    event["end_time"] ??
    null;

  const rawStatus = String(
    event["status"] ??
      event["gameStatus"] ??
      (resolved ? "resolved" : closed ? "closed" : active ? "active" : "inactive"),
  );

  return {
    slug,
    active,
    closed,
    resolved,
    acceptingOrders,
    endDate: endDateRaw ? String(endDateRaw) : null,
    rawStatus,
  };
}

// ── Gamma — fetch home team YES/NO token IDs ─────────────────────────────────

export async function fetchHomeTeamMarket(
  slug: string,
  homeTeamName?: string,
  awayTeamName?: string,
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
  const selectedHomeTeam =
    (homeTeamName && homeTeamName.trim()) || config.matchTeamHome;
  const selectedAwayTeam =
    (awayTeamName && awayTeamName.trim()) || config.matchTeamAway;
  let homeTeamMarket: Record<string, unknown> | null = null;

  for (const m of markets) {
    const mType = String(m["sportsMarketType"] ?? "").toLowerCase();
    const groupTitle = String(m["groupItemTitle"] ?? "");
    const question = String(m["question"] ?? "");
    const questionLower = question.toLowerCase();

    const isMoneyline =
      mType.includes("moneyline") ||
      (!mType &&
        !questionLower.includes("halftime") &&
        !questionLower.includes("corner") &&
        !questionLower.includes("score"));

    const isHomeTeam =
      textMatchesTeam(groupTitle, selectedHomeTeam) ||
      textMatchesTeam(question, selectedHomeTeam);

    if (isMoneyline && isHomeTeam) {
      homeTeamMarket = m;
      break;
    }
  }

  if (!homeTeamMarket) {
    const fallbackCandidates = markets.filter((m) => {
      const mType = String(m["sportsMarketType"] ?? "").toLowerCase();
      const question = String(m["question"] ?? "");
      const questionLower = question.toLowerCase();
      const isMoneyline =
        mType.includes("moneyline") ||
        (!mType &&
          !questionLower.includes("halftime") &&
          !questionLower.includes("corner") &&
          !questionLower.includes("score"));
      const isDraw = questionLower.includes("draw");
      return isMoneyline && !isDraw;
    });

    if (fallbackCandidates.length >= 2 && selectedAwayTeam) {
      const awayFiltered = fallbackCandidates.filter((m) => {
        const q = String(m["question"] ?? "");
        const g = String(m["groupItemTitle"] ?? "");
        return !textMatchesTeam(`${q} ${g}`, selectedAwayTeam);
      });
      if (awayFiltered.length >= 1) {
        homeTeamMarket = awayFiltered[0] ?? null;
      }
    }
  }

  if (!homeTeamMarket) {
    throw new Error(
      `Could not find ${selectedHomeTeam} moneyline market in event ${slug}. ` +
        `Markets found: ${markets.map((m) => m["question"]).join(", ")}`,
    );
  }

  // clobTokenIds is a JSON-encoded string: "[\"tokenId1\",\"tokenId2\"]"
  const rawTokenIds = String(homeTeamMarket["clobTokenIds"] ?? "[]");
  const tokenIds = JSON.parse(rawTokenIds) as string[];

  if (tokenIds.length < 2) {
    throw new Error(
      `Unexpected clobTokenIds for ${selectedHomeTeam} market: ${rawTokenIds}`,
    );
  }

  const conditionId = String(
    homeTeamMarket["conditionId"] ?? homeTeamMarket["condition_id"] ?? "",
  );
  const question = String(homeTeamMarket["question"] ?? "");
  const tickSizeRaw =
    homeTeamMarket["orderPriceMinTickSize"] ??
    homeTeamMarket["order_price_min_tick_size"] ??
    homeTeamMarket["tickSize"] ??
    homeTeamMarket["tick_size"] ??
    null;
  const parsedTickSize = Number(tickSizeRaw);
  const orderPriceMinTickSize =
    Number.isFinite(parsedTickSize) && parsedTickSize > 0
      ? parsedTickSize
      : null;

  console.log(
    `[polymarket] ${selectedHomeTeam} market: "${question}" YES=${tokenIds[0].slice(0, 12)}... NO=${tokenIds[1].slice(0, 12)}...`,
  );

  return {
    yesTokenId: tokenIds[0], // Home team wins
    noTokenId: tokenIds[1], // Home team doesn't win
    conditionId,
    question,
    orderPriceMinTickSize,
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

  const rawKey = config.polymarket.signerKey.trim();
  if (!rawKey) throw new Error("BOT_SIGNER_KEY not set");
  const keyNoPrefix = rawKey.startsWith("0x") ? rawKey.slice(2) : rawKey;
  if (!/^[0-9a-fA-F]{64}$/.test(keyNoPrefix)) {
    throw new Error(
      "BOT_SIGNER_KEY must be a 64-char hex private key (optionally 0x-prefixed)",
    );
  }
  const key = `0x${keyNoPrefix}` as `0x${string}`;

  const account = privateKeyToAccount(key);
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

  const origConsoleError = console.error;
  let suppressedCreateNoise = false;
  console.error = (...args: unknown[]) => {
    const joined = args
      .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg ?? "")))
      .join(" ");
    if (joined.includes("Could not create api key")) {
      suppressedCreateNoise = true;
      return;
    }
    origConsoleError(...args);
  };

  let creds: unknown;
  try {
    creds = await tempClient.createOrDeriveApiKey();
  } finally {
    console.error = origConsoleError;
  }

  const credsObj = creds as unknown as Record<string, unknown>;
  if (!credsObj["key"]) {
    throw new Error(
      `createOrDeriveApiKey returned no key: ${JSON.stringify(creds)}`,
    );
  }
  if (suppressedCreateNoise) {
    console.log("[clob] Existing API key detected; using derived key.");
  }
  console.log(
    `[clob] API key ready: ${String(credsObj["key"]).slice(0, 8)}...`,
  );

  _signingClient = new ClobClient({
    host: config.polymarket.host,
    chain: Chain.POLYGON,
    signer: signer as any,
    creds: creds as any,
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

/** Returns currently spendable collateral balance in USDC (6-decimal normalized). */
export async function getAvailableCollateralBalanceUsdc(): Promise<number> {
  try {
    const c = await getSigningClient();
    // Refresh exchange-side collateral cache first.
    await (c as any)
      .updateBalanceAllowance({ asset_type: AssetType.COLLATERAL })
      .catch(() => undefined);

    const result = (await (c as any).getBalanceAllowance({
      asset_type: AssetType.COLLATERAL,
    })) as { balance?: string; allowance?: string };

    const balance = parseFloat(result.balance ?? "0") / 1e6;
    const allowance = parseFloat(result.allowance ?? "0") / 1e6;
    const available = Math.max(0, Math.min(balance, allowance));
    return Number.isFinite(available) ? available : 0;
  } catch (err) {
    console.warn(
      "[clob] getAvailableCollateralBalanceUsdc error:",
      (err as Error).message,
    );
    return 0;
  }
}

// ── Order placement ───────────────────────────────────────────────────────────

/**
 * Polymarket CLOB sometimes returns status="delayed" on market-moving events
 * (brief orderbook pause for anti-manipulation). Poll until the order settles.
 */
async function waitForDelayedOrder(
  orderId: string,
  side: "BUY" | "SELL",
  timeoutMs = 30_000,
): Promise<{ filledShares: number; filledUsdc: number } | null> {
  const c = await getSigningClient();
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 2_000));
    attempt++;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const order = (await (c as any).getOrder(orderId)) as Record<
        string,
        unknown
      >;
      const matched = parseFloat(String(order["size_matched"] ?? "0")) || 0;
      const status = String(order["status"] ?? "").toLowerCase();
      console.log(
        `[placeMarketOrder] delayed poll #${attempt}: status=${status} size_matched=${matched}`,
      );
      if (matched > 0) {
        const price = parseFloat(String(order["price"] ?? "0")) || 0;
        const filledShares = matched;
        const filledUsdc = matched * price;
        return { filledShares, filledUsdc };
      }
      if (
        status === "cancelled" ||
        status === "canceled" ||
        status === "expired" ||
        status === "unmatched"
      ) {
        console.warn(
          `[placeMarketOrder] delayed order ${orderId} ended with status=${status}`,
        );
        return null;
      }
    } catch (err) {
      console.warn(
        `[placeMarketOrder] delayed poll error:`,
        (err as Error).message,
      );
    }
  }
  console.warn(
    `[placeMarketOrder] delayed order ${orderId} timed out after ${timeoutMs}ms`,
  );
  return null;
}

export async function placeMarketOrder(
  tokenId: string,
  side: "BUY" | "SELL",
  amount: number, // USDC to spend (BUY) or shares to sell (SELL)
  opts?: { worstPrice?: number },
): Promise<{ orderId: string; filledShares: number; filledUsdc: number }> {
  const c = await getSigningClient();

  // For BUY: worst acceptable price = 0.99 (CLOB max; pay any ask up to 99¢)
  // For SELL: worst acceptable price = 0.01 (CLOB min; accept any bid down to 1¢)
  const fallbackWorstPrice = side === "BUY" ? 0.99 : 0.01;
  const override = opts?.worstPrice;
  const worstPrice =
    typeof override === "number" && Number.isFinite(override)
      ? override
      : fallbackWorstPrice;

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
  const errorMsg = String(r["errorMsg"] ?? "").trim();
  const errorText = String(r["error"] ?? "").trim();
  const statusCode = Number(r["status"] ?? 0);
  const rejectionText = errorMsg || errorText;
  if (
    rejectionText &&
    rejectionText !== "null" &&
    rejectionText !== "undefined"
  ) {
    throw new Error(`Market order rejected: ${rejectionText}`);
  }
  if (Number.isFinite(statusCode) && statusCode >= 400) {
    throw new Error(`Market order rejected with status ${statusCode}`);
  }

  const orderId = String(r["orderID"] ?? "unknown");
  console.log("[placeMarketOrder] raw result:", JSON.stringify(r));
  // Amounts are in micro-units (1e6). For BUY: making=USDC given, taking=shares received.
  // For SELL: making=shares given, taking=USDC received.
  const makingAmt = (parseFloat(String(r["makingAmount"] || "0")) || 0) / 1e6;
  const takingAmt = (parseFloat(String(r["takingAmount"] || "0")) || 0) / 1e6;

  // If the CLOB delayed the order (brief pause on market-moving events),
  // poll until it settles instead of treating it as a zero fill.
  const rawStatus = String(r["status"] ?? "");
  if (
    rawStatus === "delayed" &&
    orderId !== "unknown" &&
    makingAmt === 0 &&
    takingAmt === 0
  ) {
    console.log(
      `[placeMarketOrder] order ${orderId} is delayed — polling for fill...`,
    );
    const filled = await waitForDelayedOrder(orderId, side);
    if (filled) {
      console.log(
        `[placeMarketOrder] delayed order filled: shares=${filled.filledShares} usdc=${filled.filledUsdc}`,
      );
      return { orderId, ...filled };
    }
    return { orderId, filledShares: 0, filledUsdc: 0 };
  }

  const filledUsdc = side === "BUY" ? makingAmt : takingAmt;
  const filledShares = side === "BUY" ? takingAmt : makingAmt;

  return { orderId, filledShares, filledUsdc };
}
