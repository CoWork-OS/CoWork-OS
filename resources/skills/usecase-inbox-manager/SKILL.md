---
name: usecase-inbox-manager
description: "Triage inbox, draft replies, and suggest cleanup automations with strict confirmation gates."
---

# Inbox Manager

## Purpose

Triage inbox, draft replies, and suggest cleanup automations with strict confirmation gates.

## Routing

- Use when: Use when the user asks to triage inbox, draft replies, and suggest cleanup automations with strict confirmation gates.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Inbox Manager: prioritized inbox plan, safe draft replies, and explicit next-step actions.
- Success criteria: Produces actionable inbox triage with clear confirmation boundaries and no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the usecase-inbox-manager skill for this request.
- Help me with inbox manager.
- Use when the user asks to triage inbox, draft replies, and suggest cleanup automations with strict confirmation gates.
- Inbox Manager: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use usecase-inbox-manager for unrelated requests.
- This request is outside inbox manager scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| mode | select | No | Inbox manager mode |
| message_limit | number | No | Maximum number of messages to inspect |
| time_window | string | No | Lookback window (e.g., "24h", "3d") |
| output_format | select | No | How to format the final report |

## Runtime Prompt

- Current runtime prompt length: 1236 characters.
- Runtime prompt is defined directly in `../usecase-inbox-manager.json`. 
