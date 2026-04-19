/**
 * index.ts — BTC 15-min Lag Bot (Bot 7) — STUB / COMING SOON
 *
 * Strategy (to be implemented):
 *   Coinbase BTC/USD 15-min candle close lags Binance by ~200ms due to
 *   index calculation differences. When Binance prints a decisive candle
 *   close, Polymarket/Kalshi BTC bracket markets briefly misprice because
 *   the oracle uses Coinbase. Enter the mispriced side before Coinbase catches up.
 *
 * Dependencies to build:
 *   - Coinbase Advanced Trade WebSocket (real-time candles)
 *   - Binance WebSocket (klines, 15m)
 *   - Kalshi REST API (bracket market orders)
 *   - Polymarket CLOB (BTC price markets)
 *
 * This stub keeps the port alive and reports to the orchestrator so the
 * dashboard tile renders correctly. Full implementation next sprint.
 */

import "dotenv/config";
import express, { type Request, type Response } from "express";

const PORT = parseInt(process.env["PORT"] ?? "3008", 10);
const BOT_ID = parseInt(process.env["BOT_ID"] ?? "7", 10);
const ORCHESTRATOR_URL =
  process.env["ORCHESTRATOR_URL"] ?? "http://localhost:3002";

const app = express();
app.use(express.json());

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    botId: BOT_ID,
    name: "btc-lag",
    status: "STUB — not yet implemented",
  });
});

app.get("/metrics", (_req: Request, res: Response) => {
  res.json({
    botId: BOT_ID,
    equity: 0,
    pnl: 0,
    unrealizedPnl: 0,
    utilization: 0,
    openPositions: 0,
    recordedAt: new Date().toISOString(),
  });
});

app.get("/positions", (_req: Request, res: Response) => {
  res.json({ positions: [], totalRealizedPnl: 0 });
});

app.get("/config", (_req: Request, res: Response) => {
  res.json({
    botId: BOT_ID,
    status: "STUB",
    strategy: "BTC 15-min Coinbase/Binance Lag",
    description:
      "Exploits the ~200ms lag between Binance and Coinbase 15-min BTC candle closes. " +
      "Trades Polymarket and Kalshi BTC bracket markets before the Coinbase oracle catches up. " +
      "Full implementation scheduled for next sprint alongside Kalshi Arb Bot.",
    exchanges: ["Coinbase Advanced Trade", "Binance"],
    venues: ["Polymarket CLOB", "Kalshi"],
  });
});

// Heartbeat metrics reporter (sends zero equity so the tile shows but doesn't mislead)
async function reportHeartbeat(): Promise<void> {
  try {
    await fetch(`${ORCHESTRATOR_URL}/metrics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        botId: BOT_ID,
        equity: 0,
        pnl: 0,
        realizedPnl: 0,
        unrealizedPnl: 0,
        utilization: 0,
        openPositions: 0,
        recordedAt: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // Orchestrator offline — ignore
  }
  setTimeout(reportHeartbeat, 60_000);
}

app.listen(PORT, () => {
  console.log(
    `[btc-lag] STUB Bot (id=${BOT_ID}) listening on :${PORT} — awaiting full implementation`,
  );
  reportHeartbeat();
});
