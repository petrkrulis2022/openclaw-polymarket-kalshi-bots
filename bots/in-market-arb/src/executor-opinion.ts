/**
 * executor-opinion.ts — Opinion (CLOB on BNB) binary-arb execution.
 *
 * Opinion has no FOK/IOC, so legs are marketable LIMIT orders at the asks; the
 * matched YES+NO is then merged back to collateral. Real orders — no dry-run;
 * sized off the budget and capped by the quote-token balance. BLIND until the
 * gated Opinion key + live validation.
 */

import { config } from "./config.js";
import { addPair, settlePair, updatePair, type ArbPair } from "./inventory.js";
import { logActivity } from "./activity.js";
import { reportFill } from "./measurement.js";
import { placeBuy, mergeYesNo, enableTrading } from "./venue/opinion.js";
import type { ArbSignal } from "./orderbook.js";

function makeId(): string {
  return `oarb-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export async function executeOpinionArbPair(signal: ArbSignal): Promise<void> {
  const budgetUsd = Math.min(config.maxPositionUsd, signal.profitableVolumeUsd);
  const combined = signal.yesEntryPrice + signal.noEntryPrice;
  const size = combined > 0 ? Math.floor(budgetUsd / combined) : 0;
  if (size < 1) {
    console.warn(`[opinion-exec] size<1 for ${signal.marketQuestion}`);
    return;
  }

  const id = makeId();
  const marketId = signal.marketId; // BinaryMarket.id = marketId
  console.log(
    `[opinion-exec] ${id} ${signal.marketQuestion} | YES@${signal.yesEntryPrice.toFixed(4)} ` +
      `NO@${signal.noEntryPrice.toFixed(4)} net=${signal.netSpread.toFixed(4)} size=${size}`,
  );

  // One-time trading enablement (Safe approval); cheap no-op after the first call.
  try {
    await enableTrading();
  } catch (err) {
    console.error(`[opinion-exec] enableTrading failed: ${(err as Error).message}`);
    return;
  }

  const [yRes, nRes] = await Promise.allSettled([
    placeBuy(signal.yesTokenId, signal.yesEntryPrice, size),
    placeBuy(signal.noTokenId, signal.noEntryPrice, size),
  ]);
  const yesOk = yRes.status === "fulfilled";
  const noOk = nRes.status === "fulfilled";
  if (yRes.status === "rejected")
    console.warn(`[opinion-exec] ${id} YES leg rejected: ${(yRes.reason as Error).message}`);
  if (nRes.status === "rejected")
    console.warn(`[opinion-exec] ${id} NO leg rejected: ${(nRes.reason as Error).message}`);

  reportFill({
    side: "BUY",
    tokenId: signal.yesTokenId,
    signalPrice: signal.yesEntryPrice,
    fillPrice: signal.yesEntryPrice,
    fillShares: yesOk ? size : 0,
    fillUsdc: yesOk ? size * signal.yesEntryPrice : 0,
    fillStatus: yesOk ? "filled" : "failed",
    meta: { pairId: id, leg: "yes", marketId },
  });
  reportFill({
    side: "BUY",
    tokenId: signal.noTokenId,
    signalPrice: signal.noEntryPrice,
    fillPrice: signal.noEntryPrice,
    fillShares: noOk ? size : 0,
    fillUsdc: noOk ? size * signal.noEntryPrice : 0,
    fillStatus: noOk ? "filled" : "failed",
    meta: { pairId: id, leg: "no", marketId },
  });

  const pair: ArbPair = {
    id,
    type: "binary",
    marketId,
    conditionId: signal.conditionId,
    marketQuestion: signal.marketQuestion,
    yesTokenId: signal.yesTokenId,
    noTokenId: signal.noTokenId,
    yesOrderId: yesOk ? yRes.value.orderId : "",
    noOrderId: noOk ? nRes.value.orderId : "",
    yesPrice: signal.yesEntryPrice,
    noPrice: signal.noEntryPrice,
    yesRemainingSize: 0,
    noRemainingSize: 0,
    sizeUsd: size * combined,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  addPair(pair);

  if (yesOk && noOk) {
    const tx = await mergeYesNo(marketId, size);
    const pnl = size * signal.netSpread;
    settlePair(id, pnl);
    logActivity("opinion_pair_filled", {
      pairId: id,
      market: signal.marketQuestion,
      size,
      pnlUsd: pnl,
      mergeTx: tx,
    });
    console.log(
      `[opinion-exec] ${id} hedged ${size} | pnl≈$${pnl.toFixed(4)}` +
        (tx ? ` | merge=${tx.slice(0, 10)}` : " | held (merge pending)"),
    );
  } else {
    updatePair(id, { status: "partial" });
    logActivity("opinion_pair_legged", { pairId: id, yesOk, noOk }, "warn");
    console.warn(`[opinion-exec] ${id} legged: yes=${yesOk} no=${noOk} — naked leg, review`);
  }
}
