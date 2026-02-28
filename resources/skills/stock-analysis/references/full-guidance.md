# Stock Analysis — Market Intelligence

Analyze stocks, ETFs, indices, and crypto using free public APIs. Two data sources:

| Source | Auth | Best For |
|--------|------|----------|
| **Yahoo Finance** (via curl or yfinance) | None | Real-time quotes, charts, fundamentals, options, news |
| **Alpha Vantage** | Free API key | Technical indicators, historical data, forex, screening |

---

## Method 1: Yahoo Finance (curl — no dependencies)

### Real-time quote + key stats

```bash
curl -s 'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=1d' | python3 -c "
import json, sys
d = json.load(sys.stdin)['chart']['result'][0]
m = d['meta']
print(f'{m["symbol"]} — {m.get("longName", m["symbol"])}')
print(f'Price: \${m["regularMarketPrice"]:.2f}')
print(f'Prev Close: \${m["chartPreviousClose"]:.2f}')
chg = m['regularMarketPrice'] - m['chartPreviousClose']
pct = (chg / m['chartPreviousClose']) * 100
arrow = '↑' if chg > 0 else '↓' if chg < 0 else '—'
print(f'Change: {arrow} \${abs(chg):.2f} ({abs(pct):.2f}%)')
print(f'Day Range: \${m["regularMarketDayLow"]:.2f} – \${m["regularMarketDayHigh"]:.2f}')
print(f'52-Week: \${m["fiftyTwoWeekLow"]:.2f} – \${m["fiftyTwoWeekHigh"]:.2f}')
print(f'Volume: {m["regularMarketVolume"]:,}')
"
```

### Historical price data

```bash
# Intervals: 1m, 5m, 15m, 30m, 1h, 1d, 1wk, 1mo
# Ranges: 1d, 5d, 1mo, 3mo, 6mo, 1y, 2y, 5y, 10y, ytd, max
curl -s 'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=6mo'
```

### Multiple quotes at once

```bash
curl -s 'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=1d' \
     -s 'https://query1.finance.yahoo.com/v8/finance/chart/MSFT?interval=1d&range=1d' \
     -s 'https://query1.finance.yahoo.com/v8/finance/chart/GOOGL?interval=1d&range=1d'
```

### Crypto quotes

Crypto tickers use the format `SYMBOL-USD`:

```bash
curl -s 'https://query1.finance.yahoo.com/v8/finance/chart/BTC-USD?interval=1d&range=1d'
curl -s 'https://query1.finance.yahoo.com/v8/finance/chart/ETH-USD?interval=1d&range=5d'
curl -s 'https://query1.finance.yahoo.com/v8/finance/chart/SOL-USD?interval=1d&range=1mo'
```

### Index quotes

```bash
curl -s 'https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d&range=5d'   # S&P 500
curl -s 'https://query1.finance.yahoo.com/v8/finance/chart/%5EIXIC?interval=1d&range=5d'   # NASDAQ
curl -s 'https://query1.finance.yahoo.com/v8/finance/chart/%5EDJI?interval=1d&range=5d'    # Dow Jones
curl -s 'https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=5d'    # VIX
curl -s 'https://query1.finance.yahoo.com/v8/finance/chart/%5EFTSE?interval=1d&range=5d'   # FTSE 100
```

Note: `^` must be URL-encoded as `%5E` in curl.

---

## Method 2: yfinance (Python — richer data)

Install: `pip install yfinance`

### Full company profile + key stats

```bash
python3 -c "
import yfinance as yf
t = yf.Ticker('AAPL')
i = t.info
print(f'{i.get("shortName", "")} ({i["symbol"]})')
print(f'Sector: {i.get("sector", "N/A")} | Industry: {i.get("industry", "N/A")}')
print(f'Price: \${i.get("currentPrice", 0):.2f}  Mkt Cap: \${i.get("marketCap", 0)/1e9:.1f}B')
print(f'P/E: {i.get("trailingPE", "N/A")}  Fwd P/E: {i.get("forwardPE", "N/A")}')
print(f'EPS (TTM): \${i.get("trailingEps", "N/A")}  Fwd EPS: \${i.get("forwardEps", "N/A")}')
print(f'PEG: {i.get("pegRatio", "N/A")}  P/S: {i.get("priceToSalesTrailing12Months", "N/A"):.2f}')
print(f'P/B: {i.get("priceToBook", "N/A")}  EV/EBITDA: {i.get("enterpriseToEbitda", "N/A")}')
print(f'Div Yield: {(i.get("dividendYield", 0) or 0)*100:.2f}%  Payout: {(i.get("payoutRatio", 0) or 0)*100:.1f}%')
print(f'Beta: {i.get("beta", "N/A")}  52-Week: \${i.get("fiftyTwoWeekLow", 0):.2f} – \${i.get("fiftyTwoWeekHigh", 0):.2f}')
print(f'Revenue: \${i.get("totalRevenue", 0)/1e9:.1f}B  Profit Margin: {(i.get("profitMargins", 0) or 0)*100:.1f}%')
print(f'ROE: {(i.get("returnOnEquity", 0) or 0)*100:.1f}%  ROA: {(i.get("returnOnAssets", 0) or 0)*100:.1f}%')
print(f'Debt/Equity: {i.get("debtToEquity", "N/A")}  Current Ratio: {i.get("currentRatio", "N/A")}')
print(f'Free Cash Flow: \${i.get("freeCashflow", 0)/1e9:.1f}B')
print(f'Shares Outstanding: {i.get("sharesOutstanding", 0)/1e9:.2f}B')
print(f'Float Short: {(i.get("shortPercentOfFloat", 0) or 0)*100:.2f}%')
"
```

### Financial statements

```bash
python3 -c "
import yfinance as yf
t = yf.Ticker('AAPL')
print('=== Income Statement (Annual) ===')
print(t.financials.to_string())
print('\n=== Balance Sheet ===')
print(t.balance_sheet.to_string())
print('\n=== Cash Flow ===')
print(t.cashflow.to_string())
"
```

### Quarterly financials

```bash
python3 -c "
import yfinance as yf
t = yf.Ticker('AAPL')
print(t.quarterly_financials.to_string())
"
```

### Earnings history + estimates

```bash
python3 -c "
import yfinance as yf
t = yf.Ticker('AAPL')
print('=== Earnings History ===')
print(t.earnings_history.to_string() if hasattr(t, 'earnings_history') else 'N/A')
print('\n=== Earnings Dates ===')
print(t.earnings_dates.to_string())
print('\n=== Analyst Price Targets ===')
for k, v in t.analyst_price_targets.items():
    print(f'  {k}: \${v:.2f}' if isinstance(v, (int, float)) else f'  {k}: {v}')
"
```

### Analyst recommendations

```bash
python3 -c "
import yfinance as yf
t = yf.Ticker('AAPL')
print('=== Recommendations ===')
print(t.recommendations.tail(10).to_string())
print('\n=== Recommendation Summary ===')
print(t.recommendations_summary.to_string() if t.recommendations_summary is not None else 'N/A')
"
```

### Institutional & major holders

```bash
python3 -c "
import yfinance as yf
t = yf.Ticker('AAPL')
print('=== Major Holders ===')
print(t.major_holders.to_string())
print('\n=== Top Institutional Holders ===')
print(t.institutional_holders.head(15).to_string())
print('\n=== Mutual Fund Holders ===')
print(t.mutualfund_holders.head(10).to_string())
"
```

### Dividends & splits

```bash
python3 -c "
import yfinance as yf
t = yf.Ticker('AAPL')
print('=== Dividends (last 20) ===')
print(t.dividends.tail(20).to_string())
print('\n=== Splits ===')
print(t.splits.to_string())
"
```

### Options chain

```bash
python3 -c "
import yfinance as yf
t = yf.Ticker('AAPL')
print('Expiration dates:', t.options)
opt = t.option_chain(t.options[0])  # nearest expiry
print('\n=== Calls (top 10 by volume) ===')
print(opt.calls.sort_values('volume', ascending=False).head(10)[['strike','lastPrice','bid','ask','volume','openInterest','impliedVolatility']].to_string())
print('\n=== Puts (top 10 by volume) ===')
print(opt.puts.sort_values('volume', ascending=False).head(10)[['strike','lastPrice','bid','ask','volume','openInterest','impliedVolatility']].to_string())
"
```

### News

```bash
python3 -c "
import yfinance as yf
t = yf.Ticker('AAPL')
for n in t.news[:10]:
    print(f'  {n.get("title", "")}  —  {n.get("publisher", "")}')
    print(f'  {n.get("link", "")}')
    print()
"
```

### Sector & industry comparison

```bash
python3 -c "
import yfinance as yf
s = yf.Sector('technology')
print('=== Technology Sector Overview ===')
print(f'Symbol: {s.symbol}')
print(f'Name: {s.name}')
print(s.overview.to_string() if s.overview is not None else '')
print('\n=== Top Industries ===')
print(s.industries.head(10).to_string() if s.industries is not None else '')
"
```

### Stock screener

```bash
python3 -c "
import yfinance as yf
from yfinance import EquityQuery, Screener

# Example: large-cap tech with P/E under 30
q = EquityQuery('and', [
    EquityQuery('gt', ['intradaymarketcap', 100_000_000_000]),
    EquityQuery('lt', ['peratio.lasttwelvemonths', 30]),
    EquityQuery('eq', ['sector', 'Technology']),
])
sc = Screener()
sc.set_body(q, sortField='intradaymarketcap', sortAsc=False)
result = sc.response
for quote in result.get('quotes', [])[:15]:
    print(f'{quote["symbol"]:8s} {quote.get("shortName",""):30s} PE:{quote.get("trailingPE","N/A"):>8} MCap:{quote.get("marketCap",0)/1e9:>8.1f}B')
"
```

---

## Method 3: Alpha Vantage (free API key)

Get a free key at https://www.alphavantage.co/support/#api-key

Store it:
```bash
mkdir -p ~/.config/alphavantage
echo "YOUR_KEY" > ~/.config/alphavantage/api_key
```

### Real-time quote

```bash
AV_KEY=$(cat ~/.config/alphavantage/api_key 2>/dev/null || echo 'demo')
curl -s "https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=AAPL&apikey=$AV_KEY" | python3 -c "
import json, sys
d = json.load(sys.stdin).get('Global Quote', {})
print(f'{d.get("01. symbol", "")}  \${d.get("05. price", "")}  Chg: {d.get("09. change", "")} ({d.get("10. change percent", "")})')
"
```

### Technical indicators

```bash
AV_KEY=$(cat ~/.config/alphavantage/api_key 2>/dev/null || echo 'demo')

# RSI
curl -s "https://www.alphavantage.co/query?function=RSI&symbol=AAPL&interval=daily&time_period=14&series_type=close&apikey=$AV_KEY"

# MACD
curl -s "https://www.alphavantage.co/query?function=MACD&symbol=AAPL&interval=daily&series_type=close&apikey=$AV_KEY"

# Bollinger Bands
curl -s "https://www.alphavantage.co/query?function=BBANDS&symbol=AAPL&interval=daily&time_period=20&series_type=close&apikey=$AV_KEY"

# SMA (50-day and 200-day)
curl -s "https://www.alphavantage.co/query?function=SMA&symbol=AAPL&interval=daily&time_period=50&series_type=close&apikey=$AV_KEY"
curl -s "https://www.alphavantage.co/query?function=SMA&symbol=AAPL&interval=daily&time_period=200&series_type=close&apikey=$AV_KEY"

# EMA
curl -s "https://www.alphavantage.co/query?function=EMA&symbol=AAPL&interval=daily&time_period=20&series_type=close&apikey=$AV_KEY"

# Stochastic
curl -s "https://www.alphavantage.co/query?function=STOCH&symbol=AAPL&interval=daily&apikey=$AV_KEY"

# ADX (trend strength)
curl -s "https://www.alphavantage.co/query?function=ADX&symbol=AAPL&interval=daily&time_period=14&apikey=$AV_KEY"

# OBV (On-Balance Volume)
curl -s "https://www.alphavantage.co/query?function=OBV&symbol=AAPL&interval=daily&apikey=$AV_KEY"
```

### Symbol search

```bash
AV_KEY=$(cat ~/.config/alphavantage/api_key 2>/dev/null || echo 'demo')
curl -s "https://www.alphavantage.co/query?function=SYMBOL_SEARCH&keywords=tesla&apikey=$AV_KEY"
```

### Market status

```bash
AV_KEY=$(cat ~/.config/alphavantage/api_key 2>/dev/null || echo 'demo')
curl -s "https://www.alphavantage.co/query?function=MARKET_STATUS&apikey=$AV_KEY"
```

---

## Computed Technical Analysis (No API key)

When Alpha Vantage isn't configured, compute indicators from Yahoo Finance price data:

```bash
python3 -c "
import json, urllib.request

symbol = 'AAPL'
url = f'https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1d&range=6mo'
with urllib.request.urlopen(url) as r:
    data = json.load(r)

result = data['chart']['result'][0]
closes = result['indicators']['quote'][0]['close']
closes = [c for c in closes if c is not None]

# SMA
def sma(data, n): return sum(data[-n:]) / n if len(data) >= n else None

# RSI (14-day)
def rsi(data, n=14):
    deltas = [data[i] - data[i-1] for i in range(1, len(data))]
    gains = [d if d > 0 else 0 for d in deltas[-n:]]
    losses = [-d if d < 0 else 0 for d in deltas[-n:]]
    avg_gain = sum(gains) / n
    avg_loss = sum(losses) / n
    if avg_loss == 0: return 100
    rs = avg_gain / avg_loss
    return 100 - (100 / (1 + rs))

# MACD
def ema(data, n):
    k = 2 / (n + 1)
    result = [data[0]]
    for price in data[1:]:
        result.append(price * k + result[-1] * (1 - k))
    return result

ema12 = ema(closes, 12)
ema26 = ema(closes, 26)
macd_line = ema12[-1] - ema26[-1]
signal = ema([e12 - e26 for e12, e26 in zip(ema12[-9:], ema26[-9:])], 9)[-1] if len(closes) >= 35 else None

print(f'{symbol} Technical Summary')
print(f'Price:    \${closes[-1]:.2f}')
print(f'SMA 20:   \${sma(closes, 20):.2f}' if sma(closes, 20) else '')
print(f'SMA 50:   \${sma(closes, 50):.2f}' if sma(closes, 50) else '')
print(f'SMA 200:  \${sma(closes, 200):.2f}' if sma(closes, 200) else 'SMA 200: N/A (need more data)')
print(f'RSI (14): {rsi(closes):.1f}')
print(f'MACD:     {macd_line:.3f}')
if signal: print(f'Signal:   {signal:.3f}')

# Position relative to SMAs
if sma(closes, 50) and sma(closes, 200):
    if sma(closes, 50) > sma(closes, 200): print('Trend: Golden Cross (bullish)')
    else: print('Trend: Death Cross (bearish)')
if rsi(closes) > 70: print('RSI: Overbought')
elif rsi(closes) < 30: print('RSI: Oversold')
else: print(f'RSI: Neutral')
"
```

---

## 8-Dimensional Stock Score

When asked to score or rate a stock, evaluate across these 8 dimensions:

| # | Dimension | Key Metrics | Weight |
|---|-----------|-------------|--------|
| 1 | **Valuation** | P/E, Fwd P/E, PEG, P/S, P/B, EV/EBITDA | 15% |
| 2 | **Profitability** | Profit margin, ROE, ROA, operating margin | 15% |
| 3 | **Growth** | Revenue growth, EPS growth, earnings surprise | 15% |
| 4 | **Financial Health** | Debt/equity, current ratio, free cash flow, interest coverage | 12.5% |
| 5 | **Technical Momentum** | RSI, MACD, SMA crossovers, 52-week position | 12.5% |
| 6 | **Dividend Quality** | Yield, payout ratio, growth history, consistency | 10% |
| 7 | **Analyst Sentiment** | Buy/hold/sell ratings, price target vs current, upgrades/downgrades | 10% |
| 8 | **Risk** | Beta, short interest, volatility, sector risk | 10% |

Score each dimension 1-10. Provide an overall weighted score.

### Scoring guidelines

**Valuation (1-10):**
- 9-10: Deeply undervalued (P/E < 10, PEG < 0.5)
- 7-8: Moderately undervalued
- 5-6: Fairly valued
- 3-4: Moderately overvalued
- 1-2: Extremely overvalued (P/E > 50, PEG > 3)

**Profitability (1-10):**
- 9-10: Exceptional (ROE > 30%, margins > 25%)
- 7-8: Strong
- 5-6: Average
- 3-4: Below average
- 1-2: Unprofitable

**Growth (1-10):**
- 9-10: Hyper growth (>30% revenue + earnings growth)
- 7-8: Strong growth (15-30%)
- 5-6: Moderate (5-15%)
- 3-4: Slow (<5%)
- 1-2: Declining

**Financial Health (1-10):**
- 9-10: Fortress balance sheet (D/E < 0.3, strong FCF)
- 7-8: Healthy
- 5-6: Adequate
- 3-4: Leveraged
- 1-2: Distressed

---

## Common Workflows

### "Analyze AAPL for me"

1. Fetch real-time quote (Yahoo chart API)
2. Fetch full profile with yfinance (P/E, margins, growth, etc.)
3. Compute technical indicators (RSI, MACD, SMA)
4. Get analyst recommendations and price targets
5. Check recent news
6. Run the 8-dimensional score
7. Present a structured report

### "Compare AAPL vs MSFT"

1. Fetch both profiles
2. Side-by-side: price, market cap, P/E, margins, growth, dividends
3. Technical comparison (RSI, trend)
4. Analyst consensus comparison
5. Table format with winner per category

### "What are the best tech stocks under $50?"

1. Use yfinance Screener with EquityQuery
2. Filter: sector=Technology, price < 50, marketCap > 1B
3. Sort by a meaningful metric (P/E, growth, volume)
4. Present top 10-15 with key stats

### "Should I buy TSLA?"

1. Full 8-dimensional analysis
2. Bull case vs bear case (from fundamentals + technicals)
3. Analyst consensus and price target range
4. Key risks (beta, short interest, valuation)
5. Clear conclusion with confidence level

### "How are my stocks doing?" (portfolio review)

1. User provides tickers (and optionally cost basis)
2. Fetch current prices for all
3. Calculate P&L per position and total
4. Highlight biggest winners/losers
5. Portfolio-level metrics (diversification, beta, dividend yield)

### "What's moving today?" (market scan)

1. Fetch major indices (S&P 500, NASDAQ, Dow, VIX)
2. Identify sectors leading/lagging
3. Note any earnings reports today
4. Show biggest volume spikes or unusual moves

### "Show me the options chain for AAPL"

1. Fetch options via yfinance
2. Show expiration dates
3. Display calls/puts sorted by volume
4. Highlight unusual activity (high volume vs open interest)
5. Show implied volatility

### "Dividend analysis for KO"

1. Current yield, payout ratio, ex-dividend date
2. Dividend growth history (5yr, 10yr CAGR)
3. Dividend aristocrat/king status
4. Payout sustainability (FCF coverage)
5. Compare yield to sector average

### "Is the market overbought?"

1. S&P 500 RSI, MACD, distance from 200-day SMA
2. VIX level and trend
3. Advance/decline breadth
4. Sector rotation signals
5. Put/call ratio context

---

## Common Ticker Formats

| Type | Format | Example |
|------|--------|----------|
| US Stock | `AAPL` | Apple Inc. |
| ETF | `SPY` | S&P 500 ETF |
| Index | `^GSPC` | S&P 500 |
| Crypto | `BTC-USD` | Bitcoin |
| Forex | `EURUSD=X` | EUR/USD |
| Intl Stock | `7203.T` | Toyota (Tokyo) |
| UK Stock | `SHEL.L` | Shell (London) |

---

## Formatting Guidelines

When presenting financial data:

- **Prices**: `$272.18` — always 2 decimal places
- **Market cap**: `$3.4T`, `$125.6B`, `$2.1B` — human-readable
- **Percentages**: `12.5%` — 1 decimal place
- **Ratios**: P/E `28.5`, P/B `12.3` — 1 decimal
- **Volume**: `45.2M shares` — abbreviated
- **Changes**: `↑ $3.42 (+1.27%)` or `↓ $1.15 (-0.82%)`
- **52-week position**: show as a visual bar when possible
- **Color coding** (in description): bullish = positive language, bearish = cautionary
- **Always show data freshness**: "As of market close Feb 24, 2026"

### Example report format

```
📈 AAPL — Apple Inc.
   $272.18  ↑ $4.42 (+1.65%)  |  Vol: 45.2M
   52-Week: $169.21 ———————●——— $288.62

   Fundamentals
   Mkt Cap: $4.1T    P/E: 33.2    Fwd P/E: 28.5
   EPS: $8.20        Rev: $394.3B  Margin: 26.1%
   ROE: 157.4%       D/E: 1.87     FCF: $101.2B
   Div Yield: 0.44%  Beta: 1.24    Short: 0.65%

   Technical
   RSI (14): 58.3 (neutral)  |  MACD: +1.23 (bullish)
   Above 50-day SMA ($265) ✓  |  Above 200-day SMA ($232) ✓
   Trend: Golden Cross (bullish)

   Analyst Consensus
   Strong Buy (28) | Buy (8) | Hold (5) | Sell (1)
   Target: $245 – $320 (median $290)

   Score: 7.8/10
   Valuation: 5 | Profitability: 9 | Growth: 7 | Health: 6
   Momentum: 7 | Dividends: 4 | Sentiment: 8 | Risk: 6
```

---

## Notes

- **Yahoo Finance chart API** requires no auth — works with plain curl
- **yfinance** provides the richest data but needs `pip install yfinance`
- **Alpha Vantage** free tier: 25 requests/day — use for technical indicators when yfinance isn't available
- **Yahoo Finance may rate-limit** heavy usage — space requests when processing many tickers
- **After-hours prices** are in `meta.postMarketPrice` (Yahoo chart API)
- **Pre-market prices** are in `meta.preMarketPrice`
- **Options data** requires yfinance — not available via the chart API
- **Financial statements** require yfinance — not available via the chart API
- Crypto markets trade 24/7; stock markets have specific hours
- Always note that this is **informational, not financial advice**
