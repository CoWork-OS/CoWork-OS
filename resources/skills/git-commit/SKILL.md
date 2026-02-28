---
name: git-commit
description: "Create a well-formatted commit message from staged changes"
---

# Git Commit

## Purpose

Create a well-formatted commit message from staged changes

## Routing

- Use when: Use when the user asks to create a well-formatted commit message from staged changes.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Git Commit: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the git-commit skill for this request.
- Help me with git commit.
- Use when the user asks to create a well-formatted commit message from staged changes.
- Git Commit: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use git-commit for unrelated requests.
- This request is outside git commit scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 494 characters.
- Runtime prompt is defined directly in `../git-commit.json`. 
