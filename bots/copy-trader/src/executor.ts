/**
 * executor.ts — executes an approved copy-trade by placing a limit order
 * at the current best available price.
 */

import {
  getBestAsk,
  getBestBid,
  getCollateralBalance,
  placeMarketableOrder,
} from "./clob.js";
import { params } from "./runtime-config.js";
import { getPosition, recordFill } from "./inventory.js";
import { markExecuted, markFailed, type PendingTrade } from "./pending.js";
import { logActivity } from "./activity.js";
import { config } from "./config.js";

function recordAttribution(trade: PendingTrade): void {
  const userAddress = process.env["USER_METAMASK_ADDRESS"] ?? "";
  if (!userAddress) return;
  fetch(`${config.orchestratorUrl}/positions/attribute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userAddress,
      conditionId: "",
      outcomeIndex: 0,
      tokenId: trade.tokenId,
      botName: "copy-trader",
      marketQuestion: trade.marketTitle,
      side: trade.side,
    }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
}

/**
 * Execute an approved trade.
 *  - Fetches current best price
 *  - Places a limit order (or simulates in paper mode)
 *  - Updates inventory and pending entry status
 */
export async function executeTrade(trade: PendingTrade): Promise<void> {
  const { id, tokenId, side, ourTargetShares, traderLabel } = trade;

  try {
    let targetShares = ourTargetShares;
    if (side === "SELL") {
      const held = getPosition(tokenId)?.netSize ?? 0;
      targetShares = Math.min(targetShares, held);
      if (targetShares < 0.01) {
        markFailed(id, "Insufficient local inventory for SELL signal");
        logActivity("trade_skipped", { id, reason: "insufficient_inventory" }, "warn");
        return;
      }
    }

    // Get live price at execution time
    let price: number;
    if (side === "BUY") {
      price = await getBestAsk(tokenId);
    } else {
      price = await getBestBid(tokenId);
    }

    // Guard against degenerate prices
    if (price <= 0 || price >= 1) {
      price = trade.suggestedPrice;
    }

    const reference = trade.suggestedPrice > 0 ? trade.suggestedPrice : price;
    const drift = Math.abs(price - reference) / reference;
    if (drift > params.maxSignalDriftPct) {
      markFailed(id, `Execution drift too high (${(drift * 100).toFixed(2)}%)`);
      logActivity("trade_skipped", { id, reason: "price_drift", driftPct: drift * 100 }, "warn");
      return;
    }

    // Don't hammer the CLOB with BUYs we can't fund. The probe returns 0 when
    // unavailable, so only gate on a positive-but-insufficient balance.
    if (side === "BUY") {
      const cost = targetShares * price;
      const collateral = await getCollateralBalance();
      if (collateral > 0 && collateral < cost) {
        markFailed(
          id,
          `Insufficient balance ($${collateral.toFixed(2)} available < $${cost.toFixed(2)} needed)`,
        );
        logActivity(
          "trade_failed",
          { id, reason: "insufficient_balance", collateral, cost },
          "warn",
        );
        return;
      }
    }

    // Marketable FAK: fills whatever liquidity is available right now and
    // reports the REAL matched amounts — no resting orders, no phantom fills.
    const { orderId, filledShares, filledUsdc } = await placeMarketableOrder(
      tokenId,
      side,
      targetShares,
      price,
    );

    if (filledShares < 0.01) {
      markFailed(id, "Order killed with no fill (no marketable liquidity / funds)");
      logActivity(
        "trade_failed",
        { id, reason: "zero_fill", requested: targetShares },
        "warn",
      );
      return;
    }

    const avgPrice = filledUsdc / filledShares;
    markExecuted(id, orderId, avgPrice, filledShares);
    recordFill(tokenId, traderLabel, side, avgPrice, filledShares);
    if (side === "BUY") recordAttribution(trade);

    console.log(
      `[executor] ✓ ${side} ${filledShares.toFixed(2)}/${targetShares.toFixed(2)} shares @ ${avgPrice.toFixed(4)} (copy: ${traderLabel}) orderId=${orderId}`,
    );
    logActivity("trade_executed", {
      id,
      side,
      shares: filledShares,
      requested: targetShares,
      price: avgPrice,
      trader: traderLabel,
    });
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    console.error(`[executor] ✗ Failed trade ${id}: ${msg}`);
    logActivity("trade_failed", { id, message: msg }, "error");
    markFailed(id, msg);
  }
}
