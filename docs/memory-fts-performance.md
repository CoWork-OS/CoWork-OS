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

| Component | General `search()` | Fast prompt recall |
|-----------|--------------------|--------------------|
| Imported-global FTS | 2 queries (raw + relaxed) | Skipped entirely |
| Hybrid semantic scoring | Embedding + cosine similarity | Skipped (BM25 only) |
| Double `getFullDetails` | 2 round-trips | 0 (content carried inline) |
| Tier tracking (`recordReference`) | N sync UPDATEs per search | Skipped (automatic recall shouldn't inflate counts) |
| Relaxed FTS token cap | 8 tokens | 5 tokens |
| Result limit | 10–20 | 5 |

### New Repository Method

`MemoryRepository.searchLocalForPromptRecall()` in `src/electron/database/repositories.ts`:

- Local-only BM25 search (no imported-global scan)
- Returns `content` alongside snippets so callers filter suppressions without a second `getFullDetails` call
- Uses `PROMPT_RECALL_FTS_MAX_TOKENS = 5` for the relaxed FTS query
- Labels queries as `prompt-recall-raw` / `prompt-recall-relaxed` for instrumentation

### LRU Cache

`MemoryService.searchForPromptRecallFast()` caches results per `{workspaceId, prompt[:500]}`:

| Parameter | Value |
|-----------|-------|
| Max entries | 32 |
| TTL | 5 minutes |
| Cache key | `${workspaceId}:${query.slice(0, 500)}` |

Cache hits return immediately with zero DB work. The cache is cleared via `MemoryService.clearPromptRecallCache()`.

### Callers Updated

| File | Call site | Before | After |
|------|-----------|--------|-------|
| `src/electron/memory/MemorySynthesizer.ts` | `extractArchiveFragments()` | `searchForPromptRecall()` | `searchForPromptRecallFast()` |
| `src/electron/memory/MemoryService.ts` | `getContextForInjection()` | `searchForPromptRecall()` | `searchForPromptRecallFast()` |
| `src/electron/agent/executor.ts` | Inline memory context builder | `searchForPromptRecall()` | `searchForPromptRecallFast()` |

---

## Fix 2: Batched Tier Tracking

`MemoryTierService.recordReferenceBatch()` replaces the per-result `recordReference()` loop in `MemoryService.search()`.

**Before**: N individual `UPDATE memories SET reference_count = reference_count + 1 WHERE id = ?` calls.

**After**: Single `UPDATE memories SET reference_count = reference_count + 1 WHERE id IN (?, ?, ...)`.

**File**: `src/electron/memory/MemoryTierService.ts`

The fast prompt-recall path skips tier tracking entirely since automatic recall shouldn't inflate reference counts.

---

## Fix 3: Background Marker-Based Lookups

Background services (Subconscious loop, ProactiveSuggestionsService, EvolutionMetricsService, PlaybookSkillPromoter) search for known content markers like `[SUGGESTION]`, `[PLAYBOOK] Task succeeded`, `[suggestion-feedback:acted_on]`. These are structural lookups, not natural-language search — FTS tokenization is counterproductive (strips brackets, splits tokens) and slow.

`MemoryRepository.searchByContentMarker()` and `MemoryService.searchByContentMarker()` use a direct `LIKE` query instead of FTS — no tokenization, no BM25 scoring, no imported-global scan, no tier tracking.

### Callers Migrated

| File | Method | Marker | Limit |
|------|--------|--------|-------|
| `ProactiveSuggestionsService.ts` | `loadAll()` | `[SUGGESTION]` | 50 |
| `ProactiveSuggestionsService.ts` | `actOn()` | `[SUGGESTION]` | 50 |
| `ProactiveSuggestionsService.ts` | `detectRecurringPatterns()` | `[PLAYBOOK] Task succeeded` | 50 |
| `ProactiveSuggestionsService.ts` | `findSuggestionById()` | `[SUGGESTION]` | 50 |
| `SubconsciousLoopService.ts` | `countAcceptedSuggestionPatterns()` | `[suggestion-feedback:acted_on]` | 20 |
| `EvolutionMetricsService.ts` | `computeCorrectionRate()` | `[PLAYBOOK] Task failed` | 100 |
| `EvolutionMetricsService.ts` | `computeTaskSuccessRate()` | `[PLAYBOOK] Task` | 100 |
| `PlaybookSkillPromoter.ts` | `findCandidates()` | `[PLAYBOOK] Reinforced pattern` | 100 |

---

## Fix 4: Composite Index

Added `idx_memories_workspace_recent` on `memories(workspace_id, created_at DESC)` in `src/electron/database/schema.ts`.

This covers the `getRecentForWorkspace()` query which previously relied on separate single-column indexes for `workspace_id` and `created_at`.

### All Memory Indexes

| Index | Columns |
|-------|---------|
| `idx_memories_workspace` | `(workspace_id)` |
| `idx_memories_task` | `(task_id)` |
| `idx_memories_type` | `(type)` |
| `idx_memories_created` | `(created_at)` |
| `idx_memories_compressed` | `(is_compressed)` |
| `idx_memories_tier` | `(workspace_id, tier, reference_count DESC)` |
| **`idx_memories_workspace_recent`** | **`(workspace_id, created_at DESC)`** ← new |

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

| File | Changes |
|------|---------|
| `src/electron/database/repositories.ts` | Added `searchLocalForPromptRecall()`, `searchByContentMarker()`, `PROMPT_RECALL_FTS_MAX_TOKENS`, enhanced `runMemoryFtsQuery()` instrumentation, parameterized `buildRelaxedFtsQuery()` max tokens |
| `src/electron/database/schema.ts` | Added `idx_memories_workspace_recent` composite index |
| `src/electron/memory/MemoryService.ts` | Added `searchForPromptRecallFast()` with LRU cache, `searchByContentMarker()`, `clearPromptRecallCache()`, switched `search()` to batched `recordReferenceBatch` |
| `src/electron/memory/MemoryTierService.ts` | Added `recordReferenceBatch()` |
| `src/electron/memory/MemorySynthesizer.ts` | Switched to `searchForPromptRecallFast()` |
| `src/electron/agent/executor.ts` | Switched to `searchForPromptRecallFast()` |
| `src/electron/agent/ProactiveSuggestionsService.ts` | Switched to `searchByContentMarker()` |
| `src/electron/subconscious/SubconsciousLoopService.ts` | Switched to `searchByContentMarker()` |
| `src/electron/memory/EvolutionMetricsService.ts` | Switched to `searchByContentMarker()` |
| `src/electron/memory/PlaybookSkillPromoter.ts` | Switched to `searchByContentMarker()` |

## Future Work

- **Worker-backed search (PR 2)**: Move FTS off the main thread entirely using a `worker_threads` read-only SQLite connection behind a `workerSearchEnabled` feature flag, with short timeouts for prompt recall.
- **FTS table partitioning**: Split prompt-recall-eligible memory from archival/imported memory into a smaller recall-specific FTS table (deferred — skipping imported-global achieves most of the benefit without a schema migration).
