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
  port: parseInt(process.env["PORT"] ?? "3005", 10),
  botId: parseInt(process.env["BOT_ID"] ?? "4", 10),
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
  scanIntervalMs: parseInt(process.env["SCAN_INTERVAL_MS"] ?? "60000", 10),
  maxConcurrentMarkets: parseInt(
    process.env["MAX_CONCURRENT_MARKETS"] ?? "10",
    10,
  ),
  // Net spread after fees must exceed this to be worth entering
  feeThreshold: parseFloat(process.env["FEE_THRESHOLD"] ?? "0.002"),
  // Abandon unpaired leg after this many ms
  pairTimeoutMs: parseInt(process.env["PAIR_TIMEOUT_MS"] ?? "10000", 10),
  maxPositionUsd: parseFloat(process.env["MAX_POSITION_USD"] ?? "50"),
} as const;
