/**
 * executor.ts — places both legs of an arb simultaneously.
 * If one leg fails, cancel the other immediately to avoid naked exposure.
 */

import { placeLimitOrder, cancelOrder } from "./clob.js";
import { addPair, cancelPair, type ArbPair } from "./inventory.js";
import type { ArbSignal } from "./orderbook.js";
import { config } from "./config.js";

function makeId(): string {
  return `arb-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Execute both YES and NO legs concurrently.
 * On any failure, attempt to cancel the successful leg.
 */
export async function executeArbPair(signal: ArbSignal): Promise<void> {
  const budgetUsd = Math.min(config.maxPositionUsd, signal.profitableVolumeUsd);
  const combinedPrice = signal.yesEntryPrice + signal.noEntryPrice;
  const size = combinedPrice > 0 ? budgetUsd / combinedPrice : 0;

  if (size < 0.01) {
    console.warn(
      `[executor] Size too small (${size.toFixed(4)}) for market ${signal.marketId}`,
    );
    return;
  }

  const id = makeId();
  console.log(
    `[executor] Entering arb pair ${id} — market: ${signal.marketQuestion} | ` +
      `YES@${signal.yesEntryPrice.toFixed(4)} NO@${signal.noEntryPrice.toFixed(4)} ` +
      `spread=${signal.netSpread.toFixed(4)} size=${size.toFixed(2)}`,
  );

  let yesOrderId: string | null = null;
  let noOrderId: string | null = null;

  try {
    // Place first leg, then second leg. If second leg fails, immediately
    // cancel the first to avoid naked directional exposure.
    const yesResult = await placeLimitOrder(
      signal.yesTokenId,
      "BUY",
      signal.yesEntryPrice,
      size,
    );
    yesOrderId = yesResult.orderId;

    const noResult = await placeLimitOrder(
      signal.noTokenId,
      "BUY",
      signal.noEntryPrice,
      size,
    );
    noOrderId = noResult.orderId;
  } catch (err) {
    console.error(
      `[executor] Failed to place pair ${id}:`,
      (err as Error).message,
    );
    // Attempt to cancel whichever leg succeeded
    if (yesOrderId) await cancelOrder(yesOrderId);
    if (noOrderId) await cancelOrder(noOrderId);
    return;
  }

  const pair: ArbPair = {
    id,
    marketId: signal.marketId,
    marketQuestion: signal.marketQuestion,
    yesTokenId: signal.yesTokenId,
    noTokenId: signal.noTokenId,
    yesOrderId,
    noOrderId,
    yesPrice: signal.yesEntryPrice,
    noPrice: signal.noEntryPrice,
    yesRemainingSize: size,
    noRemainingSize: size,
    sizeUsd: size * (signal.yesEntryPrice + signal.noEntryPrice),
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  addPair(pair);

  // Schedule pair timeout — cancel unpaired leg if not filled
  setTimeout(async () => {
    const { getPair } = await import("./inventory.js");
    const current = getPair(id);
    if (!current || current.status !== "pending") return;
    console.warn(`[executor] Pair ${id} timed out — cancelling both legs`);
    await Promise.all([cancelOrder(yesOrderId), cancelOrder(noOrderId)]);
    cancelPair(id);
  }, config.pairTimeoutMs);
}
