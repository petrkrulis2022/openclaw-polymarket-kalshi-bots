/**
 * executor.ts — places limit buy on the winning token during resolution lag.
 */

import { placeLimitOrder } from "./clob.js";
import { addPosition, type LagPosition } from "./inventory.js";
import { logActivity } from "./activity.js";
import type { ResolutionOpportunity } from "./oracle.js";
import { config } from "./config.js";

function recordAttribution(opp: ResolutionOpportunity): void {
  const userAddress = process.env["USER_METAMASK_ADDRESS"] ?? "";
  if (!userAddress) return;
  fetch(`${config.orchestratorUrl}/positions/attribute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userAddress,
      conditionId: opp.market.conditionId,
      outcomeIndex: 0,
      tokenId: opp.winningTokenId,
      botName: "resolution-lag",
      marketQuestion: opp.market.question,
      side: opp.market.gammaOutcome ?? "YES",
    }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
}

function makeId(): string {
  return `lag-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export async function enterPosition(opp: ResolutionOpportunity): Promise<void> {
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
    console.error(`[executor] Order failed for ${id}:`, (err as Error).message);
    logActivity(
      "order_failed",
      { positionId: id, market: opp.market.question, message: (err as Error).message },
      "error",
    );
    return;
  }

  const pos: LagPosition = {
    id,
    marketId: opp.market.id,
    conditionId: opp.market.conditionId,
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
  logActivity("position_entered", {
    positionId: id,
    market: opp.market.question,
    ask: opp.currentAsk,
    sizeShares,
  });
  recordAttribution(opp);

  // Log fill to measurement layer (fire-and-forget)
  fetch(`${config.orchestratorUrl}/fills`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ts: pos.openedAt,
      botId: "resolution-lag",
      side: "BUY",
      tokenId: opp.winningTokenId,
      signalPrice: opp.currentAsk,
      fillPrice: opp.currentAsk,
      fillShares: sizeShares,
      fillUsdc: pos.costBasis,
      fillStatus: "filled",
      meta: { marketId: opp.market.id, question: opp.market.question, expectedYield: opp.expectedYield },
    }),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {});
}
