# Portfolio Optimization Request

**Current Holdings:** {{holdings}}
**Objective:** {{objective}}
**Question:** {{question}}

**Constraints (if provided):** {{constraints}}
**Target Return (if provided):** {{targetReturn}}

Using the portfolio optimization framework below, analyze the portfolio and recommend an optimal allocation. Apply the specified objective function and any constraints. If historical data is not provided, use reasonable estimates based on asset class benchmarks.

---

# Portfolio Optimization Reference

## Core Concepts

**The fundamental insight of portfolio theory:** Diversification can reduce risk without proportionally reducing return. The risk of a portfolio depends not just on individual asset risks, but on the correlations between assets.

**Portfolio Return:** Rp = Σ wi x Ri (weighted average of asset returns)

**Portfolio Variance:** σp² = Σ Σ wi x wj x σi x σj x ρij = w'Σw

Where Σ is the variance-covariance matrix.

## Method 1: Markowitz Mean-Variance Optimization

### Optimization Problem

**Minimize portfolio variance:**
min w'Σw
subject to:
- w'μ >= target return (return constraint)
- w'1 = 1 (fully invested)
- wi >= 0 for all i (long-only, if applicable)

**Or maximize Sharpe Ratio:**
max (w'μ - Rf) / sqrt(w'Σw)
subject to:
- w'1 = 1
- wi >= 0 for all i

### Efficient Frontier Construction

1. Find the Minimum Variance Portfolio (MVP): min w'Σw s.t. w'1 = 1
2. Find the Maximum Return Portfolio: max w'μ s.t. w'1 = 1
3. For target returns between MVP and max: solve min w'Σw s.t. w'μ = target, w'1 = 1
4. Plot risk (σp) vs return (Rp) for each solution

### Sharpe Ratio

SR = (Rp - Rf) / σp

| Sharpe Ratio | Interpretation |
|-------------|----------------|
| < 0 | Asset underperforms risk-free rate |
| 0 - 0.5 | Poor risk-adjusted return |
| 0.5 - 1.0 | Adequate |
| 1.0 - 2.0 | Good |
| 2.0 - 3.0 | Very good |
| > 3.0 | Exceptional (verify data) |

### Historical Asset Class Returns and Volatility

| Asset Class | Annual Return | Annual Volatility | Sharpe Ratio |
|------------|---------------|-------------------|-------------|
| US Large Cap (S&P 500) | 10-12% | 15-17% | 0.4-0.6 |
| US Small Cap (Russell 2000) | 11-13% | 19-22% | 0.4-0.5 |
| International Developed (EAFE) | 8-10% | 16-18% | 0.3-0.5 |
| Emerging Markets | 9-12% | 22-26% | 0.3-0.4 |
| US Aggregate Bonds | 4-6% | 4-6% | 0.3-0.5 |
| US Treasury (10Y) | 3-5% | 6-8% | 0.2-0.4 |
| High Yield Bonds | 6-8% | 8-12% | 0.3-0.5 |
| REITs | 8-11% | 18-22% | 0.3-0.4 |
| Commodities | 3-6% | 15-20% | 0.1-0.2 |
| Gold | 5-8% | 15-18% | 0.1-0.3 |

### Typical Correlation Matrix

| | US LC | US SC | Intl | EM | Bonds | HY | REITs | Cmdty | Gold |
|---|-------|-------|------|-----|-------|-----|-------|-------|------|
| US LC | 1.00 | 0.80 | 0.75 | 0.65 | -0.05 | 0.55 | 0.60 | 0.15 | 0.00 |
| US SC | 0.80 | 1.00 | 0.70 | 0.65 | -0.10 | 0.60 | 0.65 | 0.15 | -0.05 |
| Intl | 0.75 | 0.70 | 1.00 | 0.75 | 0.05 | 0.50 | 0.55 | 0.25 | 0.10 |
| EM | 0.65 | 0.65 | 0.75 | 1.00 | 0.00 | 0.55 | 0.50 | 0.30 | 0.10 |
| Bonds | -0.05 | -0.10 | 0.05 | 0.00 | 1.00 | 0.20 | 0.15 | -0.10 | 0.30 |
| HY | 0.55 | 0.60 | 0.50 | 0.55 | 0.20 | 1.00 | 0.55 | 0.20 | 0.05 |
| REITs | 0.60 | 0.65 | 0.55 | 0.50 | 0.15 | 0.55 | 1.00 | 0.15 | 0.10 |
| Cmdty | 0.15 | 0.15 | 0.25 | 0.30 | -0.10 | 0.20 | 0.15 | 1.00 | 0.35 |
| Gold | 0.00 | -0.05 | 0.10 | 0.10 | 0.30 | 0.05 | 0.10 | 0.35 | 1.00 |

## Method 2: Black-Litterman Model

Black-Litterman addresses the extreme sensitivity of Markowitz optimization to expected return inputs by combining market equilibrium returns with investor views.

### Equilibrium Returns (Market Implied)

π = δ x Σ x w_mkt

Where:
- π = Implied equilibrium excess returns
- δ = Risk aversion coefficient (typically 2.5)
- Σ = Covariance matrix
- w_mkt = Market capitalization weights

### Incorporating Views

**View structure:** P x μ = Q + ε, where ε ~ N(0, Ω)
- P = Pick matrix (identifies assets in the view)
- Q = Expected returns from views
- Ω = Uncertainty of views (diagonal matrix)

### Combined Return Estimate

μ_BL = [(τΣ)^(-1) + P'Ω^(-1)P]^(-1) x [(τΣ)^(-1)π + P'Ω^(-1)Q]

Where:
- τ = Scalar (typically 0.025 to 0.05, represents uncertainty in equilibrium)
- All other variables as defined above

### Combined Covariance

Σ_BL = Σ + [(τΣ)^(-1) + P'Ω^(-1)P]^(-1)

**Advantages over Markowitz:**
1. More stable, intuitive allocations
2. Starts from equilibrium (market portfolio) as anchor
3. Views are optional and uncertainty-weighted
4. Avoids extreme corner solutions

## Method 3: Risk Parity

### Principle

Each asset contributes equally to total portfolio risk.

**Risk contribution of asset i:**
RC_i = wi x (Σw)_i / σp

**Target:** RC_i = RC_j for all i, j (equal risk contribution)

**Simplified for uncorrelated assets:** wi = (1/σi) / Σ(1/σj)

### Typical Risk Parity Allocation

| Asset Class | Traditional 60/40 | Risk Parity |
|------------|-------------------|-------------|
| Equities | 60% | 20-25% |
| Fixed Income | 40% | 50-60% |
| Commodities | 0% | 10-15% |
| TIPS/Real Assets | 0% | 10-15% |
| **Risk Contribution** | Equity: ~90% | Equal: ~25% each |

**Note:** Risk parity often uses leverage to scale returns to target, since the unlevered portfolio has lower expected returns than traditional allocations.

## Method 4: Maximum Diversification

### Diversification Ratio

DR = (w'σ) / sqrt(w'Σw)

Maximize this ratio to find the most diversified portfolio. Higher DR means more diversification benefit captured.

## Constraint Types

| Constraint | Formulation | Purpose |
|-----------|-------------|---------|
| Long-only | wi >= 0 | No short selling |
| Fully invested | Σwi = 1 | 100% allocation |
| Max position | wi <= max% | Concentration limit |
| Min position | wi >= min% or wi = 0 | Avoid trivial positions |
| Sector limit | Σ wi (sector j) <= limit | Sector diversification |
| Turnover | Σ |wi_new - wi_old| <= limit | Trading cost control |
| Tracking error | sqrt((w-wb)'Σ(w-wb)) <= limit | Benchmark deviation |
| Beta | w'β <= target | Market exposure control |

## Portfolio Performance Metrics

| Metric | Formula | Target |
|--------|---------|--------|
| Sharpe Ratio | (Rp - Rf) / σp | > 0.5 |
| Sortino Ratio | (Rp - Rf) / σ_downside | > 1.0 |
| Calmar Ratio | Annual Return / Max Drawdown | > 0.5 |
| Information Ratio | (Rp - Rb) / Tracking Error | > 0.5 |
| Treynor Ratio | (Rp - Rf) / βp | Compare vs peers |
| Maximum Drawdown | max peak-to-trough decline | < 20% conservative |
| Beta | Cov(Rp, Rm) / Var(Rm) | Depends on mandate |
| Alpha (Jensen's) | Rp - [Rf + β(Rm - Rf)] | > 0 |

## Rebalancing Framework

**Calendar-based:** Quarterly or semi-annual rebalancing
**Threshold-based:** Rebalance when any position drifts >5% from target
**Cost-aware:** Rebalance only if expected benefit > transaction costs + tax impact

**Rebalancing Bands:**
- Tight (2-3%): Higher tracking precision, higher costs
- Normal (5%): Good balance of precision and cost
- Wide (10%): Lower costs, more drift tolerance
