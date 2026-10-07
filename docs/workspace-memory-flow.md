# Workspace Memory Flow

This document describes how CoWork OS stores, curates, retrieves, and injects workspace memory. The fact store, write path, recall and curation contracts are specified in [Memory Engine](memory-engine.md); this page is the workspace-level overview.

The runtime is a four-layer wake-up model built on top of these storage lanes:

- **Facts (`memory_items`)**: small, prompt-visible facts about the user and workspace, written only through `MemoryWriter` and edited in the Memory Hub (the generated `.cowork/USER.md` / `.cowork/MEMORY.md` auto-blocks are retired)
- **Recall archive**: larger searchable episodic memory/history, not injected by default
- **Structured observations**: inspectable sidecar metadata for archive memories
- **Session recall**: recent transcript/checkpoint history for “what happened in that run?”

An optional external provider lane can also sit beside that local stack. Today that provider is Supermemory, and it is additive rather than authoritative.

[Dreaming](dreaming.md) is the curator of `memory_items`: it merges, resolves, promotes, decays and expires facts, applies safe operations on inferred facts automatically (each one undoable) and queues the rest for the Memory Hub **Review** tab.

## Access Profile Boundary

Workspace memory is subject to the active [access profile](access-profiles.md). Interactive memory
and workspace-kit tools use the same profile-derived filesystem evaluator as other file tools. The
Heartbeat/Dreaming maintenance path also resolves a workspace read guard before inspecting
file-backed kit or transcript evidence; an unavailable profile or denied path is skipped/fails
closed rather than becoming an unrestricted background read. Memory database rows and candidate
records do not grant filesystem authority, and accepted candidate writes still pass through memory
write governance.

Those lanes map into runtime layers as:

- **L0 Identity**: pinned, identity, rule, commitment and user-stated `memory_items` + `USER.md` essentials
- **L1 Essential Story**: `memory_items` recall for the request and playbook patterns
- **L2** (topic packs) is retired
- **L3 Deep Recall**: unified recall and verbatim quote search across tasks/messages/files/memory/KG

Chronicle fits this model as a **screen-context evidence source**, not as a fifth memory lane. Raw passive frames stay ephemeral in app-local storage. When a task uses `screen_context_resolve`, only the single top match is promoted into workspace state, and only if its confidence is at least `0.5`, the task did not opt out with `<no-memory>`, and the access profile allows writing the Chronicle directory. Promoted observations become searchable through unified recall as `screen_context`. When enabled, they can also create linked `screen_context` archive rows through `MemoryService.capture`; those rows are always private, so they stay local and are never mirrored to Supermemory. Screen text never becomes a `memory_items` fact.

---

## Memory Write Governance

Durable memory writes pass through `MemoryWriteGate` before they commit when an
explicit review mode is enabled. CoWork's normal local runtime has no approval
prompts, so it commits new memory writes immediately. This remains true when a
previous session saved a review mode in Memory Hub; the saved setting is kept
for compatibility, but it cannot recreate an approval surface while the
no-prompt policy is active. Memory Hub no longer offers a review-mode select.
To exercise the review queue deliberately in a headless or controlled run, set
`COWORK_MEMORY_WRITE_APPROVAL_MODE`:

- `curated_only`: stage fact writes (`memory_remember` facts and core memory candidate facts, target `curated`).
- `external_only`: stage writes before anything is saved or mirrored to Supermemory.
- `background_only`: stage background, distillation (including core memory candidate facts) and mirror writes while allowing explicit agent tool saves.
- `all`: stage every durable archive, curated, and external memory write.

The queue is therefore an opt-in compatibility path. It is separate from the
task approval flow and never opens a popup. A queued write can be reviewed from
Memory Hub or resolved through `MemoryWriteGate`; if a decision is required by
the task policy, the task uses the assistant message/input flow instead.

Pending writes are stored in `pending_memory_writes` with target layer, action, origin, proposed value, old value when available, evidence metadata, and risk score. The main SQLite database is a normal `better-sqlite3` database with selected encrypted settings/fields, not a whole-file SQLCipher database, so sensitive external-memory payloads are blocked before they are persisted to the approval queue. Explicit tools return the pending id when a write is staged so the runtime can surface the review item instead of reporting a committed write.

Approving a pending write first atomically claims the row as `applying`, replays the stored payload with the write gate bypassed, then marks the row `applied`. Rejecting a write marks it `rejected` without calling the target memory service. Failed replays are marked `failed` with the error text for audit. The no-prompt migration exposes `MemoryWriteGate.rejectAllPending()`, which marks the old unresolved backlog as `rejected` without replaying any stored payload; in-flight `applying` rows are left for their current replay to finish. Take a SQLite backup before a one-time backlog cleanup and verify `pendingCount()` afterward; database deletion is not part of this migration.

The approval gate sits in front of all durable memory write surfaces:

- `memory_remember` (facts go through `MemoryWriter`; `outcome`/`error`/`note` go to the archive) and automatic `MemoryService.capture(...)` archive writes
- Box Brain source writes
- `memory_remember` with scope `external` (target `external`) and optional Supermemory mirroring
- external provider mirror hooks through `ExternalMemoryProvider`

Not staged: Dreaming curation (it has its own Review tab and undo) and core memory candidate facts, which `CoreMemoryDistiller` writes directly through `MemoryWriter` (an open item in the [audit](memory-system-audit-2026-10-03.md#status)).

Read-only recall tools are not staged. Search, profile fetch, inspector views, and prompt synthesis read from the current committed memory layers.

---

## Overview

```text
memory_remember facts / Memory Hub / core candidate facts / awareness / imports
        │
        ├─→ MemoryWriter (salience, redaction, policy, dedupe, supersession)
        │     └─→ memory_items (SQLite, the only fact store)
        │
        ├─→ MemoryService
        │     ├─→ memories + embeddings (archive lane)
        │     └─→ MemoryObservationService
        │           └─→ memory_observation_metadata + FTS sidecar
        │
        ├─→ SupermemoryService (optional)
        │     ├─→ prompt-time profile/search context
        │     └─→ mirrored non-private memory captures
        │
        ├─→ TranscriptStore
        │     └─→ .cowork/memory/transcripts/*
        │
        ├─→ DreamingService (curator of memory_items)
        │     ├─→ MemoryWriter.applyCuration (safe ops, logged in memory_curation_log, undoable)
        │     └─→ dreaming_candidates (proposals for the Memory Hub Review tab)

MemorySynthesizer.synthesize()
        │
        ├─→ L0 Identity
        │     ├─→ workspace kit essentials
        │     └─→ memory_items L0 (MemoryContextBuilder)
        └─→ L1 Essential Story
              └─→ playbook / Box Brain hits

Agent memory tools (audit §8.3)
        ├─→ memory_recall    MemoryRecall: memory_items + archive + conversations
        │                    + knowledge (KG, .cowork markdown) + Supermemory
        ├─→ memory_remember  MemoryWriter (facts) or the archive (outcome/error/note)
        ├─→ memory_forget    real delete of an item or own archive row (asks first)
        ├─→ context_recall   the active task's earlier conversation after compaction
        └─→ kg_*             explicit graph editing (deferred; found through tool_search)

Chronicle promoted observations
        ├─→ .cowork/chronicle/observations + assets
        └─→ ChronicleMemoryService → MemoryService (`screen_context`)
```

---

## Agent Memory Tools

**Tools:** `src/electron/agent/tools/memory-tools.ts`  
**Recall:** `src/electron/memory/MemoryRecall.ts`  
**Routing hint:** `src/electron/memory/memory-tool-routing.ts`

The agent sees four memory tools (audit §8.3), always exposed in the memory lane:

| Tool | Does | Policy |
|---|---|---|
| `memory_recall` | One query over `memory_items`, the archive, the conversation index (other tasks), knowledge (KG entities, `.cowork` markdown) and, when asked for and allowed, Supermemory. Lists are fused by weighted reciprocal rank; results are an index (`id`, lane, snippet, provenance, relevance, token estimate) until `detail: "full"` with `ids`. | Read. Allowed in plan/analyze modes and every plan step. `external` scope needs network access and the `external_service` approval. |
| `memory_remember` | Facts (`preference`, `identity`, `rule`, `project_fact`, `decision`, `commitment`, `correction`, `insight`) through `MemoryWriter`; `outcome`, `error`, `note` to the archive; scope `external` stores the memory only in Supermemory. `user_stated` only when the model sets `user_asked` and the user's latest message really asks to remember (otherwise `inferred`, never pinned, and kept out of L0 until the user pins or confirms it). The agent is told to save, as it works, what a later task would need and the user would otherwise repeat. | Memory write: available in every plan step; denied in plan/analyze modes and to verifier/researcher workers; staged when memory-write approval is on; blocked by `<no-memory>`. |
| `memory_forget` | Real delete of a memory item visible to this workspace (with its older revisions), of this workspace's archive row, or of a Supermemory entry (an `external:<id>` id, or `scope: "external"` with `match` text that Supermemory matches). Otherwise `match` must identify exactly one memory. | Memory write. Asks the user first (`memory_delete` approval, "Forget a memory") unless the item was inferred by this task's agent itself; Supermemory ids take the `external_service` approval. |
| `context_recall` | The active task's earlier conversation (never another task's): durable compaction context when enabled, then the conversation index. | Read. |

All of them are in `group:memory`, so group and public gateway contexts cannot use them, and a managed agent with memory disabled has them denied. Recall output is never re-captured into the archive or the conversation index.

The 16 tools they replace (`search_memories`, `memory_search_index`, `memory_timeline`, `memory_details`, `search_quotes`, `search_sessions`, `memory_topics_load`, `memory_curated_read`, `supermemory_profile`, `supermemory_search`, `memory_save`, `memory_curate`, `supermemory_remember`, `supermemory_forget`, `context_grep`, `context_describe`) were hidden aliases for one release and are now removed: they are no longer registered, resolved as aliases or listed in any policy group, allowlist or deny list, and a call to one fails as an unknown tool. Skills and prompts must use the four tools above. Recorded calls in old task history still render in the timeline (generic tool label), and the conversation index backfill still skips their recorded recall output (`RETIRED_MEMORY_TOOL_NAMES`). `kg_*` stays for explicit graph editing, deferred and discoverable through `tool_search`.

---

## Lane 1 — Facts (`memory_items`)

**Writer:** `src/electron/memory/MemoryWriter.ts`  
**Storage:** `memory_items` table (the old `curated_memory_entries` table was migrated into it and dropped by the legacy data retirement)  
**Views:** `CuratedMemoryService` (workspace scope), Memory Hub "What CoWork knows"  
**Rendered into:** `.cowork/USER.md`, `.cowork/MEMORY.md` auto-blocks

This lane is for the small set of durable facts that should stay front-and-center in prompts:

- user preferences
- identity facts
- durable constraints
- workflow rules
- project facts
- active commitments

### How entries arrive

- explicit user actions (Memory Hub add/edit, `user_stated`)
- the agent's `memory_remember` (`user_stated` only when the user asked to remember, else `inferred`)
- accepted core memory candidates of a fact type (preference, correction, project state, workflow pattern; a constraint only when the user accepted it or auto-promotion is on): `CoreMemoryDistiller` writes them through `MemoryWriter` as `inferred` items with `source_ref.store = "core_candidate"` ([memory-engine.md](memory-engine.md) §1)
- Dreaming promotions of recurring outcomes, imported facts (`import`), awareness beliefs and the adaptive response style (`inferred`)

### Guardrails

- every write passes the salience gate, secret redaction, `<no-memory>` and workspace memory settings, then dedupe by content hash and supersession by subject (a lower-trust source never overrides what the user said)
- fact content is capped at **1000 characters**; the `CuratedMemoryService` view caps curated content at **320 characters** and replace/remove `match` strings at **120 characters**
- workspace items render into auto-managed blocks inside `.cowork/USER.md` and `.cowork/MEMORY.md` (private items never)
- file sync is serialized per workspace to reduce last-writer-wins races
- replace/remove prefers stable `id` values for deterministic updates; the agent forgets an item with `memory_forget` and an id from `memory_recall`

### Prompt behavior

L0 facts are injected by default (the pinned `<cowork_user_profile>` block on plan steps and follow-ups, `<cowork_hot_memory>` on planning and chat); L1 recall of `memory_items` for the current request is added per step. Budgets and surfaces are in [memory-engine.md §4a](memory-engine.md#4a-prompt-read-path-implemented).

### Dreaming interaction

Dreaming curates this lane: it merges duplicates, flags conflicts, promotes recurring archive outcomes, decays unused inferences and closes finished commitments. Safe operations on inferred facts are applied through `MemoryWriter.applyCuration` and can be undone; everything else, and anything touching what the user stated or confirmed, waits in the Memory Hub Review tab. See [Dreaming](dreaming.md).

---

## Lane 2 — Recall Archive

**Service:** `src/electron/memory/MemoryService.ts`  
**Storage:** `memories`, `memory_embeddings`
**Structured sidecar:** `src/electron/memory/MemoryObservationService.ts`, `memory_observation_metadata`

This is the broad searchable archive:

- task outcomes (completion summaries)
- decisions and user feedback
- errors that affected a task (tool errors, failed steps, verification failures)
- user corrections and insights
- explicit `memory_remember` entries of kind `outcome`, `error` or `note`
- imported ChatGPT history and pasted memory exports (through the gated import session)
- accepted core memory candidates that are events (open loops, watch items, recurring-workflow hints)
- compressed summaries (AI compression digests, stored through `capture` with their own observation)

Each row's summary is its first informative line (constant preambles such as the Chronicle provenance line, the compaction preamble, `[Imported from …]` headers and section labels are skipped), and its local embedding and observation text are built from the content, not the summary alone. AI memory compression (on by default per workspace, a daily budget of 20,000 tokens across workspaces) replaces long rows' summaries with a model-written line and groups related rows into digests; it uses the configured provider and costs tokens, and never sends private rows. See [Memory Engine §6a](memory-engine.md#6a-archive-capture-summaries-and-compression).

Every producer uses the same hygiene: `MemoryService.capture` checks `<no-memory>` (in the text, or the caller's `noMemory`), the shared salience gate, workspace memory settings (memory, auto-capture, privacy mode), redacts secret values, applies excluded patterns and inline `<private>` blocks, and dedupes by content hash. Imports go through the gated import API, `MemoryService.openImportSession`: the same checks except auto-capture (an import is an explicit act), dedupe against every imported row visible in the workspace (re-imports, and non-private imports of other workspaces), the observation sidecar and embedding, and the storage cap. Imported facts about the user (ChatGPT `observation` entries) are also written to `memory_items` as `import` items in the workspace scope; deleting, clearing or ignoring the imported row deletes or archives that fact. A source guard test (`memory-writers-sanctioned.test.ts`) keeps every other module from inserting into `memories` or `memory_items`.

Capture is salience-gated (`src/electron/memory/memory-capture-salience.ts`). The daemon no longer archives raw telemetry such as tool calls and results, step progress, plan JSON, assistant messages or file events; the task timeline keeps those. Events from memory-recall tools are never archived, so recalled memories are not re-captured as new ones. A user correction is captured once, where it is detected.

Chronicle-promoted observations remain provenance-rich `screen_context` records so unified recall can surface them separately from ordinary memory text. When background Chronicle memory generation is enabled, the runtime can also create linked `screen_context` memory rows derived from those observations. Those derived rows are summaries with provenance warnings, not raw frame dumps.

This lane uses hybrid lexical retrieval plus hashed local term vectors (no embedding model; real local embeddings were skipped by decision), but it is **not injected by default**. The feature flag `defaultArchiveInjectionEnabled` now defaults to `false`.

The per-turn recall block (`<cowork_memory_recall>`) is query-driven: each turn it injects archive and `.cowork` note matches for the current query. The unconditional "recent memories" lane in that block runs only when `defaultArchiveInjectionEnabled` is on. Both lanes skip memories captured by the current task, so the agent does not see its own tool events echoed back.

### Structured observations

Every archive memory can have a structured observation sidecar keyed by `memory_id`. The sidecar stores title, subtitle, narrative, facts, concepts, file/tool provenance, source event IDs, content hash, capture reason, privacy state, generation source, and migration status.

This gives CoWork a compact index for retrieval and a user-inspectable control plane without rewriting the original `memories` table. The original archive row remains authoritative for full content.

Backfill is deterministic and local. It derives metadata from existing content and summaries without per-row LLM calls. It does not run as a synchronous startup write path; Memory Hub shows status and can trigger rebuild explicitly.

Destructive inspector actions are workspace-scoped. Delete is implemented as confirmed soft-delete: the observation becomes `suppressed`, the underlying memory is marked private, and the row is excluded from default search, prompt recall and every agent read path (`memory_recall` listings and `detail: "full"` expansion) instead of being hard-deleted directly. Rebuild never loosens an existing privacy state.

### Retrieval path

- `memory_recall` (scope `memory`) searches this lane through `MemoryService.searchForRecallAsync` (same hybrid search and visibility as `searchAsync`, without counting a listing as a reference) and fuses it with `memory_items`; `detail: "full"` with `archive:<id>` expands a row only when it belongs to this workspace or is a non-private import, and never when it is suppressed or redacted
- a row read in full counts as a use (`MemoryService.recordPromptInjection`); a listing does not
- archive recall can still be injected when explicitly enabled for a workspace/runtime
- `MemoryTierService` tracks reference counts (search hits and prompt injections) and promotes entries between tiers; it never deletes rows

### Retention

Archive rows are removed only by the workspace's `retention_days` setting (default 90) and storage cap, measured from the later of creation and last reference. The storage cap counts content, summary, the stored embedding and the observation sidecar's text. There is no separate short-tier expiry. Imported rows, Playbook rows, explicit saves and curated promotions are never removed by retention.

### Privacy path

- `<no-memory>` disables automatic capture for the relevant task content
- `<private>...</private>` redacts that segment from captured memory and marks affected derived entries private when needed
- secrets are redacted before storage; private rows are never injected into prompts
- private, redacted, and suppressed observations are excluded from Supermemory mirroring
- redacted and suppressed observations are excluded from both search-based prompt recall and recent-memory prompt recall

### Dreaming interaction

Dreaming reads archive outcomes of the last 30 days as evidence: an outcome that recurs in at least two tasks can be promoted into an `inferred` fact (listing its archive rows in `source_ref.aliases`), and a done signal can close an overdue commitment. It never edits `memories` or `memory_observation_metadata`. Proposals show their evidence in the Memory Hub Review tab.

## Screen Context Evidence — Chronicle Promotions

**Services:** `src/electron/chronicle/ChronicleCaptureService.ts`, `src/electron/chronicle/ChronicleObservationRepository.ts`, `src/electron/chronicle/ChronicleMemoryService.ts`
**Workspace storage:** `.cowork/chronicle/observations/*.json`, `.cowork/chronicle/assets/*`

Chronicle keeps a local recent-screen buffer in app user-data storage, but only writes into the workspace when a task actually used a screen observation.

Promoted Chronicle records contain:

- the original query
- capture timestamp
- app name and window title
- OCR-derived local text snippet
- confidence
- provenance (`untrusted_screen_text`)
- source reference when frontmost URL/file/app metadata can be resolved
- destination hints when the task implied a workflow target such as `google_doc` or `slack_dm`
- linked `memoryId` / `memoryGeneratedAt` fields when background Chronicle memory generation produced a related `screen_context` memory row

Durable promotion is also gated by Chronicle's `respectWorkspaceMemory` setting:

- when it is `true`, Chronicle only persists promoted observations if workspace memory is enabled, auto-capture is enabled, and memory privacy mode is not disabled
- when it is `false`, Chronicle can still persist observations even if workspace memory capture is otherwise restricted

### Retrieval path

- unified recall can surface promoted Chronicle observations as `screen_context`
- Mission Control learning/evidence cards can attach Chronicle-backed evidence refs and a dedicated `Chronicle screen context used` learning step
- linked `screen_context` memory rows can participate in normal memory search and retention logic
- raw passive frames are **not** indexed or injected by default

---

## Optional External Lane — Supermemory

**Service:** `src/electron/memory/SupermemoryService.ts`  
**Surface:** `Settings → Memory → Settings → Connections → Supermemory`

Supermemory is an optional external memory provider that runs alongside CoWork's local memory system.

What it adds:

- scoped profile fetches for prompt construction
- external recall and writes through the memory tools (`memory_recall` / `memory_remember` / `memory_forget` with scope `external`)
- optional mirroring of non-private local memory captures
- workspace-scoped container tags derived from a template such as `cowork:{workspaceId}`

What it does not replace:

- `memory_items` facts
- archive memory
- transcript/session recall
- workspace kit files
- knowledge graph state

### Retrieval and write path

- `memory_recall` with scope `external` searches Supermemory for the workspace's resolved `containerTag`. The lane runs only when Supermemory is configured, the workspace allows network access and the model asked for the scope; the call then needs the `external_service` approval
- `memory_forget` with an `external:<id>` from `memory_recall` removes that external memory
- `memory_remember` with scope `external` stores a memory only in Supermemory (through the memory write gate, `external_service` approval); `memory_forget` with `scope: "external"` and `match` text forgets the Supermemory memory with that text. The write is refused for `<no-memory>`, when workspace memory is off, and in privacy modes `disabled` and `strict`; secret values are redacted before the request (text that is only a secret is refused)
- the earlier `supermemory_*` tools are removed

### Prompt behavior

If prompt injection is enabled in Memory Hub, CoWork appends a Supermemory profile block during chat, execution, and follow-up prompt construction. This block is treated as soft context and should lose to fresher or conflicting user instructions in the active conversation.

### Mirroring behavior

If mirroring is enabled in Memory Hub, `MemoryService.capture(...)` best-effort mirrors non-private memory entries into Supermemory with workspace/task metadata.

Current boundary:

- private or strict-mode entries are not mirrored (this includes all Chronicle-derived memories)
- workspace kit files remain local
- full conversation turn-by-turn sync is not implemented yet
- remote ids are stored (`supermemory_remote_refs`), so deleting, suppressing or clearing local memory forgets the mirrored copy; copies sent before remote ids were kept cannot be addressed
- Supermemory profile and search results are only held in a per-task cache for the prompt; they are never stored locally as memory

### Failure handling

Supermemory requests are guarded with timeouts, best-effort behavior, and a temporary circuit breaker after repeated failures. When the provider is unavailable, CoWork continues with local memory only.

---

## Lane 3 — Session Recall

**Service:** `src/electron/memory/SessionRecallService.ts`  
**Backing store:** the conversation index (`src/electron/memory/conversation-index-sql.ts`, via `DurableContextService`), plus checkpoints in `src/electron/memory/TranscriptStore.ts`

Recent task/session history is a first-class recall lane rather than something folded into archive recall.

There is one conversation search index: `durable_context_events` with an FTS5 index (`unicode61 remove_diacritics 2`) keyed by row id. It is part of the durable context store and is:

- fed from the task event pipeline for every task, whatever the memory settings, except tasks whose prompt carries `<no-memory>`
- clean text extracted from each event (messages, tool calls and results, completion summaries); no raw JSON, no `conversation_snapshot` copies, no recall-tool echoes
- scoped by workspace id; queries use the shared builder in `src/electron/database/fts-query.ts` (Unicode terms, file names kept whole, prefix matching, operator-safe)
- pruned with task-event retention (terminal tasks older than 90 days, and deleted tasks), and removed by task delete and by "Clear All Memories"

The old transcript spans (`transcript_spans` and `.cowork/memory/transcripts/spans/*.jsonl`) are no longer written. A one-time, resumable migration in daily database maintenance moves existing span rows into the index and deletes them (until it finishes, searches also read the remaining span rows), then backfills the index from `task_events`. Leftover JSONL files are removed by task delete, workspace purge and retention.

`durableContextEnabled` now only controls the compaction-recovery layer: recording the full LLM message history and compaction summaries that `context_recall` searches first. `transcriptStoreEnabled` only turns on the query orchestrator's `transcript_context` prompt section.

Checkpoints stay under `.cowork/memory/transcripts/checkpoints/*.json`; they are resume state, not a search source.

Checkpoints are signed with an `hmac-sha256` key held in encrypted settings. A checkpoint without a valid signature (including legacy unkeyed `sha256` ones) is never used for restore; the runtime falls back to the snapshot in the task database. Permission state is never restored from a checkpoint file.

Each checkpoint can now carry two complementary artifacts:

- `structuredSummary`: compact durable synthesis used by existing memory/prompt flows
- `evidencePacket`: exact transcript/message spans with provenance and a dedupe hash

Dreaming reads session recall as one of its main evidence sources after task completion. This gives memory curation access to what actually happened in the run without injecting full transcript history into future prompts by default.

### Checkpoint capture triggers

- **Pre-compaction**: always, before messages are dropped
- **Periodic long-run capture**: every 12 meaningful user/assistant exchanges, deduped by span hash
- **Task completion**: only when the task produced a non-trivial result or decision

### Retrieval path

- `memory_recall` with scope `conversations` searches the conversation index (all of the workspace's tasks except the active one, ranked by relevance and fused with the other lanes); `event:<id>` results expand with `detail: "full"`
- `context_recall` searches the active task only (compaction recovery)
- this is intended for “what happened in that run?” rather than “what should the system remember forever?”

### Verbatim recall

Exact wording comes from `memory_recall` too: conversation hits are clean excerpts of the indexed events, and `detail: "full"` returns the stored text (events, archive rows, `.cowork` markdown line ranges).

---

## Retired: Topic Packs, Daily Summaries and Generated Kit Blocks

Topic packs (`.cowork/memory/topics/*.md` and the `.cowork/memory/MEMORY.md` index), daily
summaries (`.cowork/memory/summaries/*.md`) and the generated `USER.md` / `MEMORY.md`
auto-blocks are retired, with the `layeredMemoryEnabled`, `topicMemoryEnabled` and
`backgroundConsolidationEnabled` settings that drove them. Durable notes live in the memory
folder (the memory repo) and `memory_items`; recall reaches them through `memory_recall`.

- Nothing reads or writes the topic and summary files any more; the markdown index excludes
  `memory/topics/` and `memory/summaries/`, and Clear All Memories still removes leftovers.
- Leftover generated blocks in `USER.md` / `MEMORY.md` are removed once per workspace when a
  task plans in it (see [memory-engine.md](memory-engine.md) §5, "Generated kit views"); the
  prompt strips them meanwhile.

---

## Prompt Synthesis

**Service:** `src/electron/memory/MemorySynthesizer.ts`

Prompt synthesis now builds separate sections instead of one monolithic synthesized-memory block:

- `L0 Identity`: `memory_items` L0 built by `MemoryContextBuilder` (pinned, identity, rule, commitment, curated and user-stated items, named preferences); `memory_items` is the only source
- `<cowork_structured_memory>` — `L1 Essential Story`: playbook and Box Brain hits; on plan steps the builder's `memory_items` recall takes the former hot-memory slot. The knowledge graph is not injected in the default wake-up path; agents reach it through `memory_recall` (scope `knowledge`) and the `kg_*` tools.
- optional Supermemory profile block — external profile/search context appended only when enabled

`L3 Deep Recall` is not injected into the live prompt by default. It stays explicit and tool-driven.

Durable Runtime Context is another explicit, tool-driven lane. It is not part of the default
`L0/L1` prompt payload and is not workspace-wide memory. When enabled, it stores task-scoped runtime
messages and source-linked compaction summaries so `context_recall` can recover facts from the active
task after compaction. Without it, `context_recall` searches the active task's conversation index.

Workspace kit context is still injected separately and placed before the memory sections.

### Budgeting

- plan steps request `1820` estimated tokens from the synthesizer (`MEMORY_CONTEXT_SECTION_TOKENS` in `src/electron/agent/content/prompt-budgets.ts`), and the `memory_context` prompt section is capped at the same value
- in the default wake-up path the workspace kit keeps roughly `30%` of the budget; `.cowork/USER.md`, `MEMORY.md`, `RULES.md`, `.cowork/AGENTS.md` and `IDENTITY.md` come first in that slice
- repo-root `AGENTS.md`/`CLAUDE.md` and docs map files are not part of the memory slice; they have their own `project_guidance` section (1000 tokens)
- design-system context (`design_system`, 1200 tokens), the external memory profile (`external_memory`, 400) and transcript hits (`transcript_context`, 400) also have their own sections
- remaining budget is split between hot memory and structured memory; a short memory-tool routing hint (about 90 tokens, at most 100, naming only the memory tools the model can call: `memory_recall`, `memory_remember`, `memory_forget`, `context_recall`) is included in that budget
- truncation always happens on fragment boundaries and closes any wrapper tag it left open; when the whole prompt is over budget, memory, design-system and project-guidance sections shrink before they are dropped
- `memory_items` text has one budget owner, `MemoryContextBuilder`: L0 600 tokens (`MEMORY_L0_TOKENS`), L1 400 on plan steps and 250 on planning, chat and follow-ups; L0 is cached per session and rebuilt when the hot-memory version changes

### Default injection behavior

- `L0 Identity`: **on**
- `L1 Essential Story`: **on**
- archive memory: **off by default** (the per-turn recall block still injects query matches)
- Supermemory profile injection: **optional**
- `L2 Topic Packs`: **tool-driven**
- `L3 Deep Recall` (`memory_recall`, `context_recall`): **tool-driven**

---

## Workspace Kit Context

**Service:** `src/electron/memory/WorkspaceKitContext.ts`  
**Location:** `.cowork/*.md`

The workspace kit remains a governed durable context layer with its own contracts, freshness windows, and prompt budgets. `USER.md` and `MEMORY.md` contain auto-managed blocks rendered from `memory_items` in addition to human-authored content; hand edits inside a block are synced back shortly after the file is saved, and on every kit sync ([memory-engine.md §5](memory-engine.md#generated-kit-views)).

From **Settings → Memory → Settings → Advanced → Workspace kit**, the "Open USER.md" and "Open MEMORY.md" buttons open (or create if missing) these files directly in the system editor via `kit:openFile` IPC.

Memory Hub also shows a preview of the current `L0/L1` payload plus the `L2/L3` layers excluded from default injection, including fragment counts dropped by budget.

---

## Deleting Memory

**Service:** `src/electron/memory/MemoryWorkspacePurgeService.ts`

- **Task delete:** in the same transaction as the task row, durable context (including the task's conversation index rows), legacy transcript span rows, and the archive memories (except imported rows and explicit saves), KG facts and Playbook evidence derived from the task are removed, and task foreign keys in `dreaming_runs` and `pending_memory_writes` are cleared. Task-scoped `memory_items` are deleted, and with `purgeDerivedMemory` so are inferred, third-party and system items learned in the task. The task's transcript files (leftover JSONL spans, checkpoints, lock file) and its Chronicle observations are removed afterwards, and Supermemory copies of its rows are forgotten.
- **Clear All Memories** (per workspace, from Memory settings): archive memories and observations, durable context, the workspace's `memory_items` (and leftover generated blocks in `.cowork/USER.md` / `.cowork/MEMORY.md`), knowledge graph, Dreaming runs and candidates, core memory candidates, Playbook evidence, pending memory writes, transcripts, leftover topic pack and daily summary files (and `.cowork/memory/MEMORY.md`), Chronicle observations and every Supermemory copy recorded for the workspace. Each store is cleared separately and the result reports per-store counts and failures. Global items are cleared with "Clear global memories" in the Memory Hub.
- **Not covered:** Supermemory copies sent before remote ids were recorded (`supermemory_remote_refs`); remove them with `memory_forget` (scope `external`) or in Supermemory directly.

---

## Message Feedback → Memory

User feedback flows into personalization, not into profile or relationship memory:

```text
User clicks 👍 or 👎 (+ optional reason)
        │
        ▼
kit:submitMessageFeedback IPC (validated)
        │
        ▼
user_feedback task event
        │
        ├─→ archive memory (`decision` row: decision + reason)
        ├─→ AwarenessService.captureFeedback()
        ├─→ AdaptiveStyleEngine.observeFeedback()  [if enabled]
        └─→ FeedbackService → `.cowork/MISTAKES.md` auto block
```

Feedback reason values: `incorrect`, `too_verbose`, `ignored_instructions`, `wrong_tone`, `unsafe`.

---

## Related docs

- [Evolving Agent Intelligence](evolving-agent-intelligence.md)
- [Execution Runtime Model](execution-runtime-model.md)
- [Features](features.md)
- [Integration Setup, Skill Proposals, and Bootstrap Lifecycle](integration-skill-bootstrap-lifecycle.md)
- [Memory Engine](memory-engine.md)
- [Dreaming](dreaming.md)
- [Durable Runtime Context](durable-runtime-context.md)
- [Structured Memory Observations](memory-observations.md)
- [Supermemory Integration](supermemory.md)
