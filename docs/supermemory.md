# Supermemory Integration

CoWork OS can use [Supermemory](https://supermemory.ai/) as an external memory layer alongside its built-in local memory runtime.

This integration is intentionally modeled after the Hermes-style provider shape:

- native provider-style configuration in **Settings → Memory Hub**
- workspace-scoped container tags
- explicit external memory tools
- optional prompt-time profile injection
- optional background mirroring of local memory writes
- optional Memory Write Approval gating before external writes commit
- guarded failure behavior so provider outages do not break the main agent loop

Supermemory does **not** replace CoWork's local memory system. CoWork keeps its own archive memory, curated hot memory, workspace kit files, transcript recall, and knowledge graph. Supermemory is an additional external memory lane.

The task's [access profile](access-profiles.md) remains the ceiling for this
integration. Profile network and connector rules apply before Supermemory
searches, profile injection, external remembers, forgets, or background
mirrors. Memory Write Approval is a separate durable-write gate: it can add a
review step, but it cannot grant a denied profile, expand a domain or
filesystem scope, or turn an unavailable profile into an executable one.

---

## What It Adds

When enabled, CoWork adds four explicit tools to the agent runtime:

- `supermemory_profile`
- `supermemory_search`
- `supermemory_remember`
- `supermemory_forget`

It also adds two optional runtime behaviors:

- **Prompt profile injection**: fetches a scoped Supermemory profile and appends it as soft context during chat, execution, and follow-up turns
- **Memory mirroring**: mirrors non-private CoWork memory captures into Supermemory as indexed external documents

Supermemory write paths also participate in Memory Write Governance. If Memory Hub is set to `external_only`, `background_only`, or `all`, external `remember` and mirror writes are staged for user review before they leave the local runtime.

---

## Setup

1. Open **Settings → Memory Hub**.
2. Find the **Supermemory** section.
3. Enable **Supermemory**.
4. Paste your Supermemory API key.
5. Leave the default base URL unless you are self-hosting.
6. Choose a container-tag template.
7. Choose whether Memory Write Approval should govern external writes.
8. Save settings.
9. Click **Test Connection**.

The default base URL is:

```text
https://api.supermemory.ai
```

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
   `search_memories`, `search_sessions`, `search_quotes`, `memory_topics_load`, transcript spans, and workspace markdown.

3. **External Supermemory**
   Scoped profile/search/remember/forget operations plus optional mirrored memory history.

CoWork treats Supermemory results as **soft context**:

- useful prior context
- lower priority than the current user message
- separate from the local workspace kit and local archive memory

Write behavior is governed separately from read behavior. `supermemory_profile` and `supermemory_search` read from the external lane when enabled. `supermemory_remember` and mirror writes can be:

- committed immediately when Memory Write Approval is `off`
- staged in `pending_memory_writes` when the mode covers external/background writes
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

The injected block is wrapped as pinned profile-style context, but it remains advisory. If the user gives newer or conflicting information in the current conversation, the current message should win.

---

## Mirroring Behavior

If **Mirror Memory Writes** is enabled, CoWork mirrors non-private archive-memory captures into Supermemory.
Structured observation metadata remains local-first and authoritative for privacy decisions.
If Memory Write Approval covers background or external writes, a mirror attempt is staged in the approval queue and only sent after approval.

Current mirroring source:

- `MemoryService.capture(...)` for non-private memory entries

Current mirrored payload shape:

- raw memory content as an external document
- metadata including workspace ID, workspace name, task ID, memory type, capture timestamp, and structured observation fields when available

Current exclusions:

- private/strict-mode memory entries are not mirrored
- redacted and suppressed structured observations are not mirrored
- clipboard-only/private sensitive content remains local
- sensitive external-memory payloads are blocked before being stored in the pending approval queue
- this integration does not currently stream every chat turn into Supermemory conversations

That last point matters: CoWork currently mirrors memory captures, not the full conversation transcript lifecycle.

For the local structured-memory model, see [Structured Memory Observations](memory-observations.md).

---

## Tooling

### `supermemory_profile`

Fetches the current profile for the workspace-scoped container, optionally with a query.

Use it when the agent needs:

- durable user context
- recent external context
- relevant external memories before answering

### `supermemory_search`

Runs explicit search against the configured container.

Configurable options include:

- `query`
- `containerTag`
- `limit`
- `threshold`
- `rerank`
- `searchMode`

Supported search modes in CoWork:

- `hybrid`
- `memories`

### `supermemory_remember`

Creates a durable external memory directly in Supermemory.

Use it for:

- preferences
- project facts
- stable context worth keeping outside the local machine

If Memory Write Approval covers external writes, the tool returns a pending approval id instead of creating the external memory immediately. If the payload contains obvious secrets, CoWork blocks the write rather than persisting it to the approval queue.

### `supermemory_forget`

Forgets an external memory by:

- exact memory ID, or
- exact content text

Use it when external memory is outdated or incorrect.

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
- usable with explicit `containerTag` overrides on the Supermemory tools

What CoWork does **not** do yet:

- automatic model-driven container switching
- heuristic auto-routing between work/personal/project containers

If you want multi-container routing today, use explicit `containerTag` values with the Supermemory tools.

---

## Failure Handling

Supermemory failures should not brick the CoWork runtime.

Current safeguards:

- short request timeout
- best-effort prompt injection
- best-effort background mirroring
- approval staging for external/background writes when Memory Write Approval is enabled
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
- workspace kit files remain local and governed by CoWork's existing memory/runtime policies

If you want fully local-only operation, leave Supermemory disabled.

---

## Related Docs

- [Features](features.md#persistent-memory-system)
- [Workspace Memory Flow](workspace-memory-flow.md)
- [Getting Started](getting-started.md)
- [README](../README.md)
