---
name: market-screener
description: "Screen equities, ETFs, and bonds using fundamental, technical, and quantitative criteria with multi-factor ranking and sector filtering."
---

# Market Screener

## Purpose

Screen equities, ETFs, and bonds using fundamental, technical, and quantitative criteria with multi-factor ranking and sector filtering.

## Routing

- Use when: Use when the user asks to screen or filter stocks, find investment ideas based on criteria, rank equities by metrics, build watchlists, or apply fundamental/technical screening rules to a market universe.
- Do not use when: Do not use when the request is about analyzing a single known company (use Earnings Analyzer or DCF Valuation), optimizing a portfolio, or performing risk analysis.
- Outputs: Outcome from Market Screener: ranked list of securities matching the screening criteria with composite scores, key metrics, and investment rationale for each match.
- Success criteria: Returns a clearly ranked list of securities that match all specified criteria, with supporting metrics, sector classification, and brief rationale for inclusion.

## Trigger Examples

### Positive

- Use the market-screener skill for this request.
- Help me with market screener.
- Use when the user asks to screen or filter stocks, find investment ideas based on criteria, rank equities by metrics, build watchlists, or apply fundamental/technical screening rules to a market universe.
- Market Screener: provide an actionable result.

### Negative

- Do not use when the request is about analyzing a single known company (use Earnings Analyzer or DCF Valuation), optimizing a portfolio, or performing risk analysis.
- Do not use market-screener for unrelated requests.
- This request is outside market screener scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| assetClass | select | Yes | Asset class to screen |
| criteria | string | Yes | Screening criteria (e.g., P/E < 15, ROE > 20%, dividend yield > 3%) |
| question | string | Yes | Your specific screening question |
| market | select | Yes | Market region to screen |
| maxResults | select | Yes | Maximum number of results to return |

## Runtime Prompt

- Current runtime prompt length: 1111 characters.
- Runtime prompt is defined directly in `../market-screener.json`. 
