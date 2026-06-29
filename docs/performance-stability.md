# Performance & Stability Enhancements

This document covers performance optimizations and stability fixes applied to CoWork OS to address resource issues observed during multitask runs (collaborative team reviews, parallel agent execution).

## Problem Statement

During live multitask review runs, the following resource issues were observed:

- **Renderer memory**: grew from ~1 GB to 7.4 GB RSS
- **Renderer CPU**: stayed at 100% after task completion
- **MCP server processes**: 27 leaked processes (~2.4 GB)
- **Synthesis prompts**: ballooned to 244k+ characters
- **Concurrent verification**: up to 3 duplicate `tsc --noEmit` processes (~3 GB combined)
- **React render loops**: "Maximum update depth exceeded" caused cascading re-renders
- **SQLite lock contention**: "database is locked" errors under concurrent writes
- **Phase tracking**: UI showed "Thinking..." during active agent execution

---

## Renderer Memory & CPU

### Event Array Capping

| Constant | Value | File |
|----------|-------|------|
| `MAX_RENDERER_TASK_EVENTS` | 600 | `src/renderer/App.tsx` |
| `MAX_RENDERER_CHILD_EVENTS` | 300 | `src/renderer/App.tsx` |
| `DEFAULT_MAX_EVENT_PAYLOAD_BYTES` | 750 KiB | `src/renderer/utils/task-event-append.ts` |
| `MAX_LARGE_EVENT_STRING_CHARS` | 32 KiB | `src/renderer/utils/task-event-append.ts` |
| `MAX_COMMAND_OUTPUT_CHARS` | 16 KiB | `src/renderer/utils/task-event-append.ts` |

The renderer caps task events in memory using `capTaskEvents()`, which prioritizes structural events (approvals, plan steps, errors) over noise events (progress updates, streaming). Child event arrays from sub-agents are capped at a lower threshold since they're secondary context.

Large renderer events (`command_output`, tool call/result payloads, and timeline command output) are trimmed before they are retained in renderer state. Command output fields (`output`, `stdout`, `stderr`, and `command`) use the tighter 16 KiB field cap so noisy terminal streams cannot dominate the in-memory task event array.

### Command Output Windows

| Constant | Value | File |
|----------|-------|------|
| `MAX_COMMAND_OUTPUT_SESSION_CHARS` | 50 KiB | `src/renderer/utils/task-event-derived.ts`, `src/renderer/components/MainContent/MainContent.tsx` |
| `MAX_COMMAND_OUTPUT_SESSIONS` | 12 | `src/renderer/utils/task-event-derived.ts`, `src/renderer/components/MainContent/MainContent.tsx` |
| `MAX_OUTPUT_SIZE` | 100 KiB | `src/electron/agent/tools/shell-tools.ts` |
| `MAX_OUTPUT_BYTES` | 100 KiB | `src/electron/agent/tools/code-exec-tools.ts` |

Backend shell and code-execution tools cap raw command output before returning it to the executor. The renderer then keeps only the tail of each visible command-output session and limits how many command-output sessions remain expanded in task views.

### Child Event Polling Stop

When all child tasks reach terminal status (`completed`, `failed`, `cancelled`), the 12-second polling interval for child historical events is cleared. Previously the interval ran indefinitely, generating IPC traffic and re-renders for finished work.

**File:** `src/renderer/App.tsx` — poll timer callback checks `tasksRef.current` for non-terminal children.

### Stale Task Reconciliation Guard

The 4-second reconciliation interval that re-fetches task state from the database is skipped entirely when the selected task is already terminal. This prevents unnecessary IPC round-trips and state updates for completed tasks.

**File:** `src/renderer/App.tsx` — early return using `isTerminalTaskStatus()`.

### Map Ref Cleanup

Growing `Map` and `Set` refs (`latestAttentionEventByTaskIdRef`, `taskLastEventTimestampRef`, `completionToastNotifiedPathsRef`) are pruned whenever the task list changes, removing entries for task IDs no longer in the sidebar.

**File:** `src/renderer/App.tsx` — cleanup effect keyed on `tasks`.

### React Render Loop Fix

**Root cause:** `loadTasks` was a plain `async` function recreated every render, passed as `onTasksChanged` to `MainContent`. The team run event effect included `onTasksChanged` in its dependency array, causing infinite re-subscription cycles.

**Fixes:**
- Wrapped `loadTasks` in `useCallback([], [])` — it only uses stable references (state setters, refs, constants)
- Added `onTasksChangedRef` in `MainContent` to decouple the event subscription from prop identity
- Guarded `setWelcomeTaskSuggestions([])` to skip when already empty

**Files:** `src/renderer/App.tsx`, `src/renderer/components/MainContent.tsx`

### Single-Event Merge Fast Path

`mergeTaskEventsByIdentity()` now has a fast path for `incoming.length === 1` (the common streaming case). Instead of building a full `Map` and sorting, it finds-or-appends the single event and skips the sort when the event is already in order.

**File:** `src/renderer/utils/task-event-stream.ts`

### Timeline Virtualization

| Constant | Value | Purpose |
|----------|-------|---------|
| `VIRTUALIZE_THRESHOLD` | 50 | Switch to virtual rendering above this event count |
| `MAX_SHOW_ALL_EVENTS` | 200 | Cap for "Show All" mode |
| `WINDOW_SIZE` | 6 | Default visible events in windowed mode |

Virtualization is now always enabled when events exceed 50, regardless of feature flags. "Show All" is capped at the last 200 events.

**File:** `src/renderer/components/timeline/SemanticTimeline.tsx`

---

## MCP Server Lifecycle

### Connection Reference Counting

`MCPClientManager` tracks which executors use which MCP server connections via `connectionRefCounts: Map<string, Set<string>>` (serverId → executorIds). Servers connected at startup are tagged as `initialServerIds` and are never auto-disconnected.

- `acquireForExecutor(executorId, serverId)` — registers usage
- `releaseForExecutor(executorId)` — removes all references; disconnects servers with zero remaining references (excluding initial servers)

Release is called from:
- `ToolRegistry.cleanup()` — when a task's tool registry is cleaned up
- `daemon.cleanupOldExecutors()` — when cached executors are evicted
- `daemon.completeTask()` — immediately for sub-agent tasks (they won't receive follow-ups)

**Files:** `src/electron/mcp/client/MCPClientManager.ts`, `src/electron/agent/tools/registry.ts`, `src/electron/agent/daemon.ts`

---

## Synthesis Prompt Optimization

### Token-Budgeted Truncation

| Constant | Value |
|----------|-------|
| `MAX_SYNTHESIS_PROMPT_CHARS` | 100,000 |

`groupAndCompactThoughts()` groups agent thoughts by agent name and applies proportional per-agent truncation when total content exceeds the budget. Applied in all three synthesis prompt builders (`buildSynthesisPrompt`, `buildMultiLlmSynthesisPrompt`, `buildCouncilSynthesisPrompt`).

### Synthesis Step Bounds

Synthesis tasks are configured with `maxTurns: 3` and explicit instructions: *"Produce your synthesis in a SINGLE response. Do NOT create sub-tasks or use planning tools."*

### Synthesis Retry with Compact Prompt

When a synthesis item fails (e.g., provider prompt-too-long), the orchestrator retries once per team run by re-invoking `transitionToSynthesizePhase()`. The `synthesisRetried` Set prevents infinite retry loops.

**File:** `src/electron/agents/AgentTeamOrchestrator.ts`

---

## Executor & Cache Management

### Tightened Executor Cache

| Constant | Previous | Current |
|----------|----------|---------|
| `MAX_CACHED_EXECUTORS` | 10 | 2 |
| `EXECUTOR_CACHE_TTL_MS` | 30 min | 3 min |
| Cleanup interval | 5 min | 2 min |

Completed task executors are evicted faster, freeing memory from LLM conversation history, tool registries, and associated state.

**File:** `src/electron/agent/daemon.ts`

---

## Workspace Verification Deduplication

Multiple executors running in the same workspace often trigger identical verification commands (e.g., `tsc --noEmit`, `npm run build`). The daemon now deduplicates these:

- `verificationLocks: Map<string, { promise, startedAt }>` keyed by `workspace::command`
- If the same command was started within 120 seconds, the existing promise is returned
- Locks are cleaned up 5 seconds after completion

The executor's `runStepExternalVerification` routes through `daemon.runWorkspaceVerification()` when available.

**Files:** `src/electron/agent/daemon.ts`, `src/electron/agent/executor.ts`

---

## Database Stability

### WAL Mode + Busy Timeout

```
PRAGMA journal_mode = WAL
PRAGMA busy_timeout = 5000
```

WAL (Write-Ahead Logging) enables concurrent reads during writes — critical for multitask operations where the daemon, executors, and renderer all access the database simultaneously. `busy_timeout = 5000` gives SQLite a 5-second retry window instead of immediately failing with "database is locked".

**File:** `src/electron/database/schema.ts`

### Automatic Maintenance

Daily database maintenance (deferred 60 seconds after startup):
- `pruneOldEvents(90)` — deletes events for terminal tasks older than 90 days
- `vacuumIfNeeded(500)` — runs VACUUM when freelist exceeds 500 MB

**Files:** `src/electron/database/repositories.ts`, `src/electron/agent/daemon.ts`

---

## Search Scope Optimization

### Grep Directory Exclusions

Added to `skipDirs`: `release`, `.cowork`, `out`, `.cache`, `.parcel-cache`, `.turbo`

These directories contain build artifacts and worktrees that bloat search scope during code review tasks.

### Grep Output Capping

| Constant | Value |
|----------|-------|
| `MAX_GREP_OUTPUT_BYTES` | 50,000 |

When serialized grep matches exceed 50 KB, matches are removed from the end until within budget. The `truncated` flag is set so the agent knows results were capped.

### Timeline Payload Sanitizer

| Constant | Value |
|----------|-------|
| `MAX_TIMELINE_STRING_CHARS` | 60,000 |
| `TIMELINE_PAYLOAD_STORAGE_BYTE_LIMIT` | 256 KiB |
| `MAX_TIMELINE_PAYLOAD_PREVIEW_CHARS` | 4,096 |
| `MAX_TIMELINE_SANITIZE_DEPTH` | 12 |
| `MAX_TIMELINE_ARRAY_ITEMS` | 200 |
| `MAX_TIMELINE_OBJECT_KEYS` | 200 |

Timeline event payloads are sanitized before storage. Base64 images and binary-like values are replaced with metadata stubs, strings exceeding 60k characters are truncated with a notice, circular references and unsupported scalar types are omitted, and arrays/objects are bounded. After field-level sanitization, the serialized payload is capped at 256 KiB; oversized payloads retain a compact summary plus a short serialized preview.

**Files:** `src/electron/agent/tools/grep-tools.ts`, `src/electron/agent/timeline-payload-sanitizer.ts`

---

## Load-Aware Trigger Gating

Event triggers are skipped when active task count >= 4, preventing automated triggers from spawning additional work during heavy load.

**Files:** `src/electron/triggers/EventTriggerService.ts`, `src/electron/triggers/types.ts`

---

## Read-Only Review Safety

### Git State Snapshot

When a task is classified as read-only review (via `descriptionHasReadOnlyIntent`), the executor captures `git diff --cached --stat` and `git diff --stat` at task start and stores it as `reviewDiffSnapshot`.

### Tool Restrictions

Read-only review tasks automatically restrict system interaction tools: `group:system`, `take_screenshot`, `type_text`, `screenshot`, `click`, `double_click`, `move_mouse`, `drag`, `scroll`, `keypress`. This prevents review agents from accidentally modifying the workspace.

**File:** `src/electron/agent/executor.ts`

---

## Team Run Phase Tracking

Added `"execute"` phase to `AgentTeamRunPhase`:

```
dispatch → execute → synthesize → complete
```

Previously, the phase stayed at `"think"` during the entire child task execution, showing "Thinking..." in the UI. Now it transitions to `"execute"` when items are spawned, and the `CollaborativeSummaryPanel` shows "Agents are executing..." for the execute phase and "Planning..." for the dispatch phase.

**Files:** `src/shared/types.ts`, `src/electron/agents/AgentTeamOrchestrator.ts`, `src/renderer/components/CollaborativeSummaryPanel.tsx`

---

## Files Modified

| File | Changes |
|------|---------|
| `src/renderer/App.tsx` | Event capping, polling stop, reconciliation guard, Map cleanup, loadTasks stabilization |
| `src/renderer/components/MainContent.tsx` | onTasksChangedRef, welcome suggestions guard |
| `src/renderer/components/CollaborativeSummaryPanel.tsx` | Phase display labels |
| `src/renderer/components/timeline/SemanticTimeline.tsx` | Virtualization enforcement, Show All cap |
| `src/renderer/utils/task-event-stream.ts` | Single-event merge fast path |
| `src/electron/agent/daemon.ts` | Executor cache, verification dedup, MCP cleanup, DB maintenance |
| `src/electron/agent/executor.ts` | Review snapshot, tool restrictions, verification routing |
| `src/electron/agent/tools/grep-tools.ts` | Skip dirs, output capping |
| `src/electron/agent/tools/registry.ts` | MCP release in cleanup |
| `src/electron/agent/timeline-payload-sanitizer.ts` | String truncation, image omission |
| `src/electron/agents/AgentTeamOrchestrator.ts` | Synthesis budget, retry, bounds, execute phase |
| `src/electron/database/schema.ts` | WAL mode, busy timeout |
| `src/electron/database/repositories.ts` | Event pruning, vacuum |
| `src/electron/mcp/client/MCPClientManager.ts` | Connection ref counting |
| `src/electron/triggers/EventTriggerService.ts` | Load-aware gating |
| `src/electron/triggers/types.ts` | getActiveTaskCount dep |
| `src/shared/types.ts` | Execute phase type |

## Verification

```bash
npm run type-check        # Must pass (pre-existing errors in TerminalTabsDock/i18n are unrelated)
npm run test              # 6007 passed, 2 pre-existing failures unrelated to these changes
```

Runtime verification during a multitask run:
- Renderer RSS should stay under 2 GB
- MCP server count should return to baseline after child tasks complete
- Renderer CPU should drop to near 0% within 30 seconds of task completion
- No concurrent duplicate `tsc --noEmit` processes
- Task spinner must disappear within 5 seconds of collaborative task completion
- `CollaborativeSummaryPanel` should show "Agents are executing..." during runs, not "Thinking..."
