---
name: idea-validation
description: "Validate a business or product idea with market research, competitor analysis, and a go/no-go recommendation"
---

# Idea Validation

## Purpose

Validate a business or product idea with market research, competitor analysis, and a go/no-go recommendation

## Routing

- Use when: Use when a user wants to validate an idea, assess market viability, or decide whether to pursue a concept.
- Do not use when: Don't use for ideas that are already validated or when the user just wants competitor research (use competitive-research instead).
- Outputs: Structured validation report with market sizing, competitor analysis, MVP definition, and go/no-go recommendation.
- Success criteria: Provides a clear, data-informed recommendation with specific next steps.

## Trigger Examples

### Positive

- Use the idea-validation skill for this request.
- Help me with idea validation.
- Use when a user wants to validate an idea, assess market viability, or decide whether to pursue a concept.
- Idea Validation: provide an actionable result.

### Negative

- Don't use for ideas that are already validated or when the user just wants competitor research (use competitive-research instead).
- Do not use idea-validation for unrelated requests.
- This request is outside idea validation scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| idea | string | Yes | Description of the business or product idea to validate |

## Runtime Prompt

- Current runtime prompt length: 1560 characters.
- Runtime prompt is defined directly in `../idea-validation.json`. 
