import "dotenv/config";
import { SignatureTypeV2 } from "@polymarket/clob-client-v2";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function signatureTypeFromEnv(): SignatureTypeV2 {
  switch (process.env["POLYMARKET_SIGNATURE_TYPE"]) {
    case "POLY_EOA":
    case "EOA":
    case "0":
      return SignatureTypeV2.EOA;
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
  port: parseInt(process.env["PORT"] ?? "3003", 10),
  botId: parseInt(process.env["BOT_ID"] ?? "1", 10),
  // Kalshi backend (only required when VENUE=kalshi). Validated lazily by the adapter.
  kalshi: {
    apiKeyId: process.env["KALSHI_API_KEY_ID"] ?? "",
    privateKeyPem: (process.env["KALSHI_PRIVATE_KEY_PEM"] ?? "").replace(/\\n/g, "\n"),
    host: process.env["KALSHI_HOST"] ?? "https://external-api.kalshi.com/trade-api/v2",
    feeRate: parseFloat(process.env["KALSHI_FEE_RATE"] ?? "0.07"),
  } as const,
  // Live mode: BOT_SIGNER_KEY must be set and PAPER_TRADING must not be "true".
  // The bot EOA signs on behalf of funderAddress (Polymarket proxy wallet) using
  // GNOSIS_SAFE signature type. API creds are auto-derived from the private key.
  paperTrading:
    !process.env["BOT_SIGNER_KEY"] || process.env["PAPER_TRADING"] === "true",

  polymarket: {
    // Proxy wallet address registered on Polymarket (the maker on all orders)
    walletAddress: req("POLYMARKET_WALLET_ADDRESS"),
    // Bot EOA private key (hex, no 0x prefix) — signs orders for funderAddress
    signerKey: process.env["BOT_SIGNER_KEY"] ?? "",
    // Polymarket proxy wallet (Gnosis Safe) that holds pUSD collateral
    funderAddress: process.env["POLYMARKET_FUNDER_ADDRESS"] ?? "",
    signatureType: signatureTypeFromEnv(),
    host: "https://clob.polymarket.com",
    gammaHost: "https://gamma-api.polymarket.com",
  } as const,

  orchestratorUrl: process.env["ORCHESTRATOR_URL"] ?? "http://localhost:3002",
  treasuryUrl: process.env["TREASURY_URL"] ?? "http://localhost:3001",

  // On-chain CTF mergePositions is signed by the bot EOA, so it only succeeds
  // when the EOA itself holds the conditional tokens — i.e. POLY_EOA mode.
  // In proxy/Safe/1271 mode the tokens live in the proxy wallet and a direct
  // EOA merge reverts, so we skip it and recycle inventory through the book
  // (and capture the locked spread at oracle resolution instead).
  // Kalshi nets YES+NO automatically and has no on-chain CTF merge.
  canMergeOnchain:
    VENUE !== "kalshi" && signatureTypeFromEnv() === SignatureTypeV2.EOA,

  quoting: {
    // halfWidth: how far each side is from mid, e.g. 0.03 = 3 cent spread on each side
    quoteHalfWidth: parseFloat(process.env["QUOTE_HALF_WIDTH"] ?? "0.03"),
    widthMultiplier: parseFloat(process.env["QUOTE_WIDTH_MULTIPLIER"] ?? "1.2"),
    numMarkets: parseInt(process.env["NUM_MARKETS"] ?? "5", 10),
    minVolume24h: parseFloat(process.env["MIN_VOLUME_24H"] ?? "1000"),
    paperEquity: parseFloat(process.env["PAPER_EQUITY"] ?? "100"),
    pollIntervalMs: parseInt(process.env["POLL_INTERVAL_MS"] ?? "5000", 10),
    metricsIntervalMs: parseInt(
      process.env["METRICS_INTERVAL_MS"] ?? "30000",
      10,
    ),
    maxInventorySkew: 0.6, // cancel/re-quote if one side > 60%
    // Quote inside Polymarket liquidity-rewards bands (the actual edge for
    // small MMs). Set REWARDS_MODE=false to fall back to naked spread capture.
    // Polymarket liquidity-rewards bands don't exist on Kalshi → naked spread only.
    rewardsMode:
      VENUE !== "kalshi" && (process.env["REWARDS_MODE"] ?? "true") === "true",
    reQuoteThreshold: 0.005, // 0.5% mid move triggers re-quote
    orderStalenessThreshold: 0.01, // 1% off market triggers re-quote
  },
} as const;
