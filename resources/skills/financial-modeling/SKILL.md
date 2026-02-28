---
name: financial-modeling
description: "Build and analyze three-statement financial models with integrated income statement, balance sheet, and cash flow projections, scenario analysis, and key driver assumptions."
---

# Financial Modeling

## Purpose

Build and analyze three-statement financial models with integrated income statement, balance sheet, and cash flow projections, scenario analysis, and key driver assumptions.

## Routing

- Use when: Use when the user asks about building a financial model, three-statement model, income statement projection, balance sheet forecasting, cash flow modeling, scenario analysis, or linking financial statements together.
- Do not use when: Do not use when the request is purely about valuation (use DCF Valuation), portfolio management, or non-financial-model analysis like earnings reviews.
- Outputs: Outcome from Financial Modeling: integrated three-statement model with driver assumptions, projected financials, scenario analysis, and model integrity checks.
- Success criteria: Returns a complete linked financial model with clearly stated assumptions, all three statements, working capital and debt schedules, scenario outputs, and balance checks.

## Trigger Examples

### Positive

- Use the financial-modeling skill for this request.
- Help me with financial modeling.
- Use when the user asks about building a financial model, three-statement model, income statement projection, balance sheet forecasting, cash flow modeling, scenario analysis, or linking financial statements together.
- Financial Modeling: provide an actionable result.

### Negative

- Do not use when the request is purely about valuation (use DCF Valuation), portfolio management, or non-financial-model analysis like earnings reviews.
- Do not use financial-modeling for unrelated requests.
- This request is outside financial modeling scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| modelType | select | Yes | Type of financial model to build |
| company | string | Yes | Company name or ticker symbol |
| question | string | Yes | Your specific modeling question |
| historicalData | string | No | Historical financial data or key metrics (e.g., last 3 years revenue, margins) |
| assumptions | string | No | Key assumptions to use (e.g., 15% revenue growth, 30% EBITDA margin target) |

## Runtime Prompt

- Current runtime prompt length: 1117 characters.
- Runtime prompt is defined directly in `../financial-modeling.json`. 
