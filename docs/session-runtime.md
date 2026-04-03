# Session Runtime

SessionRuntime is the canonical owner of mutable task-session state for execution-oriented work. It sits between `TaskExecutor` and the lower-level turn executor, so the executor keeps task lifecycle responsibilities while the runtime owns the session mirror, permission state, persistence, and recovery behavior.

## What It Owns

SessionRuntime groups all mutable session state into explicit buckets:

- `transcript`: conversation history, latest user and assistant outputs, chat summary blocks, and step outcome summaries
- `tooling`: tool failure tracking, tool usage counters, tool-result memory, web evidence memory, and available-tools caching
- `files`: file-read tracking and file-operation tracking
- `loop`: turn counts, continuation counters, compaction counters, loop fingerprints, and soft-deadline flags
- `recovery`: retry and failure-signature state, recovery classification, and tool-disable scopes
- `queues`: pending follow-ups and step-feedback signals
- `worker`: mentioned-agent dispatch state and verification-agent state
- `verification`: verification evidence and failed-step tracking
- `checklist`: session-local execution checklist items, nudge state, and checklist timestamps
- `usage`: cumulative token and cost tracking plus usage offsets
- `permissions`: default mode, session-local rules, temporary grants, denial counters, and latest prompt context

This is the state that used to be mirrored across the executor and related helpers. It now lives in one place so task resume, retry, and completion logic read the same source of truth.

## Public Surface

The runtime exposes a narrow API for the executor and task orchestration layers:

- `runStepLoop(...)`
- `runFollowUpLoop(...)`
- `runTextLoop(...)`
- `queueFollowUp(...)`
- `setStepFeedback(...)`
- `drainAllPendingFollowUps(...)`
- `maybeAutoContinueAfterTurnLimit(...)`
- `continueAfterBudgetExhausted(...)`
- `resetForRetry(...)`
- `saveSnapshot(...)`
- `restoreFromEvents(...)`
- `projectTaskState(...)`
- `createTaskList(...)`
- `updateTaskList(...)`
- `listTaskList(...)`
- `getTaskListState(...)`
- `clearTaskListVerificationNudge()`
- `getOutputState(...)`
- `getVerificationState(...)`
- `getRecoveryState(...)`
- `getPermissionState(...)`
- `applyWorkspaceUpdate(...)`

The executor still owns task bootstrap, plan construction, completion policy, UI/daemon updates, and final result projection. It now delegates session state changes instead of duplicating them.

## Session Checklist Primitive

SessionRuntime now owns a lightweight session checklist that is separate from:

- plan steps
- shared team checklists
- any database-backed durable checklist model

The checklist is session-scoped, agent-managed, and persisted only inside `session_runtime_v2` snapshots and checklist events. It exists to keep execution disciplined during multi-step work without creating a second planning system.

### Tool surface

Execution-capable paths expose three runtime tools:

- `task_list_create`
- `task_list_update`
- `task_list_list`

They are intentionally unavailable in chat, plan, analyze, and other non-executing paths.

### Runtime semantics

- `task_list_create` creates the first ordered checklist and fails if one already exists
- `task_list_update` replaces the full ordered state
- existing items keep their ids when the caller supplies them
- new items may omit `id` and the runtime generates one
- `kind` defaults to `implementation`
- create and update reject empty lists, duplicate ids, and more than one `in_progress` item

### Verification nudge algorithm

The checklist can raise a non-blocking verification reminder when all of the following are true:

- a session checklist exists
- at least one checklist item has `kind: "implementation"`
- every implementation item is `completed`
- no checklist item has `kind: "verification"`
- the current plan does not already contain a verification step
- the task is not already on a verified path with explicit verification coverage

When that happens:

- `task_list_update` returns `verificationNudgeNeeded: true`
- SessionRuntime persists that flag in checklist state
- the runtime emits `task_list_verification_nudged`
- next-turn preparation injects a short reminder to add or run a verification item before final completion

The reminder is advisory in v1. It does not fail completion by itself.

### UI/event model

Checklist state is replayable from events alone. The runtime emits:

- `task_list_created`
- `task_list_updated`
- `task_list_verification_nudged`

Each payload carries the full current checklist snapshot so the renderer can reconstruct the latest read-only checklist state without a separate query path.

## Turn Execution Flow

```
TaskExecutor
  -> SessionRuntime
      -> TurnKernel for the active step / follow-up / text turn
      -> adaptive budget and retry helpers
      -> session state updates
      -> task projection updates
      -> snapshot save / restore
```

The turn kernel is still responsible for a single turn of execution. SessionRuntime is responsible for choosing when to run it, which state to feed into it, and how to persist the results.

## Snapshot And Restore Algorithm

Persisted task state uses the legacy `conversation_snapshot` event name for compatibility, but the payload is now versioned as `session_runtime_v2`.

### Write path

1. SessionRuntime captures the full runtime snapshot.
2. It writes a `conversation_snapshot` event with:
   - `schema: "session_runtime_v2"`
   - `version: 2`
   - transcript, tooling, files, loop, recovery, queues, worker, verification, checklist, usage, and permissions state
3. `TaskExecutor` no longer writes the payload directly.

### Restore path

`restoreFromEvents()` follows a strict precedence order:

1. Load a V2 checkpoint payload, if present.
2. Otherwise load the latest V2 `conversation_snapshot` event payload.
3. Otherwise restore from a legacy checkpoint payload that still contains `conversationHistory`.
4. Otherwise restore from a legacy `conversation_snapshot` event payload with `conversationHistory`.
5. Otherwise rebuild a readable fallback conversation from task events.

If a legacy payload is restored, the runtime writes back a V2 snapshot on the next checkpoint so future resumes use the canonical schema.

### Why the order matters

- Checkpoints are the most recent durable session state.
- Event payloads provide a replayable source of truth when a checkpoint is absent or stale.
- Legacy payloads remain readable so older tasks can still resume.
- Event-derived fallback keeps very old or partially migrated tasks usable even when no snapshot payload is available.

## Task Projection

`projectTaskState()` exposes the runtime-owned task fields that still need to be reflected on the task row:

- budget usage
- continuation count and window
- lifetime turns used
- compaction count and last compaction markers
- no-progress streak
- last loop fingerprint

This keeps the task row synchronized with the runtime without copying the rest of the session state into the database row itself.

## Terminal Status Synchronization

The runtime boundary is also responsible for keeping the task row and the event stream in the same terminal state.

### Completion algorithm

1. The executor computes the final outcome and terminal metadata.
2. The daemon persists the task row first, including `status`, `completedAt`, `terminalStatus`, `failureClass`, and completion summaries.
3. Only after the row update succeeds does the daemon emit `task_completed` or the final `task_status` event.

This ordering ensures the event stream never advertises completion ahead of the durable task row update.

### Resume safety algorithm

Late resume calls can happen after approvals, structured-input responses, or renderer-side event handling. To prevent a finished task from being reopened accidentally:

1. resume callers ask the daemon to resume instead of writing `executing` themselves
2. the daemon re-reads the persisted task row and derives the canonical lifecycle state
3. if the task is already terminal, resume is rejected and no state is rewritten
4. if the task is already `executing`, the daemon skips duplicate `executing` writes
5. only a genuinely resumable non-terminal task is moved back to `executing`

This protects terminal fields from stale post-resume writes and keeps task rows aligned with `task_completed` events even when approval or follow-up flows resolve very quickly.

## Workspace Refresh

When the active workspace changes, SessionRuntime swaps to the new tool registry, invalidates tool availability caches, and preserves the live transcript and loop state. This lets the task continue without resetting the session mirror.

It also clears workspace-derived permission cache entries so the next evaluation uses the refreshed
workspace rule set.

## Related Docs

- [Architecture](architecture.md)
- [Features](features.md)
- [Context Compaction](context-compaction.md)
- [Project Status](project-status.md)
- [Session Note: 2026-04-02](session-notes/2026-04-02-session-runtime-owner.md)
