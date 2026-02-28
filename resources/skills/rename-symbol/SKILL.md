---
name: rename-symbol
description: "Rename a variable/function across files"
---

# Rename Symbol

## Purpose

Rename a variable/function across files

## Routing

- Use when: Use when renaming identifiers across files requires consistent symbol-level updates.
- Do not use when: Don't use when simple local rename in a single file can be done manually.
- Outputs: List of files edited, replacement counts, and ambiguous cases flagged for review.
- Success criteria: Only real symbol references are changed, with exports/imports kept consistent.

## Trigger Examples

### Positive

- Use the rename-symbol skill for this request.
- Help me with rename symbol.
- Use when renaming identifiers across files requires consistent symbol-level updates.
- Rename Symbol: provide an actionable result.

### Negative

- Don't use when simple local rename in a single file can be done manually.
- Do not use rename-symbol for unrelated requests.
- This request is outside rename symbol scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| oldName | string | Yes | Current name of the symbol |
| newName | string | Yes | New name for the symbol |

## Runtime Prompt

- Current runtime prompt length: 545 characters.
- Runtime prompt is defined directly in `../rename-symbol.json`. 
