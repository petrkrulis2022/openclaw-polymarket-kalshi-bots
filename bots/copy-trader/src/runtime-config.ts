// ── Runtime-mutable state for the copy-trader bot ──────────────────────────

import fs from "fs";

export interface TrackedTrader {
  /** Polymarket proxy wallet address (from profile URL, e.g. polymarket.com/profile/0x...) */
  address: string;
  /** Human-readable display name */
  label: string;
  /** Maximum USD allocated to copy this trader */
  allocationUsd: number;
  /**
   * Fraction of the trader's position delta to replicate.
   * copyRatio=0.1 → for every $1 they trade, we trade $0.10.
   */
  copyRatio: number;
  /** How approvals work for this trader's signals */
  mode: "manual" | "auto" | "orchestrator";
  /** Pause copying without removing the trader */
  enabled: boolean;
  addedAt: string;
}

export interface CopyTradingParams {
  /** How often to poll each trader's positions (ms) */
  pollIntervalMs: number;
  /** How often to push metrics to orchestrator (ms) */
  metricsIntervalMs: number;
  /**
   * How long a pending trade stays in queue before auto-expiring (ms).
   * Default: 5 minutes.
   */
  pendingExpiryMs: number;
  /** Minimum signal size in USD — ignore smaller moves */
  minSignalUsd: number;
  /**
   * Maximum allowed execution price drift from detected signal price.
   * Example: 0.15 = max 15% move.
   */
  maxSignalDriftPct: number;
}

const DEFAULTS: Readonly<CopyTradingParams> = Object.freeze({
  pollIntervalMs: 10_000,
  metricsIntervalMs: 30_000,
  pendingExpiryMs: 5 * 60 * 1_000,
  minSignalUsd: 3.0,
  maxSignalDriftPct: 0.15,
});

// ── Mutable singletons ───────────────────────────────────────────────────────

export let params: CopyTradingParams = { ...DEFAULTS };

// Ordered list of traders to copy
export const traders: TrackedTrader[] = [];

// ── Trader persistence ───────────────────────────────────────────────────────

// Prefer an explicit TRADERS_STATE_FILE, but fall back to a path derived from
// POSITIONS_STATE_FILE (which the orchestrator always sets). This makes the
// tracked-trader list survive restarts even when the orchestrator didn't inject
// TRADERS_STATE_FILE — no re-spawn or env gymnastics required.
const TRADERS_FILE =
  process.env["TRADERS_STATE_FILE"] ||
  (process.env["POSITIONS_STATE_FILE"]
    ? process.env["POSITIONS_STATE_FILE"].replace(/\.json$/, "-traders.json")
    : "");

function saveTraders(): void {
  if (!TRADERS_FILE) return;
  try {
    fs.writeFileSync(
      TRADERS_FILE,
      JSON.stringify({ traders, savedAt: new Date().toISOString() }, null, 2),
      "utf-8",
    );
  } catch {
    /* non-fatal */
  }
}

export function loadTraders(): void {
  if (!TRADERS_FILE || !fs.existsSync(TRADERS_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(TRADERS_FILE, "utf-8")) as {
      traders: TrackedTrader[];
    };
    traders.length = 0;
    traders.push(...(raw.traders ?? []));
    console.log(`[runtime-config] Loaded ${traders.length} trader(s) from disk.`);
  } catch (err) {
    console.warn(
      "[runtime-config] Failed to load traders:",
      (err as Error).message,
    );
  }
}

// ── Param helpers ────────────────────────────────────────────────────────────

export function updateParams(patch: Partial<CopyTradingParams>): void {
  params = { ...params, ...patch };
}

export function resetParams(): void {
  params = { ...DEFAULTS };
}

export function getParams(): CopyTradingParams {
  return { ...params };
}

export function getDefaults(): Readonly<CopyTradingParams> {
  return DEFAULTS;
}

// ── Trader helpers ────────────────────────────────────────────────────────────

export function addTrader(t: TrackedTrader): void {
  const idx = traders.findIndex((x) => x.address === t.address);
  if (idx !== -1) {
    traders[idx] = t;
  } else {
    traders.push(t);
  }
  saveTraders();
}

export function removeTrader(address: string): boolean {
  const idx = traders.findIndex((x) => x.address === address);
  if (idx === -1) return false;
  traders.splice(idx, 1);
  saveTraders();
  return true;
}

export function updateTrader(
  address: string,
  patch: Partial<Omit<TrackedTrader, "address" | "addedAt">>,
): TrackedTrader | null {
  const t = traders.find((x) => x.address === address);
  if (!t) return null;
  Object.assign(t, patch);
  saveTraders();
  return { ...t };
}

export function getTrader(address: string): TrackedTrader | undefined {
  return traders.find((x) => x.address === address);
}
