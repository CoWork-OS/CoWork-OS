---
name: risk-analyzer
description: "Portfolio risk analysis including Value at Risk (parametric, historical, Monte Carlo), Conditional VaR, stress testing, drawdown analysis, and factor exposure assessment."
---

# Risk Analyzer

## Purpose

Portfolio risk analysis including Value at Risk (parametric, historical, Monte Carlo), Conditional VaR, stress testing, drawdown analysis, and factor exposure assessment.

## Routing

- Use when: Use when the user asks about portfolio risk, Value at Risk, VaR, CVaR, stress testing, drawdown analysis, factor exposure, risk budgeting, beta, tracking error, or any risk measurement and management question.
- Do not use when: Do not use when the request is about portfolio construction/optimization (use Portfolio Optimizer), company valuation, or financial modeling.
- Outputs: Outcome from Risk Analyzer: comprehensive risk assessment with VaR/CVaR calculations, stress test results, factor exposures, drawdown analysis, and risk management recommendations.
- Success criteria: Returns quantified risk metrics at the specified confidence level and horizon, identifies key risk concentrations, provides stress test impacts, and recommends actionable risk mitigation steps.

## Trigger Examples

### Positive

- Use the risk-analyzer skill for this request.
- Help me with risk analyzer.
- Use when the user asks about portfolio risk, Value at Risk, VaR, CVaR, stress testing, drawdown analysis, factor exposure, risk budgeting, beta, tracking error, or any risk measurement and management question.
- Risk Analyzer: provide an actionable result.

### Negative

- Do not use when the request is about portfolio construction/optimization (use Portfolio Optimizer), company valuation, or financial modeling.
- Do not use risk-analyzer for unrelated requests.
- This request is outside risk analyzer scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| portfolio | string | Yes | Portfolio holdings with weights and/or dollar amounts (e.g., SPY 50%, TLT 30%, GLD 20%; $500K total) |
| riskMetric | select | Yes | Primary risk metric to analyze |
| question | string | Yes | Your specific risk analysis question |
| confidence | select | Yes | Confidence level for VaR calculations |
| horizon | select | Yes | Time horizon for risk measurement |

## Runtime Prompt

- Current runtime prompt length: 1139 characters.
- Runtime prompt is defined directly in `../risk-analyzer.json`. 
