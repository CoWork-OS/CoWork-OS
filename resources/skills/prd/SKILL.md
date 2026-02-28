---
name: prd
description: "Generate a structured Product Requirements Document from a feature request."
---

# prd

## Purpose

Generate a structured Product Requirements Document from a feature request.

## Routing

- Use when: Use when the user asks to generate a structured Product Requirements Document from a feature request.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from prd: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the prd skill for this request.
- Help me with prd.
- Use when the user asks to generate a structured Product Requirements Document from a feature request.
- prd: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use prd for unrelated requests.
- This request is outside prd scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 845 characters.
- Runtime prompt is defined directly in `../prd.json`. 
