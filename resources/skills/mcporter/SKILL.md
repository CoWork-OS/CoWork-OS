---
name: mcporter
description: "Use the mcporter CLI to list, configure, auth, and call MCP servers/tools directly (HTTP or stdio), including ad-hoc servers, config edits, and CLI/type generation."
---

# Mcporter

## Purpose

Use the mcporter CLI to list, configure, auth, and call MCP servers/tools directly (HTTP or stdio), including ad-hoc servers, config edits, and CLI/type generation.

## Routing

- Use when: Use when the user asks to use the mcporter CLI to list, configure, auth, and call MCP servers/tools directly HTTP or stdio, including ad-hoc servers, config edits, and CLI/type generation.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Mcporter: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the mcporter skill for this request.
- Help me with mcporter.
- Use when the user asks to use the mcporter CLI to list, configure, auth, and call MCP servers/tools directly HTTP or stdio, including ad-hoc servers, config edits, and CLI/type generation.
- Mcporter: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use mcporter for unrelated requests.
- This request is outside mcporter scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 1065 characters.
- Runtime prompt is defined directly in `../mcporter.json`. 
