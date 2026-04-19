// ── Runtime-mutable state for the copy-trader bot ──────────────────────────

export interface TrackedTrader {
  /** Polymarket proxy wallet address (from profile URL, e.g. polymarket.com/profile/0x...) */
  address: string;
  /** Human-readable display name */
  label: string;
  /** Maximum USD allocated to copy this trader */
  allocationUsd: number;
  /**
   * Fraction of the trader's position size to replicate.
   * 1.0 = match fully relative to allocationUsd, 0.5 = half.
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
}

const DEFAULTS: Readonly<CopyTradingParams> = Object.freeze({
  pollIntervalMs: 10_000,
  metricsIntervalMs: 30_000,
  pendingExpiryMs: 5 * 60 * 1_000,
  minSignalUsd: 3.0,
});

// ── Mutable singletons ───────────────────────────────────────────────────────

export let params: CopyTradingParams = { ...DEFAULTS };

// Ordered list of traders to copy
export const traders: TrackedTrader[] = [];

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
}

export function removeTrader(address: string): boolean {
  const idx = traders.findIndex((x) => x.address === address);
  if (idx === -1) return false;
  traders.splice(idx, 1);
  return true;
}

export function updateTrader(
  address: string,
  patch: Partial<Omit<TrackedTrader, "address" | "addedAt">>,
): TrackedTrader | null {
  const t = traders.find((x) => x.address === address);
  if (!t) return null;
  Object.assign(t, patch);
  return { ...t };
}

export function getTrader(address: string): TrackedTrader | undefined {
  return traders.find((x) => x.address === address);
}
