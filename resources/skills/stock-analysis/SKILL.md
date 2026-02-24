---
name: stock-analysis
description:
  Analyze stocks, ETFs, and crypto using Yahoo Finance and Alpha Vantage.
  Get real-time quotes, fundamentals, technical indicators, dividends, earnings,
  options chains, analyst ratings, institutional holders, sector comparisons, and screening.
metadata:
  {
    "cowork":
      {
        "emoji": "📈",
        "category": "Tools",
        "requires": { "anyBins": ["python3", "curl"] },
      },
  }
---

# Stock Analysis 📈

Comprehensive market intelligence for stocks, ETFs, indices, and crypto. Three data sources, zero to one API key, and a structured 8-dimensional scoring framework.

## Overview

| Source | Auth | Best For |
|--------|------|----------|
| **Yahoo Finance** (curl) | None | Real-time quotes, charts, price history |
| **yfinance** (Python) | None | Fundamentals, financials, options, earnings, holders, screening |
| **Alpha Vantage** | Free key | Technical indicators (RSI, MACD, Bollinger, SMA, etc.) |

All Yahoo Finance endpoints are free and unauthenticated. Alpha Vantage offers 25 free requests/day.

## Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `ticker` | string | No | — | Stock symbol (e.g., AAPL, BTC-USD, ^GSPC) |
| `analysis_type` | select | No | `full` | `full`, `technical`, `fundamental`, `compare`, `screen`, `dividends`, `options` |

## Install

```bash
# Optional but recommended — unlocks fundamentals, options, screener
pip install yfinance

# Optional — unlocks 50+ technical indicators
# Get free key at https://www.alphavantage.co/support/#api-key
mkdir -p ~/.config/alphavantage
echo "YOUR_KEY" > ~/.config/alphavantage/api_key
```

The skill works with just `curl` and `python3` (no pip packages required) for basic quotes and computed technicals.

## Capabilities

### Tier 1: curl only (no dependencies)

- Real-time stock/ETF/index/crypto quotes
- Historical OHLCV data (1m to max range)
- Pre-market and after-hours prices
- Basic technical indicators computed from price data (SMA, RSI, MACD)

### Tier 2: + yfinance

Everything in Tier 1 plus:
- Full company profile (sector, industry, description)
- Key statistics (P/E, EPS, margins, ROE, beta, short interest)
- Income statement, balance sheet, cash flow (annual + quarterly)
- Earnings history + estimates + surprise data
- Analyst recommendations + price targets
- Institutional and mutual fund holders
- Dividend history + splits
- Options chains with Greeks
- News feed
- Sector/industry data
- Stock screener with custom filters

### Tier 3: + Alpha Vantage

Everything in Tier 1-2 plus:
- 50+ technical indicators (RSI, MACD, Bollinger, Stochastic, ADX, OBV, CCI, Aroon, etc.)
- Symbol search
- Global market status

## Ticker Formats

| Type | Format | Example |
|------|--------|---------|
| US Stock | `AAPL` | Apple Inc. |
| ETF | `SPY` | S&P 500 ETF |
| Index | `^GSPC` | S&P 500 (URL-encode `^` as `%5E` in curl) |
| Crypto | `BTC-USD` | Bitcoin |
| Forex | `EURUSD=X` | EUR/USD |
| International | `7203.T` | Toyota (Tokyo) |
| UK Stock | `SHEL.L` | Shell (London) |

## 8-Dimensional Stock Score

The skill's signature feature — a structured scoring framework for evaluating any stock:

| # | Dimension | Key Metrics | Weight |
|---|-----------|-------------|--------|
| 1 | **Valuation** | P/E, Fwd P/E, PEG, P/S, P/B, EV/EBITDA | 15% |
| 2 | **Profitability** | Profit margin, ROE, ROA, operating margin | 15% |
| 3 | **Growth** | Revenue growth, EPS growth, earnings surprise | 15% |
| 4 | **Financial Health** | Debt/equity, current ratio, FCF, interest coverage | 12.5% |
| 5 | **Technical Momentum** | RSI, MACD, SMA crossovers, 52-week position | 12.5% |
| 6 | **Dividend Quality** | Yield, payout ratio, growth history, consistency | 10% |
| 7 | **Analyst Sentiment** | Buy/hold/sell, price target vs current, upgrades | 10% |
| 8 | **Risk** | Beta, short interest, volatility, sector risk | 10% |

Each dimension scored 1-10. Overall weighted score provided.

## Common Workflows

| User Says | What Happens |
|-----------|-------------|
| "Analyze AAPL" | Full report: quote + fundamentals + technicals + analyst + 8-dim score |
| "Compare AAPL vs MSFT" | Side-by-side table across all dimensions |
| "Best tech stocks under $50" | Screener with sector + price filters, sorted by key metric |
| "Should I buy TSLA?" | 8-dimensional score + bull/bear case + risks + conclusion |
| "How are my stocks doing?" | Portfolio review with P&L, diversification, beta |
| "What's moving today?" | Market scan: indices + sectors + unusual volume |
| "AAPL options chain" | Calls/puts by volume, strike, IV for nearest expiry |
| "KO dividend analysis" | Yield, growth history, payout sustainability, aristocrat status |
| "Is the market overbought?" | S&P RSI, VIX, breadth, sector rotation signals |

## Output Format

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

## API Reference

### Yahoo Finance Chart API (no auth)

```
GET https://query1.finance.yahoo.com/v8/finance/chart/{SYMBOL}
```

| Param | Values |
|-------|--------|
| `interval` | `1m`, `5m`, `15m`, `30m`, `1h`, `1d`, `1wk`, `1mo` |
| `range` | `1d`, `5d`, `1mo`, `3mo`, `6mo`, `1y`, `2y`, `5y`, `10y`, `ytd`, `max` |

### Alpha Vantage Technical Indicators

| Indicator | Function | Key Params |
|-----------|----------|------------|
| RSI | `RSI` | `time_period=14` |
| MACD | `MACD` | default 12/26/9 |
| Bollinger | `BBANDS` | `time_period=20` |
| SMA | `SMA` | `time_period=50` or `200` |
| EMA | `EMA` | `time_period=20` |
| Stochastic | `STOCH` | default |
| ADX | `ADX` | `time_period=14` |
| OBV | `OBV` | — |
| CCI | `CCI` | `time_period=20` |
| Aroon | `AROON` | `time_period=14` |

### yfinance Key Properties

| Property | Returns |
|----------|---------|
| `t.info` | Full profile + key stats (60+ fields) |
| `t.financials` | Annual income statement |
| `t.quarterly_financials` | Quarterly income statement |
| `t.balance_sheet` | Balance sheet |
| `t.cashflow` | Cash flow statement |
| `t.earnings_dates` | Upcoming/past earnings dates + estimates |
| `t.recommendations` | Analyst ratings history |
| `t.analyst_price_targets` | Low/mean/median/high targets |
| `t.institutional_holders` | Top institutional holders |
| `t.mutualfund_holders` | Top mutual fund holders |
| `t.major_holders` | Holder breakdown percentages |
| `t.dividends` | Dividend history |
| `t.splits` | Stock split history |
| `t.options` | Available expiration dates |
| `t.option_chain(date)` | Calls + puts for an expiration |
| `t.news` | Recent news articles |

## Comparison with ClawHub Version

| Feature | ClawHub (v6.2.0) | CoWork OS |
|---------|-------------------|-----------|
| Data sources | Yahoo Finance | **Yahoo Finance + yfinance + Alpha Vantage** (3 tiers) |
| Real-time quotes | Yes | Yes — **stocks, ETFs, indices, crypto, forex, international** |
| Fundamentals | Unknown depth | **60+ fields**: P/E, EPS, margins, ROE, D/E, FCF, and more |
| Financial statements | Not mentioned | **Income, balance sheet, cash flow** (annual + quarterly) |
| Technical indicators | Not mentioned | **50+ via Alpha Vantage** + computed RSI/MACD/SMA from raw data |
| Options chains | Not mentioned | **Full chains**: strikes, Greeks, IV, volume, OI |
| Earnings | Not mentioned | **History + estimates + surprise + upcoming dates** |
| Institutional holders | Not mentioned | **Top institutional + mutual fund holders** |
| Analyst ratings | Not mentioned | **Recommendations + price targets (low/mean/median/high)** |
| Stock screening | Not mentioned | **yfinance EquityQuery**: filter by any metric, custom sorts |
| 8-dim scoring | "8-dimensional scoring" | **Detailed framework**: 8 dimensions with weights, metrics, and 1-10 guidelines |
| Hot Scanner | "Viral trend detection" | **Market scan workflow** with index + sector + volume analysis |
| Watchlist alerts | Yes | Via scheduled tasks in CoWork OS |
| Dividend analysis | Yes | **Full workflow**: yield, growth CAGR, payout ratio, aristocrat status, FCF coverage |
| Crypto | Yes | **BTC-USD format** + 24/7 market awareness |
| Portfolio review | Yes | **P&L per position + total + diversification + beta** |
| Computed technicals | Not mentioned | **RSI, MACD, SMA from raw price data** (no API key needed) |
| Parameters | Unknown | **`ticker` + `analysis_type`** (7 options) |
| Common workflows | Unknown | **9 detailed recipes** |

## Notes

- Yahoo Finance chart API requires no auth — works with plain `curl`
- yfinance requires `pip install yfinance` but unlocks the richest data
- Alpha Vantage free tier: 25 requests/day
- After-hours: `meta.postMarketPrice`, Pre-market: `meta.preMarketPrice`
- Crypto trades 24/7; stock markets have specific hours
- Always note: informational only, not financial advice
