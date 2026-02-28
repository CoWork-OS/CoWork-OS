---
name: session-logs
description: "Query prior conversations/tasks via the task_history tool (replaces filesystem JSONL session logs)."
---

# Session Logs (Deprecated)

## Purpose

Query prior conversations/tasks via the task_history tool (replaces filesystem JSONL session logs).

## Routing

- Use when: Use when the user asks to query prior conversations/tasks via the task_history tool replaces filesystem JSONL session logs.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Session Logs (Deprecated): task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the session-logs skill for this request.
- Help me with session logs (deprecated).
- Use when the user asks to query prior conversations/tasks via the task_history tool replaces filesystem JSONL session logs.
- Session Logs (Deprecated): provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use session-logs for unrelated requests.
- This request is outside session logs (deprecated) scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 1034 characters.
- Runtime prompt is defined directly in `../session-logs.json`. 
