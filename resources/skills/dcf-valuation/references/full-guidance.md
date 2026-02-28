# DCF Valuation Request

**Company:** {{company}}
**Projection Period:** {{projectionYears}} years
**Question:** {{question}}

**Assumptions (if provided):**
- Revenue Growth: {{revenueGrowth}}
- EBITDA Margin: {{ebitdaMargin}}
- WACC: {{wacc}}
- Terminal Growth Rate: {{terminalGrowthRate}}

Using the DCF valuation framework below, build a complete discounted cash flow analysis for this company. If assumptions are provided, incorporate them into the model. Otherwise, derive reasonable assumptions from industry benchmarks.

---

# Discounted Cash Flow Valuation Reference

## Core Principle

The intrinsic value of any asset is the present value of its expected future cash flows, discounted at a rate that reflects the riskiness of those cash flows.

**Enterprise Value = PV(Free Cash Flows) + PV(Terminal Value)**

## Step 1: Free Cash Flow Projection

### Unlevered Free Cash Flow (UFCF) Formula

UFCF = EBIT x (1 - Tax Rate) + D&A - CapEx - Change in Net Working Capital

Alternatively:
UFCF = EBITDA x (1 - Tax Rate) + D&A x Tax Rate - CapEx - Change in NWC

### Revenue Build Methodology

**Top-Down Approach:**
1. Total Addressable Market (TAM) sizing
2. Serviceable Addressable Market (SAM) = TAM x geographic/segment filters
3. Market share trajectory over projection period
4. Revenue = SAM x Market Share x Average Selling Price

**Bottom-Up Approach:**
1. Existing customer base x retention rate x ARPU growth
2. Plus: New customer additions x ramp ARPU
3. Less: Churned customer revenue
4. Total = Retained Revenue + Expansion + New Revenue - Churned Revenue

### Operating Model Drivers

| Line Item | Typical Driver | Benchmark Range |
|-----------|---------------|----------------|
| COGS | % of revenue | 20-60% (varies by industry) |
| Gross Margin | 1 - COGS% | 40-80% (SaaS: 70-85%) |
| R&D | % of revenue | 10-25% (tech: 15-25%) |
| S&M | % of revenue | 15-40% (SaaS: 20-50%) |
| G&A | % of revenue | 8-15% |
| EBITDA Margin | derived | 15-35% at maturity |
| D&A | % of revenue or PP&E | 2-8% of revenue |
| CapEx | % of revenue | 3-10% (asset-light: 2-5%) |
| NWC Change | % of revenue change | 5-15% of incremental revenue |

### Projection Table Format

| Year | Revenue | Growth % | EBITDA | EBITDA % | EBIT | Tax | NOPAT | D&A | CapEx | ΔNWC | UFCF |
|------|---------|----------|--------|----------|------|-----|-------|-----|-------|------|------|
| 1 | | | | | | | | | | | |
| 2 | | | | | | | | | | | |
| ... | | | | | | | | | | | |
| N | | | | | | | | | | | |

## Step 2: Weighted Average Cost of Capital (WACC)

### WACC Formula

WACC = (E / (E + D)) x Re + (D / (E + D)) x Rd x (1 - T)

Where:
- E = Market value of equity
- D = Market value of debt
- Re = Cost of equity
- Rd = Cost of debt (pre-tax)
- T = Corporate tax rate

### Cost of Equity via CAPM

Re = Rf + β x (Rm - Rf) + Size Premium + Country Risk Premium

Where:
- Rf = Risk-free rate (10Y Treasury yield; typically 3.5-5.0%)
- β = Levered beta (regression vs market index)
- Rm - Rf = Equity risk premium (typically 4.5-6.0%, Damodaran estimate)
- Size premium = 0-3% for smaller companies (Duff & Phelps data)

**Beta Adjustments:**
- Unlevered Beta: βu = βl / (1 + (1 - T) x (D/E))
- Re-levered Beta: βl = βu x (1 + (1 - T) x (D/E))
- Bloomberg adjustment: Adjusted β = 0.67 x Raw β + 0.33 x 1.0

### Cost of Debt

Rd = Risk-free rate + Credit spread

| Credit Rating | Spread (bps) | Implied Rd |
|--------------|-------------|------------|
| AAA | 40-60 | 4.0-4.6% |
| AA | 60-100 | 4.1-5.0% |
| A | 100-150 | 4.5-5.5% |
| BBB | 150-250 | 5.0-6.5% |
| BB | 250-400 | 6.0-8.0% |
| B | 400-600 | 7.5-10.0% |

### WACC Benchmarks by Sector

| Sector | Typical WACC Range |
|--------|-------------------|
| Technology | 8-12% |
| Healthcare | 7-10% |
| Consumer Staples | 6-8% |
| Financials | 8-11% |
| Industrials | 7-10% |
| Energy | 8-12% |
| Utilities | 5-7% |
| Real Estate | 6-9% |

## Step 3: Terminal Value

### Method 1: Gordon Growth Model (Perpetuity Growth)

TV = FCF_n x (1 + g) / (WACC - g)

Where:
- FCF_n = Free cash flow in the last projection year
- g = Perpetual growth rate (typically 2-3%, should not exceed long-term GDP growth)
- WACC = Weighted average cost of capital

**Sanity check:** Terminal value typically represents 60-80% of total enterprise value. If >85%, consider extending projection period or questioning assumptions.

### Method 2: Exit Multiple

TV = EBITDA_n x Exit Multiple

Or: TV = Revenue_n x Exit Multiple

| Sector | EV/EBITDA Range | EV/Revenue Range |
|--------|----------------|------------------|
| SaaS (high growth) | 20-40x | 8-15x |
| SaaS (mature) | 12-20x | 4-8x |
| Technology | 12-25x | 3-8x |
| Healthcare | 10-18x | 2-5x |
| Consumer | 8-14x | 1-3x |
| Industrials | 7-12x | 1-2x |
| Financial Services | 8-14x | 2-5x |

**Best practice:** Use both methods and cross-check. Implied perpetuity growth from exit multiple: g = WACC - (FCF_n / TV)

## Step 4: Enterprise Value Calculation

### Discount Factor

Discount Factor_n = 1 / (1 + WACC)^n

**Mid-year convention:** Discount Factor_n = 1 / (1 + WACC)^(n - 0.5)
Use mid-year convention to reflect that cash flows are received throughout the year, not at year-end.

### Enterprise Value

EV = Σ (UFCF_n x DF_n) + (TV x DF_terminal)

## Step 5: Enterprise Value to Equity Value Bridge

Equity Value = Enterprise Value
  - Net Debt (Total Debt - Cash & Equivalents)
  - Preferred Stock (at liquidation value)
  - Minority / Non-Controlling Interests
  + Equity Method Investments / Associates
  - Pension & Lease Obligations (if not in debt)
  - Contingent Liabilities (if material)

**Per Share Value** = Equity Value / Fully Diluted Shares Outstanding

Fully diluted shares = Basic shares + In-the-money options (Treasury Stock Method) + Convertible securities (if-converted method) + RSU/PSU shares

## Step 6: Sensitivity Analysis

### WACC vs Terminal Growth Rate

| WACC \ g | 1.5% | 2.0% | 2.5% | 3.0% | 3.5% |
|----------|------|------|------|------|------|
| 7.0% | $XX | $XX | $XX | $XX | $XX |
| 8.0% | $XX | $XX | $XX | $XX | $XX |
| 9.0% | $XX | $XX | $XX | $XX | $XX |
| 10.0% | $XX | $XX | $XX | $XX | $XX |
| 11.0% | $XX | $XX | $XX | $XX | $XX |

### WACC vs Exit Multiple

| WACC \ Multiple | 8x | 10x | 12x | 14x | 16x |
|-----------------|-----|------|------|------|------|
| 7.0% | $XX | $XX | $XX | $XX | $XX |
| 8.0% | $XX | $XX | $XX | $XX | $XX |
| 9.0% | $XX | $XX | $XX | $XX | $XX |
| 10.0% | $XX | $XX | $XX | $XX | $XX |
| 11.0% | $XX | $XX | $XX | $XX | $XX |

### Revenue Growth vs EBITDA Margin

| Growth \ Margin | 15% | 20% | 25% | 30% | 35% |
|-----------------|------|------|------|------|------|
| 5% | $XX | $XX | $XX | $XX | $XX |
| 10% | $XX | $XX | $XX | $XX | $XX |
| 15% | $XX | $XX | $XX | $XX | $XX |
| 20% | $XX | $XX | $XX | $XX | $XX |
| 25% | $XX | $XX | $XX | $XX | $XX |

## Common Pitfalls

1. **Terminal value dominance:** If TV > 80% of EV, extend projection period
2. **Growth > WACC:** Model breaks; terminal growth must be < WACC
3. **Negative FCF extrapolation:** Ensure company reaches positive FCF before terminal year
4. **Ignoring reinvestment:** Mature growth requires ROIC > WACC; g = Reinvestment Rate x ROIC
5. **Stale beta:** Use 2-5 year weekly returns; consider peer group median
6. **Double counting:** Don't subtract operating leases from both UFCF and equity bridge
7. **Currency mismatch:** Match cash flow currency with discount rate currency
