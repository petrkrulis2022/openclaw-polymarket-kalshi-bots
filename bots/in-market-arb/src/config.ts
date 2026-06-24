import "dotenv/config";
import { SignatureTypeV2 } from "@polymarket/clob-client-v2";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function signatureTypeFromEnv(): SignatureTypeV2 {
  switch (process.env["POLYMARKET_SIGNATURE_TYPE"]) {
    case "POLY_PROXY":
      return SignatureTypeV2.POLY_PROXY;
    case "POLY_1271":
      return SignatureTypeV2.POLY_1271;
    case "POLY_GNOSIS_SAFE":
    default:
      return SignatureTypeV2.POLY_GNOSIS_SAFE;
  }
}

const VENUE = process.env["VENUE"] === "kalshi" ? "kalshi" : "polymarket";

export const config = {
  venue: VENUE as "polymarket" | "kalshi",
  port: parseInt(process.env["PORT"] ?? "3005", 10),
  botId: parseInt(process.env["BOT_ID"] ?? "4", 10),
  // Kalshi backend (only required when VENUE=kalshi; kept optional so the
  // Polymarket path never needs KALSHI_* env). Validated lazily by the adapter.
  kalshi: {
    apiKeyId: process.env["KALSHI_API_KEY_ID"] ?? "",
    privateKeyPem: (process.env["KALSHI_PRIVATE_KEY_PEM"] ?? "").replace(/\\n/g, "\n"),
    host: process.env["KALSHI_HOST"] ?? "https://external-api.kalshi.com/trade-api/v2",
    // Kalshi taker fee rate: fee = feeRate × price × (1 − price) per contract
    // (same shape as Polymarket). 0.07 is Kalshi's standard rate; conservative
    // so the arb threshold never trades a false positive.
    feeRate: parseFloat(process.env["KALSHI_FEE_RATE"] ?? "0.07"),
  } as const,
  polymarket: {
    walletAddress: req("POLYMARKET_WALLET_ADDRESS"),
    signerKey: process.env["BOT_SIGNER_KEY"] ?? "",
    funderAddress: process.env["POLYMARKET_FUNDER_ADDRESS"] ?? "",
    signatureType: signatureTypeFromEnv(),
    host: "https://clob.polymarket.com",
  } as const,
  orchestratorUrl: process.env["ORCHESTRATOR_URL"] ?? "http://localhost:3002",
  treasuryUrl: process.env["TREASURY_URL"] ?? "http://localhost:3001",
  // Reduced from 60s — faster reaction without websocket
  scanIntervalMs: parseInt(process.env["SCAN_INTERVAL_MS"] ?? "15000", 10),
  maxConcurrentMarkets: parseInt(
    process.env["MAX_CONCURRENT_MARKETS"] ?? "10",
    10,
  ),
  // Minimum net profit ratio AFTER real per-market taker fees.
  // 0.005 = must profit at least 0.5¢ per $1 of guaranteed return after fees.
  feeThreshold: parseFloat(process.env["FEE_THRESHOLD"] ?? "0.005"),
  pairTimeoutMs: parseInt(process.env["PAIR_TIMEOUT_MS"] ?? "10000", 10),
  maxPositionUsd: parseFloat(process.env["MAX_POSITION_USD"] ?? "50"),
  // Conservative fallback fee rate (decimal) when Gamma API does not provide one.
  // Polymarket taker fee formula: fee = feeRate × price × (1 − price) per share.
  defaultFeeRate: parseFloat(process.env["DEFAULT_FEE_RATE"] ?? "0.02"),
} as const;
