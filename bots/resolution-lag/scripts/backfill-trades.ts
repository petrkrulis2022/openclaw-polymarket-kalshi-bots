/**
 * backfill-trades.ts
 *
 * One-time script: fetches all resolved positions from the resolution-lag bot's
 * wallet via the Polymarket data API and inserts them into the trades table.
 *
 * Run once on the server:
 *   cd bots/resolution-lag && npx tsx scripts/backfill-trades.ts
 */

import "dotenv/config";

const ORCHESTRATOR_URL =
  process.env["ORCHESTRATOR_URL"] ?? "http://localhost:3002";
const BOT_WALLET = process.env["POLYMARKET_WALLET_ADDRESS"] ?? "";
const BOT_ID = 5;

interface PolyPosition {
  conditionId: string;
  asset: string;
  title: string;
  outcome: string;
  outcomeIndex: number;
  size: number;
  avgPrice: number;
  currentValue: number;
  curPrice: number;
  redeemable: boolean;
  endDate: string;
  cashPnl: number;
}

async function main() {
  if (!BOT_WALLET) {
    console.error("POLYMARKET_WALLET_ADDRESS not set");
    process.exit(1);
  }

  console.log(`Fetching positions for ${BOT_WALLET}…`);
  const res = await fetch(
    `https://data-api.polymarket.com/positions?user=${BOT_WALLET}&sizeThreshold=0`,
  );
  if (!res.ok) throw new Error(`Polymarket API error: ${res.status}`);
  const data = (await res.json()) as PolyPosition[];

  // Only backfill positions that are resolved (curPrice is 0 or 1, not active)
  const resolved = data.filter(
    (p) => p.redeemable || (p.curPrice === 0 && p.endDate),
  );

  console.log(`Found ${resolved.length} resolved positions to backfill.`);

  for (const pos of resolved) {
    // curPrice is 1 if the position resolved in your favour, 0 if it lost.
    // redeemable=true only means the market has a final result, not that you won.
    const settledPrice = pos.curPrice;
    const realizedPnl = pos.cashPnl ?? (settledPrice - pos.avgPrice) * pos.size;
    const status = settledPrice === 1 ? "won" : "lost";

    const body = {
      botId: BOT_ID,
      marketQuestion: pos.title,
      conditionId: pos.conditionId,
      tokenId: pos.asset,
      outcome: pos.outcome,
      shares: pos.size,
      avgPrice: pos.avgPrice,
      settledPrice,
      realizedPnl,
      closedAt: pos.endDate || new Date().toISOString(),
      status,
    };

    const r = await fetch(`${ORCHESTRATOR_URL}/trades`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (r.ok) {
      const j = (await r.json()) as { id: number };
      console.log(
        `  ✓ [${status}] ${pos.title.slice(0, 60)} → id=${j.id}, pnl=$${realizedPnl.toFixed(2)}`,
      );
    } else {
      const err = await r.text();
      console.warn(`  ✗ ${pos.title.slice(0, 60)}: ${err}`);
    }
  }

  console.log("Backfill complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
