---
name: usecase-dev-task-queue
description: "Create and run an agent-ready development queue from issues/PRs with progress checkpoints."
---

# Dev Task Queue

## Purpose

Create and run an agent-ready development queue from issues/PRs with progress checkpoints.

## Routing

- Use when: Use when the user asks to queue software tasks for agent execution with progress updates and safe merge/deploy gating.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Dev Task Queue: prioritized queue, execution status, and explicit approval checkpoints.
- Success criteria: Builds a practical task queue with visible progress and no unsafe autonomous merge/deploy actions.

## Trigger Examples

### Positive

- Use the usecase-dev-task-queue skill for this request.
- Help me with dev task queue.
- Use when the user asks to queue software tasks for agent execution with progress updates and safe merge/deploy gating.
- Dev Task Queue: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use usecase-dev-task-queue for unrelated requests.
- This request is outside dev task queue scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| repository | string | Yes | Repo slug or URL |
| scope_filter | string | No | Optional scope (label, milestone, area, keyword) |
| max_parallel_tasks | number | No | Maximum active tasks in parallel |
| progress_channel | select | No | Where progress updates should be formatted for |

## Runtime Prompt

- Current runtime prompt length: 1159 characters.
- Runtime prompt is defined directly in `../usecase-dev-task-queue.json`. 
