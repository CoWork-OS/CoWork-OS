# Risk Analysis Request

**Portfolio:** {{portfolio}}
**Risk Metric:** {{riskMetric}}
**Question:** {{question}}

**Confidence Level:** {{confidence}}
**Time Horizon:** {{horizon}}

Using the risk analysis framework below, perform a comprehensive risk assessment of this portfolio. Calculate the requested metrics, identify key risk exposures, and provide actionable risk management recommendations.

---

# Portfolio Risk Analysis Reference

## Value at Risk (VaR)

VaR answers: "What is the maximum loss at a given confidence level over a specified time horizon?"

### Method 1: Parametric (Variance-Covariance) VaR

**Single Asset:**
VaR = μ - zα x σ

Where:
- μ = Expected return over horizon
- zα = Z-score for confidence level
- σ = Standard deviation over horizon

**Z-scores by confidence level:**
| Confidence | Z-score |
|-----------|--------|
| 90% | 1.282 |
| 95% | 1.645 |
| 99% | 2.326 |

**Portfolio VaR:**
VaR_p = zα x sqrt(w'Σw) x Portfolio Value

Where w'Σw = portfolio variance from covariance matrix Σ.

**Time scaling:** VaR_T = VaR_1day x sqrt(T)
(Assumes i.i.d. returns; use with caution for horizons > 10 days)

**Assumptions and limitations:**
- Assumes normal distribution (underestimates tail risk)
- Linear approximation (poor for options/nonlinear instruments)
- Works best for short horizons and liquid portfolios

### Method 2: Historical Simulation VaR

**Process:**
1. Collect historical returns for all portfolio assets (250-1000+ days)
2. Apply current portfolio weights to historical returns
3. Sort portfolio returns from worst to best
4. VaR at α% confidence = the (1-α) x N th worst return
   - Example: 95% VaR with 1000 days = 50th worst day

**Advantages:** No distributional assumptions, captures fat tails and correlations naturally
**Disadvantages:** Limited by historical sample, assumes past represents future

### Method 3: Monte Carlo VaR

**Process:**
1. Estimate return distribution parameters (μ, Σ) or use factor model
2. Generate 10,000-100,000 random scenarios using Geometric Brownian Motion:
   S_t = S_0 x exp((μ - σ²/2)t + σ x W_t)
   Where W_t = standard Brownian motion (random walk)
3. Calculate portfolio value for each scenario
4. Sort results and find the (1-α) percentile

**Can incorporate:**
- Fat tails (Student-t distribution with 4-6 degrees of freedom)
- Skewness (skewed normal or Johnson distribution)
- Regime switching (different parameters for bull/bear markets)
- Non-linear payoffs (options, structured products)

## Conditional VaR (CVaR) / Expected Shortfall

CVaR = E[Loss | Loss > VaR]

The average loss in the worst (1-α)% of scenarios. More informative than VaR because it describes the severity of tail losses.

**Parametric CVaR (normal distribution):**
CVaR = μ + σ x φ(zα) / (1 - α)

Where φ(zα) = standard normal PDF evaluated at the z-score.

| Confidence | VaR (% of σ) | CVaR (% of σ) | CVaR/VaR Ratio |
|-----------|-------------|---------------|----------------|
| 90% | 1.28σ | 1.76σ | 1.37x |
| 95% | 1.65σ | 2.06σ | 1.25x |
| 99% | 2.33σ | 2.67σ | 1.15x |

**Key insight:** If CVaR is much higher than VaR (ratio > 1.5x), the portfolio has significant tail risk beyond what VaR captures.

## Maximum Drawdown Analysis

**Maximum Drawdown (MDD):**
MDD = (Trough Value - Peak Value) / Peak Value

**Drawdown Duration:**
- Drawdown period: Peak to trough
- Recovery period: Trough to new peak
- Total underwater period: Peak to next new peak

### Historical Drawdowns (S&P 500)

| Event | Period | Drawdown | Recovery Time |
|-------|--------|----------|---------------|
| 2008 Global Financial Crisis | Oct 2007 - Mar 2009 | -56.8% | ~4.5 years |
| 2000 Dot-Com Bust | Mar 2000 - Oct 2002 | -49.1% | ~7 years |
| 2020 COVID Crash | Feb 2020 - Mar 2020 | -33.9% | ~5 months |
| 2022 Rate Shock | Jan 2022 - Oct 2022 | -25.4% | ~2 years |
| 2018 Q4 Selloff | Sep 2018 - Dec 2018 | -19.8% | ~4 months |
| 1987 Black Monday | Aug 1987 - Dec 1987 | -33.5% | ~2 years |

### Calmar Ratio

Calmar Ratio = Annualized Return / |Maximum Drawdown|

| Calmar | Interpretation |
|--------|----------------|
| < 0.5 | Poor drawdown-adjusted returns |
| 0.5-1.0 | Acceptable |
| 1.0-2.0 | Good |
| > 2.0 | Excellent |

## Stress Testing

### Historical Scenario Replay

Apply historical factor shocks to current portfolio:

| Scenario | Equities | Bonds | Credit | Commodities | USD |
|----------|----------|-------|--------|-------------|-----|
| 2008 GFC (6 months) | -45% | +10% | -20% | -55% | +15% |
| 2020 COVID (1 month) | -34% | +5% | -15% | -30% | +8% |
| 2022 Rate Shock (9 months) | -25% | -15% | -12% | +20% | +12% |
| 2013 Taper Tantrum | -5% | -8% | -5% | -10% | +5% |
| Euro Crisis 2011 | -19% | +8% | -15% | -15% | +3% |
| Oil Crash 2014-15 | -12% | +5% | -8% | -60% | +20% |

### Hypothetical Scenarios

| Scenario | Description | Key Shocks |
|----------|-------------|------------|
| Rate Spike +200bps | Rapid tightening | Bonds -10 to -15%, Growth stocks -20%, Value +5% |
| Recession | GDP contracts 2%+ | Equities -30%, HY -15%, Treasuries +15%, Gold +20% |
| Stagflation | High inflation + low growth | Equities -20%, Bonds -10%, Commodities +30%, TIPS +10% |
| USD Crisis | Dollar loses reserve status | USD -30%, Gold +50%, Intl equities +20% |
| Geopolitical Shock | Major conflict | Equities -15%, Oil +50%, Gold +15%, Treasuries +5% |
| Tech Bubble Pop | AI/tech reversal | Nasdaq -40%, S&P -20%, Value +5%, Bonds +10% |

## Factor Exposure Analysis

### Fama-French Five-Factor Model

R - Rf = α + β1(MKT-Rf) + β2(SMB) + β3(HML) + β4(RMW) + β5(CMA) + ε

Where:
- MKT-Rf = Market excess return (market risk)
- SMB = Small Minus Big (size factor)
- HML = High Minus Low (value factor)
- RMW = Robust Minus Weak (profitability factor)
- CMA = Conservative Minus Aggressive (investment factor)

### Factor Risk Premiums (Historical Annualized)

| Factor | Premium | Volatility | Sharpe |
|--------|---------|-----------|--------|
| Market (MKT) | 5-7% | 15-17% | 0.35-0.45 |
| Size (SMB) | 2-3% | 10-12% | 0.15-0.25 |
| Value (HML) | 3-5% | 10-13% | 0.25-0.40 |
| Profitability (RMW) | 3-4% | 8-10% | 0.30-0.45 |
| Investment (CMA) | 2-4% | 7-9% | 0.25-0.40 |
| Momentum (WML) | 5-8% | 14-18% | 0.30-0.50 |

### Interpreting Factor Exposures

| β Value | Exposure Level | Implication |
|---------|---------------|-------------|
| > 1.5 | Very High | Concentrated bet on this factor |
| 1.0-1.5 | High | Significant tilt |
| 0.5-1.0 | Moderate | Some exposure |
| 0-0.5 | Low | Minimal exposure |
| < 0 | Negative | Betting against this factor |

## Additional Risk Metrics

| Metric | Formula | Use |
|--------|---------|-----|
| Beta | Cov(Rp, Rm) / Var(Rm) | Systematic risk |
| Tracking Error | std(Rp - Rb) | Active risk vs benchmark |
| Information Ratio | (Rp - Rb) / TE | Active return per unit active risk |
| Downside Deviation | std(min(Ri - T, 0)) | Risk of underperformance |
| Sortino Ratio | (Rp - T) / Downside Dev | Downside risk-adjusted return |
| Ulcer Index | sqrt(mean(DD²)) | Depth and duration of drawdowns |
| Tail Ratio | |P95 return| / |P5 return| | Upside vs downside tail |

## Risk Budgeting Guidelines

| Risk Budget Allocation | Conservative | Moderate | Aggressive |
|-----------------------|-------------|----------|------------|
| Max Drawdown Tolerance | 10-15% | 15-25% | 25-40% |
| Annual Volatility Target | 5-8% | 8-14% | 14-22% |
| VaR (95%, 1-month) | 2-4% | 4-7% | 7-12% |
| Max Single Position | 5-10% | 10-20% | 20-30% |
| Max Sector Exposure | 15-25% | 25-35% | 35-50% |
