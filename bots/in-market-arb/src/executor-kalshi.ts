/**
 * executor-kalshi.ts — Kalshi binary-arb execution.
 *
 * Buys YES + NO of one market with FOK orders (no resting orders, no neg-risk
 * groups, no on-chain merge — none of which Kalshi has). FOK responses don't
 * carry a fill amount, so fills are confirmed via position deltas, and any
 * naked leg (one side filled, the other killed) is unwound at the bid.
 */

import { config } from "./config.js";
import { addPair, settlePair, updatePair, type ArbPair } from "./inventory.js";
import { logActivity } from "./activity.js";
import {
  getOrderBook,
  placeBuy,
  placeSell,
  getPositionContracts,
} from "./venue/kalshi.js";
import type { ArbSignal } from "./orderbook.js";

const UNWIND_SLIP = 0.02;
const FILL_SETTLE_MS = 600; // let Kalshi settle the position before we read it

function makeId(): string {
  return `karb-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function heldContracts(ref: string): Promise<number> {
  const p = await getPositionContracts(ref);
  return p ?? 0;
}

export async function executeKalshiArbPair(signal: ArbSignal): Promise<void> {
  const budgetUsd = Math.min(config.maxPositionUsd, signal.profitableVolumeUsd);
  const combined = signal.yesEntryPrice + signal.noEntryPrice;
  const size = combined > 0 ? Math.floor(budgetUsd / combined) : 0; // whole contracts
  if (size < 1) {
    console.warn(
      `[kalshi-exec] size<1 (budget=$${budgetUsd.toFixed(2)} combined=${combined.toFixed(4)}) — skip ${signal.marketQuestion}`,
    );
    return;
  }

  const id = makeId();
  const yesRef = signal.yesTokenId;
  const noRef = signal.noTokenId;
  console.log(
    `[kalshi-exec] ${id} ${signal.marketQuestion} | YES@${signal.yesEntryPrice.toFixed(4)} ` +
      `NO@${signal.noEntryPrice.toFixed(4)} net=${signal.netSpread.toFixed(4)} size=${size}`,
  );

  const [yesBefore, noBefore] = await Promise.all([
    heldContracts(yesRef),
    heldContracts(noRef),
  ]);

  const [yRes, nRes] = await Promise.allSettled([
    placeBuy(yesRef, signal.yesEntryPrice, size),
    placeBuy(noRef, signal.noEntryPrice, size),
  ]);
  const yesOrderId = yRes.status === "fulfilled" ? yRes.value.orderId : "";
  const noOrderId = nRes.status === "fulfilled" ? nRes.value.orderId : "";
  if (yRes.status === "rejected")
    console.warn(`[kalshi-exec] ${id} YES leg rejected: ${(yRes.reason as Error).message}`);
  if (nRes.status === "rejected")
    console.warn(`[kalshi-exec] ${id} NO leg rejected: ${(nRes.reason as Error).message}`);

  // FOK gives no fill amount in the response — confirm via position deltas.
  await new Promise((r) => setTimeout(r, FILL_SETTLE_MS));
  const [yesAfter, noAfter] = await Promise.all([
    heldContracts(yesRef),
    heldContracts(noRef),
  ]);
  const filledYes = Math.max(0, yesAfter - yesBefore);
  const filledNo = Math.max(0, noAfter - noBefore);
  const hedged = Math.min(filledYes, filledNo);

  const pair: ArbPair = {
    id,
    type: "binary",
    marketId: signal.marketId,
    conditionId: "",
    marketQuestion: signal.marketQuestion,
    yesTokenId: yesRef,
    noTokenId: noRef,
    yesOrderId,
    noOrderId,
    yesPrice: signal.yesEntryPrice,
    noPrice: signal.noEntryPrice,
    yesRemainingSize: 0,
    noRemainingSize: 0,
    sizeUsd: hedged * combined,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  addPair(pair);

  // Unwind any naked leg (one side filled more than the other).
  const nakedYes = filledYes - hedged;
  const nakedNo = filledNo - hedged;
  if (nakedYes >= 1) await unwind(yesRef, nakedYes, "YES", id);
  if (nakedNo >= 1) await unwind(noRef, nakedNo, "NO", id);

  if (hedged >= 1) {
    // Locked arb: each hedged set returns $1 at resolution; net profit per set
    // after fees is signal.netSpread (fees are already in the threshold).
    const pnl = hedged * signal.netSpread;
    settlePair(id, pnl);
    logActivity("kalshi_pair_filled", {
      pairId: id,
      market: signal.marketQuestion,
      hedged,
      pnlUsd: pnl,
    });
    console.log(`[kalshi-exec] ${id} hedged ${hedged} sets | pnl≈$${pnl.toFixed(4)}`);
  } else {
    updatePair(id, { status: "cancelled" });
    logActivity(
      "kalshi_pair_no_fill",
      { pairId: id, market: signal.marketQuestion, filledYes, filledNo },
      "warn",
    );
    console.log(`[kalshi-exec] ${id} no hedged fill (yes=${filledYes} no=${filledNo})`);
  }
}

async function unwind(
  ref: string,
  contracts: number,
  label: string,
  pairId: string,
): Promise<void> {
  try {
    const book = await getOrderBook(ref);
    const bestBid = book.bids[0]?.price ?? 0;
    const sellPrice = Math.max(0.01, bestBid - UNWIND_SLIP);
    console.warn(
      `[kalshi-exec] unwinding naked ${label} ${contracts} @ ~${sellPrice.toFixed(4)} (pair ${pairId})`,
    );
    await placeSell(ref, sellPrice, contracts);
    logActivity("kalshi_unwind", { pairId, side: label, contracts, sellPrice }, "warn");
  } catch (err) {
    console.error(
      `[kalshi-exec] unwind ${label} failed (pair ${pairId}):`,
      (err as Error).message,
    );
    logActivity(
      "kalshi_unwind_failed",
      { pairId, side: label, message: (err as Error).message },
      "error",
    );
  }
}
