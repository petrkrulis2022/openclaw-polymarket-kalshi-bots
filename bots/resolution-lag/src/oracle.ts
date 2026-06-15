/**
 * oracle.ts — cross-checks Gamma resolution status against CLOB prices.
 *
 * Strategy: if Gamma says market is resolved (winner = YES) but the CLOB
 * still shows a meaningful ask price below 0.99, there's a lag window —
 * buy the winning token cheap before the CLOB resolves it to $1.
 */

import { getBestAsk, getResolvedWinnerTokenId } from "./clob.js";
import type { ClosedMarket } from "./monitor.js";
import { config } from "./config.js";

export interface ResolutionOpportunity {
  market: ClosedMarket;
  /** Token to buy (the winning side) */
  winningTokenId: string;
  /** Current ask price on CLOB — should settle at $1 */
  currentAsk: number;
  /** Expected yield: (1 - currentAsk) / currentAsk */
  expectedYield: number;
}

const confirmationCounts = new Map<string, number>();

/**
 * For each Gamma-resolved market, check CLOB ask price on the winning token.
 * Return opportunities where the CLOB ask is meaningfully below $1.
 */
export async function findResolutionOpportunities(
  markets: ClosedMarket[],
): Promise<ResolutionOpportunity[]> {
  const opportunities: ResolutionOpportunity[] = [];

  // Only process markets where Gamma is resolved and winner token is mapped.
  const actionable = markets.filter(
    (m) => m.gammaResolved && !!m.winnerTokenId,
  );
  const seenThisScan = new Set<string>();

  // Diagnostics: count why candidates get rejected so "0 opportunities" is
  // explainable instead of a black box.
  const diag = { notConfirmed: 0, noAsk: 0, priceBand: 0, pending: 0, found: 0 };
  const askSamples: number[] = [];

  // Process in small concurrency-limited batches — firing a CLOB request for
  // every candidate at once bursts hundreds of calls at clob.polymarket.com and
  // gets rate-limited ("fetch failed"), so no opportunity is ever confirmed.
  const batchSize = Math.max(1, config.clobCheckConcurrency);
  for (let i = 0; i < actionable.length; i += batchSize) {
    const batch = actionable.slice(i, i + batchSize);
    await Promise.allSettled(
      batch.map(async (m) => {
      const winningTokenId = m.winnerTokenId;
      const confirmKey = `${m.id}:${winningTokenId}`;
      seenThisScan.add(confirmKey);

      if (config.requireClobWinnerConfirmation) {
        const clobWinnerTokenId = await getResolvedWinnerTokenId(m.conditionId);
        if (!clobWinnerTokenId || clobWinnerTokenId !== winningTokenId) {
          confirmationCounts.delete(confirmKey);
          diag.notConfirmed++;
          return;
        }
      }

      const ask = await getBestAsk(winningTokenId);
      if (ask <= 0) {
        confirmationCounts.delete(confirmKey);
        diag.noAsk++;
        return;
      }
      if (askSamples.length < 12) askSamples.push(ask);

      // Ignore obvious live-market pricing and fully settled pricing.
      if (ask < config.minAskPrice || ask >= config.maxAskPrice) {
        confirmationCounts.delete(confirmKey);
        diag.priceBand++;
        return;
      }

      const nextConfirmCount = (confirmationCounts.get(confirmKey) ?? 0) + 1;
      confirmationCounts.set(confirmKey, nextConfirmCount);
      if (nextConfirmCount < config.requiredResolutionConfirmations) {
        diag.pending++;
        return;
      }

      diag.found++;
      const expectedYield = (1 - ask) / ask;
      opportunities.push({
        market: m,
        winningTokenId,
        currentAsk: ask,
        expectedYield,
      });
      }),
    );
  }

  console.log(
    `[oracle] candidates=${actionable.length} confirmRejected=${diag.notConfirmed} ` +
      `noAsk=${diag.noAsk} priceBand=${diag.priceBand} pending=${diag.pending} ` +
      `found=${diag.found} | asks=[${askSamples.map((a) => a.toFixed(2)).join(",")}]`,
  );

  for (const key of confirmationCounts.keys()) {
    if (!seenThisScan.has(key)) confirmationCounts.delete(key);
  }

  return opportunities;
}
