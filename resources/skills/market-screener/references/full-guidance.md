# Market Screening Request

**Asset Class:** {{assetClass}}
**Screening Criteria:** {{criteria}}
**Question:** {{question}}

**Market:** {{market}}
**Max Results:** {{maxResults}}

Using the market screening framework below, build and execute a screen based on the specified criteria. Rank results by composite score and provide rationale for each match.

---

# Market Screening Reference

## Fundamental Screening Criteria

### Valuation Metrics

| Metric | Formula | Value Zone | Growth Zone | Expensive Zone |
|--------|---------|-----------|-------------|----------------|
| P/E Ratio | Price / EPS | < 15x | 15-25x | > 25x |
| Forward P/E | Price / Forward EPS | < 12x | 12-20x | > 20x |
| PEG Ratio | P/E / EPS Growth Rate | < 1.0 | 1.0-2.0 | > 2.0 |
| P/B Ratio | Price / Book Value per Share | < 1.5 | 1.5-4.0 | > 4.0 |
| P/S Ratio | Price / Revenue per Share | < 2.0 | 2.0-6.0 | > 6.0 |
| EV/EBITDA | Enterprise Value / EBITDA | < 10x | 10-18x | > 18x |
| EV/Revenue | Enterprise Value / Revenue | < 3x | 3-8x | > 8x |
| FCF Yield | Free Cash Flow / Market Cap | > 8% | 4-8% | < 4% |
| Earnings Yield | EPS / Price (1/PE) | > 7% | 4-7% | < 4% |
| Dividend Yield | Annual Dividend / Price | > 3% | 1-3% | < 1% |

### Profitability Metrics

| Metric | Formula | Excellent | Good | Poor |
|--------|---------|-----------|------|------|
| ROE | Net Income / Shareholders' Equity | > 20% | 10-20% | < 10% |
| ROIC | NOPAT / Invested Capital | > 15% | 8-15% | < 8% |
| ROA | Net Income / Total Assets | > 10% | 5-10% | < 5% |
| Gross Margin | (Revenue - COGS) / Revenue | > 60% | 30-60% | < 30% |
| Operating Margin | EBIT / Revenue | > 20% | 10-20% | < 10% |
| Net Margin | Net Income / Revenue | > 15% | 5-15% | < 5% |
| FCF Margin | Free Cash Flow / Revenue | > 15% | 5-15% | < 5% |

### Growth Metrics

| Metric | Strong Growth | Moderate | Slow |
|--------|-------------|----------|------|
| Revenue Growth (YoY) | > 20% | 5-20% | < 5% |
| EPS Growth (YoY) | > 20% | 5-20% | < 5% |
| Revenue Growth (3Y CAGR) | > 15% | 5-15% | < 5% |
| EPS Growth (3Y CAGR) | > 15% | 5-15% | < 5% |
| FCF Growth (YoY) | > 15% | 5-15% | < 5% |
| Book Value Growth | > 10% | 3-10% | < 3% |

### Financial Health

| Metric | Formula | Strong | Adequate | Weak |
|--------|---------|--------|----------|------|
| Debt/Equity | Total Debt / Total Equity | < 0.5 | 0.5-1.5 | > 1.5 |
| Net Debt/EBITDA | (Debt - Cash) / EBITDA | < 1.0 | 1.0-3.0 | > 3.0 |
| Interest Coverage | EBIT / Interest Expense | > 8x | 3-8x | < 3x |
| Current Ratio | Current Assets / Current Liabilities | > 2.0 | 1.0-2.0 | < 1.0 |
| Quick Ratio | (Cash + Receivables) / Current Liabilities | > 1.5 | 0.7-1.5 | < 0.7 |

## Technical Screening Criteria

### Moving Average Signals

| Signal | Condition | Interpretation |
|--------|-----------|----------------|
| Golden Cross | 50-day SMA crosses above 200-day SMA | Bullish trend confirmation |
| Death Cross | 50-day SMA crosses below 200-day SMA | Bearish trend confirmation |
| Above 200 SMA | Price > 200-day SMA | Long-term uptrend |
| Above 50 SMA | Price > 50-day SMA | Medium-term uptrend |
| SMA Alignment | 20 > 50 > 100 > 200 SMA | Strong uptrend structure |

### Momentum Indicators

| Indicator | Oversold | Neutral | Overbought |
|-----------|----------|---------|------------|
| RSI (14-day) | < 30 | 30-70 | > 70 |
| Stochastic %K | < 20 | 20-80 | > 80 |
| Williams %R | < -80 | -80 to -20 | > -20 |

### MACD Signals

- **Bullish crossover:** MACD line crosses above signal line
- **Bearish crossover:** MACD line crosses below signal line
- **Histogram positive/negative:** Confirms momentum direction
- **Divergence:** Price makes new high/low but MACD does not (reversal signal)

### Volume Signals

| Signal | Condition | Meaning |
|--------|-----------|--------|
| Volume surge | Volume > 2x 20-day average | Institutional activity |
| Accumulation | Price up on above-avg volume | Buying pressure |
| Distribution | Price down on above-avg volume | Selling pressure |
| OBV rising | On-Balance Volume trending up | Accumulation confirmed |

## Quality Factor Screens

### Piotroski F-Score (0-9)

A composite score of 9 binary signals measuring financial strength:

**Profitability (0-4 points):**
1. ROA > 0 (positive net income)
2. Operating Cash Flow > 0
3. ROA increasing year-over-year
4. Cash flow from operations > Net Income (accrual quality)

**Leverage & Liquidity (0-3 points):**
5. Long-term debt ratio decreasing
6. Current ratio increasing
7. No new share issuance (dilution)

**Operating Efficiency (0-2 points):**
8. Gross margin increasing
9. Asset turnover increasing

| Score | Interpretation | Action |
|-------|---------------|--------|
| 8-9 | Strong financial position | Buy candidates |
| 5-7 | Average | Hold / Further analysis |
| 0-4 | Weak financial position | Avoid / Short candidates |

### Altman Z-Score (Manufacturing)

Z = 1.2(WC/TA) + 1.4(RE/TA) + 3.3(EBIT/TA) + 0.6(MVE/TL) + 1.0(Sales/TA)

| Z-Score | Zone | Probability of Default |
|---------|------|------------------------|
| > 2.99 | Safe | Very low |
| 1.81-2.99 | Grey | Moderate |
| < 1.81 | Distress | High |

### Beneish M-Score (Earnings Manipulation Detection)

M = -4.84 + 0.92(DSRI) + 0.528(GMI) + 0.404(AQI) + 0.892(SGI) + 0.115(DEPI) - 0.172(SGAI) + 4.679(TATA) - 0.327(LVGI)

| M-Score | Interpretation |
|---------|----------------|
| > -1.78 | Likely earnings manipulation |
| < -1.78 | Unlikely manipulation |

## Pre-Built Screen Templates

### Value Screen
- P/E < 15
- P/B < 2.0
- Dividend Yield > 2%
- Debt/Equity < 1.0
- Piotroski F-Score >= 6
- Market Cap > $1B

### Growth Screen
- Revenue Growth (3Y CAGR) > 15%
- EPS Growth (3Y CAGR) > 15%
- ROE > 15%
- PEG < 2.0
- Operating Margin > 10%
- Relative Strength (52-week) > 0 (outperforming market)

### Quality Screen
- ROIC > 15%
- Gross Margin > 40%
- FCF Margin > 10%
- Debt/Equity < 0.5
- Revenue Growth > 5%
- Piotroski F-Score >= 7
- Altman Z-Score > 3.0

### Dividend Income Screen
- Dividend Yield > 3%
- Dividend Growth (5Y CAGR) > 5%
- Payout Ratio < 60%
- Debt/Equity < 1.0
- FCF Yield > Dividend Yield (sustainable payout)
- Consecutive Dividend Increases > 10 years

### Momentum Screen
- RSI (14) between 50-70
- Price > 200-day SMA
- 52-week relative strength > 80th percentile
- Volume > 20-day average
- Positive MACD crossover in last 10 days

## GICS Sector Classification

| Sector | Sub-Industries | Typical P/E | Typical EV/EBITDA |
|--------|---------------|------------|-------------------|
| Technology | Software, Hardware, Semis, IT Services | 20-35x | 15-25x |
| Healthcare | Pharma, Biotech, MedTech, Services | 15-30x | 12-20x |
| Financials | Banks, Insurance, Asset Mgmt, Fintech | 10-15x | N/A (use P/B) |
| Consumer Discretionary | Retail, Auto, Hospitality, Apparel | 15-25x | 10-18x |
| Consumer Staples | Food, Beverage, Household, Tobacco | 18-25x | 12-16x |
| Industrials | Aerospace, Machinery, Transport, Defense | 15-22x | 10-15x |
| Energy | Oil & Gas, Refining, Pipelines, Renewables | 8-15x | 5-10x |
| Materials | Chemicals, Mining, Metals, Paper | 10-18x | 7-12x |
| Utilities | Electric, Gas, Water, Renewables | 15-20x | 10-14x |
| Real Estate | REITs, Developers, Services | 15-25x | 15-20x (use FFO) |
| Communication Services | Telecom, Media, Entertainment, Social | 15-25x | 10-18x |

## Multi-Factor Ranking Methodology

1. **Normalize** each metric to a 0-100 percentile score within the universe
2. **Weight** factors by category importance (e.g., Value 30%, Quality 30%, Momentum 20%, Growth 20%)
3. **Composite Score** = Σ (Factor Score x Factor Weight)
4. **Rank** securities by composite score, highest first
5. **Filter** by minimum thresholds on any hard constraints (e.g., market cap > $500M)
