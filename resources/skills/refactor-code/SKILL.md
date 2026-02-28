---
name: refactor-code
description: "Improve code structure and readability"
---

# Refactor Code

## Purpose

Improve code structure and readability

## Routing

- Use when: Use when user asks to improve maintainability, readability, modularity, or error handling in code.
- Do not use when: Don't use for behavior-only fixes where refactor risk is unnecessary.
- Outputs: Refactor changes, rationale, and minimal review checklist for behavior-sensitive sections.
- Success criteria: Preserves behavior while improving structure and readability.

## Trigger Examples

### Positive

- Use the refactor-code skill for this request.
- Help me with refactor code.
- Use when user asks to improve maintainability, readability, modularity, or error handling in code.
- Refactor Code: provide an actionable result.

### Negative

- Don't use for behavior-only fixes where refactor risk is unnecessary.
- Do not use refactor-code for unrelated requests.
- This request is outside refactor code scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| path | string | Yes | Path to the file to refactor |
| focus | select | Yes | What to focus on |

## Runtime Prompt

- Current runtime prompt length: 235 characters.
- Runtime prompt is defined directly in `../refactor-code.json`. 
