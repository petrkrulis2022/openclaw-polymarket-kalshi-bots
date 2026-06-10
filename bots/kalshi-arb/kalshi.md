# Kalshi API Documentation Reference

## Top-Level

- Welcome: https://docs.kalshi.com/welcome
- Quick Start: https://docs.kalshi.com/getting_started/api_environments
- Concepts: https://docs.kalshi.com/getting_started/making_your_first_request
- Predictions APIs: https://docs.kalshi.com/api-reference/exchange/get-exchange-status
- Perps APIs: https://docs.kalshi.com/margin
- Changelog: https://docs.kalshi.com/changelog
- Predictions OpenAPI spec: https://docs.kalshi.com/openapi.yaml
- Predictions AsyncAPI (WebSocket): https://docs.kalshi.com/asyncapi.yaml

## Quick Start

- API Environments and Endpoints: https://docs.kalshi.com/getting_started/api_environments
- Quick Start: Market Data: https://docs.kalshi.com/getting_started/quick_start_market_data
- Quick Start: Authenticated Requests: https://docs.kalshi.com/getting_started/quick_start_authenticated_requests
- Quick Start: Create your first order: https://docs.kalshi.com/getting_started/quick_start_create_order
- Quick Start: WebSockets: https://docs.kalshi.com/getting_started/quick_start_websockets
- Kalshi SDKs: https://docs.kalshi.com/sdks/overview

## Concepts

- Making Your First Request: https://docs.kalshi.com/getting_started/making_your_first_request
- Test In The Demo Environment: https://docs.kalshi.com/getting_started/demo_env
- API Keys: https://docs.kalshi.com/getting_started/api_keys
- Rate Limits and Tiers: https://docs.kalshi.com/getting_started/rate_limits
- Understanding Pagination: https://docs.kalshi.com/getting_started/pagination
- Orderbook Responses: https://docs.kalshi.com/getting_started/orderbook_responses
- Order Direction (outcome_side / book_side): https://docs.kalshi.com/getting_started/order_direction
- Order Groups: https://docs.kalshi.com/getting_started/order_groups
- Fixed-Point Migration: https://docs.kalshi.com/getting_started/fixed_point_migration
- Fee Rounding: https://docs.kalshi.com/getting_started/fee_rounding
- Historical Data: https://docs.kalshi.com/getting_started/historical_data
- Market Lifecycle: https://docs.kalshi.com/getting_started/market_lifecycle
- Market Settlement: https://docs.kalshi.com/getting_started/market_settlement
- Request for Quote (RFQ): https://docs.kalshi.com/getting_started/rfqs
- Kalshi Glossary: https://docs.kalshi.com/getting_started/terms

## REST – Exchange

- Get Exchange Status: https://docs.kalshi.com/api-reference/exchange/get-exchange-status
- Get Exchange Announcements: https://docs.kalshi.com/api-reference/exchange/get-exchange-announcements
- Get Series Fee Changes: https://docs.kalshi.com/api-reference/exchange/get-series-fee-changes
- Get Exchange Schedule: https://docs.kalshi.com/api-reference/exchange/get-exchange-schedule

## WebSockets

- Connection: https://docs.kalshi.com/websockets/websocket-connection
- Keep-Alive: https://docs.kalshi.com/websockets/connection-keep-alive
- Orderbook Updates: https://docs.kalshi.com/websockets/orderbook-updates
- Market Ticker: https://docs.kalshi.com/websockets/market-ticker
- Public Trades: https://docs.kalshi.com/websockets/public-trades
- User Fills: https://docs.kalshi.com/websockets/user-fills
- Market Positions: https://docs.kalshi.com/websockets/market-positions
- Market & Event Lifecycle: https://docs.kalshi.com/websockets/market-and-event-lifecycle
- User Orders: https://docs.kalshi.com/websockets/user-orders
- Order Group Updates: https://docs.kalshi.com/websockets/order-group-updates

## Auth Summary (RSA-PSS / SHA-256)

Sign string: `{timestamp_ms}{METHOD_UPPERCASE}{path_without_query}`

Headers:
- `KALSHI-ACCESS-KEY`: API key ID
- `KALSHI-ACCESS-TIMESTAMP`: milliseconds since epoch
- `KALSHI-ACCESS-SIGNATURE`: base64(RSA-PSS-SHA256(signing_string))

Node.js signing:
```ts
crypto.sign("sha256", Buffer.from(msg), {
  key: privateKeyPem,
  padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
  saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
})
```

## Environments

| | Base URL |
|---|---|
| Production | `https://external-api.kalshi.com/trade-api/v2` |
| Demo | `https://external-api.demo.kalshi.co/trade-api/v2` |

## Order Book Format

`GET /markets/{ticker}/orderbook` returns `orderbook_fp`:
- `yes_dollars`: array of `[price_string, count_string]`, sorted ascending (best bid = last)
- `no_dollars`: same format
- Only bids returned. YES ask = `1 − best NO bid`.

## Order Placement

`POST /portfolio/events/orders`:
```json
{
  "ticker": "...",
  "outcome_side": "yes",
  "price": "0.4200",
  "count": "10.00",
  "time_in_force": "fill_or_kill",
  "client_order_id": "<uuid>"
}
```
