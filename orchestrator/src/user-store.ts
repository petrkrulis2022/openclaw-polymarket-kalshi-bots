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
    bots_running       INTEGER NOT NULL DEFAULT 0,
    created_at         INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Start user bot wallet indices at 10 (0-3 are reserved for treasury+bot1/2/3)
  INSERT OR IGNORE INTO meta (key, value) VALUES ('next_wallet_index', '10');
`);

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
const stmtSetBotsRunning = db.prepare<[number, string]>(
  "UPDATE users SET bots_running = ? WHERE metamask_address = ?",
);
const stmtGetMeta = db.prepare<[string]>("SELECT value FROM meta WHERE key = ?");
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
  bots_running: number;
  created_at: number;
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

export function setBotsRunning(metamaskAddress: string, running: boolean): void {
  stmtSetBotsRunning.run(running ? 1 : 0, metamaskAddress);
}
