---
name: add-documentation
description: "Generate JSDoc/docstrings for functions"
---

# Add Documentation

## Purpose

Generate JSDoc/docstrings for functions

## Routing

- Use when: Use when users ask for in-code docs, docstring addition, or API-level comments.
- Do not use when: Don't use for content translation or narrative changelogs.
- Outputs: Updated code artifacts with improved inline documentation.
- Success criteria: Retains behavior while improving doc clarity and consistency.

## Trigger Examples

### Positive

- Use the add-documentation skill for this request.
- Help me with add documentation.
- Use when users ask for in-code docs, docstring addition, or API-level comments.
- Add Documentation: provide an actionable result.

### Negative

- Don't use for content translation or narrative changelogs.
- Do not use add-documentation for unrelated requests.
- This request is outside add documentation scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| path | string | Yes | Path to the file to document |
| style | select | Yes | Documentation style |

## Runtime Prompt

- Current runtime prompt length: 523 characters.
- Runtime prompt is defined directly in `../add-documentation.json`. 
