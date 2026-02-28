---
name: usecase-draft-reply
description: "Summarize a chat and draft 2 reply options. Stops before sending."
---

# Draft Reply

## Purpose

Summarize a chat and draft 2 reply options. Stops before sending.

## Routing

- Use when: Use when the user asks to summarize a chat and draft 2 reply options. Stops before sending.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Draft Reply: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the usecase-draft-reply skill for this request.
- Help me with draft reply.
- Use when the user asks to summarize a chat and draft 2 reply options. Stops before sending.
- Draft Reply: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use usecase-draft-reply for unrelated requests.
- This request is outside draft reply scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| channel | select | Yes | Which channel to read from |
| chat_hint | string | Yes | Name/keyword to identify the chat in channel_list_chats results |
| since | string | No | Time window (e.g., "15m", "24h", "7d") |
| message_limit | number | No | How many recent messages to fetch |
| tone | select | No | Desired tone for the draft |

## Runtime Prompt

- Current runtime prompt length: 917 characters.
- Runtime prompt is defined directly in `../usecase-draft-reply.json`. 
