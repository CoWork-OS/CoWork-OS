---
name: things-mac
description: "Manage Things 3 via the `things` CLI on macOS (add/update projects+todos via URL scheme; read/search/list from the local Things database). Use when a user asks CoWork-OSS to add a task to Things, list inbox/today/upcoming, search tasks, or inspect projects/areas/tags."
---

# Things-mac

## Purpose

Manage Things 3 via the `things` CLI on macOS (add/update projects+todos via URL scheme; read/search/list from the local Things database). Use when a user asks CoWork-OSS to add a task to Things, list inbox/today/upcoming, search tasks, or inspect projects/areas/tags.

## Routing

- Use when: Use when the user asks to manage Things 3 via the things CLI on macOS add/update projects+todos via URL scheme; read/search/list from the local Things database.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead. Avoid using this in non-macOS environments.
- Outputs: Outcome from Things-mac: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the things-mac skill for this request.
- Help me with things-mac.
- Use when the user asks to manage Things 3 via the things CLI on macOS add/update projects+todos via URL scheme; read/search/list from the local Things database.
- Things-mac: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead. Avoid using this in non-macOS environments.
- Do not use things-mac for unrelated requests.
- This request is outside things-mac scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 2754 characters.
- Runtime prompt is defined directly in `../things-mac.json`. 
