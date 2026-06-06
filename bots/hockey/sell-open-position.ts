/**
 * Manual sell: reads the open position from the running hockey-bot HTTP API
 * and places a FOK market sell on CLOB.
 *
 * Usage (from bots/hockey/):
 *   npx tsx sell-open-position.ts [botPort]
 *
 * Default port: 4105 (hockey-bot-u9). Pass a different port for other users.
 */
import { ClobClient, Chain, Side } from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

const BOT_PORT = process.argv[2] ? Number(process.argv[2]) : 4105;
const BOT_URL = `http://localhost:${BOT_PORT}`;

// ── 1. Read open position from running bot ────────────────────────────────────
console.log(`Fetching open position from ${BOT_URL}/trades ...`);
const tradesRes = await fetch(`${BOT_URL}/trades`);
if (!tradesRes.ok) throw new Error(`Bot HTTP ${tradesRes.status}`);
const tradesData = (await tradesRes.json()) as {
  openPosition?: {
    tokenId: string;
    label: string;
    size: number;
    entryAsk: number;
  };
};

const pos = tradesData.openPosition;
if (!pos) {
  console.log("✅  No open position — nothing to sell.");
  process.exit(0);
}
console.log(`Open position: ${pos.label} | ${pos.size} shares @ entry ${pos.entryAsk}`);
console.log(`Token ID: ${pos.tokenId}`);

// ── 2. Read signing credentials from bot diagnostics ���────────────────────────
const diagRes = await fetch(`${BOT_URL}/diagnostics`);
const diag = (await diagRes.json()) as { matchSlug?: string };
console.log(`Market: ${diag.matchSlug ?? "unknown"}`);

// ── 3. Read credentials from bot env (via /health which echoes botId, or hard-coded path) ���
// Fall back to ecosystem-u9.json if we can't get them from bot
const { readFileSync } = await import("fs");
const ecosystemPath = new URL(
  "../../orchestrator/data/envs/ecosystem-u9.json",
  import.meta.url,
).pathname;
const ecosystem = JSON.parse(readFileSync(ecosystemPath, "utf-8")) as {
  apps: Array<{ name: string; env: Record<string, string> }>;
};
const hockeyApp = ecosystem.apps.find((a) => a.name.startsWith("hockey-bot"));
if (!hockeyApp) throw new Error("hockey-bot app not found in ecosystem-u9.json");
const SIGNER_KEY = `0x${hockeyApp.env["BOT_SIGNER_KEY"]}` as `0x${string}`;
const FUNDER_ADDRESS = hockeyApp.env[
  "POLYMARKET_FUNDER_ADDRESS"
] as `0x${string}`;

// ── 4. Build CLOB client ──────────────────────────────────────────────────────
const account = privateKeyToAccount(SIGNER_KEY);
const walletClient = createWalletClient({
  account,
  chain: polygon,
  transport: http(),
});

console.log(`\nEOA:    ${account.address}`);
console.log(`Funder: ${FUNDER_ADDRESS}`);
console.log("Deriving API key...");

const tempClient = new ClobClient({
  host: "https://clob.polymarket.com",
  chain: Chain.POLYGON,
  signer: walletClient as any,
  signatureType: 3,
  funderAddress: FUNDER_ADDRESS,
});
const creds = await tempClient.createOrDeriveApiKey();
const credsObj = creds as Record<string, unknown>;
console.log(`API key: ${String(credsObj["key"]).slice(0, 8)}...`);

const client = new ClobClient({
  host: "https://clob.polymarket.com",
  chain: Chain.POLYGON,
  signer: walletClient as any,
  creds: creds as any,
  signatureType: 3,
  funderAddress: FUNDER_ADDRESS,
});

// ── 5. Check current best bid ─────────────────────────────────────────────────
const book = await client.getOrderBook(pos.tokenId);
const rawBids: Array<{ price: string; size: string }> =
  (book as any)?.bids ?? [];
const bids = rawBids
  .map((b) => parseFloat(b.price))
  .sort((a, b) => b - a); // descending
const bestBid = bids[0] ?? 0;
const worstPrice = Math.max(0.01, bestBid - 0.011);

console.log(`\nBest bid: ${bestBid}`);
console.log(`Worth ~$${(bestBid * pos.size).toFixed(2)} for ${pos.size} shares`);
console.log(`\nPlacing FOK SELL ${pos.size} ${pos.label} at worst=${worstPrice.toFixed(3)} ...`);

// ── 6. Place market sell ───────────────────────────────────────────────────────
const result = await (client as any).createAndPostMarketOrder(
  {
    tokenID: pos.tokenId,
    side: Side.SELL,
    amount: pos.size,
    price: worstPrice,
  },
  undefined,
  "FOK",
);

console.log("\nResult:", JSON.stringify(result, null, 2));
const r = result as Record<string, unknown>;
const err = String(r["errorMsg"] ?? r["error"] ?? "").trim();
if (err && err !== "null" && err !== "undefined") {
  console.log(`\n❌ SELL failed: ${err}`);
} else {
  console.log(
    `\n✅ SELL submitted! orderId=${r["orderID"]} status=${r["status"]}`,
  );
  const takingAmt =
    (parseFloat(String(r["takingAmount"] ?? "0")) || 0) / 1e6;
  if (takingAmt > 0) console.log(`   Received: $${takingAmt.toFixed(4)} USDC`);
}
