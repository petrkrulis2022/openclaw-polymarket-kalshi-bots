/**
 * routes/users.ts
 *
 * REST endpoints for multi-user registration and bot management.
 *
 * POST /users/register           — register or look up a MetaMask address
 * GET  /users/:address           — fetch user record
 * PUT  /users/:address/api-keys  — save Polymarket API credentials
 * POST /users/:address/start-bots — spawn PM2 bot processes for this user
 * POST /users/:address/stop-bots  — stop PM2 bot processes for this user
 */

import { Router, Request, Response, NextFunction } from "express";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  getUser,
  upsertUser,
  updateBotWalletAddress,
  updateApiKeys,
  updateFunderAddress,
  getBotAllocations,
  setBotAllocation,
  setBotsRunning,
  setAutonomousMode,
  getWatchedGames,
  setWatchedGames,
  type WatchedGame,
  type User,
} from "../user-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../");
const DATA_DIR = path.resolve(__dirname, "../../data");
const ENVS_DIR = path.join(DATA_DIR, "envs");

const WDK_TREASURY_URL =
  process.env["WDK_TREASURY_URL"] ?? "http://localhost:3001";
const GOALSERVE_API_KEY =
  process.env["GOALSERVE_API_KEY"] ?? "edc0ecd4f73c4c1a20f808dea8e5ebf2";
const GOALSERVE_HOCKEY_FEED_BASE = `https://www.goalserve.com/getfeed/${GOALSERVE_API_KEY}/hockey`;
const GOALSERVE_FOOTBALL_FEED_BASE = `https://www.goalserve.com/getfeed/${GOALSERVE_API_KEY}/soccernew`;
const HOCKEY_DISCOVERY_TTL_MS = 10_000;
const FOOTBALL_DISCOVERY_TTL_MS = 10_000;
const WC_DISCOVERY_CACHE_FILE = path.join(
  DATA_DIR,
  "hockey-world-championship-cache.json",
);

type HockeyDiscoveryCache = {
  updatedAtMs: number;
  today: unknown;
  tomorrow: unknown;
};

type WorldChampionshipDiscoveryCache = {
  updatedAtMs: number;
  today: unknown;
  tomorrow: unknown;
};

type FootballDiscoveryCache = {
  updatedAtMs: number;
  today: unknown;
  tomorrow: unknown;
};

let hockeyDiscoveryCache: HockeyDiscoveryCache | null = null;
let footballDiscoveryCache: FootballDiscoveryCache | null = null;
let worldChampionshipDiscoveryCache: WorldChampionshipDiscoveryCache | null =
  null;

function loadWorldChampionshipCacheFromDisk(): WorldChampionshipDiscoveryCache | null {
  try {
    if (!fs.existsSync(WC_DISCOVERY_CACHE_FILE)) return null;
    const raw = fs.readFileSync(WC_DISCOVERY_CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw) as {
      updatedAtMs?: unknown;
      today?: unknown;
      tomorrow?: unknown;
    };
    const updatedAtMs = Number(parsed.updatedAtMs ?? 0);
    if (!Number.isFinite(updatedAtMs) || updatedAtMs <= 0) return null;
    return {
      updatedAtMs,
      today: parsed.today,
      tomorrow: parsed.tomorrow,
    };
  } catch {
    return null;
  }
}

function saveWorldChampionshipCacheToDisk(
  snapshot: WorldChampionshipDiscoveryCache,
): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(WC_DISCOVERY_CACHE_FILE, JSON.stringify(snapshot), "utf8");
  } catch {
    // Non-fatal: in-memory fallback still works.
  }
}

worldChampionshipDiscoveryCache = loadWorldChampionshipCacheFromDisk();

// Bot definitions: name → { folder, botId, portOffset, entrypoint }
// portOffset 0-5 relative to user base port
const BOT_DEFS = [
  {
    name: "market-maker",
    folder: "market-maker",
    botId: 1,
    portOffset: 0,
    entrypoint: "src/index.ts",
  },
  {
    name: "copy-trader",
    folder: "copy-trader",
    botId: 3,
    portOffset: 1,
    entrypoint: "src/index.ts",
  },
  {
    name: "in-market-arb",
    folder: "in-market-arb",
    botId: 4,
    portOffset: 2,
    entrypoint: "src/index.ts",
  },
  {
    name: "resolution-lag",
    folder: "resolution-lag",
    botId: 5,
    portOffset: 3,
    entrypoint: "src/index.ts",
  },
  {
    name: "microstructure",
    folder: "microstructure",
    botId: 6,
    portOffset: 4,
    entrypoint: "src/index.ts",
  },
  {
    name: "hockey-bot",
    folder: "hockey",
    botId: 10,
    portOffset: 5,
    entrypoint: "scripts/hockey-bot.ts",
  },
  {
    name: "football-bot",
    folder: "football",
    botId: 8,
    portOffset: 6,
    entrypoint: "scripts/football-bot.ts",
  },
] as const;

const WATCHLIST_BOTS = new Set([
  ...BOT_DEFS.map((b) => b.name),
  "football-bot",
  "hockey-bot",
]);

function getBotDef(botName: string) {
  return BOT_DEFS.find((b) => b.name === botName);
}

function getUserBotBaseUrl(user: User, botName: string): string | null {
  const bot = getBotDef(botName);
  if (!bot) return null;
  const port = userBasePort(user.bot_wallet_index) + bot.portOffset;
  return `http://127.0.0.1:${port}`;
}

type BotReadiness = {
  botName: string;
  ready: boolean;
  stage: "ready" | "initializing" | "offline";
  unreachable: boolean;
  missing: string[];
  details?: unknown;
  error?: string;
};

async function probeBotReadiness(
  user: User,
  botName: string,
): Promise<BotReadiness> {
  const botBaseUrl = getUserBotBaseUrl(user, botName);
  if (!botBaseUrl) {
    return {
      botName,
      ready: false,
      stage: "offline",
      unreachable: true,
      missing: [],
      error: "Unknown bot",
    };
  }

  try {
    const readyRes = await fetch(`${botBaseUrl}/ready`, {
      signal: AbortSignal.timeout(2_500),
    });

    if (readyRes.ok) {
      const payload = (await readyRes.json()) as {
        ready?: boolean;
        stage?: string;
        missing?: string[];
        details?: unknown;
        lastSetupError?: string;
      };
      const stage = payload.ready ? "ready" : "initializing";
      return {
        botName,
        ready: Boolean(payload.ready),
        stage,
        unreachable: false,
        missing: Array.isArray(payload.missing) ? payload.missing : [],
        details: payload.details,
        error: payload.lastSetupError,
      };
    }
  } catch {
    // Fall through to health probe.
  }

  try {
    const healthRes = await fetch(`${botBaseUrl}/health`, {
      signal: AbortSignal.timeout(2_500),
    });
    if (!healthRes.ok) {
      return {
        botName,
        ready: false,
        stage: "offline",
        unreachable: true,
        missing: [],
        error: `Health returned ${healthRes.status}`,
      };
    }
    const payload = (await healthRes.json()) as {
      ok?: boolean;
      ready?: boolean;
      marketReady?: boolean;
      signingClientReady?: boolean;
      staticIdReady?: boolean;
      lastSetupError?: string;
    };

    const missing: string[] = [];
    if (payload.marketReady === false) missing.push("market");
    if (payload.signingClientReady === false) missing.push("signing");
    if (payload.staticIdReady === false) missing.push("goalserveStaticId");

    return {
      botName,
      ready: Boolean(payload.ready),
      stage: payload.ready ? "ready" : "initializing",
      unreachable: false,
      missing,
      details: payload,
      error: payload.lastSetupError,
    };
  } catch {
    return {
      botName,
      ready: false,
      stage: "offline",
      unreachable: true,
      missing: [],
      error: "Bot process unreachable",
    };
  }
}

async function fetchGoalserveHockey(
  pathname: "home" | "d1" | "d2" | "d3",
): Promise<unknown> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(
        `${GOALSERVE_HOCKEY_FEED_BASE}/${pathname}?json=1`,
        {
          signal: AbortSignal.timeout(6_000),
        },
      );
      if (!res.ok) {
        throw new Error(`Goalserve hockey ${pathname} failed (${res.status})`);
      }
      return res.json();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastError ?? new Error(`Goalserve hockey ${pathname} failed`);
}

async function fetchGoalserveFootball(
  pathname: "home" | "d1",
): Promise<unknown> {
  const res = await fetch(
    `${GOALSERVE_FOOTBALL_FEED_BASE}/${pathname}?json=1`,
    { signal: AbortSignal.timeout(6_000) },
  );
  if (!res.ok) {
    throw new Error(`Goalserve football ${pathname} failed (${res.status})`);
  }
  return res.json();
}

function emptyDiscoveryFeed(): { scores: { category: [] } } {
  return { scores: { category: [] } };
}

function mergeDiscoveryFeeds(feeds: unknown[]): unknown {
  const categoryMap = new Map<string, Record<string, unknown>>();

  const toArray = <T>(value: T | T[] | null | undefined): T[] => {
    if (Array.isArray(value)) return value;
    return value == null ? [] : [value];
  };

  const asRecord = (value: unknown): Record<string, unknown> | null => {
    if (!value || typeof value !== "object") return null;
    return value as Record<string, unknown>;
  };

  const readString = (
    obj: Record<string, unknown>,
    ...keys: string[]
  ): string => {
    for (const key of keys) {
      const value = obj[key];
      if (value == null) continue;
      return String(value).trim();
    }
    return "";
  };

  const toCategoryKey = (category: Record<string, unknown>): string => {
    const country = readString(
      category,
      "country",
      "@file_group",
    ).toLowerCase();
    const name = readString(category, "name", "@name").toLowerCase();
    return `${country}::${name}`;
  };

  const toMatchKey = (match: Record<string, unknown>): string => {
    const local = asRecord(match["localteam"]);
    const visitor =
      asRecord(match["awayteam"]) ?? asRecord(match["visitorteam"]);
    const homeTeam = local ? readString(local, "name", "@name") : "";
    const awayTeam = visitor ? readString(visitor, "name", "@name") : "";
    const id = readString(match, "id", "@id");
    const fixId = readString(match, "fix_id", "@fix_id");
    const date = readString(match, "date", "@formatted_date");
    const time = readString(match, "time", "@time");
    return `${id}|${fixId}|${homeTeam}|${awayTeam}|${date}|${time}`.toLowerCase();
  };

  for (const feed of feeds) {
    const root = (feed ?? {}) as Record<string, unknown>;
    const scores = (root["scores"] ?? {}) as Record<string, unknown>;
    const categories = toArray(scores["category"]);

    for (const categoryRaw of categories) {
      const category = asRecord(categoryRaw);
      if (!category) continue;

      const categoryKey = toCategoryKey(category);
      const existingCategory = categoryMap.get(categoryKey);
      const baseCategory = existingCategory
        ? existingCategory
        : { ...category };

      const existingMatchesContainer = asRecord(baseCategory["matches"]);
      const existingMatches = toArray(
        (existingMatchesContainer?.["match"] ?? baseCategory["match"]) as
          | Record<string, unknown>
          | Record<string, unknown>[]
          | undefined,
      )
        .map((row) => asRecord(row))
        .filter((row): row is Record<string, unknown> => row !== null);

      const incomingMatchesContainer = asRecord(category["matches"]);
      const incomingMatches = toArray(
        (incomingMatchesContainer?.["match"] ?? category["match"]) as
          | Record<string, unknown>
          | Record<string, unknown>[]
          | undefined,
      )
        .map((row) => asRecord(row))
        .filter((row): row is Record<string, unknown> => row !== null);

      const seenMatchKeys = new Set(
        existingMatches.map((row) => toMatchKey(row)),
      );
      const mergedMatches = [...existingMatches];
      for (const match of incomingMatches) {
        const matchKey = toMatchKey(match);
        if (seenMatchKeys.has(matchKey)) continue;
        seenMatchKeys.add(matchKey);
        mergedMatches.push(match);
      }

      baseCategory["matches"] = { match: mergedMatches };
      categoryMap.set(categoryKey, baseCategory);
    }
  }

  return { scores: { category: [...categoryMap.values()] } };
}

function filterWorldChampionshipDiscovery(feed: unknown): unknown {
  const asRecord = (value: unknown): Record<string, unknown> | null => {
    if (!value || typeof value !== "object") return null;
    return value as Record<string, unknown>;
  };

  const toArray = <T>(value: T | T[] | null | undefined): T[] => {
    if (Array.isArray(value)) return value;
    return value == null ? [] : [value];
  };

  const readString = (
    obj: Record<string, unknown>,
    ...keys: string[]
  ): string => {
    for (const key of keys) {
      const value = obj[key];
      if (value == null) continue;
      return String(value).trim();
    }
    return "";
  };

  const normalize = (input: string): string =>
    input
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const categoryMatchesWorldChampionship = (
    category: Record<string, unknown>,
  ): boolean => {
    const categoryContext = normalize(
      `${readString(category, "country", "@file_group")} ${readString(category, "name", "@name")}`,
    );
    return /iihf|world championship/.test(categoryContext);
  };

  const root = asRecord(feed) ?? {};
  const scores = asRecord(root["scores"]) ?? {};
  const categories = toArray(scores["category"]);
  const worldCategories = categories
    .map((row) => asRecord(row))
    .filter((row): row is Record<string, unknown> => row !== null)
    .filter((row) => categoryMatchesWorldChampionship(row));

  return { scores: { category: worldCategories } };
}

function discoveryHasAnyMatches(feed: unknown): boolean {
  const asRecord = (value: unknown): Record<string, unknown> | null => {
    if (!value || typeof value !== "object") return null;
    return value as Record<string, unknown>;
  };

  const toArray = <T>(value: T | T[] | null | undefined): T[] => {
    if (Array.isArray(value)) return value;
    return value == null ? [] : [value];
  };

  const root = asRecord(feed) ?? {};
  const scores = asRecord(root["scores"]) ?? {};
  const categories = toArray(scores["category"])
    .map((row) => asRecord(row))
    .filter((row): row is Record<string, unknown> => row !== null);

  for (const category of categories) {
    const matchesContainer = asRecord(category["matches"]);
    const matches = toArray(
      (matchesContainer?.["match"] ?? category["match"]) as
        | Record<string, unknown>
        | Record<string, unknown>[]
        | undefined,
    );
    if (matches.length > 0) return true;
  }

  return false;
}

function getSanitizedWorldChampionshipSnapshot(): WorldChampionshipDiscoveryCache | null {
  if (!worldChampionshipDiscoveryCache) return null;

  const today = filterWorldChampionshipDiscovery(worldChampionshipDiscoveryCache.today);
  const tomorrow = filterWorldChampionshipDiscovery(
    worldChampionshipDiscoveryCache.tomorrow,
  );
  const hasMatches = discoveryHasAnyMatches(today) || discoveryHasAnyMatches(tomorrow);
  if (!hasMatches) return null;

  return {
    updatedAtMs: worldChampionshipDiscoveryCache.updatedAtMs,
    today,
    tomorrow,
  };
}

async function getHockeyDiscoveryCached(): Promise<{
  cacheUpdatedAtMs: number;
  stale: boolean;
  today: unknown;
  tomorrow: unknown;
}> {
  const now = Date.now();
  if (
    hockeyDiscoveryCache &&
    now - hockeyDiscoveryCache.updatedAtMs < HOCKEY_DISCOVERY_TTL_MS
  ) {
    return {
      cacheUpdatedAtMs: hockeyDiscoveryCache.updatedAtMs,
      stale: false,
      today: hockeyDiscoveryCache.today,
      tomorrow: hockeyDiscoveryCache.tomorrow,
    };
  }

  try {
    const [todayRes, tomorrowRes, dayAfterRes, twoDaysAfterRes] =
      await Promise.allSettled([
        fetchGoalserveHockey("home"),
        fetchGoalserveHockey("d1"),
        fetchGoalserveHockey("d2"),
        fetchGoalserveHockey("d3"),
      ]);

    const today =
      todayRes.status === "fulfilled" ? todayRes.value : emptyDiscoveryFeed();
    const tomorrowFeeds: unknown[] = [];
    if (tomorrowRes.status === "fulfilled")
      tomorrowFeeds.push(tomorrowRes.value);
    if (dayAfterRes.status === "fulfilled")
      tomorrowFeeds.push(dayAfterRes.value);
    if (twoDaysAfterRes.status === "fulfilled")
      tomorrowFeeds.push(twoDaysAfterRes.value);
    const tomorrow =
      tomorrowFeeds.length > 0
        ? mergeDiscoveryFeeds(tomorrowFeeds)
        : emptyDiscoveryFeed();

    if (
      todayRes.status === "rejected" &&
      tomorrowRes.status === "rejected" &&
      dayAfterRes.status === "rejected" &&
      twoDaysAfterRes.status === "rejected" &&
      hockeyDiscoveryCache
    ) {
      return {
        cacheUpdatedAtMs: hockeyDiscoveryCache.updatedAtMs,
        stale: true,
        today: hockeyDiscoveryCache.today,
        tomorrow: hockeyDiscoveryCache.tomorrow,
      };
    }

    hockeyDiscoveryCache = {
      updatedAtMs: now,
      today,
      tomorrow,
    };
    return {
      cacheUpdatedAtMs: now,
      stale: false,
      today,
      tomorrow,
    };
  } catch (err) {
    if (hockeyDiscoveryCache) {
      return {
        cacheUpdatedAtMs: hockeyDiscoveryCache.updatedAtMs,
        stale: true,
        today: hockeyDiscoveryCache.today,
        tomorrow: hockeyDiscoveryCache.tomorrow,
      };
    }
    throw err;
  }
}

async function getFootballDiscoveryCached(): Promise<{
  cacheUpdatedAtMs: number;
  stale: boolean;
  today: unknown;
  tomorrow: unknown;
}> {
  const now = Date.now();
  if (
    footballDiscoveryCache &&
    now - footballDiscoveryCache.updatedAtMs < FOOTBALL_DISCOVERY_TTL_MS
  ) {
    return {
      cacheUpdatedAtMs: footballDiscoveryCache.updatedAtMs,
      stale: false,
      today: footballDiscoveryCache.today,
      tomorrow: footballDiscoveryCache.tomorrow,
    };
  }

  try {
    const [todayRes, tomorrowRes] = await Promise.allSettled([
      fetchGoalserveFootball("home"),
      fetchGoalserveFootball("d1"),
    ]);

    const today =
      todayRes.status === "fulfilled" ? todayRes.value : emptyDiscoveryFeed();
    const tomorrow =
      tomorrowRes.status === "fulfilled"
        ? tomorrowRes.value
        : emptyDiscoveryFeed();

    if (
      todayRes.status === "rejected" &&
      tomorrowRes.status === "rejected" &&
      footballDiscoveryCache
    ) {
      return {
        cacheUpdatedAtMs: footballDiscoveryCache.updatedAtMs,
        stale: true,
        today: footballDiscoveryCache.today,
        tomorrow: footballDiscoveryCache.tomorrow,
      };
    }

    footballDiscoveryCache = {
      updatedAtMs: now,
      today,
      tomorrow,
    };
    return {
      cacheUpdatedAtMs: now,
      stale: false,
      today,
      tomorrow,
    };
  } catch (err) {
    if (footballDiscoveryCache) {
      return {
        cacheUpdatedAtMs: footballDiscoveryCache.updatedAtMs,
        stale: true,
        today: footballDiscoveryCache.today,
        tomorrow: footballDiscoveryCache.tomorrow,
      };
    }
    throw err;
  }
}

/** User slot = bot_wallet_index - 10 (indices 0-9 reserved for treasury/system) */
function userSlot(botWalletIndex: number): number {
  return botWalletIndex - 10;
}

/** Base port for a user's bots.  User slot 0 → 4010, slot 1 → 4020, … */
function userBasePort(botWalletIndex: number): number {
  return 4010 + userSlot(botWalletIndex) * 10;
}

function safeUser(user: User) {
  const botAllocations = getBotAllocations(user.metamask_address);
  return {
    metamaskAddress: user.metamask_address,
    botWalletAddress: user.bot_wallet_address,
    botWalletIndex: user.bot_wallet_index,
    // hasApiKeys now reflects whether Polymarket funder address (proxy wallet) is configured.
    // Bots auto-derive their API creds from the private key via clob-client-v2.
    hasApiKeys: !!user.poly_funder_address,
    funderAddress: user.poly_funder_address ?? null,
    botsRunning: user.bots_running === 1,
    autonomousMode: user.autonomous_mode === 1,
    createdAt: user.created_at,
    botAllocations,
  };
}

function isBotEnabled(user: User, botName: string): boolean {
  const allocations = getBotAllocations(user.metamask_address);
  return allocations[botName] !== false;
}

/** Call WDK treasury to derive a bot wallet at the given HD index. */
async function deriveWallet(
  index: number,
): Promise<{ address: string; signerKey: string }> {
  const res = await fetch(`${WDK_TREASURY_URL}/derive`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ index }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Treasury /derive failed (${res.status}): ${body}`);
  }
  return res.json() as Promise<{ address: string; signerKey: string }>;
}

/**
 * Call WDK treasury to get the deterministic deposit wallet address for a given
 * HD index. The deposit wallet is an ERC-1967 proxy deployed by the Polymarket
 * relayer. Bots use POLY_1271 (signatureType=3) with this address as both
 * POLYMARKET_WALLET_ADDRESS and POLYMARKET_FUNDER_ADDRESS.
 */
async function getDepositWalletAddress(
  index: number,
): Promise<{ depositWalletAddress: string; eoa: string }> {
  const res = await fetch(
    `${WDK_TREASURY_URL}/deposit-polymarket/address?index=${index}`,
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Treasury /deposit-polymarket/address failed (${res.status}): ${body}`,
    );
  }
  return res.json() as Promise<{ depositWalletAddress: string; eoa: string }>;
}

/** Run a shell command and return stdout (rejects on non-zero exit). */
function runCmd(cmd: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("close", (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`${cmd} exited ${code}: ${err.trim()}`));
    });
  });
}

type Pm2Proc = {
  name: string;
  pm2_env?: { status?: string };
};

async function getPm2Processes(): Promise<Pm2Proc[]> {
  const raw = await runCmd("pm2", ["jlist"]);
  return JSON.parse(raw) as Pm2Proc[];
}

async function ensureUserBotProcess(
  user: User,
  botName: string,
  totalEnabledBots: number,
): Promise<string> {
  const bot = getBotDef(botName);
  if (!bot) {
    throw new Error(`Unknown bot \"${botName}\"`);
  }

  const slot = userSlot(user.bot_wallet_index);
  const pmName = `${bot.name}-u${slot}`;

  try {
    const list = await getPm2Processes();
    const exists = list.some((p) => p.name === pmName);
    if (exists) return pmName;
  } catch {
    // Fall through and try creating the process definition.
  }

  const [{ signerKey }, { depositWalletAddress }] = await Promise.all([
    deriveWallet(user.bot_wallet_index),
    getDepositWalletAddress(user.bot_wallet_index),
  ]);

  if (!fs.existsSync(ENVS_DIR)) fs.mkdirSync(ENVS_DIR, { recursive: true });

  const app = {
    name: pmName,
    script: "npx",
    args: `tsx ${bot.entrypoint}`,
    cwd: path.join(REPO_ROOT, "bots", bot.folder),
    env: {
      PORT: String(userBasePort(user.bot_wallet_index) + bot.portOffset),
      BOT_ID: String(bot.botId),
      USER_METAMASK_ADDRESS: user.metamask_address,
      POLYMARKET_WALLET_ADDRESS: depositWalletAddress,
      BOT_SIGNER_KEY: signerKey,
      POLYMARKET_FUNDER_ADDRESS: depositWalletAddress,
      POLYMARKET_SIGNATURE_TYPE: "POLY_1271",
      ORCHESTRATOR_URL: `http://localhost:${process.env["PORT"] ?? 3002}`,
      TREASURY_URL: WDK_TREASURY_URL,
      BOT_COUNT: String(Math.max(1, totalEnabledBots)),
      PAPER_TRADING: "",
    },
  };

  const ecosystemPath = path.join(ENVS_DIR, `ecosystem-${pmName}.json`);
  fs.writeFileSync(ecosystemPath, JSON.stringify({ apps: [app] }, null, 2), {
    mode: 0o600,
  });

  await runCmd("pm2", ["start", ecosystemPath]);
  await runCmd("pm2", ["save"]);

  return pmName;
}

const router = Router();

// ── POST /users/register ─────────────────────────────────────────────────────

router.post(
  "/register",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { metamaskAddress } = req.body as { metamaskAddress?: string };
      if (!metamaskAddress || !/^0x[0-9a-fA-F]{40}$/.test(metamaskAddress)) {
        return res.status(400).json({ error: "Invalid metamaskAddress" });
      }

      // Look up or create the user record (allocates HD index)
      const user = upsertUser(metamaskAddress);

      // Derive bot wallet address if not yet stored
      if (!user.bot_wallet_address) {
        const { address } = await deriveWallet(user.bot_wallet_index);
        updateBotWalletAddress(metamaskAddress, address);
        user.bot_wallet_address = address;
      }

      return res.json(safeUser(user));
    } catch (err) {
      return next(err);
    }
  },
);

// ── GET /users/:address ───────────────────────────────────────────────────────
// Also syncs bots_running from actual PM2 state so the flag stays accurate
// even if bots were started/stopped outside the REST API.

router.get(
  "/:address",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { address } = req.params;
      const user = getUser(address);
      if (!user) return res.status(404).json({ error: "User not found" });

      // Cross-check PM2 status so the DB flag is always accurate.
      try {
        const slot = userSlot(user.bot_wallet_index);
        const raw = await runCmd("pm2", ["jlist"]);
        const list = JSON.parse(raw) as Array<{
          name: string;
          pm2_env?: { status?: string };
        }>;
        const anyOnline = BOT_DEFS.some((bot) => {
          const pmName = `${bot.name}-u${slot}`;
          const proc = list.find((p) => p.name === pmName);
          return proc?.pm2_env?.status === "online";
        });
        if (anyOnline && user.bots_running !== 1) {
          setBotsRunning(address, true);
          user.bots_running = 1;
        } else if (!anyOnline && user.bots_running === 1) {
          setBotsRunning(address, false);
          user.bots_running = 0;
        }
      } catch {
        // PM2 not available or no processes yet — ignore, use DB value
      }

      return res.json(safeUser(user));
    } catch (err) {
      return next(err);
    }
  },
);

// ── PUT /users/:address/api-keys ──────────────────────────────────────────────
// Kept for backward-compat; stores API key/secret/passphrase if provided.

router.put("/:address/api-keys", (req: Request, res: Response) => {
  const { address } = req.params;
  const { apiKey, apiSecret, apiPassphrase } = req.body as {
    apiKey?: string;
    apiSecret?: string;
    apiPassphrase?: string;
  };

  if (!apiKey || !apiSecret || !apiPassphrase) {
    return res
      .status(400)
      .json({ error: "apiKey, apiSecret, and apiPassphrase are required" });
  }

  const user = getUser(address);
  if (!user) return res.status(404).json({ error: "User not found" });

  updateApiKeys(address, apiKey, apiSecret, apiPassphrase);
  return res.json({ ok: true });
});

// ── PUT /users/:address/funder-address ─────────────────────────────────────────
// Save the Polymarket proxy wallet address (funderAddress for GNOSIS_SAFE sigs).

router.put("/:address/funder-address", (req: Request, res: Response) => {
  const { address } = req.params;
  const { funderAddress } = req.body as { funderAddress?: string };

  if (!funderAddress || !/^0x[0-9a-fA-F]{40}$/.test(funderAddress)) {
    return res.status(400).json({
      error: "Invalid funderAddress (must be a 0x-prefixed EVM address)",
    });
  }

  const user = getUser(address);
  if (!user) return res.status(404).json({ error: "User not found" });

  updateFunderAddress(address, funderAddress);
  return res.json({ ok: true });
});

// ── POST /users/:address/start-bots ───────────────────────────────────────────

router.post(
  "/:address/start-bots",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { address } = req.params;
      const user = getUser(address);
      if (!user) return res.status(404).json({ error: "User not found" });
      if (!user.bot_wallet_address) {
        return res.status(400).json({ error: "Bot wallet not yet derived" });
      }
      // Get the EOA signer key + the deterministic deposit wallet address.
      // Polymarket V2 requires a Deposit Wallet (ERC-1967 proxy) as the maker;
      // pure EOA (POLY_EOA) is blocked for new accounts on the CLOB.
      // The deposit wallet must be deployed and funded before starting bots
      // by calling POST /deposit-polymarket on the treasury service.
      const [{ signerKey }, { depositWalletAddress }] = await Promise.all([
        deriveWallet(user.bot_wallet_index),
        getDepositWalletAddress(user.bot_wallet_index),
      ]);

      // Write per-user env files and build PM2 app configs
      if (!fs.existsSync(ENVS_DIR)) fs.mkdirSync(ENVS_DIR, { recursive: true });

      const slot = userSlot(user.bot_wallet_index);
      const basePort = userBasePort(user.bot_wallet_index);
      const enabledBots = BOT_DEFS.filter((bot) =>
        isBotEnabled(user, bot.name),
      );
      if (enabledBots.length === 0) {
        return res.status(400).json({
          error:
            "No bots are enabled for this user. Tick at least one bot first.",
        });
      }

      const apps = enabledBots.map((bot) => {
        const port = basePort + bot.portOffset;
        const pmName = `${bot.name}-u${slot}`;
        const botDir = path.join(REPO_ROOT, "bots", bot.folder);

        return {
          name: pmName,
          script: "npx",
          args: `tsx ${bot.entrypoint}`,
          cwd: botDir,
          env: {
            PORT: String(port),
            BOT_ID: String(bot.botId),
            USER_METAMASK_ADDRESS: user.metamask_address,
            // Deposit wallet is the maker on all orders and the balance holder.
            // The EOA private key (BOT_SIGNER_KEY) signs on its behalf.
            POLYMARKET_WALLET_ADDRESS: depositWalletAddress,
            BOT_SIGNER_KEY: signerKey,
            POLYMARKET_FUNDER_ADDRESS: depositWalletAddress,
            POLYMARKET_SIGNATURE_TYPE: "POLY_1271",
            ORCHESTRATOR_URL: `http://localhost:${process.env["PORT"] ?? 3002}`,
            TREASURY_URL: WDK_TREASURY_URL,
            BOT_COUNT: String(enabledBots.length),
            PAPER_TRADING: "",
          },
        };
      });

      // Write the PM2 ecosystem JSON for this user
      const ecosystemPath = path.join(ENVS_DIR, `ecosystem-u${slot}.json`);
      fs.writeFileSync(ecosystemPath, JSON.stringify({ apps }, null, 2), {
        mode: 0o600,
      });

      // Start via PM2
      await runCmd("pm2", ["start", ecosystemPath]);
      await runCmd("pm2", ["save"]);

      // Auto-run deposit wallet setup (idempotent: skips already-done steps).
      // This deploys the deposit wallet, transfers pUSD, and sets approvals.
      // Non-fatal: bots start regardless (they'll error if wallet not ready).
      try {
        const depRes = await fetch(`${WDK_TREASURY_URL}/deposit-polymarket`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ index: user.bot_wallet_index }),
        });
        const depData = await depRes.json();
        console.log("[start-bots] deposit wallet setup:", depData);
      } catch (err) {
        console.warn(
          "[start-bots] deposit wallet setup failed (non-fatal):",
          (err as Error).message,
        );
      }

      setBotsRunning(address, true);

      const readiness = await Promise.all(
        enabledBots.map((b) => probeBotReadiness(user, b.name)),
      );

      return res.json({
        ok: true,
        slot,
        basePort,
        enabledBots: enabledBots.map((b) => b.name),
        readiness,
      });
    } catch (err) {
      return next(err);
    }
  },
);

// ── GET /users/:address/bots/:botName/watched-games ─────────────────────────

router.get("/:address/bots/:botName/watched-games", (req, res) => {
  const { address, botName } = req.params;
  const user = getUser(address);
  if (!user) return res.status(404).json({ error: "User not found" });
  if (!WATCHLIST_BOTS.has(botName)) {
    return res.status(400).json({
      error: `Unknown bot "${botName}" for watched games`,
    });
  }

  const games = getWatchedGames(address, botName);
  return res.json({ botName, games });
});

// ── GET /users/:address/bots/:botName/readiness ────────────────────────────

router.get("/:address/bots/:botName/readiness", async (req, res) => {
  const { address, botName } = req.params;
  const user = getUser(address);
  if (!user) return res.status(404).json({ error: "User not found" });

  const readiness = await probeBotReadiness(user, botName);
  return res.json({ ok: true, readiness });
});

// ── PUT /users/:address/bots/:botName/watched-games ─────────────────────────

router.put("/:address/bots/:botName/watched-games", async (req, res) => {
  const { address, botName } = req.params;
  const user = getUser(address);
  if (!user) return res.status(404).json({ error: "User not found" });
  if (!WATCHLIST_BOTS.has(botName)) {
    return res.status(400).json({
      error: `Unknown bot "${botName}" for watched games`,
    });
  }

  const { games } = req.body as { games?: WatchedGame[] };
  if (!Array.isArray(games)) {
    return res.status(400).json({ error: "games array is required" });
  }

  const normalized: WatchedGame[] = games
    .map((g) => {
      const key = String(g?.key ?? "").trim();
      const homeTeam = String(g?.homeTeam ?? "").trim();
      const awayTeam = String(g?.awayTeam ?? "").trim();
      if (!key || !homeTeam || !awayTeam) return null;
      return {
        key,
        sport: String(g?.sport ?? "hockey"),
        staticId: g?.staticId ? String(g.staticId) : undefined,
        fixId: g?.fixId ? String(g.fixId) : undefined,
        leagueName: g?.leagueName ? String(g.leagueName) : undefined,
        country: g?.country ? String(g.country) : undefined,
        homeTeam,
        awayTeam,
        date: g?.date ? String(g.date) : undefined,
        time: g?.time ? String(g.time) : undefined,
        statusAtAdd: g?.statusAtAdd ? String(g.statusAtAdd) : undefined,
        matchSlug: g?.matchSlug ? String(g.matchSlug) : undefined,
        yesTokenId: g?.yesTokenId ? String(g.yesTokenId) : undefined,
        noTokenId: g?.noTokenId ? String(g.noTokenId) : undefined,
        conditionId: g?.conditionId ? String(g.conditionId) : undefined,
        createdAt: Number(g?.createdAt ?? Date.now()),
      } as WatchedGame;
    })
    .filter((row): row is WatchedGame => row !== null);

  setWatchedGames(address, botName, normalized);

  const readiness = await probeBotReadiness(user, botName);
  return res.json({ ok: true, botName, games: normalized, readiness });
});

// ── GET /users/:address/bots/hockey-bot/discovery ───────────────────────────

router.get("/:address/bots/hockey-bot/discovery", async (req, res, next) => {
  try {
    const { address } = req.params;
    const user = getUser(address);
    if (!user) return res.status(404).json({ error: "User not found" });

    try {
      const payload = await getHockeyDiscoveryCached();
      return res.json({
        ok: true,
        bot: "hockey-bot",
        cacheTtlMs: HOCKEY_DISCOVERY_TTL_MS,
        cacheUpdatedAtMs: payload.cacheUpdatedAtMs,
        stale: payload.stale,
        today: payload.today,
        tomorrow: payload.tomorrow,
      });
    } catch (err) {
      return res.status(502).json({
        ok: false,
        bot: "hockey-bot",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } catch (err) {
    return next(err);
  }
});

// ── GET /users/:address/bots/hockey-bot/discovery/world-championship ───────

router.get(
  "/:address/bots/hockey-bot/discovery/world-championship",
  async (req, res, next) => {
    try {
      const { address } = req.params;
      const user = getUser(address);
      if (!user) return res.status(404).json({ error: "User not found" });

      try {
        const payload = await getHockeyDiscoveryCached();
        const today = filterWorldChampionshipDiscovery(payload.today);
        const tomorrow = filterWorldChampionshipDiscovery(payload.tomorrow);
        const hasMatches =
          discoveryHasAnyMatches(today) || discoveryHasAnyMatches(tomorrow);

        if (hasMatches) {
          worldChampionshipDiscoveryCache = {
            updatedAtMs: Date.now(),
            today,
            tomorrow,
          };
          saveWorldChampionshipCacheToDisk(worldChampionshipDiscoveryCache);
        }

        const sanitizedCached = getSanitizedWorldChampionshipSnapshot();
        if (!hasMatches && sanitizedCached) {
          return res.json({
            ok: true,
            bot: "hockey-bot",
            competition: "world-championship",
            cacheTtlMs: HOCKEY_DISCOVERY_TTL_MS,
            cacheUpdatedAtMs: sanitizedCached.updatedAtMs,
            stale: true,
            fallbackUsed: true,
            today: sanitizedCached.today,
            tomorrow: sanitizedCached.tomorrow,
          });
        }

        return res.json({
          ok: true,
          bot: "hockey-bot",
          competition: "world-championship",
          cacheTtlMs: HOCKEY_DISCOVERY_TTL_MS,
          cacheUpdatedAtMs: payload.cacheUpdatedAtMs,
          stale: payload.stale,
          fallbackUsed: false,
          today,
          tomorrow,
        });
      } catch (err) {
        const sanitizedCached = getSanitizedWorldChampionshipSnapshot();
        if (sanitizedCached) {
          return res.json({
            ok: true,
            bot: "hockey-bot",
            competition: "world-championship",
            cacheTtlMs: HOCKEY_DISCOVERY_TTL_MS,
            cacheUpdatedAtMs: sanitizedCached.updatedAtMs,
            stale: true,
            fallbackUsed: true,
            today: sanitizedCached.today,
            tomorrow: sanitizedCached.tomorrow,
          });
        }
        return res.status(502).json({
          ok: false,
          bot: "hockey-bot",
          competition: "world-championship",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } catch (err) {
      return next(err);
    }
  },
);

// ── GET /users/:address/bots/football-bot/discovery ─────────────────────────

router.get("/:address/bots/football-bot/discovery", async (req, res, next) => {
  try {
    const { address } = req.params;
    const user = getUser(address);
    if (!user) return res.status(404).json({ error: "User not found" });

    try {
      const payload = await getFootballDiscoveryCached();
      return res.json({
        ok: true,
        bot: "football-bot",
        cacheTtlMs: FOOTBALL_DISCOVERY_TTL_MS,
        cacheUpdatedAtMs: payload.cacheUpdatedAtMs,
        stale: payload.stale,
        today: payload.today,
        tomorrow: payload.tomorrow,
      });
    } catch (err) {
      return res.status(502).json({
        ok: false,
        bot: "football-bot",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } catch (err) {
    return next(err);
  }
});

// ── GET /users/:address/bots/football-bot/watchlist-state ───────────────────

router.get(
  "/:address/bots/football-bot/watchlist-state",
  async (req, res, next) => {
    try {
      const { address } = req.params;
      const user = getUser(address);
      if (!user) return res.status(404).json({ error: "User not found" });

      const botBaseUrl = getUserBotBaseUrl(user, "football-bot");
      if (!botBaseUrl) {
        return res.status(500).json({
          ok: false,
          bot: "football-bot",
          error: "Football bot definition not found",
        });
      }
      const targetUrl = `${botBaseUrl}/watchlist-state`;
      try {
        const botRes = await fetch(targetUrl, {
          signal: AbortSignal.timeout(4_000),
        });
        if (!botRes.ok) {
          return res.json({
            ok: false,
            bot: "football-bot",
            offline: true,
            watchlist: [],
            error: `Football bot watchlist-state returned ${botRes.status}`,
          });
        }
        return res.json(await botRes.json());
      } catch (err) {
        return res.json({
          ok: false,
          bot: "football-bot",
          offline: true,
          watchlist: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } catch (err) {
      return next(err);
    }
  },
);

// ── GET /users/:address/bots/football-bot/watchlist-state/:key ──────────────

router.get(
  "/:address/bots/football-bot/watchlist-state/:key",
  async (req, res, next) => {
    try {
      const { address } = req.params;
      const user = getUser(address);
      if (!user) return res.status(404).json({ error: "User not found" });

      const botBaseUrl = getUserBotBaseUrl(user, "football-bot");
      if (!botBaseUrl) {
        return res.status(500).json({
          ok: false,
          bot: "football-bot",
          error: "Football bot definition not found",
        });
      }
      const targetUrl = `${botBaseUrl}/watchlist-state/${req.params["key"]}`;
      try {
        const botRes = await fetch(targetUrl, {
          signal: AbortSignal.timeout(4_000),
        });
        if (!botRes.ok) {
          return res.json({
            ok: false,
            bot: "football-bot",
            offline: true,
            error: `Football bot watchlist-state returned ${botRes.status}`,
          });
        }
        return res.json(await botRes.json());
      } catch (err) {
        return res.json({
          ok: false,
          bot: "football-bot",
          offline: true,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } catch (err) {
      return next(err);
    }
  },
);

// ── GET /users/:address/bots/hockey-bot/watchlist-state ─────────────────────

router.get(
  "/:address/bots/hockey-bot/watchlist-state",
  async (req, res, next) => {
    try {
      const { address } = req.params;
      const user = getUser(address);
      if (!user) return res.status(404).json({ error: "User not found" });

      const botBaseUrl = getUserBotBaseUrl(user, "hockey-bot");
      if (!botBaseUrl) {
        return res.status(500).json({
          ok: false,
          bot: "hockey-bot",
          error: "Hockey bot definition not found",
        });
      }
      const targetUrl = `${botBaseUrl}/watchlist-state`;
      try {
        const botRes = await fetch(targetUrl, {
          signal: AbortSignal.timeout(4_000),
        });
        if (!botRes.ok) {
          return res.json({
            ok: false,
            bot: "hockey-bot",
            offline: true,
            watchlist: [],
            error: `Hockey bot watchlist-state returned ${botRes.status}`,
          });
        }
        return res.json(await botRes.json());
      } catch (err) {
        return res.json({
          ok: false,
          bot: "hockey-bot",
          offline: true,
          watchlist: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } catch (err) {
      return next(err);
    }
  },
);

// ── GET /users/:address/bots/hockey-bot/watchlist-state/:key ────────────────

router.get(
  "/:address/bots/hockey-bot/watchlist-state/:key",
  async (req, res, next) => {
    try {
      const { address, key } = req.params;
      const user = getUser(address);
      if (!user) return res.status(404).json({ error: "User not found" });

      const botBaseUrl = getUserBotBaseUrl(user, "hockey-bot");
      if (!botBaseUrl) {
        return res.status(500).json({
          ok: false,
          bot: "hockey-bot",
          error: "Hockey bot definition not found",
        });
      }
      const targetUrl = `${botBaseUrl}/watchlist-state/${encodeURIComponent(key ?? "")}`;
      try {
        const botRes = await fetch(targetUrl, {
          signal: AbortSignal.timeout(4_000),
        });
        if (!botRes.ok) {
          return res.json({
            ok: false,
            bot: "hockey-bot",
            offline: true,
            error: `Hockey bot watchlist-state returned ${botRes.status}`,
          });
        }
        return res.json(await botRes.json());
      } catch (err) {
        return res.json({
          ok: false,
          bot: "hockey-bot",
          offline: true,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } catch (err) {
      return next(err);
    }
  },
);

// ── POST /users/:address/stop-bots ────────────────────────────────────────────

router.post(
  "/:address/stop-bots",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { address } = req.params;
      const user = getUser(address);
      if (!user) return res.status(404).json({ error: "User not found" });

      const slot = userSlot(user.bot_wallet_index);

      // Stop (but keep) all PM2 processes for this user
      for (const bot of BOT_DEFS) {
        const pmName = `${bot.name}-u${slot}`;
        try {
          await runCmd("pm2", ["stop", pmName]);
        } catch {
          // Process may not exist yet — ignore
        }
      }

      setBotsRunning(address, false);
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  },
);

// ── GET /users/:address/deposit-wallet-address ────────────────────────────────
// Returns the deterministic deposit wallet address for a user (no balance).
// Used by the dashboard as a fallback when treasury hasn't been restarted yet.

router.get(
  "/:address/deposit-wallet-address",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { address } = req.params;
      const user = getUser(address);
      if (!user) return res.status(404).json({ error: "User not found" });
      const { depositWalletAddress, eoa } = await getDepositWalletAddress(
        user.bot_wallet_index,
      );
      return res.json({ depositWalletAddress, eoa });
    } catch (err) {
      return next(err);
    }
  },
);

// ── POST /users/:address/deposit-polymarket ───────────────────────────────────
// Manually trigger deposit wallet setup (idempotent).
// Deploys the deposit wallet, transfers pUSD, and sets approvals.

router.post(
  "/:address/deposit-polymarket",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { address } = req.params;
      const user = getUser(address);
      if (!user) return res.status(404).json({ error: "User not found" });

      const { amountUsdce } = req.body as { amountUsdce?: string };

      const depRes = await fetch(`${WDK_TREASURY_URL}/deposit-polymarket`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          index: user.bot_wallet_index,
          ...(amountUsdce ? { amountUsdce } : {}),
        }),
      });
      const depData = await depRes.json();
      if (!depRes.ok) {
        return res.status(depRes.status).json(depData);
      }
      return res.json(depData);
    } catch (err) {
      return next(err);
    }
  },
);

// ── POST /users/:address/bots/:botName/stop ───────────────────────────────────
// Stop a single named bot for a user (e.g. "market-maker").

router.post(
  "/:address/bots/:botName/stop",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { address, botName } = req.params;
      const user = getUser(address);
      if (!user) return res.status(404).json({ error: "User not found" });

      const valid = getBotDef(botName);
      if (!valid) {
        return res.status(400).json({
          error: `Unknown bot "${botName}". Valid: ${BOT_DEFS.map((b) => b.name).join(", ")}`,
        });
      }

      const slot = userSlot(user.bot_wallet_index);
      const pmName = `${botName}-u${slot}`;
      await runCmd("pm2", ["stop", pmName]);
      setBotAllocation(address, botName, false);
      return res.json({ ok: true, bot: pmName, action: "stopped" });
    } catch (err) {
      return next(err);
    }
  },
);

// ── POST /users/:address/bots/:botName/start ──────────────────────────────────
// Start a single named bot for a user.

router.post(
  "/:address/bots/:botName/start",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { address, botName } = req.params;
      const user = getUser(address);
      if (!user) return res.status(404).json({ error: "User not found" });

      const valid = getBotDef(botName);
      if (!valid) {
        return res.status(400).json({
          error: `Unknown bot "${botName}". Valid: ${BOT_DEFS.map((b) => b.name).join(", ")}`,
        });
      }

      const enabledCount = BOT_DEFS.filter((bot) =>
        isBotEnabled(user, bot.name),
      ).length;
      const slot = userSlot(user.bot_wallet_index);
      const pmName = `${botName}-u${slot}`;
      setBotAllocation(address, botName, true);
      await ensureUserBotProcess(user, botName, Math.max(1, enabledCount));
      await runCmd("pm2", ["start", pmName]);
      return res.json({ ok: true, bot: pmName, action: "started" });
    } catch (err) {
      return next(err);
    }
  },
);

// ── PUT /users/:address/bots/:botName/enabled ────────────────────────────────
// Persist a bot allocation toggle and start/stop the corresponding PM2 process.

router.put(
  "/:address/bots/:botName/enabled",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { address, botName } = req.params;
      const user = getUser(address);
      if (!user) return res.status(404).json({ error: "User not found" });

      const valid = getBotDef(botName);
      if (!valid) {
        return res.status(400).json({
          error: `Unknown bot \"${botName}\". Valid: ${BOT_DEFS.map((b) => b.name).join(", ")}`,
        });
      }

      const { enabled } = req.body as { enabled?: boolean };
      if (typeof enabled !== "boolean") {
        return res.status(400).json({ error: "enabled (boolean) is required" });
      }

      const slot = userSlot(user.bot_wallet_index);
      const pmName = `${botName}-u${slot}`;

      setBotAllocation(address, botName, enabled);

      if (enabled) {
        if (user.bots_running === 1) {
          const enabledCount = BOT_DEFS.filter((bot) =>
            isBotEnabled(user, bot.name),
          ).length;
          await ensureUserBotProcess(user, botName, Math.max(1, enabledCount));
          await runCmd("pm2", ["start", pmName]);
        }
      } else {
        try {
          await runCmd("pm2", ["stop", pmName]);
        } catch {
          // already stopped
        }
      }

      const anyEnabled = BOT_DEFS.some((bot) => isBotEnabled(user, bot.name));
      setBotsRunning(address, anyEnabled && user.bots_running === 1);

      return res.json({ ok: true, bot: pmName, enabled });
    } catch (err) {
      return next(err);
    }
  },
);

// ── GET /users/:address/bots/:botName/diagnostics ───────────────────────────
// Proxy to the local bot process so the dashboard can show live health and
// reconciliation state without reaching into PM2 directly.

router.get(
  "/:address/bots/:botName/diagnostics",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { address, botName } = req.params;
      const user = getUser(address);
      if (!user) return res.status(404).json({ error: "User not found" });

      const bot = getBotDef(botName);
      if (!bot) {
        return res.status(400).json({
          error: `Unknown bot "${botName}". Valid: ${BOT_DEFS.map((b) => b.name).join(", ")}`,
        });
      }

      const slot = userSlot(user.bot_wallet_index);
      const port = userBasePort(user.bot_wallet_index) + bot.portOffset;
      const url = `http://127.0.0.1:${port}/diagnostics`;

      try {
        const diagRes = await fetch(url, {
          signal: AbortSignal.timeout(4_000),
        });
        if (!diagRes.ok) {
          return res.status(502).json({
            ok: false,
            bot: bot.name,
            pmName: `${bot.name}-u${slot}`,
            enabled: isBotEnabled(user, bot.name),
            error: `Bot diagnostics returned ${diagRes.status}`,
          });
        }
        const diag = await diagRes.json();
        return res.json({
          ok: true,
          bot: bot.name,
          pmName: `${bot.name}-u${slot}`,
          enabled: isBotEnabled(user, bot.name),
          ...diag,
        });
      } catch (err) {
        return res.status(502).json({
          ok: false,
          bot: bot.name,
          pmName: `${bot.name}-u${slot}`,
          enabled: isBotEnabled(user, bot.name),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } catch (err) {
      return next(err);
    }
  },
);

// ── ALL /users/:address/bots/:botName/proxy/* ───────────────────────────────
// Generic per-user bot proxy used by dashboard hooks so they can talk to the
// correct user-scoped bot process instead of fixed global ports.

router.all(
  "/:address/bots/:botName/proxy/*",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { address, botName } = req.params;
      const user = getUser(address);
      if (!user) return res.status(404).json({ error: "User not found" });

      const bot = getBotDef(botName);
      if (!bot) {
        return res.status(400).json({
          error: `Unknown bot "${botName}". Valid: ${BOT_DEFS.map((b) => b.name).join(", ")}`,
        });
      }

      const botBaseUrl = getUserBotBaseUrl(user, botName);
      if (!botBaseUrl) {
        return res.status(400).json({ error: "Unsupported bot" });
      }

      const wildcard = (req.params as Record<string, string>)?.["0"] ?? "";
      const targetPath = wildcard.startsWith("/") ? wildcard : `/${wildcard}`;
      const query = req.url.includes("?")
        ? req.url.slice(req.url.indexOf("?"))
        : "";
      const targetUrl = `${botBaseUrl}${targetPath}${query}`;

      const headers: Record<string, string> = {};
      const contentType = req.header("content-type");
      if (contentType) headers["content-type"] = contentType;

      const method = req.method.toUpperCase();
      const hasBody = !["GET", "HEAD"].includes(method);

      let upstream: globalThis.Response;
      try {
        upstream = await fetch(targetUrl, {
          method,
          headers,
          body: hasBody ? JSON.stringify(req.body ?? {}) : undefined,
          signal: AbortSignal.timeout(8_000),
        });
      } catch (err) {
        return res.status(502).json({
          ok: false,
          bot: bot.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const bodyText = await upstream.text();
      const upstreamType = upstream.headers.get("content-type") ?? "";
      res.status(upstream.status);
      if (upstreamType.includes("application/json")) {
        return res.type("application/json").send(bodyText);
      }
      return res.type(upstreamType || "text/plain").send(bodyText);
    } catch (err) {
      return next(err);
    }
  },
);

// ── GET /users/:address/bots/status ──────────────────────────────────────────
// Return running/stopped state for each of the user's bots.

router.get(
  "/:address/bots/status",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { address } = req.params;
      const user = getUser(address);
      if (!user) return res.status(404).json({ error: "User not found" });

      const slot = userSlot(user.bot_wallet_index);

      const raw = await runCmd("pm2", ["jlist"]);
      const list = JSON.parse(raw) as Array<{
        name: string;
        pm2_env?: { status?: string };
      }>;

      const status = BOT_DEFS.map((bot) => {
        const pmName = `${bot.name}-u${slot}`;
        const proc = list.find((p) => p.name === pmName);
        return {
          name: bot.name,
          pmName,
          status: proc?.pm2_env?.status ?? "stopped",
          enabled: isBotEnabled(user, bot.name),
        };
      });

      return res.json(status);
    } catch (err) {
      return next(err);
    }
  },
);

// ── POST /users/:address/convert-funds ───────────────────────────────────────
// Triggers a USDT → USDC.e swap for the user's bot wallet via the treasury.

router.post(
  "/:address/convert-funds",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { address } = req.params;
      const user = getUser(address);
      if (!user) return res.status(404).json({ error: "User not found" });
      if (!user.bot_wallet_address) {
        return res.status(400).json({ error: "Bot wallet not yet derived" });
      }

      const { amountUsdt } = req.body as { amountUsdt?: string };

      const swapRes = await fetch(`${WDK_TREASURY_URL}/swap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index: user.bot_wallet_index, amountUsdt }),
      });

      if (!swapRes.ok) {
        const body = await swapRes.text();
        return res
          .status(502)
          .json({ error: `Treasury swap failed (${swapRes.status}): ${body}` });
      }

      const result = await swapRes.json();
      return res.json(result);
    } catch (err) {
      return next(err);
    }
  },
);

// ── PUT /users/:address/autonomous ───────────────────────────────────────────
// Toggle autonomous USDT→USDC.e auto-swap mode.

router.put("/:address/autonomous", (req: Request, res: Response) => {
  const { address } = req.params;
  const user = getUser(address);
  if (!user) return res.status(404).json({ error: "User not found" });

  const { enabled } = req.body as { enabled?: boolean };
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ error: "enabled (boolean) is required" });
  }

  setAutonomousMode(address, enabled);
  return res.json({ ok: true, autonomousMode: enabled });
});

// ── GET /users/:address/balance ───────────────────────────────────────────────
// Returns USDT, USDC.e and native POL balances for the bot wallet.

router.get(
  "/:address/balance",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { address } = req.params;
      const user = getUser(address);
      if (!user) return res.status(404).json({ error: "User not found" });

      const balRes = await fetch(`${WDK_TREASURY_URL}/balance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index: user.bot_wallet_index }),
      });

      if (!balRes.ok) {
        const body = await balRes.text();
        return res.status(502).json({
          error: `Treasury balance failed (${balRes.status}): ${body}`,
        });
      }

      return res.json(await balRes.json());
    } catch (err) {
      return next(err);
    }
  },
);

// ── POST /users/:address/withdraw ─────────────────────────────────────────────
// Full withdrawal flow:
//   1. Optionally stop PM2 bots
//   2. Swap all USDC.e → USDT via treasury /swap-reverse
//   3. Transfer USDT from bot wallet → user's MetaMask address

router.post(
  "/:address/withdraw",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { address } = req.params;
      const { amountUsdt, stopBots: doStopBots } = req.body as {
        amountUsdt?: string;
        stopBots?: boolean;
      };

      const user = getUser(address);
      if (!user) return res.status(404).json({ error: "User not found" });
      if (!user.bot_wallet_address) {
        return res.status(400).json({ error: "Bot wallet not yet derived" });
      }

      // ── Step 1: Optionally stop bots ───────────────────────────────────────

      if (doStopBots && user.bots_running === 1) {
        const slot = userSlot(user.bot_wallet_index);
        for (const bot of BOT_DEFS) {
          const pmName = `${bot.name}-u${slot}`;
          try {
            await runCmd("pm2", ["stop", pmName]);
          } catch {
            // Process may not exist — ignore
          }
        }
        setBotsRunning(address, false);
      }

      // ── Step 2: Swap USDC.e → USDT (skip gracefully if no balance) ─────────

      let swapTxHash: string | undefined;
      let usdceSwapped: string | undefined;
      let usdtReceived: string | undefined;

      const swapRes = await fetch(`${WDK_TREASURY_URL}/swap-reverse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index: user.bot_wallet_index }),
      });

      if (swapRes.ok) {
        const swapResult = (await swapRes.json()) as {
          txHash: string;
          usdceSwapped: string;
          usdtReceived: string;
        };
        swapTxHash = swapResult.txHash;
        usdceSwapped = swapResult.usdceSwapped;
        usdtReceived = swapResult.usdtReceived;
      } else {
        const body = await swapRes.text();
        // "No USDC.e balance to swap" is expected when user only has USDT
        if (!body.includes("No USDC.e balance")) {
          return res.status(502).json({
            error: `USDC.e → USDT swap failed (${swapRes.status}): ${body}`,
          });
        }
      }

      // ── Step 3: Transfer USDT → user's MetaMask address ────────────────────

      const withdrawBody: {
        index: number;
        toAddress: string;
        amountUsdt?: string;
      } = {
        index: user.bot_wallet_index,
        toAddress: address, // always send to the user's own MetaMask address
      };
      if (amountUsdt) withdrawBody.amountUsdt = amountUsdt;

      const withdrawRes = await fetch(`${WDK_TREASURY_URL}/withdraw`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withdrawBody),
      });

      if (!withdrawRes.ok) {
        const body = await withdrawRes.text();
        return res.status(502).json({
          error: `Withdrawal transfer failed (${withdrawRes.status}): ${body}`,
        });
      }

      const withdrawResult = (await withdrawRes.json()) as {
        txHash: string;
        from: string;
        to: string;
        amount: string;
      };

      // ── Step 4: Drain USDC.e from deposit wallet → MetaMask (gasless) ──────
      // The deposit wallet holds any USDC.e received from redeemed positions.
      // It can only be moved via the Polymarket gasless relayer (no POL needed).

      let depositWithdrawTxHash: string | undefined;
      let depositAmountWithdrawn: string | undefined;

      const depositWithdrawRes = await fetch(
        `${WDK_TREASURY_URL}/withdraw-deposit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            index: user.bot_wallet_index,
            toAddress: address,
            // amountUsdce omitted → sends full balance
          }),
        },
      );

      if (depositWithdrawRes.ok) {
        const dr = (await depositWithdrawRes.json()) as {
          txHash: string;
          amount: string;
        };
        depositWithdrawTxHash = dr.txHash;
        depositAmountWithdrawn = dr.amount;
      } else {
        const body = await depositWithdrawRes.text();
        // "No USDC.e balance" is fine — deposit wallet may already be empty
        if (!body.includes("No USDC.e balance")) {
          console.error(
            `[withdraw] deposit wallet drain failed (${depositWithdrawRes.status}): ${body}`,
          );
        }
      }

      return res.json({
        swapTxHash,
        usdceSwapped,
        usdtReceived,
        withdrawTxHash: withdrawResult.txHash,
        amountWithdrawn: withdrawResult.amount,
        to: withdrawResult.to,
        depositWithdrawTxHash,
        depositAmountWithdrawn,
      });
    } catch (err) {
      return next(err);
    }
  },
);

export default router;
