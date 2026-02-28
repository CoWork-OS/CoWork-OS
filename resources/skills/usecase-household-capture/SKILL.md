---
name: usecase-household-capture
description: "Turn a messy household message into Notion tasks + optional reminders."
---

# Household Capture

## Purpose

Turn a messy household message into Notion tasks + optional reminders.

## Routing

- Use when: Use when the user asks to turn a messy household message into Notion tasks + optional reminders.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Household Capture: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the usecase-household-capture skill for this request.
- Help me with household capture.
- Use when the user asks to turn a messy household message into Notion tasks + optional reminders.
- Household Capture: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use usecase-household-capture for unrelated requests.
- This request is outside household capture scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| notion_database_id | string | Yes | Target Notion database_id where tasks should be created |
| tasks | string | Yes | Paste the raw household tasks text here |
| create_reminders | boolean | No | Also create reminders for due tasks |

## Runtime Prompt

- Current runtime prompt length: 1062 characters.
- Runtime prompt is defined directly in `../usecase-household-capture.json`. 
