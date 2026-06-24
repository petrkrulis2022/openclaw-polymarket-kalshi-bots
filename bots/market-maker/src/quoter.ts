import { config } from "./config.js";
import { params } from "./runtime-config.js";
import { getActiveMarkets, type GammaMarket } from "./markets.js";
import {
  getOrderBook,
  placeLimitOrder,
  cancelOrder,
  getOpenOrders,
} from "./venue/index.js";
import {
  getNetSkew,
  recordFill,
  recordMerge,
  getPosition,
} from "./inventory.js";
import { registerOrder } from "./fills.js";
import { mergeYesNo } from "./merge.js";
import { recordAttribution } from "./attribution.js";
import { logActivity } from "./activity.js";

const clamp = (p: number): number => Math.max(0.01, Math.min(0.99, p));

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

    const netSkew = getNetSkew(yesTokenId, noTokenId, equityPerMarket);
    const inventorySkewed = Math.abs(netSkew) > params.maxInventorySkew;

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
        recordAttribution(
          market.conditionId,
          yesTokenId,
          0,
          "YES",
          market.question,
        );
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

  // Compute quote prices. bidPrice/askPrice are YES-equivalent prices straddling
  // mid; the actual order on each side may be on the YES or NO token depending
  // on what inventory we're recycling, but stays at the same book level.
  const MIN_ORDER_SIZE = Math.max(
    5, // Polymarket minimum shares per order
    inRewardsBand ? market.rewardsMinSize : 0,
  );
  const bidPrice = clamp(mid - halfWidth);
  const askPrice = clamp(mid + halfWidth);
  if (bidPrice >= askPrice) return;

  const targetShares = equityPerMarket / 2 / mid;

  // Throttle the side that would deepen an existing imbalance: when already net
  // long YES, buy less YES; when net long NO, buy less NO.
  const netSkew = getNetSkew(yesTokenId, noTokenId, equityPerMarket);
  const buyYesFactor = Math.max(0, 1 - Math.max(0, netSkew) * 2);
  const buyNoFactor = Math.max(0, 1 - Math.max(0, -netSkew) * 2);

  const heldYes = getPosition(yesTokenId).netSize;
  const heldNo = getPosition(noTokenId).netSize;

  interface PlannedOrder {
    tokenId: string;
    side: "BUY" | "SELL";
    price: number;
    size: number;
  }

  // ── Low side (the bid level) ──────────────────────────────────────────────
  // SELL NO @ (1−bidPrice) is economically a BUY YES @ bidPrice. When we hold
  // NO, posting it as a NO sell recycles that inventory instead of growing YES;
  // otherwise we buy YES with USDC.
  let bidOrder: PlannedOrder | null = null;
  if (!config.paperTrading && heldNo >= MIN_ORDER_SIZE) {
    bidOrder = {
      tokenId: noTokenId,
      side: "SELL",
      price: clamp(1 - bidPrice),
      size: parseFloat(Math.min(heldNo, Math.max(MIN_ORDER_SIZE, targetShares)).toFixed(2)),
    };
  } else {
    const maxAffordableShares = (freeCollateralUsd * 0.95) / bidPrice;
    const rawBuySize = Math.min(targetShares, maxAffordableShares) * buyYesFactor;
    const size = parseFloat(Math.max(MIN_ORDER_SIZE, rawBuySize).toFixed(2));
    if (maxAffordableShares >= MIN_ORDER_SIZE && size >= MIN_ORDER_SIZE) {
      bidOrder = { tokenId: yesTokenId, side: "BUY", price: bidPrice, size };
    }
  }

  // ── High side (the ask level) ─────────────────────────────────────────────
  // SELL YES @ askPrice recycles held YES; otherwise BUY NO @ (1−askPrice),
  // which is economically a SELL YES @ askPrice funded by USDC, so we can quote
  // both sides from day one. Rewards require a two-sided quote to score.
  let askOrder: PlannedOrder | null = null;
  if (heldYes >= MIN_ORDER_SIZE) {
    askOrder = {
      tokenId: yesTokenId,
      side: "SELL",
      price: askPrice,
      size: parseFloat(Math.min(heldYes, Math.max(MIN_ORDER_SIZE, targetShares)).toFixed(2)),
    };
  } else if (!config.paperTrading) {
    const noBidPrice = clamp(1 - askPrice);
    const maxAffordableShares = (freeCollateralUsd * 0.95) / noBidPrice;
    const size = parseFloat(Math.max(MIN_ORDER_SIZE, targetShares * buyNoFactor).toFixed(2));
    if (maxAffordableShares >= MIN_ORDER_SIZE && size >= MIN_ORDER_SIZE) {
      askOrder = { tokenId: noTokenId, side: "BUY", price: noBidPrice, size };
    }
  }

  // In rewards markets, a one-sided quote earns nothing and we can't afford the
  // minimum — bail rather than rest a non-scoring order.
  if (inRewardsBand && !bidOrder && !askOrder) {
    logActivity(
      "quote_skipped",
      {
        reason: "rewards_min_size_unaffordable",
        market: market.question.slice(0, 60),
        minSize: MIN_ORDER_SIZE,
      },
      "warn",
    );
    return;
  }

  const [bidResult, askResult] = await Promise.all([
    bidOrder
      ? placeLimitOrder(bidOrder.tokenId, bidOrder.side, bidOrder.price, bidOrder.size, market.question)
      : Promise.resolve(null),
    askOrder
      ? placeLimitOrder(askOrder.tokenId, askOrder.side, askOrder.price, askOrder.size, market.question)
      : Promise.resolve(null),
  ]);

  // Track our order IDs so the fill poller can attribute their fills to us.
  if (bidResult && !bidResult.paper && bidOrder) {
    registerOrder(bidResult.orderId, {
      tokenId: bidOrder.tokenId,
      conditionId: market.conditionId,
      question: market.question,
      yesTokenId,
      noTokenId,
    });
  }
  if (askResult && !askResult.paper && askOrder) {
    registerOrder(askResult.orderId, {
      tokenId: askOrder.tokenId,
      conditionId: market.conditionId,
      question: market.question,
      yesTokenId,
      noTokenId,
    });
  }

  const openPositions = (bidResult ? 1 : 0) + (askResult ? 1 : 0);
  if (bidResult || askResult) {
    logActivity("quotes_posted", {
      market: market.question.slice(0, 60),
      bid: bidResult ? bidPrice : null,
      ask: askResult ? askPrice : null,
    });
  }

  states.set(market.conditionId, {
    market,
    yesTokenId,
    noTokenId,
    mid,
    spread,
    ourBidId: bidResult?.orderId ?? null,
    ourBidPrice: bidPrice,
    ourBidRemainingSize: bidResult && bidOrder ? bidOrder.size : 0,
    ourAskId: askResult?.orderId ?? null,
    ourAskPrice: askPrice,
    ourAskRemainingSize: askResult && askOrder ? askOrder.size : 0,
    openPositions,
  });
}

/**
 * Merge matched YES+NO pairs back into USDC. Each merged pair returns $1,
 * realizing the spread we captured by acquiring both legs below $1 and freeing
 * the collateral immediately. EOA-only — see config.canMergeOnchain.
 */
const mergeInFlight = new Set<string>();

async function mergeMatchedPairs(): Promise<void> {
  if (!config.canMergeOnchain) return;

  for (const [conditionId, st] of states.entries()) {
    if (mergeInFlight.has(conditionId)) continue;
    const heldYes = getPosition(st.yesTokenId).netSize;
    const heldNo = getPosition(st.noTokenId).netSize;
    const amount = Math.min(heldYes, heldNo);
    if (amount < 1) continue; // not worth the gas below ~1 share

    mergeInFlight.add(conditionId);
    logActivity("merge_attempted", {
      conditionId,
      amount,
      market: st.market.question.slice(0, 60),
    });
    mergeYesNo(conditionId, amount)
      .then((txHash) => {
        const merged = recordMerge(st.yesTokenId, st.noTokenId, amount);
        console.log(
          `[quoter] Merged ${merged.toFixed(2)} pair(s) → USDC tx=${txHash} | ${st.market.question.slice(0, 40)}`,
        );
        logActivity("merge_complete", { conditionId, merged, txHash });
      })
      .catch((err: Error) => {
        console.error("[quoter] mergeYesNo failed:", err.message);
        logActivity("merge_failed", { conditionId, message: err.message }, "error");
      })
      .finally(() => mergeInFlight.delete(conditionId));
  }
}

/**
 * Unwind any markets that have left the active list while we still hold inventory.
 * Cancels open orders then posts a sell at best available bid (or 1¢ floor).
 * This prevents stranded inventory when markets resolve, rotate off, or go extreme.
 */
async function unwindRemovedMarkets(activeConditionIds: Set<string>): Promise<void> {
  for (const [conditionId, st] of states.entries()) {
    if (activeConditionIds.has(conditionId)) continue;

    let heldYes = getPosition(st.yesTokenId).netSize;
    let heldNo = getPosition(st.noTokenId).netSize;
    const hasOrders = Boolean(st.ourBidId || st.ourAskId);
    if (!heldYes && !heldNo && !hasOrders) {
      states.delete(conditionId);
      continue;
    }

    console.warn(
      `[quoter] Market removed from active list — unwinding: ${st.market.question.slice(0, 50)} ` +
        `(yes=${heldYes.toFixed(2)} no=${heldNo.toFixed(2)} shares)`,
    );

    if (st.ourBidId) await cancelOrder(st.ourBidId).catch(() => {});
    if (st.ourAskId) await cancelOrder(st.ourAskId).catch(() => {});

    // Collapse any matched pair into USDC first (EOA mode); the rest is sold off.
    if (config.canMergeOnchain) {
      const amount = Math.min(heldYes, heldNo);
      if (amount >= 1) {
        try {
          const txHash = await mergeYesNo(conditionId, amount);
          const merged = recordMerge(st.yesTokenId, st.noTokenId, amount);
          console.warn(`[quoter] Unwind merge: ${merged.toFixed(2)} pair(s) tx=${txHash}`);
          logActivity("market_unwound", { conditionId, merged, via: "merge" }, "warn");
          heldYes = getPosition(st.yesTokenId).netSize;
          heldNo = getPosition(st.noTokenId).netSize;
        } catch (err) {
          console.error("[quoter] Unwind merge failed:", (err as Error).message);
        }
      }
    }

    // Sell each remaining leg at its best bid (1¢ floor) — accept a loss rather
    // than hold to resolution.
    for (const leg of [
      { tokenId: st.yesTokenId, held: heldYes, label: "YES" },
      { tokenId: st.noTokenId, held: heldNo, label: "NO" },
    ]) {
      if (leg.held < 1) continue;
      try {
        const book = await getOrderBook(leg.tokenId);
        const sellPrice = Math.max(0.01, book.bids[0]?.price ?? 0);
        const sell = await placeLimitOrder(
          leg.tokenId,
          "SELL",
          sellPrice,
          leg.held,
          st.market.question,
        );
        // Let the fill poller book the actual fill (the limit may rest unfilled).
        if (!sell.paper) {
          registerOrder(sell.orderId, {
            tokenId: leg.tokenId,
            conditionId,
            question: st.market.question,
            yesTokenId: st.yesTokenId,
            noTokenId: st.noTokenId,
          });
        }
        console.warn(
          `[quoter] Unwind SELL ${leg.label}: ${leg.held.toFixed(2)} shares @ ${sellPrice.toFixed(4)}`,
        );
        logActivity(
          "market_unwound",
          { conditionId, leg: leg.label, shares: leg.held, sellPrice, via: "sell" },
          "warn",
        );
      } catch (err) {
        console.error("[quoter] Unwind sell failed:", (err as Error).message);
        logActivity(
          "unwind_failed",
          { conditionId, leg: leg.label, message: (err as Error).message },
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

  // Recycle any matched YES+NO pairs the latest fills produced back into USDC.
  await mergeMatchedPairs();

  logActivity("quote_cycle_complete", { markets: markets.length });
}
