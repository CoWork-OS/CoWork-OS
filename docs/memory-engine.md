# Memory Engine — design and Phase 2 foundation

**Status.** Phase 2 foundation, 2026-10-03, with the Phase 3 additions noted inline. The write
side described here is implemented: the `memory_items` store, `MemoryWriter`, the one-time lane
migration, dual writes from the legacy stores, and purge/retention. On the read side,
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
| Episodic history: task outcomes, resolved errors, feedback, explicit `memory_save` notes | `memories` (the archive) + `memory_observation_metadata` + FTS | Unchanged in Phase 2. See §6. |
| Raw conversation | `task_events` + the conversation index | Owned by the conversation-index consolidation, not this engine. |
| Playbook entries, proactive suggestions | Their own tables (`playbook_entries`, `suggestions`) | Moved out of `memories` by a parallel Phase 2 change. |
| Legacy lanes: `curated_memory_entries`, SecureSettings `user-profile`, `relationship-memory`, `awareness-state` beliefs, `adaptive-style-engine` | Unchanged and still read by their consumers | Mirrored into `memory_items` (§5) until consumers switch. |

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
writer are serialized, so fire-and-forget dual writes land in call order.

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
     (`scope_ref = gateway:<channel>:<user id>`), and `memory_curate`, `set_user_name` and
     `set_response_style` are refused.
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

`memory-engine-contracts.ts` defines the interfaces; another wave implements them.

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
  Until the lane migration has run, or without a writer (CLI), L0 comes from the
  legacy stores through the same lane mappers.
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

**Read-side syncs (`memory-read-side.ts`)**, active once the lane migration has finished:

- PersonalityManager's user name follows the active `preferred_name` item: `set_user_name`
  (`user_stated`) wins over inferred names, and a newer statement supersedes. A deleted item
  clears the name. After the migration, the live PersonalityManager name is adopted once as
  `user_stated`, so the migration never reverts it.
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
  default), `knowledge` (KG `searchEntities`, the `.cowork` markdown index, existing topic
  packs, read-only), `external` (Supermemory; only when `policy.allowExternal` and configured).
- **One FTS builder.** The memory lane uses `database/fts-query.ts` (Unicode, prefix-aware,
  operator-safe: all terms, then any term), with a term-match fallback when FTS5 is missing.
  Any-term (OR) queries drop function words of a small English, German, Turkish, French and
  Spanish stopword list, unless the query has nothing else; all-terms (AND) queries keep every
  term. Without this, "when do we ship the postgres 16 migration" matched every row containing
  "the" or "we".
- **Knowledge graph.** `searchEntities` matches entity names and descriptions through FTS, and
  fills the remaining slots with entities whose observations contain the query's distinctive
  terms (observations are not in the FTS index); those hits carry the matching observations,
  so the recall hit shows them.
- **Visibility, once per lane.** Memory items: `active`, unexpired, global or this workspace,
  task scope only for the active task, contact scope only for `contactRef`; `private` only with
  `policy.includePrivate` (or the handled contact's own items); minimum trust `inferred` unless
  `minSource` says otherwise (so `third_party` is out by default). Archive: agent-visible rows of
  this workspace plus non-private imports. Conversations, KG, files: this workspace only; files
  through the caller's read guard and inside `.cowork/`.
- **Fusion.** Weighted reciprocal rank (k = 60): memory 1.0, archive 0.8, conversations 0.7,
  knowledge 0.6 (topic packs ×0.6), external 0.5; imported archive rows count half. Each
  contribution is scaled by term coverage: `0.4 + 0.6 × coverage`, where coverage is the share
  of the query's distinctive (non-stopword) terms in the hit's text, applied when the query
  has at least two such terms. Rank fusion alone let a one-word match in a strong lane outrank
  a full match in a weaker lane. Hits with the same normalized text are merged (strongest lane
  kept, all lane ranks recorded). `relevance` is the fused score relative to the best hit.
- **Hits** add `snippet`, `relevance`, `tokenEstimate`, `kind` and `provenance` to the contract
  type. `detail: "full"` adds `content` (≤ 4000 characters); `ids` expand lane-qualified refs
  (`memory:`, `archive:`, `event:`, `kg:`, `doc:<start>-<end>:<path>`, `topic:<file>`) with the
  same visibility rules. `query` has no side effects; `markUsed` sets `last_used_at` on items and
  records an archive reference — the tools call it only for results returned in full.
- **Failures.** `recall()` reports per-lane errors; `query()` throws when every lane failed, so
  a broken index is never mistaken for "nothing remembered" (RECALL-3).

Agent tools (`agent/tools/memory-tools.ts`, audit §8.3): `memory_recall`, `memory_remember`
(facts through `MemoryWriter` as `user_stated` only when the model sets `user_asked` and the
user's latest message asks to remember, else `inferred`; `outcome`/`error`/`note` to the
archive), `memory_forget` (Memory Hub delete path for items, own archive rows, Supermemory ids;
asks the user first through the permission engine as a `memory_delete` approval (classified as
a delete; the dialog is titled "Forget a memory" and shows the memory and its source; channel
approval messages leave the memory text out) — prompted in the default and dangerous-only
modes, allowed by bypass modes or a saved rule — except for
an item this task's agent inferred itself and that no other record merged into; Supermemory
ids keep the pipeline's `external_service` approval),
`context_recall` (active task). The 16 earlier tools are hidden aliases for one release
(`LEGACY_MEMORY_TOOL_ALIASES` in `shared/types.ts`). Routing guidance is one generated hint of
about 90 tokens naming only visible tools (`memory-tool-routing.ts`).

## 5. Legacy lanes

Mapping lives in `memory-items-lanes.ts` and is shared by the migration and the dual writes.

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

`MemoryItemsLaneMigration.ts`, scheduled by `memory-engine-bootstrap.ts` (`startMemoryEngine`,
called from `main.ts` and from the node daemon's `src/daemon/main.ts` after
`MemoryService.initialize`) **120 s after startup**, off the hot path.

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
- The legacy stores are not modified.

### Dual writes (this wave)

Legacy stores remain the system of record for reads; every write path also goes through
`MemoryWriter`. Synchronous services use `MemoryWriter.dualWrite` / `dualWriteStatus`
(fire-and-forget, serialized, failures logged, no-op before initialization).

| Write path | memory_items effect |
|---|---|
| `CuratedMemoryService.curate` add/replace, `upsertDistilledEntry` | `ingest` (awaited, before the kit files sync); replace is an edit of the same record → supersede |
| `CuratedMemoryService.curate` remove | active revision → `archived` |
| `UserProfileService.addFact` / `updateFact` | `ingest` (update = edit → supersede when the value changes) |
| `UserProfileService.deleteFact` | every revision → `deleted` |
| `RelationshipMemoryService` upsert (mailbox insights, task completion) / `updateItem` | `ingest`; done → `archived`; history not mirrored |
| `RelationshipMemoryService.deleteItem` | every revision → `deleted` |
| Awareness belief → profile bridge | through `UserProfileService.addFact(request, { memorySubjectKey, memoryOriginWorkspaceId })`, so `response_length`/`preferred_name` supersede and the belief's workspace settings apply |
| `AdaptiveStyleEngine.maybeAdapt` | `response_style`, `inferred` (outranked by a user-stated style) |
| `set_user_name` tool | `preferred_name`, `user_stated` |
| `set_response_style` tool | `response_style`, `user_stated` |
| Response style changed in Settings (personality save/import IPC, browser host) | `response_style`, `user_stated` (`withSettingsResponseStyleMirror`, only when the save changed the style) |

### Generated kit views

`CuratedMemoryService.syncWorkspaceFiles` renders the `USER.md` / `MEMORY.md` auto-blocks from
`memory_items` **once the lane migration marker exists** (before that, and without a writer, it
renders from `curated_memory_entries` as before):

- `USER.md` block: active, non-private workspace items of kind `identity`/`preference`, plus any
  item curated into the user lane (`source_ref.target = 'user'`).
- `MEMORY.md` block: every other active, non-private workspace item.
- Labels are memory kinds (`Rule`, `Decision`, …). Private items (strict privacy mode) are not
  rendered, because kit files are injected into prompts.

**Privacy.** `USER.md` and `MEMORY.md` live in the workspace (and may be committed with it), so
they only ever show non-private items: strict privacy mode makes new items `private`, and
private items, contact items and global items are never rendered into either file.

**Back-sync (PROMPT-12).** Hand edits inside the auto-blocks are no longer overwritten:

- Every sync records the rendered block per workspace and file (`maintenance_state`, key
  `kit_render_state:<workspaceId>:<user|workspace>`: body hash plus one `{ id, line }` per
  bullet). Clear All Memories drops these rows with the items.
- On the next sync, a block whose hash differs from the recorded one was edited. Its bullet
  lines (`- Label: text`, label optional) are compared with the rendered lines: unchanged
  lines are kept, a new line similar to a vanished one is an **edit** of that item (a new
  `curated` revision superseding it, with `editedVia: "kit_file"`; a changed label changes
  the kind), other new lines are **adds** (`curated`, `source_ref.store = "kit_file"`), and
  other vanished lines **archive** their item. Curated entries the items mirror are updated or
  archived too. Items the user stated or confirmed (`user_stated`, `user_confirmed`) are never
  edited or archived from the file; that has to happen in the Memory Hub.
- Only blocks rendered from `memory_items` are synced back. Without a recorded block (first
  sync, a file that arrived with a cloned repository) nothing is imported. A block that was
  deleted entirely is re-rendered, not read as "forget everything". Items that changed in the
  database since the render keep the database version.
- The block is then re-rendered from the database and the file is written only when its
  content changes, so a sync after a sync does nothing (no write loop). If the file's mtime
  changes between reading the edits and applying them, nothing is applied and the read is
  retried; a file that changes after edits were applied is left for the next sync.
- Back-sync runs on the next kit sync (a curated write, a Memory Hub change, Clear All
  Memories); there is no file watcher.
- An agent can write `.cowork/USER.md` like any workspace file, so kit edits cannot be
  attributed to the user: they carry `curated` trust (0.85) and never outrank or overwrite
  what the user stated.

## 5a. Memory Hub: "What CoWork knows"

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
  item and every older revision. Edits, pins and deletes are also applied to the legacy record
  the item mirrors (profile fact, relationship item, curated entry); workspace changes re-render
  the kit files.
- **Clear global memories** hard-deletes global items and their profile/relationship records;
  workspace items are cleared by Clear All Memories, whose per-store counts the Hub now shows.
- Items from other people (contact scope or `third_party`) are listed in a separate, collapsed
  "From other people" section.
- The fact editors in Personality > Memory and the Memory settings card were removed; both point
  to this tab.
- **Layer preview** (`MemorySynthesizer.buildLayerPreview`): what a private task in the
  workspace would receive, built like a plan step. `resolveMemoryInjection` decides the layers
  (private gateway, the workspace's memory settings, no external provider); L0 is the
  builder's pinned profile block and L1 the plan step's memory section (the builder's L1
  recall for the most recent task prompt, the kit slice, playbook and summaries). Before the
  lane migration both come from the legacy stores, as in a task.

## 5b. Dreaming: the curator of `memory_items` (Phase 3)

Audit §8.2 "Dreaming as the only curator". `DreamingService.ts` runs the curation;
`MemoryCurator.ts` holds the deterministic heuristics (pure); `memory-curation-llm.ts` the
optional LLM step; `memory-curation-sql.ts` / `memory-curation-units.ts` apply and undo
operations; `MemoryReviewService.ts` backs the Memory Hub Review tab.

**Inputs** (per workspace): active `global` and `workspace` items (contact and task items are
never curated), archive outcomes of the last 30 days (`decision`, `error`, `insight`
including `[CORRECTION]` rows, `preference`, `constraint`, `correction_rule`,
`workflow_pattern`; suppressed and redacted rows excluded), and conversation-index hits that
show an overdue commitment was done.

**Operations** (fixed set; `MEMORY_CURATION_OPS` in `shared/memory-review-types.ts`):

| Operation | Heuristic | Safe (auto-applied) when | Otherwise |
|---|---|---|---|
| `merge` | same scope and kind, derived subject, word-set Jaccard ≥ 0.75 (0.6–0.75 → review); keeps the strongest item (trust, pin, reinforcement, confidence, use, recency), supersedes the rest, folds their refs into `aliases` and their reinforcement into the keeper | all items have the same trust and none is `user_stated`/`user_confirmed` | review |
| `resolve_conflict` | same scope and kind, topic overlap ≥ 0.5 with opposite polarity (negation or an antonym pair); suggests the more trusted item, then the newer | never | always review |
| `promote` | archive outcomes of one kind that recur (Jaccard ≥ 0.5) in ≥ 2 distinct tasks and match no active item; corrections → `correction`, preferences → `preference`, constraints → `rule`, other outcomes → `project_fact`; written as `inferred` with `source_ref.aliases = archive:<id>` | kind is not `rule` and no evidence is private, imported or captured from the screen | review (accepting writes `user_confirmed`) |
| `decay` | unused (last use / update) for 60–180 days by kind, extended by reinforcement; trust ≤ 0.6; not pinned; never `identity` or `rule` | source is `inferred` | review (`import`) |
| `expire_commitment` | past `dueAt` with a done signal (archive or conversation), or ≥ 30 days overdue | done signal and not stated/confirmed by the user | review |

At most one operation per item per run; at most 25 automatic operations and 20 queued
proposals per run. Items the user stated or confirmed are never changed automatically: the
store refuses it (`protected`) unless the user accepted the change in the Review tab.

**Apply and undo.** Every applied operation goes through `MemoryWriter.applyCuration`
(serialized with other writes; a promotion runs the writer's salience, redaction and policy
steps) and is one transaction with its `memory_curation_log` row: op, item ids, created
ids, before/after snapshots, run id, origin (`auto` or `review`), `applied_at`,
`undone_at`. `MemoryWriter.undoCuration` restores the prior status, pin, reinforcement,
confidence and provenance, and tombstones items the operation created. Undo is refused when
an item changed since, or when reactivating would collide with an active item holding the
same content or subject. Undone and rejected changes are never applied or proposed again
(fingerprints). Log rows that quote an item are deleted when the item is really deleted
(forget, task purge, Clear All Memories, clear global); retention drops log rows after 90
days.

**LLM synthesis** (`dreamingLlmEnabled`, off by default; `dreamingLlmDailyTokenBudget`,
default 20 000 tokens per day across workspaces, counted from `dreaming_runs.llm_tokens`).
One call per run on the configured provider (cheap profile, usage telemetry
`memory_curation`). The model sees aliases (`i3`, `e7`), never ids or private items; its
answer must be strict JSON matching a zod schema, may only use `merge`,
`resolve_conflict`, `promote` (≥ 2 tasks) and `decay`, and may only reference aliases it was
given. Everything it proposes is queued for review.

**Triggers.** Heartbeat memory signals and hot-memory pressure (6 h workspace cooldown, as in
Phase 1), task completion when `backgroundConsolidationEnabled`, Box Brain imports, a manual
"Run Dreaming now" in the Review tab, and a once-daily idle pass: a pulse with no other
Dreaming trigger and no foreground task curates the next workspace with a task created in the last
14 days and no Dreaming run in the last 24 hours (the pulse's workspace first; one per
pulse; no timer of its own). Runs wait for the lane migration. `dreaming_runs` records
`applied_count`, `queued_count`, `llm_tokens`, `llm_calls` and per-operation `stats`.

**Review tab** (Memory Hub, `memoryReview:*` IPC, zod-validated in main,
`memory-review-ipc-validation.ts`; same methods in the browser host): pending proposals
with their items, why, why it needs review and evidence, with Accept / Reject; recent
changes with Undo; the AI synthesis switch and today's token use. The tab label shows the
pending count. A proposal whose items are gone or changed is dismissed instead of applied.

The pre-curator constant-text candidates are gone; open ones were closed as `dismissed`
by the schema setup (`memory-curation-log-sql.ts`).

## 6. The archive (`memories`) and its future

- **Now (Phase 2):** `memories` stays the episodic store: task outcomes, resolved errors,
  feedback, corrections as events, explicit `memory_save` notes, Chronicle and imports. It keeps
  its own capture salience gate, retention (`retention_days`), privacy states and FTS.
  `memory_items` is the semantic fact store. The two do not reference each other yet; a fact
  learned from an archived event should carry the archive row id in `source_ref` (`{ store:
  "archive", id }`) when a producer starts writing such facts.
- **Phase 3 (unification):** Dreaming promotes recurring archive outcomes into `memory_items`
  facts (`source: inferred`, `source_ref.aliases` listing the supporting archive rows), and
  `MemoryRecall` fuses both lanes. The archive then becomes the `outcome`/`decision` event lane
  of the same engine: either `memory_items` gains episodic kinds and the archive rows migrate in
  with `kind = outcome`, or the archive is kept as an evidence log behind the facts. That choice
  is deferred until recall telemetry shows how often episodic rows are recalled directly.

## 7. Purge and retention

- **Task delete** (`memory-purge-sql.ts` `purgeTaskDerivedRows`, inside `TaskStore.delete`'s
  transaction): task-scoped items are always deleted. With `purgeDerivedMemory`, items learned
  in the task with source `inferred`, `third_party` or `system` are deleted too. User-stated,
  confirmed and curated items survive with `task_id` cleared.
- **Clear All Memories** (`purgeWorkspaceMemoryRows`, `MemoryWorkspacePurgeService`): every item
  with the workspace's `workspace_id` (workspace, task and workspace-bound contact scopes);
  reported as `memoryItems`. Global items are not workspace-owned and are not cleared, matching
  the legacy profile stores. Deleting a workspace row cascades to its items (on connections with
  foreign keys on).
- **Retention** (`MemoryRetentionService`, step `memoryItems`, `MEMORY_ITEM_RETENTION_RULES`):
  daily, drops `deleted` tombstones and items whose `expires_at` has passed. Step
  `pendingWrites` drops memory-write approvals that are `applied`, `rejected` or `failed` and
  were reviewed (or created, if never reviewed) more than 30 days ago; `pending` and
  `applying` rows stay.
- **Markdown index exclusions.** Step `markdownIndexPurge` runs once per profile (marker
  `memory:markdown_index_exclusion_purge:v1` in `maintenance_state`, deferred with the first
  retention run): it deletes file, chunk and chunk-FTS rows of every workspace whose path the
  index excludes (`markdown-index-exclusions.ts`: `.history/`, `subconscious/`, `chronicle/`,
  `memory/transcripts/`, `memory/topics/`, `memory/locks/`, `tmp/`, `scratchpad*`, nested
  `.history`, and stale rows from the old workspace-root index). The per-workspace purge still
  runs when a workspace's index syncs.
- **Shutdown.** The desktop app and the node daemon stop retention and the engine's deferred
  jobs and flush queued `MemoryWriter` writes (shutdown step "memory engine") before the
  conversation index, the memory service and the database close.
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

## 8. Gaps and next steps

1. Done for prompts (§4a) and the Memory Hub layer preview (§5a). Open: the mailbox prompt
   (`RelationshipMemoryService.buildPromptContext`), then retire the legacy stores and their dual
   writes. The node daemon now starts the same engine as the desktop app (`startMemoryEngine`:
   `MemoryWriter`, read-side syncs, the claimed lane migration), `MemoryRetentionService`, the
   knowledge graph and Lore, and flushes queued `memory_items` writes and the conversation
   index at shutdown, so its prompts use `memory_items` once the migration has run. The desktop
   app flushes the same way (§7).
2. Done: kit-file edits and Memory Hub edits go through `MemoryWriter` (§5, §5a); kit edits
   carry `curated` trust because agent and user writes to the files cannot be told apart.
   Open: trigger back-sync without waiting for the next kit sync.
3. Done: "Clear global memories" in the Memory Hub. It does not reset the awareness beliefs,
   adaptive style or the personality user name that global items were copied from.
4. Done: `AdaptiveStyleEngine` defers to an explicit `response_style` (§4a), including a style
   set in Settings.
5. Superseded revisions are kept indefinitely; add an age-based retention rule once the Memory
   Hub shows history.
6. `findBySourceRef` matches aliases with `json_each`, which cannot use an index; fine for the
   expected size (hundreds to low thousands of rows), revisit if the table grows.
7. Producers not yet routed through `MemoryWriter`: the deprecated `memory_curate` alias
   (still the curated dual-write path), core memory candidates, Chronicle, imports,
   Supermemory. Agent fact writes go through `MemoryWriter` (`memory_remember`, §4b).
8. Retire the legacy stores and their dual writes (curated memory, user profile facts,
   relationship memory; §5 "Dual writes") after one release on `memory_items`, together with
   the 16 hidden tool aliases.
9. Real local embeddings are out of scope (decision above). Revisit only if the memory evals
   show a recall gap that lexical recall and fusion tuning cannot close.
