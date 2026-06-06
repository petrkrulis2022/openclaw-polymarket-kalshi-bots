/**
 * orderbook.ts — walks YES+NO ask depth to find profitable arb volume.
 *
 * KEY INSIGHT: never use top-of-book only. Walk full depth and accumulate
 * only volume where the running combined EFFECTIVE cost (price + taker fee)
 * is still below $1 guaranteed return.
 *
 * Taker fee formula: fee = feeRate × price × (1 − price) per share.
 * feeRate is per-market from Gamma API; see config.defaultFeeRate for fallback.
 */

import { getOrderBook } from "./clob.js";
import { config } from "./config.js";
import type { NegRiskGroup } from "./scanner.js";

export interface ArbSignal {
  type: "binary";
  yesTokenId: string;
  noTokenId: string;
  marketId: string;
  marketQuestion: string;
  profitableVolumeUsd: number;
  expectedProfitUsd: number;
  yesEntryPrice: number;
  noEntryPrice: number;
  /** Net profit per $1 guaranteed return, after fees. */
  netSpread: number;
  feeRate: number;
}

export interface NegRiskArbSignal {
  type: "neg_risk";
  negRiskMarketId: string;
  groupQuestion: string;
  legs: Array<{ marketId: string; yesTokenId: string; entryPrice: number }>;
  profitableVolumeUsd: number;
  expectedProfitUsd: number;
  /** Net profit per $1 guaranteed return, after fees. */
  netSpread: number;
  feeRate: number;
}

/** Effective per-share cost including taker fee. */
function effectiveCost(price: number, feeRate: number): number {
  return price + feeRate * price * (1 - price);
}

/**
 * Walk YES+NO ask depth simultaneously with proper per-market fee deduction.
 * Returns null if net profit after fees doesn't clear config.feeThreshold.
 */
export async function computeArbSignal(
  marketId: string,
  question: string,
  yesTokenId: string,
  noTokenId: string,
  feeRate: number,
): Promise<ArbSignal | null> {
  const [yesBook, noBook] = await Promise.all([
    getOrderBook(yesTokenId),
    getOrderBook(noTokenId),
  ]);

  const yesAsks = yesBook.asks.filter((a) => a.price > 0 && a.size > 0);
  const noAsks = noBook.asks.filter((a) => a.price > 0 && a.size > 0);

  if (!yesAsks.length || !noAsks.length) return null;

  let profitableVolumeUsd = 0;
  let expectedProfitUsd = 0;
  let totalYesSpend = 0;
  let totalNoSpend = 0;
  let totalShares = 0;

  let yi = 0;
  let ni = 0;
  let yesRemaining = yesAsks[0].size;
  let noRemaining = noAsks[0].size;

  while (yi < yesAsks.length && ni < noAsks.length) {
    const yesPrice = yesAsks[yi].price;
    const noPrice = noAsks[ni].price;

    // Net profit per share after taker fees on both legs
    const netProfit = 1 - effectiveCost(yesPrice, feeRate) - effectiveCost(noPrice, feeRate);

    if (netProfit <= config.feeThreshold) break;

    const stepSize = Math.min(yesRemaining, noRemaining);
    const stepNotionalUsd = stepSize * (yesPrice + noPrice);

    if (profitableVolumeUsd + stepNotionalUsd > config.maxPositionUsd) {
      const remainingBudget = config.maxPositionUsd - profitableVolumeUsd;
      if (remainingBudget > 0) {
        const partialShares = remainingBudget / (yesPrice + noPrice);
        totalYesSpend += partialShares * yesPrice;
        totalNoSpend += partialShares * noPrice;
        totalShares += partialShares;
        profitableVolumeUsd = config.maxPositionUsd;
        expectedProfitUsd += partialShares * netProfit;
      }
      break;
    }

    profitableVolumeUsd += stepNotionalUsd;
    expectedProfitUsd += stepSize * netProfit;
    totalYesSpend += stepSize * yesPrice;
    totalNoSpend += stepSize * noPrice;
    totalShares += stepSize;

    yesRemaining -= stepSize;
    noRemaining -= stepSize;

    if (yesRemaining <= 0.0001) {
      yi++;
      if (yi < yesAsks.length) yesRemaining = yesAsks[yi].size;
    }
    if (noRemaining <= 0.0001) {
      ni++;
      if (ni < noAsks.length) noRemaining = noAsks[ni].size;
    }
  }

  if (profitableVolumeUsd <= 0 || totalShares <= 0) return null;

  const yesAvg = totalYesSpend / totalShares;
  const noAvg = totalNoSpend / totalShares;

  return {
    type: "binary",
    yesTokenId,
    noTokenId,
    marketId,
    marketQuestion: question,
    profitableVolumeUsd,
    expectedProfitUsd,
    yesEntryPrice: yesAvg,
    noEntryPrice: noAvg,
    netSpread: 1 - effectiveCost(yesAvg, feeRate) - effectiveCost(noAvg, feeRate),
    feeRate,
  };
}

/**
 * Check top-of-book for all N YES outcomes in a negRisk group.
 * Buying YES for every outcome guarantees $1 at resolution (exactly one wins).
 * Returns null if sum of effective YES costs doesn't clear config.feeThreshold.
 */
export async function computeNegRiskArbSignal(
  group: NegRiskGroup,
): Promise<NegRiskArbSignal | null> {
  const N = group.outcomes.length;
  if (N < 2) return null;

  const books = await Promise.all(
    group.outcomes.map((o) => getOrderBook(o.yesTokenId)),
  );

  const topAsks = books.map((b) => {
    const asks = b.asks.filter((a) => a.price > 0 && a.size > 0);
    return asks.length > 0 ? asks[0] : null;
  });

  if (topAsks.some((a) => a === null)) return null;

  const asks = topAsks as Array<{ price: number; size: number }>;
  const feeRate = group.feeRate;

  const totalEffectiveCost = asks.reduce(
    (sum, a) => sum + effectiveCost(a.price, feeRate),
    0,
  );
  const netProfit = 1 - totalEffectiveCost;

  if (netProfit <= config.feeThreshold) return null;

  const totalRawCost = asks.reduce((s, a) => s + a.price, 0);
  const minSize = Math.min(...asks.map((a) => a.size));
  const maxSharesByBudget = config.maxPositionUsd / totalRawCost;
  const size = Math.min(minSize, maxSharesByBudget);

  if (size < 0.01) return null;

  return {
    type: "neg_risk",
    negRiskMarketId: group.negRiskMarketId,
    groupQuestion: group.groupQuestion,
    legs: group.outcomes.map((o, i) => ({
      marketId: o.marketId,
      yesTokenId: o.yesTokenId,
      entryPrice: asks[i].price,
    })),
    profitableVolumeUsd: size * totalRawCost,
    expectedProfitUsd: size * netProfit,
    netSpread: netProfit,
    feeRate,
  };
}
