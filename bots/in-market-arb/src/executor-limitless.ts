/**
 * executor-limitless.ts — Limitless (CTF on Base) binary-arb execution.
 *
 * Buys YES + NO with FAK marketable-limit orders (no naked resting leg), reports
 * each leg to the measurement sink, then merges the matched amount back to USDC
 * to recover capital. Real orders — no dry-run; size is capped by the budget and
 * ultimately by the Base USDC balance (insufficient balance / bad orders are
 * rejected by the venue, not mis-filled).
 */

import { config } from "./config.js";
import { addPair, settlePair, updatePair, type ArbPair } from "./inventory.js";
import { logActivity } from "./activity.js";
import { reportFill } from "./measurement.js";
import { placeBuy, ensureUsdcApproval, mergeYesNo } from "./venue/limitless.js";
import type { ArbSignal } from "./orderbook.js";

function makeId(): string {
  return `larb-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export async function executeLimitlessArbPair(signal: ArbSignal): Promise<void> {
  const budgetUsd = Math.min(config.maxPositionUsd, signal.profitableVolumeUsd);
  const combined = signal.yesEntryPrice + signal.noEntryPrice;
  const size = combined > 0 ? Math.floor(budgetUsd / combined) : 0; // whole shares
  if (size < 1) {
    console.warn(`[limitless-exec] size<1 for ${signal.marketQuestion}`);
    return;
  }

  const id = makeId();
  const slug = signal.marketId; // BinaryMarket.id = slug
  console.log(
    `[limitless-exec] ${id} ${signal.marketQuestion} | YES@${signal.yesEntryPrice.toFixed(4)} ` +
      `NO@${signal.noEntryPrice.toFixed(4)} net=${signal.netSpread.toFixed(4)} size=${size}`,
  );

  // One-time USDC approval for this market's exchange (needs ETH on Base for gas).
  try {
    await ensureUsdcApproval(slug);
  } catch (err) {
    console.error(`[limitless-exec] USDC approval failed: ${(err as Error).message}`);
    return;
  }

  const [yRes, nRes] = await Promise.allSettled([
    placeBuy(signal.yesTokenId, signal.yesEntryPrice, size),
    placeBuy(signal.noTokenId, signal.noEntryPrice, size),
  ]);
  const yesOk = yRes.status === "fulfilled";
  const noOk = nRes.status === "fulfilled";
  if (yRes.status === "rejected")
    console.warn(`[limitless-exec] ${id} YES leg rejected: ${(yRes.reason as Error).message}`);
  if (nRes.status === "rejected")
    console.warn(`[limitless-exec] ${id} NO leg rejected: ${(nRes.reason as Error).message}`);

  // Measurement: one record per leg (FAK fill amount confirmed live; assume full
  // on success for now and refine once the createOrder fill shape is verified).
  reportFill({
    side: "BUY",
    tokenId: signal.yesTokenId,
    signalPrice: signal.yesEntryPrice,
    fillPrice: signal.yesEntryPrice,
    fillShares: yesOk ? size : 0,
    fillUsdc: yesOk ? size * signal.yesEntryPrice : 0,
    fillStatus: yesOk ? "filled" : "failed",
    meta: { pairId: id, leg: "yes", slug },
  });
  reportFill({
    side: "BUY",
    tokenId: signal.noTokenId,
    signalPrice: signal.noEntryPrice,
    fillPrice: signal.noEntryPrice,
    fillShares: noOk ? size : 0,
    fillUsdc: noOk ? size * signal.noEntryPrice : 0,
    fillStatus: noOk ? "filled" : "failed",
    meta: { pairId: id, leg: "no", slug },
  });

  const pair: ArbPair = {
    id,
    type: "binary",
    marketId: slug,
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
    // Hedged — recover capital by merging the matched YES+NO back to USDC.
    try {
      const tx = await mergeYesNo(slug, size);
      const pnl = size * signal.netSpread;
      settlePair(id, pnl);
      logActivity("limitless_pair_filled", {
        pairId: id,
        market: signal.marketQuestion,
        size,
        pnlUsd: pnl,
        mergeTx: tx,
      });
      console.log(
        `[limitless-exec] ${id} hedged ${size} | pnl≈$${pnl.toFixed(4)}` +
          (tx ? ` | merge=${tx.slice(0, 10)}` : " | held (no merge)"),
      );
    } catch (err) {
      console.error(`[limitless-exec] merge failed (pair ${id}): ${(err as Error).message}`);
      updatePair(id, { status: "partial" });
    }
  } else {
    // A single filled leg is naked exposure (FAK leaves no resting order to
    // cancel). Flag for review; unwind is handled live for now.
    updatePair(id, { status: "partial" });
    logActivity("limitless_pair_legged", { pairId: id, yesOk, noOk }, "warn");
    console.warn(`[limitless-exec] ${id} legged: yes=${yesOk} no=${noOk} — naked leg, review`);
  }
}
