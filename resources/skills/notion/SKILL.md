---
name: notion
description: "Notion API for creating and managing pages, databases, and blocks."
---

# Notion

## Purpose

Notion API for creating and managing pages, databases, and blocks.

## Routing

- Use when: Use when the user asks to notion API for creating and managing pages, databases, and blocks.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Notion: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the notion skill for this request.
- Help me with notion.
- Use when the user asks to notion API for creating and managing pages, databases, and blocks.
- Notion: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use notion for unrelated requests.
- This request is outside notion scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 4860 characters.
- Runtime prompt is defined directly in `../notion.json`. 
