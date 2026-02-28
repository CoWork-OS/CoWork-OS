---
name: weather
description: "Get current weather and forecasts (no API key required)."
---

# Weather

## Purpose

Get current weather and forecasts (no API key required).

## Routing

- Use when: Use when the user asks to get current weather and forecasts no API key required.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Weather: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the weather skill for this request.
- Help me with weather.
- Use when the user asks to get current weather and forecasts no API key required.
- Weather: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use weather for unrelated requests.
- This request is outside weather scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 958 characters.
- Runtime prompt is defined directly in `../weather.json`. 
