/**
 * orderbook.ts — computes net arb edge from matched Kalshi + Polymarket books.
 *
 * Kalshi only returns bids; asks are reconstructed:
 *   YES ask = 1 − best NO bid
 *   NO ask  = 1 − best YES bid
 *
 * Fee formula (per Kalshi docs): fee = feeRate × price × (1 − price)
 * Net edge = 1.00 − VWAP_kalshi_side − VWAP_poly_side − fees_both_sides
 *
 * Two directions evaluated per pair:
 *   Direction A: Long YES on Kalshi + Long NO on Polymarket
 *   Direction B: Long NO  on Kalshi + Long YES on Polymarket
 */

import { config } from "./config.js";
import type { KalshiOrderBook } from "./kalshi.js";
import type { OrderBook as PolyOrderBook } from "./clob.js";
import type { MarketPair } from "./mapper.js";

export type ArbDirection = "kalshi_yes_poly_no" | "kalshi_no_poly_yes";

export interface ArbSignal {
  pair: MarketPair;
  direction: ArbDirection;
  // Kalshi side
  kalshiSide: "yes" | "no";
  kalshiVwap: number;
  kalshiContracts: number;
  // Polymarket side
  polySide: "yes" | "no";
  polyTokenId: string;
  polyVwap: number;
  polyShares: number;
  // Combined
  netEdgePct: number;
  estimatedProfitUsd: number;
}

// Walk order book asks up to targetUsd notional. Returns { vwap, contracts }.
// `asks` is sorted ascending by price (cheapest first).
function walkAsks(
  asks: Array<{ price: number; size: number }>,
  targetUsd: number,
): { vwap: number; contracts: number } {
  let spent = 0;
  let contracts = 0;

  for (const level of asks) {
    if (spent >= targetUsd) break;
    const available = level.size;
    const levelCost = level.price * available;
    if (spent + levelCost <= targetUsd) {
      spent += levelCost;
      contracts += available;
    } else {
      const partial = (targetUsd - spent) / level.price;
      spent += partial * level.price;
      contracts += partial;
    }
  }

  if (contracts === 0) return { vwap: 0, contracts: 0 };
  return { vwap: spent / contracts, contracts };
}

function kalshiFee(price: number, feeRate: number): number {
  return feeRate * price * (1 - price);
}

function polyFee(price: number, feeRate: number): number {
  return feeRate * price * (1 - price);
}

function computeSignal(
  pair: MarketPair,
  direction: ArbDirection,
  kalshiBook: KalshiOrderBook,
  polyBook: PolyOrderBook,
): ArbSignal | null {
  const targetUsd = config.maxPositionUsd;

  // Reconstruct Kalshi asks from opposite bids
  // YES asks: sorted ascending (cheapest YES ask first) = reverse of NO bids sorted desc
  const kalshiYesAsks = kalshiBook.noBids
    .map((b) => ({ price: 1 - b.price, size: b.size }))
    .filter((a) => a.price > 0 && a.price < 1)
    .sort((a, b) => a.price - b.price);

  const kalshiNoAsks = kalshiBook.yesBids
    .map((b) => ({ price: 1 - b.price, size: b.size }))
    .filter((a) => a.price > 0 && a.price < 1)
    .sort((a, b) => a.price - b.price);

  // Polymarket asks sorted ascending
  const polyYesAsks = [...polyBook.asks].sort((a, b) => a.price - b.price);
  const polyNoAsks: Array<{ price: number; size: number }> = [];
  // Poly NO ask = 1 − best YES bid (reconstruct same way as Kalshi)
  for (const bid of [...polyBook.bids].sort((a, b) => b.price - a.price)) {
    polyNoAsks.push({ price: 1 - bid.price, size: bid.size });
  }
  polyNoAsks.sort((a, b) => a.price - b.price);

  let kalshiAsks: typeof kalshiYesAsks;
  let kalshiSide: "yes" | "no";
  let polyAsks: typeof polyYesAsks;
  let polySide: "yes" | "no";
  let polyTokenId: string;

  if (direction === "kalshi_yes_poly_no") {
    kalshiAsks = kalshiYesAsks;
    kalshiSide = "yes";
    polyAsks = polyNoAsks;
    polySide = "no";
    polyTokenId = pair.polyNoTokenId;
  } else {
    kalshiAsks = kalshiNoAsks;
    kalshiSide = "no";
    polyAsks = polyYesAsks;
    polySide = "yes";
    polyTokenId = pair.polyYesTokenId;
  }

  if (!kalshiAsks.length || !polyAsks.length) return null;

  const kResult = walkAsks(kalshiAsks, targetUsd / 2);
  const pResult = walkAsks(polyAsks, targetUsd / 2);

  if (kResult.contracts < 0.01 || pResult.contracts === 0) return null;

  const kFee = kalshiFee(kResult.vwap, pair.kalshiFeeRate);
  const pFee = polyFee(pResult.vwap, pair.polyFeeRate);
  const totalCost = kResult.vwap + pResult.vwap;
  const netEdge = 1.0 - totalCost - kFee - pFee;
  const netEdgePct = netEdge * 100;

  if (netEdgePct < config.minNetSpreadPct) return null;

  const avgContracts = Math.min(kResult.contracts, pResult.contracts);
  const estimatedProfitUsd = netEdge * avgContracts;

  return {
    pair,
    direction,
    kalshiSide,
    kalshiVwap: kResult.vwap,
    kalshiContracts: kResult.contracts,
    polySide,
    polyTokenId,
    polyVwap: pResult.vwap,
    polyShares: pResult.contracts,
    netEdgePct,
    estimatedProfitUsd,
  };
}

export function computeArbSignals(
  pair: MarketPair,
  kalshiBook: KalshiOrderBook,
  polyBook: PolyOrderBook,
): ArbSignal[] {
  const signals: ArbSignal[] = [];

  const a = computeSignal(pair, "kalshi_yes_poly_no", kalshiBook, polyBook);
  if (a) signals.push(a);

  const b = computeSignal(pair, "kalshi_no_poly_yes", kalshiBook, polyBook);
  if (b) signals.push(b);

  return signals.sort((x, y) => y.netEdgePct - x.netEdgePct);
}
