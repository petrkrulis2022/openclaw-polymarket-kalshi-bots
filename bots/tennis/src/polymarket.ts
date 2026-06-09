/**
 * polymarket.ts — Gamma + CLOB client for tennis bot.
 *
 * fetchHomeTeamMarket  — fetch YES/NO token IDs from Gamma events API
 *   Tennis markets have one match-winner market ("Player A vs Player B").
 *   YES token = the first-listed player wins.
 *   We detect order and swap tokenIds so yesTokenId always = homePlayer wins.
 *
 * getOrderBook        — read current bids/asks for a token
 * getBestAsk / getBestBid — convenience helpers
 * placeMarketOrder    — submit FOK market order via clob-client-v2
 */

import { AssetType, ClobClient, Chain, Side, SignatureTypeV2 } from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { config } from "./config.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface HomeTeamMarket {
  /** Home player wins YES */
  yesTokenId: string;
  /** Home player does NOT win NO */
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
  startDate: string | null;
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

  // Tennis players often identified by last name only — add it as alias
  const parts = normalized.trim().split(/\s+/);
  if (parts.length >= 2) {
    const lastName = parts[parts.length - 1];
    if (lastName && lastName.length > 2) aliases.add(lastName);
    const firstName = parts[0];
    if (firstName && firstName.length > 2) aliases.add(firstName);
  }

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

export async function fetchEventLifecycle(
  slug: string,
): Promise<EventLifecycle> {
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

  const startDateRaw =
    event["startDate"] ??
    event["start_date"] ??
    event["startTime"] ??
    event["start_time"] ??
    null;

  const endDateRaw =
    event["endDate"] ??
    event["end_date"] ??
    event["endTime"] ??
    event["end_time"] ??
    null;

  const rawStatus = String(
    event["status"] ??
      event["gameStatus"] ??
      (resolved
        ? "resolved"
        : closed
          ? "closed"
          : active
            ? "active"
            : "inactive"),
  );

  return {
    slug,
    active,
    closed,
    resolved,
    acceptingOrders,
    startDate: startDateRaw ? String(startDateRaw) : null,
    endDate: endDateRaw ? String(endDateRaw) : null,
    rawStatus,
  };
}

// ── Gamma — fetch home player YES/NO token IDs ────────────────────────────────

/**
 * Detect if a market is a plain match-winner (not O/U, handicap, set-specific,
 * or completed-match variant).
 */
function isTennisMatchWinner(question: string): boolean {
  const q = question.toLowerCase();
  if (q.includes("o/u") || q.includes("over/under")) return false;
  if (q.includes("completed")) return false;
  if (q.includes("handicap") || q.includes("spread")) return false;
  if (/set \d/.test(q)) return false;
  if (q.includes("games")) return false;
  if (q.includes("total sets")) return false;
  return true;
}

/**
 * Find the position of the first alias match in normalised text.
 * Returns Infinity if not found.
 */
function firstAliasPosition(normalizedText: string, team: string): number {
  const aliases = buildTeamAliases(team).filter(Boolean);
  let best = Infinity;
  for (const alias of aliases) {
    const idx = normalizedText.indexOf(alias);
    if (idx >= 0 && idx < best) best = idx;
  }
  return best;
}

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

  const selectedHomeTeam =
    (homeTeamName && homeTeamName.trim()) || config.matchTeamHome;
  const selectedAwayTeam =
    (awayTeamName && awayTeamName.trim()) || config.matchTeamAway;

  // Find the match-winner market: contains both player names, not O/U or set-specific.
  let matchWinnerMarket: Record<string, unknown> | null = null;
  for (const m of markets) {
    const question = String(m["question"] ?? "");
    if (!isTennisMatchWinner(question)) continue;
    if (titleMatchesTeams(question, selectedHomeTeam, selectedAwayTeam)) {
      matchWinnerMarket = m;
      break;
    }
  }

  // Fallback: any market that passes isTennisMatchWinner and contains either player
  if (!matchWinnerMarket) {
    for (const m of markets) {
      const question = String(m["question"] ?? "");
      if (!isTennisMatchWinner(question)) continue;
      if (
        textMatchesTeam(question, selectedHomeTeam) ||
        textMatchesTeam(question, selectedAwayTeam)
      ) {
        matchWinnerMarket = m;
        break;
      }
    }
  }

  if (!matchWinnerMarket) {
    throw new Error(
      `Could not find match-winner market for ${selectedHomeTeam} vs ${selectedAwayTeam} in event ${slug}. ` +
        `Markets found: ${markets.map((m) => m["question"]).join(", ")}`,
    );
  }

  const rawTokenIds = String(matchWinnerMarket["clobTokenIds"] ?? "[]");
  const tokenIds = JSON.parse(rawTokenIds) as string[];

  if (tokenIds.length < 2) {
    throw new Error(
      `Unexpected clobTokenIds for ${selectedHomeTeam} market: ${rawTokenIds}`,
    );
  }

  // Detect which player is listed first in the question (= YES token).
  // Swap tokenIds so yesTokenId always = homeTeam wins.
  const question = String(matchWinnerMarket["question"] ?? "");
  const normalizedQ = normalizeTeamName(question);
  const homePos = firstAliasPosition(normalizedQ, selectedHomeTeam);
  const awayPos = firstAliasPosition(normalizedQ, selectedAwayTeam);
  // If awayTeam appears before homeTeam → YES=away → swap so YES=home
  if (awayPos < homePos) {
    [tokenIds[0], tokenIds[1]] = [tokenIds[1], tokenIds[0]];
  }

  const conditionId = String(
    matchWinnerMarket["conditionId"] ?? matchWinnerMarket["condition_id"] ?? "",
  );
  const tickSizeRaw =
    matchWinnerMarket["orderPriceMinTickSize"] ??
    matchWinnerMarket["order_price_min_tick_size"] ??
    matchWinnerMarket["tickSize"] ??
    matchWinnerMarket["tick_size"] ??
    null;
  const parsedTickSize = Number(tickSizeRaw);
  const orderPriceMinTickSize =
    Number.isFinite(parsedTickSize) && parsedTickSize > 0
      ? parsedTickSize
      : null;

  console.log(
    `[polymarket] ${selectedHomeTeam} market: "${question}" YES=${tokenIds[0].slice(0, 12)}... NO=${tokenIds[1].slice(0, 12)}... (swapped=${awayPos < homePos})`,
  );

  return {
    yesTokenId: tokenIds[0], // Home player wins
    noTokenId: tokenIds[1],  // Away player wins
    conditionId,
    question,
    orderPriceMinTickSize,
  };
}

// ── CLOB clients ──────────────────────────────────────────────────────────────

let _readClient: ClobClient | null = null;
let _signingClient: ClobClient | null = null;

export const polymarketOverrides: {
  signerKey?: string;
  walletAddress?: string;
  funderAddress?: string;
  signatureType?: SignatureTypeV2;
} = {};

export function resetSigningClient(): void {
  _signingClient = null;
}

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

  const rawKey = (
    polymarketOverrides.signerKey ?? config.polymarket.signerKey
  ).trim();
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

  const effectiveSignatureType =
    polymarketOverrides.signatureType ?? config.polymarket.signatureType;
  const effectiveFunderAddress =
    polymarketOverrides.funderAddress ?? config.polymarket.funderAddress;

  const tempClient = new ClobClient({
    host: config.polymarket.host,
    chain: Chain.POLYGON,
    signer: signer as any,
    signatureType: effectiveSignatureType,
    funderAddress: effectiveFunderAddress || undefined,
  });

  console.log(
    `[clob] Deriving API key for ${account.address} (sig_type=${effectiveSignatureType})...`,
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
    signatureType: effectiveSignatureType,
    funderAddress: effectiveFunderAddress || undefined,
  });

  return _signingClient;
}

// ── Order book ────────────────────────────────────────────────────────────────

export async function getOrderBook(tokenId: string): Promise<OrderBook> {
  try {
    const raw = await getReadClient().getOrderBook(tokenId);
    return {
      bids: (raw.bids ?? [])
        .map((b) => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
        .sort((a, b) => b.price - a.price),
      asks: (raw.asks ?? [])
        .map((a) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
        .sort((a, b) => a.price - b.price),
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

export async function getAvailableCollateralBalanceUsdc(): Promise<number> {
  try {
    const c = await getSigningClient();
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

async function waitForDelayedOrder(
  orderId: string,
  side: "BUY" | "SELL",
  timeoutMs = 30_000,
  postTimeMs?: number,
): Promise<{ filledShares: number; filledUsdc: number } | null> {
  const c = await getSigningClient();
  const delayStartMs = Date.now();
  const deadline = delayStartMs + timeoutMs;
  let attempt = 0;
  let firstPollMs = 0;
  let freezeWindowMs = 0;

  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 2_000));
    attempt++;
    const pollTimeMs = Date.now();
    if (firstPollMs === 0) firstPollMs = pollTimeMs;

    try {
      const order = (await (c as any).getOrder(orderId)) as Record<
        string,
        unknown
      >;
      const matched = parseFloat(String(order["size_matched"] ?? "0")) || 0;
      const status = String(order["status"] ?? "").toLowerCase();
      const createdAtMs = parseFloat(String(order["created_at"] ?? "0")) * 1000;
      const matchTimeMs = parseFloat(String(order["match_time"] ?? "0")) * 1000;
      const lastUpdateMs = parseFloat(
        String(order["last_update"] ?? "0"),
      ) * 1000;

      if (freezeWindowMs === 0 && matchTimeMs > 0 && createdAtMs > 0) {
        freezeWindowMs = matchTimeMs - createdAtMs;
      }

      const elapsedSincePost = postTimeMs ? pollTimeMs - postTimeMs : 0;
      const elapsedSinceDelayStart = pollTimeMs - delayStartMs;

      console.log(
        `[clob] delay-poll #${attempt} @ ${pollTimeMs} | status=${status} size_matched=${matched.toFixed(4)} | ` +
          `elapsed_since_post=${elapsedSincePost}ms elapsed_since_delayed_detected=${elapsedSinceDelayStart}ms | ` +
          `created=${createdAtMs > 0 ? new Date(createdAtMs).toISOString() : "n/a"} ` +
          `match=${matchTimeMs > 0 ? new Date(matchTimeMs).toISOString() : "pending"} ` +
          `last_update=${lastUpdateMs > 0 ? new Date(lastUpdateMs).toISOString() : "n/a"} ` +
          `[freeze_window=${freezeWindowMs}ms]`,
      );

      if (matched > 0) {
        const price = parseFloat(String(order["price"] ?? "0")) || 0;
        const filledShares = matched;
        const filledUsdc = matched * price;
        const totalLatencyMs = pollTimeMs - (postTimeMs || delayStartMs);
        console.log(
          `[clob] ✅ delayed order matched after ${totalLatencyMs}ms | freeze_duration=${freezeWindowMs}ms | shares=${filledShares.toFixed(4)} usdc=${filledUsdc.toFixed(4)}`,
        );
        return { filledShares, filledUsdc };
      }

      if (
        status === "cancelled" ||
        status === "canceled" ||
        status === "expired" ||
        status === "unmatched"
      ) {
        console.warn(
          `[clob] ❌ delayed order ${orderId} ended with status=${status}`,
        );
        return null;
      }
    } catch (err) {
      console.warn(`[clob] delayed poll error:`, (err as Error).message);
    }
  }
  console.warn(
    `[clob] ⏱️  delayed order ${orderId} timed out after ${timeoutMs}ms (freeze_window_estimate=${freezeWindowMs}ms)`,
  );
  return null;
}

export async function placeMarketOrder(
  tokenId: string,
  side: "BUY" | "SELL",
  amount: number,
  opts?: { worstPrice?: number },
): Promise<{ orderId: string; filledShares: number; filledUsdc: number }> {
  const c = await getSigningClient();
  const postTimeMs = Date.now();

  const fallbackWorstPrice = side === "BUY" ? 0.99 : 0.01;
  const override = opts?.worstPrice;
  const worstPrice =
    typeof override === "number" && Number.isFinite(override)
      ? override
      : fallbackWorstPrice;

  console.log(
    `[clob] 📤 POST order @ ${postTimeMs} | side=${side} amount=${amount} worst=${worstPrice}`,
  );

  const result = await (c as any).createAndPostMarketOrder(
    {
      tokenID: tokenId,
      side: side === "BUY" ? Side.BUY : Side.SELL,
      amount,
      price: worstPrice,
    },
    undefined,
    "FOK",
  );

  const responseTimeMs = Date.now();
  const orderId = String(result?.orderID ?? result?.order_id ?? result?.id ?? "");
  const status = String(result?.status ?? result?.orderStatus ?? "");

  console.log(
    `[clob] 📥 response @ ${responseTimeMs} (rtt=${responseTimeMs - postTimeMs}ms) | orderId=${orderId} status=${status}`,
  );

  if (status === "delayed") {
    console.log(
      `[clob] ⏳ order ${orderId} delayed by Gamma — starting polling cycle (pass_post_time=${postTimeMs})`,
    );
    const filled = await waitForDelayedOrder(orderId, side, 30_000, postTimeMs);
    if (filled) {
      console.log(
        `[clob] delayed order filled: shares=${filled.filledShares} usdc=${filled.filledUsdc}`,
      );
      return { orderId, filledShares: filled.filledShares, filledUsdc: filled.filledUsdc };
    }
    throw new Error(`Delayed order ${orderId} was not filled`);
  }

  const filledShares =
    parseFloat(String(result?.size_matched ?? result?.filledSize ?? result?.filled ?? "0")) || 0;
  const filledPrice =
    parseFloat(String(result?.price ?? result?.avg_price ?? "0")) || worstPrice;
  const filledUsdc = filledShares * filledPrice;

  if (filledShares <= 0) {
    throw new Error(
      `Order ${orderId} not filled (status=${status}, size_matched=${filledShares}). Full response: ${JSON.stringify(result)}`,
    );
  }

  return { orderId, filledShares, filledUsdc };
}
