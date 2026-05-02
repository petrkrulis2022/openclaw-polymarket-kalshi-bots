/**
 * wdk.ts
 *
 * Initialises the Tether WDK instance and exports helpers used across all routes.
 * This module loads `.env` via dotenv before anything else, so importing it early
 * in the dependency graph is safe.
 *
 * Wallet index mapping:
 *   0 – Treasury  (holds the main USD₮ reserve)
 *   1 – Bot 1     (Polymarket market-maker)
 *   2 – Bot 2     (Polymarket–Kalshi arb)
 *   3 – Bot 3     (Polymarket copy-trader)
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import { Mnemonic, randomBytes } from "ethers";
import WDK from "@tetherto/wdk";
import WalletManagerEvm from "@tetherto/wdk-wallet-evm";

// ── Seed phrase: load or generate ─────────────────────────────────────────────

function getOrCreateSeedPhrase(): string {
  if (process.env.SEED_PHRASE) return process.env.SEED_PHRASE;

  // Generate a fresh 12-word BIP-39 mnemonic
  const mnemonic = Mnemonic.entropyToPhrase(randomBytes(16));
  process.env.SEED_PHRASE = mnemonic;

  // Persist to .env so the same wallet is used on next restart
  const envPath = path.resolve(process.cwd(), ".env");
  const existing = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, "utf8")
    : "";
  fs.writeFileSync(
    envPath,
    existing + `\nSEED_PHRASE="${mnemonic}"\n`,
    { mode: 0o600 }, // owner-readable only
  );

  console.log("\n" + "═".repeat(60));
  console.log("🆕  NEW WALLET GENERATED");
  console.log("═".repeat(60));
  console.log("Seed phrase (back this up — it controls real funds!):");
  console.log(`\n  ${mnemonic}\n`);
  console.log("Saved to .env — DO NOT commit .env to version control.");
  console.log("═".repeat(60) + "\n");

  return mnemonic;
}

export const SEED_PHRASE = getOrCreateSeedPhrase();
export const USDT_TOKEN_ADDRESS =
  process.env.USDT_TOKEN_ADDRESS ??
  "0xc2132D05D31c914a87C6611C10748AEb04B58e8F";
export const POLYGON_RPC =
  process.env.POLYGON_RPC ?? "https://polygon-bor-rpc.publicnode.com";

// ── Wallet index constants ────────────────────────────────────────────────────

export const WALLET_INDEX = {
  treasury: 0,
  bot1: 1,
  bot2: 2,
  bot3: 3,
} as const;

/** Valid bot IDs accepted by /allocate and /recall endpoints. */
export const VALID_BOT_IDS = new Set<number>([1, 2, 3]);

export type BotId = 1 | 2 | 3;

/** Map botId (1-3) to the WALLET_INDEX key. */
export function botIndexForId(botId: BotId): number {
  return WALLET_INDEX[`bot${botId}` as "bot1" | "bot2" | "bot3"];
}

// ── WDK initialisation ────────────────────────────────────────────────────────
//
// The WDK instance is created once at startup. The seed phrase stays in memory
// for the lifetime of the process so the service can sign transactions.
// Derived account keys (per-request) are disposed after use — see getAccount().

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _wdk: any = new (WDK as any)(SEED_PHRASE).registerWallet(
  "polygon",
  WalletManagerEvm,
  { provider: POLYGON_RPC },
);

/**
 * Derive a WDK EVM account for the given wallet index.
 *
 * **IMPORTANT**: always call `account.dispose()` (or `account?.dispose?.()`)
 * after use to clear the derived private key from memory.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getAccount(index: number): Promise<any> {
  return _wdk.getAccount("polygon", index);
}

// ── USD₮ decimal helpers (6 decimals on Polygon) ─────────────────────────────

const SCALE = 1_000_000n; // 10^6

/**
 * Convert a human-readable decimal string (e.g. "1.5") to raw bigint base units.
 * Truncates fractional part to 6 places. Throws on invalid or zero input.
 *
 * Examples:
 *   "1"       → 1_000_000n
 *   "1.5"     → 1_500_000n
 *   "0.001"   → 1_000n
 */
export function parseUsdT(amountStr: string): bigint {
  const trimmed = (amountStr ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(
      `Invalid amount "${trimmed}": must be a non-negative decimal number (e.g. "1.5").`,
    );
  }
  const [whole, frac = ""] = trimmed.split(".");
  const fracPadded = frac.slice(0, 6).padEnd(6, "0");
  const result = BigInt(whole) * SCALE + BigInt(fracPadded);
  if (result === 0n) {
    throw new Error("Amount must be greater than zero.");
  }
  return result;
}

/**
 * Convert raw bigint base units to a human-readable decimal string (6 decimal places).
 *
 * Examples:
 *   1_000_000n → "1.000000"
 *   1_500_000n → "1.500000"
 *   0n         → "0.000000"
 */
export function formatUsdT(amount: bigint): string {
  const whole = amount / SCALE;
  const frac = (amount % SCALE).toString().padStart(6, "0");
  return `${whole}.${frac}`;
}
