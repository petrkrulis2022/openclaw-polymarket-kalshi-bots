/**
 * index.ts – WDK Treasury Service entry point
 *
 * Exposes three REST endpoints:
 *   GET  /wallets          → addresses + USD₮ balances for all 4 wallets
 *   POST /allocate         → transfer USD₮ from treasury to a bot wallet
 *   POST /recall           → transfer USD₮ from a bot wallet back to treasury
 *   GET  /health           → liveness check
 *
 * This module MUST be the entry point so that dotenv (loaded transitively by
 * src/wdk.ts) is guaranteed to run before any module-level env reads.
 */

// dotenv is loaded inside src/wdk.ts as its first import, which means it runs
// before any module-level code in this file accesses process.env.
import "./wdk.js"; // warm up the WDK module (validates env at startup)

import express, { NextFunction, Request, Response } from "express";
import walletsRouter from "./routes/wallets.js";
import allocateRouter from "./routes/allocate.js";
import recallRouter from "./routes/recall.js";
import deriveRouter from "./routes/derive.js";
import balanceRouter from "./routes/balance.js";
import swapRouter from "./routes/swap.js";
import swapReverseRouter from "./routes/swap-reverse.js";
import withdrawRouter from "./routes/withdraw.js";

const app = express();

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(express.json());

// ── Routes ────────────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/wallets", walletsRouter);
app.use("/allocate", allocateRouter);
app.use("/recall", recallRouter);
app.use("/derive", deriveRouter);
app.use("/balance", balanceRouter);
app.use("/swap", swapRouter);
app.use("/swap-reverse", swapReverseRouter);
app.use("/withdraw", withdrawRouter);

// ── 404 catch-all ─────────────────────────────────────────────────────────────

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found" });
});

// ── Global error handler ──────────────────────────────────────────────────────
// Sanitised: never send stack traces or internal details to clients.

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message =
    err instanceof Error ? err.message : "An unexpected error occurred.";
  // Log the full error server-side for debugging
  console.error("[error]", err instanceof Error ? err.stack : err);
  res.status(500).json({ error: "Internal error", message });
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 3001);

app.listen(PORT, () => {
  console.log(`WDK Treasury Service listening on http://localhost:${PORT}`);
  console.log(`  GET  /health`);
  console.log(`  GET  /wallets`);
  console.log(`  POST /allocate`);
  console.log(`  POST /recall`);
  console.log(`  POST /derive   (internal)`);
});
