/**
 * executor.ts — places limit buy on the winning token during resolution lag.
 */

import { placeLimitOrder } from "./clob.js";
import { addPosition, type LagPosition } from "./inventory.js";
import type { ResolutionOpportunity } from "./oracle.js";
import { config } from "./config.js";

function makeId(): string {
  return `lag-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export async function enterPosition(
  opp: ResolutionOpportunity,
): Promise<void> {
  const sizeShares =
    opp.currentAsk > 0 ? config.maxPositionUsd / opp.currentAsk : 0;
  if (sizeShares < 0.01) return;

  const id = makeId();
  console.log(
    `[executor] Entering resolution-lag ${id} — ` +
      `market: ${opp.market.question} | ` +
      `ask=${opp.currentAsk.toFixed(4)} yield=${(opp.expectedYield * 100).toFixed(2)}%`,
  );

  let orderId: string;
  try {
    const result = await placeLimitOrder(
      opp.winningTokenId,
      "BUY",
      opp.currentAsk,
      sizeShares,
    );
    orderId = result.orderId;
  } catch (err) {
    console.error(
      `[executor] Order failed for ${id}:`,
      (err as Error).message,
    );
    return;
  }

  const pos: LagPosition = {
    id,
    marketId: opp.market.id,
    marketQuestion: opp.market.question,
    tokenId: opp.winningTokenId,
    boughtAt: opp.currentAsk,
    size: sizeShares,
    costBasis: opp.currentAsk * sizeShares,
    expectedYield: opp.expectedYield,
    orderId,
    status: "open",
    openedAt: new Date().toISOString(),
  };
  addPosition(pos);
}
