/**
 * oracle.ts — cross-checks Gamma resolution status against CLOB prices.
 *
 * Strategy: if Gamma says market is resolved (winner = YES) but the CLOB
 * still shows a meaningful ask price below 0.99, there's a lag window —
 * buy the winning token cheap before the CLOB resolves it to $1.
 */

import { getBestAsk } from "./clob.js";
import type { ClosedMarket } from "./monitor.js";

export interface ResolutionOpportunity {
  market: ClosedMarket;
  /** Token to buy (the winning side) */
  winningTokenId: string;
  /** Current ask price on CLOB — should settle at $1 */
  currentAsk: number;
  /** Expected yield: (1 - currentAsk) / currentAsk */
  expectedYield: number;
}

/**
 * For each Gamma-resolved market, check CLOB ask price on the winning token.
 * Return opportunities where the CLOB ask is meaningfully below $1.
 */
export async function findResolutionOpportunities(
  markets: ClosedMarket[],
): Promise<ResolutionOpportunity[]> {
  const opportunities: ResolutionOpportunity[] = [];

  // Only process markets where Gamma is resolved and winner is known
  const actionable = markets.filter(
    (m) => m.gammaResolved && m.gammaOutcome !== "UNKNOWN",
  );

  await Promise.allSettled(
    actionable.map(async (m) => {
      const winningTokenId =
        m.gammaOutcome === "YES" ? m.yesTokenId : m.noTokenId;

      const ask = await getBestAsk(winningTokenId);

      // CLOB is already resolved if ask ≥ 0.99
      if (ask >= 0.99) return;

      const expectedYield = (1 - ask) / ask;
      opportunities.push({
        market: m,
        winningTokenId,
        currentAsk: ask,
        expectedYield,
      });
    }),
  );

  return opportunities;
}
