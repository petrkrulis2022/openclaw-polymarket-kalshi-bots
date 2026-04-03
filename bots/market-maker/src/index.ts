import "dotenv/config";
import express from "express";
import { config } from "./config.js";
import { getStates, runQuotingCycle } from "./quoter.js";
import { getAllPositions, getTotalRealizedPnl } from "./inventory.js";
import { reportMetrics, getLastSnapshot } from "./metrics.js";
import { getActiveMarkets } from "./markets.js";

// ─── State ────────────────────────────────────────────────────────────────────
let allocatedEquity = 0; // updated from treasury at startup; bots don't move funds
let running = true;

// ─── Treasury: read bot wallet info ──────────────────────────────────────────
async function fetchAllocatedEquity(): Promise<number> {
  try {
    const res = await fetch(`${config.treasuryUrl}/wallets`);
    if (!res.ok) throw new Error(`Treasury ${res.status}`);
    const data = (await res.json()) as {
      bots: Array<{ id: number; usdTBalance: string }>;
    };
    const bot = data.bots.find((b) => b.id === config.botId);
    const balance = parseFloat(bot?.usdTBalance ?? "0");
    console.log(
      `[init] Bot ${config.botId} wallet balance: $${balance.toFixed(4)} USDT`,
    );
    return balance;
  } catch (err) {
    console.warn(
      "[init] Treasury unreachable, using 0 equity:",
      (err as Error).message,
    );
    return 0;
  }
}

// ─── Main quoting loop ────────────────────────────────────────────────────────
async function mainLoop(): Promise<void> {
  console.log(
    `[main] Market Maker starting — paper=${config.paperTrading}, markets=${config.quoting.numMarkets}, pollInterval=${config.quoting.pollIntervalMs}ms`,
  );

  allocatedEquity = await fetchAllocatedEquity();
  // In paper mode, fall back to a simulated paper equity if treasury has nothing
  if (config.paperTrading && allocatedEquity === 0) {
    allocatedEquity = config.quoting.paperEquity;
    console.log(
      `[init] Paper mode — using simulated equity: $${allocatedEquity}`,
    );
  }

  // Pre-load markets
  await getActiveMarkets();

  // Quoting loop
  const quotingTimer = setInterval(async () => {
    if (!running) return;
    try {
      await runQuotingCycle(allocatedEquity);
    } catch (err) {
      console.error("[quoter] Cycle error:", (err as Error).message);
    }
  }, config.quoting.pollIntervalMs);

  // Metrics reporting loop
  const metricsTimer = setInterval(async () => {
    if (!running) return;
    try {
      await reportMetrics(allocatedEquity);
    } catch (err) {
      console.error("[metrics] Report error:", (err as Error).message);
    }
  }, config.quoting.metricsIntervalMs);

  // Re-fetch balance periodically (treasury may have allocated/recalled)
  const balanceTimer = setInterval(async () => {
    const fetched = await fetchAllocatedEquity();
    // In paper mode, don't overwrite the simulated equity with the real $0 balance
    if (config.paperTrading && fetched === 0) return;
    allocatedEquity = fetched;
  }, 60_000);

  process.on("SIGTERM", () => {
    running = false;
    clearInterval(quotingTimer);
    clearInterval(metricsTimer);
    clearInterval(balanceTimer);
    console.log("[main] Shutting down");
    process.exit(0);
  });
}

// ─── Express API ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    botId: config.botId,
    paperTrading: config.paperTrading,
    allocatedEquity,
    walletAddress: config.polymarket.walletAddress,
  });
});

app.get("/metrics", (_req, res) => {
  res.json(getLastSnapshot());
});

app.get("/positions", (_req, res) => {
  const states = getStates();
  const inventory = getAllPositions();
  res.json({
    markets: states.map((s) => ({
      conditionId: s.market.conditionId,
      question: s.market.question,
      endDateIso: s.market.endDateIso,
      volume24hr: s.market.volume24hr,
      mid: s.mid,
      spread: s.spread,
      ourBidPrice: s.ourBidPrice,
      ourAskPrice: s.ourAskPrice,
      ourBidId: s.ourBidId,
      ourAskId: s.ourAskId,
      openPositions: s.openPositions,
    })),
    inventory: inventory.map((p) => ({
      tokenId: p.tokenId,
      netSize: p.netSize,
      avgPrice: p.avgPrice,
      realizedPnl: p.realizedPnl,
    })),
    totalRealizedPnl: getTotalRealizedPnl(),
    allocatedEquity,
  });
});

app.get("/config", (_req, res) => {
  res.json({
    paperTrading: config.paperTrading,
    numMarkets: config.quoting.numMarkets,
    widthMultiplier: config.quoting.widthMultiplier,
    pollIntervalMs: config.quoting.pollIntervalMs,
    metricsIntervalMs: config.quoting.metricsIntervalMs,
  });
});

app.listen(config.port, () => {
  console.log(
    `[server] Market Maker bot listening on http://localhost:${config.port}`,
  );
  console.log(
    `[server] Mode: ${config.paperTrading ? "PAPER TRADING" : "LIVE TRADING"}`,
  );
  console.log(`[server] Polymarket wallet: ${config.polymarket.walletAddress}`);
  mainLoop().catch((err) => {
    console.error("[main] Fatal error:", err);
    process.exit(1);
  });
});
