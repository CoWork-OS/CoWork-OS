---
name: usecase-chief-of-staff-briefing
description: "Build a morning/evening executive brief from calendar, inbox, tasks, and optional ops signals."
---

# Chief of Staff Briefing

## Purpose

Build a morning/evening executive brief from calendar, inbox, tasks, and optional ops signals.

## Routing

- Use when: Use when the user asks to build a morning or daily executive brief from calendar, inbox, tasks, and optional ops signals.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Chief of Staff Briefing: one high-signal brief plus prioritized next actions.
- Success criteria: Delivers a concise brief with explicit data availability boundaries and clear recommended actions.

## Trigger Examples

### Positive

- Use the usecase-chief-of-staff-briefing skill for this request.
- Help me with chief of staff briefing.
- Use when the user asks to build a morning or daily executive brief from calendar, inbox, tasks, and optional ops signals.
- Chief of Staff Briefing: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use usecase-chief-of-staff-briefing for unrelated requests.
- This request is outside chief of staff briefing scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| timeframe | select | No | Time horizon for the briefing |
| audience_style | select | No | How executive vs detailed the brief should be |
| include_optional_signals | select | No | Include weather/ops/revenue signals when connectors exist |
| delivery_style | select | No | Formatting style for final output |

## Runtime Prompt

- Current runtime prompt length: 1219 characters.
- Runtime prompt is defined directly in `../usecase-chief-of-staff-briefing.json`. 
