---
name: usecase-family-digest
description: "Draft a daily digest based on calendar + tasks. Stops before sending."
---

# Family Digest

## Purpose

Draft a daily digest based on calendar + tasks. Stops before sending.

## Routing

- Use when: Use when the user asks to draft a daily digest based on calendar + tasks. Stops before sending.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Family Digest: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the usecase-family-digest skill for this request.
- Help me with family digest.
- Use when the user asks to draft a daily digest based on calendar + tasks. Stops before sending.
- Family Digest: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use usecase-family-digest for unrelated requests.
- This request is outside family digest scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| range | select | No | Time range to summarize |
| recipient | string | No | Who this digest is for (e.g., "my parents", "my partner") |
| tone | select | No | Writing tone |

## Runtime Prompt

- Current runtime prompt length: 696 characters.
- Runtime prompt is defined directly in `../usecase-family-digest.json`. 
