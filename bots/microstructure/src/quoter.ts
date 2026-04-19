/**
 * quoter.ts — posts resting bids on screened low-price markets.
 * On fill, immediately posts an ask at 2× the bid price.
 * Cancels all quotes near expiry.
 */

import {
  getBestBid,
  getBestAsk,
  placeLimitOrder,
  cancelOrder,
} from "./clob.js";
import { getPosition, upsertPosition } from "./inventory.js";
import type { ScreenedMarket } from "./screener.js";
import { config } from "./config.js";

/**
 * Refresh the quote for a single market:
 * 1. If near expiry → cancel everything
 * 2. If we have held shares and no ask → post ask at 2× entry
 * 3. If no bid placed → post bid at min(bestBid, maxAskPrice/3)
 * 4. If bid is stale (price moved) → cancel and repost
 */
export async function refreshQuote(market: ScreenedMarket): Promise<void> {
  const pos = getPosition(market.id);

  // Cancel near expiry
  if (market.daysToExpiry <= config.cancelDaysBeforeExpiry) {
    if (pos?.bidOrderId) {
      await cancelOrder(pos.bidOrderId);
      upsertPosition(market.id, { marketId: market.id, bidOrderId: null });
    }
    if (pos?.askOrderId) {
      await cancelOrder(pos.askOrderId);
      upsertPosition(market.id, { marketId: market.id, askOrderId: null });
    }
    return;
  }

  // If we hold shares and don't have an ask up, post one
  if (pos && pos.heldShares > 0.001 && !pos.askOrderId) {
    const avgEntry =
      pos.heldShares > 0 ? pos.totalCost / pos.heldShares : pos.bidPrice;
    const askPrice = Math.min(0.99, avgEntry * 2);
    try {
      const result = await placeLimitOrder(
        market.yesTokenId,
        "SELL",
        askPrice,
        pos.heldShares,
      );
      upsertPosition(market.id, {
        marketId: market.id,
        askOrderId: result.orderId,
        askPrice,
      });
      console.log(
        `[quoter] Ask posted ${market.id.slice(0, 8)} ask=${askPrice.toFixed(4)} size=${pos.heldShares.toFixed(2)}`,
      );
    } catch (err) {
      console.warn("[quoter] ask error:", (err as Error).message);
    }
    return;
  }

  // Don't post a new bid if we already have one open
  if (pos?.bidOrderId) return;

  // Check live ask — skip if above threshold (market moved up)
  const liveAsk = await getBestAsk(market.yesTokenId);
  if (liveAsk > config.maxAskPrice) return;

  const bestBid = await getBestBid(market.yesTokenId);
  // Bid at the current best-bid or at 1/3 of max ask price, whichever is lower
  const bidPrice = Math.max(0.001, Math.min(bestBid, config.maxAskPrice / 3));
  const bidSize = config.maxUsdPerMarket / bidPrice;

  try {
    const result = await placeLimitOrder(
      market.yesTokenId,
      "BUY",
      bidPrice,
      bidSize,
    );
    upsertPosition(market.id, {
      marketId: market.id,
      marketQuestion: market.question,
      yesTokenId: market.yesTokenId,
      endDate: market.endDate,
      daysToExpiry: market.daysToExpiry,
      bidOrderId: result.orderId,
      bidPrice,
    });
    console.log(
      `[quoter] Bid posted ${market.id.slice(0, 8)} bid=${bidPrice.toFixed(4)} size=${bidSize.toFixed(2)}`,
    );
  } catch (err) {
    console.warn("[quoter] bid error:", (err as Error).message);
  }
}
