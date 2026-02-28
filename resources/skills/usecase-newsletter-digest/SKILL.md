---
name: usecase-newsletter-digest
description: "Summarize newsletter/email feed messages from the last N hours and propose follow-ups."
---

# Newsletter Digest

## Purpose

Summarize newsletter/email feed messages from the last N hours and propose follow-ups.

## Routing

- Use when: Use when the user asks to summarize newsletter/email feed messages from the last N hours and propose follow-ups.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Newsletter Digest: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the usecase-newsletter-digest skill for this request.
- Help me with newsletter digest.
- Use when the user asks to summarize newsletter/email feed messages from the last N hours and propose follow-ups.
- Newsletter Digest: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use usecase-newsletter-digest for unrelated requests.
- This request is outside newsletter digest scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| channel | select | Yes | Where the newsletter feed arrives |
| chat_hint | string | Yes | Name/keyword to identify the chat in channel_list_chats results |
| since | string | No | Time window (e.g., "24h") |
| message_limit | number | No | How many messages to fetch |
| output_format | select | No | How to format the digest |

## Runtime Prompt

- Current runtime prompt length: 882 characters.
- Runtime prompt is defined directly in `../usecase-newsletter-digest.json`. 
