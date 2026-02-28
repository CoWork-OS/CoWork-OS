---
name: multi-pr-review
description: "Run a consensus-style multi-agent review of a PR with severity-based findings."
---

# multi-pr-review

## Purpose

Run a consensus-style multi-agent review of a PR with severity-based findings.

## Routing

- Use when: Use when the user asks to run a consensus-style multi-agent review of a PR with severity-based findings.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from multi-pr-review: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the multi-pr-review skill for this request.
- Help me with multi-pr-review.
- Use when the user asks to run a consensus-style multi-agent review of a PR with severity-based findings.
- multi-pr-review: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use multi-pr-review for unrelated requests.
- This request is outside multi-pr-review scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 872 characters.
- Runtime prompt is defined directly in `../multi-pr-review.json`. 
