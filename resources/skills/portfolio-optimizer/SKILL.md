---
name: portfolio-optimizer
description: "Modern portfolio theory optimization including Markowitz mean-variance, Black-Litterman, risk parity, and efficient frontier construction with constraints."
---

# Portfolio Optimizer

## Purpose

Modern portfolio theory optimization including Markowitz mean-variance, Black-Litterman, risk parity, and efficient frontier construction with constraints.

## Routing

- Use when: Use when the user asks about portfolio optimization, asset allocation, efficient frontier, Markowitz optimization, Black-Litterman, risk parity, diversification, rebalancing, or optimal portfolio construction.
- Do not use when: Do not use when the request is about individual stock analysis, financial modeling, risk metrics only (use Risk Analyzer), or tax planning.
- Outputs: Outcome from Portfolio Optimizer: optimized asset allocation with weights, expected return, risk metrics, efficient frontier positioning, and rebalancing recommendations.
- Success criteria: Returns specific allocation weights, portfolio expected return and risk, Sharpe ratio, comparison to current allocation, and actionable rebalancing steps.

## Trigger Examples

### Positive

- Use the portfolio-optimizer skill for this request.
- Help me with portfolio optimizer.
- Use when the user asks about portfolio optimization, asset allocation, efficient frontier, Markowitz optimization, Black-Litterman, risk parity, diversification, rebalancing, or optimal portfolio construction.
- Portfolio Optimizer: provide an actionable result.

### Negative

- Do not use when the request is about individual stock analysis, financial modeling, risk metrics only (use Risk Analyzer), or tax planning.
- Do not use portfolio-optimizer for unrelated requests.
- This request is outside portfolio optimizer scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| holdings | string | Yes | Current portfolio holdings and weights (e.g., SPY 40%, AGG 30%, GLD 10%, VWO 20%) |
| objective | select | Yes | Optimization objective |
| question | string | Yes | Your specific optimization question |
| constraints | string | No | Portfolio constraints (e.g., long-only, max 25% per position, no emerging markets) |
| targetReturn | string | No | Target annual return for optimization (e.g., 8%) |

## Runtime Prompt

- Current runtime prompt length: 1094 characters.
- Runtime prompt is defined directly in `../portfolio-optimizer.json`. 
