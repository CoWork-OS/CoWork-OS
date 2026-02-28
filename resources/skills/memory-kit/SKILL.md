---
name: memory-kit
description: "Create a workspace-local .cowork/ memory kit (rules, identity, long-term notes, daily logs, heartbeat templates)."
---

# Memory Kit

## Purpose

Create a workspace-local .cowork/ memory kit (rules, identity, long-term notes, daily logs, heartbeat templates).

## Routing

- Use when: Use when the user asks to create a workspace-local.cowork/ memory kit rules, identity, long-term notes, daily logs, heartbeat templates.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Memory Kit: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the memory-kit skill for this request.
- Help me with memory kit.
- Use when the user asks to create a workspace-local.cowork/ memory kit rules, identity, long-term notes, daily logs, heartbeat templates.
- Memory Kit: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use memory-kit for unrelated requests.
- This request is outside memory kit scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 894 characters.
- Runtime prompt is defined directly in `../memory-kit.json`. 
