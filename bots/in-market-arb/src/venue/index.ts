/**
 * venue/index.ts — selects the active exchange backend by config.venue
 * (VENUE=polymarket|kalshi). Both backends expose the same primitives, so the
 * shared signal code (orderbook.ts) is venue-agnostic. Discovery and execution,
 * which differ per venue, are branched by the caller using `VENUE`.
 */

import { config } from "../config.js";
import * as poly from "../clob.js";
import * as kalshi from "./kalshi.js";

export const VENUE = config.venue;

const backend = VENUE === "kalshi" ? kalshi : poly;

// Shared read/cancel primitives (identical signatures across venues).
export const getOrderBook = backend.getOrderBook;
export const getCollateralBalance = backend.getCollateralBalance;
export const cancelOrder = backend.cancelOrder;
export const getOpenOrders = backend.getOpenOrders;
