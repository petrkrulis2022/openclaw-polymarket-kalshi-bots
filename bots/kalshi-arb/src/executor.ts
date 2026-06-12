/**
 * executor.ts — fires both legs of a Kalshi ↔ Polymarket arb concurrently.
 *
 * Both legs placed concurrently; a legging failure triggers the unwind
 * path in unwind.ts. FOK orders — no partial fills to manage.
 */

import { randomUUID } from "crypto";
import { config } from "./config.js";
import { placeKalshiOrder, cancelKalshiOrder } from "./kalshi.js";
import { placeLimitOrder, cancelPolyOrder } from "./clob.js";
import { addPair, updatePair, getAllPairs } from "./inventory.js";
import { startUnwind } from "./unwind.js";
import { logActivity } from "./activity.js";
import type { ArbSignal } from "./orderbook.js";

export interface ExecutionResult {
  pairId: string;
  kalshiOrderId?: string;
  polyOrderId?: string;
  error?: string;
}

export async function executeArb(signal: ArbSignal): Promise<ExecutionResult> {
  const pairId = randomUUID();
  const { pair, kalshiSide, kalshiVwap, kalshiContracts, polySide, polyTokenId, polyVwap, polyShares, netEdgePct } = signal;

  const sizeUsd = Math.min(config.maxPositionUsd / 2, kalshiContracts * kalshiVwap, polyShares * polyVwap);

  console.log(
    `[executor] signal: ${pair.kalshiTicker} ↔ ${pair.polyQuestion.slice(0, 50)} | ` +
    `${kalshiSide.toUpperCase()} on Kalshi @ ${(kalshiVwap * 100).toFixed(1)}¢ + ` +
    `${polySide.toUpperCase()} on Poly @ ${(polyVwap * 100).toFixed(1)}¢ | ` +
    `edge=${netEdgePct.toFixed(2)}% sizeUsd=${sizeUsd.toFixed(2)}`,
  );

  logActivity("signal_execute", {
    ticker: pair.kalshiTicker,
    edgePct: netEdgePct,
    sizeUsd,
  });

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

  const [kSettled, pSettled] = await Promise.allSettled([
    placeKalshiOrder(pair.kalshiTicker, kalshiSide, kalshiVwap, sizeUsd, clientOrderId),
    placeLimitOrder(polyTokenId, "BUY", polyVwap, sizeUsd / polyVwap),
  ]);

  // ── Legging failure handling ──────────────────────────────────────────────
  if (kSettled.status === "rejected" || pSettled.status === "rejected") {
    const kMsg = kSettled.status === "rejected" ? (kSettled.reason as Error).message : null;
    const pMsg = pSettled.status === "rejected" ? (pSettled.reason as Error).message : null;
    console.error(
      `[executor] pair ${pairId} legging failure: kalshi=${kMsg ?? "ok"} poly=${pMsg ?? "ok"}`,
    );

    if (kSettled.status === "rejected" && pSettled.status === "rejected") {
      // Both legs failed — nothing held, plain cancel.
      logActivity("pair_failed", { pairId, message: `${kMsg} | ${pMsg}` }, "error");
      updatePair(pairId, { status: "cancelled", closedAt: new Date().toISOString() });
      return { pairId, error: `${kMsg} | ${pMsg}` };
    }

    // Exactly one leg succeeded — we may hold a naked position.
    if (kSettled.status === "fulfilled") {
      kalshiOrderId = kSettled.value.orderId;
      updatePair(pairId, { kalshiOrderId });
      // FOK either filled or self-cancelled; cancel is a harmless no-op if filled.
      await cancelKalshiOrder(kalshiOrderId);
      const naked = getAllPairs().find((p) => p.id === pairId);
      if (naked) await startUnwind(naked, "kalshi");
      return { pairId, kalshiOrderId, error: pMsg ?? undefined };
    }

    polyOrderId = (pSettled as PromiseFulfilledResult<{ orderId: string }>).value.orderId;
    updatePair(pairId, { polyOrderId });
    // Limit order may be resting unfilled — cancel first, then unwind any fill.
    await cancelPolyOrder(polyOrderId);
    const naked = getAllPairs().find((p) => p.id === pairId);
    if (naked) await startUnwind(naked, "poly");
    return { pairId, polyOrderId, error: kMsg ?? undefined };
  }

  try {
    kalshiOrderId = kSettled.value.orderId;
    polyOrderId = pSettled.value.orderId;

    updatePair(pairId, {
      kalshiOrderId,
      polyOrderId,
      status: "filled",
    });
    logActivity("pair_placed", { pairId, kalshiOrderId, polyOrderId, sizeUsd });

    // Report attribution to orchestrator (same endpoint as the other bots —
    // the previous /attributions route never existed, so kalshi-arb positions
    // showed no bot label on the dashboard)
    const userAddress = process.env["USER_METAMASK_ADDRESS"] ?? "";
    if (userAddress) {
      fetch(`${config.orchestratorUrl}/positions/attribute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userAddress,
          conditionId: pair.polyConditionId,
          outcomeIndex: polySide === "yes" ? 0 : 1,
          tokenId: polyTokenId,
          botName: "kalshi-arb",
          marketQuestion: pair.polyQuestion,
          side: polySide.toUpperCase(),
        }),
        signal: AbortSignal.timeout(5_000),
      }).catch(() => {});
    }

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

    return { pairId, kalshiOrderId, polyOrderId };
  } catch (err) {
    // Both orders were placed; this catch only covers post-placement work
    // (attribution/fills reporting) — the pair itself is live and hedged.
    const msg = (err as Error).message;
    console.error(`[executor] pair ${pairId} post-placement error: ${msg}`);
    logActivity("pair_failed", { pairId, message: msg }, "warn");
    return { pairId, kalshiOrderId, polyOrderId, error: msg };
  }
}
