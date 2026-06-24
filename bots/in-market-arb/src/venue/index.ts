/**
 * venue/index.ts — selects the active exchange backend by config.venue
 * (VENUE=polymarket|kalshi|limitless). Both backends expose the same primitives,
 * so the shared signal code (orderbook.ts) is venue-agnostic. Discovery and
 * execution, which differ per venue, are branched by the caller using `VENUE`.
 *
 * The kalshi/limitless adapters are SDK-free (fetch + viem, already deps), so
 * importing them adds no heavy dependency to the live polymarket bot.
 */

import { config } from "../config.js";
import * as poly from "../clob.js";
import * as kalshi from "./kalshi.js";
import * as limitless from "./limitless.js";

export const VENUE = config.venue;

const backend =
  VENUE === "kalshi" ? kalshi : VENUE === "limitless" ? limitless : poly;

// Shared read/cancel primitives (identical signatures across venues).
export const getOrderBook = backend.getOrderBook;
export const getCollateralBalance = backend.getCollateralBalance;
export const cancelOrder = backend.cancelOrder;
export const getOpenOrders = backend.getOpenOrders;
