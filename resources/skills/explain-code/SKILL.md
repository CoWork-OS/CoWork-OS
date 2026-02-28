---
name: explain-code
description: "Get a detailed explanation of how code works"
---

# Explain Code

## Purpose

Get a detailed explanation of how code works

## Routing

- Use when: Use when user asks for a conceptual explanation of function behavior, architecture, or control flow.
- Do not use when: Don't use when the task requires code edits or strict formal API docs.
- Outputs: Step-by-step explanation with key abstractions, assumptions, and edge-case behavior.
- Success criteria: Explanation matches code intent at requested level with minimal speculation and clear terminology.

## Trigger Examples

### Positive

- Use the explain-code skill for this request.
- Help me with explain code.
- Use when user asks for a conceptual explanation of function behavior, architecture, or control flow.
- Explain Code: provide an actionable result.

### Negative

- Don't use when the task requires code edits or strict formal API docs.
- Do not use explain-code for unrelated requests.
- This request is outside explain code scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| path | string | Yes | Path to the file to explain |
| level | select | Yes | Explanation depth |

## Runtime Prompt

- Current runtime prompt length: 268 characters.
- Runtime prompt is defined directly in `../explain-code.json`. 
