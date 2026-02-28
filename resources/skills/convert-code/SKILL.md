---
name: convert-code
description: "Convert code from one language to another"
---

# Convert Code

## Purpose

Convert code from one language to another

## Routing

- Use when: Use when asked to translate source code from one language to another while preserving behavior.
- Do not use when: Don't use when target language constraints, API semantics, or requirements are unclear.
- Outputs: Converted source plus migration notes and any intentional semantic deviations.
- Success criteria: Core logic and behavior stay equivalent, with idiomatic target-language usage.

## Trigger Examples

### Positive

- Use the convert-code skill for this request.
- Help me with convert code.
- Use when asked to translate source code from one language to another while preserving behavior.
- Convert Code: provide an actionable result.

### Negative

- Don't use when target language constraints, API semantics, or requirements are unclear.
- Do not use convert-code for unrelated requests.
- This request is outside convert code scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| path | string | Yes | Path to the source file |
| targetLanguage | select | Yes | Target programming language |

## Runtime Prompt

- Current runtime prompt length: 409 characters.
- Runtime prompt is defined directly in `../convert-code.json`. 
