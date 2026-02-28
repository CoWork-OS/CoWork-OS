---
name: startup-cfo
description: "AI CFO for bootstrapped startups. Provides financial frameworks for cash management, runway calculations, unit economics (LTV:CAC), capital allocation, hiring ROI, burn rate analysis, working capital optimization, and forecasting."
---

# Startup CFO

## Purpose

AI CFO for bootstrapped startups. Provides financial frameworks for cash management, runway calculations, unit economics (LTV:CAC), capital allocation, hiring ROI, burn rate analysis, working capital optimization, and forecasting.

## Routing

- Use when: Use when the user asks to aI CFO for bootstrapped startups. Provides financial frameworks for cash management, runway calculations, unit economics LTV:CAC, capital allocation, hiring ROI, burn rate analysis, working capital optimization, and forecasting.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Startup CFO: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the startup-cfo skill for this request.
- Help me with startup cfo.
- Use when the user asks to aI CFO for bootstrapped startups. Provides financial frameworks for cash management, runway calculations, unit economics LTV:CAC, capital allocation, hiring ROI, burn rate analysis, working capital optimization, and forecasting.
- Startup CFO: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use startup-cfo for unrelated requests.
- This request is outside startup cfo scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| topic | select | Yes | Area of focus |
| question | string | Yes | Your specific question |
| arr | string | No | Annual Recurring Revenue (e.g., $2M) |
| monthlyChurn | string | No | Monthly churn rate (e.g., 2.5%) |
| cac | string | No | Customer Acquisition Cost (e.g., $500) |
| ltv | string | No | Lifetime Value (e.g., $3000) |

## Runtime Prompt

- Current runtime prompt length: 4158 characters.
- Runtime prompt is defined directly in `../startup-cfo.json`. 
