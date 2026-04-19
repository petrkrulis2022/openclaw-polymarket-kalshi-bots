# Market Making Strategy: Bid-Ask Spread Capture

## Overview

Our trading bot implements a **market making strategy** focused on capturing the bid-ask spread on Polymarket prediction markets. This is **not** traditional spread trading (which involves correlated assets), but rather **market making** where we simultaneously post buy and sell orders on the same asset to profit from the price difference between buyers and sellers.

## How It Works

### Core Mechanism

1. **Mid Price Calculation**: For each selected market, we determine a fair "mid" price using:
   - Primary: Gamma API's `bestBid` and `bestAsk` (already fetched during market discovery)
   - Fallback: CLOB order book mid
   - Last resort: Last trade price

2. **Quote Placement**: Around this mid, we place two orders:
   - **BID** (buy order) at `mid - halfWidth` (e.g., 0.135)
   - **ASK** (sell order) at `mid + halfWidth` (e.g., 0.195)

   The `halfWidth` is configurable (default 0.03 = 3¢ each side), creating a spread of 6¢.

3. **Profit Capture**: When both orders fill over time, we pocket the spread difference. For example:
   - Buy 5 shares at $0.135 = $0.675 spent
   - Sell 5 shares at $0.195 = $0.975 received
   - Profit: $0.30 per round-trip (minus fees)

### Market Selection

- Filters out near-resolved markets (YES > 90% or < 10%) to avoid unaffordable positions
- Prioritizes liquid markets with high volume
- Currently quotes 2 markets simultaneously

### Risk Management

- **Affordability Check**: Ensures we can fund minimum order size (5 shares) with available equity
- **Inventory Limits**: Reduces quote sizes when one side accumulates too much inventory
- **Order Staleness**: Cancels and re-quotes if prices move significantly
- **Capital Allocation**: Splits equity across markets to limit exposure

## Key Parameters

| Parameter          | Default | Purpose                                         |
| ------------------ | ------- | ----------------------------------------------- |
| `quoteHalfWidth`   | 0.03    | Distance from mid for bid/ask (3¢ each side)    |
| `numMarkets`       | 2       | Markets to quote simultaneously                 |
| `minVolume24h`     | 5000    | Minimum daily volume for market selection       |
| `maxInventorySkew` | 0.6     | Max one-sided inventory ratio before adjustment |
| `reQuoteThreshold` | 0.005   | Mid move threshold for re-quoting (0.5%)        |

## Advantages

- **Market Neutral**: Profits from spread capture, not directional bets
- **Low Holding Risk**: Aims to be flat inventory; positions are side effects
- **Scalable**: Works on any liquid prediction market
- **Automated**: Runs 24/7 with minimal intervention

## Risks

- **Adverse Selection**: Traders may hit our quotes when prices are moving against us
- **Inventory Drift**: Uneven fills can create unwanted directional exposure
- **Low Liquidity**: In illiquid markets, orders may not fill quickly
- **Fee Impact**: Polymarket fees reduce effective spread
- **Market Events**: Sudden news can cause rapid price moves

## Performance Tracking

- **Realized PnL**: Profit from closed round-trip trades
- **Unrealized PnL**: Current inventory value vs. cost basis
- **Utilization**: Percentage of capital deployed
- **Fill Rate**: How often orders are executed

## Current Status

- Active on Polymarket Polygon
- Equity: ~$0.10 (after initial losses from poor market selection)
- Strategy: Recovering from early mistakes, now targeting liquid sports/IPL markets
- Markets: Filtering YES price 0.10-0.90 range for affordability

## Future Improvements

- **Dynamic Spreads**: Adjust halfWidth based on market volatility
- **Multi-Market Arbitrage**: Quote correlated markets for true spread trading
- **Fee Optimization**: Minimize taker fees through better order sizing
- **Risk Limits**: Hard stops on inventory accumulation
