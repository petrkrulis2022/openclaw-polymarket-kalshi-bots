/**
 * closer.ts — monitors open pairs and exits early when spread compresses.
 *
 * Exit condition: combined current value of both legs > entry cost + min threshold.
 * i.e. the spread that locked profit at entry has now closed enough that selling
 * both positions realises the profit without waiting for resolution.
 *
 * This frees capital in days rather than waiting weeks for resolution.
 * Formula: currentEdge = (kalshiSellPrice + polySellPrice) − 1.00
 *   → if currentEdge < -CLOSE_THRESHOLD, spread has compressed → sell both
 *
 * Kalshi sell = place a limit SELL at best bid (take the book).
 * Polymarket sell = place a SELL limit at current best bid.
 *
 * Both sells via Promise.all with FOK. If either fails, leave position open.
 */

import { config } from "./config.js";
import { getKalshiOrderBook, placeKalshiOrder } from "./kalshi.js";
import { getPolyOrderBook, placeLimitOrder } from "./clob.js";
import { getAllPairs, getOpenPairs, updatePair } from "./inventory.js";
import { attemptUnwind } from "./unwind.js";
import { logActivity } from "./activity.js";

// Exit when the remaining spread (cost to close) is within 0.25% of breakeven.
// That means we've captured at least (entryEdgePct - 0.25%) of our locked profit.
const CLOSE_THRESHOLD = 0.0025;

export async function checkAndClosePositions(): Promise<void> {
  // Retry any pairs stuck mid-unwind (naked leg from a legging failure).
  const unwinding = getAllPairs().filter((p) => p.status === "unwinding");
  for (const pair of unwinding) {
    logActivity(
      "unwind_retry",
      { pairId: pair.id, leg: pair.unwindInfo?.leg, attempts: pair.unwindInfo?.attempts ?? 0 },
      "error",
    );
    await attemptUnwind(pair).catch((err) =>
      console.error(`[closer] unwind retry failed for ${pair.id}:`, (err as Error).message),
    );
  }

  const openPairs = getOpenPairs().filter((p) => p.status === "filled");
  if (openPairs.length === 0) return;

  await Promise.allSettled(
    openPairs.map(async (pair) => {
      try {
        const [kalshiBook, polyBook] = await Promise.all([
          getKalshiOrderBook(pair.kalshiTicker),
          getPolyOrderBook(
            pair.polySide === "yes"
              ? pair.polyYesTokenId
              : pair.polyNoTokenId,
          ),
        ]);

        // Best bid on each side (what we'd receive if we sell now)
        const kalshiBestBid =
          pair.kalshiSide === "yes"
            ? (kalshiBook.yesBids[0]?.price ?? 0)
            : (kalshiBook.noBids[0]?.price ?? 0);

        const polyBestBid = polyBook.bids[0]?.price ?? 0;

        if (kalshiBestBid === 0 || polyBestBid === 0) return;

        // Combined sell proceeds (what we get back for our locked $1 position)
        const combinedSellValue = kalshiBestBid + polyBestBid;
        // Originally paid pair.entryEdgePct/100 less than $1.
        // The position pays $1 at resolution.
        // We can exit early if sell proceeds ≥ 1 − CLOSE_THRESHOLD
        const exitThreshold = 1.0 - CLOSE_THRESHOLD;

        if (combinedSellValue < exitThreshold) return;

        const realizedPnl =
          combinedSellValue - (1.0 - pair.entryEdgePct / 100);

        console.log(
          `[closer] Closing pair ${pair.id}: combined sell=${combinedSellValue.toFixed(4)} ` +
          `entry edge=${pair.entryEdgePct.toFixed(2)}% realizedPnl≈${realizedPnl.toFixed(4)}`,
        );

        logActivity("close_attempt", {
          pairId: pair.id,
          combinedSellValue,
          realizedPnl,
          dryRun: config.dryRun,
        });

        if (config.dryRun) {
          console.log(`[closer] DRY_RUN — would close pair ${pair.id}`);
          return;
        }

        const sizePerLeg = pair.sizeUsd / 2;
        const kalshiContracts = sizePerLeg / pair.kalshiEntryVwap;
        const polyShares = sizePerLeg / pair.polyEntryVwap;

        const [kRes, pRes] = await Promise.allSettled([
          placeKalshiOrder(
            pair.kalshiTicker,
            pair.kalshiSide,
            kalshiBestBid,
            sizePerLeg,
            `close-${pair.id.slice(0, 8)}`,
            "sell",
          ),
          placeLimitOrder(
            pair.polySide === "yes" ? pair.polyYesTokenId : pair.polyNoTokenId,
            "SELL",
            polyBestBid,
            polyShares,
          ),
        ]);

        if (kRes.status === "rejected" || pRes.status === "rejected") {
          console.warn(
            `[closer] Close failed for ${pair.id}: ` +
            `kalshi=${kRes.status} poly=${pRes.status}`,
          );
          logActivity(
            "close_failed",
            { pairId: pair.id, kalshi: kRes.status, poly: pRes.status },
            "warn",
          );
          return;
        }

        updatePair(pair.id, {
          status: "closed",
          closedAt: new Date().toISOString(),
          realizedPnl: realizedPnl * kalshiContracts,
        });
        logActivity("pair_closed", {
          pairId: pair.id,
          realizedPnl: realizedPnl * kalshiContracts,
        });
      } catch (err) {
        console.warn(`[closer] checkAndClose error for ${pair.id}:`, (err as Error).message);
      }
    }),
  );
}
