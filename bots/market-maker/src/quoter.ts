import { config } from "./config.js";
import { params } from "./runtime-config.js";
import { getActiveMarkets, type GammaMarket } from "./markets.js";

function recordAttribution(market: GammaMarket, tokenId: string, side: string): void {
  const userAddress = process.env["USER_METAMASK_ADDRESS"] ?? "";
  if (!userAddress) return;
  fetch(`${config.orchestratorUrl}/positions/attribute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userAddress,
      conditionId: market.conditionId ?? "",
      outcomeIndex: side === "YES" ? 0 : 1,
      tokenId,
      botName: "market-maker",
      marketQuestion: market.question,
      side,
    }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
}
import {
  getOrderBook,
  placeLimitOrder,
  cancelOrder,
  getOpenOrders,
} from "./clob.js";
import { getSkew, recordFill, getPosition } from "./inventory.js";
import { logActivity } from "./activity.js";

export interface MarketState {
  market: GammaMarket;
  yesTokenId: string;
  noTokenId: string;
  mid: number;
  spread: number;
  ourBidId: string | null;
  ourBidPrice: number;
  ourBidRemainingSize: number;
  ourAskId: string | null;
  ourAskPrice: number;
  ourAskRemainingSize: number;
  openPositions: number;
}

const states = new Map<string, MarketState>();

// Paper-mode simulated mids: each market gets a random-walk price
const paperMids = new Map<string, number>();

function getSimulatedMid(conditionId: string): number {
  if (!paperMids.has(conditionId)) {
    // Start anywhere between 0.2–0.8 (avoiding extremes)
    paperMids.set(conditionId, 0.3 + Math.random() * 0.4);
  }
  const current = paperMids.get(conditionId)!;
  // Random walk: ±0–6% each cycle, bounded to [0.05, 0.95]
  const delta = (Math.random() - 0.5) * 0.12;
  const next = Math.max(0.05, Math.min(0.95, current + delta));
  paperMids.set(conditionId, next);
  return next;
}

export function getStates(): MarketState[] {
  return Array.from(states.values());
}

function syncStatesFromOpenOrders(
  openOrdersById: Map<
    string,
    {
      id: string;
      tokenId: string;
      side: string;
      price: number;
      size: number;
      remainingSize: number;
      originalSize: number;
    }
  >,
): void {
  for (const [conditionId, st] of states.entries()) {
    const bid = st.ourBidId ? openOrdersById.get(st.ourBidId) : undefined;
    const ask = st.ourAskId ? openOrdersById.get(st.ourAskId) : undefined;

    states.set(conditionId, {
      ...st,
      ourBidId: bid ? st.ourBidId : null,
      ourAskId: ask ? st.ourAskId : null,
      ourBidRemainingSize: bid?.remainingSize ?? 0,
      ourAskRemainingSize: ask?.remainingSize ?? 0,
      openPositions: (bid ? 1 : 0) + (ask ? 1 : 0),
    });
  }
}

export async function quoteMarket(
  market: GammaMarket,
  equityPerMarket: number,
  freeCollateralUsd: number,
): Promise<void> {
  const yesTokenId = market.yesTokenId;
  const noTokenId = market.noTokenId;
  if (!yesTokenId || !noTokenId) return;

  let mid: number;
  let spread: number;

  if (config.paperTrading) {
    // In paper mode: use a simulated random-walk mid, ignore the real book
    mid = getSimulatedMid(market.conditionId);
    spread = params.quoteHalfWidth * 2;
  } else {
    const MAX_USABLE_SPREAD = 0.3;

    // Always price off the live CLOB book. Gamma prices lag the book —
    // quoting off them is adverse-selection bait.
    const book = await getOrderBook(yesTokenId);
    const clobBid = book.bids[0]?.price ?? 0;
    const clobAsk = book.asks[0]?.price ?? 0;
    if (clobBid <= 0 || clobAsk <= 0 || clobAsk <= clobBid) {
      console.warn(
        `[quoter] One-sided/empty book for ${market.question.slice(0, 40)}, skipping`,
      );
      return;
    }
    spread = clobAsk - clobBid;
    if (spread > MAX_USABLE_SPREAD) {
      console.warn(
        `[quoter] Spread too wide (${spread.toFixed(3)}) for ${market.question.slice(0, 40)}, skipping`,
      );
      return;
    }
    mid = (clobBid + clobAsk) / 2;
  }

  // Half-width: inside the rewards band when the market pays rewards
  // (orders outside rewardsMaxSpread of mid earn nothing).
  const inRewardsBand =
    params.rewardsMode && !config.paperTrading && market.rewardsMaxSpread > 0;
  const halfWidth = inRewardsBand
    ? Math.min(params.quoteHalfWidth, 0.8 * market.rewardsMaxSpread)
    : params.quoteHalfWidth;

  const existing = states.get(market.conditionId);

  // Check if re-quote is needed
  if (existing) {
    const midMoved =
      Math.abs(mid - existing.mid) > params.reQuoteThreshold * existing.mid;
    const bidStale =
      existing.ourBidId &&
      Math.abs(existing.ourBidPrice - (mid - halfWidth)) / mid >
        params.orderStalenessThreshold;
    const askStale =
      existing.ourAskId &&
      Math.abs(existing.ourAskPrice - (mid + halfWidth)) / mid >
        params.orderStalenessThreshold;

    const { yesRatio } = getSkew(yesTokenId, equityPerMarket);
    const inventorySkewed =
      yesRatio > params.maxInventorySkew ||
      yesRatio < 1 - params.maxInventorySkew;

    // Rewards only accrue while quotes sit inside the band around mid —
    // re-quote as soon as a resting order drifts out of it.
    const bandExit =
      inRewardsBand &&
      ((existing.ourBidId &&
        Math.abs(mid - existing.ourBidPrice) > market.rewardsMaxSpread) ||
        (existing.ourAskId &&
          Math.abs(existing.ourAskPrice - mid) > market.rewardsMaxSpread));

    const hasAnyLiveOrder = Boolean(existing.ourBidId || existing.ourAskId);

    if (
      hasAnyLiveOrder &&
      !midMoved &&
      !bidStale &&
      !askStale &&
      !inventorySkewed &&
      !bandExit
    ) {
      return; // nothing to do
    }

    // Cancel stale orders — simulate fills if paper mid moved into our quotes
    if (existing.ourBidId) {
      if (
        config.paperTrading &&
        mid < existing.ourBidPrice &&
        Math.random() < 0.4
      ) {
        const fillSize = parseFloat(
          (equityPerMarket / 2 / existing.ourBidPrice).toFixed(2),
        );
        recordFill(yesTokenId, "BUY", existing.ourBidPrice, fillSize);
        recordAttribution(market, yesTokenId, "YES");
        console.log(
          `[paper-fill] BUY filled @ ${existing.ourBidPrice.toFixed(4)} size=${fillSize} | ${market.question.slice(0, 40)}`,
        );
        logActivity("paper_fill", {
          side: "BUY",
          price: existing.ourBidPrice,
          size: fillSize,
          market: market.question.slice(0, 60),
        });
      }
      await cancelOrder(existing.ourBidId);
    }
    if (existing.ourAskId) {
      if (
        config.paperTrading &&
        mid > existing.ourAskPrice &&
        Math.random() < 0.4
      ) {
        const fillSize = parseFloat(
          (equityPerMarket / 2 / existing.ourAskPrice).toFixed(2),
        );
        recordFill(yesTokenId, "SELL", existing.ourAskPrice, fillSize);
        console.log(
          `[paper-fill] SELL filled @ ${existing.ourAskPrice.toFixed(4)} size=${fillSize} | ${market.question.slice(0, 40)}`,
        );
        logActivity("paper_fill", {
          side: "SELL",
          price: existing.ourAskPrice,
          size: fillSize,
          market: market.question.slice(0, 60),
        });
      }
      await cancelOrder(existing.ourAskId);
    }
  }

  // Compute quote prices
  const { yesRatio } = getSkew(yesTokenId, equityPerMarket);
  const skewFactor = 1 - Math.max(0, yesRatio - 0.5) * 2;

  // Rewards require resting size ≥ rewardsMinSize to score at all
  const MIN_ORDER_SIZE = Math.max(
    5, // Polymarket minimum shares per order
    inRewardsBand ? market.rewardsMinSize : 0,
  );
  const bidPrice = Math.max(0.01, Math.min(0.99, mid - halfWidth));
  const askPrice = Math.max(0.01, Math.min(0.99, mid + halfWidth));

  if (bidPrice >= askPrice) return;

  // Affordability: can we fund the BUY with available equity?
  // Use free collateral for the threshold check (so MIN_ORDER_SIZE is achievable
  // even when per-market allocation is small), but size from per-market budget.
  const maxAffordableShares = (freeCollateralUsd * 0.95) / bidPrice;
  const canBuy = maxAffordableShares >= MIN_ORDER_SIZE;
  const rawBuySize = Math.min(equityPerMarket / 2 / mid, maxAffordableShares);
  const bidSize = canBuy
    ? parseFloat(Math.max(MIN_ORDER_SIZE, rawBuySize * skewFactor).toFixed(2))
    : 0;

  if (inRewardsBand && !canBuy) {
    logActivity("quote_skipped", {
      reason: "rewards_min_size_unaffordable",
      market: market.question.slice(0, 60),
      minSize: MIN_ORDER_SIZE,
    }, "warn");
    return;
  }

  const heldYes = getPosition(yesTokenId).netSize;
  const askSize = parseFloat(
    Math.max(MIN_ORDER_SIZE, equityPerMarket / 2 / mid).toFixed(2),
  );
  // Prefer SELLing held YES (recycles inventory); otherwise quote the ask
  // side as a BUY on the NO token at 1−askPrice — economically identical
  // (the binary book is unified) and funded by USDC, so we can quote
  // two-sided from day one. Rewards score requires both sides.
  const canSell = heldYes >= MIN_ORDER_SIZE;
  const noBidPrice = Math.max(0.01, Math.min(0.99, 1 - askPrice));
  const canQuoteNoBid =
    !config.paperTrading &&
    !canSell &&
    (freeCollateralUsd * 0.95) / noBidPrice >= MIN_ORDER_SIZE;
  const noBidSize = parseFloat(
    Math.max(MIN_ORDER_SIZE, (equityPerMarket / 2) / Math.max(0.01, noBidPrice)).toFixed(2),
  );

  const [bidResult, askResult] = await Promise.all([
    canBuy && bidSize >= MIN_ORDER_SIZE
      ? placeLimitOrder(yesTokenId, "BUY", bidPrice, bidSize, market.question)
      : Promise.resolve(null),
    canSell
      ? placeLimitOrder(
          yesTokenId,
          "SELL",
          askPrice,
          Math.min(askSize, heldYes),
          market.question,
        )
      : canQuoteNoBid
        ? placeLimitOrder(noTokenId, "BUY", noBidPrice, noBidSize, market.question)
        : Promise.resolve(null),
  ]);

  const openPositions = (bidResult ? 1 : 0) + (askResult ? 1 : 0);
  if (bidResult || askResult) {
    logActivity("quotes_posted", {
      market: market.question.slice(0, 60),
      bid: bidResult ? bidPrice : null,
      ask: askResult ? askPrice : null,
    });
  }
  if (bidResult) recordAttribution(market, yesTokenId, "YES");

  states.set(market.conditionId, {
    market,
    yesTokenId,
    noTokenId,
    mid,
    spread,
    ourBidId: bidResult?.orderId ?? null,
    ourBidPrice: bidPrice,
    ourBidRemainingSize: bidResult ? bidSize : 0,
    ourAskId: askResult?.orderId ?? null,
    ourAskPrice: askPrice,
    ourAskRemainingSize: askResult ? Math.min(askSize, heldYes) : 0,
    openPositions,
  });
}

/**
 * Unwind any markets that have left the active list while we still hold inventory.
 * Cancels open orders then posts a sell at best available bid (or 1¢ floor).
 * This prevents stranded inventory when markets resolve, rotate off, or go extreme.
 */
async function unwindRemovedMarkets(activeConditionIds: Set<string>): Promise<void> {
  for (const [conditionId, st] of states.entries()) {
    if (activeConditionIds.has(conditionId)) continue;

    const heldYes = getPosition(st.yesTokenId).netSize;
    const hasOrders = Boolean(st.ourBidId || st.ourAskId);
    if (!heldYes && !hasOrders) {
      states.delete(conditionId);
      continue;
    }

    console.warn(
      `[quoter] Market removed from active list — unwinding: ${st.market.question.slice(0, 50)} ` +
        `(held=${heldYes.toFixed(2)} shares)`,
    );

    if (st.ourBidId) await cancelOrder(st.ourBidId).catch(() => {});
    if (st.ourAskId) await cancelOrder(st.ourAskId).catch(() => {});

    if (heldYes >= 1) {
      try {
        const book = await getOrderBook(st.yesTokenId);
        const bestBid = book.bids[0]?.price ?? 0;
        // Sell at best bid or 1¢ floor — accept a loss rather than hold to zero
        const sellPrice = Math.max(0.01, bestBid);
        await placeLimitOrder(st.yesTokenId, "SELL", sellPrice, heldYes, st.market.question);
        console.warn(
          `[quoter] Unwind SELL posted: ${heldYes.toFixed(2)} shares @ ${sellPrice.toFixed(4)}`,
        );
        logActivity("market_unwound", {
          conditionId: st.market.conditionId,
          shares: heldYes,
          sellPrice,
        }, "warn");
      } catch (err) {
        console.error("[quoter] Unwind sell failed:", (err as Error).message);
        logActivity(
          "unwind_failed",
          { conditionId: st.market.conditionId, message: (err as Error).message },
          "error",
        );
      }
    }

    states.delete(conditionId);
  }
}

export async function runQuotingCycle(allocatedEquity: number): Promise<void> {
  const markets = await getActiveMarkets();
  if (markets.length === 0) {
    console.warn("[quoter] No active markets available");
    logActivity("quote_skipped", { reason: "no_active_markets" }, "warn");
    return;
  }

  // Unwind any markets that are no longer in the active list
  const activeConditionIds = new Set(markets.map((m) => m.conditionId));
  await unwindRemovedMarkets(activeConditionIds);

  let freeCollateralUsd = allocatedEquity;
  let openOrdersById = new Map<
    string,
    {
      id: string;
      tokenId: string;
      side: string;
      price: number;
      size: number;
      remainingSize: number;
      originalSize: number;
    }
  >();
  try {
    const openOrders = await getOpenOrders();
    openOrdersById = new Map(openOrders.map((o) => [o.id, o]));
    const reservedBuyUsd = openOrders
      .filter((o) => o.side === "BUY")
      .reduce((s, o) => s + o.price * o.size, 0);
    freeCollateralUsd = Math.max(0, allocatedEquity - reservedBuyUsd);
  } catch {
    // Keep fallback value
  }

  syncStatesFromOpenOrders(openOrdersById);

  const equityPerMarket = allocatedEquity / markets.length;

  await Promise.allSettled(
    markets.map((m) => quoteMarket(m, equityPerMarket, freeCollateralUsd)),
  );
  logActivity("quote_cycle_complete", { markets: markets.length });
}
