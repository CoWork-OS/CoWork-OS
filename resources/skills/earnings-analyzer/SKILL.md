---
name: earnings-analyzer
description: "Analyze quarterly and annual earnings reports including EPS beat/miss analysis, revenue trends, margin expansion, forward guidance parsing, and management commentary extraction."
---

# Earnings Analyzer

## Purpose

Analyze quarterly and annual earnings reports including EPS beat/miss analysis, revenue trends, margin expansion, forward guidance parsing, and management commentary extraction.

## Routing

- Use when: Use when the user asks about earnings reports, quarterly results, EPS beat/miss, revenue analysis, margin trends, earnings guidance, earnings quality, or management commentary from earnings calls.
- Do not use when: Do not use when the request is about building a financial model (use Financial Modeling), valuation (use DCF Valuation), or general stock screening (use Market Screener).
- Outputs: Outcome from Earnings Analyzer: comprehensive earnings analysis with EPS assessment, revenue decomposition, margin waterfall, guidance evaluation, quality indicators, and key takeaways.
- Success criteria: Returns a structured earnings analysis with beat/miss classification, revenue and margin trends, guidance comparison to consensus, earnings quality assessment, and clear investment implications.

## Trigger Examples

### Positive

- Use the earnings-analyzer skill for this request.
- Help me with earnings analyzer.
- Use when the user asks about earnings reports, quarterly results, EPS beat/miss, revenue analysis, margin trends, earnings guidance, earnings quality, or management commentary from earnings calls.
- Earnings Analyzer: provide an actionable result.

### Negative

- Do not use when the request is about building a financial model (use Financial Modeling), valuation (use DCF Valuation), or general stock screening (use Market Screener).
- Do not use earnings-analyzer for unrelated requests.
- This request is outside earnings analyzer scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| company | string | Yes | Company name or ticker symbol |
| analysisType | select | Yes | Type of earnings analysis |
| question | string | Yes | Your specific earnings analysis question |
| quarter | string | No | Specific quarter to analyze (e.g., Q3 2024, FY 2024) |
| earningsData | string | No | Earnings data to analyze (e.g., EPS $2.15 vs $2.05 est, revenue $15.2B vs $14.8B est) |

## Runtime Prompt

- Current runtime prompt length: 1165 characters.
- Runtime prompt is defined directly in `../earnings-analyzer.json`. 
