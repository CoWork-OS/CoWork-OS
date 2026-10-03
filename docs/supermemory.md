# Supermemory Integration

CoWork OS can use [Supermemory](https://supermemory.ai/) as an external memory layer alongside its built-in local memory runtime.

This integration is intentionally modeled after the Hermes-style provider shape:

- native provider-style configuration in **Settings → Memory Hub**
- workspace-scoped container tags
- explicit external memory tools
- optional prompt-time profile injection
- optional background mirroring of local memory writes
- optional explicit Memory Write review gating before external writes commit
- guarded failure behavior so provider outages do not break the main agent loop

Supermemory does **not** replace CoWork's local memory system. CoWork keeps its own archive memory, curated hot memory, workspace kit files, transcript recall, and knowledge graph. Supermemory is an additional external memory lane.

The task's [access profile](access-profiles.md) remains the ceiling for this
integration. Profile network and connector rules apply before Supermemory
searches, profile injection, external remembers, forgets, or background
mirrors. Memory Write review is a separate durable-write gate: it can add a
review step when explicitly enabled, but it cannot grant a denied profile,
expand a domain or filesystem scope, or turn an unavailable profile into an
executable one. The normal no-prompt runtime commits ordinary memory writes
without opening an approval popup. A task-level policy decision still uses the
assistant message/input flow.

---

## What It Adds

When enabled, Supermemory becomes one lane of the consolidated memory tools:

- `memory_recall` with `scopes: ["external"]` searches the workspace container (the
  `external` lane is only used when the workspace allows network access and Supermemory is
  configured)
- `memory_forget` with an `external:<id>` id deletes a Supermemory document

The earlier `supermemory_profile`, `supermemory_search`, `supermemory_remember` and
`supermemory_forget` tools are deprecated, hidden aliases for one release: they still run
when a saved prompt or skill calls them, but they are no longer offered to the model (see
[Memory Engine](memory-engine.md#4b-recall-and-the-agent-tool-surface-implemented)).

It also adds two optional runtime behaviors:

- **Prompt profile injection**: fetches a scoped Supermemory profile and appends it as soft context during chat, execution, and follow-up turns
- **Memory mirroring**: mirrors non-private CoWork memory captures into Supermemory as indexed external documents

Supermemory write paths also participate in Memory Write Governance. If `COWORK_MEMORY_WRITE_APPROVAL_MODE` is set to `external_only`, `background_only`, or `all`, external `remember` and mirror writes are staged for review before they leave the local runtime. Memory Hub no longer has a review-mode select.

---

## Setup

1. Open **Settings → Memory Hub**.
2. Find the **Supermemory** section.
3. Enable **Supermemory**.
4. Paste your Supermemory API key.
5. Choose a container-tag template.
6. Save settings.
7. Click **Test Connection**.

The normal no-prompt runtime commits new writes immediately. A controlled run can opt into the review queue with `COWORK_MEMORY_WRITE_APPROVAL_MODE`.

The base URL is fixed:

```text
https://api.supermemory.ai
```

It is not editable, and any other configured value is replaced by this host. Self-hosted endpoints are not supported.

The default container template is:

```text
cowork:{workspaceId}
```

Supported template variables:

- `{workspaceId}`
- `{workspaceName}`

These are sanitized into a valid Supermemory `containerTag`.

---

## Runtime Model

CoWork now has three distinct memory surfaces:

1. **Local prompt-visible memory**
   Curated hot memory, `USER.md`, `MEMORY.md`, and the `L0/L1` wake-up layers.

2. **Local deep recall**
   `memory_recall` over saved facts, the archive, earlier conversations, `.cowork` notes, topic packs and the knowledge graph; `context_recall` for the active task after compaction.

3. **External Supermemory**
   Scoped profile/search/remember/forget operations plus optional mirrored memory history.

CoWork treats Supermemory results as **soft context**:

- useful prior context
- lower priority than the current user message
- separate from the local workspace kit and local archive memory

Write behavior is governed separately from read behavior. `memory_recall` (scope `external`) reads from the external lane when enabled. Mirror writes and the deprecated `supermemory_remember` alias can be:

- committed immediately in the normal no-prompt runtime
- staged in `pending_memory_writes` only when an explicit review mode is enabled
- blocked before staging when the payload contains obvious secrets such as API keys, tokens, credentials, bearer tokens, or private keys

---

## Prompt Injection

If **Inject Supermemory Profile Into Prompts** is enabled, CoWork performs a scoped profile fetch during prompt construction and injects:

- static facts
- dynamic recent context
- a small set of relevant external memories for the current task/query

This happens in:

- chat turns
- execution turns
- follow-up turns

The injected block has its own `external_memory` prompt section and `<cowork_external_memory>` tag, is cached per task for 10 minutes, and remains advisory. If the user gives newer or conflicting information in the current conversation, the current message should win.

---

## Mirroring Behavior

If **Mirror Memory Writes** is enabled, CoWork mirrors non-private archive-memory captures into Supermemory.
Structured observation metadata remains local-first and authoritative for privacy decisions.
If an explicit Memory Write review mode covers background or external writes, a
mirror attempt is staged in the review queue and only sent after review. The
queue is opt-in and does not open a popup in the normal runtime.

Current mirroring source:

- `MemoryService.capture(...)` for non-private memory entries

Current mirrored payload shape:

- raw memory content as an external document
- metadata including workspace ID, workspace name, task ID, memory type, capture timestamp, and structured observation fields when available

Current exclusions:

- private/strict-mode memory entries are not mirrored
- Chronicle-derived (`screen_context`) memories are always captured as private, so screen text is never mirrored
- redacted and suppressed structured observations are not mirrored
- mirroring requires network access in the task's access profile
- clipboard-only/private sensitive content remains local
- sensitive external-memory payloads are blocked before being stored in the pending approval queue
- this integration does not currently stream every chat turn into Supermemory conversations

That last point matters: CoWork currently mirrors memory captures, not the full conversation transcript lifecycle.

Automatic captures are salience-gated, so mirroring sends task outcomes, decisions and feedback, errors, corrections and explicit saves rather than raw tool calls and results.

CoWork does not store the Supermemory id of a mirrored document. Deleting, suppressing or redacting a local memory, deleting a task, **Clear All Memories** and disabling Supermemory therefore do not remove mirrored copies. Use `memory_forget` with an `external:<id>` id, the deprecated `supermemory_forget` alias (which also accepts exact content text), or the Supermemory dashboard to remove them.

For the local structured-memory model, see [Structured Memory Observations](memory-observations.md).

---

## Tooling

### `memory_recall` (scope `external`)

Searches the workspace-scoped container and fuses the hits with the local lanes (external
hits are weighted lowest). Supermemory is queried only when the workspace may reach the
network and Supermemory is configured; otherwise the tool reports the lane as unavailable.

### `memory_forget` with an `external:<id>` id

Deletes one Supermemory document by id (an id returned by `memory_recall`). It needs network
access. This is the only remote delete path; local deletes do not call it.

### Deprecated aliases

- `supermemory_profile` and `supermemory_search` run `memory_recall` with scope `external`
  (query and limit only; `containerTag`, `threshold`, `rerank` and `searchMode` are ignored).
- `supermemory_remember` keeps its own implementation: it creates an external memory
  directly. If an explicit Memory Write review mode covers external writes, it returns a
  pending approval id instead. If the payload contains obvious secrets, CoWork blocks the
  write rather than persisting it to the approval queue. A task that opted out with
  `<no-memory>` cannot use it, and plan, analyze and verifier modes treat it as a write.
- `supermemory_forget` with `memoryId` runs `memory_forget`; with exact content text it uses
  the earlier implementation.

Each alias result carries a `deprecated` notice naming the replacement.

---

## Container Tags And Scope

By default, CoWork resolves one workspace-scoped container tag from the configured template.

Examples:

```text
cowork:workspace-123
cowork:Client-A
```

Custom container entries can also be stored in the UI as named namespaces. Today, those entries are:

- configuration metadata
- useful for human/operator reference
- usable with explicit `containerTag` overrides on the deprecated `supermemory_remember` alias

What CoWork does **not** do yet:

- automatic model-driven container switching
- heuristic auto-routing between work/personal/project containers

`memory_recall` always searches the workspace's resolved container.

---

## Failure Handling

Supermemory failures should not brick the CoWork runtime.

Current safeguards:

- short request timeout
- best-effort prompt injection
- best-effort background mirroring
- approval staging for external/background writes when an explicit Memory Write review mode is enabled
- pre-queue blocking for sensitive external-memory payloads
- circuit breaker after repeated request failures

When the circuit breaker opens, CoWork pauses Supermemory requests temporarily and keeps running with local memory only.

The Memory Hub shows:

- whether the API key is configured
- the latest connection-test result
- the most recent provider error
- circuit-breaker pause state when active

---

## Privacy And Boundaries

Important boundaries:

- CoWork's local memory remains the primary durable memory system
- Supermemory is optional and external
- mirrored local memory writes can leave the device
- external writes can be approval-gated before leaving the device
- obvious secrets in external-memory payloads are blocked before they are stored in the pending queue
- private memory entries are not mirrored
- mirrored copies are not removed by local deletes; there is no automatic remote forget
- workspace kit files remain local and governed by CoWork's existing memory/runtime policies

If you want fully local-only operation, leave Supermemory disabled.

---

## Related Docs

- [Features](features.md#persistent-memory-system)
- [Workspace Memory Flow](workspace-memory-flow.md)
- [Getting Started](getting-started.md)
- [README](../README.md)
