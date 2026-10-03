# Workspace Memory Flow

This document describes how CoWork OS stores, curates, retrieves, and injects workspace memory after the layered-memory upgrade.

The foundation is still the hybrid memory system, but the runtime now makes it explicit as a four-layer wake-up model built on top of those storage lanes:

- **Curated hot memory**: small, prompt-visible, explicitly edited or promoted
- **Recall archive**: larger searchable memory/history, not injected by default
- **Structured observations**: inspectable sidecar metadata for archive memories
- **Session recall**: recent transcript/checkpoint history for “what happened in that run?”
- **Topic packs**: focused `.cowork/memory/topics/*.md` files loaded explicitly for topical work

An optional external provider lane can also sit beside that local stack. Today that provider is Supermemory, and it is additive rather than authoritative.

Dreaming sits above these lanes as a memory-curation process. It reviews recent transcript evidence, structured observations, and curated hot memory, then writes reviewable `dreaming_candidates` instead of directly changing memory.

## Access Profile Boundary

Workspace memory is subject to the active [access profile](access-profiles.md). Interactive memory
and workspace-kit tools use the same profile-derived filesystem evaluator as other file tools. The
Heartbeat/Dreaming maintenance path also resolves a workspace read guard before inspecting
file-backed kit or transcript evidence; an unavailable profile or denied path is skipped/fails
closed rather than becoming an unrestricted background read. Memory database rows and candidate
records do not grant filesystem authority, and accepted candidate writes still pass through memory
write governance.

Those lanes map into runtime layers as:

- **L0 Identity**: curated user/workspace memory + `USER.md` essentials
- **L1 Essential Story**: playbook patterns, daily activity summaries, active commitments
- **L2 Topic Packs**: focused topic files loaded on demand
- **L3 Deep Recall**: unified recall and verbatim quote search across tasks/messages/files/memory/KG

Chronicle fits this model as a **screen-context evidence source**, not as a fifth memory lane. Raw passive frames stay ephemeral in app-local storage. When a task uses `screen_context_resolve`, only the single top match is promoted into workspace state, and only if its confidence is at least `0.5`, the task did not opt out with `<no-memory>`, and the access profile allows writing the Chronicle directory. Promoted observations become searchable through unified recall as `screen_context`. When enabled, they can also create linked `screen_context` memory entries through the normal memory service; those entries are always private, so they stay local and are never mirrored to Supermemory.

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

- `curated_only`: stage writes to the hot `.cowork/USER.md` / `.cowork/MEMORY.md` layer.
- `external_only`: stage writes before anything is saved or mirrored to Supermemory.
- `background_only`: stage background, distillation, Dreaming, and mirror writes while allowing explicit agent tool saves.
- `all`: stage every durable archive, curated, and external memory write.

The queue is therefore an opt-in compatibility path. It is separate from the
task approval flow and never opens a popup. A queued write can be reviewed from
Memory Hub or resolved through `MemoryWriteGate`; if a decision is required by
the task policy, the task uses the assistant message/input flow instead.

Pending writes are stored in `pending_memory_writes` with target layer, action, origin, proposed value, old value when available, evidence metadata, and risk score. The main SQLite database is a normal `better-sqlite3` database with selected encrypted settings/fields, not a whole-file SQLCipher database, so sensitive external-memory payloads are blocked before they are persisted to the approval queue. Explicit tools return the pending id when a write is staged so the runtime can surface the review item instead of reporting a committed write.

Approving a pending write first atomically claims the row as `applying`, replays the stored payload with the write gate bypassed, then marks the row `applied`. Rejecting a write marks it `rejected` without calling the target memory service. Failed replays are marked `failed` with the error text for audit. The no-prompt migration exposes `MemoryWriteGate.rejectAllPending()`, which marks the old unresolved backlog as `rejected` without replaying any stored payload; in-flight `applying` rows are left for their current replay to finish. Take a SQLite backup before a one-time backlog cleanup and verify `pendingCount()` afterward; database deletion is not part of this migration.

The approval gate sits in front of all durable memory write surfaces:

- `memory_save` and automatic `MemoryService.capture(...)` archive writes
- `memory_curate`, Dreaming accepted candidates, and Core Memory Distiller promotions
- `supermemory_remember` and optional Supermemory mirroring
- external provider mirror hooks through `ExternalMemoryProvider`

Read-only recall tools are not staged. Search, profile fetch, inspector views, and prompt synthesis read from the current committed memory layers.

---

## Overview

```text
User corrections / salient task events / accepted distill candidates
        │
        ├─→ CuratedMemoryService
        │     ├─→ curated_memory_entries (SQLite)
        │     ├─→ .cowork/USER.md (auto block)
        │     └─→ .cowork/MEMORY.md (auto block)
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
        ├─→ DreamingService
        │     ├─→ dreaming_runs
        │     └─→ dreaming_candidates (reviewable memory maintenance proposals)
        │
        └─→ MemoryConsolidator / DailyLogSummarizer
              └─→ .cowork/memory/summaries (one line per task per day)

MemorySynthesizer.synthesize()
        │
        ├─→ L0 Identity
        │     ├─→ workspace kit essentials
        │     └─→ hot curated memory
        └─→ L1 Essential Story
              └─→ playbook / daily summaries / Box Brain hits

Explicit recall tools
        ├─→ memory_search_index
        ├─→ memory_timeline
        ├─→ memory_details
        ├─→ search_memories
        ├─→ search_sessions
        ├─→ search_quotes
        ├─→ memory_topics_load
        ├─→ memory_curate
        ├─→ memory_curated_read
        ├─→ supermemory_profile
        ├─→ supermemory_search
        ├─→ supermemory_remember
        └─→ supermemory_forget

Chronicle promoted observations
        ├─→ .cowork/chronicle/observations + assets
        └─→ ChronicleMemoryService → MemoryService (`screen_context`)
```

---

## Lane 1 — Curated Hot Memory

**Service:** `src/electron/memory/CuratedMemoryService.ts`  
**Storage:** `curated_memory_entries` table  
**Mirrors:** `.cowork/USER.md`, `.cowork/MEMORY.md`

This lane is for the small set of durable facts that should stay front-and-center in prompts:

- user preferences
- identity facts
- durable constraints
- workflow rules
- project facts
- active commitments

### How entries arrive

- explicit agent/user actions through `memory_curate`
- accepted stable promotions from `CoreMemoryDistiller`
- future human edits that are synced back through governed workflows

### Guardrails

- curated content is normalized before storage
- stored curated content is capped at **320 characters**
- `match` strings used for replace/remove are capped at **120 characters**
- writes mirror into auto-managed blocks inside `.cowork/USER.md` and `.cowork/MEMORY.md`
- file sync is serialized per workspace to reduce last-writer-wins races
- replace/remove prefers stable `id` values from `memory_curated_read` for deterministic updates

### Prompt behavior

Curated hot memory is injected by default through `<cowork_hot_memory>`.

### Dreaming interaction

Dreaming can propose curated-memory additions, replacements, or archives when recent evidence shows a correction, contradiction, duplicate entry, open loop, recurring cadence, or durable constraint. Those proposals remain `dreaming_candidates`; there is no review UI yet, so no candidate is currently accepted or applied. Once accepted, a change must go through `CuratedMemoryService`; Dreaming is not allowed to bypass the curated-memory write path.

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
- explicit `memory_save` entries
- imported ChatGPT history
- compressed summaries

Capture is salience-gated (`src/electron/memory/memory-capture-salience.ts`). The daemon no longer archives raw telemetry such as tool calls and results, step progress, plan JSON, assistant messages or file events; the task timeline keeps those. Events from memory-recall tools are never archived, so recalled memories are not re-captured as new ones. A user correction is captured once, where it is detected.

Chronicle-promoted observations remain provenance-rich `screen_context` records so unified recall can surface them separately from ordinary memory text. When background Chronicle memory generation is enabled, the runtime can also create linked `screen_context` memory rows derived from those observations. Those derived rows are summaries with provenance warnings, not raw frame dumps.

This lane still uses hybrid lexical + local semantic retrieval, but it is **not injected by default**. The feature flag `defaultArchiveInjectionEnabled` now defaults to `false`.

The per-turn recall block (`<cowork_memory_recall>`) is query-driven: each turn it injects archive and `.cowork` note matches for the current query. The unconditional "recent memories" lane in that block runs only when `defaultArchiveInjectionEnabled` is on. Both lanes skip memories captured by the current task, so the agent does not see its own tool events echoed back.

### Structured observations

Every archive memory can have a structured observation sidecar keyed by `memory_id`. The sidecar stores title, subtitle, narrative, facts, concepts, file/tool provenance, source event IDs, content hash, capture reason, privacy state, generation source, and migration status.

This gives CoWork a compact index for retrieval and a user-inspectable control plane without rewriting the original `memories` table. The original archive row remains authoritative for full content.

Backfill is deterministic and local. It derives metadata from existing content and summaries without per-row LLM calls. It does not run as a synchronous startup write path; Memory Hub shows status and can trigger rebuild explicitly.

Destructive inspector actions are workspace-scoped. Delete is implemented as confirmed soft-delete: the observation becomes `suppressed`, the underlying memory is marked private, and the row is excluded from default search, prompt recall and every agent read path (`search_memories`, `memory_search_index`/`timeline`/`details`) instead of being hard-deleted directly. Rebuild never loosens an existing privacy state.

### Retrieval path

- `search_memories` searches archive memory plus indexed `.cowork/` markdown
- `memory_search_index` returns compact structured observation matches first
- `memory_timeline` returns compact neighboring observations around an anchor ID or query
- `memory_details` expands only selected observation IDs and is scoped to the active workspace
- archive recall can still be injected when explicitly enabled for a workspace/runtime
- `MemoryTierService` tracks reference counts (search hits and prompt injections) and promotes entries between tiers; it never deletes rows

### Retention

Archive rows are removed only by the workspace's `retention_days` setting (default 90) and storage cap, measured from the later of creation and last reference. There is no separate short-tier expiry. Imported rows, Playbook rows, explicit saves and curated promotions are never removed by retention.

### Privacy path

- `<no-memory>` disables automatic capture for the relevant task content
- `<private>...</private>` redacts that segment from captured memory and marks affected derived entries private when needed
- secrets are redacted before storage; private rows are never injected into prompts
- private, redacted, and suppressed observations are excluded from Supermemory mirroring
- redacted and suppressed observations are excluded from both search-based prompt recall and recent-memory prompt recall

### Dreaming interaction

Dreaming uses structured observations as compact evidence for memory maintenance. It can detect likely stale archive facts, contradictions, and repeated patterns, but it records proposals in `dreaming_candidates` rather than editing `memories` or `memory_observation_metadata` directly.

Dreaming candidates keep evidence refs so a future Memory Hub review surface can show why a proposal exists before any archive, replacement, or topic-pack update is applied. That surface does not exist yet.

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
**Surface:** `Settings → Memory Hub → Supermemory`

Supermemory is an optional external memory provider that runs alongside CoWork's local memory system.

What it adds:

- scoped profile fetches for prompt construction
- explicit external recall and write tools
- optional mirroring of non-private local memory captures
- workspace-scoped container tags derived from a template such as `cowork:{workspaceId}`

What it does not replace:

- curated hot memory
- archive memory
- transcript/session recall
- workspace kit files
- knowledge graph state

### Retrieval and write path

- `supermemory_profile` fetches a scoped profile plus relevant external context
- `supermemory_search` performs explicit search against the resolved or overridden `containerTag`
- `supermemory_remember` creates a durable external memory directly in Supermemory
- `supermemory_forget` removes an external memory by ID or exact content

### Prompt behavior

If prompt injection is enabled in Memory Hub, CoWork appends a Supermemory profile block during chat, execution, and follow-up prompt construction. This block is treated as soft context and should lose to fresher or conflicting user instructions in the active conversation.

### Mirroring behavior

If mirroring is enabled in Memory Hub, `MemoryService.capture(...)` best-effort mirrors non-private memory entries into Supermemory with workspace/task metadata.

Current boundary:

- private or strict-mode entries are not mirrored (this includes all Chronicle-derived memories)
- workspace kit files remain local
- full conversation turn-by-turn sync is not implemented yet
- remote ids are not stored, so deleting, suppressing or clearing local memory does not remove the mirrored copy from Supermemory

### Failure handling

Supermemory requests are guarded with timeouts, best-effort behavior, and a temporary circuit breaker after repeated failures. When the provider is unavailable, CoWork continues with local memory only.

---

## Lane 3 — Session Recall

**Service:** `src/electron/memory/SessionRecallService.ts`  
**Backing store:** `src/electron/memory/TranscriptStore.ts`

Recent task/session history is now a first-class recall lane rather than something folded into archive recall.

Stored artifacts include:

- transcript spans under `.cowork/memory/transcripts/spans/*.jsonl`, indexed once in SQLite (`transcript_spans`)
- lightweight checkpoints under `.cowork/memory/transcripts/checkpoints/*.json`

Full `conversation_snapshot` events are not stored as spans (the task database keeps the latest snapshot), and oversized payloads are stored as a preview. Transcript retention follows task-event retention (90 days). Deleting a task removes its spans, JSONL file, checkpoints and lock file.

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

- `search_sessions` searches transcript spans
- optional checkpoint search can widen recall to summary/checkpoint payloads
- this is intended for “what happened in that run?” rather than “what should the system remember forever?”

### Verbatim recall lane

`search_quotes` is the low-loss recall lane for exact wording. It searches:

- transcript spans
- task messages
- imported/archive memories
- indexed workspace markdown

Results return exact excerpts plus provenance such as `sourceType`, `objectId`, `taskId`, `timestamp`, optional `path`, and ranking reason. Transcript/message hits outrank synthesized-memory hits when both match.

---

## Topic Packs

**Service:** `src/electron/memory/LayeredMemoryIndexService.ts`  
**Files:** `.cowork/memory/MEMORY.md`, `.cowork/memory/topics/*.md`

Topic packs are query-scoped, focused memory slices generated from:

- relevant archive recall
- relevant indexed markdown
- curated hot memory summary lines
- recent daily summaries

### Retrieval path

- `memory_topics_load` can rebuild topic files for a query
- `memory_topics_load(refresh: false)` now performs a true read-only lookup over existing topic files
- topic snippets are intentionally capped so packs stay compact

Topic packs are for topical work such as “bring me the onboarding context for billing migrations,” not for always-on prompt injection.

---

## Daily Summaries

**Writer:** `src/electron/memory/MemoryConsolidator.ts` (via `DailyLogSummarizer.appendTaskLine`)  
**Reader:** `src/electron/memory/DailyLogSummarizer.ts`  
**Location:** `.cowork/memory/summaries/<YYYY-MM-DD>.md`

When `backgroundConsolidationEnabled` is on (default off), each completed task adds or replaces one line in today's summary under `## Task Activity`: the time, a short excerpt of the task prompt and the number of transcript events. A file keeps at most 40 lines of at most 200 characters. Raw transcript payloads are never copied into the summary; older summaries in the previous "Consolidated Signals" layout are replaced on the next append. A consolidation lock left behind by a crashed run is removed after 10 minutes.

Recent summaries (last 7 days) are injected as `daily_summary` fragments in `L1 Essential Story`. They are an activity index, not a synthesis of decisions or preferences. There is no separate raw daily log.

---

## Prompt Synthesis

**Service:** `src/electron/memory/MemorySynthesizer.ts`

Prompt synthesis now builds separate sections instead of one monolithic synthesized-memory block:

- `<cowork_hot_memory>` — `L0 Identity`: curated hot memory + user/profile + active relationship items
- `<cowork_structured_memory>` — `L1 Essential Story`: playbook, daily summaries and active commitments. The knowledge graph is not injected in the default wake-up path; agents reach it through the `kg_*` tools.
- optional Supermemory profile block — external profile/search context appended only when enabled

`L2 Topic Packs` and `L3 Deep Recall` are not injected into the live prompt by default. They stay explicit and tool-driven.

Durable Runtime Context is another explicit, tool-driven lane. It is not part of the default
`L0/L1` prompt payload and is not workspace-wide memory. When enabled, it stores task-scoped runtime
messages and source-linked compaction summaries so `context_grep` and `context_describe` can recover
facts from the active task after compaction.

Workspace kit context is still injected separately and placed before the memory sections.

### Budgeting

- plan steps request `1820` estimated tokens from the synthesizer (`MEMORY_CONTEXT_SECTION_TOKENS` in `src/electron/agent/content/prompt-budgets.ts`), and the `memory_context` prompt section is capped at the same value
- in the default wake-up path the workspace kit keeps roughly `30%` of the budget; `.cowork/USER.md`, `MEMORY.md`, `RULES.md`, `.cowork/AGENTS.md` and `IDENTITY.md` come first in that slice
- repo-root `AGENTS.md`/`CLAUDE.md` and docs map files are not part of the memory slice; they have their own `project_guidance` section (1000 tokens)
- design-system context (`design_system`, 1200 tokens), the external memory profile (`external_memory`, 400) and transcript hits (`transcript_context`, 400) also have their own sections
- remaining budget is split between hot memory and structured memory; a short memory-tool routing hint (at most 120 tokens, naming only tools the model can call) is included in that budget
- truncation always happens on fragment boundaries and closes any wrapper tag it left open; when the whole prompt is over budget, memory, design-system and project-guidance sections shrink before they are dropped
- follow-ups, chat and planning get a compact L0 block (curated memory plus identity, 450 tokens), cached per task and rebuilt after curated, profile or relationship writes

### Default injection behavior

- `L0 Identity`: **on**
- `L1 Essential Story`: **on**
- archive memory: **off by default** (the per-turn recall block still injects query matches)
- Supermemory profile injection: **optional**
- `L2 Topic Packs`: **tool-driven**
- `L3 Deep Recall` (`memory_search_index`, `memory_timeline`, `memory_details`, `search_quotes`, `search_sessions`, `search_memories`): **tool-driven**

---

## Workspace Kit Context

**Service:** `src/electron/memory/WorkspaceKitContext.ts`  
**Location:** `.cowork/*.md`

The workspace kit remains a governed durable context layer with its own contracts, freshness windows, and prompt budgets. `USER.md` and `MEMORY.md` now contain auto-managed curated-memory blocks in addition to human-authored content.

From **Settings → Memory Hub → Per Workspace**, the "Open USER.md" and "Open MEMORY.md" buttons open (or create if missing) these files directly in the system editor via `kit:openFile` IPC.

Memory Hub also shows a preview of the current `L0/L1` payload plus the `L2/L3` layers excluded from default injection, including fragment counts dropped by budget.

---

## Deleting Memory

**Service:** `src/electron/memory/MemoryWorkspacePurgeService.ts`

- **Task delete:** in the same transaction as the task row, durable context, transcript span rows, and the archive memories (except imported rows and explicit saves), KG facts and Playbook evidence derived from the task are removed, and task foreign keys in `dreaming_runs` and `pending_memory_writes` are cleared. The task's transcript files (JSONL spans, checkpoints, lock file) and its Chronicle observations are removed afterwards.
- **Clear All Memories** (per workspace, from Memory settings): archive memories and observations, durable context, curated entries (and the auto-managed blocks in `.cowork/USER.md` / `.cowork/MEMORY.md`), knowledge graph, Dreaming runs and candidates, core memory candidates, Playbook evidence, pending memory writes, transcripts, topic packs and `.cowork/memory/MEMORY.md`, daily summaries and Chronicle observations. Each store is cleared separately and the result reports per-store counts and failures.
- **Not covered:** copies already mirrored to Supermemory. The local runtime does not keep remote ids, so it cannot delete them; remove them in Supermemory directly.

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
- [Durable Runtime Context](durable-runtime-context.md)
- [Structured Memory Observations](memory-observations.md)
- [Supermemory Integration](supermemory.md)
