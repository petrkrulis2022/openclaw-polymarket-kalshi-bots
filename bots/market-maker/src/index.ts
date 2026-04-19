import "dotenv/config";
import express from "express";
import { config } from "./config.js";
import {
  params,
  getParams,
  getDefaults,
  updateParams,
  resetParams,
  type QuotingParams,
} from "./runtime-config.js";
import { getStates, runQuotingCycle } from "./quoter.js";
import {
  getAllPositions,
  getTotalRealizedPnl,
  initFromTrades,
} from "./inventory.js";
import { reportMetrics, getLastSnapshot } from "./metrics.js";
import { getActiveMarkets } from "./markets.js";
import {
  getCollateralBalance,
  fetchTradeHistory,
  getOpenOrders,
} from "./clob.js";

// ─── State ────────────────────────────────────────────────────────────────────
let allocatedEquity = 0; // updated from treasury at startup; bots don't move funds
let running = true;

// ─── Treasury: read bot wallet info ──────────────────────────────────────────
async function fetchTreasuryEquity(): Promise<number> {
  try {
    const res = await fetch(`${config.treasuryUrl}/wallets`);
    if (!res.ok) throw new Error(`Treasury ${res.status}`);
    const data = (await res.json()) as {
      bots: Array<{ id: number; usdTBalance: string }>;
    };
    const bot = data.bots.find((b) => b.id === config.botId);
    const balance = parseFloat(bot?.usdTBalance ?? "0");
    if (balance > 0) {
      console.log(
        `[init] Bot ${config.botId} wallet balance: $${balance.toFixed(4)} USDT`,
      );
      return balance;
    }
    // Treasury bot wallet is empty — fall through to CLOB balance
    return 0;
  } catch (err) {
    console.warn("[init] Treasury unreachable:", (err as Error).message);
    return 0;
  }
}

async function fetchAllocatedEquity(): Promise<number> {
  const treasuryBalance = await fetchTreasuryEquity();
  if (treasuryBalance > 0) return treasuryBalance;
  // Fall back to CLOB collateral balance (EOA mode)
  const clobBalance = await getCollateralBalance();
  if (clobBalance > 0) {
    console.log(`[init] EOA CLOB balance: $${clobBalance.toFixed(4)} USDC.e`);
  }
  return clobBalance;
}

// ─── Main quoting loop ────────────────────────────────────────────────────────
async function mainLoop(): Promise<void> {
  console.log(
    `[main] Market Maker starting — paper=${config.paperTrading}, markets=${params.numMarkets}, pollInterval=${params.pollIntervalMs}ms`,
  );

  allocatedEquity = await fetchAllocatedEquity();
  // In paper mode, fall back to a simulated paper equity if treasury has nothing
  if (config.paperTrading && allocatedEquity === 0) {
    allocatedEquity = params.paperEquity;
    console.log(
      `[init] Paper mode — using simulated equity: $${allocatedEquity}`,
    );
  }

  // Pre-load markets
  await getActiveMarkets();

  // Seed inventory from trade history so positions survive bot restarts
  const tradeHistory = await fetchTradeHistory();
  initFromTrades(tradeHistory);

  // Self-rescheduling quoting loop — picks up pollIntervalMs changes immediately
  async function scheduleQuoting(): Promise<void> {
    if (!running) return;
    try {
      await runQuotingCycle(allocatedEquity);
    } catch (err) {
      console.error("[quoter] Cycle error:", (err as Error).message);
    }
    if (running) setTimeout(scheduleQuoting, params.pollIntervalMs);
  }

  // Self-rescheduling metrics loop — picks up metricsIntervalMs changes immediately
  async function scheduleMetrics(): Promise<void> {
    if (!running) return;
    try {
      await reportMetrics(allocatedEquity);
    } catch (err) {
      console.error("[metrics] Report error:", (err as Error).message);
    }
    if (running) setTimeout(scheduleMetrics, params.metricsIntervalMs);
  }

  // Re-fetch balance periodically (treasury may have allocated/recalled)
  const balanceTimer = setInterval(async () => {
    const fetched = await fetchAllocatedEquity();
    // In paper mode, don't overwrite the simulated equity with the real $0 balance
    if (config.paperTrading && fetched === 0) return;
    allocatedEquity = fetched;
  }, 60_000);

  // Kick off loops
  setTimeout(scheduleQuoting, params.pollIntervalMs);
  setTimeout(scheduleMetrics, params.metricsIntervalMs);

  process.on("SIGTERM", () => {
    running = false;
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

app.get("/positions", async (_req, res) => {
  const states = getStates();
  const inventory = getAllPositions();

  // Map yesTokenId / noTokenId -> current mid for unrealized PnL calculation
  const midByToken = new Map<string, number>();
  for (const st of states) {
    if (st.yesTokenId) midByToken.set(st.yesTokenId, st.mid);
    if (st.noTokenId) midByToken.set(st.noTokenId, 1 - st.mid);
  }

  // Locked collateral = USDC.e reserved by open BUY limit orders
  let lockedCollateral = 0;
  try {
    const openOrders = await getOpenOrders();
    for (const o of openOrders) {
      if (o.side === "BUY") lockedCollateral += o.price * o.size;
    }
  } catch {
    /* non-fatal */
  }

  const inventoryWithPnl = inventory.map((p) => {
    const currentMid = midByToken.get(p.tokenId) ?? null;
    const unrealizedPnl =
      currentMid != null ? (currentMid - p.avgPrice) * p.netSize : null;
    return {
      tokenId: p.tokenId,
      netSize: p.netSize,
      avgPrice: p.avgPrice,
      currentMid,
      realizedPnl: p.realizedPnl,
      unrealizedPnl,
    };
  });

  const strategyPnl = getTotalRealizedPnl();
  const positionPnl = inventoryWithPnl.reduce(
    (s, p) => s + (p.unrealizedPnl ?? 0),
    0,
  );

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
    inventory: inventoryWithPnl,
    totalRealizedPnl: strategyPnl,
    strategyPnl,
    positionPnl,
    lockedCollateral: parseFloat(lockedCollateral.toFixed(6)),
    allocatedEquity,
  });
});

// ── Runtime config endpoints ──────────────────────────────────────────────────

app.get("/config", (_req, res) => {
  res.json({
    paperTrading: config.paperTrading,
    params: getParams(),
    defaults: getDefaults(),
  });
});

app.put("/config", (req, res) => {
  const patch = req.body as Partial<QuotingParams>;
  if (!patch || typeof patch !== "object") {
    res.status(400).json({ error: "Expected JSON body with param fields" });
    return;
  }
  const updated = updateParams(patch);
  res.json({ ok: true, params: updated });
});

app.post("/config/reset", (_req, res) => {
  const reset = resetParams();
  res.json({ ok: true, params: reset, defaults: getDefaults() });
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
