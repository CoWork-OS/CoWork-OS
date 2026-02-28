---
name: clean-imports
description: "Remove unused imports from files"
---

# Clean Imports

## Purpose

Remove unused imports from files

## Routing

- Use when: Use for import hygiene: unused imports, sorting, grouping, and duplicate cleanup in local source files.
- Do not use when: Don't use for formatting-only tasks or API-logic refactors where imports are secondary.
- Outputs: Refactored import blocks and a concise list of removed/sorted/grouped changes.
- Success criteria: No functional change while improving import ordering, grouping, and deduplication without overreach.

## Trigger Examples

### Positive

- Use the clean-imports skill for this request.
- Help me with clean imports.
- Use for import hygiene: unused imports, sorting, grouping, and duplicate cleanup in local source files.
- Clean Imports: provide an actionable result.

### Negative

- Don't use for formatting-only tasks or API-logic refactors where imports are secondary.
- Do not use clean-imports for unrelated requests.
- This request is outside clean imports scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| path | string | Yes | Path to file or folder |

## Runtime Prompt

- Current runtime prompt length: 367 characters.
- Runtime prompt is defined directly in `../clean-imports.json`. 
