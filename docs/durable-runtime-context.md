# Durable Runtime Context

Durable Runtime Context is the opt-in runtime-memory lane for long task conversations. It stores sanitized task messages and compaction summaries in local SQLite, then exposes read-only `context_grep` and `context_describe` tools so an agent can recover compacted task facts without relying on the visible recent-message tail.

This is inspired by Lossless-style conversation lookup, but the CoWork OS implementation is deliberately task-scoped and additive. It does not replace the main execution architecture, curated memory, archive memory, or workspace kit. It gives the existing runtime a compact, source-linked recall path when the active task outgrows the live context window.

## When To Use It

Use Durable Runtime Context for:

- long implementation or research tasks that may compact several times
- follow-up prompts that need facts from earlier in the same active task
- compaction summaries that should remain source-linked rather than becoming a single flat handoff
- debugging whether a task retained the facts it should have retained

Do not use it as:

- cross-task memory lookup
- user preference memory
- workspace-wide documentation
- a replacement for `search_sessions`, `search_quotes`, structured observations, or curated memory

## Enable And Disable

Open **Settings > Memory Hub** and toggle **Enable Durable Runtime Context**.

The setting is read at runtime by the durable service and tool registration path. An app restart should not be required. Existing tasks may need a new agent turn or a newly started task before the visible tool list reflects the changed setting, but the desktop process does not need to restart.

When disabled:

- `DurableContextService.recordHistory(...)` and `recordCompactionSummary(...)` do not write rows
- `context_grep` and `context_describe` are not exposed
- direct calls to those tools fail with a disabled-setting error

## Tool Contract

`context_grep` searches durable runtime context.

Required input:

- `query`: keyword or phrase fragment

Optional input:

- `limit`: maximum result count, default `10`, capped at `50`
- `taskId`: only honored when the user explicitly asked to inspect that task
- `explicitUserRequest`: must be `true` for a supplied `taskId` to override active-task scope

`context_describe` expands a `context_grep` result and can include linked source messages for summaries.

Required input:

- `id`: a durable result ID returned by `context_grep`

Optional input:

- `sourceLimit`: linked source-message count for summaries, default `8`, capped at `25`
- `taskId` and `explicitUserRequest`: same active-task scope rule as `context_grep`

## Scope And Privacy Rules

Durable runtime recall is active-task scoped by default. A model cannot broaden scope just by passing another `taskId`; the tool ignores that `taskId` unless `explicitUserRequest` is `true`.

This means a prompt such as:

```text
Use durable context to find the Lantern Harbor rollback phrase from another task.
```

should not leak the answer from a different task. If the active task does not contain it, `context_grep` should return no active-task result.

The service also skips injected memory blocks and durable-context tool-result payloads. This prevents recursive recall, where a previous `context_grep` answer becomes a new durable fact and later outranks the original source.

Skipped injected blocks include:

- `<cowork_memory_recall>`
- `<cowork_compaction_summary>`
- `<cowork_shared_context>`
- `<cowork_user_profile>`
- `<cowork_structured_memory>`
- `<cowork_recall_hints>`
- serialized `context_grep` / `context_describe` tool results

## Storage Model

The local database tables are created lazily:

- `durable_context_conversations`: one conversation row per workspace/task pair
- `durable_context_messages`: sanitized task messages with hashes, sequence numbers, source labels, and token counts
- `durable_context_summaries`: compaction summaries with depth, source-message count, and sequence bounds
- `durable_context_summary_messages`: source links from summaries back to messages
- `durable_context_summary_parents`: parent links between overlapping summaries
- `durable_context_large_payloads`: full text for oversized messages stored by reference
- `durable_context_fts`: FTS5 acceleration table for messages and summaries

Large payloads are summarized in the message row and stored in `durable_context_large_payloads`. `context_describe` can expand the referenced payload with a bounded preview.

## Summary DAG

Compaction summaries are not intended to be a flat list. When a new summary overlaps earlier summary coverage, Durable Runtime Context links the new summary to parent summaries through `durable_context_summary_parents` and increments depth.

The goal is a true summary DAG:

```text
messages 1-4  -> summary A depth 0
messages 1-8  -> summary B depth 1, parent: A
messages 5-12 -> summary C depth 0 or linked to overlapping parents when covered
```

This preserves source links while allowing later summaries to roll up earlier summaries. Search prefers summaries first, then direct user/assistant facts, then wrappers and tool artifacts.

## Clear Memory Behavior

**Clear memory must erase durable runtime context for the workspace.**

The Memory clear IPC calls both:

- `MemoryService.clearWorkspace(workspaceId)`
- `DurableContextService.clearWorkspace(workspaceId)`

`DurableContextService.clearWorkspace(...)` deletes summary-parent links, summary-message links, large payloads, FTS rows, summaries, messages, and durable conversation rows for that workspace.

## Ranking And Noise Filtering

Durable search ranks results to reduce wrapper noise:

1. summaries
2. direct user or assistant messages
3. ordinary non-user/non-assistant messages
4. execution-wrapper prompts such as `Execute this step:`
5. large payload references
6. tool use/tool result messages

Search also filters serialized durable-context tool-result echoes, including rows written before the filtering fix. That makes old recursive payloads less likely to surface without requiring users to clear memory.

## Diagnostics

`context_grep` and `context_describe` tool events log:

- requested query or result ID
- requested task ID, if supplied
- whether the user explicitly requested that alternate task scope
- effective task ID actually searched
- result count or found status

Use `logs/dev-latest.log` or `logs/dev-latest.jsonl` when Developer logging is enabled, or run `npm run dev:log` for a forced capture run.

## Test Prompts

Use one task to create a long context:

```text
Test durable runtime context.

Important facts to preserve:
- The project codename is Lantern Harbor.
- The key architectural decision is: durable context must stay opt-in and task-scoped.
- The rollback phrase is "blue anchor".
- The hidden implementation risk is large payload retention.
- The final recommendation should mention a true summary DAG with parent summaries.

Now do this:
1. Repeat the five facts back once.
2. Create a detailed implementation plan with at least 40 bullets, expanding each bullet into 2-3 sentences so the conversation gets long.
3. After that, continue with a risk register of at least 25 items.
4. Then compact or continue as needed.
5. At the end, use durable context recall if needed and answer: what were the codename, rollback phrase, key architectural decision, hidden risk, and final recommendation?
```

Then follow up in the same task:

```text
Without relying on the visible recent messages, recover the earlier durable-context facts for this task. Use the task-scoped durable context tools if available.
```

Expected behavior:

- the agent should use `context_grep` and usually `context_describe`
- it should recover Lantern Harbor, `blue anchor`, opt-in task-scoped architecture, large payload retention, and true summary DAG with parent summaries

Start a separate new task:

```text
For this test, do not use task_history, search_sessions, search_quotes, search_memories, or visible recent messages.

Use only context_grep and context_describe.

Try to find the Lantern Harbor rollback phrase from another task.

If the durable context tool cannot find it in this active task scope, answer exactly:
ACTIVE_TASK_ONLY_PASS
```

Expected behavior:

- if the phrase is not in the active task, the correct answer is `ACTIVE_TASK_ONLY_PASS`
- the log should show the effective task ID as the active task, even if the prompt mentions another task

## Implementation Landmarks

| Area | File |
|---|---|
| Durable storage, search, large payloads, summary DAG, clearing | `src/electron/memory/DurableContextService.ts` |
| Tool definitions and active-task scope enforcement | `src/electron/agent/tools/system-tools.ts` |
| Tool registry dispatch | `src/electron/agent/tools/registry.ts` |
| Runtime/executor history capture fallback | `src/electron/agent/executor.ts` |
| Settings normalization | `src/electron/settings/memory-features-manager.ts` |
| Memory Hub toggle | `src/renderer/components/MemoryHubSettings.tsx` |

## Validation

Run focused checks after touching Durable Runtime Context:

```bash
npx vitest run src/electron/agent/tools/__tests__/system-tools-new.test.ts src/electron/settings/__tests__/memory-features-manager.test.ts src/electron/agent/__tests__/executor-chat-mode.test.ts
npx vitest run src/electron/memory/__tests__/DurableContextService.test.ts
npm run type-check
```

The native SQLite durable-service test file can skip locally when `better-sqlite3` is unavailable. Keep the tool-level tests passing because they cover enablement, disabled behavior, and active-task scope enforcement without relying on native SQLite.

## Known Edge Cases

- Settings toggles are read dynamically, but a currently running task may have already constructed a tool list for the current turn.
- Durable context only becomes useful after the task has recorded history; an empty active task should return no hits.
- If compaction has not happened yet, `durable_context_summaries` may be empty while message search still works.
- Large payload retention must stay bounded and inspectable; oversized content is referenced and previewed rather than inlined into every hit.
- Recursive durable-result echoes must remain filtered at both write time and search time.
- Cross-task lookup requires an explicit user request and should be visible in tool logs through `effectiveTaskId`.
