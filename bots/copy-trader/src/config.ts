import "dotenv/config";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  port: parseInt(process.env["PORT"] ?? "3004", 10),
  botId: parseInt(process.env["BOT_ID"] ?? "3", 10),
  polymarket: {
    walletAddress: req("POLYMARKET_WALLET_ADDRESS"),
    apiKey: req("POLYMARKET_API_KEY"),
    apiSecret: req("POLYMARKET_API_SECRET"),
    apiPassphrase: req("POLYMARKET_API_PASSPHRASE"),
    signerKey: process.env["BOT_SIGNER_KEY"] ?? "",
    host: "https://clob.polymarket.com",
    dataApiHost: "https://data-api.polymarket.com",
  } as const,
  orchestratorUrl: process.env["ORCHESTRATOR_URL"] ?? "http://localhost:3002",
  treasuryUrl: process.env["TREASURY_URL"] ?? "http://localhost:3001",
} as const;
