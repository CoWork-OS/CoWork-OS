---
name: polymarket
description:
  Query Polymarket prediction markets — search events, check odds and prices,
  view trending markets, track price momentum, get orderbook depth, analyze volume,
  and monitor market resolution timelines.
homepage: https://polymarket.com
metadata:
  {
    "cowork":
      {
        "emoji": "📊",
        "category": "Tools",
      },
  }
---

# Polymarket 📊

Query the world's largest prediction market directly from CoWork OS. No API key required — all public endpoints are unauthenticated.

## Overview

Polymarket is a decentralized prediction market where users trade on the outcomes of real-world events. Prices represent implied probabilities: a "Yes" token at $0.72 means the market assigns a **72% probability** to that outcome.

This skill gives the agent full read access to three Polymarket APIs covering market discovery, real-time pricing, orderbook depth, trade history, and analytics.

## APIs

| API | Base URL | Auth | Purpose |
|-----|----------|------|---------|
| **Gamma** | `https://gamma-api.polymarket.com` | None | Events, markets, search, tags, series |
| **CLOB** | `https://clob.polymarket.com` | None (public) | Prices, orderbooks, spreads, midpoints, price history |
| **Data** | `https://data-api.polymarket.com` | None | Open interest, holders, trades, analytics |

**Rate limits:** 15,000 requests per 10 seconds globally. Some endpoints (e.g. `/events`) have tighter limits (~500 req/10s).

## Data Model

```
Event (e.g. "2028 Presidential Election")
 └── Market (e.g. "Will Candidate A win?")
      ├── Yes Token (clobTokenIds[0])
      └── No Token  (clobTokenIds[1])
```

- **Events** group related markets together
- **Markets** are individual binary Yes/No outcomes
- **Multi-outcome events** use `enableNegRisk: true` with one market per candidate/option
- Each market has a `conditionId` (hex hash) used by CLOB and Data APIs
- Each market has `clobTokenIds` for orderbook/price queries

### Field Gotchas

Several fields are stored as JSON strings, not native arrays:

| Field | Stored as | Example |
|-------|-----------|---------|
| `outcomePrices` | `"[\"0.72\", \"0.28\"]"` | Must `JSON.parse()` first |
| `outcomes` | `"[\"Yes\", \"No\"]"` | Must `JSON.parse()` first |
| `clobTokenIds` | `"[\"123...\", \"456...\"]"` | Must `JSON.parse()` first |

## Gamma API — Discovery & Search

### Search events by keyword

```bash
curl -s 'https://gamma-api.polymarket.com/events?title_contains=trump&active=true&closed=false&limit=10'
```

### Get trending markets (highest 24h volume)

```bash
curl -s 'https://gamma-api.polymarket.com/events?limit=10&active=true&closed=false&order=volume24hr&ascending=false'
```

### Get trending by liquidity

```bash
curl -s 'https://gamma-api.polymarket.com/events?limit=10&active=true&closed=false&order=liquidity&ascending=false'
```

### Filter by category / tag

Common tag slugs: `politics`, `crypto`, `sports`, `pop-culture`, `science`, `business`

```bash
curl -s 'https://gamma-api.polymarket.com/events?tag=politics&active=true&closed=false&order=volume24hr&ascending=false&limit=10'
```

### Get a single event

```bash
curl -s 'https://gamma-api.polymarket.com/events/{event_id}'
curl -s 'https://gamma-api.polymarket.com/events?slug={event_slug}'
```

### Get a single market

```bash
curl -s 'https://gamma-api.polymarket.com/markets/{market_id}'
```

### List all tags

```bash
curl -s 'https://gamma-api.polymarket.com/tags'
```

### List series (recurring event groups)

```bash
curl -s 'https://gamma-api.polymarket.com/series?active=true'
```

### Query Parameters Reference

| Param | Type | Description |
|-------|------|-------------|
| `limit` | int | Max results (default 100) |
| `offset` | int | Pagination offset |
| `active` | bool | Only active events |
| `closed` | bool | Filter by closed status |
| `archived` | bool | Filter by archived status |
| `order` | string | Sort: `volume24hr`, `volume1wk`, `volume1mo`, `liquidity`, `startDate`, `endDate`, `createdAt` |
| `ascending` | bool | Sort direction |
| `tag` | string | Filter by tag slug |
| `title_contains` | string | Keyword search within titles |
| `slug` | string | Exact slug match |
| `id` | string | Exact ID match |

## CLOB API — Prices & Orderbooks

### Get current price

```bash
curl -s 'https://clob.polymarket.com/price?token_id={clob_token_id}&side=buy'
# Response: {"price": "0.62"}
```

### Get prices for multiple tokens

```bash
curl -s -X POST 'https://clob.polymarket.com/prices' \
  -H 'Content-Type: application/json' \
  -d '[{"token_id": "{token_id_1}"}, {"token_id": "{token_id_2}"}]'
```

### Get orderbook

```bash
curl -s 'https://clob.polymarket.com/book?token_id={clob_token_id}'
# Response: {"bids": [{"price":"0.61","size":"1500.00"}], "asks": [{"price":"0.63","size":"800.00"}]}
```

### Get spread and midpoint

```bash
curl -s 'https://clob.polymarket.com/spread?token_id={clob_token_id}'
curl -s 'https://clob.polymarket.com/midpoint?token_id={clob_token_id}'
```

### Get price history

```bash
curl -s 'https://clob.polymarket.com/prices-history?market={condition_id}&interval=1d&fidelity=60'
```

| Param | Values |
|-------|--------|
| `interval` | `1d`, `1w`, `1m`, `3m`, `6m`, `1y`, `max` |
| `fidelity` | Number of data points returned |

## Data API — Analytics

### Open interest

```bash
curl -s 'https://data-api.polymarket.com/oi?market={condition_id}'
```

### Top holders

```bash
curl -s 'https://data-api.polymarket.com/holders?token_id={clob_token_id}&limit=10'
```

### Recent trades

```bash
curl -s 'https://data-api.polymarket.com/trades?market={condition_id}&limit=20'
```

## Price & Volume Fields

### Prices (implied probabilities)

- `outcomePrices` — JSON string `["yesPrice", "noPrice"]`, always sums to ~1.0
- Yes at 0.72 = **72% implied probability**

### Volume

| Field | Window |
|-------|--------|
| `volume` | All-time total (USD) |
| `volume24hr` | Last 24 hours |
| `volume1wk` | Last 7 days |
| `volume1mo` | Last 30 days |
| `volume1yr` | Last 365 days |

### Liquidity

| Field | Meaning |
|-------|---------|
| `liquidity` | Total available liquidity |
| `liquidityClob` | Liquidity in the CLOB orderbook |

### Momentum

| Field | Window |
|-------|--------|
| `oneHourPriceChange` | 1 hour |
| `oneDayPriceChange` | 24 hours |
| `oneWeekPriceChange` | 7 days |
| `oneMonthPriceChange` | 30 days |
| `oneYearPriceChange` | 1 year |
| `bestBid` | Current top bid |
| `bestAsk` | Current top ask |
| `lastTradePrice` | Most recent trade |
| `spread` | Current bid-ask spread |

## Common Workflows

### Check odds on a topic

1. `GET /events?title_contains={topic}&active=true&closed=false`
2. Parse `outcomePrices` from matching markets
3. Report as percentages: "The market gives X a 72% chance"

### What's trending right now?

1. `GET /events?limit=10&active=true&closed=false&order=volume24hr&ascending=false`
2. Show titles + 24h volume + current Yes prices

### How has the price moved?

1. Get market from Gamma for the `conditionId`
2. Use momentum fields (`oneDayPriceChange`, `oneWeekPriceChange`, etc.)
3. For full chart data: `GET /prices-history?market={conditionId}&interval=1w&fidelity=60`

### Show the orderbook

1. Parse `clobTokenIds` from the market object
2. `GET /book?token_id={yesTokenId}`
3. Display top bids and asks with sizes

### Markets resolving soon

1. `GET /events?active=true&closed=false&order=endDate&ascending=true&limit=20`
2. Filter where `endDate` is within the next 7 days
3. Show title + endDate + current odds

### Browse by category

1. `GET /events?tag={slug}&active=true&closed=false&order=volume24hr&ascending=false&limit=10`
2. Common slugs: `politics`, `crypto`, `sports`, `pop-culture`, `science`, `business`

## Output Formatting

When presenting market data, the agent should:

- Show prices as **percentages** (72%, not 0.72)
- Format volume as **human-readable** ($1.2M, not 1234567.89)
- Show spread in **cents** (2c spread)
- Use **arrows** for price changes (up 5%, down 3%)
- Include the **event title** for context
- Show **resolution date** when relevant
- For multi-outcome events, present as a **ranked list** summing to ~100%

### Example output

```
📊 US Presidential Election 2028

  Candidate A      42% (↑3% this week)   $2.1M vol/24h
  Candidate B      35% (↓1% this week)   $1.8M vol/24h
  Candidate C      15% (—)               $450K vol/24h
  Other             8%                    $120K vol/24h

  Liquidity: $5.2M  |  Resolves: Nov 3, 2028
```

## Example Prompts

| User says | What the skill does |
|-----------|---------------------|
| "What are the odds on Iran strikes?" | Searches events by keyword, shows probabilities |
| "What's trending on Polymarket?" | Top events sorted by 24h volume |
| "Show me crypto prediction markets" | Filters by `crypto` tag |
| "How have Trump election odds moved?" | Price history + momentum fields |
| "Show me the orderbook for this market" | CLOB bid/ask depth |
| "What markets resolve this week?" | Sorted by endDate, filtered to upcoming |
| "What does the market think about the Fed?" | Keyword search + probability breakdown |

## Notes

- All public endpoints require **no API key** — just `curl` directly
- Event IDs are numeric strings, market IDs are also numeric strings
- `conditionId` is a hex hash used by CLOB and Data APIs
- Markets from restricted regions may have `restricted: true`
- Multi-outcome events have `enableNegRisk: true`; all Yes prices should sum to ~1.0
- If a search returns no results, try broader terms or check `/tags` for the right slug
