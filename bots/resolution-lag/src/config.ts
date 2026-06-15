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
  port: parseInt(process.env["PORT"] ?? "3006", 10),
  botId: parseInt(process.env["BOT_ID"] ?? "5", 10),
  polymarket: {
    walletAddress: req("POLYMARKET_WALLET_ADDRESS"),
    signerKey: process.env["BOT_SIGNER_KEY"] ?? "",
    // Polymarket proxy wallet (Gnosis Safe) that holds pUSD collateral
    funderAddress: process.env["POLYMARKET_FUNDER_ADDRESS"] ?? "",
    signatureType: signatureTypeFromEnv(),
    host: "https://clob.polymarket.com",
  } as const,
  orchestratorUrl: process.env["ORCHESTRATOR_URL"] ?? "http://localhost:3002",
  treasuryUrl: process.env["TREASURY_URL"] ?? "http://localhost:3001",
  // How often to poll Gamma for newly closed but unresolved markets
  monitorIntervalMs: parseInt(
    process.env["MONITOR_INTERVAL_MS"] ?? "60000",
    10,
  ),
  // Minimum annualised yield (%) to enter a resolution-lag trade
  minYieldPct: parseFloat(process.env["MIN_YIELD_PCT"] ?? "0.5"),
  // Price floor for the winner token. The ask = the market's live probability
  // the resolution holds, so a cheap winner means the market disbelieves it
  // (dispute / premature-or-wrong resolution → can settle to $0). 0.50 captures
  // genuine redemption-lag discounts while staying out of the deep-discount
  // dispute zone; requireClobWinnerConfirmation is the independent safety gate.
  // Lower (e.g. 0.10) = main-style lottery tickets — size tiny, losses frequent.
  minAskPrice: parseFloat(process.env["MIN_ASK_PRICE"] ?? "0.10"),
  maxAskPrice: parseFloat(process.env["MAX_ASK_PRICE"] ?? "0.99"),
  // Safety buffer after market end time before considering it actionable.
  minPostEndMinutes: parseInt(process.env["MIN_POST_END_MINUTES"] ?? "45", 10),
  // Only consider markets that ended within this lookback window. Resolution-lag
  // opportunities are fresh closures; an unbounded closed=true query is dominated
  // by far-future-dated and ancient markets and surfaces zero recent ones.
  lookbackHours: parseInt(process.env["LOOKBACK_HOURS"] ?? "48", 10),
  // Cap how many (freshest-first) candidates we CLOB-check per scan, and how many
  // CLOB requests run concurrently. Checking every candidate at once bursts
  // hundreds of requests at clob.polymarket.com and gets rate-limited ("fetch
  // failed"). The freshest closures are also the ones most likely still lagging.
  maxCandidates: parseInt(process.env["MAX_CANDIDATES"] ?? "50", 10),
  clobCheckConcurrency: parseInt(process.env["CLOB_CHECK_CONCURRENCY"] ?? "4", 10),
  // Require the same candidate to pass checks in N consecutive scans.
  // 1 is sufficient since CLOB winner confirmation is an independent safety gate.
  requiredResolutionConfirmations: parseInt(
    process.env["REQUIRED_RESOLUTION_CONFIRMATIONS"] ?? "1",
    10,
  ),
  // Require CLOB market endpoint to confirm the exact winning token.
  requireClobWinnerConfirmation:
    (process.env["REQUIRE_CLOB_WINNER_CONFIRMATION"] ?? "true") === "true",
  maxPositionUsd: parseFloat(process.env["MAX_POSITION_USD"] ?? "100"),
  maxOpenPositions: parseInt(process.env["MAX_OPEN_POSITIONS"] ?? "20", 10),
} as const;
