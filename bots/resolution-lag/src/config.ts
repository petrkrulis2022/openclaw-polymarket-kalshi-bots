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
    process.env["MONITOR_INTERVAL_MS"] ?? "300000",
    10,
  ),
  // Minimum annualised yield (%) to enter a resolution-lag trade
  minYieldPct: parseFloat(process.env["MIN_YIELD_PCT"] ?? "0.5"),
  maxPositionUsd: parseFloat(process.env["MAX_POSITION_USD"] ?? "100"),
  maxOpenPositions: parseInt(process.env["MAX_OPEN_POSITIONS"] ?? "20", 10),
} as const;
