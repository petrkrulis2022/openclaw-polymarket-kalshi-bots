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
import { getCollateralBalance, fetchTradeHistory } from "./clob.js";
import {
  getAllPositions,
  getTotalRealizedPnl,
  initFromTrades,
} from "./inventory.js";
import { reportMetrics, buildSnapshot, getLastSnapshot } from "./metrics.js";

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

  if (config.paperTrading) return params.paperEquity;

  try {
    return await getCollateralBalance();
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
  res.json({ ok: true, botId: config.botId, paper: config.paperTrading });
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

// ── Pending queue ─────────────────────────────────────────────────────────────

app.get("/pending", (_req: Request, res: Response) => {
  res.json(listAll());
});

app.post("/pending/:id/approve", (req: Request, res: Response) => {
  const trade = approve(req.params["id"] ?? "");
  if (!trade) {
    res.status(404).json({ error: "Trade not found or not in pending state" });
    return;
  }
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
    `[copy-trader] Starting (bot ${config.botId}, port ${config.port}, paper=${config.paperTrading})`,
  );

  // Restore inventory from trade history
  try {
    const trades = await fetchTradeHistory();
    if (trades.length > 0) {
      initFromTrades(trades);
      console.log(`[copy-trader] Restored ${trades.length} trade records`);
    }
  } catch (err) {
    console.warn(
      "[copy-trader] Could not restore trade history:",
      (err as Error).message,
    );
  }

  app.listen(config.port, () => {
    console.log(`[copy-trader] Listening on port ${config.port}`);
  });

  // Start loops
  setTimeout(schedulePolling, 2_000);
  setTimeout(scheduleMetrics, 5_000);
}

main().catch((err) => {
  console.error("[copy-trader] Fatal startup error:", err);
  process.exit(1);
});
