import "dotenv/config";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  port: parseInt(process.env["PORT"] ?? "3003", 10),
  botId: parseInt(process.env["BOT_ID"] ?? "1", 10),
  // Live mode requires BOT_SIGNER_KEY (MetaMask EOA key).
  // BOT_FUNDER_ADDRESS is the proxy wallet that holds funds (0x4D265C9B...).
  // When both are set and PAPER_TRADING != "true", the bot trades live.
  paperTrading:
    !process.env["BOT_SIGNER_KEY"] || process.env["PAPER_TRADING"] === "true",

  polymarket: {
    // The proxy/trading wallet address (holds USDC, the "maker" on orders)
    walletAddress: req("POLYMARKET_WALLET_ADDRESS"),
    apiKey: req("POLYMARKET_API_KEY"),
    apiSecret: req("POLYMARKET_API_SECRET"),
    apiPassphrase: req("POLYMARKET_API_PASSPHRASE"),
    // EOA signer key (MetaMask 0xD7CA...) — signs orders on behalf of proxy
    signerKey: process.env["BOT_SIGNER_KEY"] ?? "",
    // Proxy/funder wallet (0x4D265C9B...) — where funds live
    funderAddress: process.env["POLYMARKET_WALLET_ADDRESS"] ?? "",
    host: "https://clob.polymarket.com",
    gammaHost: "https://gamma-api.polymarket.com",
  },

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
