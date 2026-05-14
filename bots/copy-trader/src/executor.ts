/**
 * executor.ts — executes an approved copy-trade by placing a limit order
 * at the current best available price.
 */

import { getBestAsk, getBestBid, placeLimitOrder } from "./clob.js";
import { params } from "./runtime-config.js";
import { getPosition } from "./inventory.js";
import { markExecuted, markFailed, type PendingTrade } from "./pending.js";

/**
 * Execute an approved trade.
 *  - Fetches current best price
 *  - Places a limit order (or simulates in paper mode)
 *  - Updates inventory and pending entry status
 */
export async function executeTrade(trade: PendingTrade): Promise<void> {
  const { id, tokenId, side, ourTargetShares, marketTitle, traderLabel } =
    trade;

  try {
    let targetShares = ourTargetShares;
    if (side === "SELL") {
      const held = getPosition(tokenId)?.netSize ?? 0;
      targetShares = Math.min(targetShares, held);
      if (targetShares < 0.01) {
        markFailed(id, "Insufficient local inventory for SELL signal");
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
      return;
    }

    const { orderId } = await placeLimitOrder(
      tokenId,
      side,
      price,
      targetShares,
      `[COPY:${traderLabel}] ${marketTitle}`,
    );

    markExecuted(id, orderId, price, targetShares);

    console.log(
      `[executor] ✓ ${side} ${targetShares.toFixed(2)} shares @ ${price.toFixed(4)} (copy: ${traderLabel}) orderId=${orderId}`,
    );
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    console.error(`[executor] ✗ Failed trade ${id}: ${msg}`);
    markFailed(id, msg);
  }
}
