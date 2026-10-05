# Memory FTS Performance

This document covers the SQLite full-text search (FTS) performance optimizations applied to the memory system to eliminate synchronous main-thread blocking during agent task execution.

## Problem Statement

During agent task execution, the memory prompt-recall path ran synchronous SQLite FTS5 queries on the Electron main process, causing observable CPU spikes and UI responsiveness issues:

```
2026-05-20T09:14:40.947Z slow FTS: label=local-relaxed elapsedMs=1548 queryChars=12
2026-05-20T09:16:05.662Z slow FTS: label=local-raw elapsedMs=308 queryChars=51
2026-05-20T09:16:06.151Z slow FTS: label=local-relaxed elapsedMs=273 queryChars=86
```

The 1548ms spike aligned with Electron main CPU hitting 98.5%. The entire memory search call chain — FTS queries, hybrid semantic scoring, full-detail loading, tier tracking — executed synchronously on the main thread during every task step.

### Blocking Call Chain (Before)

```
executor.ts  MemorySynthesizer.synthesize()           [sync, NOT awaited]
  └─ extractArchiveFragments()                         [sync]
       ├─ getRecentForPromptRecall()                   [sync DB]
       └─ searchForPromptRecall()                      [sync]
            └─ search()                                [sync]
                 └─ searchInternal()                   [sync]
                      ├─ memoryRepo.search()           [2x sync FTS: raw + relaxed]
                      ├─ searchImportedGlobal()        [2x sync FTS: raw + relaxed]
                      ├─ getFullDetails()              [sync N-row SELECT for hybrid scoring]
                      ├─ createLocalEmbedding()        [CPU-bound embedding]
                      └─ recordReference() × N         [N sync UPDATEs]
                 └─ getFullDetails()                   [SECOND N-row SELECT for suppression]
```

**Worst case per step**: 4 FTS queries + 2× full-detail loads + N tier UPDATEs + embedding computation = 500–2000ms blocking.

---

## Fix 1: Fast Prompt-Recall Search Path

A dedicated `searchForPromptRecallFast()` method replaces the general-purpose `search()` for all prompt-construction callers.

### What It Skips

| Component                         | General `search()`            | Fast prompt recall                                  |
| --------------------------------- | ----------------------------- | --------------------------------------------------- |
| Imported-global FTS               | 2 queries (raw + relaxed)     | Skipped entirely                                    |
| Hybrid semantic scoring           | Embedding + cosine similarity | Skipped (BM25 only)                                 |
| Double `getFullDetails`           | 2 round-trips                 | 0 (content carried inline)                          |
| Tier tracking (`recordReference`) | N sync UPDATEs per search     | Skipped (automatic recall shouldn't inflate counts) |
| Relaxed FTS token cap             | 8 tokens                      | 5 tokens                                            |
| Result limit                      | 10–20                         | 5                                                   |

### New Repository Method

`MemoryRepository.searchLocalForPromptRecall()` in `src/electron/database/repositories.ts`:

- Local-only BM25 search (no imported-global scan)
- Returns `content` alongside snippets so callers filter suppressions without a second `getFullDetails` call
- Uses `PROMPT_RECALL_FTS_MAX_TOKENS = 5` for the relaxed FTS query
- Labels queries as `prompt-recall-raw` / `prompt-recall-relaxed` for instrumentation

### LRU Cache

`MemoryService.searchForPromptRecallFast()` caches results per `{workspaceId, prompt[:500]}`:

| Parameter   | Value                                   |
| ----------- | --------------------------------------- |
| Max entries | 32                                      |
| TTL         | 5 minutes                               |
| Cache key   | `${workspaceId}:${query.slice(0, 500)}` |

Cache hits return immediately with zero DB work. The cache is cleared via `MemoryService.clearPromptRecallCache()`.

### Callers Updated

| File                                       | Call site                     | Before                    | After                         |
| ------------------------------------------ | ----------------------------- | ------------------------- | ----------------------------- |
| `src/electron/memory/MemorySynthesizer.ts` | `extractArchiveFragments()`   | `searchForPromptRecall()` | `searchForPromptRecallFast()` |
| `src/electron/memory/MemoryService.ts`     | `getContextForInjection()`    | `searchForPromptRecall()` | `searchForPromptRecallFast()` |
| `src/electron/agent/executor.ts`           | Inline memory context builder | `searchForPromptRecall()` | `searchForPromptRecallFast()` |

---

## Fix 2: Batched Tier Tracking

`MemoryTierService.recordReferenceBatch()` replaces the per-result `recordReference()` loop in `MemoryService.search()`.

**Before**: N individual `UPDATE memories SET reference_count = reference_count + 1 WHERE id = ?` calls.

**After**: Single `UPDATE memories SET reference_count = reference_count + 1 WHERE id IN (?, ?, ...)`.

**File**: `src/electron/memory/MemoryTierService.ts`

The fast prompt-recall path skips tier tracking entirely since automatic recall shouldn't inflate reference counts.

---

## Fix 3: Background Marker-Based Lookups

Background services search the archive for known content markers (for example the daemon's `[CORRECTION]` rows that `EvolutionMetricsService.computeCorrectionRate()` counts). These are structural lookups, not natural-language search — FTS tokenization is counterproductive (strips brackets, splits tokens) and slow.

`MemoryRepository.searchByContentMarker()` and `MemoryService.searchByContentMarker()` use a direct `LIKE` query instead of FTS — no tokenization, no BM25 scoring, no imported-global scan, no tier tracking.

Suggestions, suggestion feedback and Playbook outcomes used to be `[SUGGESTION]`, `[suggestion-feedback:…]` and `[PLAYBOOK] …` archive rows found this way. They now live in their own tables (`suggestions`, `suggestion_feedback`, `playbook_entries`) and are read through `ProactiveSuggestionStore` and `PlaybookService`; a one-time migration (`memory/memory-payload-migration-sql.ts`) moved existing rows out of `memories`.

---

## Fix 4: Composite Index

Added `idx_memories_workspace_recent` on `memories(workspace_id, created_at DESC)` in `src/electron/database/schema.ts`.

This covers the `getRecentForWorkspace()` query which previously relied on separate single-column indexes for `workspace_id` and `created_at`.

### All Memory Indexes

| Index                               | Columns                                      |
| ----------------------------------- | -------------------------------------------- |
| `idx_memories_workspace`            | `(workspace_id)`                             |
| `idx_memories_task`                 | `(task_id)`                                  |
| `idx_memories_type`                 | `(type)`                                     |
| `idx_memories_created`              | `(created_at)`                               |
| `idx_memories_compressed`           | `(is_compressed)`                            |
| `idx_memories_tier`                 | `(workspace_id, tier, reference_count DESC)` |
| **`idx_memories_workspace_recent`** | **`(workspace_id, created_at DESC)`** ← new  |

---

## Fix 5: Enhanced FTS Instrumentation

`MemoryRepository.runMemoryFtsQuery()` now logs richer context on slow queries (≥250ms):

**Before**:

```
Slow memory FTS query label=local-relaxed elapsedMs=1548 queryChars=12
```

**After**:

```
Slow memory FTS query label=local-relaxed elapsedMs=1548 queryChars=12 tokens=2 rows=50 limit=50 workspace=ws_abc123
```

New fields: `tokens` (tokenized query term count), `rows` (result count), `limit` (requested limit), `workspace` (workspace ID or "global" for imported search).

FTS query labels now distinguish prompt-recall queries (`prompt-recall-raw`, `prompt-recall-relaxed`) from general search (`local-raw`, `local-relaxed`) and imported search (`imported-raw`, `imported-relaxed`).

---

## Validation Results

After applying fixes, re-running the same "what new in gemini based on google IO announcements" task:

- No slow FTS logs during the active task execution path
- No main-process CPU spike aligned with memory search
- Task still received useful memory context
- One remaining slow FTS from a background Subconscious run was resolved by Fix 3 (marker-based lookup migration)

---

## Files Modified

| File                                                   | Changes                                                                                                                                                                                            |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/electron/database/repositories.ts`                | Added `searchLocalForPromptRecall()`, `searchByContentMarker()`, `PROMPT_RECALL_FTS_MAX_TOKENS`, enhanced `runMemoryFtsQuery()` instrumentation, parameterized `buildRelaxedFtsQuery()` max tokens |
| `src/electron/database/schema.ts`                      | Added `idx_memories_workspace_recent` composite index                                                                                                                                              |
| `src/electron/memory/MemoryService.ts`                 | Added `searchForPromptRecallFast()` with LRU cache, `searchByContentMarker()`, `clearPromptRecallCache()`, switched `search()` to batched `recordReferenceBatch`                                   |
| `src/electron/memory/MemoryTierService.ts`             | Added `recordReferenceBatch()`                                                                                                                                                                     |
| `src/electron/memory/MemorySynthesizer.ts`             | Switched to `searchForPromptRecallFast()`                                                                                                                                                          |
| `src/electron/agent/executor.ts`                       | Switched to `searchForPromptRecallFast()`                                                                                                                                                          |
| `src/electron/agent/ProactiveSuggestionsService.ts`    | Switched to `searchByContentMarker()`                                                                                                                                                              |
| `src/electron/subconscious/SubconsciousLoopService.ts` | Switched to `searchByContentMarker()`                                                                                                                                                              |
| `src/electron/memory/EvolutionMetricsService.ts`       | Switched to `searchByContentMarker()`                                                                                                                                                              |
| `src/electron/memory/PlaybookSkillPromoter.ts`         | Switched to `searchByContentMarker()`                                                                                                                                                              |

## Worker-Backed Search

FTS now runs off the main thread. Lexical recall and marker lookups run in the memory FTS worker (a read-only `worker_threads` connection started in the desktop app, the daemon and the CLI). The host only ranks the results with the semantic stage.

- **No host fallback:** if the worker fails, `searchAsync` returns semantic-only results instead of rerunning FTS on the host. A failed marker lookup rejects.
- **Writes in the worker:** memory capture and embedding writes run in the database write worker (the `memory` domain). Each write reports the ids it wrote to the FTS worker's embedding cache.
- **Summary re-index in the worker:** the one-time `memory_summary_reindex_v1` job (DATA-5) recomputes summaries, embeddings and observation text in chunks of 100 rows, each one write-worker unit with a 50 ms pause between chunks, and invalidates the changed ids in the FTS worker's cache ([Memory Engine §6a](memory-engine.md#6a-archive-capture-summaries-and-compression)).
- **Measurements:** in the heavy-profile read benchmark (`npm run qa:db:reads`), the longest host stall around a hybrid search fell from 69 ms to 6 ms. See the [async SQLite baseline](async-sqlite-db0-baseline-2026-09-27.md).

## Future Work

- **FTS table partitioning**: Split prompt-recall-eligible memory from archival/imported memory into a smaller recall-specific FTS table (deferred — skipping imported-global achieves most of the benefit without a schema migration).
