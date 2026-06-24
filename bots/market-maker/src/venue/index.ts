/**
 * venue/index.ts — selects the active exchange backend by config.venue
 * (VENUE=polymarket|kalshi). Both backends expose the same primitives, so the
 * quoter and fill loop are venue-agnostic. Discovery is routed in markets.ts.
 */

import { config } from "../config.js";
import * as poly from "../clob.js";
import * as kalshi from "./kalshi.js";

export const VENUE = config.venue;

const backend = VENUE === "kalshi" ? kalshi : poly;

export const getOrderBook = backend.getOrderBook;
export const placeLimitOrder = backend.placeLimitOrder;
export const cancelOrder = backend.cancelOrder;
export const getCollateralBalance = backend.getCollateralBalance;
export const getOpenOrders = backend.getOpenOrders;
export const fetchRawTrades = backend.fetchRawTrades;
export const fetchTradeHistory = backend.fetchTradeHistory;
export const getLastTradeMid = backend.getLastTradeMid;
