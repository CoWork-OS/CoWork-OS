---
name: bear-notes
description: "Create, search, and manage Bear notes via grizzly CLI."
---

# Bear-notes

## Purpose

Create, search, and manage Bear notes via grizzly CLI.

## Routing

- Use when: Use when the user asks to create, search, and manage Bear notes via grizzly CLI.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Bear-notes: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the bear-notes skill for this request.
- Help me with bear-notes.
- Use when the user asks to create, search, and manage Bear notes via grizzly CLI.
- Bear-notes: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use bear-notes for unrelated requests.
- This request is outside bear-notes scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 2092 characters.
- Runtime prompt is defined directly in `../bear-notes.json`. 
