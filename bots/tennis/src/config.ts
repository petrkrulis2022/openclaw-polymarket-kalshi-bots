import "dotenv/config";
import { SignatureTypeV2 } from "@polymarket/clob-client-v2";

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
  polymarket: {
    walletAddress: process.env["POLYMARKET_WALLET_ADDRESS"] ?? "",
    signerKey: process.env["BOT_SIGNER_KEY"] ?? "",
    funderAddress: process.env["POLYMARKET_FUNDER_ADDRESS"] ?? "",
    signatureType: signatureTypeFromEnv(),
    host: "https://clob.polymarket.com",
    gammaApi: "https://gamma-api.polymarket.com",
  },
  orchestrator: {
    baseUrl: process.env["ORCHESTRATOR_URL"] ?? "http://localhost:3002",
    userAddress: process.env["USER_METAMASK_ADDRESS"] ?? "",
    watchedGamesPollMs:
      parseInt(process.env["WATCHED_GAMES_POLL_SECONDS"] ?? "2", 10) * 1_000,
  },
  matchSlug: (process.env["MATCH_SLUG"] ?? "").trim(),
  matchTeamHome: (process.env["MATCH_TEAM_HOME"] ?? "").trim(),
  matchTeamAway: (process.env["MATCH_TEAM_AWAY"] ?? "").trim(),
  maxPositionUsd: parseFloat(process.env["MAX_POSITION_USD"] ?? "10"),
  minProfitCents: parseFloat(process.env["MIN_PROFIT_CENTS"] ?? "0.04"),
  stopLossRatio: parseFloat(process.env["STOP_LOSS_RATIO"] ?? "0.9"),
  holdBeforeSellSeconds: parseInt(
    process.env["HOLD_BEFORE_SELL_SECONDS"] ?? "30",
    10,
  ),
  maxLossCents: parseFloat(process.env["MAX_LOSS_CENTS"] ?? "0.03"),
  sellTimeoutMinutes: parseInt(process.env["SELL_TIMEOUT_MINUTES"] ?? "15", 10),
  preGamePollMs:
    parseInt(process.env["PRE_GAME_POLL_SECONDS"] ?? "1", 10) * 1_000,
  livePollMs: parseInt(process.env["LIVE_POLL_SECONDS"] ?? "1", 10) * 1_000,
  sellPollMs: parseInt(process.env["SELL_POLL_SECONDS"] ?? "1", 10) * 1_000,
  port: parseInt(process.env["PORT"] ?? "3020", 10),
  botId: 11,
} as const;
