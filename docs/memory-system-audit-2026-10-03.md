# Memory System Audit — 2026-10-03

**Scope.** This audit covers everything in CoWork OS that remembers, recalls, curates or learns:

- **Stored memory:** archive memory, curated/hot memory, the workspace kit, and the user profile/relationship/awareness/style data.
- **Session history:** transcripts, checkpoints and durable context.
- **Other sources:** Chronicle, the knowledge graph (KG), Supermemory, Box Brain and the ChatGPT importer.
- **Background loops:** Heartbeat, Workflow Intelligence (WI, internally "Subconscious"), Dreaming, core-memory distillation and learning, Awareness/AutonomyEngine, and the briefing.
- **Surfaces:** agent tools, IPC, settings and the Memory Hub UI.

**Method.** Six parallel, read-only code audits were run against `main` @ `069740faf`. The six areas were:

1. Archive core
2. Prompt assembly and profile lanes
3. Background loops
4. Recall and evidence lanes
5. Tools/IPC/settings/UI
6. Wiring/lifecycle/data model

The audit also ran read-only aggregate queries against the live desktop database (`~/Library/Application Support/cowork-os/cowork-os.db`). These returned counts and generator templates only — no memory content. High-severity claims were re-verified by hand.

**Legend.**

- ✔ re-verified against code or live data
- C traced by an auditor
- P plausible, not exercised

File references are relative to `src/electron/` unless prefixed.

### Status (2026-10-03, Phase 3)

The findings below describe `main` @ `069740faf`, before any fixes.

| Status | Findings |
|---|---|
| Fixed in Phase 0 (merged, `28e423ff1`, PR #291) | SEC-1..12 |
| Fixed in Phase 1 (merged, `ad1db1d94`, PR #292) | DATA-1, 2, 3, 9, 11, 12; LOOP-1..11; PROMPT-1..4, 6, 8, 9; RECALL-1, 3; LIFE-1..4; SEC-14, 15; §6 dead-code and dead-settings cleanup; §7 doc drift in the memory docs |
| Phase 2 complete (branch `cowork-os/memory-phase2`) | **Roadmap item 1:** `memory_items` store + `MemoryWriter` (salience gate, redaction, dedupe, trust-ranked supersession), one-time lane migration, dual writes from the legacy stores, purge and retention. **Item 2:** `MemoryInjectionPolicy` + `MemoryContextBuilder` for every prompt surface (L0 pinned profile, L1 recall per step, one budget, dedupe by subject and content hash, `memory_used` attribution); `MemoryRecall` (one Unicode FTS builder, weighted RRF across memory, archive, conversations, knowledge and external lanes). **Item 3:** one conversation index. **Item 4:** four agent tools (`memory_recall`, `memory_remember`, `memory_forget`, `context_recall`) with the 16 earlier tools as hidden aliases for one release, and a generated routing hint naming only visible tools. **§8.4 Memory Hub:** "What CoWork knows" tab over `memory_items` (list, why, add, edit, pin, delete, clear global), layer preview built with the policy and builder, and kit auto-blocks rendered from `memory_items` with back-sync of hand edits at curated trust boundaries (PROMPT-12). **Item 5:** scheduler consolidation (one suggestion sink). **Item 6:** `[PLAYBOOK]`/`[SUGGESTION]` payload tables. Also PROMPT-5, 7, 10, 11; RECALL-2, 7; a response style set in Settings is recorded as `user_stated` and locks style adaptation. Design: [memory-engine.md](memory-engine.md) |
| Phase 3 (branch `cowork-os/memory-phase3`) | Dreaming as the curator of `memory_items`, with the Memory Hub Review tab and undo; `MemoryWriter` parity in the node daemon; per-reply "Memory used" (desktop and browser host); memory evals in the harness battery and a read-only health check; Supermemory remote ids, forget and purge on disable (SEC-17); SEC-13 (1, 2) and SEC-16, with a settings UI for the owner's channel accounts; a dedicated `memory_delete` approval for `memory_forget`; lexical recall quality (stopwords, KG observations, coverage-aware fusion); retention of settled memory-write approvals and a one-time markdown index purge; memory flush at desktop shutdown. Details below |
| Decided | **Real local embeddings (DATA-6): skipped by decision (2026-10-03).** Recall stays lexical FTS plus reciprocal-rank fusion; the memory evals gate recall quality |
| Phase 3 (remaining) | Retire the legacy stores and their dual writes (and the 16 hidden tool aliases) after one release on `memory_items`; route the mailbox prompt through the policy and builder; the remaining producers not yet routed through `MemoryWriter` ([memory-engine.md](memory-engine.md) §8); SEC-17 copies made before remote ids were kept cannot be addressed |
| Other open findings | SEC-18; LIFE-5 (partial); RECALL-4..6, 8, 9; DATA-4..8, 10, 13; LOOP-12..15; the Memory Hub Review/Sources/Health tabs of §8.4 |

Phase 0 deviations from the §9 plan:

- **SEC-1:** checkpoints stay in the workspace rather than moving to `userData`. Phase 0 stopped restoring permission state from checkpoint files, ignored far-future checkpoints and protected `.cowork/memory/transcripts` from agent file writes. Phase 1 added HMAC signing with a key held in encrypted settings; unsigned or legacy `sha256` checkpoints are rejected.
- **SEC-2:** mailbox-sourced relationship items are kept out of profile prompts (and injected text is escaped) rather than routed to a contact-scoped `third_party` lane.
- **SEC-10:** spoofed `[Imported from` prefixes are neutralized and private imports stay in their workspace; there is no `is_imported` column.
- **SEC-13** (background writers bypassing access profiles) was not addressed in Phase 0 or Phase 1.

Phase 3 progress (branch `cowork-os/memory-phase3`):

- **SEC-13 (1) and (2) fixed.**
  - Workflow Intelligence writes no `.cowork/subconscious/**` while it is disabled. Enabling it starts a refresh.
  - Artifacts go only to the owning workspace's own `.cowork/subconscious`, never to an enclosing git root.
  - Every artifact write passes the confined internal-write check and the workspace access profile (`security/background-write-guard.ts`).
  - CrossSignal, Feedback and Lore pass a `pathGuard` to `writeKitFileWithSnapshot`.
  - (3) was already resolved in Phase 1: `CoreMemoryDistiller.refreshIndex` no longer runs.
- **Daemon parity.** The node daemon starts the memory engine (`MemoryWriter`, read side, lane migration), retention, the knowledge graph and Lore. It flushes memory writes at shutdown. A desktop app and a daemon on one profile claim one-time migrations atomically (`maintenance-claim-sql.ts`).
- **SEC-16 fixed.** Channel tasks record whether the sender is the workspace owner (self-chat, or `ownerUserIds` in the channel config). Other senders no longer feed awareness beliefs, the adaptive style, `user_stated` facts or the curated profile; `memory_remember` stores what they say as a private contact-scope `third_party` item.
- **SEC-17 fixed** for copies written from now on: remote ids are kept (`supermemory_remote_refs`); deletes, suppression, privacy changes, task delete, Clear All Memories and `memory_forget` forget the remote copy; "Disconnect & purge" deletes every recorded copy before disabling; mirror writes use the workspace name for `{workspaceName}` containers; 4xx answers no longer trip the circuit breaker. (4) was addressed in Phase 2 (own sanitized `external_memory` tag); (2) is limited only by the Phase 1 capture salience gate (`mirrorMemoryWrites` still defaults to on). Copies made before remote ids were kept cannot be addressed.
- **Per-reply "Memory used"** on chat replies, from the hidden `memory_used` events (now emitted per turn). **`memory_forget` asks before deleting** (except facts the task's own agent inferred). A stale Personality settings copy no longer records its response style as the user's choice.
- **§8.5 quality gates.**
  - Memory evals: `npm run qa:memory-evals`, also in `qa:harness`.
  - Read-only health check: `npm run qa:memory-health`.
  - Both are described in [harness-eval-battery.md](harness-eval-battery.md).
- **`memory_forget` approval.** A dedicated `memory_delete` approval type, classified as a
  delete by the permission engine (prompted in default and dangerous-only modes, denied when
  the workspace delete capability is off). The dialog reads "Forget a memory" and shows the
  memory, its source and the reason; channel approval messages leave the memory text out.
- **SEC-16 owner accounts.** Each channel's settings has "Your Account on This Channel": the
  `ownerUserIds` list, typed or set with "This is me" next to an allowed user, validated in
  main ([channels.md](channels.md#your-account-on-a-channel-memory)). Pairing and allowlists are
  not taken as owner evidence: they admit anyone the owner lets in. Voice-note updates of
  `PRIORITIES.md` now also require the owner as sender.
- **SEC-13 leftovers.** Every `writeKitFileWithSnapshot` caller passes a path guard: kit seeding
  and onboarding from Settings use the workspace's effective access profile
  (`security/effective-workspace.ts`), and the gateway's voice-note `PRIORITIES.md` update uses
  the background guard.
- **Recall quality (RECALL-9 follow-up).** Any-term FTS queries drop a small multilingual
  stopword list (en/tr/de/fr/es); knowledge-graph search also matches observations; fusion
  scales each hit by its coverage of the query's distinctive terms. Golden set (27 queries,
  one added for KG observations): recall@5 0.923 → 1.0, recall@1 0.769 → 0.889, MRR 0.848 →
  0.944 (gates 0.90 and 0.75).
- **Lifecycle.** Retention drops `pending_memory_writes` rows that are applied, rejected or
  failed and older than 30 days (the live profile held 10,006 rejected rows). A one-time,
  marker-recorded purge removes excluded markdown index rows (with their FTS rows) in every
  workspace, not only in workspaces whose index syncs. The desktop app stops retention and the
  engine and flushes `MemoryWriter` before the database closes, as the daemon does.
- **"Memory used" in the browser host** (`getMemoryUsedForTask`), and "Open in Memory Hub"
  switches the Hub to the task's workspace.

---

## 1. Executive summary

1. **This is not one memory system; it is about ten that grew side by side.** It has:
   - ~45 modules across 12 directories
   - ~11 stores of "facts about the user"
   - 14 recall implementations and 13 prompt-injection sites
   - 25 memory/KG/Supermemory tool schemas
   - 4 distillation pipelines and 10+ independent timers
   - the same conversation stored up to 5 times
2. **The memory that matters is empty; the memory that is full is noise.**
   - Curated hot memory, the only lane designed for default injection, has **0 rows**.
   - The archive is **66% raw tool/step telemetry** ("Tool called: …", "Tool result for run_command: undefined").
   - Another **19% is the same distiller lines repeated** (each repeated ~59×).
   - One task wrote 883 memories.
3. **A hidden 7-day expiry deletes nearly everything else.**
   - An hourly "tier" pass hard-deletes short-tier memories that are older than 7 days and have fewer than 2 search references.
   - It ignores the user's "retention days" setting.
   - Observed live: the table went from 5,014 to 4,906 rows *during this audit*. Only 73 rows older than 7 days remain.
4. **10,006 memory writes were silently lost (2026-06-12 → 2026-09-19).** They were staged in a review queue with no working approval surface, then bulk-rejected by the no-prompt migration.
5. **The curation loops either never run or run in circles.**
   - **Dreaming:** 0 runs ever, because its triggers have no emitters.
   - **Improvement loop:** dead code.
   - **Core distiller:**
     - It re-writes the same accepted candidates at every boot and every 6 h; one open loop has been accepted 475×.
     - It auto-accepts *"Operator should respect dispatch timing constraints"* on every cooldown pulse.
     - It logged 4,381 eval-case rows with 2 distinct texts.
6. **Duplicate transcripts dominate storage.**
   - 3.2 GB of the 5.0 GB database is `transcript_spans`. Each tool result is stored 3× per row plus FTS, a full conversation snapshot is appended every step, and there is no retention.
   - The same spans are also kept as JSONL on disk: 696 MB in this repo's `.cowork/` alone.
   - Durable context adds another 634 MB.
7. **Security and privacy defects need a hotfix first.**
   - A hand-written checkpoint file can restore `bypass_permissions` and session allow-rules on resume.
   - Email subjects and summaries, which the sender controls, are injected as the *user profile* into every prompt.
   - The profile block reaches group chats and sub-agents ungated.
   - Group chats can call `search_memories` and `search_quotes`.
   - Inspector "Delete" hides nothing from agent tools, and "Rebuild" un-deletes.
   - Secrets are only flagged: they are stored verbatim and re-injected.
   - Chronicle "Clear" deletes whatever file path is written into an observation JSON.
8. **What does reach the prompt is mis-budgeted.**
   - The synthesizer is asked for 1,820 tokens, but the section is capped at 1,200. Up to 7,000 chars of design-system context is prepended into that same cap.
   - The kit slice is used up by the root `AGENTS.md`/`CLAUDE.md`/docs before `.cowork/USER.md`/`MEMORY.md`.
   - Follow-ups, chat and planning get no hot memory, and plan steps get no memory tools.
   - Meanwhile one preference can appear 4–6× in a single step.
9. **Heartbeat has real concurrency bugs.**
   - Each manual pulse leaks a timer.
   - The running guard sits behind 5 awaits since the async-SQLite migration.
   - Runbook dispatches silently consume every pending signal.
   - 5 dispatch runs have been stuck "running" since Sept 18–19.
10. **The docs describe a cleaner system than the code.** None of these documented behaviours is true today:
    - a Dreaming review UI
    - "archive off by default"
    - "not every tool call is captured"
    - "KG auto-injected"
    - "Heartbeat owns when to think"
    - message ingestion into the user profile

**Recommendation.** Freeze new memory features, then work in phases (details in §8–§9):

1. **Phase 0:** a security/privacy hotfix.
2. **Phase 1:** two weeks of "stop the bleeding".
3. **Phase 2:** consolidate into **one memory engine**, with one store of record, one write pipeline, one recall service, one injection policy and one scheduler.

---

## 2. What's what — the current map

Status key: 🟢 live · 🟡 live but off by default or rarely triggers · 🔴 broken · ⚫ dead or write-only

### 2.1 Capture (writes)

| Component | What it does | Status |
|---|---|---|
| `AgentDaemon.captureToMemory` (`agent/daemon.ts:10235→10526-10710`) | Writes an archive row for ~17 task-event types (user/assistant messages, tool calls, tool results, steps, corrections) | 🟢 — this is the firehose |
| Executor compaction flushes (`agent/executor.ts:6207, 6370`) | Pre-compaction flush plus a compaction summary, as two archive rows | 🟢 |
| `memory_save` / `memory_curate` tools | Explicit archive / curated writes | 🟢 |
| `PlaybookService` | `[PLAYBOOK]` outcome rows plus `playbook_success_*` evidence | 🟢 |
| `ProactiveSuggestionsService` | `[SUGGESTION]{json}` rows stored inside `memories` | 🟢 |
| `CoreMemoryCandidateService` / `CoreMemoryDistiller` | Heuristic candidates from Heartbeat/WI traces → memories | 🟢 but duplicating |
| `ChronicleMemoryService` | `screen_context` memories from promoted frames | 🟡 (Chronicle is opt-in) |
| `ChatGPTImporter`, `MemoryService.importFromText` | Imports; both bypass the gate and the observation sidecar | 🟡 manual |
| `BoxBrainService` | Box folder → memories | 🔴 always fails (unbound `this`) |
| `MemoryWriteGate` | Review queue | ⚫ staging only works when the `COWORK_MEMORY_WRITE_APPROVAL_MODE` env var is set |
| Awareness belief regexes → `UserProfileService` | "I prefer / I need to / I am" → durable profile facts | 🟢 |
| `RelationshipMemoryService` | Continuity layers, fed from task completion and mailbox | 🟢 (the mailbox path is unsafe, SEC-2) |
| `UserProfileService` / `RelationshipMemoryService` `ingest*` (from user messages) | "remember that", "remind me", operating-manual facts | ⚫ no callers since `bc3ad5fbe` (2026-03-20) |
| `DailyLogService` | Raw daily journal | ⚫ no writers |
| `CrossSignalService` / `FeedbackService` / `LoreService` | Write `CROSS_SIGNALS.md`, `MISTAKES.md`, `LORE.md` | 🟢 |

### 2.2 Stores

| Store | Holds | Status |
|---|---|---|
| `memories` + `memory_embeddings` + `memory_observation_metadata` + 2 FTS tables | Archive, but also suggestions, playbooks, core memories, Chronicle and Box items | 🟢 overloaded |
| `curated_memory_entries` + auto-blocks in `.cowork/USER.md` / `.cowork/MEMORY.md` | Hot memory (L0) | 🟡 empty in practice |
| SecureSettings blobs: `user-profile`, `relationship-memory`, `adaptive-style`, awareness beliefs, autonomy | Global (not workspace-scoped) user facts | 🟢 |
| `PersonalityManager` config | Name, style, rules, "soul" | 🟢 |
| Workspace kit `.cowork/*.md` (+ `.cowork/.history/` revision snapshots) | Human-written plus generated context | 🟢 (snapshots never pruned) |
| `task_events` | **System of record** (pruned at 90 d) | 🟢 |
| `transcript_spans` + FTS + `.cowork/memory/transcripts/spans/*.jsonl` | A second copy of the event stream | 🟢 (3.2 GB) |
| `.cowork/memory/transcripts/checkpoints/*.json` (+ `.previous`) | Resume state | 🟢 (SEC-1) |
| `durable_context_*` | Task-scoped messages plus a summary DAG | 🟡 |
| `kg_*` | Entities, edges, observations | 🟢 (regex-populated, noisy; no UI) |
| `.cowork/chronicle/{observations,assets}` | Promoted screen observations plus PNGs | 🟡 |
| `.cowork/memory/MEMORY.md` + `.cowork/memory/topics/*.md` | Layered index / topic packs | 🟡 (off by default) |
| `.cowork/memory/<local-date>.md`, `daily/`, `summaries/` | **Three** daily-log paths | 🟡 / ⚫ |
| `core_*` (traces, events, candidates, distill runs, failures, learnings) | Harness learning | 🟢 (unbounded) |
| `dreaming_runs` / `dreaming_candidates` | Curation proposals | ⚫ never written in practice, never read |
| `subconscious_*` + `.cowork/subconscious/**` | WI runs and artifacts | 🟢 (unbounded) |
| `heartbeat_runs` / `heartbeat_run_events`, `heartbeat-signals-v3.json` | Heartbeat state | 🟢 (unbounded) |
| `pending_memory_writes` | Review queue | ⚫ (10,006 rejected rows) |
| `memory_summaries`, `improvement_*`, `heartbeat_policies` | — | ⚫ |
| Supermemory (remote) | External mirror and profile | 🟡 |

### 2.3 Background loops

| Loop | Cadence | Status |
|---|---|---|
| Heartbeat pulse: Project Manager "dispatcher" every 20 min, Assistant "observer" every 30 min (`main.ts:488-509`) | ~120 pulses/day | 🟢 **on by default** |
| ↳ WI reflection / Dreaming / core hot-path learning | Inside each pulse | 🟢 / ⚫ / 🟢 |
| Core offline distill (`main.ts:3271-3295`) | At boot, then every 6 h; the timer is never cleared | 🟢 duplicating |
| `MemoryService` tier pass + cleanup (`memory/MemoryService.ts:245`, `memory/memory-units.ts:46-60`) | Hourly — this is the 7-day expiry | 🟢 deleting |
| `AwarenessService` | Every 20 s: `osascript` polls of the frontmost app, clipboard and notifications | 🟢 |
| `AutonomyEngine` | Every 90 s plus once per awareness event; can create tasks without approval | 🟢 |
| Chronicle capture | Every 10 s when enabled | 🟡 |
| Box Brain poll | Every 60 s | 🔴 |
| `AmbientMonitoringService`, `StrategicPlannerService` (adjacent) | Every 5–10 min / every 60 s | 🟢 |
| Daily briefing | 08:00 cron | 🟡 off by default |
| CrossSignal / Feedback / Lore | 12 s debounce; CrossSignal and Feedback have no `stop()` | 🟢 |
| `ImprovementLoopService`, `MemoryNudgeService` | — | ⚫ never constructed |

### 2.4 How a "fact about the user" flows today

```text
user message ─┬─▶ daemon event capture ──▶ memories (raw event, expires in 7 days)
              ├─▶ awareness regex ─────────▶ beliefs ─▶ UserProfile facts ─┐
              ├─▶ adaptive-style regex ────▶ PersonalityManager style      │
              └─▶ (UPS/RMS ingest — dead since 2026-03-20)                 │
email ──────────▶ mailbox hub ─▶ RelationshipMemory (global) ──────────────┤
heartbeat pulse ▶ core candidate (auto-accept) ─▶ memories (×N duplicates) │
memory_curate ──▶ curated_memory_entries (empty) ─▶ USER.md auto-block     │
                                                                           ▼
prompt build ◀── 13 injection sites, each with its own gating and budget ◀─┘
```

---

## 3. Reality check — the live database

All figures are aggregate counts from this machine's desktop profile. No memory content was read.

| Signal | Value | What it means |
|---|---|---|
| Database size | **5.0 GB** | — |
| `transcript_spans` / its FTS | **2,702 MB / 541 MB** | Each tool result is stored 3× per row (`payload_json`, `raw_line`, `search_text`) plus FTS. Average tool result is 40 KB; the largest row is 6 MB. |
| `conversation_snapshot` spans | 2,271 rows, 57 KB average | A full conversation history is re-appended on every step |
| `.cowork/memory/transcripts` (this repo) | **696 MB** on disk | The same spans again, as JSONL |
| `durable_context_*` | 444 MB + 190 MB FTS | A third copy of the conversation |
| `memories` | 5,014 → **4,906 during the audit** | The hourly 7-day expiry deleting rows live |
| Memories older than 7 days | **73** (40 medium/long, 31 referenced, 2 about to go) | Everything else has been evicted |
| Memory mix by generator | 66% raw tool/step events · 19% `[core-trace:…]` copies · 5% `[SUGGESTION]` · 0.4% playbook · 9% other | The archive is telemetry, not memory |
| Memories per task (Oct 1–3) | Average 139, maximum **883** | Docs say capture is "selective" |
| `curated_memory_entries` | **0** | L0 hot memory is empty |
| `pending_memory_writes` | **10,006, all `rejected`** (8,599 auto-capture, 1,356 distill, 51 background) | Three months of memory dropped |
| `dreaming_runs` / `dreaming_candidates` | **0 / 0** | Dreaming has never run |
| `improvement_runs` / `improvement_candidates` | 0 / 0 | Dead loop |
| `core_memory_candidates` | 9,670 rows: 9,091 proposed (never reviewed), 579 accepted | No review UI exists |
| — `open_loop` accepted | 475 rows, **1 distinct summary** | No dedupe |
| — offline distill runs | 1,770 runs → **204,402 candidates** generated | Re-scanning the same traces |
| `core_learnings_log` | `eval_case` 4,381 rows / **2 distinct**; `failure_cluster` 5,088 / 528 distinct | Healthy idle pulses are logged as failures |
| `heartbeat_runs` | 8,991 pulses, 137 dispatches, **5 dispatches stuck `running` since 2026-09-18/19** | — |
| `memory_markdown_files` | 3,942 files: **64% `.cowork/.history/`** snapshots, **30% `.cowork/subconscious/`** artifacts, 1% `.cowork/memory/` | Memory search mostly hits stale revisions and run artifacts |
| `memory_embeddings` orphans | 437 (8%) | Rows deleted without cascading to their embeddings |
| `memory_summaries` | 0 | Never written |
| `box_brain_items` | 0 | Sync always fails (DATA-11) |

The SQL used is in Appendix A so this health check can be re-run.

---

## 4. Duplication and overlap

| Concern | Count | Where | Keep |
|---|---|---|---|
| Copies of the conversation | **5** | `task_events` · `transcript_spans` + FTS · JSONL · checkpoints · `durable_context_*` (plus per-event archive rows) | `task_events` as truth, plus **one** search index |
| Stores of user facts and preferences | **~11** | curated entries · `USER.md` · `MEMORY.md` · UserProfile · Relationship · Awareness beliefs · PersonalityManager · AdaptiveStyle · `MISTAKES.md` · archive · Supermemory | One fact store keyed by subject (§8) |
| Places that hold "response style" | 6 | PersonalityManager · AdaptiveStyle · UserProfile style facts · Awareness beliefs · `MISTAKES.md` · channel persona | One `response_style` fact |
| Commitment stores / injections | 3 / 3 | Relationship commitments · curated `active_commitment` · mailbox commitments → hot memory · pinned block · awareness "Due soon" | One |
| Distillation pipelines | 4 | Dreaming · CoreMemoryDistiller · MemoryConsolidator · WI "dreams" | Dreaming |
| Learn-from-correction pipelines | 8 | daemon correction regex (2–3 rows each) · awareness regex · AdaptiveStyle · FeedbackService · suggestion feedback · Dreaming · core "correction" · EverydayAgent trust | One correction signal → fact store |
| Schedulers | 10+ | Heartbeat · AutonomyEngine · Awareness · core distill · tier pass · Chronicle · Box Brain · Ambient · StrategicPlanner · briefing cron · debouncers | Heartbeat as the only scheduler |
| Suggestion producers | 5 | Heartbeat dispatch · WI · ProactiveSuggestions · Chief-of-staff (AutonomyEngine) · Briefing; deduplicated by title only | One sink, deduplicated by entity |
| Task creators with separate budgets | 4 | Heartbeat · AutonomyEngine · WI · StrategicPlanner | One budget |
| Recall implementations | 14 | Memory host + worker, prompt-recall fast path, markdown index, transcript FTS + JSONL scan, checkpoints, QuoteRecall, durable context, KG, Chronicle ×2, unified recall, synthesizer lanes, QueryOrchestrator, Supermemory | One recall service |
| Hybrid search stacks | 2 | Host `MemoryStore` + `rankHybrid` (2 unbounded caches) vs FTS worker; they have drifted | Worker |
| Sensitive-data detectors | 3, which disagree | `MemoryService.ts:47-66` · `ChatGPTImporter.ts:112-122` · `MemoryWriteGate.ts:575-596` | One |
| Archive → prompt formatters | 4 | `executor.buildHybridMemoryRecallBlock` · `MemorySynthesizer` · `getContextForInjection` · topic packs | One |
| "What happened before?" tools | 8 | `search_memories` · `search_sessions` · `search_quotes` · `task_history` · `memory_search_index` · `context_grep` · `supermemory_search` · `kg_search` | 1–2 |
| "Remember this" tools | 7 | `memory_save` · `memory_curate` · `supermemory_remember` · `kg_*` · `update_lore` · `set_user_name` / `add_behavioral_rule` · `scratchpad_write` | 1 |
| Daily-log paths | 3 | `.cowork/memory/<local-date>.md` · `daily/` (UTC) · `summaries/` (UTC) | 0–1 |
| Files named `MEMORY.md` | 3 | Kit · layered index · role kit — all indexed, so mixed in recall | Rename |
| Import paths | 3 | ChatGPT · `importFromText` · Box Brain — each with different gates | One gated import API |
| Heartbeat config stores | 3 | `automation_profiles` · `agent_roles` columns · `heartbeat_policies` (no consumer) | `automation_profiles` |

**One open loop, six surfaces.** A single mailbox commitment currently becomes six separate items, none of which merge:

- an AutonomyEngine "Follow up on: X" decision
- a "Review due soon: X" suggestion
- a chief-of-staff suggestion
- a briefing item
- a Dreaming `open_loop` candidate
- a core `open_loop` candidate

---

## 5. Findings

### 5.1 Security and privacy — fix first (Phase 0)

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| SEC-1 ✔ | **High** | **Checkpoint files can restore permission state.** The trigger is any follow-up that rebuilds the executor; resume prefers a "fresher" checkpoint. It then copies `permissions.mode`, `sessionRules`, `temporaryGrants` and `recentSensitiveSources` verbatim, and the daemon uses that mode for permission decisions. Three things make this exploitable: (1) the checkpoint lives in an unprotected workspace path, (2) `parseCheckpoint` accepts files with **no** integrity block, and (3) when the block is present its sha256 is unkeyed. A prompt-injected agent can write `<taskId>.json` with `bypass_permissions` and a far-future `sourceTimestamp`. `.cowork/policy/**` is protected precisely to stop this kind of self-escalation. | `memory/TranscriptStore.ts:337-361`; `agent/runtime/SessionRuntime.ts:3895-3925, 4760-4769`; `agent/daemon.ts:6930-6931, 6968`; `security/access-profile-paths.ts:388`; `agent/executor.ts:7090` |
| SEC-2 ✔ | **High** | **Email-sender text becomes "user profile" in every prompt.** Mailbox events write `Thread subject:`, `Summary:`, contact names and commitment titles into global relationship memory. That memory feeds `UserProfileService.buildPromptContext`, which becomes the pinned `<cowork_user_profile>` block on every LLM iteration, unsanitized. Anyone who emails the user can place text into every task's prompt under a "user profile" label. | `mailbox/MailboxAutomationHub.ts:158-177, 208`; `mailbox/MailboxService.ts:7504`; `memory/UserProfileService.ts:235-237`; `agent/runtime/SessionRuntime.ts:2134` |
| SEC-3 ✔ | **High** | **The pinned profile/relationship block ignores memory gating.** It is injected on every iteration without checking `allowMemoryInjection` or `retainMemory`. Shared context and recall *are* gated. Group/public channel replies, sub-agents, council and verification workers all receive profile facts, commitments, email subjects and task history. Relationship memory is also baked into the persisted `task.prompt` with no gateway check. | `agent/runtime/SessionRuntime.ts:2134-2143` (compare 2145, 2165); `agent/executor.ts:8648, 8871, 28236`; `agent/daemon.ts:1593` |
| SEC-4 ✔ | **High** | **Group and public chats can search private memory.** The `group:memory` block list omits `search_memories`, `search_quotes`, `context_*` and `kg_*`. A Slack or Discord group can therefore search imported ChatGPT history across workspaces and verbatim task messages. `search_quotes` also never checks that a passed `taskId` belongs to the workspace. | `src/shared/types.ts:1859-1884`; `memory/QuoteRecallService.ts:312-318` |
| SEC-5 ✔ | **High** | **Inspector "Delete" hides nothing from the agent, and "Rebuild" un-deletes.** Soft-delete leaves `memories.content` intact. Every agent path still returns it: `search_memories` and `searchAsync` have no suppressed filter; `memory_search_index` accepts `privacyStates:["suppressed"]` from the model; `memory_details` returns raw content; `memory_timeline` has no filter. Separately, "Rebuild Metadata" (`force:true`) recomputes `privacy_state` from `is_private`, so suppressed and redacted rows become "private". Recent recall includes private rows, so they come back into prompts. | `memory/memory-observation-sql.ts:485-505, 210`; `agent/tools/system-tools.ts:1612, 1709, 1797-1813`; `memory/MemoryService.ts:1032`; `src/renderer/components/MemoryHubSettings.tsx:530, 588` |
| SEC-6 ✔ | **High** | **Secrets are stored verbatim and re-injected.** Sensitive-pattern matches only set `is_private`; the content (including tool results up to 1,500 chars) is stored as-is, which violates the project's no-plaintext-secrets rule. Private rows are then injected through per-turn "recent" recall (`includePrivate=true`). Separately, the patterns are over-broad (`/auth/i`, `/token/i`, `/\.env/i`): content mentioning OAuth or tokens is silently hidden from recall, and playbook reinforcement breaks for those tasks. | `memory/MemoryService.ts:47-66, 375-381, 1032`; `agent/daemon.ts:10583`; `agent/executor.ts:5296`; `memory/PlaybookEvidenceStore.ts:237-240` |
| SEC-7 ✔ | Med-High | **Chronicle Delete/Clear can delete arbitrary files.** `deleteObservation` and `clearWorkspace` call `fs.rm(record.imagePath)`, and `imagePath` is read from JSON the agent can write in `.cowork/chronicle/observations/`. A planted record makes "Clear Chronicle" delete any file. `observationId` from IPC is also joined straight into the path. `screen_context_resolve` is classed read-only, yet it writes into the workspace with raw `fs` and no access-profile check. | `chronicle/ChronicleObservationRepository.ts:117-155, 224-243`; `ipc/handlers.ts:11855` |
| SEC-8 | Med | **Chronicle privacy gaps.** (1) Memories are captured with `isPrivate=false`, so OCR text is mirrored to Supermemory, contrary to the docs. (2) While paused, `queryRecentContext` and the fallback screenshot still run, and the buffer is never pruned. (3) Up to 5 matches are promoted per call regardless of confidence. (4) The `<no-memory>` directive is ignored. (5) The durability check fails open. | `chronicle/ChronicleMemoryService.ts:53-64`; `chronicle/ChronicleCaptureService.ts:115-117, 199-236`; `agent/tools/registry.ts:2798-2840`; `chronicle/ChronicleObservationRepository.ts:87` |
| SEC-9 | Med | **KG tools act on raw IDs across workspaces.** Update/delete/edge/observation/neighbors/subgraph only check `WHERE id=?`. `create_edge` accepts foreign entities. Neighbors and subgraph results are unbounded. | `agent/tools/knowledge-graph-tools.ts:314-492`; `knowledge-graph/knowledge-graph-sql.ts:188-238, 692-704` |
| SEC-10 | Med | **An `[Imported from ` prefix makes content global.** Any memory whose text starts with this prefix is visible in every workspace. `memory_save` stores model text verbatim, so the prefix can be planted. Imported rows also ignore privacy and per-workspace "memory off". | `database/fts-utils.ts:29`; `database/repositories.ts:6923`; `agent/tools/memory-tools.ts:204` |
| SEC-11 | Med | **IPC validation gaps.** | `ipc/handlers.ts` (lines per item below) |
| | | • `MEMORY_SEARCH` / `GET_TIMELINE` / `GET_DETAILS` are unscoped. | 13552-13587 |
| | | • `MEMORY_SAVE_SETTINGS.excludedPatterns` is compiled as a `RegExp` in main (ReDoS risk). | 13366; `MemoryService.ts:2864` |
| | | • `KIT_OPEN_FILE` only checks for a `.cowork/` prefix, so it can create files under protected `.cowork/policy/`. | 13261-13302 |
| | | • The renderer can set the user-fact `source`. | 13838-13859 |
| | | • `RELATIONSHIP_UPDATE` status and confidence are unchecked. | 13894 |
| | | • `KIT_SUBMIT_MESSAGE_FEEDBACK` accepts any `taskId`. | 13309 |
| | | • `CHRONICLE_*` has no schema. | 11801-11896 |
| | | • Write approve/reject accept a missing `workspaceId`. | 13466-13490 |
| SEC-12 | Med | **Memory writes are not treated as writes.** `memory_save`, `supermemory_remember`/`forget` and `kg_*` writes are allowed in plan/analyze modes and for the verifier role. `<no-memory>` stops only automatic capture. | `agent/tool-policy-engine.ts:551-627`; `agent/runtime/PermissionEngine.ts:1255-1295`; `agent/daemon.ts:10588` |
| SEC-13 | Med | **Background writers bypass access profiles.** (1) WI `start()` refreshes targets even when disabled. It writes `.cowork/subconscious/**` into every workspace, and into the **git repo root** when the workspace sits inside a larger repo. (2) CrossSignal, Feedback and Lore omit `pathGuard`. (3) `CoreMemoryDistiller.refreshIndex` runs without guards. | `subconscious/SubconsciousLoopService.ts:339-353, 1535-1537`; `subconscious/SubconsciousArtifactStore.ts:82-88`; `context/kit-revisions.ts:55`; `agents/CrossSignalService.ts:343`; `core/CoreMemoryDistiller.ts:139-143` |
| SEC-14 | Med | **The daily briefing can leak to a channel.** Memory highlights come from `searchAsync`, which includes private, suppressed and cross-workspace imported rows, and the briefing can be auto-delivered to a channel. | `briefing/DailyBriefingService.ts:124-133, 473-481` |
| SEC-15 | Med | **Deletion doesn't cascade.** Task delete leaves spans, JSONL, checkpoints, lock files, durable context, Chronicle files and memories, KG rows and Supermemory copies. "Clear All Memories" leaves curated memory (still injected), KG, transcripts, topic packs, Chronicle, Dreaming, core candidates and Supermemory. Deleted content stays searchable through `search_sessions`, `search_quotes` and `context_grep`. | `ipc/handlers.ts:5909-5931, 13740-13745`; `memory/MemoryService.ts:1684-1700`; `src/host/services/browser-memory-methods.ts:513` |
| SEC-16 | Med (P) | **Third parties can write the owner's profile.** Any gateway DM is classed "private", so another person's "call me / I prefer / my goal" becomes the owner's global UserProfile facts. | `gateway/router.ts:4456`; `awareness/AwarenessService.ts:583-588, 815` |
| SEC-17 | Low-Med | **Supermemory issues.** (1) No remote IDs are stored, so delete, suppress, clear and disable cannot forget remotely. (2) When enabled, every non-private event is mirrored, including tool I/O (`mirrorMemoryWrites` defaults to true). (3) Mirror writes use `name: workspaceId`, so a `{workspaceName}` template writes to a different container than reads use. (4) The profile block is unsanitized and reuses the `<cowork_user_profile>` tag. | `memory/MemoryService.ts:538-550`; `memory/SupermemoryService.ts:81, 667`; `agent/executor.ts:8658-8682` |
| SEC-18 | Design risk | **Autonomous task creation without approval.** AutonomyEngine runs `create_task` without approval by default. Heartbeat dispatch tasks run under the `founder_edge` preset, which auto-approves `run_command`. | `awareness/AutonomyEngine.ts:80, 735-740`; `agents/HeartbeatDispatchEngine.ts:115`; `agents/autonomy-policy.ts:113-127` |

### 5.2 Data loss and data quality

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| DATA-1 ✔ | **High** | **A hidden 7-day expiry overrides "retention days".** An hourly pass deletes `short`-tier rows older than 7 days with fewer than 2 references. Every insert defaults to `short`, and only explicit searches add references; prompt recall does not. The deleted rows include imports (a re-import then pays the LLM again), playbook memories (evidence is then invalidated as `source_memory_deleted`), preferences, corrections, suggestions and Box docs. The UI offers 7–365 days of retention. | `memory/memory-units.ts:46-60`; `memory/MemoryTierService.ts:38-41`; `memory/MemoryService.ts:596, 1261, 2683`; `memory/PlaybookEvidenceStore.ts:221-237`; `src/renderer/components/MemorySettings.tsx:1556-1573`; live: 5,014 → 4,906 |
| DATA-2 ✔ | **High** | **The archive is a raw event firehose.** One row is written per mapped task event: "Tool called: …", "Tool result for X: undefined", "Step completed", raw JSON step payloads. The skip list omits the memory-recall tools, so recalled memories get re-captured. A `memory_save` produces 4 rows, and a user correction produces 3. | `agent/daemon.ts:10526-10710, 10554-10569, 10633-10707`; `agent/tools/memory-tools.ts:158-214`; live: 66% telemetry, 883 memories in one task |
| DATA-3 ✔ | **High** | **The core distiller duplicates and spams meta-memories.** (1) Every cooldown pulse auto-accepts "Operator should respect dispatch timing constraints" and writes a `constraint` memory; the trace id in the content defeats dedupe. (2) `runOffline` re-captures the newest 200 accepted candidates at boot and every 6 h, with no "applied" status. (3) Every idle pulse adds an unreviewed `open_loop` candidate. (4) If Supermemory mirroring is on, each copy is mirrored too. | `core/CoreMemoryCandidateService.ts:84-93, 160-180`; `core/CoreMemoryDistiller.ts:113-133, 186-208`; `main.ts:3271-3295`; live: ×59 copies, 475 accepted copies of one open loop |
| DATA-4 ✔ | High (historical) | **Lost writes.** The 10,006 staged writes from Jun 12 → Sep 19 were bulk-rejected. Today the gate's staging only runs when an env var is set, and the Memory Hub "review mode" select does nothing. Tests exercise staging that production never uses. | `memory/MemoryWriteGate.ts:258-268`; `agent/approval-policy.ts:24`; live table |
| DATA-5 | Med | **Only the first line is used.** Summary, embedding and observation title/narrative/facts all come from the first line. Many generators use a constant first line (Chronicle provenance, compaction preamble, "Tool result for X:", `[core-trace:…]`), so their snippets and embeddings are identical. `memory_search_index` cannot find text in the body. | `memory/MemoryService.ts:449-465, 2103-2117`; `memory/memory-observation-sql.ts:191-203`; `chronicle/ChronicleProvenance.ts:16` |
| DATA-6 | Med | **Embedding and FTS quality.** Embeddings are a 256-dim hashed bag-of-words, ASCII-only, stored as ~5 KB of JSON per row. The worker strips `.` and non-ASCII per token: `executor.ts` → `executorts`, `şifre` → `ifre`. Non-ASCII queries skip FTS in the transcript and KG lanes. Cache invalidation never reaches the FTS worker thread (stale for up to 10 min). The host caches grow without bound. | `memory/local-embedding.ts`; `database/fts-utils.ts:3-5`; `memory/TranscriptStore.ts:413`; `database/repositories.ts:7706-7723`; `memory/MemoryService.ts:510, 933` |
| DATA-7 | Med | **Compression and the storage cap don't work.** The single-item LLM compression path can never run (it compares summary tokens). Batch "digests" add new rows that bypass the gate, the sidecar and the mirror. The storage cap counts only content+summary, not the ~5 KB embedding, sidecar or FTS, and it deletes the oldest rows first regardless of value. | `memory/MemoryService.ts:455, 2336-2338, 2584, 2723`; `database/repositories.ts:7262` |
| DATA-8 | Med | **FTS write churn.** Every search awaits a reference-count update, and `memories_fts_update` fires on any column change. Observation `INSERT OR REPLACE` without `recursive_triggers` leaves ghost FTS rows, which bloat the index and skew BM25. | `memory/MemoryService.ts:1261`; `database/schema.ts:2759-2764`; `memory/memory-capture-sql.ts:86` |
| DATA-9 ✔ | Med | **The markdown memory index is polluted and thrashes.** 94% of indexed files are `.cowork/.history/` snapshots and `.cowork/subconscious/` artifacts. Unified recall and the distiller index from the workspace *root* while the executor indexes `.cowork`. The index is keyed by workspace only, so each switch deletes rows and reindexes the whole repo. | `memory/MarkdownMemoryIndexService.ts:99-101, 179-229`; `agent/RuntimeVisibilityService.ts:282`; live table |
| DATA-10 | Med | **KG data quality.** The case-insensitive tech regex turns "go", "rest", "express" and "rust" into entities. Names are unique case-sensitively, so `Go`/`go`/`GO` are separate entities. Mailbox ingest creates "Gmail"/"Outlook" organisations with `works_at` edges, and appends observations with no dedupe. Auto upserts overwrite manual descriptions. Decay keys on `created_at`. | `knowledge-graph/KnowledgeGraphService.ts:171-174, 209-327, 411-413`; `knowledge-graph/knowledge-graph-sql.ts:581-597, 669`; `database/schema.ts:5416` |
| DATA-11 | Med | **Box Brain sync always fails.** It calls `MemoryService.capture`, `replaceMemory` and `deleteEntries` as unbound methods, so `this` is undefined and the run is marked failed. Tests inject deps, so they never hit this. | `memory/BoxBrainService.ts:925-933, 954-957`; `main.ts:2116` |
| DATA-12 | Med | **The daily summary is a transcript dump.** `MemoryConsolidator` overwrites today's summary with span counts and raw span JSON (or "none captured" boilerplate), and L1 injects it. A crash leaves `consolidation.lock` behind forever. | `memory/MemoryConsolidator.ts:64-74, 98-124`; `memory/DailyLogSummarizer.ts:69` |
| DATA-13 | Low | **Smaller defects.** 437 orphan embeddings. `profileId`/`coreTraceId`/`candidateId`/`scope*` capture options are never persisted. The `{duplicate}` flag is never read. `importFromText` dedupes only within a single paste. ChatGPT import dedupe is per workspace, and LLM failures are counted as processed. | `memory/MemoryService.ts:689-705, 1601-1614`; `memory/ChatGPTImporter.ts:201, 627-639` |

### 5.3 Background loops

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| LOOP-1 ✔ | **High** | **Heartbeat timer leak.** `finishPulse` removes the timer from the map without calling `clearTimeout`. A manual or triggered pulse (Mission Control, mailbox hand-off, event trigger) therefore leaves the old timer pending while the `finally` block schedules a new one. That creates two pulse chains forever, plus one more per further wake. | `agents/HeartbeatService.ts:487-511, 1060-1104`; `mailbox/MailboxService.ts:2862`; `main.ts:3587` |
| LOOP-2 ✔ | **High** | **Running guard after 5 awaits — a regression from the async-SQLite migration.** The guard is checked at 526 but only set at 596, so scheduled and manual pulses can run concurrently and dispatch twice. The manual-override replay also runs twice. Manual pulses bypass the cooldown and budget. | `agents/HeartbeatService.ts:520-600, 359, 1071-1081` |
| LOOP-3 | Med | **Runbook and cron hand-off dispatches only write an activity entry**, yet they still consume budget and cooldown, mark checklist items done, and **delete every pending signal**. The default `HEARTBEAT.md` daily and weekly items therefore never execute and swallow mailbox and urgent signals. | `agents/HeartbeatDispatchEngine.ts:149-197`; `agents/HeartbeatService.ts:936-951`; `agents/HeartbeatPulseEngine.ts:68`; `context/kit-operations.ts:348-364` |
| LOOP-4 | Med | **Observer suggestions are dropped.** The strong-signal branch returns `suggestion` without a `dispatchKind`, which is treated as idle, while the status still shows "suggestion". | `agents/HeartbeatPulseEngine.ts:157-170`; `agents/HeartbeatService.ts:780` |
| LOOP-5 | Med | **`mode:"now"` wakes never pulse.** They only add a signal. Urgent signals expire after 30 min, which equals the Assistant's cadence, so they can expire unseen. | `agents/HeartbeatService.ts:392-412`; `agents/HeartbeatSignalStore.ts:51` |
| LOOP-6 ✔ | Low-Med | **`getTasksForAgent` filters on the non-existent status `"running"`.** Queued, executing, blocked and paused assigned work is invisible to Heartbeat. | `main.ts:2983-2989`; `src/shared/types.ts:705` |
| LOOP-7 | Med | **The in-flight dispatch guard never trips.** The run is marked finished before the task executes. "Task creation requires evidence refs" is not enforced. Live: 5 dispatch runs are stuck `running`. | `agents/HeartbeatService.ts:922`; `docs/heartbeat-v3.md:124-129` |
| LOOP-8 | Med | **Signals never merge, and the signal file is rewritten constantly.** Fingerprints embed the window title or file path. Every wake rewrites `heartbeat-signals-v3.json` synchronously, once per agent. | `agents/HeartbeatService.ts:399-402`; `monitoring/AmbientMonitoringService.ts:307`; `agents/HeartbeatSignalStore.ts:101-111` |
| LOOP-9 ✔ | Med | **Dreaming never runs (0 runs).** `memory_drift` is only emitted for mailbox `draft_created`. `correction_learning` and `cross_workspace_patterns` have **no emitters**. The task-completion trigger is gated by `backgroundConsolidationEnabled=false`. A latent inverse bug: hot-memory "pressure" (one duplicate line, or 80% of the `USER/MEMORY/SOUL.md` budget) fires Dreaming on every pulse with no cooldown, and nothing Dreaming produces relieves the pressure. Candidates are boilerplate. `applyAcceptedCandidate` has no caller, and there is no UI. | `agents/HeartbeatService.ts:1193-1238`; `mailbox/MailboxAutomationHub.ts:110-116`; `memory/MemoryPressureService.ts:123-151`; `memory/DreamingService.ts:209, 382-442`; `agent/daemon.ts:9268` |
| LOOP-10 | Med | **Failure mining treats healthy pulses as failures.** Deferred pulses and WI `no_evidence` runs are counted as failures, and each produces a failure record plus 1–2 learnings rows. | `core/CoreFailureMiningService.ts:97-113`; `core/CoreLearningPipelineService.ts:17-42` |
| LOOP-11 | Med | **Pulse ordering waste.** Reflection and Dreaming run *before* the foreground-deferral check. Run and trace rows are created before the active-hours check. `relevantActivities` counts all-time activity, so reflection fires on almost every pulse once WI is on. Targets are refreshed twice per reflection, each time spawning 3 git processes per workspace. | `agents/HeartbeatService.ts:553-606, 678-735, 1174-1178`; `activity/ActivityRepository.ts:146-192`; `subconscious/SubconsciousLoopService.ts:489, 886` |
| LOOP-12 | Med | **Awareness turns passing phrases into durable facts.** "I need to / I want to" becomes a goal fact, which feeds AutonomyEngine and the briefing. Contradictory beliefs ("prefers concise" and "prefers detailed") both become profile facts. A lowercase "i am X" stores a junk name fact. | `awareness/AwarenessService.ts:663-815`; `memory/UserProfileService.ts:33-92` |
| LOOP-13 | Med | **AutonomyEngine creates tasks from recurring-workflow beliefs** and does a full encrypted SecureSettings save on every 90 s evaluation. | `awareness/AutonomyEngine.ts:318, 479-480, 630-645, 735-740` |
| LOOP-14 | Low-Med | **Lifecycle gaps.** The distill timer is never cleared. CrossSignal and Feedback have no `stop()`. Untracked async work (consolidation timer, executor learning, compression retries, markdown sync) can write after the DB closes. Quiet mode is ignored by distill, cleanup and the kit writers. | `main.ts:383, 3271-3295, 4410-4502`; `agent/daemon.ts:9675, 17338` |
| LOOP-15 | Low | **Smaller defects.** EverydayAgent "clear memory candidates" deletes nothing (filters on `profile_id='default'`), and its count is always 0. FeedbackService rebuild reads 30 of 90 days, so a restart erases patterns. LoreService records heartbeat and autonomy tasks as milestones. `WorkingStateRepository.cleanupOldStates` is never called. The WI review status is unvalidated. | `everyday-agent/EverydayAgentService.ts:1515-1524`; `agents/FeedbackService.ts:47-48, 357-366`; `agents/LoreService.ts:181-194`; `ipc/subconscious-handlers.ts:111-115` |

### 5.4 Prompt assembly

The prompt is built from 13 injection sites:

- the step `memory_context` section
- `awareness_snapshot`
- `personality`
- identity
- `role_context`
- `memory_index`/`memory_topics`
- three pinned per-iteration blocks: profile, shared context, recall
- planning guidance
- follow-up (Supermemory only)
- chat/companion
- relationship text baked into `task.prompt`

Each site has its own gating and budget.

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| PROMPT-1 ✔ | **High** | **Budget mismatch.** The synthesizer is asked for 700+700+420 = **1,820** tokens, but `memory_context` is capped at **1,200**. Up to 7,000 chars of design-system context plus the Supermemory profile are prepended into the same capped section. Truncation cuts mid-block and leaves tags unclosed. The documented "2,800 tokens / 35% kit" budget is not what runs. | `agent/executor.ts:538-548, 31759-31766, 31860-31866`; `agent/content/ContentBuilder.ts:294` |
| PROMPT-2 | **High** | **The kit slice starves `.cowork` files.** The synthesizer keeps ~546 tokens of kit. Root `AGENTS.md`/`CLAUDE.md` (up to 20K) and docs-map files (up to 6K each) come first, and `MEMORY.md` is 19th in kit order. In this repo `docs/architecture.md` alone fills the slice, so no `.cowork` file reaches a step prompt. | `memory/MemorySynthesizer.ts:612-622`; `memory/WorkspaceKitContext.ts:489, 518-521`; `context/kit-contracts.ts:317-338` |
| PROMPT-3 | **High** | **Hot memory is missing outside plan steps, and plan steps have no memory tools.** Follow-ups carry only Supermemory, chat carries only the profile block, and planning has none. Meanwhile the plan-step allowlist strips every memory tool. The `memory_curate` description promises "injected by default". | `agent/executor.ts:40729-40743, 18438-18452, 18865-18929`; `agent/tools/memory-tools.ts:60` |
| PROMPT-4 ✔ | Med | **Archive is injected every turn by default**, ignoring `defaultArchiveInjectionEnabled=false`. The "recent 4" are usually the current task's own just-captured tool events, so the agent sees an echo of itself. Private rows are included. | `agent/executor.ts:5285-5330`; `memory/MemoryService.ts:1032`; `database/fts-worker.ts:133-137` |
| PROMPT-5 | Med | **One fact appears 4–6 times per step.** The same name or preference can show up in hot memory, the pinned profile block, awareness beliefs, `USER.md` (onboarding plus curated blocks), `MEMORY.md`, and a recall `[note]`. The synthesizer's dedupe keys are prefixed by source, so cross-source duplicates are never removed. PRIORITIES, CROSS_SIGNALS and MISTAKES appear both in the kit and in the pinned shared-context block. | `memory/MemorySynthesizer.ts:160, 182, 198`; `agent/executor.ts:5238` |
| PROMPT-6 | Med | **Workspace curated entries are starved.** The top-10 sort puts the user lane first, so with 10 or more user entries no workspace rules reach hot memory. | `database/repositories.ts:7666` |
| PROMPT-7 | Med | **Name conflict.** `set_user_name` writes only to PersonalityManager. Any new profile name fact re-syncs from the pinned onboarding name (confidence 1.0), which reverts it, and then both names are injected. | `agent/tools/registry.ts:10045`; `memory/UserProfileService.ts:546-556`; `src/shared/onboarding.ts:365` |
| PROMPT-8 | Med | **👎 feedback teaches the style learners nothing.** The UI sends `too_verbose`, but `\bverbose\b` cannot match across the underscore, and Awareness has no rule for it. Only `MISTAKES.md` records it. | `src/renderer/components/MainContent/MainContent.tsx:3109`; `memory/AdaptiveStyleEngine.ts:201` |
| PROMPT-9 | Med | **The pre-compaction flush parser corrupts the kit daily log.** Both regex literals contain `\\s`, which matches a literal backslash, so sections bleed into each other and leading characters are eaten. | `agent/executor.ts:6461, 6472` |
| PROMPT-10 | Med | **The Supermemory block is uncached.** It is a network call of up to 10 s on every step, follow-up and chat turn, and it is unsanitized. | `agent/executor.ts:8657-8682` |
| PROMPT-11 | Low | **Smaller defects.** (1) The prompt-recall cache is never cleared on delete/redact/suppress. (2) The synthesizer ignores per-workspace `enabled`/`privacyMode`. (3) The KG is never injected despite `includeKnowledgeGraph:true`. (4) `DESIGN.md` can be injected twice. (5) The decorated `task.prompt` is used as the retrieval query. (6) The Memory Hub preview doesn't model the real pipeline. (7) Volatile pinned blocks break prompt caching (P). | `memory/MemoryService.ts:1109, 1792`; `memory/MemorySynthesizer.ts:599-651`; `agent/executor.ts:31811, 41071`; `ipc/handlers.ts:13427` |
| PROMPT-12 | Low | **Curated file sync problems.** Sync is one-way, so hand edits inside the auto-block are overwritten. Both files are rewritten on every change. The 320-char truncation is silent and not in the tool schema. The DB commit happens before a sync error is reported. Desktop and the node daemon run separate sync queues. `USER.md` mirrors personal entries into the repo with no `.gitignore`. | `memory/CuratedMemoryService.ts:19, 83-98, 284-336, 421-484, 566-586`; `main.ts:2101`; `src/daemon/main.ts:345` |

### 5.5 Recall and tools

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| RECALL-1 | **High** (functional) | **Recall tools are unreachable in common paths.** (1) Plan steps strip them. (2) `memory_search_index`/`timeline`/`details` and `kg_*` sit in a "system/conditional" lane that is shown only when the task text mentions clipboard, application or screenshot. (3) They aren't discoverable via `tool_search`, which indexes only deferred tools. (4) The "memory internals" deferral list is overridden by the always-expose list. | `agent/tool-policy-engine.ts:228, 364-406, 532`; `agent/tools/registry.ts:1975-1977`; `agent/tools/runtime-tool-definition.ts:142-149, 191-205` |
| RECALL-2 | Med | **Too many tools, inconsistent guidance.** There are 8 tools for "what happened before?" and 7 for "remember this". The only routing guidance (`MemorySynthesizer.ts:550-579`) is dropped in the default wake-up mode. `search_memories` tells the model to prefer a tool that is usually hidden. Desktop tool descriptions lose their "when to use" sentences. The 25 schemas cost ~4.3K tokens. | `agent/tools/system-tools.ts:2262-2290, 2720` |
| RECALL-3 | Med | **Recall tools return empty results on any error**, hiding a deliberate "memory search unavailable" error. | `agent/tools/system-tools.ts:1674, 1883, 1967, 2052, 2126, 2213` |
| RECALL-4 | Med | **Unified recall (Mission Control) isn't unified.** A whole-query substring post-filter throws away FTS and semantic hits. Scores from different lanes are incomparable. It skips transcripts, durable context, quotes and Supermemory. Browsing bumps reference counts and re-roots the markdown index. | `agent/RuntimeVisibilityService.ts:216-468` |
| RECALL-5 | Med | **QueryOrchestrator's `transcript_context` is noise.** It runs a 2,500-char prompt as an FTS query and injects JSON fragments into memory context without untrusted framing. | `agent/orchestration/QueryOrchestrator.ts:19-55`; `agent/content/ContentBuilder.ts:173` |
| RECALL-6 | Med | **SessionRecall is wrong.** It matches `.previous.json` (duplicate tasks), skips the integrity check, and reads every checkpoint per query. Its hits are injected into recovery prompts. | `memory/SessionRecallService.ts:89-133`; `agent/executor.ts:17830` |
| RECALL-7 | Low | **Smaller tool defects.** (1) The `memory_timeline` window isn't centred on the anchor and has no privacy filter. (2) The `search_memories` type filter runs after the limit. (3) `memory_curated_read` is uncapped. (4) `memory_topics_load refresh:false` still creates directories. (5) Topic packs are named by rank (`memory-1..N`), so each query overwrites them. | `memory/memory-observation-sql.ts:367-400`; `agent/tools/system-tools.ts:1601-1647`; `memory/LayeredMemoryIndexService.ts:155-176, 277` |
| RECALL-8 | Low | **Ranking scale bugs.** Raw `\|bm25\|` (for queries under 2 tokens) is mixed with [0,1] scores. Lexical-only candidates get a semantic score of 0. The RRF baseline lets cross-workspace imports tie local results. | `memory/memory-hybrid-rank.ts:97-140` |
| RECALL-9 | Low | **FTS dialect gaps.** Uppercase AND/OR/NOT/NEAR in durable context errors out and silently falls back to LIKE. KG and task `LIKE` queries don't escape `%`/`_`. There are 6 FTS dialects and 5 copies of `normalizeText`. | `memory/durable-context-sql.ts:503, 762`; `knowledge-graph/knowledge-graph-sql.ts:420-448` |

### 5.6 Storage and lifecycle

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| LIFE-1 ✔ | **High** | **Transcript write amplification.** Every `conversation_snapshot`, which is a full history saved per dispatch/step/response, is appended to JSONL and indexed 4× (`payload_json`, `raw_line`, `search_text`, FTS). Each snapshot also triggers a full checkpoint rewrite plus a `.previous` copy with fsync, and that part is on by default. `task_events` prunes old snapshots; none of these copies are pruned. Growth is O(turns × history). `loadRecentSpans` reads whole files into memory. After durable context is toggled on and then off, transcript writing can't be turned off. | `memory/TranscriptStore.ts:442, 475-491, 653, 701, 748-771`; `agent/daemon.ts:9220-9235, 9569`; `database/repositories.ts:3789`; live: 3.2 GB + 696 MB |
| LIFE-2 | Med | **Durable context does quadratic work.** The full history is re-recorded on every message, and each FTS delete filters on an UNINDEXED `id`, scanning the whole FTS table. | `agent/runtime/SessionRuntime.ts:1540-1551`; `memory/durable-context-sql.ts:264-271, 330-375, 742-760`; live: 634 MB |
| LIFE-3 | Med | **No retention** for any of: `heartbeat_*`, `core_*`, `dreaming_*`, `subconscious_*`, `.cowork/subconscious/**` (`artifactRetentionDays` is unenforced), kit `.history/` snapshots, weekly feedback files, WI `.jsonl`, or checkpoint lock files in `~/.cowork`. | `context/kit-revisions.ts:79-96`; `memory/TranscriptStore.ts:130-219` |
| LIFE-4 | Med | **Deletes can fail on foreign keys.** Task delete doesn't null `dreaming_runs.source_task_id` or `pending_memory_writes.task_id`, so the FK fails, and `SessionRetentionService` has no try/catch, so one such task aborts the whole retention run. The gateway `/removeworkspace` command fails the FK whenever data exists. There is no desktop path to delete a workspace. | `database/repositories.ts:1532-1700`; `database/schema.ts:1885, 1927`; `sessions/SessionRetentionService.ts:154`; `gateway/router.ts:8589` |
| LIFE-5 | Low | **Instance sprawl.** `MemoryWriteGate` is initialized 3×. `DailyBriefingService` is created per IPC call. `EverydayAgentService` has 3 instances. `DreamingService` is created per call with no overlap guard. The node daemon starts only a subset of services (no KG, Lore or Heartbeat) and races the desktop on kit files. | `main.ts:2081`; `ipc/handlers.ts:10652-10675`; `src/daemon/main.ts:340-387` |

---

## 6. Dead code, dead settings, write-only stores

**Dead code — safe to delete after a final grep (~5–6K LOC):**

- **Improvement loop:** `ImprovementLoopService`, `ImprovementCandidateService`, `ExperimentEvaluationService`, `ExperimentPromptBuilder`, `ImprovementSettingsManager`, `ipc/improvement-handlers.ts`, `src/renderer/.../ImprovementSettingsPanel.tsx`, and the `improvement_*` tables.
- **Other unused modules:** `memory/MemoryNudgeService.ts`, `reports/DailyBriefingService.ts`, `memory/DailyLogService.ts` (no writers; `.cowork/memory/daily/` is still read), `agents/HeartbeatPolicyRepository.ts`, and the `heartbeat_policies` and `memory_summaries` tables.
- **Uncalled methods:**
  - `UserProfileService` / `RelationshipMemoryService` `ingest*` and their extractors
  - `MemoryService.getContextForInjection`, `clearPromptRecallCache`, `getRecentWorkspaceMarkdownSnippets`, `getByTask`
  - `ExternalMemoryProvider.syncTurn` / `extractSession` / `forget`
  - the Heartbeat `captureMemory` dependency, which makes every `origin:"heartbeat"` branch in `MemoryService` dead
  - `touchPrune`, `onMemoryChanged` (no subscribers), and the `MEMORY_EVENT` channel (never sent)

**Dead or no-op settings:**

| Setting | Why it does nothing |
|---|---|
| `heartbeatMaintenanceEnabled` | Has a UI toggle; nothing reads it |
| `memoryWriteApprovalMode` | Has a 5-option select; ignored without the env var |
| `durableContextThreshold` / `FreshTailCount` / `SummaryModel` | Never read |
| WI `artifactRetentionDays`, `phaseModels`, `catchUpOnRestart`, `autoRun`/`cadenceMinutes` | Never read; there is no WI scheduler |
| Supermemory `baseUrl` | Forced back to the default host |
| EverydayAgent `memoryCandidateDays` | Never read |
| `promptStackV2Enabled`, `sessionLineageEnabled`, `memoryInspectorEnabled` | Never read |
| `includeKnowledgeGraph` | Ignored in wake-up mode |

**Write-only stores (written, never consumed):**

- `dreaming_runs` / `dreaming_candidates`
- proposed `core_memory_candidates`
- `core_memory_scope_state` and `noveltyScore`
- `heartbeat_runs.cost_stats` (never set)
- checkpoint `structuredSummary` / `evidencePacket` (only `dedupeHash` is read)
- the `{duplicate}` capture flag
- tier values `medium`/`long`: no reader uses them for ranking
- the LORE auto-block (stripped before injection)
- the KG in the default prompt path

---

## 7. Doc drift

| Doc claim | Reality |
|---|---|
| Archive injection is off by default (`workspace-memory-flow.md:189, 426`) | The per-turn recall block injects archive memory on every turn (PROMPT-4) |
| "It should not capture every tool call" (`memory-observations.md:71`) | The daemon captures every tool call and result (DATA-2) |
| Soft-delete hides the memory from recall (`memory-observations.md:173`) | Agent tools still return it; Rebuild un-deletes (SEC-5) |
| Memory Hub shows Dreaming candidates (`workflow-intelligence.md:142`); accepted candidates get applied (`dreaming.md:104`) | No UI; nothing ever accepts a candidate (LOOP-9) |
| Dreaming does not run on generic pressure (`dreaming.md:41`) | It runs on hot-memory pressure with no cooldown (LOOP-9) |
| Heartbeat owns "when should we think?" (`heartbeat-v3.md:19`) | 10+ loops schedule themselves (§4) |
| Signals merge, so ambient monitoring stays cheap (`heartbeat-v3.md:59`) | Fingerprints include window titles and never merge (LOOP-8) |
| One in-flight dispatch; dispatch requires evidence refs (`heartbeat-v3.md:124-129`) | Neither is enforced (LOOP-7) |
| Runbooks and a cached checklist (`heartbeat-v3.md:95, 118`) | Runbooks only log; the checklist is re-read every call |
| KG is auto-injected and there is no cross-workspace leakage (`knowledge-graph.md:150, 190-208`) | KG is excluded from the default prompt; tools are unscoped (SEC-9) |
| Message feedback and user messages feed profile/relationship memory (`workspace-memory-flow.md:448-461`, `evolving-agent-intelligence.md:173`) | The `ingest*` paths are dead |
| Supermemory: turn-by-turn sync not implemented; suppressed entries excluded (`workspace-memory-flow.md:297`) | Every event is mirrored; there is no remote forget (SEC-17) |
| Chronicle: passive frames never leave the device; only used observations are promoted (`chronicle.md`) | OCR text is mirrored to Supermemory; up to 5 matches are promoted (SEC-8) |
| `memory_summaries` is archive storage | Never written |
| Daily summaries are a synthesis | They are a transcript dump (DATA-12) |
| The memory budget is 2,800 tokens, 35% kit | Capped at 1,200 tokens (PROMPT-1) |
| `docs/everyday-agent.md:20` candidate count | Always 0 |

---

## 8. Target architecture — one memory system

### 8.1 Principles

1. **One source of truth per kind of knowledge.** Everything else is a *view*: `USER.md`, `MEMORY.md`, profile blocks, topic packs, the Supermemory mirror.
2. **Salience before storage.** Raw events are logs, not memories. The archive holds outcomes, decisions, resolved errors, corrections, preferences and explicit saves.
3. **Every read and write passes one policy:** scope, privacy, trust level, access profile, `retainMemory`, channel privacy and `<no-memory>`.
4. **Facts carry provenance and trust.** Values are `user_stated` > `user_confirmed` > `inferred` > `third_party` (email, screen, imports). Third-party text is never labelled "user", and is sanitized and tag-escaped when injected.
5. **One scheduler, idempotent jobs.** Every background job has a cooldown, a dedupe key, a budget and cost telemetry.
6. **Users can see, edit and *truly* delete what CoWork remembers.** They can also see which memories were used in a reply.

### 8.2 Components

```text
 producers                         ┌─────────────────────── Memory Engine ───────────────────────┐
 (memory tools, task outcomes,     │ MemoryWriter.ingest(candidate)                               │
  corrections, feedback, imports,──▶│  salience → redact (1 detector) → dedupe/supersede by       │
  Chronicle, mailbox, Box)         │  subject → policy (scope/privacy/access/no-memory) →        │
                                   │  persist → invalidate caches → optional mirror (remote id)  │
                                   │                                                             │
                                   │ ┌────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
                                   │ │ Event Log  │  │ Memory Store     │  │ Knowledge        │  │
                                   │ │ task_events│  │ memory_items     │  │ KG · docs index  │  │
                                   │ │ + ONE conv.│  │ facts · rules ·  │  │ topic packs ·    │  │
                                   │ │ search idx │  │ prefs · commits ·│  │ imports · ext.   │  │
                                   │ │            │  │ decisions · outc.│  │ providers        │  │
                                   │ └─────┬──────┘  └────────┬─────────┘  └────────┬─────────┘  │
                                   │       └──── MemoryRecall.query() — RRF, policy ─┘            │
                                   │ MemoryContextBuilder — L0 cached/session, L1 per step,       │
                                   │ one budget owner, cross-source dedupe, trust-tagged blocks   │
                                   └──────────────┬──────────────────────────────────────────────┘
                                                  ▼
                   prompts (plan · step · follow-up · chat · channels) · 5 agent tools · Memory Hub
 Heartbeat (only scheduler): observe signals → reflect (WI) → curate (Dreaming) → suggest/dispatch
```

| Component | Replaces | Key properties |
|---|---|---|
| **Event Log** — `task_events` plus **one** conversation search index (durable context, Unicode FTS keyed by event rowid) | `transcript_spans` + FTS, JSONL spans, SessionRecall, QuoteRecall's transcript lane, QueryOrchestrator transcript context | Retention follows `task_events`. Checkpoints move to `userData`, HMAC-signed with a key in `safeStorage`, and **never carry permission state**. `.cowork/memory/**` becomes a protected segment. |
| **Memory Store** — `memory_items`, evolved from `memories` + the observation sidecar | Curated entries, UserProfile, Relationship, Awareness beliefs, AdaptiveStyle state, core accepted candidates, `[PLAYBOOK]`/`[SUGGESTION]` rows (which move to their own tables) | Fields: `kind` (preference · identity · rule · project_fact · decision · commitment · correction · insight · outcome), `subject_key`, `scope` (global · workspace · contact · task), `source` + `source_ref`, `trust`, `status` (active · superseded · archived · deleted), `confidence`, `reinforced_count`, `last_used_at`, `supersedes_id`, `content_hash` (unique per scope + kind), `expires_at`, `privacy`. **Hot memory = pinned or high-salience active items.** `USER.md`/`MEMORY.md` become generated views; edits go back through `MemoryWriter`. |
| **Knowledge** | KG, markdown index, topic packs, Box/ChatGPT imports, Supermemory | KG names are case-insensitive, merges follow source precedence (manual > agent > auto), and there is a free-mail denylist. The markdown index excludes `.history/`, `subconscious/` and generated files and uses a single root. Topic packs are keyed by entity, not rank. External providers sit behind one `MemoryProvider` that stores remote IDs (so forget works). |
| **MemoryWriter** | 9 capture paths, 3 sensitive detectors, `MemoryWriteGate` staging, 3 importers | One pipeline. Low-salience events are dropped, secrets are redacted (not just flagged), hash and near-duplicate matches are merged (incrementing `reinforced_count`), and contradictions by `subject_key` supersede older items. |
| **MemoryRecall** | 14 recall implementations, 2 hybrid stacks, unified recall | One query builder (Unicode, prefix-aware) and reciprocal-rank fusion across lanes. Privacy and scope filters are applied once. The prompt builder, tools and UI all use it. A reference is counted when an item is *used*, not when it is browsed. |
| **MemoryContextBuilder** + **MemoryInjectionPolicy** | 13 injection sites, pinned profile block, Supermemory block, synthesizer, kit slice logic | **L0** (identity, rules, pinned preferences): every surface, cached per session, invalidated on writes. **L1** (task-relevant items from recall): per step. One budget owner, with the section cap equal to the requested budget. Design-system context and project instructions get their own budgets. Emits per-reply "memory used" attribution. |
| **Heartbeat as the only scheduler** | AutonomyEngine timer, core distill timer, Box poll, WI cadence knobs, MemoryNudge, Improvement loop | Pulse phases run in order: observe → reflect → curate → suggest/dispatch. Awareness and Ambient become debounced signal producers only. There is one dispatch budget and one suggestion sink deduplicated by entity. |
| **Dreaming as the only curator** | CoreMemoryDistiller memory writes, MemoryConsolidator, WI "dreams", core candidate heuristics | Merges duplicates, supersedes contradictions, promotes recurring outcomes into facts, decays unused items, and enforces retention. **Safe changes are auto-applied** (dedupe, decay, archive) with an audit log and undo. **Risky ones are queued for review** (new rules, contradictions, third-party-sourced facts). LLM synthesis runs under a per-day budget. Core traces stay as harness metrics only. |

### 8.3 Agent tool surface: 25 → ~5

| Tool | Covers today's |
|---|---|
| `memory_recall` (`query`, `scope`: memory · conversations · knowledge · external; `detail`: index · full; `ids`) | `search_memories`, `memory_search_index`/`timeline`/`details`, `search_quotes`, `search_sessions`, `memory_topics_load`, `supermemory_search`/`profile`, `kg_search` |
| `memory_remember` (`content`, `kind`, `scope`, `pin?`) | `memory_save`, `memory_curate`, `supermemory_remember`, `set_user_name`, `add_behavioral_rule` |
| `memory_forget` (`id` or `match`) | curate remove, `supermemory_forget` |
| `context_recall` — active task only, after compaction | `context_grep`, `context_describe` |
| `kg_*` — explicit graph editing, deferred and discoverable | unchanged, but scoped |

All five are in the memory lane, are available in plan steps, are blocked in group/public channels, and are treated as writes where applicable. Routing guidance is generated from the tools that are actually visible.

### 8.4 Memory Hub

Memory Hub becomes four tabs plus a single settings area:

1. **What CoWork knows:** items grouped by kind, each with provenance, trust, "why", edit, pin and delete. Delete is a real delete that cascades to the mirror.
2. **Review:** Dreaming proposals with accept / reject / undo.
3. **Sources:** Chronicle, imports, Supermemory, a KG browser, and the conversation index, each with purge.
4. **Health:** per-store size, last run, failures, duplicate rate, noise ratio and cost per loop.

**Settings:** one per-workspace mode (off / read-only / read-write) that every tool, injection site, Chronicle path and KG path respects, plus a handful of global toggles. All dead toggles are removed.

### 8.5 Quality gates

- **Memory evals in the harness battery:** a golden recall set (recall@k), duplicate rate, noise ratio (telemetry vs. salient), contradiction rate, injection-budget overflow rate, and a privacy-leak suite (suppressed, private, group channel, third-party text).
- **Health check:** Appendix A's SQL becomes a CI-safe `memory-health` script.

---

## 9. Roadmap

### Phase 0 — Security and privacy hotfix (one PR, days)

| Fix | Findings |
|---|---|
| Move checkpoints to `userData` with an HMAC; never restore permission state from a file; add `.cowork/memory` to the protected segments | SEC-1 |
| Gate the pinned profile block with the same `allowMemoryInjection` as recall; remove relationship memory from `task.prompt`; route mailbox facts to a contact-scoped, sanitized, `third_party` lane | SEC-2, SEC-3 |
| Add `search_memories`, `search_quotes`, `context_*` and `kg_*` to `group:memory`; validate `taskId` ownership in QuoteRecall | SEC-4 |
| Apply a suppressed/redacted filter on every agent read path; ignore model-supplied `privacyStates`; make Rebuild preserve the existing `privacy_state`; never inject private rows | SEC-5 |
| Redact secrets at capture; narrow the sensitive patterns to real secret shapes; use one shared detector | SEC-6 |
| Whitelist the Chronicle ID format; confine `imagePath` to the assets directory; add access checks on promotion; make Chronicle memories private; enforce pause; respect `<no-memory>` | SEC-7, SEC-8 |
| Add workspace ownership checks to KG SQL and cap result sizes | SEC-9 |
| Replace the `[Imported from` prefix with an `is_imported` column | SEC-10 |
| Add zod schemas to the memory/Chronicle/kit IPC handlers; reject `.cowork/policy` paths in `KIT_OPEN_FILE` | SEC-11 |
| Classify memory, Supermemory and KG writes as writes in plan/analyze/verifier modes | SEC-12 |

### Phase 1 — Stop the bleeding (≈1–2 weeks)

| Fix | Findings |
|---|---|
| **Salience-gated capture:** stop archiving raw tool/step events; skip memory-recall tool outputs; dedupe on `content_hash` | DATA-2 |
| **Remove the hidden 7-day expiry:** honour `retention_days`; exempt imports, playbook items and explicit saves; count a reference when an item is used in a prompt | DATA-1 |
| **Distiller:** stop "dispatch timing" meta-memories; add an `applied` status; drop the `runOffline` re-capture; failure mining ignores healthy deferred/idle pulses; add a one-time cleanup migration for existing duplicates | DATA-3, LOOP-10 |
| **Transcript diet:** stop persisting `conversation_snapshot` spans; drop the `raw_line`/`search_text` duplication; align retention with `task_events`; incremental durable-context writes keyed by rowid; one-time cleanup plus `VACUUM` (expected to reclaim ~3 GB here) | LIFE-1, LIFE-2 |
| Exclude `.history/`, `subconscious/` and generated files from the markdown index; use a single index root | DATA-9 |
| **Prompt budget:** section cap = requested budget; give design-system context its own section; order `.cowork/USER.md`/`MEMORY.md` before repo docs; give L0 to follow-up, chat and planning; add memory tools to the plan-step allowlist and the memory lane | PROMPT-1..3, RECALL-1 |
| **Heartbeat:** `clearTimeout` on every reschedule; reserve the running slot synchronously; runbooks consume no signals until implemented; fix observer suggestions, `now` wakes and task statuses; reconcile stale dispatch runs; normalize fingerprints | LOOP-1..8 |
| Make Dreaming reachable: emit `correction_learning` from the daemon's correction detection; add a per-workspace cooldown; relieve pressure via curated dedupe | LOOP-9 |
| Bind Box Brain deps; map 👎 reasons to typed signals; fix the flush-parser regex; fix the consolidation lock | DATA-11, PROMPT-8, PROMPT-9, DATA-12 |
| **Cascading deletes:** task delete, "Clear memory" and workspace removal reach every store; add `ON DELETE SET NULL` on the two task FKs | SEC-15, LIFE-4 |
| One retention job for heartbeat, core, dreaming, subconscious, kit snapshots and lock files | LIFE-3 |
| Delete the dead code and dead settings listed in §6; fix the doc drift listed in §7 | §6, §7 |

### Phase 2 — Consolidate (≈3–4 weeks)

1. Introduce `memory_items` (kinds, subjects, scopes, trust, supersession). Migrate curated entries, UserProfile, Relationship, Awareness beliefs and AdaptiveStyle into it. Make `USER.md`/`MEMORY.md` generated views.
2. Build `MemoryWriter`, then `MemoryRecall` (RRF, one Unicode FTS builder), then `MemoryContextBuilder` + `MemoryInjectionPolicy`. Delete the host search stack and the 4 formatters.
3. Make one conversation index; retire `transcript_spans`/JSONL and SessionRecall/QuoteRecall transcript lanes.
4. Consolidate the tools into the ~5 in §8.3, and generate routing guidance from the visible tools.
5. Consolidate the schedulers: Heartbeat becomes the only scheduler, AutonomyEngine is folded into a pulse phase, and there is one suggestion sink and one dispatch budget.
6. Move `[PLAYBOOK]` and `[SUGGESTION]` rows into their own tables.

### Phase 3 — Make it great (ongoing)

1. Dreaming becomes the real curator: LLM synthesis under a budget, auto-apply with undo for safe changes, and a review inbox.
2. A real local embedding model: multilingual/Unicode, chunked full content, Float32 BLOBs with `sqlite-vec` ANN. *Skipped by decision (2026-10-03); recall stays lexical FTS plus reciprocal-rank fusion (see Status).*
3. The Memory Hub redesign (§8.4) and per-reply "memory used" attribution.
4. Memory evals and per-loop cost telemetry in the harness battery.
5. Supermemory as a proper provider: remote IDs, forget, and purge on disable.

### Success metrics

| Metric | Today | Target |
|---|---|---|
| Archive rows that are raw telemetry | 66% | < 5% |
| Duplicate rows (same content hash per scope) | ~19% | < 1% |
| Curated/L0 items for an active user | 0 | 10–40, reviewed |
| Memory older than 7 days surviving | 73 rows | Everything within retention |
| DB size attributable to conversation copies | ~3.9 GB | ≤ 1 copy, retention-bound |
| Recall tools reachable in plan steps | 0 | All |
| Times the same preference is injected per step | up to 6 | 1 |
| Dreaming runs that apply or queue a real change | 0 | Daily, with undo |

---

## Appendix A — Live health-check queries (read-only)

```bash
DB="file:$HOME/Library/Application Support/cowork-os/cowork-os.db?mode=ro"
sqlite3 -header -column "$DB" "select name, round(sum(pgsize)/1048576.0,1) mb from dbstat group by name order by sum(pgsize) desc limit 15"
sqlite3 -header -column "$DB" "select tier, case when created_at < (strftime('%s','now')-7*86400)*1000 then 'older_7d' else 'last_7d' end age, count(*) from memories group by 1,2"
sqlite3 -header -column "$DB" "select case when content like 'Tool called:%' or content like 'Tool result for%' or content like 'Step completed:%' or content like '{\"stepId\"%' or content like '{\"taskId\"%' or content like '{\"groupId\"%' then 'raw_event' when content like '[core-trace:%' then 'core_trace' when content like '[SUGGESTION]%' then 'suggestion' when content like '[PLAYBOOK]%' then 'playbook' else 'other' end kind, count(*) from memories group by 1 order by 2 desc"
sqlite3 -header -column "$DB" "select (select count(*) from curated_memory_entries) curated, (select count(*) from dreaming_runs) dreaming_runs, (select count(*) from pending_memory_writes where status='pending') pending_writes"
sqlite3 -header -column "$DB" "select candidate_type, status, count(*) n, count(distinct summary) distinct_summaries from core_memory_candidates group by 1,2 order by n desc"
sqlite3 -header -column "$DB" "select run_type, status, count(*) from heartbeat_runs group by 1,2"
sqlite3 -header -column "$DB" "select substr(path,1,instr(path||'/','/')) top, count(*) from memory_markdown_files group by 1 order by 2 desc limit 10"
```

## Appendix B — Audit coverage

| Slice | Main files read |
|---|---|
| Archive core | `memory/MemoryService.ts`, `memory-capture-sql.ts`, `memory-hybrid-rank.ts`, `local-embedding.ts`, `memory-embedding-cache.ts`, `MemoryObservationService.ts`, `MemoryTierService.ts`, `MemoryConsolidator.ts`, `MemoryPressureService.ts`, `MemoryWriteGate.ts`, `database/fts-worker.ts` |
| Prompt assembly | `MemorySynthesizer.ts`, `CuratedMemoryService.ts`, `WorkspaceKitContext.ts`, `context/kit-*`, `UserProfileService.ts`, `RelationshipMemoryService.ts`, `AdaptiveStyleEngine.ts`, `ChannelPersonaAdapter.ts`, `Playbook*`, executor and `SessionRuntime` prompt paths |
| Background loops | `agents/Heartbeat*`, `subconscious/*`, `DreamingService.ts`, `core/CoreMemory*`, `core/CoreLearning*`, `awareness/*`, `improvement/*`, `everyday-agent/*`, `briefing/*` |
| Recall and evidence | `chronicle/*`, `TranscriptStore.ts`, `SessionRecallService.ts`, `QuoteRecallService.ts`, `DurableContextService.ts`, `knowledge-graph/*`, `SupermemoryService.ts`, `ExternalMemoryProvider.ts`, `BoxBrainService.ts`, `ChatGPTImporter.ts`, `RuntimeVisibilityService.ts` |
| Tools, IPC, settings and UI | `agent/tools/memory-tools.ts`, `system-tools.ts`, `knowledge-graph-tools.ts`, `tool-policy-engine.ts`, `settings/memory-features-manager.ts`, `ipc/handlers.ts`, `preload.ts`, `MemoryHubSettings.tsx`, `MemorySettings.tsx`, `ChronicleSettings.tsx`, `SubconsciousSettingsPanel.tsx` |
| Wiring, lifecycle and data model | `main.ts`, `src/daemon/main.ts`, `agent/daemon.ts`, `database/schema.ts`, the repositories |

The async-SQLite `as Any` blind spot was swept with a TS-API scan plus the repo's floating-promise lint rules. No un-awaited async repository calls were found in the memory paths. The two real async defects are `DreamingService.ts:286-290` (a try without `await`) and `agent/daemon.ts:8953` (`void` with no `.catch`). The async-migration regression is LOOP-2.
