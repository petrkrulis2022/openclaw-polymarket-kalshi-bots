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
  type OpenOrder,
} from "./clob.js";
import {
  getPosition,
  recordFill,
  recordSell,
  upsertPosition,
} from "./inventory.js";
import type { ScreenedMarket } from "./screener.js";
import { config } from "./config.js";

function recordAttribution(market: ScreenedMarket): void {
  const userAddress = process.env["USER_METAMASK_ADDRESS"] ?? "";
  if (!userAddress) return;
  fetch(`${config.orchestratorUrl}/positions/attribute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userAddress,
      conditionId: "",
      outcomeIndex: 0,
      tokenId: market.tokenId ?? market.id,
      botName: "microstructure",
      marketQuestion: market.question,
      side: market.outcome,
    }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
}

type TradeFill = {
  side: "BUY" | "SELL";
  size: number;
  price: number;
};

/**
 * Refresh the quote for a single market:
 * 1. If near expiry → cancel everything
 * 2. If we have held shares and no ask → post ask at 2× entry
 * 3. If no bid placed → post bid at min(bestBid, maxAskPrice/3)
 * 4. If bid is stale (price moved) → cancel and repost
 */
export async function refreshQuote(
  market: ScreenedMarket,
  openOrdersById?: Map<string, OpenOrder>,
  fillsByOrderId?: Map<string, TradeFill>,
): Promise<void> {
  const pos = getPosition(market.id);

  // Reconcile local order state vs exchange state before making decisions.
  if (pos?.bidOrderId) {
    const bidOrder = openOrdersById?.get(pos.bidOrderId);
    const isBidOpen = Boolean(bidOrder);
    const fill = fillsByOrderId?.get(pos.bidOrderId);

    if (fill && fill.side === "BUY" && fill.size > 0) {
      recordFill(
        market.id,
        fill.price > 0 ? fill.price : pos.bidPrice,
        fill.size,
        { clearBidOrderId: !isBidOpen },
      );
      recordAttribution(market);
      console.log(
        `[quoter] Reconciled bid fill ${market.id.slice(0, 8)} @ ${(fill.price > 0 ? fill.price : pos.bidPrice).toFixed(4)} size=${fill.size.toFixed(2)}`,
      );
    } else if (openOrdersById && !isBidOpen) {
      upsertPosition(market.id, {
        marketId: market.id,
        bidOrderId: null,
        bidOrderRemainingSize: 0,
      });
      console.log(
        `[quoter] Reconciled bid close ${market.id.slice(0, 8)} (no fill evidence)`,
      );
    }

    if (bidOrder) {
      const updated = getPosition(market.id);
      if (
        updated &&
        Math.abs(updated.bidOrderRemainingSize - bidOrder.remainingSize) > 1e-6
      ) {
        upsertPosition(market.id, {
          marketId: market.id,
          bidOrderRemainingSize: bidOrder.remainingSize,
        });
      }
    }
  }

  const refreshedPos = getPosition(market.id);
  if (refreshedPos?.askOrderId) {
    const askOrder = openOrdersById?.get(refreshedPos.askOrderId);
    const isAskOpen = Boolean(askOrder);
    const fill = fillsByOrderId?.get(refreshedPos.askOrderId);
    if (
      fill &&
      fill.side === "SELL" &&
      fill.size > 0 &&
      refreshedPos.heldShares > 0
    ) {
      const sellSize = Math.min(fill.size, refreshedPos.heldShares);
      recordSell(
        market.id,
        fill.price > 0 ? fill.price : refreshedPos.askPrice,
        sellSize,
        { clearAskOrderId: !isAskOpen },
      );
      console.log(
        `[quoter] Reconciled ask fill ${market.id.slice(0, 8)} @ ${(fill.price > 0 ? fill.price : refreshedPos.askPrice).toFixed(4)} size=${sellSize.toFixed(2)}`,
      );
    } else if (openOrdersById && !isAskOpen) {
      upsertPosition(market.id, {
        marketId: market.id,
        askOrderId: null,
        askOrderRemainingSize: 0,
      });
      console.log(
        `[quoter] Reconciled ask close ${market.id.slice(0, 8)} (no fill evidence)`,
      );
    }

    if (askOrder) {
      const updated = getPosition(market.id);
      if (
        updated &&
        Math.abs(updated.askOrderRemainingSize - askOrder.remainingSize) > 1e-6
      ) {
        upsertPosition(market.id, {
          marketId: market.id,
          askOrderRemainingSize: askOrder.remainingSize,
        });
      }
    }
  }

  const currentPos = getPosition(market.id);

  // Cancel near expiry
  if (market.daysToExpiry <= config.cancelDaysBeforeExpiry) {
    if (currentPos?.bidOrderId) {
      await cancelOrder(currentPos.bidOrderId);
      upsertPosition(market.id, {
        marketId: market.id,
        bidOrderId: null,
        bidOrderRemainingSize: 0,
      });
    }
    if (currentPos?.askOrderId) {
      await cancelOrder(currentPos.askOrderId);
      upsertPosition(market.id, {
        marketId: market.id,
        askOrderId: null,
        askOrderRemainingSize: 0,
      });
    }
    return;
  }

  // If we hold shares and don't have an ask up, post one
  if (currentPos && currentPos.heldShares > 0.001 && !currentPos.askOrderId) {
    const avgEntry =
      currentPos.heldShares > 0
        ? currentPos.totalCost / currentPos.heldShares
        : currentPos.bidPrice;
    const askPrice = Math.min(0.99, avgEntry * 2);
    try {
      const result = await placeLimitOrder(
        market.tokenId,
        "SELL",
        askPrice,
        currentPos.heldShares,
      );
      upsertPosition(market.id, {
        marketId: market.id,
        askOrderId: result.orderId,
        askPrice,
        askOrderRemainingSize: currentPos.heldShares,
      });
      console.log(
        `[quoter] Ask posted ${market.id.slice(0, 8)} ask=${askPrice.toFixed(4)} size=${currentPos.heldShares.toFixed(2)}`,
      );
    } catch (err) {
      console.warn("[quoter] ask error:", (err as Error).message);
    }
    return;
  }

  // Don't post a new bid if we already have one open
  if (currentPos?.bidOrderId) return;

  // Check live ask — skip if above threshold (market moved up)
  const liveAsk = await getBestAsk(market.tokenId);
  if (liveAsk > config.maxAskPrice) return;

  const bestBid = await getBestBid(market.tokenId);
  // Bid at the current best-bid or at 1/3 of max ask price, whichever is lower
  const bidPrice = Math.max(0.001, Math.min(bestBid, config.maxAskPrice / 3));
  const bidSize = config.maxUsdPerMarket / bidPrice;

  try {
    const result = await placeLimitOrder(
      market.tokenId,
      "BUY",
      bidPrice,
      bidSize,
    );
    upsertPosition(market.id, {
      marketId: market.id,
      marketQuestion: market.question,
      tokenId: market.tokenId,
      endDate: market.endDate,
      daysToExpiry: market.daysToExpiry,
      bidOrderId: result.orderId,
      bidPrice,
      bidOrderRemainingSize: bidSize,
    });
    console.log(
      `[quoter] Bid posted ${market.id.slice(0, 8)} bid=${bidPrice.toFixed(4)} size=${bidSize.toFixed(2)}`,
    );
  } catch (err) {
    console.warn("[quoter] bid error:", (err as Error).message);
  }
}
