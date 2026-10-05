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

Supermemory does **not** replace CoWork's local memory system. CoWork keeps its own fact store (`memory_items`), archive memory, workspace kit files, conversation recall, and knowledge graph ([Memory Engine](memory-engine.md)). Supermemory is an additional external memory lane.

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
- `memory_remember` with `scope: "external"` stores a memory only in Supermemory (the
  workspace container)
- `memory_forget` with an `external:<id>` id deletes a Supermemory document; with
  `scope: "external"` and `match` text, Supermemory forgets the memory with that text

The earlier `supermemory_profile`, `supermemory_search`, `supermemory_remember` and
`supermemory_forget` tools were hidden aliases for one release and are now removed (see
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
   `memory_items` facts (L0/L1), the `USER.md` / `MEMORY.md` blocks rendered from them, and the wake-up layers.

2. **Local deep recall**
   `memory_recall` over saved facts, the archive, earlier conversations, `.cowork` notes, topic packs and the knowledge graph; `context_recall` for the active task after compaction.

3. **External Supermemory**
   Scoped profile/search/remember/forget operations plus optional mirrored memory history.

CoWork treats Supermemory results as **soft context**:

- useful prior context
- lower priority than the current user message
- separate from the local workspace kit and local archive memory

Write behavior is governed separately from read behavior. `memory_recall` (scope `external`) reads from the external lane when enabled. Mirror writes and `memory_remember` with scope `external` can be:

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

CoWork stores the Supermemory id of each copy (`supermemory_remote_refs`, SEC-17): deleting, suppressing or redacting a local memory, deleting a task and **Clear All Memories** forget the remote copy, and "Disconnect & purge" deletes every recorded copy. Copies sent before remote ids were kept cannot be addressed; remove them with `memory_forget` (an `external:<id>` id, or `scope: "external"` with the exact text) or the Supermemory dashboard.

Reads never become local memory: the profile block and `memory_recall` external hits are held only in a per-task prompt cache, labelled as third-party context, and never written to `memory_items` or the archive (so a remote fact is never stored as something the user said).

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

### External writes

- `memory_remember` with `scope: "external"` creates an external memory directly in the
  workspace container. If an explicit Memory Write review mode covers external writes, it
  returns a pending approval id instead. Before anything leaves the device the write goes
  through the shared memory hygiene: content with `<no-memory>` is refused, secret values
  are redacted with the shared detector (text that is only a secret is refused), and the
  workspace memory settings apply: memory off, privacy mode `disabled` or `strict` (strict
  keeps every memory private) refuse the write, and unreadable settings refuse it too.
  Payloads that still look like credentials (`token=…`) are blocked rather than persisted
  to the approval queue. A task that opted out with `<no-memory>` cannot use it, a task
  started by a third-party channel sender is refused, and plan, analyze and verifier modes
  treat it as a write.
- `memory_forget` with `scope: "external"` and `match` sends the text to Supermemory, which
  forgets the matching memory.

The removed `supermemory_*` tools accepted a `containerTag` override, `threshold`, `rerank`
and `searchMode`; the memory tools always use the workspace's resolved container.

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
- not selectable from the agent tools, which always use the workspace container

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
- copies with a recorded remote id are forgotten when their local record is deleted or hidden
- Supermemory results are never stored locally as memory
- workspace kit files remain local and governed by CoWork's existing memory/runtime policies

If you want fully local-only operation, leave Supermemory disabled.

---

## Related Docs

- [Features](features.md#persistent-memory-system)
- [Workspace Memory Flow](workspace-memory-flow.md)
- [Getting Started](getting-started.md)
- [README](../README.md)
