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
  getLastTradeMid,
  getOpenOrders,
} from "./clob.js";
import { getSkew, recordFill, getPosition } from "./inventory.js";

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

    // Prefer Gamma API prices (already fetched at market discovery, no extra
    // API call). Fall back to CLOB order book only if Gamma prices are missing.
    const gammaBid = market.gammaBestBid;
    const gammaAsk = market.gammaBestAsk;
    const gammaSpread = gammaAsk - gammaBid;

    if (gammaBid > 0 && gammaAsk < 1 && gammaSpread <= MAX_USABLE_SPREAD) {
      mid = (gammaBid + gammaAsk) / 2;
      spread = gammaSpread;
    } else {
      // Gamma prices stale/missing — query CLOB order book
      const book = await getOrderBook(yesTokenId);
      const clobBid = book.bids[0]?.price ?? 0;
      const clobAsk = book.asks[0]?.price ?? 1;
      if (clobBid <= 0 || clobAsk <= 0 || clobAsk <= clobBid) return;
      spread = clobAsk - clobBid;

      if (spread > MAX_USABLE_SPREAD) {
        // CLOB also sparse — last resort: last trade price
        const lastMid = await getLastTradeMid(yesTokenId);
        if (lastMid <= 0) {
          console.warn(
            `[quoter] No usable price for ${market.question.slice(0, 40)}, skipping`,
          );
          return;
        }
        mid = lastMid;
      } else {
        mid = (clobBid + clobAsk) / 2;
      }
    }
  }

  // Fixed half-width from config (e.g. 0.03 = 3 cents each side)
  const halfWidth = params.quoteHalfWidth;

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

    const hasAnyLiveOrder = Boolean(existing.ourBidId || existing.ourAskId);

    if (
      hasAnyLiveOrder &&
      !midMoved &&
      !bidStale &&
      !askStale &&
      !inventorySkewed
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
      }
      await cancelOrder(existing.ourAskId);
    }
  }

  // Compute quote prices
  const { yesRatio } = getSkew(yesTokenId, equityPerMarket);
  const skewFactor = 1 - Math.max(0, yesRatio - 0.5) * 2;

  const MIN_ORDER_SIZE = 5; // Polymarket minimum shares per order
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

  // Only SELL if we own the inventory (in-memory tracked fills)
  const heldYes = getPosition(yesTokenId).netSize;
  const askSize = parseFloat(
    Math.max(MIN_ORDER_SIZE, equityPerMarket / 2 / mid).toFixed(2),
  );
  const canSell = heldYes >= MIN_ORDER_SIZE;

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
      : Promise.resolve(null),
  ]);

  const openPositions = (bidResult ? 1 : 0) + (askResult ? 1 : 0);
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

export async function runQuotingCycle(allocatedEquity: number): Promise<void> {
  const markets = await getActiveMarkets();
  if (markets.length === 0) {
    console.warn("[quoter] No active markets available");
    return;
  }

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
}
