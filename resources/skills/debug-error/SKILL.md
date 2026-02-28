---
name: debug-error
description: "Analyze an error message and suggest fixes"
---

# Debug Error

## Purpose

Analyze an error message and suggest fixes

## Routing

- Use when: Use when user shares an error message and asks for root-cause analysis.
- Do not use when: Don't use for feature requests or non-debug planning questions.
- Outputs: Root-cause analysis and concrete remediation steps.
- Success criteria: Provides plausible cause, fix plan, and verification step.

## Trigger Examples

### Positive

- Use the debug-error skill for this request.
- Help me with debug error.
- Use when user shares an error message and asks for root-cause analysis.
- Debug Error: provide an actionable result.

### Negative

- Don't use for feature requests or non-debug planning questions.
- Do not use debug-error for unrelated requests.
- This request is outside debug error scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| error | string | Yes | The error message or stack trace |

## Runtime Prompt

- Current runtime prompt length: 429 characters.
- Runtime prompt is defined directly in `../debug-error.json`. 
