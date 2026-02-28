# Financial Modeling Request

**Model Type:** {{modelType}}
**Company:** {{company}}
**Question:** {{question}}

**Additional Context (if provided):**
- Historical Data: {{historicalData}}
- Assumptions: {{assumptions}}

Using the financial modeling framework below, build or analyze the requested model. Incorporate any provided data and assumptions. Where data is missing, use industry benchmarks and clearly state all assumptions.

---

# Three-Statement Financial Modeling Reference

## Core Architecture

A three-statement model links the income statement, balance sheet, and cash flow statement so that a change in any driver cascades through all three statements automatically.

**Flow of Logic:**
1. Revenue drivers feed the Income Statement
2. Income Statement flows into Retained Earnings on the Balance Sheet
3. Balance Sheet changes drive the Cash Flow Statement
4. Cash Flow Statement feeds back into the Balance Sheet (cash balance)
5. Debt balances feed interest expense back into the Income Statement (circular reference)

## Income Statement Build

### Revenue Build Approaches

**Volume x Price:**
- Units sold x Average Selling Price
- Segment by product line, geography, or customer type

**Cohort-Based (SaaS/subscription):**
- Beginning customers + New - Churned = Ending customers
- Revenue = Ending Customers x ARPU
- Include expansion revenue from upsells

**Same-Store + New:**
- Existing locations x SSS growth %
- Plus: New location count x Average Unit Volume x Ramp factor

**Backlog/Pipeline:**
- Beginning backlog + New orders - Deliveries = Ending backlog
- Revenue recognized from deliveries

### Income Statement Structure

| Line Item | Driver | Notes |
|-----------|--------|-------|
| Revenue | Model-specific build | See approaches above |
| COGS | % of revenue or unit cost | Split fixed/variable when possible |
| **Gross Profit** | Revenue - COGS | Target: 40-80% depending on industry |
| R&D | % of revenue | Tech: 15-25%, Pharma: 15-20% |
| Sales & Marketing | % of revenue | SaaS: 20-50%, Consumer: 10-20% |
| G&A | % of revenue, partially fixed | 8-15% of revenue |
| **EBITDA** | GP - OpEx | |
| D&A | % of PP&E or revenue | Linked to CapEx schedule |
| **EBIT** | EBITDA - D&A | |
| Interest Expense | Avg Debt x Interest Rate | Circular with debt schedule |
| Interest Income | Avg Cash x Yield | |
| **EBT** | EBIT - Net Interest | |
| Taxes | EBT x Effective Tax Rate | 21% US federal + state |
| **Net Income** | EBT - Taxes | |
| EPS | Net Income / Diluted Shares | Treasury stock method for options |

## Balance Sheet Build

### Working Capital Drivers

| Item | Driver | Formula | Benchmark |
|------|--------|---------|----------|
| Accounts Receivable | Days Sales Outstanding (DSO) | Revenue / 365 x DSO | 30-60 days |
| Inventory | Days Inventory Outstanding (DIO) | COGS / 365 x DIO | 30-90 days |
| Prepaid Expenses | % of OpEx | | 1-3% |
| Accounts Payable | Days Payable Outstanding (DPO) | COGS / 365 x DPO | 30-60 days |
| Accrued Expenses | % of OpEx | | 5-10% |
| Deferred Revenue | % of revenue | Common in SaaS | 5-20% |

**Net Working Capital = Current Assets (ex-cash) - Current Liabilities (ex-debt)**
**Change in NWC = NWC_current - NWC_prior** (increase = cash outflow)

### Fixed Asset Schedule

| Item | Formula |
|------|--------|
| Beginning PP&E | Prior year ending PP&E |
| + Capital Expenditures | % of revenue (maintenance + growth) |
| - Depreciation | Straight-line over useful life |
| - Asset Disposals | If applicable |
| = Ending PP&E | |

**CapEx benchmarks:**
- Maintenance CapEx: ~D&A (keeps asset base steady)
- Growth CapEx: Additional investment for expansion
- Asset-light (SaaS): 2-5% of revenue
- Asset-heavy (manufacturing): 8-15% of revenue

### Debt Schedule

| Item | Formula |
|------|--------|
| Beginning Debt | Prior year ending debt |
| + New Borrowings | From financing assumptions |
| - Mandatory Repayments | Amortization schedule |
| - Optional Prepayments | Cash sweep or strategic |
| = Ending Debt | |
| Interest Expense | Average Debt x Interest Rate |

### Balance Sheet Structure

**Assets = Liabilities + Equity** (must always balance)

Cash is typically the plug: if the model generates excess cash, it accumulates; if cash goes negative, a revolver draws.

## Cash Flow Statement Build

### Operating Activities (Indirect Method)

Net Income
+ D&A (add back non-cash)
+ Stock-Based Compensation (add back non-cash)
- Gains on asset sales
+/- Changes in Working Capital
  - (Increase) / Decrease in AR
  - (Increase) / Decrease in Inventory
  - (Increase) / Decrease in Prepaid
  + Increase / (Decrease) in AP
  + Increase / (Decrease) in Accrued
  + Increase / (Decrease) in Deferred Revenue
= **Cash from Operations (CFO)**

### Investing Activities

- Capital Expenditures
- Acquisitions
+ Proceeds from asset sales
+ Proceeds from investment maturities
= **Cash from Investing (CFI)**

### Financing Activities

+ Debt Issuance
- Debt Repayment
+ Equity Issuance
- Share Repurchases
- Dividends Paid
= **Cash from Financing (CFF)**

**Net Change in Cash = CFO + CFI + CFF**
**Ending Cash = Beginning Cash + Net Change in Cash**

## Circular Reference Handling

The classic circularity: Interest Expense depends on Debt Balance, which depends on Cash, which depends on Net Income, which depends on Interest Expense.

**Resolution Methods:**
1. **Iterative calculation:** Enable iterative calculations (Excel: File > Options > Formulas > Enable iterative calculation; max iterations 100, max change 0.001)
2. **Copy-paste macro:** Calculate interest on beginning balance, then iterate
3. **Average balance method:** Interest = (Beginning Debt + Ending Debt) / 2 x Rate (most common)
4. **Prior period balance:** Use beginning-of-period debt (simplest, slightly less accurate)

## Scenario Analysis Framework

### Three-Scenario Model

| Driver | Bear Case | Base Case | Bull Case |
|--------|-----------|-----------|----------|
| Revenue Growth | -1 to +5% | +5 to +15% | +15 to +30% |
| Gross Margin | -200bps vs base | Industry median | +200bps vs base |
| OpEx Leverage | Flat margins | 50-100bps/yr improvement | 150-200bps/yr improvement |
| CapEx Intensity | +20% vs base | Management guidance | -10% vs base |
| Working Capital | +5 days DSO | Stable | -5 days DSO |
| Tax Rate | +2% vs base | Statutory rate | -2% vs base |

### Probability-Weighted Valuation

Expected Value = P(Bear) x Value_Bear + P(Base) x Value_Base + P(Bull) x Value_Bull

Typical weights: Bear 25%, Base 50%, Bull 25%

## Model Integrity Checks

1. **Balance sheet balances:** Assets = Liabilities + Equity (every period)
2. **Cash flow reconciliation:** Ending cash on CFS = Cash on BS
3. **Retained earnings:** Beginning RE + Net Income - Dividends = Ending RE
4. **Debt schedule ties:** Ending debt on schedule = Debt on BS
5. **Interest coverage:** EBIT / Interest Expense > 2x (solvency check)
6. **Revenue reasonableness:** Implied market share should be credible
7. **Margin trajectory:** Should converge to industry long-term averages

## Key Ratios to Output

| Category | Ratios |
|----------|--------|
| Profitability | Gross Margin, EBITDA Margin, Net Margin, ROE, ROA, ROIC |
| Liquidity | Current Ratio, Quick Ratio, Cash Ratio |
| Leverage | Debt/Equity, Debt/EBITDA, Interest Coverage |
| Efficiency | Asset Turnover, Inventory Turnover, DSO, DPO, CCC |
| Returns | ROIC = NOPAT / Invested Capital, ROE = NI / Equity |
| Growth | Revenue CAGR, EPS CAGR, FCF CAGR |
