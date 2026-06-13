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

export const config = {
  port: parseInt(process.env["PORT"] ?? "3008", 10),
  botId: parseInt(process.env["BOT_ID"] ?? "2", 10),
  kalshi: {
    apiKeyId: req("KALSHI_API_KEY_ID"),
    // .env stores PEM with literal \n; restore real newlines at runtime
    privateKeyPem: req("KALSHI_PRIVATE_KEY_PEM").replace(/\\n/g, "\n"),
    host: process.env["KALSHI_HOST"] ?? "https://external-api.kalshi.com/trade-api/v2",
  } as const,
  polymarket: {
    walletAddress: process.env["POLYMARKET_WALLET_ADDRESS"] ?? "",
    signerKey: process.env["BOT_SIGNER_KEY"] ?? "",
    funderAddress: process.env["POLYMARKET_FUNDER_ADDRESS"] ?? "",
    signatureType: signatureTypeFromEnv(),
    host: "https://clob.polymarket.com",
  } as const,
  orchestratorUrl: process.env["ORCHESTRATOR_URL"] ?? "http://localhost:3002",
  treasuryUrl: process.env["TREASURY_URL"] ?? "http://localhost:3001",
  scanIntervalMs: parseInt(process.env["SCAN_INTERVAL_MS"] ?? "15000", 10),
  // Minimum net edge (%) after all fees before firing a trade
  minNetSpreadPct: parseFloat(process.env["MIN_NET_SPREAD_PCT"] ?? "1.0"),
  // Upper plausibility bound on net edge (%). A real same-event cross-exchange
  // arb is at most a few percent; a larger edge means the Kalshi and Poly
  // markets aren't actually the same event (mapper false-positive). Discard it
  // rather than leg into a mismatched, unhedged pair.
  maxPlausibleEdgePct: parseFloat(process.env["MAX_PLAUSIBLE_EDGE_PCT"] ?? "15"),
  // Total notional per arb pair (split across the two legs, so each leg is
  // half this). Lowered to fit the thin shared deposit wallet (~$10); $10 →
  // ~$5/leg, which still clears Polymarket's 5-share / $1 order minimum at
  // typical prices. Raise via MAX_POSITION_USD once the wallet is funded.
  maxPositionUsd: parseFloat(process.env["MAX_POSITION_USD"] ?? "10"),
  // One pair at a time while the wallet is thin and the live order path is being
  // validated — caps concurrent exposure (and naked-leg blast radius) to ~$5.
  // Raise via MAX_OPEN_PAIRS once a few pairs have round-tripped cleanly.
  maxOpenPairs: parseInt(process.env["MAX_OPEN_PAIRS"] ?? "1", 10),
  pairTimeoutMs: parseInt(process.env["PAIR_TIMEOUT_MS"] ?? "10000", 10),
  maxUnhedgedMs: parseInt(process.env["MAX_UNHEDGED_MS"] ?? "10000", 10),
  unwindMaxRetries: parseInt(process.env["UNWIND_MAX_RETRIES"] ?? "3", 10),
  // true = scan and log signals but never place real orders
  // Fallback Polymarket fee rate when market data doesn't provide one
  defaultPolyFeeRate: parseFloat(process.env["DEFAULT_POLY_FEE_RATE"] ?? "0.02"),
} as const;
