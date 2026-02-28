---
name: trello
description: "Manage Trello boards, lists, and cards via the Trello REST API."
---

# Trello

## Purpose

Manage Trello boards, lists, and cards via the Trello REST API.

## Routing

- Use when: Use when the user asks to manage Trello boards, lists, and cards via the Trello REST API.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Trello: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the trello skill for this request.
- Help me with trello.
- Use when the user asks to manage Trello boards, lists, and cards via the Trello REST API.
- Trello: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use trello for unrelated requests.
- This request is outside trello scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 2392 characters.
- Runtime prompt is defined directly in `../trello.json`. 
