import "dotenv/config";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  port: parseInt(process.env["PORT"] ?? "3003", 10),
  botId: parseInt(process.env["BOT_ID"] ?? "1", 10),
  // Live mode: BOT_SIGNER_KEY must be set and PAPER_TRADING must not be "true".
  // We use SignatureType.EOA — the MetaMask EOA (0xD7CA82...) is both signer and maker.
  // Funds must live in the EOA's wallet on Polygon (approved and deposited via Polymarket UI).
  paperTrading:
    !process.env["BOT_SIGNER_KEY"] || process.env["PAPER_TRADING"] === "true",

  polymarket: {
    // EOA address — the MetaMask wallet that signs AND holds USDC (maker on all orders)
    walletAddress: req("POLYMARKET_WALLET_ADDRESS"),
    apiKey: req("POLYMARKET_API_KEY"),
    apiSecret: req("POLYMARKET_API_SECRET"),
    apiPassphrase: req("POLYMARKET_API_PASSPHRASE"),
    // MetaMask EOA private key — signs orders directly (SignatureType.EOA)
    signerKey: process.env["BOT_SIGNER_KEY"] ?? "",
    host: "https://clob.polymarket.com",
    gammaHost: "https://gamma-api.polymarket.com",
  } as const,

  orchestratorUrl: process.env["ORCHESTRATOR_URL"] ?? "http://localhost:3002",
  treasuryUrl: process.env["TREASURY_URL"] ?? "http://localhost:3001",

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
    reQuoteThreshold: 0.005, // 0.5% mid move triggers re-quote
    orderStalenessThreshold: 0.01, // 1% off market triggers re-quote
  },
} as const;
