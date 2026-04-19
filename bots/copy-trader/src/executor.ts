/**
 * executor.ts — executes an approved copy-trade by placing a limit order
 * at the current best available price.
 */

import { getBestAsk, getBestBid, placeLimitOrder } from "./clob.js";
import { recordFill } from "./inventory.js";
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

    const { orderId } = await placeLimitOrder(
      tokenId,
      side,
      price,
      ourTargetShares,
      `[COPY:${traderLabel}] ${marketTitle}`,
    );

    recordFill(tokenId, traderLabel, side, price, ourTargetShares);
    markExecuted(id, orderId, price, ourTargetShares);

    console.log(
      `[executor] ✓ ${side} ${ourTargetShares.toFixed(2)} shares @ ${price.toFixed(4)} (copy: ${traderLabel}) orderId=${orderId}`,
    );
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    console.error(`[executor] ✗ Failed trade ${id}: ${msg}`);
    markFailed(id, msg);
  }
}
