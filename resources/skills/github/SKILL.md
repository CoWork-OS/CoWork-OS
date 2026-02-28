---
name: github
description: "Interact with GitHub using the `gh` CLI. Use `gh issue`, `gh pr`, `gh run`, and `gh api` for issues, PRs, CI runs, and advanced queries."
---

# Github

## Purpose

Interact with GitHub using the `gh` CLI. Use `gh issue`, `gh pr`, `gh run`, and `gh api` for issues, PRs, CI runs, and advanced queries.

## Routing

- Use when: Use when the user asks to interact with GitHub using the gh CLI. Use gh issue, gh pr, gh run, and gh api for issues, PRs, CI runs, and advanced queries.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Github: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the github skill for this request.
- Help me with github.
- Use when the user asks to interact with GitHub using the gh CLI. Use gh issue, gh pr, gh run, and gh api for issues, PRs, CI runs, and advanced queries.
- Github: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use github for unrelated requests.
- This request is outside github scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 942 characters.
- Runtime prompt is defined directly in `../github.json`. 
