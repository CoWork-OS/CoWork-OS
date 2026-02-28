---
name: eightctl
description: "Control Eight Sleep pods (status, temperature, alarms, schedules)."
---

# Eightctl

## Purpose

Control Eight Sleep pods (status, temperature, alarms, schedules).

## Routing

- Use when: Use when the user asks to control Eight Sleep pods status, temperature, alarms, schedules.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Eightctl: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the eightctl skill for this request.
- Help me with eightctl.
- Use when the user asks to control Eight Sleep pods status, temperature, alarms, schedules.
- Eightctl: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use eightctl for unrelated requests.
- This request is outside eightctl scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 550 characters.
- Runtime prompt is defined directly in `../eightctl.json`. 
