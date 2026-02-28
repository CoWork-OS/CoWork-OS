---
name: polymarket
description: "Query Polymarket prediction markets — search events, check odds and prices, view trending markets, track price momentum, get orderbook depth, analyze volume, and monitor market resolution timelines. Use when the user asks about prediction markets, betting odds, event probabilities, or Polymarket data."
---

# Polymarket

## Purpose

Query Polymarket prediction markets — search events, check odds and prices, view trending markets, track price momentum, get orderbook depth, analyze volume, and monitor market resolution timelines. Use when the user asks about prediction markets, betting odds, event probabilities, or Polymarket data.

## Routing

- Use when: User asks about prediction markets, betting odds, event probabilities, Polymarket data, what markets think about something, or wants to check odds on any topic
- Do not use when: User is asking about stock market prices, crypto token prices (not prediction markets), or wants to place actual trades
- Outputs: Market odds, trending events, price movements, orderbook data, resolution timelines
- Success criteria: User receives clear, formatted prediction market data with probabilities shown as percentages

## Trigger Examples

### Positive

- Use the polymarket skill for this request.
- Help me with polymarket.
- User asks about prediction markets, betting odds, event probabilities, Polymarket data, what markets think about something, or wants to check odds on any topic
- Polymarket: provide an actionable result.

### Negative

- User is asking about stock market prices, crypto token prices (not prediction markets), or wants to place actual trades
- Do not use polymarket for unrelated requests.
- This request is outside polymarket scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| query | string | No | What to search for or ask about (e.g., 'Trump election odds', 'trending crypto markets', 'AI predictions') |

## Runtime Prompt

- Current runtime prompt length: 867 characters.
- Runtime prompt is defined directly in `../polymarket.json`. 
