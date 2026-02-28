---
name: compare-files
description: "Compare two files and show differences"
---

# Compare Files

## Purpose

Compare two files and show differences

## Routing

- Use when: Use when the user asks to compare two files and show differences.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Compare Files: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the compare-files skill for this request.
- Help me with compare files.
- Use when the user asks to compare two files and show differences.
- Compare Files: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use compare-files for unrelated requests.
- This request is outside compare files scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| file1 | string | Yes | Path to the first file |
| file2 | string | Yes | Path to the second file |

## Runtime Prompt

- Current runtime prompt length: 477 characters.
- Runtime prompt is defined directly in `../compare-files.json`. 
