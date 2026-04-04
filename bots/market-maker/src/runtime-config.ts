/**
 * Mutable runtime configuration for the market maker bot.
 *
 * These parameters start from the static .env values but can be updated at
 * runtime via the PUT /config API without restarting the process.
 *
 * Static, security-sensitive config (ports, wallet addresses, API keys) stays
 * in config.ts and is never mutable at runtime.
 */
import { config } from "./config.js";

export interface QuotingParams {
  /** Half-spread in price units. 0.03 = 3¢ each side of mid. */
  quoteHalfWidth: number;
  /** Multiplier applied to halfWidth for wide/volatile markets. */
  widthMultiplier: number;
  /** Number of markets to actively quote simultaneously. */
  numMarkets: number;
  /** Minimum 24-hour volume a market must have to be selected. */
  minVolume24h: number;
  /** How often the quoting cycle runs, in milliseconds. */
  pollIntervalMs: number;
  /** How often metrics are pushed to the orchestrator, in milliseconds. */
  metricsIntervalMs: number;
  /**
   * Maximum one-sided inventory ratio before skew correction kicks in.
   * 0.6 = reduce bid size once YES inventory exceeds 60% of allocation.
   */
  maxInventorySkew: number;
  /**
   * Fraction of mid price that, when exceeded, triggers a re-quote.
   * 0.005 = re-quote if mid moves >0.5% from last quoted position.
   */
  reQuoteThreshold: number;
  /**
   * Fraction of mid price: if our posted price deviates more than this
   * from the current fair value, cancel and re-quote.
   * 0.01 = 1% staleness threshold.
   */
  orderStalenessThreshold: number;
  /** Simulated equity used when running in paper-trading mode ($). */
  paperEquity: number;
}

// Frozen defaults — these are the "reset" target
const DEFAULTS: QuotingParams = {
  quoteHalfWidth: config.quoting.quoteHalfWidth,
  widthMultiplier: config.quoting.widthMultiplier,
  numMarkets: config.quoting.numMarkets,
  minVolume24h: config.quoting.minVolume24h,
  pollIntervalMs: config.quoting.pollIntervalMs,
  metricsIntervalMs: config.quoting.metricsIntervalMs,
  maxInventorySkew: config.quoting.maxInventorySkew,
  reQuoteThreshold: config.quoting.reQuoteThreshold,
  orderStalenessThreshold: config.quoting.orderStalenessThreshold,
  paperEquity: config.quoting.paperEquity,
};

/** Live mutable copy — quoter.ts and markets.ts read from this. */
export const params: QuotingParams = { ...DEFAULTS };

export function getDefaults(): QuotingParams {
  return { ...DEFAULTS };
}

export function getParams(): QuotingParams {
  return { ...params };
}

export function updateParams(patch: Partial<QuotingParams>): QuotingParams {
  const allowed = Object.keys(DEFAULTS) as (keyof QuotingParams)[];
  for (const key of allowed) {
    if (patch[key] !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (params as unknown as Record<string, number>)[key] = patch[key] as number;
    }
  }
  console.log("[config] Updated params:", JSON.stringify(getParams(), null, 2));
  return { ...params };
}

export function resetParams(): QuotingParams {
  Object.assign(params, DEFAULTS);
  console.log("[config] Reset params to defaults");
  return { ...params };
}
