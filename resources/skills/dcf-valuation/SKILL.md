---
name: dcf-valuation
description: "Discounted cash flow valuation with WACC calculation, free cash flow projection, terminal value estimation, sensitivity analysis, and enterprise-to-equity value bridge."
---

# DCF Valuation

## Purpose

Discounted cash flow valuation with WACC calculation, free cash flow projection, terminal value estimation, sensitivity analysis, and enterprise-to-equity value bridge.

## Routing

- Use when: Use when the user asks about discounted cash flow valuation, intrinsic value estimation, WACC calculation, terminal value, enterprise value, equity value bridge, or company valuation using projected cash flows.
- Do not use when: Do not use when the request is about relative valuation only (comparable companies/transactions), portfolio optimization, or non-valuation financial analysis.
- Outputs: Outcome from DCF Valuation: complete DCF model with FCF projections, WACC derivation, terminal value, sensitivity tables, and per-share equity value.
- Success criteria: Returns a fully built DCF with all intermediate calculations, clearly stated assumptions, sensitivity analysis, and an enterprise-to-equity bridge with per-share value.

## Trigger Examples

### Positive

- Use the dcf-valuation skill for this request.
- Help me with dcf valuation.
- Use when the user asks about discounted cash flow valuation, intrinsic value estimation, WACC calculation, terminal value, enterprise value, equity value bridge, or company valuation using projected cash flows.
- DCF Valuation: provide an actionable result.

### Negative

- Do not use when the request is about relative valuation only (comparable companies/transactions), portfolio optimization, or non-valuation financial analysis.
- Do not use dcf-valuation for unrelated requests.
- This request is outside dcf valuation scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| company | string | Yes | Company name or ticker symbol |
| projectionYears | select | Yes | Number of projection years |
| question | string | Yes | Your specific valuation question |
| revenueGrowth | string | No | Expected revenue growth rate (e.g., 15%) |
| ebitdaMargin | string | No | Target EBITDA margin (e.g., 25%) |
| wacc | string | No | Weighted average cost of capital (e.g., 9.5%) |
| terminalGrowthRate | string | No | Perpetual growth rate for terminal value (e.g., 2.5%) |

## Runtime Prompt

- Current runtime prompt length: 1101 characters.
- Runtime prompt is defined directly in `../dcf-valuation.json`. 
