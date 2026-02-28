---
name: imsg
description: "iMessage/SMS CLI for listing chats, history, watch, and sending."
---

# Imsg

## Purpose

iMessage/SMS CLI for listing chats, history, watch, and sending.

## Routing

- Use when: Use when the user asks to iMessage/SMS CLI for listing chats, history, watch, and sending.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Imsg: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the imsg skill for this request.
- Help me with imsg.
- Use when the user asks to iMessage/SMS CLI for listing chats, history, watch, and sending.
- Imsg: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use imsg for unrelated requests.
- This request is outside imsg scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 569 characters.
- Runtime prompt is defined directly in `../imsg.json`. 
