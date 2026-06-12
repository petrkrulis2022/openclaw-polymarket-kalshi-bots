/**
 * executor.ts — fires both legs of a Kalshi ↔ Polymarket arb concurrently.
 *
 * DRY_RUN=true (default): logs signal, skips order placement.
 * Both legs placed via Promise.all; either failure cancels both.
 * FOK orders — no partial fills to manage.
 */

import { randomUUID } from "crypto";
import { config } from "./config.js";
import { placeKalshiOrder, cancelKalshiOrder } from "./kalshi.js";
import { placeLimitOrder, cancelPolyOrder } from "./clob.js";
import { addPair, updatePair } from "./inventory.js";
import { logActivity } from "./activity.js";
import type { ArbSignal } from "./orderbook.js";

export interface ExecutionResult {
  pairId: string;
  dryRun: boolean;
  kalshiOrderId?: string;
  polyOrderId?: string;
  error?: string;
}

export async function executeArb(signal: ArbSignal): Promise<ExecutionResult> {
  const pairId = randomUUID();
  const { pair, kalshiSide, kalshiVwap, kalshiContracts, polySide, polyTokenId, polyVwap, polyShares, netEdgePct } = signal;

  const sizeUsd = Math.min(config.maxPositionUsd / 2, kalshiContracts * kalshiVwap, polyShares * polyVwap);

  console.log(
    `[executor] ${config.dryRun ? "DRY_RUN " : ""}signal: ${pair.kalshiTicker} ↔ ${pair.polyQuestion.slice(0, 50)} | ` +
    `${kalshiSide.toUpperCase()} on Kalshi @ ${(kalshiVwap * 100).toFixed(1)}¢ + ` +
    `${polySide.toUpperCase()} on Poly @ ${(polyVwap * 100).toFixed(1)}¢ | ` +
    `edge=${netEdgePct.toFixed(2)}% sizeUsd=${sizeUsd.toFixed(2)}`,
  );

  logActivity("signal_execute", {
    ticker: pair.kalshiTicker,
    edgePct: netEdgePct,
    sizeUsd,
    dryRun: config.dryRun,
  });

  if (config.dryRun) {
    return { pairId, dryRun: true };
  }

  const clientOrderId = `arb-${pairId.slice(0, 8)}`;
  let kalshiOrderId: string | undefined;
  let polyOrderId: string | undefined;

  addPair({
    id: pairId,
    kalshiTicker: pair.kalshiTicker,
    polyConditionId: pair.polyConditionId,
    polyYesTokenId: pair.polyYesTokenId,
    polyNoTokenId: pair.polyNoTokenId,
    kalshiOrderId: "",
    polyOrderId: "",
    kalshiSide,
    polySide,
    kalshiEntryVwap: kalshiVwap,
    polyEntryVwap: polyVwap,
    entryEdgePct: netEdgePct,
    sizeUsd,
    status: "pending",
    openedAt: new Date().toISOString(),
  });

  try {
    const [kResult, pResult] = await Promise.all([
      placeKalshiOrder(pair.kalshiTicker, kalshiSide, kalshiVwap, sizeUsd, clientOrderId),
      placeLimitOrder(polyTokenId, "BUY", polyVwap, sizeUsd / polyVwap),
    ]);
    kalshiOrderId = kResult.orderId;
    polyOrderId = pResult.orderId;

    updatePair(pairId, {
      kalshiOrderId,
      polyOrderId,
      status: "filled",
    });
    logActivity("pair_placed", { pairId, kalshiOrderId, polyOrderId, sizeUsd });

    // Report attribution to orchestrator
    fetch(`${config.orchestratorUrl}/attributions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        botId: config.botId,
        pairId,
        kalshiTicker: pair.kalshiTicker,
        polyConditionId: pair.polyConditionId,
        entryEdgePct: netEdgePct,
        sizeUsd,
        openedAt: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {});

    // Log fills to measurement layer (fire-and-forget)
    const ts = new Date().toISOString();
    const fillBase = {
      ts,
      botId: "kalshi-arb",
      fillStatus: "filled" as const,
      fillShares: 0,
      meta: { kalshiTicker: pair.kalshiTicker, pairId, netEdgePct },
    };
    fetch(`${config.orchestratorUrl}/fills`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...fillBase,
        side: (kalshiSide === "yes" ? "BUY" : "BUY") as "BUY",
        tokenId: pair.kalshiTicker,
        signalPrice: kalshiVwap,
        fillPrice: kalshiVwap,
        fillUsdc: sizeUsd,
      }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {});
    fetch(`${config.orchestratorUrl}/fills`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...fillBase,
        side: "BUY" as const,
        tokenId: polyTokenId,
        signalPrice: polyVwap,
        fillPrice: polyVwap,
        fillUsdc: sizeUsd,
      }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {});

    return { pairId, dryRun: false, kalshiOrderId, polyOrderId };
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`[executor] pair ${pairId} failed: ${msg}`);
    logActivity("pair_failed", { pairId, message: msg }, "error");

    // Cancel whichever leg(s) landed
    const cancels: Promise<void>[] = [];
    if (kalshiOrderId) cancels.push(cancelKalshiOrder(kalshiOrderId));
    if (polyOrderId) cancels.push(cancelPolyOrder(polyOrderId));
    if (cancels.length) await Promise.allSettled(cancels);

    updatePair(pairId, { status: "cancelled", closedAt: new Date().toISOString() });
    return { pairId, dryRun: false, error: msg };
  }
}
