import "dotenv/config";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  port: parseInt(process.env["PORT"] ?? "3007", 10),
  botId: parseInt(process.env["BOT_ID"] ?? "6", 10),
  polymarket: {
    walletAddress: req("POLYMARKET_WALLET_ADDRESS"),
    signerKey: process.env["BOT_SIGNER_KEY"] ?? "",
    // Polymarket proxy wallet (Gnosis Safe) that holds pUSD collateral
    funderAddress: process.env["POLYMARKET_FUNDER_ADDRESS"] ?? "",
    host: "https://clob.polymarket.com",
  } as const,
  orchestratorUrl: process.env["ORCHESTRATOR_URL"] ?? "http://localhost:3002",
  treasuryUrl: process.env["TREASURY_URL"] ?? "http://localhost:3001",
  // How often to refresh the screened market list (30 min)
  screenIntervalMs: parseInt(
    process.env["SCREEN_INTERVAL_MS"] ?? "1800000",
    10,
  ),
  // How often to refresh quotes on active markets (30s)
  quoteIntervalMs: parseInt(process.env["QUOTE_INTERVAL_MS"] ?? "30000", 10),
  // Only enter if best ask is below this price
  maxAskPrice: parseFloat(process.env["MAX_ASK_PRICE"] ?? "0.003"),
  // Only enter if expiry is at least this many days away
  minDaysToExpiry: parseInt(process.env["MIN_DAYS_TO_EXPIRY"] ?? "90", 10),
  // Maximum screened markets to trade at once
  maxMarkets: parseInt(process.env["MAX_MARKETS"] ?? "200", 10),
  // Max $ deployed per market
  maxUsdPerMarket: parseFloat(process.env["MAX_USD_PER_MARKET"] ?? "2"),
  // Cancel all quotes when days-to-expiry drops below this
  cancelDaysBeforeExpiry: parseInt(
    process.env["CANCEL_DAYS_BEFORE_EXPIRY"] ?? "30",
    10,
  ),
} as const;
