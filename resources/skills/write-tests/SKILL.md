---
name: write-tests
description: "Generate unit tests for existing code"
---

# Write Tests

## Purpose

Generate unit tests for existing code

## Routing

- Use when: Use when the user requests missing test coverage for a specific file or module.
- Do not use when: Don't use for snapshot tests or manual QA-only validation.
- Outputs: Prioritized test plan and test cases with clear coverage mapping.
- Success criteria: Includes positive/negative cases and test setup assumptions.

## Trigger Examples

### Positive

- Use the write-tests skill for this request.
- Help me with write tests.
- Use when the user requests missing test coverage for a specific file or module.
- Write Tests: provide an actionable result.

### Negative

- Don't use for snapshot tests or manual QA-only validation.
- Do not use write-tests for unrelated requests.
- This request is outside write tests scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| path | string | Yes | Path to the file to test |
| framework | select | Yes | Testing framework to use |

## Runtime Prompt

- Current runtime prompt length: 339 characters.
- Runtime prompt is defined directly in `../write-tests.json`. 
