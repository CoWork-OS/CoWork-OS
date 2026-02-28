---
name: price-tracker
description: "Track and compare prices across e-commerce websites using stealth scraping."
---

# Price Tracker

## Purpose

Track and compare prices across e-commerce websites using stealth scraping.

## Routing

- Use when: Use when the user wants to check prices, compare products, track deals, or monitor e-commerce listings.
- Do not use when: Don't use for general web browsing or non-commerce content.
- Outputs: Structured price and product data in comparison table format.
- Success criteria: Successfully extracts current prices and product details from the target e-commerce sites.

## Trigger Examples

### Positive

- Use the price-tracker skill for this request.
- Help me with price tracker.
- Use when the user wants to check prices, compare products, track deals, or monitor e-commerce listings.
- Price Tracker: provide an actionable result.

### Negative

- Don't use for general web browsing or non-commerce content.
- Do not use price-tracker for unrelated requests.
- This request is outside price tracker scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| urls | string | Yes | Product URL(s) to track (comma-separated for multiple) |

## Runtime Prompt

- Current runtime prompt length: 856 characters.
- Runtime prompt is defined directly in `../price-tracker.json`. 
