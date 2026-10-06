# Memory Engine — design and Phase 2 foundation

**Status.** Implemented (updated 2026-10-05): the Phase 2 foundation with the Phase 3 additions, the legacy
retirement, the producer routing and the archive summary and compression fixes (§6a) noted inline. The write
side described here is implemented: the `memory_items` store, `MemoryWriter`, the one-time lane
migration and purge/retention. `memory_items` is the only store of facts about the user: the
legacy lanes are retired as stores (§5: no dual writes, no mirror, no legacy read paths), and
their data is exported and dropped by the data retirement migration (§5, "Data retirement"). On the read side,
`MemoryRecall` and the consolidated agent memory tools are implemented (§4b); see §4a for the
prompt read path.

**Embeddings: decision (2026-10-03).** A real local embedding model (audit DATA-6, roadmap
Phase 3 item 2) is skipped by decision. Recall stays lexical: one Unicode FTS query builder
per lane and weighted reciprocal-rank fusion (§4b). The memory evals (`npm run
qa:memory-evals`) are the gate for recall quality.

This document refines §8 of the [memory system audit](memory-system-audit-2026-10-03.md).
Engineers building recall, prompt assembly, the tool surface or the Memory Hub should treat
this file as the contract. File references are relative to `src/electron/memory/` unless noted.

## 1. Where things live

| Knowledge | Store | Notes |
|---|---|---|
| Semantic facts about the user, workspace and contacts: preferences, identity, rules, project facts, decisions, commitments, corrections, insights | **`memory_items`** (this document) | One row per fact revision. Written only through `MemoryWriter`. |
| Episodic history: task outcomes, resolved errors, feedback, explicit `memory_remember` notes (`outcome`, `error`, `note`) | `memories` (the archive) + `memory_observation_metadata` + FTS | Unchanged in Phase 2. See §6. |
| Raw conversation | `task_events` + the conversation index | Owned by the conversation-index consolidation, not this engine. |
| Playbook entries, proactive suggestions | Their own tables (`playbook_entries`, `suggestions`) | Moved out of `memories` by a parallel Phase 2 change. |
| Retired lanes: `curated_memory_entries`, SecureSettings `user-profile`, `relationship-memory`; awareness beliefs and the adaptive style as fact sources | Read only by the one-time lane migration, then exported and dropped by the data retirement | Their services are views of `memory_items` (§5). Awareness keeps its belief state (`awareness-state`) as signals; the adaptive style engine keeps its own bookkeeping (`adaptive-style-engine`). |

### Producers and their write path

Every producer that writes memory goes through the same hygiene: the salience gate
(`memoryTextSalience`, shared by `MemoryWriter` and the archive), secret redaction
(`sensitive-content.ts`), policy (`<no-memory>`, scope and privacy, workspace memory
settings) and dedupe. Facts go through `MemoryWriter.ingest` (§3); archive rows through
`MemoryService` (`capture`, the gated import API `openImportSession`, source sync
`replaceMemory`). The source guard `__tests__/memory-writers-sanctioned.test.ts` fails when
any other runtime module inserts into `memories` or `memory_items` or reaches their
low-level writers (`insertCapturedMemory`, the `memory.capture` worker command,
`MemoryRepository`, `MemoryItemsRepository`, the `memoryItems_ingest` unit).

| Producer | Route | Notes |
|---|---|---|
| `memory_remember`, Memory Hub, awareness, adaptive style, `set_user_name` / `set_response_style`, mailbox, Dreaming promotions | `MemoryWriter` | §3, §4b, §5, §5b. |
| Core memory candidates (`CoreMemoryDistiller`) | Facts → `MemoryWriter` as `inferred`; events → `MemoryService.capture` | Fact types: preference → `preference`, correction → `correction`, project_state → `project_fact`, pattern → `insight`, constraint → `rule`. An inferred `rule` is L0 on every turn, so a constraint is a fact only when the user accepted the candidate (not the hot-path auto-accept) or `autoPromoteToCuratedMemoryEnabled` is on; otherwise it is an archive event. Scope: `global` for a global core scope, else `workspace` (the candidate's workspace governs policy). `source_ref = { store: "core_candidate", id: <candidate id>, traceId, profileId, candidateType, scopeKind, scopeRef }`. Open loops, watch items and recurring-workflow hints are archive events (capture dedupe); their provenance is the candidate, marked `applied` with the archive row id (capture options carry no trace or candidate ids). `ignored_noise` is a runtime signal: never written. Lifecycle: written or reinforced → `applied`; dropped for good (no workspace, low salience, secret only, `<no-memory>`, outranked, runtime signal) → `skipped` with the reason; refused by settings (memory or capture off) → stays `accepted` and is retried. Without a running writer (CLI) facts fall back to the archive. The former curated promotion (`upsertDistilledEntry`) is no longer used by the distiller. |
| Chronicle (`ChronicleMemoryService`) | `MemoryService.capture`, archive only | One private `screen_context` row per promoted observation (`allowExternalMirror: false`), the task's `<no-memory>` passed as `noMemory`. Screen text is third-party content and never becomes a `memory_items` fact; Dreaming does not auto-promote screen-captured evidence. |
| Imports: ChatGPT export, pasted memory exports (`importFromText`) | `MemoryService.openImportSession` | One session per import. Opening it refuses when memory is off or privacy mode is `disabled`; strict privacy or `forcePrivate` make the rows private (private imports stay in their workspace). Auto-capture does not apply (an explicit act). Per entry: `<no-memory>`, input sanitization, inline `<private>`, redaction (secret-only entries dropped), salience, excluded patterns, then dedupe against every imported row visible in the workspace (own rows and non-private imports of any workspace, so a re-import or an import into a second workspace adds nothing) and the capture's content-hash dedupe; the row is written with its embedding (also into the cross-workspace imported-embedding cache) and observation sidecar (`origin: import`) in one capture; `finish` applies the storage cap. Imports are never mirrored to Supermemory. ChatGPT `observation` entries (facts about the user) are also written as `import` items (trust 0.6, never `user_stated`) in the workspace scope with `source_ref = { store: "import", id: <archive row id>, importer, conversationId }`; deleting the row (Inspector delete, delete imported entry, Delete imported, Clear All Memories) deletes the fact, and ignoring the row for prompt recall archives it (un-ignoring writes it again). A fact another source also holds (alias only) is left alone. ChatGPT conversations already imported and visible in the workspace are skipped before the LLM call; a conversation imported only into another workspace (privately there) is imported again from its stored entries (type and distilled text, rows whose observation is suppressed or redacted excluded) without a new LLM call, through the same session; a failed distillation counts as an error, not as processed. |
| Supermemory (`SupermemoryService`) | Remote only | Explicit remember (`memory_remember` scope `external`): `<no-memory>` refused, secrets redacted (secret-only refused), refused when workspace memory is off or privacy mode is `disabled` / `strict`; mirror writes copy archive rows that already passed `capture` and are non-private. Profile and search results are only cached per task for the prompt (third-party tag) and never stored locally, so a remote fact is never `user_stated` here. |
| Box Brain | `MemoryService.capture` / `replaceMemory` | Private source rows (`origin: import`, `forceCapture`). |
| Task outcomes, corrections, feedback, errors (daemon, executor), `memory_remember` kinds `outcome` / `error` / `note`, approved archive writes | `MemoryService.capture` | Salience-gated upstream (`memory-capture-salience.ts`) and at capture. |
| Compression batch digests | `MemoryService.capture` (§6a) | Digest of rows that passed capture, stored through `capture` (redaction, settings, dedupe, embedding, observation sidecar with capture reason `compression_digest`, storage cap). The write gate is skipped: every source row already passed it. Never mirrored to Supermemory. |

## 2. `memory_items`

Created by `ensureMemoryItemsSchema` (`memory-items-sql.ts`), called from
`DatabaseManager.initializeSchema` (`database/schema.ts`, `initializeMemoryItems`). The change
is additive (new tables only), so no schema version bump is needed: an older build ignores
the tables.

| Column | Type | Meaning |
|---|---|---|
| `id` | TEXT PK | UUID. |
| `workspace_id` | TEXT NULL → `workspaces(id)` ON DELETE CASCADE | NULL for global items and for workspace-less contact items. |
| `scope` | TEXT | `global` · `workspace` · `contact` · `task`. |
| `scope_ref` | TEXT NULL | Contact id (`contact`), task id (`task`); NULL otherwise. |
| `kind` | TEXT | `preference` · `identity` · `rule` · `project_fact` · `decision` · `commitment` · `correction` · `insight` · `outcome`. |
| `subject_key` | TEXT | Normalized `[a-z0-9_:.-]{1,120}`. Named subjects (`preferred_name`, `response_style`, `response_length`, `timezone`, `primary_language`) are single-valued. Other facts get a derived key `<kind>:<first 16 hex of content_hash>`. |
| `content` | TEXT | Redacted, whitespace-collapsed text, at most 1000 characters. `''` for a deleted tombstone. |
| `source` | TEXT | `user_stated` · `user_confirmed` · `curated` · `inferred` · `third_party` · `import` · `system`. |
| `source_ref` | TEXT JSON | Provenance: `{ store, id, … }` names the legacy record or producer. `aliases: ["store:id", …]` lists other records merged into this row by dedupe. `redactions` counts secrets replaced at write. Lane-specific fields (`target`, `curatedKind`, `layer`, `dueAt`, `beliefType`, `subject`, `reason`). |
| `trust` | REAL | Derived from `source`: user_stated 1.0, user_confirmed 0.9, curated 0.85, system 0.7, import 0.6, inferred 0.5, third_party 0.3. |
| `confidence` | REAL | Producer's confidence, 0..1. A repeat raises it to the max of the two; an edit of the same record sets it. |
| `status` | TEXT | `active` · `superseded` · `archived` · `deleted`. |
| `pinned` | INTEGER | Pinned items are L0 candidates. Supersession carries the pin forward. |
| `reinforced_count` | INTEGER | Number of times the same fact was written again (dedupe hits). |
| `last_used_at` | INTEGER NULL | Set by `markUsed` when an item is injected or quoted (not when browsed). |
| `supersedes_id` | TEXT NULL | The item this revision replaced. No FK: retention may drop old revisions. |
| `content_hash` | TEXT | sha256 of lower-cased, whitespace-collapsed content without trailing punctuation. `deleted:<id>` on tombstones. |
| `privacy` | TEXT | `normal` · `private`. Private items are never injected and never rendered into kit files. |
| `task_id` | TEXT NULL | Task the item was learned in (provenance, task-delete purge). No FK; the purge clears it. |
| `expires_at` | INTEGER NULL | Retention drops the item after this time. |
| `created_at`, `updated_at` | INTEGER | Epoch ms. Migration keeps the legacy record's creation time. |

Indexes and invariants:

- **One active row per content in a (workspace, scope, scope_ref, kind):** unique partial index
  `idx_memory_items_active_hash` on `(COALESCE(workspace_id,''), scope, COALESCE(scope_ref,''), kind, content_hash) WHERE status = 'active'`.
- **One active row per subject in a (workspace, scope, scope_ref):** unique partial index
  `idx_memory_items_active_subject`. This is what makes named subjects single-valued; derived
  subject keys are unique per content anyway.
- Lookups: `(workspace_id, status, kind, updated_at)`, `(scope, scope_ref, status)`, `task_id`,
  `expires_at`.
- **FTS:** `memory_items_fts` (FTS5, external content, `unicode61 remove_diacritics 2`) over
  `content` and `subject_key`. Insert, delete and update-of-content/subject triggers keep it in
  sync, so a deleted tombstone (content `''`) drops out of search immediately.
- Vocabularies are validated by the units (`memory-items-units.ts`), not by CHECK constraints,
  so later phases can add kinds without a table rebuild.

**Scopes.**

| Scope | `workspace_id` | `scope_ref` | Used for |
|---|---|---|---|
| `global` | NULL | NULL | Facts about the user that hold everywhere: profile facts, relationship items, awareness beliefs, response style, preferred name. |
| `workspace` | required | NULL | Curated entries (`USER.md` / `MEMORY.md` lanes), project facts, decisions. |
| `contact` | optional | contact id, `company:<id>` or `unattributed` | Third-party text about or from a contact (mailbox). |
| `task` | required | task id | Working facts that die with the task. |

## 3. Write path — `MemoryWriter.ingest(candidate)`

`MemoryWriter.ts`. One pipeline for every producer. The host runs steps 1–3; steps 4–6 are one
memory-domain transaction unit (`memoryItems_ingest` → `MemoryItemsStore.ingest`), in the
database worker when memory is routed there and one host transaction otherwise. Writes from one
writer are serialized, so fire-and-forget writes (`writeInBackground`) land in call order.

```ts
interface MemoryCandidate {
  content: string;
  kind: MemoryItemKind;
  scope: MemoryItemScope;
  workspaceId?: string | null;
  scopeRef?: string | null;
  subjectKey?: string | null;       // named subject; derived when omitted
  source: MemoryItemSource;
  sourceRef?: MemorySourceRef;      // { store, id, … }
  confidence?: number;
  pinned?: boolean;
  privacy?: "normal" | "private";
  taskId?: string | null;
  expiresAt?: number | null;
  status?: "active" | "archived";   // archived = a closed record (done commitment)
  originWorkspaceId?: string | null;// workspace whose settings govern a global write
  originText?: string | null;       // checked for <no-memory>
  noMemory?: boolean;
  mode?: "live" | "migration";
  createdAt?: number;               // migration keeps legacy timestamps
}

type MemoryWriteResult =
  | { status: "written"; action: "inserted" | "reinforced" | "superseded" | "updated";
      item: MemoryItem; supersededIds: string[]; redactions: number }
  | { status: "skipped"; reason: "empty" | "low_salience" | "secret_only" | "invalid_scope"
      | "third_party_scope" | "no_memory" | "memory_disabled" | "outranked"
      | "already_migrated"; holderId?: string };
```

1. **Salience gate.** Drop empty text, text under 3 characters, text without a letter or digit,
   and raw telemetry (`Tool called:`, `Tool result for `, `Step started:`, `Step completed:`, raw
   plan/step JSON). Over-long text is cut at a word boundary (1000 characters).
2. **Redact.** `redactSecrets` (`sensitive-content.ts`, the one shared detector) replaces secret
   values. If nothing but secrets remains, the write is dropped (`secret_only`).
3. **Policy.**
   - Scope shape (table above); otherwise `invalid_scope`.
   - `third_party` text may only be written to `contact` or `task` scope (`third_party_scope`)
     and defaults to `private`. Third-party text never becomes a fact about the user.
   - `<no-memory>` in `originText`, or `noMemory`, drops the write.
   - **Channel senders (SEC-16).** The gateway router records on each task whether the sender
     is the workspace owner (`gateway/gateway-sender-identity.ts`: a self-chat channel, or the
     sender listed in the channel config's `ownerUserIds`, set under "Your Account on This
     Channel" in each channel's settings; never a group; see
     [channels.md](channels.md#your-account-on-a-channel-memory)). For any other
     channel task, user messages and feedback do not feed awareness beliefs or the adaptive
     style, `memory_remember` writes a private `contact`-scope `third_party` item
     (`scope_ref = gateway:<channel>:<user id>`), `memory_remember` with scope `external` is
     refused, and `set_user_name` and `set_response_style` are refused.
   - Workspace memory settings of `originWorkspaceId ?? workspaceId` (live writes only): memory
     off (`enabled = false` or privacy mode `disabled`) blocks `inferred`, `third_party`,
     `import` and `system` writes, while explicit acts (`user_stated`, `user_confirmed`, `curated`)
     are still recorded. Privacy mode `strict` makes the item `private`.
   - File access profiles do not apply: the writer touches only the database. File-side views
     (kit files) are written by their owners under their own guards.
4. **Dedupe by content hash.** An active row with the same hash in the same scope and kind is
   reinforced (`reinforced_count + 1`, confidence max, pin sticky, trust and source upgraded when
   the new source ranks higher). The incoming record's ref is kept in `source_ref.aliases`, so an
   edit, delete or re-migration of that record still finds the row. A named subject arriving for
   content stored under a derived key is adopted (superseding a different holder when trust
   allows).
5. **Supersede by subject.** If another active row holds the subject in the scope, the new value
   supersedes it (`status = superseded`, new row's `supersedes_id`), **unless the holder has
   higher trust** — then the write is skipped as `outranked`. An inference never overrides what
   the user said; a newer statement of equal or higher trust always wins. **Edits:** in `live`
   mode, the active row whose `source_ref` (or alias) matches the candidate's `{store, id}` is the
   record being edited; a changed value supersedes it even when trust is equal, and an unchanged
   value is an `updated` (confidence and pin set, no reinforcement).
6. **Persist.** Insert the new row.
7. **Bump the hot-memory version** (`hot-memory-version.ts`) so cached L0 blocks rebuild.
8. **Notify** `MemoryWriter.onChange` listeners (`{ kind, itemIds, workspaceId, scope }`).

Status changes: `setStatusBySourceRef(store, id, status)` and `setStatus(id, status)`.
`deleted` applies to every revision of the record and scrubs `content` (to `''`), `content_hash`
(to `deleted:<id>`) and the pin; the tombstone is dropped by the next retention run. `archived`
and `superseded` apply to the active revision only. Reactivation always goes through `ingest`.

## 4. Read side — contracts only

`memory-engine-contracts.ts` defines the interfaces; §4a and §4b describe the implementations.

```ts
interface MemoryRecall {
  query(request: MemoryRecallQuery): Promise<MemoryRecallHit[]>;
  markUsed(refs: string[]): Promise<void>;
}
interface MemoryInjectionPolicy {
  surfaceAllowed(context: MemoryInjectionContext): Promise<MemoryInjectionDecision>;
  itemAllowed(item: MemoryItem, context: MemoryInjectionContext): MemoryInjectionDecision;
}
interface MemoryContextBuilder {
  build(request: MemoryContextRequest): Promise<MemoryContextBlock[]>;
  invalidate(workspaceId?: string | null): void;
}
```

Requirements the implementations must meet:

- **Recall:** one Unicode, prefix-aware FTS query builder for every lane; reciprocal-rank fusion
  across lanes (`memory`, `archive`, `conversations`, `knowledge`, `external`); privacy and scope
  filters applied once. Default minimum source excludes `third_party` unless the surface is
  handling that contact. `markUsed` only for items actually injected or quoted
  (`MemoryItemsRepository.markUsed` sets `last_used_at`).
- **Injection policy:** refuses private items, third-party items outside their contact's
  surface, group channels, `<no-memory>` tasks and memory-off workspaces.
- **Context builder:** L0 = active pinned items plus `identity`/`rule` items and named
  preference subjects (`preferred_name`, `response_style`, `response_length`), cached per
  session and rebuilt when the hot-memory version changes; L1 = recall for the step, per step.
  One budget owner; dedupe across sources by `content_hash`; blocks are trust-tagged and
  tag-escaped (`InputSanitizer.sanitizeInlineMemoryLine`); every block lists its refs for
  "memory used" attribution.

Existing repository reads available now: `list` (filters by workspace incl. global, scope, kinds,
statuses, subject, source store, pinned, privacy), `listForView`, `findById`, `findBySourceRef`.

### 4a. Prompt read path (implemented)

**`MemoryInjectionPolicy.ts`** — `resolveMemoryInjection(input)` is the one gate for every prompt
layer. Inputs: `retainMemory`, sub-agent, worker role, gateway context (`private` / `group` /
`public`) with `allowSharedContextMemory`, workspace memory settings (`enabled`, `privacyMode`),
`curatedMemoryEnabled`, `contextPackInjectionEnabled`, `<no-memory>` (task or current message),
read and network permissions. Output: per-layer booleans with a reason.

| Layer | On when |
|---|---|
| `l0`, `l1`, `external` | not `<no-memory>`; retained (sub-agents default off); not a verifier; private gateway or trusted shared context; workspace memory on (`enabled` and privacy mode not `disabled`). `external` also needs network access without approval. |
| `sharedContext` (pinned PRIORITIES / CROSS_SIGNALS / MISTAKES) | context pack on, readable, retained, not `<no-memory>`, private or trusted shared. Not tied to the workspace memory switch (files, not the database). |
| `workspaceKit` (`.cowork` slice) | `l0` on, private gateway, context pack on, readable. |
| `projectGuidance` (repo AGENTS.md / CLAUDE.md, docs maps) | private gateway, context pack on, readable. |

Private items (strict privacy mode, private notes) are allowed only in the user's own private
gateway and never for sub-agents; curated items only with `curatedMemoryEnabled`.
`memoryItemAllowed` refuses third-party and contact items (outside that contact's surface),
other workspaces' and other tasks' items. `DefaultMemoryInjectionPolicy` implements the
surface-level contract on top of it. Playbook capture uses the same task gate.

**`MemoryContextBuilder.ts`** — one builder per session (`TaskExecutor`).

- **L0:** active global and workspace items that are pinned, `identity`, `rule`, `commitment`,
  curated or user-stated, or preferences that are named subjects or trusted at least as
  `curated`. Cached until the hot-memory version changes. `preferred_name` and
  `response_style` are left out because the identity and personality prompts render them.
  Facts the agent saved on its own (`memory_remember` without the user asking: `inferred`,
  `source_ref.store = "agent_tool"`) are L1 only, whatever their kind, until the user pins,
  states or confirms them: one page the agent read could otherwise plant a standing rule.
  `memory_items` is the only source; without a writer (CLI) there is no memory layer.
- **L1:** `memory_items_fts` match for the request (`memoryItems_contextSearch`,
  `memory-context-sql.ts`; the shared Unicode query builder; LIKE without FTS5), minus what L0
  carries.
- **Dedupe:** a named single-valued subject once (highest trust, then newest), any other fact once
  per content hash, across scopes, kinds and sources.
- Every line goes through `InputSanitizer.sanitizeInlineMemoryLine` and is tagged `(inferred)`,
  `(imported)` or `(observed)` when the user did not state it. Blocks list their refs.
- **Budgets** (`agent/content/prompt-budgets.ts`): `MEMORY_L0_TOKENS` 600,
  `MEMORY_L1_ITEMS_TOKENS` 400 (plan steps, inside `memory_context`), `MEMORY_L1_COMPACT_TOKENS`
  250 (planning, chat, follow-up system prompt).

Where each layer lands:

| Surface | L0 | L1 | Other |
|---|---|---|---|
| Plan step | pinned `<cowork_user_profile>` block | `memory_context`, in the synthesizer's former hot-memory slot | kit slice without DESIGN.md, the generated USER.md / MEMORY.md blocks and the three shared-context files; playbook and summaries |
| Follow-up | pinned block | system prompt `memory_context` | |
| Planning, chat, companion | system prompt (`<cowork_hot_memory>`) | system prompt (`<cowork_relevant_memory>`) | |
| All | | | awareness snapshot without `user_*` beliefs; Supermemory in its own `external_memory` section and `<cowork_external_memory>` tag, cached per task for 10 minutes |

`task.prompt` no longer carries relationship memory. Retrieval queries use the undecorated
prompt (`rawPrompt`, with any strategy block stripped).

**Attribution.** Each surface emits a `memory_used` task event once per turn (chat turn, plan,
step, follow-up; `resetMemoryUsedAttribution`) and again when its set of injected refs changes
within the turn: `{ surface, refs, source }` with `memory:<id>`, `archive:<id>` and
`external:<provider>`. The event is hidden from the main timeline, is not indexed as
conversation and is ignored by the archive salience gate. `memory:` refs are counted with
`markUsed`.

**"Memory used" per reply (Phase 3).** The events never reach the renderer's event list. The
`memoryItems:usedForTask` IPC reads them with the task's replies and user messages and
attributes them in main (`shared/memory-used.ts`): the events after the latest user message or
reply belong to the next `assistant_message` / `task_completed`; a turn without a reply drops
its events. Each chat reply shows a small "Memory used (N)" toggle
(`renderer/components/memory/MemoryUsedAffordance.tsx`, per-task cache in
`memory-used-store.ts`) that expands to the facts (resolved with `memoryItems:get`: content,
source badge, "Open in Memory Hub", which opens the "What CoWork knows" tab filtered to the
item and switches the Hub to the task's workspace), task-history notes and external context
it used. The browser host serves the same attribution as `getMemoryUsedForTask`
(`host/services/browser-memory-methods.ts`, workspace read authority, task bound to the
workspace).

**Read-side syncs (`memory-read-side.ts`)**, installed by `startMemoryEngine` after the startup
lane migration. PersonalityManager's user name and response style are mirrors of `memory_items`:

- PersonalityManager's user name follows the active `preferred_name` item: `set_user_name`
  (`user_stated`) wins over inferred names, and a newer statement supersedes. A deleted item
  clears the name. After the migration, the live PersonalityManager name is adopted once as
  `user_stated`, so the migration never reverts it.
- The active `response_style` item carries its structured style in `source_ref.style`; the
  read side applies it to PersonalityManager's live style after every write (an adaptation, a
  style set in Settings, `set_response_style`). An item without `source_ref.style` (copied from
  the retired adaptive-style lane) changes nothing. `AdaptiveStyleEngine` only writes the item
  (`inferred`); it keeps its observations, rate limits and history in its own settings, and
  does not adapt without a MemoryWriter.
- `AdaptiveStyleEngine` does not adapt while a `user_stated` / `user_confirmed`
  `response_style` item exists. Feedback received meanwhile is dropped. A response style
  changed in Settings is written as that item (`withSettingsResponseStyleMirror`); a save
  that leaves the style unchanged writes nothing, so an adapted style is not turned into a
  user choice by an unrelated settings save. A stale form copy is not a choice either: the
  Personality settings form sends the style it loaded (`responseStyleBaseline`); when the
  saved style equals it, nothing is recorded and the newer (adapted) style is kept. Callers
  without a baseline (onboarding, import, browser host) skip the record when the save exactly
  undoes the engine's latest adaptation of every changed dimension.

### 4b. Recall and the agent tool surface (implemented)

`MemoryRecall.ts` implements the `MemoryRecall` contract (`MemoryRecallService.getDefault()`):

- **Lanes.** `memory` (`memory_items`, read unit `memoryRecall_searchItems` in
  `memory-recall-sql.ts`), `archive` (`MemoryService.searchForRecallAsync`: the hybrid search
  and Phase 0 visibility filter of `searchAsync`, without counting a listing as a reference),
  `conversations` (`DurableContextService.searchConversation`, the active task excluded by
  default), `knowledge` (KG `searchEntities` and the `.cowork` markdown index, read-only;
  topic packs are retired and `topic:` refs are unknown), `external` (Supermemory; only when `policy.allowExternal` and configured).
- **One FTS builder.** The memory lane uses `database/fts-query.ts` (Unicode, prefix-aware,
  operator-safe: all terms, then any term), with a term-match fallback when FTS5 is missing.
  The markdown index, mailbox search and YouTube transcripts use its term extraction,
  folding (`foldSearchText`: case and Latin accents) and quoting too (RECALL-9): their
  earlier ASCII-only dialects dropped every non-Latin word, so a Cyrillic, Greek, Turkish or
  CJK query found nothing. The markdown tokenizer keeps ASCII text exactly as before (stored
  local embeddings stay comparable) and keeps a single CJK character as a word; a CJK word
  inside a longer run of characters (which `unicode61` indexes as one token) is found by the
  `LIKE` fallback when FTS returns nothing. Shared text helpers (`trimmedText`,
  `collapseWhitespace`) replace the copies of `normalizeText` in the recall paths.
  Any-term (OR) queries drop function words of a small English, German, Turkish, French and
  Spanish stopword list, unless the query has nothing else; all-terms (AND) queries keep every
  term. Without this, "when do we ship the postgres 16 migration" matched every row containing
  "the" or "we".
- **Knowledge graph.** `searchEntities` matches entity names and descriptions through FTS, and
  fills the remaining slots with entities whose observations contain the query's distinctive
  terms (observations are not in the FTS index); those hits carry the matching observations,
  so the recall hit shows them.
  The graph's entities are unique per workspace, type and case-insensitive name, automatic
  extraction and mailbox ingest skip workspaces with memory off and `<no-memory>` text, and
  observations are deduped, so the lane no longer returns `Go`/`go` twins, "Gmail"
  organizations or repeated mailbox notes ([knowledge-graph.md](knowledge-graph.md), DATA-10).
- **Visibility, once per lane.** Memory items: `active`, unexpired, global or this workspace,
  task scope only for the active task, contact scope only for `contactRef`; `private` only with
  `policy.includePrivate` (or the handled contact's own items); minimum trust `inferred` unless
  `minSource` says otherwise (so `third_party` is out by default). Archive: agent-visible rows of
  this workspace plus non-private imports. Conversations, KG, files: this workspace only; files
  through the caller's read guard and inside `.cowork/`.
- **Fusion.** Weighted reciprocal rank (k = 60): memory 1.0, archive 0.8, conversations 0.7,
  knowledge 0.6, external 0.5; imported archive rows count half. Each
  contribution is scaled by term coverage: `0.4 + 0.6 × coverage`, where coverage is the share
  of the query's distinctive (non-stopword) terms in the hit's text, applied when the query
  has at least two such terms. Rank fusion alone let a one-word match in a strong lane outrank
  a full match in a weaker lane. Hits with the same normalized text are merged (strongest lane
  kept, all lane ranks recorded). `relevance` is the fused score relative to the best hit.
- **Hits** add `snippet`, `relevance`, `tokenEstimate`, `kind` and `provenance` to the contract
  type. `detail: "full"` adds `content` (≤ 4000 characters); `ids` expand lane-qualified refs
  (`memory:`, `archive:`, `event:`, `kg:`, `doc:<start>-<end>:<path>`, `repo:`) with the
  same visibility rules. `query` has no side effects; `markUsed` sets `last_used_at` on items and
  records an archive reference — the tools call it only for results returned in full.
- **Failures.** `recall()` reports per-lane errors; `query()` throws when every lane failed, so
  a broken index is never mistaken for "nothing remembered" (RECALL-3).

**Mission Control recall** (`RuntimeVisibilityService.collectUnifiedRecall`, RECALL-4) is
the user's search over one workspace in task detail. Lanes: memory items (this recall's
`memory` lane: no private, task-scope, contact or third-party items), archive memories
(`searchForBriefingAsync`), workspace notes (the `.cowork` markdown index), the knowledge
graph, Chronicle `screen_context`, the conversation index (user and assistant messages
verbatim, which replaces the retired quotes lane, plus tool output and summaries), tasks,
files those tasks touched, the activity feed and Supermemory (source `supermemory`, only
when connected and the workspace has network access on; the query leaves the device,
nothing is stored). Tasks and activity have no FTS index: they are term-searched in SQL
over every row of the workspace (`TaskStore.searchByTerms`, `ActivityStore.search`: at
least half the query terms, most matching terms first, then newest; 200 rows), then ranked
by term coverage, so a matching task from last year is found as well as one from today.
Lanes are fused by weighted reciprocal rank. A search records no memory use, and notes are
read through a read guard (inside `.cowork`, the workspace's access profile), which also
keeps a search from scheduling a markdown index sync: the index is as fresh as the last
sync by a task or a kit write. The IPC handler passes only the query, limit, source types
and the stored workspace.

Agent tools (`agent/tools/memory-tools.ts`, audit §8.3): `memory_recall`, `memory_remember`
(facts through `MemoryWriter` as `user_stated` only when the model sets `user_asked` and the
user's latest message asks to remember, else `inferred`; `pin` only for `user_stated`;
`outcome`/`error`/`note` to the archive; available in every plan step so the agent saves
what it learns while it works, and its description says when to save), `memory_forget` (Memory Hub delete path for items, own archive rows, Supermemory ids;
asks the user first through the permission engine as a `memory_delete` approval (classified as
a delete; the dialog is titled "Forget a memory" and shows the memory and its source; channel
approval messages leave the memory text out) — prompted in the default and dangerous-only
modes, allowed by bypass modes or a saved rule — except for
an item this task's agent inferred itself and that no other record merged into; Supermemory
ids keep the pipeline's `external_service` approval),
`context_recall` (the active task only; earlier tasks are recalled through `memory_recall`).
Supermemory is reached through the same tools: `memory_recall` scope `external`,
`memory_remember` scope `external` (a memory stored only in Supermemory, through the memory
write gate's `external` target; refused for third-party channel senders), and `memory_forget`
with an `external:<id>` id or with `scope: "external"` and `match` text (Supermemory matches
the text). All three take the `external_service` approval and need workspace network access.
Routing guidance is one generated hint of about 90 tokens naming only visible tools
(`memory-tool-routing.ts`).

**Removed tools.** The 16 earlier tools (`search_memories`, `memory_search_index`,
`memory_timeline`, `memory_details`, `search_quotes`, `search_sessions`, `memory_topics_load`,
`memory_curated_read`, `supermemory_profile`, `supermemory_search`, `memory_save`,
`memory_curate`, `supermemory_remember`, `supermemory_forget`, `context_grep`,
`context_describe`) were hidden aliases for one release and are now removed: they are not
registered, not tool-semantics aliases and not listed in any policy group, allowlist or deny
list, so a call to one fails as an unknown tool. `SupermemoryTools` and the agent's curated
`memory_curate` path are gone; the old `containerTag` override of `supermemory_remember` has
no replacement (writes use the workspace's container). `RETIRED_MEMORY_TOOL_NAMES` in
`shared/types.ts` lists the names for code that reads recorded task history: the conversation
index backfill still skips their recorded output, and the timeline shows old calls with the
generic tool label.

## 5. Legacy lanes

Mapping lives in `memory-items-lanes.ts`. The lane migration uses it to copy the retired
lanes; the services that now write `memory_items` directly (profile facts, awareness beliefs,
response style, user name) use the same mappers, so a fact maps the same way on every path.

| Lane | Kind | Scope | Source | Notes |
|---|---|---|---|---|
| `curated_memory_entries` (active) | identity→identity, preference→preference, constraint/workflow_rule→rule, project_fact→project_fact, active_commitment→commitment | workspace | `curated`; `distill` entries → `inferred` | User lane (`target = user`) is pinned. `source_ref.target`/`curatedKind` keep the lane. Archived entries are not migrated. |
| `user-profile` facts | identity/bio/work→identity, constraint→rule, everything else→preference | global | manual→`user_stated`, feedback→`user_confirmed`, conversation→`inferred` | Identity values failing the preferred-name sanitizer are dropped (as the profile drops them on load). `Preferred name: …` → subject `preferred_name`. |
| `relationship-memory`, non-mailbox | identity, preferences→preference, context→insight, commitments→commitment | global | conversation→`inferred`, feedback→`user_confirmed`, task→`system` | **History items are not migrated**: task-completion history is episodic and stays out of the fact store. Done commitments → `archived`. |
| `relationship-memory`, mailbox | as above | contact (`contactIdentityId`, else `company:<id>`, else `unattributed`) | `third_party` | `private`; `dueAt`, `companyId` kept in `source_ref`. |
| Awareness beliefs (`user_fact`, `user_preference`, `user_goal`) | identity, preference, preference | global | `inferred`; `user_confirmed` once confirmed | Belief subjects `preferred_name` and `response_length` become named subjects; contradictions resolve by recency (beliefs are ingested oldest first, so the newest supersedes). Other belief types are signals, not facts. |
| AdaptiveStyleEngine | preference | global | `inferred` | Single subject `response_style`, written only if the engine has adapted at least once. |
| PersonalityManager user name | identity | global | `user_confirmed` (migration), `user_stated` (`set_user_name`) | Subject `preferred_name`, pinned. |

### Lane migration

`MemoryItemsLaneMigration.ts`, run by `memory-engine-bootstrap.ts` (`startMemoryEngine`, awaited
from `main.ts` and from the node daemon's `src/daemon/main.ts` after `MemoryService.initialize`)
**at startup, before queue recovery, IPC and any service read memory**: there is no legacy
read fallback, so nothing may read a half-migrated store. When the other process (desktop app
or node daemon on the same profile) holds the claim, startup waits up to 60 s for its marker.
The migration is the only runtime reader of the retired lanes: it reads the SecureSettings
blobs directly (`loadLegacyLaneSources`, with the normalization the retired services applied)
and the curated table through `memoryItems_listCuratedForMigration` (absent table: no rows).

- Runs once per profile; the marker is `maintenance_state.memory_items_lane_migration_v1` with a
  JSON summary of per-lane written/skipped counts.
- **One process at a time.** The desktop app and the node daemon may share a profile. Before
  running, a process claims the job (`maintenance-claim-sql.ts`, unit
  `memoryMaintenance_claim`): one IMMEDIATE transaction checks the marker and the claim row
  `memory_items_lane_migration_v1:claim` and writes its own claim, so only one process runs it.
  The claim is a one-hour lease released when the run ends (also on failure), so a process
  that died mid-run does not block the job for good. The one-time archive cleanup
  (`MemoryCleanupMigration`, `memory_cleanup_migration_v1`) is claimed the same way; the
  payload-table migration runs inside schema initialization under the profile's migration
  lock, and the core-memory duplicate cleanup is a single transaction.
- Every record goes through `MemoryWriter.ingest` with `mode: "migration"`, so the normal
  salience, redaction, dedupe and supersession rules apply. A record whose `{store, id}` already
  exists (as primary ref or alias) is skipped, so an interrupted or forced re-run adds nothing.
- Lane order: curated → profile → relationship → beliefs (oldest first) → adaptive style →
  stored user name. Yields to the event loop between lanes.
- A lane whose SecureSettings blob exists but cannot be read (decryption or checksum failure)
  counts as failed; the other lanes are still copied, the marker is **not** written, and the
  run is retried on the next start. Settings are read with `loadWithStatus`, so an unreadable
  blob is never mistaken for an empty one.
- The legacy stores are not modified here. The data retirement (`LegacyMemoryRetirement.ts`,
  scheduled by `startMemoryEngine` after startup) exports and drops them only once this
  migration's marker exists.

### Retired lanes: services over `memory_items`

No dual writes remain: `MemoryWriter.dualWrite` / `dualWriteStatus` and the legacy mirror
(`memory-items-legacy-mirror.ts`) are gone. Synchronous producers use
`MemoryWriter.writeInBackground` (fire-and-forget, serialized). Synchronous readers use
`MemoryFactsSnapshot` (`memory-facts-snapshot.ts`): a cache of the active global items and
active commitments, loaded at startup, refreshed after every writer change and, when older than
30 s, on the next read (changes made by the other process on the profile). Services that write
await a refresh before they return, so callers read their own writes.

| Service / producer | Now |
|---|---|
| `UserProfileService` | `getProfile()` (sync): active, non-private global items except commitments, as `UserFact` (id = item id; category from `source_ref.category`, a goal belief, or the kind). `addFact` (async) writes `userFactCandidate`; `deleteFact` (async) tombstones the item and its revisions. No update API: facts are edited in the Memory Hub. |
| `RelationshipMemoryService` | Commitments are `commitment` items: open = `active`, done = `archived`, due date = `source_ref.dueAt`. `listOpenCommitments` / `listDueSoonCommitments` (sync, snapshot) feed Awareness, AutonomyEngine, the briefing and suggestions; `listItems`, `updateItem` (text, confidence, done/reopen, due date; a new revision of the same record) and `deleteItem` are async. Mailbox insights are private contact-scope `third_party` items (`store: "mailbox"`, record id derived from contact and text, so a repeat updates the due date). `recordTaskCompletion` only closes commitments the summary reports as done; task history is not stored. |
| Mailbox reply drafts | `buildContactMemoryContext` (`contact-memory-context.ts`): the contact's (then its company's) active contact-scope items, sanitized, under a header that marks them as the contact's words. |
| `CuratedMemoryService` | The workspace scope of `memory_items`. `list` / `getPromptEntries` map items to `CuratedMemoryEntry` (id = item id; lane from `source_ref.target` or the kind; prompt entries skip private items). `curate` add → `curated` item; replace → a new revision of the same record (a superseded id follows its record to the active revision); remove → `archived`. Items the user stated or confirmed are refused (Memory Hub only). `upsertDistilledEntry` → `inferred` item. Without a writer it reports memory as unavailable. |
| Awareness beliefs | `beliefCandidate`, written by `AwarenessService` directly (`user_confirmed` when confirmed or learned from feedback; `preferred_name` / `response_length` single-valued). |
| `AdaptiveStyleEngine` | `response_style`, `inferred`, with `source_ref.style`; PersonalityManager mirrors it (§4a). |
| `set_user_name` / `set_response_style` tools, a style set in Settings | `preferred_name` / `response_style`, `user_stated` (`writeInBackground`). |
| Core memory candidates | Fact candidates through `MemoryWriter` as `inferred` items (§1); the distiller no longer promotes into the curated lane. |
| Imports | Imported facts as `import` items through the gated import API (§1). |
| Approval-gated `memory_remember` | Staged with `MemoryWriteGate` (target `curated`, action `remember`) as the candidate itself (kind, scope, source, subject, record id) and replayed through `MemoryWriter` after approval, without a curated-lane conversion. |

The store also updates the provenance fields of an edited record whose text is unchanged (an
edit of the same `{store, id}`), so a new due date is kept.

**IPC.** `memory:getUserProfile`, `memory:commitmentsGet` and `memory:commitmentsDueSoon` read
these views. `memory:relationshipList` / `Update` / `Delete` back the Commitments section of
Settings > Memory (status, due date, text, forget). `memory:addUserFact`,
`memory:updateUserFact`, `memory:deleteUserFact` and `memory:relationshipCleanupRecurring` are
removed, with their preload and browser-host methods: facts are edited in "What CoWork knows".

**Guard.** `__tests__/legacy-memory-stores-retired.test.ts` fails when runtime code outside the
migrations (lane migration, data retirement, the pre-retirement privacy purge) names the
curated table or the `user-profile` / `relationship-memory` settings blobs.

### Data retirement

`LegacyMemoryRetirement.ts` (scheduled by `startMemoryEngine` after startup, claimed like the
other one-time jobs, marker `legacy_memory_retirement_v1`) runs only after the lane migration
marker exists. It writes an encrypted safety export (`<userData>/backups/legacy-memory-*.json.enc`,
OS keychain; without OS encryption a plaintext export leaves the settings blobs out), verifies
that every exported record has a `memory_items` row (re-ingesting missing ones in migration
mode, aborting and retrying on the next start otherwise), then deletes the `user-profile` and
`relationship-memory` blobs (only if unchanged since the export) and drops the retired tables
(`curated_memory_entries`, the unused `memory_summaries` and `heartbeat_policies`, the retired
self-improvement `improvement_*` tables once Workflow Intelligence has copied them, and the
`transcript_spans` tables once the conversation index migration has finished).
`adaptive-style-engine` (engine bookkeeping) and `awareness-state` (belief signals) are kept.

### Generated kit views (retired)

The `USER.md` / `MEMORY.md` auto-blocks (`<!-- cowork:auto:curated-user:* -->`,
`<!-- cowork:auto:curated-workspace:* -->`) used to render `memory_items` into the kit, with
back-sync of hand edits and a `KitFileWatcher`. All of that is retired
(docs/memory-repo-phase3-design.md §6): facts live in `memory_items` and the memory folder,
and nothing writes the blocks any more.

- Leftover blocks are removed once per workspace (`stripCuratedKitBlocksOnce`,
  `kit-block-strip.ts`) when a task plans in it and from Clear All Memories. The pass only
  writes a file that still has markers (with a `.history` snapshot), and skips (to retry
  later) when the kit files are symlinks or resolve outside the workspace, or when the
  workspace's access profile denies reading or writing them. It then deletes the
  workspace's `kit_render_state:<workspaceId>:<user|workspace>` keys.
- The prompt still strips the markers from kit text as a defense.
- Items written by the old back-sync keep their `kit_file` provenance.

## 5a. Memory Hub: "What CoWork knows", Sources and Health

The Memory Hub's tabs are What CoWork knows, Review (§5b), Sources, Health and Settings.
The first tab of Settings > Memory (audit §8.4) is a view of `memory_items`, through
`MemoryItemsHubService` and the `memoryItems:*` IPC channels (zod-validated in main,
`memory-ipc-validation.ts`; the browser host exposes the same methods with workspace
read/write/delete checks).

- **Scope of a view:** the selected workspace's items, global items and workspace-less contact
  items. Another workspace's item is reported as not found by every operation.
- **List** (`kinds`, `scopes`, `statuses`, `sources`, `query` substring, `pinnedOnly`; at most 200
  per page), **get** (with the supersession chain), **why** (plain-language origin, whitelisted
  `source_ref` fields, the task it was learned in, shown by title only for a task of the same
  workspace).
- **Add** writes `user_stated` (`source_ref.store = "memory_hub"`), global or workspace. **Edit**
  writes a new `user_stated` revision with the item's `{store, id}`, so MemoryWriter supersedes
  the old one. **Pin** sets `pinned` and bumps the hot-memory version. **Delete** tombstones the
  item and every older revision. Workspace changes re-render the kit files.
- **Clear global memories** hard-deletes global items (`{ success, deleted }`);
  workspace items are cleared by Clear All Memories, whose per-store counts the Hub now shows.
- Items from other people (contact scope or `third_party`) are listed in a separate, collapsed
  "From other people" section.
- The fact editors in Personality > Memory and the Memory settings card were removed; both point
  to this tab.
- **Layer preview** (`MemorySynthesizer.buildLayerPreview`): what a private task in the
  workspace would receive, built like a plan step. `resolveMemoryInjection` decides the layers
  (private gateway, the workspace's memory settings, no external provider); L0 is the
  builder's pinned profile block and L1 the plan step's memory section (the builder's L1
  recall for the most recent task prompt, the kit slice, playbook and summaries).

**Sources and Health tabs** (audit §8.4). `MemoryHealthService` behind the `memoryHub:sources`
and `memoryHub:health` IPC channels (`memory-health-ipc-validation.ts`, zod in main; the
browser host exposes `getMemorySources` / `getMemoryHealth` behind workspace read access).
Both are read units of the memory domain (`memory-health-sql.ts`), so they run in the database
worker when memory is routed there. They return counts, ratios and timestamps only, never memory
content or credentials.

- **Sources** (the selected workspace): active facts by `source` and by `source_ref.store`
  (the producer: `memory_hub`, `kit_file`, `agent_tool`, `core_candidate`, `dreaming`,
  `import`, `mailbox`, `awareness`, `adaptive_style`, `personality` and the migrated lanes),
  each split into this workspace, global and workspace-less contact items, with a plain-language
  explanation. "Show" opens "What CoWork knows" filtered to that source. Also the workspace's
  archive rows by type and by capture origin (private count), imports (archive rows and
  `import` facts), Chronicle (on or off, `screen_context` rows), Supermemory (on, connected or
  not, copies sent from the workspace) and knowledge graph entities, relationships,
  observations and entity types.
- **Health** (the whole profile database, every workspace; the workspace only gates access):
  the checks of `npm run qa:memory-health` with PASS / WARN / SKIP (a missing table) / INFO and
  their thresholds. Archive telemetry ratio ≤ 5 %, archive and `memory_items` duplicate rate
  ≤ 1 %, no heartbeat run still `running` after an hour, no orphan embeddings, ≤ 25 memory
  writes waiting for approval, database ≤ 1024 MiB, and every one-time memory migration marker
  present (the Hub adds the memory folder's checks, including "Memory folder dreaming").
  A Refresh button reruns the checks (`memoryHub:health` allows 10 calls a minute).
- The thresholds, the stuck-run age and the migration marker keys live in
  `src/shared/memory-health-thresholds.json`, read by both the service and the script (`ci` is
  the script's `--ci` preset; `hub` is when the tab shows WARN). The service repeats the
  script's SQL; `__tests__/MemoryHealthService.test.ts` checks both give the same numbers on the
  same database.

## 5b. Commitment expiry (Phase 3)

The heuristic curator of `memory_items` (`DreamingService`, `MemoryCurator`,
`memory-curation-llm`, the `dreaming_candidates` review queue, "Run Dreaming now", the
`dreamingLlm*` settings and their health checks) was retired in Phase 3
([memory-repo-phase3-design.md §6](memory-repo-phase3-design.md#6-retired)): global and
workspace facts live in the memory folder, which has its own dreaming
([memory-repo-phase2-design.md](memory-repo-phase2-design.md)). The `dreaming_runs` and
`dreaming_candidates` tables stay for history; retention prunes them, and the schema setup
closed their open proposals as `dismissed` (`memory-curation-log-sql.ts`).

What stays is commitment expiry, `CommitmentExpiryService.ts`, offered by every Heartbeat
pulse while heartbeat maintenance is on and no task is in the foreground; the service runs at
most once a day per process (in-memory cooldown, no state table) and waits for the lane
migration.

- **Input:** active `commitment` items of scope `global` or `workspace` (contact items are
  never touched) at least a day past `source_ref.dueAt`, not `user_stated` or
  `user_confirmed`.
- **Evidence:** an archive outcome of the last 30 days (`memory-curation-sql.ts`
  `archiveEvidence`) or a conversation-index hit, dated no earlier than a week before the due
  date, that shares the commitment's words and says "done", "sent", "shipped", …. Workspace
  commitments are checked in their workspace; global ones in the five most recently used
  workspaces. At most 20 conversation searches per sweep, least recently searched first.
- **Apply:** at most 25 expiries per sweep, each one `MemoryWriter.applyCuration({ op:
  "expire_commitment" })` with origin `auto`: one transaction with its `memory_curation_log`
  row (before/after snapshots, fingerprint `expire_commitment:<id>`). The store re-checks the
  invariants and refuses protected items. Nothing is queued for review; a commitment without
  evidence stays open.
- **Undo:** the Memory Hub Review tab lists the workspace's expiries under "Closed
  commitments" (`memoryReview:get` / `memoryReview:undo`, zod-validated in main,
  `memory-review-ipc-validation.ts`; same methods in the browser host).
  `MemoryWriter.undoCuration` reopens the item; undo is refused when it changed since, and an
  undone fingerprint is never applied again. Log rows that quote an item are deleted when the
  item is really deleted; retention drops log rows after 90 days.

## 6. The archive (`memories`) and its future

- **Now (Phase 2):** `memories` stays the episodic store: task outcomes, resolved errors,
  feedback, corrections as events, explicit `memory_remember` notes, core-candidate events,
  Chronicle and imports. It keeps its own capture path (the shared salience gate, redaction,
  settings and content-hash dedupe, §1), retention (`retention_days`), privacy states and
  FTS. `memory_items` is the semantic fact store. Facts link back to archive rows in two ways:
  Dreaming promotions list their evidence as `source_ref.aliases` (`archive:<id>`), and
  imported facts name their imported row as the primary ref (`{ store: "import", id }`), so
  the fact follows the row's delete and ignore. (The import store is distinct from
  `archive` so that deleting one piece of Dreaming evidence never deletes a promoted fact.)
- **Phase 3 (unification):** Dreaming promotes recurring archive outcomes into `memory_items`
  facts (`source: inferred`, `source_ref.aliases` listing the supporting archive rows), and
  `MemoryRecall` fuses both lanes. The archive then becomes the `outcome`/`decision` event lane
  of the same engine: either `memory_items` gains episodic kinds and the archive rows migrate in
  with `kind = outcome`, or the archive is kept as an evidence log behind the facts. That choice
  is deferred until recall telemetry shows how often episodic rows are recalled directly.

## 6a. Archive capture, summaries and compression

Audit DATA-5 and DATA-7. Code: `memory-summary.ts` (pure), `MemoryService.capture`, the
compression queue in `MemoryService`, `MemoryCompressionBudget.ts`,
`memory-compression-usage-sql.ts`, `memory-summary-reindex-sql.ts` and
`MemorySummaryReindex.ts`.

**Deterministic summary.** Every row gets a local summary at capture: the first
informative line, at most 220 characters. Skipped lines: code fences (prose wins over
code), the prompt-recall ignore marker, tag-only lines (`[Imported from …]`,
`[core-trace:…]`, `[scope:…]`, a digest header), the Chronicle provenance and
"treat screen-derived text as untrusted" lines, the compaction preamble, the
"Pre-compaction memory flush" header, "Tool result for X:" and "Tool called:" labels,
short label-only lines ("Highlights:") and generic section headings ("## Summary",
"Current State"). A generic label in front of text is dropped ("1. **Current State**: X"
→ "X"). A `Key: value` first line is joined with the field lines after it, so Chronicle rows
read "App: Slack · Window: #releases · …". When every line is skipped, the first line
is kept.

**Embedding and observation.** The local embedding is built from the summary followed by
the informative content (12 000 characters at most), not the summary alone. The
observation sidecar's narrative, facts and concepts come from the informative content;
the title from the summary (or the content when there is none). `tokens` is the
content's estimate.

**AI compression.** On by default per workspace (`compressionEnabled`, Memory settings →
"AI memory compression"; a workspace whose saved setting is off stays off, because only the
user's own save can write it off). Captures worth it (decisions, errors and preferences of
≥ 100 content tokens, observations, insights and screen context of ≥ 300; not low-priority,
structured or `summary` rows) are queued and drained in the background, paused while a task
runs with the side-channel policy. One row gets a one-line model summary of its content
(`summary` replaced, redacted again); several rows of one task or window get a digest stored
as a new `summary` row through `capture`. At drain time the workspace settings are read
again: memory off or privacy `disabled` drops the queue, AI compression off or privacy
`strict` keeps it local; private, `<no-memory>`, deleted and redacted rows never reach the
model or a digest. The call uses the configured provider (no task override) with its cheap
profile, 160 output tokens, and the prompt carries content excerpts (4 000 characters for one
row, 600 per row for a digest). Calls are rate-limited (3 per workspace per 15 minutes) and
bounded by `memoryCompressionDailyTokenBudget` (default 20 000 tokens, rolling 24 hours,
across workspaces), counted in `memory_compression_usage` (a ledger without memory text,
pruned after 7 days; a failed call is charged its estimated input). Without budget, the
deterministic summary or digest is kept. Memory settings show the notice "AI memory
compression uses your model provider and costs tokens (up to N tokens/day …)", the budget
and the last 24 hours' use (`MemoryService.getStats`).

**Storage cap.** `maxStorageMb` counts content, summary, the stored embedding JSON and the
observation sidecar's text columns, per workspace and per row when pruning (FTS index
rows are not counted).

**One-time re-index** (`memory_summary_reindex_v1`). Runs after the archive cleanup
migration, about 90 seconds after start, claimed like the other one-time jobs. Chunks of
100 rows (by rowid, rows created before the run started), each one memory-domain unit in
the database worker, with a 50 ms pause between chunks; progress (last rowid and counts) is
stored with each chunk under `memory_summary_reindex_v1:progress`, so a run stopped by
shutdown resumes. Per row: Inspector-deleted or redacted rows and hand-edited observations
are skipped; a deterministic summary (empty or equal to the old first-line rule) is
recomputed and `tokens` set to the content's estimate, any other summary (model-written,
source sync) is kept; the embedding is rebuilt; an existing observation's title,
narrative, facts, concepts and file lists are derived again (privacy state and provenance
unchanged; none created). `updated_at` is not changed. The `memories_fts_update` trigger
reindexes summary changes. The marker stores `scanned`, `summariesRewritten`,
`embeddingsRewritten`, `observationsRewritten`, `skippedEdited` and `keptCustomSummary`.

## 7. Purge and retention

- **Task delete** (`memory-purge-sql.ts` `purgeTaskDerivedRows`, inside `TaskStore.delete`'s
  transaction): task-scoped items are always deleted. With `purgeDerivedMemory`, items learned
  in the task with source `inferred`, `third_party` or `system` are deleted too. User-stated,
  confirmed and curated items survive with `task_id` cleared.
- **Clear All Memories** (`purgeWorkspaceMemoryRows`, `MemoryWorkspacePurgeService`): every item
  with the workspace's `workspace_id` (workspace, task and workspace-bound contact scopes);
  reported as `memoryItems`. Global items are not workspace-owned and are not cleared. Deleting a workspace row cascades to its items (on connections with
  foreign keys on).
- **Retention** (`MemoryRetentionService`, step `memoryItems`, `MEMORY_ITEM_RETENTION_RULES`):
  daily, drops `deleted` tombstones and items whose `expires_at` has passed. Step
  `memoryItemRevisions` (`MEMORY_ITEM_REVISION_RETENTION_RULES`) drops `superseded`
  revisions superseded more than 180 days ago (`supersededRevisionRetentionDays`), except
  the newest 5 revisions of each item's chain (`SUPERSEDED_REVISIONS_KEPT`, walking
  `supersedes_id` from the current row, so the Memory Hub history keeps its latest steps)
  and any revision a curation-log entry that can still be undone touched or created (Undo
  restores rows by id). A dropped revision only shortens the tail of a chain. Step
  `pendingWrites` drops memory-write approvals that are `applied`, `rejected` or `failed` and
  were reviewed (or created, if never reviewed) more than 30 days ago; `pending` and
  `applying` rows stay.
- **Markdown index exclusions.** Step `markdownIndexPurge` runs once per profile (marker
  `memory:markdown_index_exclusion_purge:v1` in `maintenance_state`, deferred with the first
  retention run): it deletes file, chunk and chunk-FTS rows of every workspace whose path the
  index excludes (`markdown-index-exclusions.ts`: `.history/`, `subconscious/`, `chronicle/`,
  `memory/transcripts/`, `memory/topics/`, `memory/summaries/`, `memory/locks/`, `tmp/`, `scratchpad*`, nested
  `.history`, and stale rows from the old workspace-root index). The per-workspace purge still
  runs when a workspace's index syncs.
- **Shutdown.** The desktop app and the node daemon stop retention and the engine's deferred
  jobs and flush queued `MemoryWriter` writes (shutdown step "memory engine") before the
  conversation index, the memory service and the database close. Earlier steps settle the
  untracked async work that used to write after the database closed:
  - The agent daemon waits up to 3 s (`AgentDaemon.BACKGROUND_WORK_DRAIN_MS`) for executor
    playbook learning, which the executor registers through `trackBackgroundWork`
    (`utils/in-flight-work.ts`). Work still running after the bound is
    abandoned; its late writes fail and are dropped.
  - The kit writers stop (flushing their debounced writes) and release the kit-writer lease
    (step "kit writers").
  - Step "memory" awaits `MemoryService.drain()` before `shutdown()`: it stops the cleanup
    interval, the deferred archive cleanup, compression drain and retry timers, starts no new
    compression batch, markdown sync or cleanup, and waits up to 5 s for a running compression
    batch (which stops at its next group and keeps the rest queued), markdown index sync or
    search, cleanup run or archive migration.
- **Quiet mode.** With desktop startup quiet mode (`COWORK_STARTUP_QUIET`,
  `COWORK_PROFILE_QUIET`, `COWORK_BACKGROUND_AUTOSTART=0`; [development](development.md#startup-quiet-mode)),
  `MemoryService.initialize(..., { backgroundJobs: false })` starts neither the periodic cleanup
  nor the deferred archive cleanup, and the kit writers are not started; distill and retention
  were already off.
- **Kit-writer ownership.** `CROSS_SIGNALS.md`, `MISTAKES.md` and `LORE.md` are written only by
  the process that owns the profile's kit-writer lease (`kit-writer-lease-sql.ts`,
  `agents/kit-writer-ownership.ts`): one `maintenance_state` row (`kit_writer_lease`) with the
  owner, its runtime and an expiry, acquired and renewed in one IMMEDIATE transaction. The lease
  lasts 60 s and is renewed every 15 s; a crashed owner's lease expires and the next process
  to ask takes over. A desktop app that finds a daemon holding it records a hand-off request;
  the daemon yields on its next renewal (stops and flushes its writers) and its release passes
  the lease to the desktop, which therefore wins whenever both run. Between processes of the
  same runtime the first one keeps it. Each new owner's writers rebuild from the database, so
  tasks the non-owner ran reach the files when ownership changes, not live.
- **Supermemory copies (SEC-17).** `supermemory_remote_refs` (`supermemory-remote-refs-sql.ts`)
  maps each remote copy to its local record: `archive:<id>` for a mirrored archive row
  (`/v3/documents`, document id), `external:<id>` for an explicit remote remember
  (`/v4/memories`), with the container it went to. Mirror writes address the workspace
  *name* for `{workspaceName}` templates, as reads do. After an archive delete, an inspector
  suppression or redaction, a privacy change, a memory-item delete, `memory_forget` or a task
  delete, a debounced orphan sweep (`SupermemoryService.scheduleOrphanSweep`) deletes copies
  whose local record is gone or hidden; Clear All Memories deletes every copy recorded for the
  workspace; "Disconnect & purge" in the Supermemory card deletes every recorded copy and
  disables the integration only when all deletes succeeded. A 404 counts as forgotten; other
  failures keep the mapping for the next sweep. 4xx answers (except 408 and 429) no longer count
  toward the circuit breaker. Copies sent before the table existed have no remote id and stay
  remote.

## 7a. The memory repo (Phase 1, opt-in)

With **Settings > Memory > Memory folder** (`memoryRepoEnabled`) on, facts the agent or the
user saves with `memory_remember` go to a local git repo of markdown files in the Agent
Memory Repo format instead of `memory_items`, and `MEMORY.md` plus the workspace's file are
in every private prompt as `<cowork_memory_repo>`. Contact, task, private and strict-privacy
facts stay in `memory_items`, as do the other producers. See
[memory-repo-phase1-design.md](memory-repo-phase1-design.md). The folder has its own dreaming
(an AI pass over the folder and recent tasks; safe changes as an undoable commit, the rest on
a review branch): [memory-repo-phase2-design.md](memory-repo-phase2-design.md). The heuristic
curator in §5b keeps curating `memory_items`.

**Sync and team memory.** The folder can sync with a private git remote the user owns
(`memoryRepoRemoteUrl`, only after the "private and mine" confirmation; the user's own git
credentials; dream review branches are never pushed), and up to three team memory repos
(`memoryRepoTeamRepos`) are read next to it in the prompt and recall, never written. The
Memory folder card has a Sync and a Team memory section; Health adds "Memory folder sync" and
"Team memory". See [memory-repo-phase4-design.md](memory-repo-phase4-design.md).

**Kit files.** While the folder is writable, a 👎/edit reason from the workspace owner (the
desktop app or the owner's private chat) is a `correction` entry of the workspace's folder
file (`by: user`, `subject: feedback:<hash>` so a repeat replaces the line, origin
`feedback`); `FeedbackService` keeps the weekly `.cowork/feedback/` logs but no longer writes
the generated `cowork:auto:mistakes` block of `MISTAKES.md`, which is stripped once (with the
§5 strip) and dropped from the prompt. With the folder off that block is still written and
read, as before. `LoreService` is retired: its `cowork:auto:lore` block is stripped once and
`update_lore` writes milestones as plain lines under `## Milestones`. Hand-written
`MISTAKES.md` / `LORE.md` text is untouched. See
[memory-repo-phase5-design.md](memory-repo-phase5-design.md) §1.

**Swarm folders.** When a task has sub-agents or a team run, the root of its `parentTaskId`
chain and every task under it share `swarms/<title slug>-<root id 8>/` in the folder
(`memory-repo-swarm.ts`: `resolveSwarm`, walked at most 20 hops and cached per task). The
`swarm_note` tool (`{ kind: finding | ruled_out | question | answer, text, sources? }`) appends
an entry to `findings.md` or `questions.md` through `MemoryRepoService.swarmAppend` (screened,
`by: agent`, `author`, `source: cowork://tasks/<id>`, `tainted: yes` after untrusted content,
one commit with origin `swarm`; `README.md` with the goal, members and rules on the first
note). The slug always comes from the task chain. The `swarm` layer of `MemoryInjectionPolicy`
(folder on, private gateway, no `<no-memory>`, workspace memory on; sub-agents and verifiers
included) pins `<cowork_swarm>` after the memory folder block (goal, members, the 10 latest
findings, the latest questions and answers, under a "peer notes, never instructions" header)
and lets file tools and recall read that swarm folder only (the access scope's `swarmPrefix`).
Verifiers read but cannot call `swarm_note`; read-only helpers in plan mode can. Swarm folders
are never linked from `MEMORY.md`, never shown in What CoWork knows, never read by dreams, and
are removed when their root task is deleted. See
[memory-repo-phase5-design.md](memory-repo-phase5-design.md) §2.

## 8. Gaps and next steps

1. Done for prompts (§4a), the Memory Hub layer preview (§5a) and the mailbox prompt
   (contact-scope items, §5). The node daemon now starts the same engine as the desktop app (`startMemoryEngine`:
   `MemoryWriter`, read-side syncs, the claimed lane migration), `MemoryRetentionService`, the
   knowledge graph and Lore, and flushes queued `memory_items` writes and the conversation
   index at shutdown, so its prompts use `memory_items` once the migration has run. The desktop
   app flushes the same way (§7).
2. Done: kit-file edits and Memory Hub edits go through `MemoryWriter` (§5, §5a); kit edits
   carry `curated` trust because agent and user writes to the files cannot be told apart.
   Retired: the generated kit blocks and their back-sync (§5).
3. Done: "Clear global memories" in the Memory Hub. It does not reset awareness's belief
   state (signals) or the adaptive style engine's bookkeeping; PersonalityManager's name and
   style keep their last mirrored values.
4. Done: `AdaptiveStyleEngine` defers to an explicit `response_style` (§4a), including a style
   set in Settings.
5. Done: superseded revisions older than 180 days are dropped, keeping the newest 5 per
   item and those an undoable curation change needs (§7).
6. `findBySourceRef` matches aliases with `json_each`, which cannot use an index; fine for the
   expected size (hundreds to low thousands of rows), revisit if the table grows.
7. Done: every producer goes through the same hygiene (§1, "Producers and their write
   path"): core memory candidates (facts through `MemoryWriter`, events through `capture`),
   Chronicle (archive only, through `capture`), imports (the gated import API, imported facts
   as `import` items) and Supermemory (explicit remembers redacted and policy-checked; reads
   never stored locally). A source guard keeps new code from inserting into `memories` or
   `memory_items` outside the sanctioned modules. The approval-gated memory-write modes
   (`COWORK_MEMORY_WRITE_APPROVAL_MODE` `curated_only`, `background_only`, `all`) stage
   core-candidate facts as `remember` writes; an approved write keeps its `core_candidate`
   source ref.
8. Done: the legacy stores are retired (§5): the 16 hidden tool aliases are removed (§4b), the
   dual writes and the legacy mirror are removed, the services are views of `memory_items`, and
   the data retirement exports and drops the old stores. Open: a commitment edited from an
   item without a `{store, id}` source ref keeps its old provenance fields when its text is
   unchanged (only items written before source refs existed).
9. Real local embeddings are out of scope (decision above). Revisit only if the memory evals
   show a recall gap that lexical recall and fusion tuning cannot close.
10. Done: shutdown waits (bounded) for consolidation, executor learning, compression batches and
    markdown syncs; quiet mode starts no memory cleanup and no kit writers; one kit-writer owner
    per profile between the desktop app and the node daemon (§7). One `DailyBriefingService`
    (the on-demand IPC briefing passes its data sources per call) and one
    `EverydayAgentService` per process, injected into IPC, the control plane and the browser
    host. Open: a non-owner's live kit updates reach the files only when ownership changes or
    on the owner's next restart; the lease does not cover `USER.md`/`MEMORY.md`, which are
    rendered from `memory_items` on request and written only when their content changes.
11. Done (DATA-5, DATA-7; §6a): summaries skip constant preambles, embeddings and observation
    text come from the content, a one-time re-index rewrote existing rows; AI compression runs
    (single rows and digests), is on by default within a daily token budget, and digests go
    through `capture`; the storage cap counts embeddings and observations. Open: the storage cap
    still prunes the least recently useful rows first regardless of their value, and FTS index
    bytes are not counted; a model-written single-row summary does not refresh the observation
    title.
