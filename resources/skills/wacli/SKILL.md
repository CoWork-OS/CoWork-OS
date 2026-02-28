---
name: wacli
description: "Send WhatsApp messages to other people or search/sync WhatsApp history via the wacli CLI (not for normal user chats)."
---

# Wacli

## Purpose

Send WhatsApp messages to other people or search/sync WhatsApp history via the wacli CLI (not for normal user chats).

## Routing

- Use when: Use when the user asks to send WhatsApp messages to other people or search/sync WhatsApp history via the wacli CLI not for normal user chats.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Wacli: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the wacli skill for this request.
- Help me with wacli.
- Use when the user asks to send WhatsApp messages to other people or search/sync WhatsApp history via the wacli CLI not for normal user chats.
- Wacli: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use wacli for unrelated requests.
- This request is outside wacli scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 1597 characters.
- Runtime prompt is defined directly in `../wacli.json`. 
