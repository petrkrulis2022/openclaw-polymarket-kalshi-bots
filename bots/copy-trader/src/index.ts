/**
 * index.ts — Copy-Trader Bot (Bot 3)
 *
 * Polls tracked Polymarket profiles for position changes, generates copy signals,
 * routes them through an approval queue (manual / auto / orchestrator), then
 * executes approved trades via the CLOB.
 */

import express, { type Request, type Response } from "express";
import { config } from "./config.js";
import {
  params,
  traders,
  addTrader,
  removeTrader,
  updateTrader,
  updateParams,
  resetParams,
  getParams,
  getDefaults,
  loadTraders,
  type TrackedTrader,
} from "./runtime-config.js";
import { pollTrader, getSnapshot, removeSnapshot } from "./tracker.js";
import {
  addPending,
  approve,
  reject,
  listAll,
  listPending,
  listApproved,
  expireOld,
  pruneTerminal,
} from "./pending.js";
import { executeTrade } from "./executor.js";
import {
  getCollateralBalance,
  getBestBid,
  placeLimitOrder,
  cancelOrder,
  getOpenOrders,
} from "./clob.js";
import {
  getAllPositions,
  getTotalRealizedPnl,
  loadPersistedState,
  resetInventory,
  recordFill,
} from "./inventory.js";
import { reportMetrics, buildSnapshot, getLastSnapshot } from "./metrics.js";
import { loadAnalysis, scheduleAnalysisRefresh } from "./analysis.js";
import { logActivity, getActivity } from "./activity.js";


// ── Equity helper ──────────────────────────────────────────────────────────────

async function fetchAllocatedEquity(): Promise<number> {
  try {
    const res = await fetch(
      `${config.treasuryUrl}/allocations/${config.botId}`,
      { signal: AbortSignal.timeout(3_000) },
    );
    if (res.ok) {
      const data = (await res.json()) as { allocatedUsd: number };
      return data.allocatedUsd ?? 0;
    }
  } catch {
    // Treasury offline — fall back to CLOB balance
  }

  try {
    const botCount = parseInt(process.env["BOT_COUNT"] ?? "1", 10);
    return (await getCollateralBalance()) / botCount;
  } catch {
    return 0;
  }
}

// ── Orchestrator approval helpers ─────────────────────────────────────────────

async function requestOrchestratorApproval(
  tradeId: string,
  signal: object,
): Promise<void> {
  try {
    const res = await fetch(`${config.orchestratorUrl}/copy-trade/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tradeId, signal, botId: config.botId }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      console.warn(
        `[orchestrator] review request returned ${res.status} — treating as manual`,
      );
    }
  } catch {
    // Orchestrator offline — trade stays pending for manual approval
  }
}

// ── Main poll cycle ───────────────────────────────────────────────────────────

async function runCycle(): Promise<void> {
  expireOld();
  pruneTerminal(200);

  const enabledTraders = traders.filter((t) => t.enabled);

  for (const trader of enabledTraders) {
    const signals = await pollTrader(
      trader.address,
      trader.label,
      trader.allocationUsd,
      trader.copyRatio,
    );

    for (const signal of signals) {
      const mode = trader.mode;
      logActivity("signal_detected", {
        side: signal.side,
        market: signal.marketTitle,
        trader: signal.traderLabel,
        mode,
      });

      if (mode === "auto") {
        // Instant approval
        const trade = addPending(signal, params.pendingExpiryMs, "approved");
        await executeTrade(trade);
      } else if (mode === "orchestrator") {
        // Add as pending, ask orchestrator for decision
        const trade = addPending(signal, params.pendingExpiryMs, "pending");
        await requestOrchestratorApproval(trade.id, signal);
      } else {
        // manual — add to queue for dashboard approval
        addPending(signal, params.pendingExpiryMs, "pending");
        console.log(
          `[copy] Pending approval: ${signal.side} ${signal.ourTargetShares.toFixed(2)} ` +
            `(${signal.marketTitle}) — trader: ${signal.traderLabel}`,
        );
      }
    }
  }

  // Execute any trades that were approved (e.g. by orchestrator callback or dashboard)
  const approved = listApproved();
  for (const trade of approved) {
    await executeTrade(trade);
  }
}

// ── Self-rescheduling loops ───────────────────────────────────────────────────

async function schedulePolling(): Promise<void> {
  try {
    await runCycle();
  } catch (err) {
    console.error("[copy] Cycle error:", (err as Error).message);
    logActivity("poll_error", { message: (err as Error).message }, "error");
  }
  setTimeout(schedulePolling, params.pollIntervalMs);
}

async function scheduleMetrics(): Promise<void> {
  try {
    const eq = await fetchAllocatedEquity();
    await reportMetrics(eq);
  } catch (err) {
    console.error("[copy] Metrics error:", (err as Error).message);
  }
  setTimeout(scheduleMetrics, params.metricsIntervalMs);
}

// ── Express API ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Health
app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, botId: config.botId });
});

app.get("/diagnostics", async (_req: Request, res) => {
  const pending = listAll();
  const positions = getAllPositions();
  const eq = await fetchAllocatedEquity();

  res.json({
    ok: true,
    botId: config.botId,
    name: "copy-trader",
    healthy: true,
    allocatedEquity: eq,
    metrics: getLastSnapshot() ?? buildSnapshot(eq),
    reconciliation: {
      tradersTracked: traders.length,
      pendingTrades: pending.length,
      approvedTrades: listApproved().length,
      openPositions: positions.filter((p) => p.netSize > 0).length,
    },
  });
});

// Metrics snapshot
app.get("/metrics", async (_req: Request, res: Response) => {
  const eq = await fetchAllocatedEquity();
  const snap = buildSnapshot(eq);
  res.json(getLastSnapshot() ?? snap);
});

// Our inventory positions
app.get("/positions", (_req: Request, res: Response) => {
  const positions = getAllPositions();
  res.json({
    positions,
    totalRealizedPnl: getTotalRealizedPnl(),
  });
});

// Emergency/manual close: sell all currently held inventory at best bid.
// Wipe all local inventory records (use after contamination or full reset).
// Does NOT cancel any open orders.
app.post("/inventory/reset", (_req: Request, res: Response) => {
  resetInventory();
  res.json({ ok: true, message: "Inventory cleared" });
});

app.post("/orders/cancel-all", async (_req: Request, res: Response) => {
  const orders = await getOpenOrders();
  let cancelled = 0;
  const errors: string[] = [];
  for (const order of orders) {
    try {
      await cancelOrder(order.id);
      cancelled++;
    } catch (err) {
      errors.push(`${order.id}: ${(err as Error).message}`);
    }
  }
  res.json({ ok: true, cancelled, total: orders.length, errors });
});

app.post("/positions/close-all", async (_req: Request, res: Response) => {
  const positions = getAllPositions().filter((p) => p.netSize > 0.001);
  if (positions.length === 0) {
    res.json({
      ok: true,
      closed: [],
      skipped: [],
      message: "No open positions",
    });
    return;
  }

  const closed: Array<{
    tokenId: string;
    size: number;
    price: number;
    orderId: string;
  }> = [];
  const skipped: Array<{ tokenId: string; reason: string }> = [];

  for (const pos of positions) {
    try {
      const price = await getBestBid(pos.tokenId);
      if (!Number.isFinite(price) || price <= 0 || price >= 1) {
        skipped.push({
          tokenId: pos.tokenId,
          reason: `Invalid bid price: ${price}`,
        });
        continue;
      }

      const size = pos.netSize;
      const { orderId } = await placeLimitOrder(
        pos.tokenId,
        "SELL",
        price,
        size,
        "[MANUAL CLOSE-ALL]",
      );

      // Keep local inventory in sync immediately after successful order post.
      recordFill(pos.tokenId, "manual-close", "SELL", price, size);

      closed.push({ tokenId: pos.tokenId, size, price, orderId });
    } catch (err) {
      skipped.push({
        tokenId: pos.tokenId,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  res.json({ ok: true, closed, skipped });
});

// ── Pending queue ─────────────────────────────────────────────────────────────

app.get("/activity", (req: Request, res: Response) => {
  const limit = Number(req.query["limit"] ?? 100);
  const afterSeq = Number(req.query["afterSeq"] ?? 0);
  res.json({
    entries: getActivity(
      Number.isFinite(limit) ? limit : 100,
      Number.isFinite(afterSeq) ? afterSeq : 0,
    ),
  });
});

app.get("/pending", (_req: Request, res: Response) => {
  res.json(listAll());
});

app.post("/pending/:id/approve", (req: Request, res: Response) => {
  const trade = approve(req.params["id"] ?? "");
  if (!trade) {
    res.status(404).json({ error: "Trade not found or not in pending state" });
    return;
  }
  logActivity("trade_approved", { id: trade.id, market: trade.marketTitle });
  // Execute asynchronously (don't await)
  executeTrade(trade).catch((err: unknown) =>
    console.error("[approve] Execution error:", (err as Error).message),
  );
  res.json({ ok: true, trade });
});

app.post("/pending/:id/reject", (req: Request, res: Response) => {
  const ok = reject(req.params["id"] ?? "");
  if (!ok) {
    res.status(404).json({ error: "Trade not found or not in pending state" });
    return;
  }
  logActivity("trade_rejected", { id: req.params["id"] ?? "" });
  res.json({ ok: true });
});

// Orchestrator callback — approve or reject a trade by AI decision
app.post(
  "/pending/:id/orchestrator-decision",
  (req: Request, res: Response) => {
    const { decision } = req.body as { decision: "approve" | "reject" };
    if (decision === "approve") {
      const trade = approve(req.params["id"] ?? "");
      if (!trade) {
        res
          .status(404)
          .json({ error: "Trade not found or not in pending state" });
        return;
      }
      executeTrade(trade).catch((err: unknown) =>
        console.error(
          "[orchestrator-decision] Execution error:",
          (err as Error).message,
        ),
      );
      res.json({ ok: true });
    } else {
      const ok = reject(req.params["id"] ?? "");
      if (!ok) {
        res
          .status(404)
          .json({ error: "Trade not found or not in pending state" });
        return;
      }
      res.json({ ok: true });
    }
  },
);

// ── Trader management ─────────────────────────────────────────────────────────

app.get("/traders", (_req: Request, res: Response) => {
  res.json(traders);
});

app.post("/traders", (req: Request, res: Response) => {
  const body = req.body as Partial<TrackedTrader>;

  if (!body.address || typeof body.address !== "string") {
    res.status(400).json({ error: "address is required" });
    return;
  }
  if (!body.label || typeof body.label !== "string") {
    res.status(400).json({ error: "label is required" });
    return;
  }
  const allocationUsd = Number(body.allocationUsd);
  if (!isFinite(allocationUsd) || allocationUsd <= 0) {
    res.status(400).json({ error: "allocationUsd must be a positive number" });
    return;
  }
  const copyRatio = Number(body.copyRatio ?? 1.0);
  if (!isFinite(copyRatio) || copyRatio <= 0 || copyRatio > 1) {
    res.status(400).json({ error: "copyRatio must be between 0 and 1" });
    return;
  }
  const mode = body.mode ?? "manual";
  if (!["manual", "auto", "orchestrator"].includes(mode)) {
    res
      .status(400)
      .json({ error: "mode must be manual, auto, or orchestrator" });
    return;
  }

  const trader: TrackedTrader = {
    address: body.address.trim().toLowerCase(),
    label: body.label.trim(),
    allocationUsd,
    copyRatio,
    mode,
    enabled: body.enabled !== false,
    addedAt: new Date().toISOString(),
  };

  addTrader(trader);
  res.status(201).json(trader);
});

app.put("/traders/:address", (req: Request, res: Response) => {
  const address = req.params["address"]?.toLowerCase() ?? "";
  const patch = req.body as Partial<Omit<TrackedTrader, "address" | "addedAt">>;

  // Validate numeric fields if present
  if (patch.allocationUsd !== undefined) {
    const v = Number(patch.allocationUsd);
    if (!isFinite(v) || v <= 0) {
      res
        .status(400)
        .json({ error: "allocationUsd must be a positive number" });
      return;
    }
    patch.allocationUsd = v;
  }
  if (patch.copyRatio !== undefined) {
    const v = Number(patch.copyRatio);
    if (!isFinite(v) || v <= 0 || v > 1) {
      res.status(400).json({ error: "copyRatio must be between 0 and 1" });
      return;
    }
    patch.copyRatio = v;
  }
  if (
    patch.mode !== undefined &&
    !["manual", "auto", "orchestrator"].includes(patch.mode)
  ) {
    res
      .status(400)
      .json({ error: "mode must be manual, auto, or orchestrator" });
    return;
  }

  const updated = updateTrader(address, patch);
  if (!updated) {
    res.status(404).json({ error: "Trader not found" });
    return;
  }
  res.json(updated);
});

app.delete("/traders/:address", (req: Request, res: Response) => {
  const address = req.params["address"]?.toLowerCase() ?? "";
  const removed = removeTrader(address);
  if (!removed) {
    res.status(404).json({ error: "Trader not found" });
    return;
  }
  removeSnapshot(address);
  res.json({ ok: true });
});

// Trader positions snapshot (what positions the tracked trader currently holds)
app.get("/traders/:address/snapshot", (req: Request, res: Response) => {
  const address = req.params["address"]?.toLowerCase() ?? "";
  res.json(getSnapshot(address));
});

// ── Config ────────────────────────────────────────────────────────────────────

app.get("/config", (_req: Request, res: Response) => {
  res.json({ params: getParams(), defaults: getDefaults() });
});

app.put("/config", (req: Request, res: Response) => {
  const patch = req.body as Partial<typeof params>;
  updateParams(patch);
  res.json(getParams());
});

app.post("/config/reset", (_req: Request, res: Response) => {
  resetParams();
  res.json(getParams());
});

// ── Startup ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(
    `[copy-trader] Starting (bot ${config.botId}, port ${config.port})`,
  );

  // Restore tracked traders from disk (must be before poll loop starts)
  loadTraders();

  // Restore inventory from state file only — never from raw CLOB trade history,
  // which would mix in positions placed by other bots on the same wallet.
  loadPersistedState();

  app.listen(config.port, () => {
    console.log(`[copy-trader] Listening on port ${config.port}`);
  });

  await loadAnalysis().catch(() => {});
  scheduleAnalysisRefresh();

  // Start loops
  setTimeout(schedulePolling, 2_000);
  setTimeout(scheduleMetrics, 5_000);
}

main().catch((err) => {
  console.error("[copy-trader] Fatal startup error:", err);
  process.exit(1);
});
