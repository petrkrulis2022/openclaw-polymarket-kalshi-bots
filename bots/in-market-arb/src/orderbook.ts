/**
 * orderbook.ts — walks YES+NO ask depth to find profitable arb volume.
 *
 * KEY INSIGHT: never use top-of-book only. Walk full depth and accumulate
 * only volume where the running combined price < 1 after fees.
 * Naive top-of-book check can show a spread that disappears when filled.
 */

import { getOrderBook } from "./clob.js";
import { config } from "./config.js";

export interface ArbSignal {
  yesTokenId: string;
  noTokenId: string;
  marketId: string;
  marketQuestion: string;
  profitableVolumeUsd: number;
  yesEntryPrice: number;
  noEntryPrice: number;
  netSpread: number;
}

/**
 * Walk ask levels of both YES and NO orderbooks simultaneously,
 * accumulating volume where (yesAsk + noAsk) < (1 - feeThreshold).
 * Returns null if no profitable volume found.
 */
export async function computeArbSignal(
  marketId: string,
  question: string,
  yesTokenId: string,
  noTokenId: string,
): Promise<ArbSignal | null> {
  const [yesBook, noBook] = await Promise.all([
    getOrderBook(yesTokenId),
    getOrderBook(noTokenId),
  ]);

  const yesAsks = yesBook.asks.filter((a) => a.price > 0 && a.size > 0);
  const noAsks = noBook.asks.filter((a) => a.price > 0 && a.size > 0);

  if (!yesAsks.length || !noAsks.length) return null;

  // Walk depth: pair up ask levels and find overlapping profitable volume
  let profitableVolumeUsd = 0;
  let totalYesSpend = 0;
  let totalNoSpend = 0;
  let totalVolume = 0;

  let yi = 0;
  let ni = 0;
  let yesRemaining = yesAsks[0].size;
  let noRemaining = noAsks[0].size;

  while (yi < yesAsks.length && ni < noAsks.length) {
    const yesPrice = yesAsks[yi].price;
    const noPrice = noAsks[ni].price;
    const combined = yesPrice + noPrice;
    const netSpread = 1 - combined;

    if (netSpread <= config.feeThreshold) {
      // This level is not profitable — stop walking
      break;
    }

    const stepSize = Math.min(yesRemaining, noRemaining);
    const stepUsd = stepSize * ((yesPrice + noPrice) / 2);

    if (totalVolume + stepUsd > config.maxPositionUsd) {
      const remainingBudget = config.maxPositionUsd - totalVolume;
      if (remainingBudget > 0) {
        profitableVolumeUsd += remainingBudget * netSpread;
        totalYesSpend += remainingBudget;
        totalNoSpend += remainingBudget;
        totalVolume = config.maxPositionUsd;
      }
      break;
    }

    profitableVolumeUsd += stepUsd * netSpread;
    totalYesSpend += stepSize * yesPrice;
    totalNoSpend += stepSize * noPrice;
    totalVolume += stepUsd;

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

  if (profitableVolumeUsd <= 0 || totalVolume <= 0) return null;

  return {
    yesTokenId,
    noTokenId,
    marketId,
    marketQuestion: question,
    profitableVolumeUsd,
    yesEntryPrice: totalYesSpend / totalVolume,
    noEntryPrice: totalNoSpend / totalVolume,
    netSpread: 1 - (totalYesSpend + totalNoSpend) / totalVolume,
  };
}
