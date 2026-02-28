---
name: proofread
description: "Check document for grammar and clarity"
---

# Proofread

## Purpose

Check document for grammar and clarity

## Routing

- Use when: Use when the user asks to check document for grammar and clarity.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Proofread: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the proofread skill for this request.
- Help me with proofread.
- Use when the user asks to check document for grammar and clarity.
- Proofread: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use proofread for unrelated requests.
- This request is outside proofread scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| path | string | Yes | Path to the document |

## Runtime Prompt

- Current runtime prompt length: 419 characters.
- Runtime prompt is defined directly in `../proofread.json`. 
