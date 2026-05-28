/**
 * user-store.ts
 *
 * SQLite-backed user registry for multi-user support.
 *
 * Each user is identified by their MetaMask EOA address.
 * On registration, a unique HD wallet index is allocated from the WDK
 * treasury seed phrase — the resulting address becomes their bot EOA.
 *
 * DB file: orchestrator/data/users.db (auto-created on first run)
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../../data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "users.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ── Schema ───────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    metamask_address   TEXT PRIMARY KEY COLLATE NOCASE,
    bot_wallet_index   INTEGER UNIQUE NOT NULL,
    bot_wallet_address TEXT,
    poly_api_key       TEXT,
    poly_api_secret    TEXT,
    poly_api_passphrase TEXT,
    poly_funder_address TEXT,
    bot_allocations_json TEXT NOT NULL DEFAULT '{}',
    sports_trade_amounts_json TEXT NOT NULL DEFAULT '{}',
    watched_games_json TEXT NOT NULL DEFAULT '{}',
    bots_running       INTEGER NOT NULL DEFAULT 0,
    autonomous_mode    INTEGER NOT NULL DEFAULT 0,
    created_at         INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Start user bot wallet indices at 10 (0-3 are reserved for treasury+bot1/2/3)
  INSERT OR IGNORE INTO meta (key, value) VALUES ('next_wallet_index', '10');
`);

// Migration: add autonomous_mode to databases that predate this column
if (
  !db
    .prepare(
      "SELECT name FROM pragma_table_info('users') WHERE name = 'autonomous_mode'",
    )
    .get()
) {
  db.exec(
    "ALTER TABLE users ADD COLUMN autonomous_mode INTEGER NOT NULL DEFAULT 0",
  );
}

// Migration: add poly_funder_address to databases that predate this column
if (
  !db
    .prepare(
      "SELECT name FROM pragma_table_info('users') WHERE name = 'poly_funder_address'",
    )
    .get()
) {
  db.exec("ALTER TABLE users ADD COLUMN poly_funder_address TEXT");
}

// Migration: add bot_allocations_json to databases that predate this column
if (
  !db
    .prepare(
      "SELECT name FROM pragma_table_info('users') WHERE name = 'bot_allocations_json'",
    )
    .get()
) {
  db.exec(
    "ALTER TABLE users ADD COLUMN bot_allocations_json TEXT NOT NULL DEFAULT '{}'",
  );
}

// Migration: add sports_trade_amounts_json to databases that predate this column
if (
  !db
    .prepare(
      "SELECT name FROM pragma_table_info('users') WHERE name = 'sports_trade_amounts_json'",
    )
    .get()
) {
  db.exec(
    "ALTER TABLE users ADD COLUMN sports_trade_amounts_json TEXT NOT NULL DEFAULT '{}'",
  );
}

// Migration: add watched_games_json to databases that predate this column
if (
  !db
    .prepare(
      "SELECT name FROM pragma_table_info('users') WHERE name = 'watched_games_json'",
    )
    .get()
) {
  db.exec(
    "ALTER TABLE users ADD COLUMN watched_games_json TEXT NOT NULL DEFAULT '{}'",
  );
}

// ── Prepared statements ───────────────────────────────────────────────────────

const stmtGetUser = db.prepare<[string]>(
  "SELECT * FROM users WHERE metamask_address = ?",
);
const stmtInsertUser = db.prepare<[string, number]>(
  "INSERT INTO users (metamask_address, bot_wallet_index) VALUES (?, ?)",
);
const stmtUpdateBotAddress = db.prepare<[string, string]>(
  "UPDATE users SET bot_wallet_address = ? WHERE metamask_address = ?",
);
const stmtUpdateApiKeys = db.prepare<[string, string, string, string]>(
  "UPDATE users SET poly_api_key = ?, poly_api_secret = ?, poly_api_passphrase = ? WHERE metamask_address = ?",
);
const stmtUpdateFunderAddress = db.prepare<[string, string]>(
  "UPDATE users SET poly_funder_address = ? WHERE metamask_address = ?",
);
const stmtUpdateBotAllocations = db.prepare<[string, string]>(
  "UPDATE users SET bot_allocations_json = ? WHERE metamask_address = ?",
);
const stmtUpdateSportsTradeAmounts = db.prepare<[string, string]>(
  "UPDATE users SET sports_trade_amounts_json = ? WHERE metamask_address = ?",
);
const stmtUpdateWatchedGames = db.prepare<[string, string]>(
  "UPDATE users SET watched_games_json = ? WHERE metamask_address = ?",
);
const stmtSetBotsRunning = db.prepare<[number, string]>(
  "UPDATE users SET bots_running = ? WHERE metamask_address = ?",
);
const stmtSetAutonomousMode = db.prepare<[number, string]>(
  "UPDATE users SET autonomous_mode = ? WHERE metamask_address = ?",
);
const stmtGetAllUsers = db.prepare("SELECT * FROM users");
const stmtGetMeta = db.prepare<[string]>(
  "SELECT value FROM meta WHERE key = ?",
);
const stmtSetMeta = db.prepare<[string, string]>(
  "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface User {
  metamask_address: string;
  bot_wallet_index: number;
  bot_wallet_address: string | null;
  poly_api_key: string | null;
  poly_api_secret: string | null;
  poly_api_passphrase: string | null;
  poly_funder_address: string | null;
  bot_allocations_json: string | null;
  sports_trade_amounts_json: string | null;
  watched_games_json: string | null;
  bots_running: number;
  autonomous_mode: number;
  created_at: number;
}

export interface WatchedGame {
  key: string;
  sport: string;
  staticId?: string;
  fixId?: string;
  leagueName?: string;
  country?: string;
  homeTeam: string;
  awayTeam: string;
  date?: string;
  time?: string;
  statusAtAdd?: string;
  matchSlug?: string;
  yesTokenId?: string;
  noTokenId?: string;
  conditionId?: string;
  createdAt: number;
}

function parseBotAllocations(
  raw: string | null | undefined,
): Record<string, boolean> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed)) {
      result[key] = value === true;
    }
    return result;
  } catch {
    return {};
  }
}

function stringifyBotAllocations(allocations: Record<string, boolean>): string {
  return JSON.stringify(allocations);
}

function parseSportsTradeAmounts(
  raw: string | null | undefined,
): Record<string, number> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) continue;
      result[key] = Number(n.toFixed(6));
    }
    return result;
  } catch {
    return {};
  }
}

function stringifySportsTradeAmounts(amounts: Record<string, number>): string {
  return JSON.stringify(amounts);
}

function parseWatchedGamesMap(
  raw: string | null | undefined,
): Record<string, WatchedGame[]> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result: Record<string, WatchedGame[]> = {};
    for (const [botName, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) continue;
      result[botName] = value
        .map((entry) => {
          if (typeof entry !== "object" || entry === null) return null;
          const row = entry as Record<string, unknown>;
          const key = String(row["key"] ?? "").trim();
          const homeTeam = String(row["homeTeam"] ?? "").trim();
          const awayTeam = String(row["awayTeam"] ?? "").trim();
          if (!key || !homeTeam || !awayTeam) return null;
          return {
            key,
            sport: String(row["sport"] ?? "hockey"),
            staticId: row["staticId"] ? String(row["staticId"]) : undefined,
            fixId: row["fixId"] ? String(row["fixId"]) : undefined,
            leagueName: row["leagueName"]
              ? String(row["leagueName"])
              : undefined,
            country: row["country"] ? String(row["country"]) : undefined,
            homeTeam,
            awayTeam,
            date: row["date"] ? String(row["date"]) : undefined,
            time: row["time"] ? String(row["time"]) : undefined,
            statusAtAdd: row["statusAtAdd"]
              ? String(row["statusAtAdd"])
              : undefined,
            matchSlug: row["matchSlug"] ? String(row["matchSlug"]) : undefined,
            yesTokenId: row["yesTokenId"]
              ? String(row["yesTokenId"])
              : undefined,
            noTokenId: row["noTokenId"] ? String(row["noTokenId"]) : undefined,
            conditionId: row["conditionId"]
              ? String(row["conditionId"])
              : undefined,
            createdAt: Number(row["createdAt"] ?? Date.now()),
          } as WatchedGame;
        })
        .filter((row): row is WatchedGame => row !== null);
    }
    return result;
  } catch {
    return {};
  }
}

function stringifyWatchedGamesMap(
  watchedGames: Record<string, WatchedGame[]>,
): string {
  return JSON.stringify(watchedGames);
}

// ── Public helpers ────────────────────────────────────────────────────────────

export function getUser(address: string): User | undefined {
  return stmtGetUser.get(address) as User | undefined;
}

/** Allocate the next free HD wallet index (thread-safe via synchronous SQLite). */
function allocateNextIndex(): number {
  const row = stmtGetMeta.get("next_wallet_index") as { value: string };
  const index = parseInt(row.value, 10);
  stmtSetMeta.run("next_wallet_index", String(index + 1));
  return index;
}

/**
 * Look up or create a user record for the given MetaMask address.
 * Returns the existing record if the address is already registered.
 */
export const upsertUser = db.transaction((address: string): User => {
  const existing = getUser(address);
  if (existing) return existing;
  const index = allocateNextIndex();
  stmtInsertUser.run(address, index);
  return getUser(address)!;
});

export function updateBotWalletAddress(
  metamaskAddress: string,
  botAddress: string,
): void {
  stmtUpdateBotAddress.run(botAddress, metamaskAddress);
}

export function updateApiKeys(
  metamaskAddress: string,
  apiKey: string,
  apiSecret: string,
  apiPassphrase: string,
): void {
  stmtUpdateApiKeys.run(apiKey, apiSecret, apiPassphrase, metamaskAddress);
}

export function updateFunderAddress(
  metamaskAddress: string,
  funderAddress: string,
): void {
  stmtUpdateFunderAddress.run(funderAddress, metamaskAddress);
}

export function getBotAllocations(address: string): Record<string, boolean> {
  const user = getUser(address);
  return parseBotAllocations(user?.bot_allocations_json);
}

export function setBotAllocation(
  metamaskAddress: string,
  botName: string,
  enabled: boolean,
): void {
  const allocations = getBotAllocations(metamaskAddress);
  allocations[botName] = enabled;
  stmtUpdateBotAllocations.run(
    stringifyBotAllocations(allocations),
    metamaskAddress,
  );
}

export function setAllBotAllocations(
  metamaskAddress: string,
  enabled: boolean,
  botNames: string[],
): void {
  const allocations = getBotAllocations(metamaskAddress);
  for (const botName of botNames) allocations[botName] = enabled;
  stmtUpdateBotAllocations.run(
    stringifyBotAllocations(allocations),
    metamaskAddress,
  );
}

export function getSportsTradeAmounts(address: string): Record<string, number> {
  const user = getUser(address);
  return parseSportsTradeAmounts(user?.sports_trade_amounts_json);
}

export function getSportsTradeAmount(
  address: string,
  botName: string,
  fallback: number,
): number {
  const amounts = getSportsTradeAmounts(address);
  const n = Number(amounts[botName]);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Number(n.toFixed(6));
}

export function setSportsTradeAmount(
  metamaskAddress: string,
  botName: string,
  amountUsd: number,
): void {
  const amounts = getSportsTradeAmounts(metamaskAddress);
  amounts[botName] = Number(amountUsd.toFixed(6));
  stmtUpdateSportsTradeAmounts.run(
    stringifySportsTradeAmounts(amounts),
    metamaskAddress,
  );
}

export function getWatchedGames(
  metamaskAddress: string,
  botName: string,
): WatchedGame[] {
  const user = getUser(metamaskAddress);
  const map = parseWatchedGamesMap(user?.watched_games_json);
  return map[botName] ?? [];
}

export function setWatchedGames(
  metamaskAddress: string,
  botName: string,
  games: WatchedGame[],
): void {
  const user = getUser(metamaskAddress);
  const map = parseWatchedGamesMap(user?.watched_games_json);
  map[botName] = games;
  stmtUpdateWatchedGames.run(stringifyWatchedGamesMap(map), metamaskAddress);
}

export function setBotsRunning(
  metamaskAddress: string,
  running: boolean,
): void {
  stmtSetBotsRunning.run(running ? 1 : 0, metamaskAddress);
}

export function setAutonomousMode(
  metamaskAddress: string,
  enabled: boolean,
): void {
  stmtSetAutonomousMode.run(enabled ? 1 : 0, metamaskAddress);
}

export function getAllUsers(): User[] {
  return stmtGetAllUsers.all() as User[];
}
