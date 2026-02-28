# Polymarket — Prediction Market Intelligence

Query the world's largest prediction market. All public endpoints require **no authentication**.

## Three APIs

| API | Base URL | Purpose |
|-----|----------|----------|
| **Gamma** | `https://gamma-api.polymarket.com` | Events, markets, search, tags, series, sports |
| **CLOB** | `https://clob.polymarket.com` | Prices, orderbooks, spreads, midpoints, trade history |
| **Data** | `https://data-api.polymarket.com` | Positions, open interest, holders, analytics |

## Rate Limits

15,000 requests per 10 seconds globally. Some endpoints (e.g. `/events`) have tighter limits (~500 req/10s).

---

## Gamma API — Discovery & Search

### Search events (natural language)

```bash
curl -s 'https://gamma-api.polymarket.com/events?limit=10&active=true&closed=false&order=volume24hr&ascending=false&tag=all' | jq '.[].title'
```

### Search by keyword

Use the `title_contains` parameter:

```bash
curl -s 'https://gamma-api.polymarket.com/events?title_contains=trump&active=true&closed=false&limit=10' | jq '.[] | {title, id, volume24hr}'
```

### Get trending markets (highest 24h volume)

```bash
curl -s 'https://gamma-api.polymarket.com/events?limit=10&active=true&closed=false&order=volume24hr&ascending=false' | jq '.[] | {title, volume24hr: (.volume24hr | tostring + " USD"), markets: [.markets[] | {question, yes_price: (.outcomePrices | fromjson)[0], no_price: (.outcomePrices | fromjson)[1]}]}'
```

### Get trending by liquidity

```bash
curl -s 'https://gamma-api.polymarket.com/events?limit=10&active=true&closed=false&order=liquidity&ascending=false' | jq '.[] | {title, liquidity}'
```

### Filter by category / tag

Common tags: `politics`, `crypto`, `sports`, `pop-culture`, `science`, `business`, `ai`, `tech`

```bash
curl -s 'https://gamma-api.polymarket.com/events?limit=10&active=true&closed=false&tag=politics&order=volume24hr&ascending=false'
```

### Get a single event by ID or slug

```bash
curl -s 'https://gamma-api.polymarket.com/events/{event_id}'
curl -s 'https://gamma-api.polymarket.com/events?slug={event_slug}'
```

### Get a single market by ID

```bash
curl -s 'https://gamma-api.polymarket.com/markets/{market_id}'
```

### List all tags

```bash
curl -s 'https://gamma-api.polymarket.com/tags' | jq '.[].label'
```

### List series (recurring event groups like NBA, NFL)

```bash
curl -s 'https://gamma-api.polymarket.com/series?active=true' | jq '.[] | {title, slug}'
```

### Gamma query parameters reference

| Param | Type | Description |
|-------|------|-------------|
| `limit` | int | Max results (default 100) |
| `offset` | int | Pagination offset |
| `active` | bool | Only active events |
| `closed` | bool | Filter by closed status |
| `archived` | bool | Filter by archived status |
| `order` | string | Sort field: `volume24hr`, `volume1wk`, `volume1mo`, `liquidity`, `startDate`, `endDate`, `createdAt` |
| `ascending` | bool | Sort direction |
| `tag` | string | Filter by tag slug |
| `title_contains` | string | Search within titles |
| `slug` | string | Exact slug match |
| `id` | string | Exact ID match |

---

## CLOB API — Prices & Orderbooks

### Get current price for a market

Each market has two `clobTokenIds` — index 0 = Yes token, index 1 = No token.

```bash
# Get price for a specific token
curl -s 'https://clob.polymarket.com/price?token_id={clob_token_id}&side=buy'
```

Response: `{"price": "0.62"}`

### Get prices for multiple tokens

```bash
curl -s -X POST 'https://clob.polymarket.com/prices' \
  -H 'Content-Type: application/json' \
  -d '[{"token_id": "{token_id_1}"}, {"token_id": "{token_id_2}"}]'
```

### Get orderbook

```bash
curl -s 'https://clob.polymarket.com/book?token_id={clob_token_id}' | jq '{bids: .bids[:5], asks: .asks[:5]}'
```

Response shape:
```json
{
  "bids": [{"price": "0.61", "size": "1500.00"}],
  "asks": [{"price": "0.63", "size": "800.00"}]
}
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

---

## Data API — Analytics

### Get open interest for a market

```bash
curl -s 'https://data-api.polymarket.com/oi?market={condition_id}'
```

### Get top holders of a market token

```bash
curl -s 'https://data-api.polymarket.com/holders?token_id={clob_token_id}&limit=10'
```

### Get recent trades

```bash
curl -s 'https://data-api.polymarket.com/trades?market={condition_id}&limit=20'
```

---

## Reading Market Data

### Understanding prices

Prices are **implied probabilities** between 0 and 1:
- Yes price = 0.72 means the market implies a **72% chance** the event happens
- No price = 0.28 means **28% chance** it doesn't (always sums to ~1.0)
- Prices come from `outcomePrices` field as a JSON string: `"[\"0.72\", \"0.28\"]"`

### Understanding volume

- `volume` — total all-time volume in USD
- `volume24hr` — last 24 hours volume
- `volume1wk` / `volume1mo` / `volume1yr` — rolling windows
- High volume = high confidence / interest

### Understanding liquidity

- `liquidity` — current total liquidity available
- `liquidityClob` — liquidity in the CLOB orderbook
- Higher liquidity = tighter spreads, less slippage

### Price momentum fields

Market objects include built-in momentum:
- `oneHourPriceChange` — 1h change
- `oneDayPriceChange` — 24h change
- `oneWeekPriceChange` — 7d change
- `oneMonthPriceChange` — 30d change
- `oneYearPriceChange` — 1y change
- `bestBid` / `bestAsk` — current top of book
- `lastTradePrice` — most recent trade
- `spread` — current bid-ask spread

---

## Multi-Outcome Events (Negative Risk)

Some events have multiple markets (e.g., "Who will win the 2028 election?" with separate markets for each candidate). These use `enableNegRisk: true`.

For these:
- Each market is a separate Yes/No binary
- The `negRiskOther` flag marks "Other" catch-all markets
- All Yes prices across markets in the event should sum to ~1.0

---

## Common Workflows

### "What are the odds on X?"

1. Search: `GET /events?title_contains=X&active=true&closed=false`
2. Extract `outcomePrices` from the matching market
3. Parse: `JSON.parse(outcomePrices)` → `[yesPrice, noPrice]`
4. Report: "The market gives X a {yesPrice * 100}% chance"

### "What's trending right now?"

1. `GET /events?limit=10&active=true&closed=false&order=volume24hr&ascending=false`
2. Show titles + 24h volume + current Yes prices

### "How has the price moved?"

1. Get market from Gamma for the `conditionId` and `clobTokenIds`
2. Use the momentum fields (`oneDayPriceChange`, `oneWeekPriceChange`, etc.)
3. For full chart data: `GET /prices-history?market={conditionId}&interval=1w&fidelity=60`

### "Show me the orderbook"

1. Get `clobTokenIds` from the market object (JSON string array — parse it)
2. `GET /book?token_id={yesTokenId}` for the Yes orderbook
3. Show top 5 bids and asks with sizes

### "What markets are resolving soon?"

1. `GET /events?active=true&closed=false&order=endDate&ascending=true&limit=20`
2. Filter where `endDate` is within the next 7 days
3. Show title + endDate + current odds

### "Show me markets in category X"

1. `GET /events?tag={category_slug}&active=true&closed=false&order=volume24hr&ascending=false&limit=10`
2. Common slugs: `politics`, `crypto`, `sports`, `pop-culture`, `science`, `business`

---

## Formatting Guidelines

When presenting market data to users:

- **Prices as percentages**: Show `0.72` as **72%**, not raw decimals
- **Volume in human-readable format**: `$1.2M` not `1234567.89`
- **Spread**: Show as cents — `$0.02 spread` or `2¢ spread`
- **Price changes**: Use arrows — `↑ 5%` or `↓ 3%` with the change amount
- **Confidence signals**: High volume + high liquidity + tight spread = reliable price
- **Always include the event title** for context, not just the market ID
- **Show resolution date** when relevant so users know the timeline
- **Multi-outcome events**: Present as a ranked list with percentages summing to ~100%

### Example output format

```
📊 US Presidential Election 2028

  Candidate A      42% (↑3% this week)   $2.1M vol/24h
  Candidate B      35% (↓1% this week)   $1.8M vol/24h
  Candidate C      15% (—)               $450K vol/24h
  Other             8%                    $120K vol/24h

  Liquidity: $5.2M  |  Resolves: Nov 3, 2028
```

---

## Notes

- All public endpoints require **no API key** — just `curl` them directly
- `clobTokenIds` is stored as a JSON string, not an array — always `JSON.parse()` it first
- `outcomePrices` is also a JSON string — parse before reading
- `outcomes` is a JSON string like `"[\"Yes\", \"No\"]"` — parse it
- Event IDs are numeric strings, market IDs are also numeric strings
- `conditionId` is a hex hash used by the CLOB and Data APIs
- Rate limit: stay under ~1,500 req/s to be safe
- Markets from restricted regions may have `restricted: true`
- When searching, try both `title_contains` on events and keyword variations
- If a search returns no results, try broader terms or check `/tags` for the right slug
