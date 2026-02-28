---
name: karpathy-guidelines
description: "Best practices for high-quality task execution"
---

# Task Guidelines

## Purpose

Best practices for high-quality task execution

## Routing

- Use when: Use when the user asks to best practices for high-quality task execution.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Task Guidelines: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the karpathy-guidelines skill for this request.
- Help me with task guidelines.
- Use when the user asks to best practices for high-quality task execution.
- Task Guidelines: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use karpathy-guidelines for unrelated requests.
- This request is outside task guidelines scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 950 characters.
- Runtime prompt is defined directly in `../karpathy-guidelines.json`. 
