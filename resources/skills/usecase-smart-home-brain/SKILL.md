---
name: usecase-smart-home-brain
description: "Coordinate smart-home actions across existing integrations with clear dry-run and safety confirmation."
---

# Smart Home Brain

## Purpose

Coordinate smart-home actions across existing integrations with clear dry-run and safety confirmation.

## Routing

- Use when: Use when the user asks to control or coordinate multiple smart-home devices through natural language.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Smart Home Brain: dry-run action plan, execution status, and fallback setup instructions when integrations are missing.
- Success criteria: Safely coordinates smart-home actions with explicit confirmation boundaries and no fabricated execution claims.

## Trigger Examples

### Positive

- Use the usecase-smart-home-brain skill for this request.
- Help me with smart home brain.
- Use when the user asks to control or coordinate multiple smart-home devices through natural language.
- Smart Home Brain: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use usecase-smart-home-brain for unrelated requests.
- This request is outside smart home brain scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| intent | string | Yes | Natural-language smart home request |
| home_profile | select | No | Home mode context |
| confirmation_policy | select | No | When to require explicit confirmation |
| quiet_hours | string | No | Local quiet-hours window |

## Runtime Prompt

- Current runtime prompt length: 1083 characters.
- Runtime prompt is defined directly in `../usecase-smart-home-brain.json`. 
