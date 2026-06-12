/**
 * executor.ts — places both legs of an arb simultaneously.
 * If one leg fails, cancel the other immediately to avoid naked exposure.
 */

import { placeLimitOrder, cancelOrder, getOpenOrders } from "./clob.js";
import {
  addPair,
  cancelPair,
  updatePair,
  addNegRiskPair,
  cancelNegRiskPair,
  type ArbPair,
  type NegRiskPair,
} from "./inventory.js";
import { mergeYesNo } from "./merge.js";
import { logActivity } from "./activity.js";
import type { ArbSignal, NegRiskArbSignal } from "./orderbook.js";
import { config } from "./config.js";

function recordAttribution(
  tokenId: string,
  outcomeIndex: number,
  side: string,
  conditionId: string,
  marketQuestion: string,
): void {
  const userAddress = process.env["USER_METAMASK_ADDRESS"] ?? "";
  if (!userAddress) return;
  fetch(`${config.orchestratorUrl}/positions/attribute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userAddress,
      conditionId,
      outcomeIndex,
      tokenId,
      botName: "in-market-arb",
      marketQuestion,
      side,
    }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
}

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
    `[executor] Binary arb ${id} — ${signal.marketQuestion} | ` +
      `YES@${signal.yesEntryPrice.toFixed(4)} NO@${signal.noEntryPrice.toFixed(4)} ` +
      `net=${signal.netSpread.toFixed(4)} fee=${signal.feeRate} size=${size.toFixed(2)}`,
  );

  let yesOrderId: string | null = null;
  let noOrderId: string | null = null;

  try {
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
    logActivity(
      "pair_place_failed",
      { pairId: id, message: (err as Error).message },
      "error",
    );
    if (yesOrderId) await cancelOrder(yesOrderId);
    if (noOrderId) await cancelOrder(noOrderId);
    return;
  }

  const pair: ArbPair = {
    id,
    type: "binary",
    marketId: signal.marketId,
    conditionId: signal.conditionId,
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
  logActivity("pair_placed", {
    pairId: id,
    market: signal.marketQuestion,
    yesPrice: signal.yesEntryPrice,
    noPrice: signal.noEntryPrice,
    size,
  });
  recordAttribution(signal.yesTokenId, 0, "YES", signal.marketId, signal.marketQuestion);
  recordAttribution(signal.noTokenId, 1, "NO", signal.marketId, signal.marketQuestion);

  setTimeout(async () => {
    const { getPair } = await import("./inventory.js");
    const current = getPair(id);
    if (!current || current.status !== "pending") return;

    // Capture fill amounts before cancelling
    const openOrders = await getOpenOrders().catch(() => []);
    const openById = new Map(openOrders.map((o) => [o.id, o]));
    const yesRemaining = openById.get(yesOrderId!)?.remainingSize ?? 0;
    const noRemaining = openById.get(noOrderId!)?.remainingSize ?? 0;
    const yesFilled = Math.max(0, size - yesRemaining);
    const noFilled = Math.max(0, size - noRemaining);

    console.warn(`[executor] Pair ${id} timed out — cancelling both legs`);
    logActivity(
      "pair_timeout_cancelled",
      { pairId: id, yesFilled, noFilled },
      "warn",
    );
    await Promise.all([cancelOrder(yesOrderId!), cancelOrder(noOrderId!)]);
    cancelPair(id);

    const mergeAmount = Math.min(yesFilled, noFilled);
    if (mergeAmount > 0.01 && current.conditionId) {
      updatePair(id, { mergeAttempted: true });
      logActivity("merge_attempted", { pairId: id, amount: mergeAmount });
      mergeYesNo(current.conditionId, mergeAmount)
        .then((txHash) => {
          console.log(`[executor] Merge complete pair=${id} tx=${txHash}`);
          logActivity("merge_complete", { pairId: id, txHash });
          updatePair(id, { mergeTxHash: txHash });
        })
        .catch((err: Error) => {
          console.error(`[executor] mergeYesNo failed pair=${id}:`, err.message);
          logActivity(
            "merge_failed",
            { pairId: id, message: err.message },
            "error",
          );
        });
    }
  }, config.pairTimeoutMs);
}

/**
 * Execute all N YES legs of a negRisk group.
 * If any leg fails, cancel all already-placed legs immediately.
 * Buying all YES outcomes guarantees $1 at resolution (exactly one wins).
 */
export async function executeNegRiskArbPair(
  signal: NegRiskArbSignal,
): Promise<void> {
  const N = signal.legs.length;
  const totalRawCost = signal.legs.reduce((s, l) => s + l.entryPrice, 0);
  const sizeByBudget = config.maxPositionUsd / totalRawCost;
  const size = Math.min(sizeByBudget, signal.profitableVolumeUsd / totalRawCost);

  if (size < 0.01) {
    console.warn(
      `[executor] NegRisk size too small (${size.toFixed(4)}) for group ${signal.negRiskMarketId}`,
    );
    return;
  }

  const id = makeId();
  console.log(
    `[executor] NegRisk arb ${id} — ${signal.groupQuestion} | ` +
      `${N} legs net=${signal.netSpread.toFixed(4)} fee=${signal.feeRate} size=${size.toFixed(2)}`,
  );

  const placedOrderIds: string[] = [];

  for (const leg of signal.legs) {
    try {
      const result = await placeLimitOrder(
        leg.tokenId,
        "BUY",
        leg.entryPrice,
        size,
      );
      placedOrderIds.push(result.orderId);
    } catch (err) {
      console.error(
        `[executor] NegRisk pair ${id} leg failed:`,
        (err as Error).message,
      );
      logActivity(
        "negrisk_leg_failed",
        { pairId: id, message: (err as Error).message },
        "error",
      );
      // Cancel all previously placed legs
      await Promise.allSettled(placedOrderIds.map((oid) => cancelOrder(oid)));
      return;
    }
  }

  const pair: NegRiskPair = {
    id,
    type: "neg_risk",
    negRiskMarketId: signal.negRiskMarketId,
    groupQuestion: signal.groupQuestion,
    sweep: signal.sweep,
    legs: signal.legs.map((l, i) => ({
      marketId: l.marketId,
      yesTokenId: l.tokenId,
      orderId: placedOrderIds[i],
      price: l.entryPrice,
      size,
      remainingSize: size,
    })),
    totalCostUsd: size * totalRawCost,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  addNegRiskPair(pair);
  logActivity("negrisk_placed", {
    pairId: id,
    sweep: signal.sweep,
    group: signal.groupQuestion,
    legs: signal.legs.length,
    totalCostUsd: pair.totalCostUsd,
  });

  signal.legs.forEach((leg, i) => {
    recordAttribution(
      leg.tokenId,
      i,
      signal.sweep === "yes" ? "YES" : "NO",
      leg.marketId,
      signal.groupQuestion,
    );
  });

  setTimeout(async () => {
    const { getNegRiskPair } = await import("./inventory.js");
    const current = getNegRiskPair(id);
    if (!current || current.status !== "pending") return;
    console.warn(`[executor] NegRisk pair ${id} timed out — cancelling all legs`);
    logActivity("negrisk_timeout_cancelled", { pairId: id }, "warn");
    await Promise.allSettled(placedOrderIds.map((oid) => cancelOrder(oid)));
    cancelNegRiskPair(id);
  }, config.pairTimeoutMs);
}
