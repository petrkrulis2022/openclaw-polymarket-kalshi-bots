/**
 * unwind.ts — markets-out a naked leg after a legging failure.
 *
 * When one leg of an arb pair fills and the other fails, the position is
 * directional, not hedged. This module sells the held leg at best bid as
 * fast as possible. Pairs stay in status "unwinding" until the inventory
 * is confirmed flat; closer.ts re-runs attemptUnwind() every cycle so a
 * crash mid-unwind self-heals.
 *
 * Position lookups return null on API failure — null means UNKNOWN, never
 * "nothing held". We only mark a pair unwound on a confirmed zero or a
 * confirmed sell.
 */

import { config } from "./config.js";
import { getKalshiOrderBook, placeKalshiOrder, getKalshiPosition } from "./kalshi.js";
import { getPolyOrderBook, placeLimitOrder, getPolyOrderSizeMatched } from "./clob.js";
import { getAllPairs, updatePair, type KalshiPolyPair } from "./inventory.js";
import { logActivity } from "./activity.js";

function reportUnwindFill(
  pair: KalshiPolyPair,
  venue: "kalshi" | "poly",
  price: number,
  sizeUsd: number,
): void {
  fetch(`${config.orchestratorUrl}/fills`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ts: new Date().toISOString(),
      botId: "kalshi-arb",
      side: "SELL",
      tokenId: venue === "kalshi" ? pair.kalshiTicker : pair.polyYesTokenId,
      signalPrice: price,
      fillPrice: price,
      fillShares: 0,
      fillUsdc: sizeUsd,
      fillStatus: "filled",
      meta: { pairId: pair.id, unwind: true, venue },
    }),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {});
}

function markUnwound(pair: KalshiPolyPair, lossUsd: number): void {
  updatePair(pair.id, {
    status: "unwound",
    closedAt: new Date().toISOString(),
    realizedPnl: -lossUsd,
    unwindInfo: { ...(pair.unwindInfo ?? { leg: "kalshi", attempts: 0 }), lossUsd },
  });
  logActivity(
    "leg_unwound",
    { pairId: pair.id, leg: pair.unwindInfo?.leg, lossUsd },
    "warn",
  );
}

/**
 * One unwind attempt for a pair in status "unwinding".
 * Returns true when the pair is flat (sold or confirmed empty).
 */
export async function attemptUnwind(pair: KalshiPolyPair): Promise<boolean> {
  const leg = pair.unwindInfo?.leg;
  if (!leg) return false;
  const attempts = (pair.unwindInfo?.attempts ?? 0) + 1;
  updatePair(pair.id, { unwindInfo: { leg, attempts } });

  try {
    if (leg === "kalshi") {
      const held = await getKalshiPosition(pair.kalshiTicker, pair.kalshiSide);
      if (held === null) return false; // unknown — retry later
      if (held <= 0) {
        markUnwound(pair, 0);
        return true;
      }

      const book = await getKalshiOrderBook(pair.kalshiTicker);
      const bestBid =
        pair.kalshiSide === "yes"
          ? (book.yesBids[0]?.price ?? 0)
          : (book.noBids[0]?.price ?? 0);
      if (bestBid <= 0) return false; // no liquidity — retry later

      const sellUsd = held * bestBid;
      await placeKalshiOrder(
        pair.kalshiTicker,
        pair.kalshiSide,
        bestBid,
        sellUsd,
        `unwind-${pair.id.slice(0, 8)}-${attempts}`,
        "sell",
      );
      const lossUsd = Math.max(0, held * (pair.kalshiEntryVwap - bestBid));
      markUnwound(pair, lossUsd);
      reportUnwindFill(pair, "kalshi", bestBid, sellUsd);
      return true;
    }

    // leg === "poly"
    const matched = await getPolyOrderSizeMatched(pair.polyOrderId);
    if (matched === null) return false; // unknown — retry later
    if (matched <= 0) {
      markUnwound(pair, 0);
      return true;
    }

    const tokenId =
      pair.polySide === "yes" ? pair.polyYesTokenId : pair.polyNoTokenId;
    const book = await getPolyOrderBook(tokenId);
    const bestBid = book.bids[0]?.price ?? 0;
    if (bestBid <= 0) return false; // no liquidity — retry later

    await placeLimitOrder(tokenId, "SELL", bestBid, matched);
    const lossUsd = Math.max(0, matched * (pair.polyEntryVwap - bestBid));
    markUnwound(pair, lossUsd);
    reportUnwindFill(pair, "poly", bestBid, matched * bestBid);
    return true;
  } catch (err) {
    console.error(
      `[unwind] attempt ${attempts} failed for pair ${pair.id}:`,
      (err as Error).message,
    );
    logActivity(
      "unwind_failed",
      { pairId: pair.id, leg, attempts, message: (err as Error).message },
      "error",
    );
    return false;
  }
}

/**
 * Mark a pair as having a naked leg and run the first unwind attempts.
 * Called by the executor immediately after a legging failure.
 */
export async function startUnwind(
  pair: KalshiPolyPair,
  leg: "kalshi" | "poly",
): Promise<void> {
  updatePair(pair.id, { status: "unwinding", unwindInfo: { leg, attempts: 0 } });
  logActivity("leg_naked", { pairId: pair.id, leg }, "error");

  const retryDelayMs = Math.max(
    1_000,
    Math.floor(config.maxUnhedgedMs / Math.max(1, config.unwindMaxRetries)),
  );
  for (let i = 0; i < config.unwindMaxRetries; i++) {
    const fresh = getAllPairs().find((p) => p.id === pair.id);
    if (!fresh || fresh.status !== "unwinding") return;
    if (await attemptUnwind(fresh)) return;
    await new Promise((r) => setTimeout(r, retryDelayMs));
  }
  // Still naked — closer.ts sweep keeps retrying every cycle.
}
