---
name: extract-todos
description: "Find all TODO/FIXME comments in codebase"
---

# Extract TODOs

## Purpose

Find all TODO/FIXME comments in codebase

## Routing

- Use when: Use when the user wants TODO/FIXME/HACK/XXX inventorying, triage, or stale-task cleanup.
- Do not use when: Don't use for implementation requests or when a code review already includes a TODO pass.
- Outputs: Prioritized TODO inventory with counts, file grouping, and stale candidates.
- Success criteria: Findings list all TODO-like markers with location, context, and suggested priority rationale.

## Trigger Examples

### Positive

- Use the extract-todos skill for this request.
- Help me with extract todos.
- Use when the user wants TODO/FIXME/HACK/XXX inventorying, triage, or stale-task cleanup.
- Extract TODOs: provide an actionable result.

### Negative

- Don't use for implementation requests or when a code review already includes a TODO pass.
- Do not use extract-todos for unrelated requests.
- This request is outside extract todos scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| path | string | Yes | Path to search |

## Runtime Prompt

- Current runtime prompt length: 517 characters.
- Runtime prompt is defined directly in `../extract-todos.json`. 
