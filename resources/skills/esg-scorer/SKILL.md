---
name: esg-scorer
description: "Environmental, Social, and Governance scoring with SASB materiality mapping, TCFD climate risk alignment, carbon footprint analysis, and sustainability benchmarking."
---

# ESG Scorer

## Purpose

Environmental, Social, and Governance scoring with SASB materiality mapping, TCFD climate risk alignment, carbon footprint analysis, and sustainability benchmarking.

## Routing

- Use when: Use when the user asks about ESG scores, sustainability assessment, SASB materiality, TCFD climate risk, carbon emissions, corporate governance quality, social impact, or responsible investing criteria.
- Do not use when: Do not use when the request is about financial performance metrics only, stock screening on non-ESG criteria (use Market Screener), or portfolio construction (use Portfolio Optimizer).
- Outputs: Outcome from ESG Scorer: comprehensive ESG assessment with pillar scores, materiality mapping, TCFD alignment check, benchmarks against sector peers, and improvement recommendations.
- Success criteria: Returns a structured ESG score with E, S, and G pillar ratings, sector-specific materiality assessment, quantified metrics where available, peer comparison, and actionable improvement areas.

## Trigger Examples

### Positive

- Use the esg-scorer skill for this request.
- Help me with esg scorer.
- Use when the user asks about ESG scores, sustainability assessment, SASB materiality, TCFD climate risk, carbon emissions, corporate governance quality, social impact, or responsible investing criteria.
- ESG Scorer: provide an actionable result.

### Negative

- Do not use when the request is about financial performance metrics only, stock screening on non-ESG criteria (use Market Screener), or portfolio construction (use Portfolio Optimizer).
- Do not use esg-scorer for unrelated requests.
- This request is outside esg scorer scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| company | string | Yes | Company name or ticker symbol |
| framework | select | Yes | ESG framework to apply |
| question | string | Yes | Your specific ESG analysis question |
| sector | string | No | Company sector for materiality mapping (e.g., Technology, Healthcare, Energy) |
| focusArea | select | Yes | Primary ESG pillar to focus on |

## Runtime Prompt

- Current runtime prompt length: 1171 characters.
- Runtime prompt is defined directly in `../esg-scorer.json`. 
