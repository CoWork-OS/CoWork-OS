---
name: competitive-research
description: "Research competitors for a product, market, or idea and identify opportunities to differentiate"
---

# Competitive Research

## Purpose

Research competitors for a product, market, or idea and identify opportunities to differentiate

## Routing

- Use when: Use when a user asks to research competitors, analyze a market, or find alternatives to a product.
- Do not use when: Don't use for general web research that isn't competitive analysis.
- Outputs: Structured competitive analysis with feature comparison, market positioning, and differentiation recommendations.
- Success criteria: Identifies at least 3 real competitors with accurate information and provides actionable differentiation advice.

## Trigger Examples

### Positive

- Use the competitive-research skill for this request.
- Help me with competitive research.
- Use when a user asks to research competitors, analyze a market, or find alternatives to a product.
- Competitive Research: provide an actionable result.

### Negative

- Don't use for general web research that isn't competitive analysis.
- Do not use competitive-research for unrelated requests.
- This request is outside competitive research scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| topic | string | Yes | The product, market, or idea to research competitors for |

## Runtime Prompt

- Current runtime prompt length: 1020 characters.
- Runtime prompt is defined directly in `../competitive-research.json`. 
