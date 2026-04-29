# Workspace Memory Flow

This document describes how CoWork OS stores, curates, retrieves, and injects workspace memory after the layered-memory upgrade.

The foundation is still the hybrid memory system, but the runtime now makes it explicit as a four-layer wake-up model built on top of those storage lanes:

- **Curated hot memory**: small, prompt-visible, explicitly edited or promoted
- **Recall archive**: larger searchable memory/history, not injected by default
- **Structured observations**: inspectable sidecar metadata for archive memories
- **Session recall**: recent transcript/checkpoint history for “what happened in that run?”
- **Topic packs**: focused `.cowork/memory/topics/*.md` files loaded explicitly for topical work

An optional external provider lane can also sit beside that local stack. Today that provider is Supermemory, and it is additive rather than authoritative.

Those lanes map into runtime layers as:

- **L0 Identity**: curated user/workspace memory + `USER.md` essentials
- **L1 Essential Story**: durable decisions, weekly/daily synthesis, active commitments
- **L2 Topic Packs**: focused topic files loaded on demand
- **L3 Deep Recall**: unified recall and verbatim quote search across tasks/messages/files/memory/KG

Chronicle fits this model as a **screen-context evidence source**, not as a fifth memory lane. Raw passive frames stay ephemeral in app-local storage. Only task-used Chronicle observations are promoted into workspace state and become searchable through unified recall as `screen_context`. When enabled, those promoted observations can also create linked `screen_context` memory entries through the normal memory service instead of bypassing it.

---

## Overview

```text
User messages / task events / accepted distill candidates
        │
        ├─→ CuratedMemoryService
        │     ├─→ curated_memory_entries (SQLite)
        │     ├─→ .cowork/USER.md (auto block)
        │     └─→ .cowork/MEMORY.md (auto block)
        │
        ├─→ MemoryService
        │     ├─→ memories + embeddings + summaries (archive lane)
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
        └─→ DailyLogService / DailyLogSummarizer
              └─→ .cowork/memory/daily + summaries

MemorySynthesizer.synthesize()
        │
        ├─→ L0 Identity
        │     ├─→ workspace kit essentials
        │     └─→ hot curated memory
        └─→ L1 Essential Story
              └─→ playbook / KG / daily summaries

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

---

## Lane 2 — Recall Archive

**Service:** `src/electron/memory/MemoryService.ts`  
**Storage:** `memories`, `memory_embeddings`, `memory_summaries`
**Structured sidecar:** `src/electron/memory/MemoryObservationService.ts`, `memory_observation_metadata`

This is the broad searchable archive:

- observations
- decisions
- errors
- insights
- imported ChatGPT history
- compressed summaries

Chronicle-promoted observations remain provenance-rich `screen_context` records so unified recall can surface them separately from ordinary memory text. When background Chronicle memory generation is enabled, the runtime can also create linked `screen_context` memory rows derived from those observations. Those derived rows are summaries with provenance warnings, not raw frame dumps.

This lane still uses hybrid lexical + local semantic retrieval, but it is **not injected by default**. The feature flag `defaultArchiveInjectionEnabled` now defaults to `false`.

### Structured observations

Every archive memory can have a structured observation sidecar keyed by `memory_id`. The sidecar stores title, subtitle, narrative, facts, concepts, file/tool provenance, source event IDs, content hash, capture reason, privacy state, generation source, and migration status.

This gives CoWork a compact index for retrieval and a user-inspectable control plane without rewriting the original `memories` table. The original archive row remains authoritative for full content.

Backfill is deterministic and local. It derives metadata from existing content and summaries without per-row LLM calls. It does not run as a synchronous startup write path; Memory Hub shows status and can trigger rebuild explicitly.

Destructive inspector actions are workspace-scoped. Delete is implemented as confirmed soft-delete: the observation becomes `suppressed`, the underlying memory is marked private, and the row is excluded from default search and prompt recall instead of being hard-deleted directly.

### Retrieval path

- `search_memories` searches archive memory plus indexed `.cowork/` markdown
- `memory_search_index` returns compact structured observation matches first
- `memory_timeline` returns compact neighboring observations around an anchor ID or query
- `memory_details` expands only selected observation IDs and is scoped to the active workspace
- archive recall can still be injected when explicitly enabled for a workspace/runtime
- `MemoryTierService` still tracks reference counts and promotes/evicts archive entries over time

### Privacy path

- `<no-memory>` disables automatic capture for the relevant task content
- `<private>...</private>` redacts that segment from captured memory and marks affected derived entries private when needed
- private, redacted, and suppressed observations are excluded from Supermemory mirroring
- redacted and suppressed observations are excluded from both search-based prompt recall and recent-memory prompt recall

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

- private or strict-mode entries are not mirrored
- workspace kit files remain local
- full conversation turn-by-turn sync is not implemented yet

### Failure handling

Supermemory requests are guarded with timeouts, best-effort behavior, and a temporary circuit breaker after repeated failures. When the provider is unavailable, CoWork continues with local memory only.

---

## Lane 3 — Session Recall

**Service:** `src/electron/memory/SessionRecallService.ts`  
**Backing store:** `src/electron/memory/TranscriptStore.ts`

Recent task/session history is now a first-class recall lane rather than something folded into archive recall.

Stored artifacts include:

- transcript spans under `.cowork/memory/transcripts/spans/*.jsonl`
- lightweight checkpoints under `.cowork/memory/transcripts/checkpoints/*.json`

Each checkpoint can now carry two complementary artifacts:

- `structuredSummary`: compact durable synthesis used by existing memory/prompt flows
- `evidencePacket`: exact transcript/message spans with provenance and a dedupe hash

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

## Daily Logs and Summaries

### Operational Daily Log

**Service:** `src/electron/memory/DailyLogService.ts`  
**Location:** `.cowork/memory/daily/<YYYY-MM-DD>.md`

When another runtime path or automation writes entries through `DailyLogService`, the files act as raw operational journals for:

- user feedback events
- task completions
- notable decisions
- high-value observations or corrections

Raw daily logs are never injected into prompts.

### Daily Summaries

**Service:** `src/electron/memory/DailyLogSummarizer.ts`  
**Location:** `.cowork/memory/summaries/<YYYY-MM-DD>.md`

Daily summaries remain part of the structured memory lane. They are ranked below curated/user relationship facts and above raw archive snippets when archive injection is enabled.

---

## Prompt Synthesis

**Service:** `src/electron/memory/MemorySynthesizer.ts`

Prompt synthesis now builds separate sections instead of one monolithic synthesized-memory block:

- `<cowork_hot_memory>` — `L0 Identity`: curated hot memory + user/profile + active relationship items
- `<cowork_structured_memory>` — `L1 Essential Story`: playbook, daily summaries, active commitments, and current KG context
- optional Supermemory profile block — external profile/search context appended only when enabled

`L2 Topic Packs` and `L3 Deep Recall` are not injected into the live prompt by default. They stay explicit and tool-driven.

Workspace kit context is still injected separately and placed before the memory sections.

### Budgeting

- total memory synthesis budget defaults to `2800` estimated tokens
- workspace kit keeps roughly `35%` of the budget
- remaining budget is split between hot memory and structured memory
- fragment selection happens before rendering, so truncation does not cut markup blocks mid-stream

### Default injection behavior

- `L0 Identity`: **on**
- `L1 Essential Story`: **on**
- archive memory: **off by default**
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

## Message Feedback → Memory

User feedback still flows into memory/personalization systems:

```text
User clicks 👍 or 👎 (+ optional reason)
        │
        ▼
kit:submitMessageFeedback IPC
        │
        ▼
UserProfileService.ingestUserFeedback()
        │
        ├─→ RelationshipMemoryService
        └─→ AdaptiveStyleEngine.observeFeedback()  [if enabled]
```

Feedback reason values: `incorrect`, `too_verbose`, `ignored_instructions`, `wrong_tone`, `unsafe`.

---

## Related docs

- [Evolving Agent Intelligence](evolving-agent-intelligence.md)
- [Execution Runtime Model](execution-runtime-model.md)
- [Features](features.md)
- [Integration Setup, Skill Proposals, and Bootstrap Lifecycle](integration-skill-bootstrap-lifecycle.md)
- [Structured Memory Observations](memory-observations.md)
- [Supermemory Integration](supermemory.md)
