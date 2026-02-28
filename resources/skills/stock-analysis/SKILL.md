---
name: stock-analysis
description: "Analyze stocks, ETFs, and crypto using Yahoo Finance and Alpha Vantage. Get real-time quotes, fundamentals (P/E, EPS, margins, balance sheet), technical indicators (RSI, MACD, Bollinger), dividends, earnings, options chains, analyst ratings, institutional holders, sector comparisons, and screening. Use when the user asks about stock prices, company financials, market trends, portfolio analysis, or any investment research."
---

# Stock Analysis

## Purpose

Analyze stocks, ETFs, and crypto using Yahoo Finance and Alpha Vantage. Get real-time quotes, fundamentals (P/E, EPS, margins, balance sheet), technical indicators (RSI, MACD, Bollinger), dividends, earnings, options chains, analyst ratings, institutional holders, sector comparisons, and screening. Use when the user asks about stock prices, company financials, market trends, portfolio analysis, or any investment research.

## Routing

- Use when: User asks about stock prices, company fundamentals, market analysis, investment research, portfolio review, technical indicators, options, dividends, earnings, or crypto prices
- Do not use when: User asks about prediction markets (use polymarket skill), personal banking, or tax advice
- Outputs: Stock quotes, fundamental analysis, technical indicators, analyst ratings, comparison tables, screening results, 8-dimensional scores
- Success criteria: User receives accurate financial data with clear formatting, relevant context, and actionable insights

## Trigger Examples

### Positive

- Use the stock-analysis skill for this request.
- Help me with stock analysis.
- User asks about stock prices, company fundamentals, market analysis, investment research, portfolio review, technical indicators, options, dividends, earnings, or crypto prices
- Stock Analysis: provide an actionable result.

### Negative

- User asks about prediction markets (use polymarket skill), personal banking, or tax advice
- Do not use stock-analysis for unrelated requests.
- This request is outside stock analysis scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| ticker | string | No | Stock ticker symbol (e.g., AAPL, MSFT, BTC-USD, ^GSPC) |
| analysis_type | select | No | Type of analysis to perform |

## Runtime Prompt

- Current runtime prompt length: 918 characters.
- Runtime prompt is defined directly in `../stock-analysis.json`. 
