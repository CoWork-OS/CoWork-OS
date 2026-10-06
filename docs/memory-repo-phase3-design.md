# Memory Repo — Phase 3 design: the memory folder becomes the store of facts

**Status.** Implemented in this change (2026-10-05). Builds on
[Phase 1](memory-repo-phase1-design.md) (the folder) and [Phase 2](memory-repo-phase2-design.md)
(dreaming over it).

**Decisions (user, 2026-10-05).**
1. The memory folder is on for everyone, new and existing installs.
2. The CoWork-generated sections in workspace `.cowork/USER.md` and `.cowork/MEMORY.md` are
   removed once and no longer generated or synced back.
3. The old automatic fact pipelines (core-memory distiller facts, awareness beliefs as facts)
   are retired; Dreaming over sessions replaces them.
4. `LORE.md`, `MISTAKES.md` and `CROSS_SIGNALS.md` stay as they are (a later change).

## 1. Where facts live after Phase 3

| Knowledge | Store |
|---|---|
| Facts about the user, workspace facts, lessons | **Memory folder** (`me.md`, `MEMORY.md`, `workspaces/*.md`, `lessons.md`, topic files) |
| Preferred name, response style | **PersonalityManager** settings (the source of truth), mirrored into `me.md` as `subject:` entries when the user states them |
| Commitments (open loops with due dates) | `memory_items`, kind `commitment` (operational data: briefing, autonomy, reminders) |
| What other people said (mailbox, channel senders) | `memory_items`, scope `contact` (private, third-party) |
| Task-scoped working facts | `memory_items`, scope `task` |
| Episodic history, conversations | archive, conversation index (unchanged) |

`memory_items` rows of scope `global`/`workspace` with any kind other than `commitment` are no
longer written, and existing ones are retired (§3).

## 2. Default on

- `memoryRepoEnabled` defaults to `true`. A one-time settings migration
  (`memoryRepoDefaultOnApplied`) turns it on for existing installs, whatever the stored value
  (during Phases 1–2 a stored `false` was usually the saved default, not a choice). After the
  migration, turning it off in the Memory folder card is respected.
- With the folder off (by choice) or unavailable (not a memory repo, read-only), writes fall
  back to `memory_items` as before, so nothing is lost; prompts keep reading both.

## 3. Retiring the old rows

After the export to the current folder has run (Phase 1 marker `.git/cowork-export-v1`), a
one-time job (`MemoryItemsFactRetirement`, marker `.git/cowork-fact-retirement-v1` in the
folder, a lock in `.git` against concurrent runs) takes the active global/workspace rows of
any kind but `commitment` that are neither private nor third-party, writes the ones whose
normalized text is in a folder file to an encrypted backup
(`<userData>/backups/memory-items-facts-*.json.enc`) and deletes them (tombstones). Rows the
folder does not hold (the export skipped them, or the text was cut) stay. The export no longer
copies commitments. Private (strict privacy) rows stay in `memory_items`.

## 4. Producers

| Producer | Before | After |
|---|---|---|
| `memory_remember` facts | folder (if on) else `memory_items` | folder; commitments → `memory_items`; fallback unchanged |
| Memory Hub add/edit/delete/pin | `memory_items` | folder (`me.md` / workspace file / `MEMORY.md` for pinned) |
| Onboarding profile facts | `UserProfileService.addFact` → `memory_items` | folder `me.md`, `by: user`, tagged `origin: onboarding` |
| `set_user_name` | PersonalityManager + `preferred_name` item | PersonalityManager + `me.md` `[subject: preferred_name]` |
| `set_response_style`, Settings style | PersonalityManager + `response_style` item | PersonalityManager + `responseStyleExplicit` flag |
| AdaptiveStyleEngine | `response_style` item (inferred) | PersonalityManager directly; never while `responseStyleExplicit` |
| Awareness beliefs | `memory_items` facts | signals only (no facts) |
| Core-memory distiller | facts → `memory_items`, events → archive | events → archive only |
| ChatGPT import facts | `import` items | folder `me.md`, `by: agent`, `source: import` |
| Observation "promote to memory" | curated item | folder workspace file, `by: user` |
| Kit back-sync | `curated` items | retired |
| Mailbox, channel senders | contact items | unchanged |

## 5. Readers

- `UserProfileService.getProfile()` becomes a read model over the folder (`me.md` and the entries
  of `MEMORY.md`), refreshed on every folder change: facts with their `kind` as category
  (`identity`, `preference`, `rule` → constraint, `insight`), plus the PersonalityManager name.
  Its consumers (AutonomyEngine goals, proactive suggestions, renderer welcome text,
  onboarding) keep their shape.
- The memory read side no longer mirrors name and style from `memory_items`.
- Memory Hub **What CoWork knows** shows the memory folder (files and entries, with edit,
  delete, pin = move to `MEMORY.md`, open file), and keeps the commitments and "From other
  people" sections from `memory_items`.

## 6. Retired

- **Generated kit blocks**: rendering, back-sync, `KitFileWatcher`, render state. A one-time,
  per-workspace strip runs when a task plans in that workspace (content-idempotent; access
  profile and symlink guards; a `.history` snapshot of each changed file). The prompt-side strip
  of the markers stays as a defense.
- **Heuristic curator** (`DreamingService`, `MemoryCurator` except commitments,
  `memory-curation-llm`, the candidates queue, "Run Dreaming now", the Dreaming LLM settings and
  their health checks). Commitment expiry stays as a small `CommitmentExpiryService` on the
  Heartbeat daily pass (auto-applies safe expiries; the curation log keeps undo). The Review tab
  keeps the memory folder's dreams.
- **Topic packs and daily summaries** (`LayeredMemoryIndexService`, `DailyLogSummarizer`,
  `MemoryConsolidator`, the `memory_topics`/`memory_index` prompt sections, the recall `topic:`
  lane, the `daily_summary` prompt fragments) and their settings `layeredMemoryEnabled`,
  `topicMemoryEnabled`, `backgroundConsolidationEnabled`. Purge steps for leftover files stay
  for one release; the markdown index keeps excluding them.

## 7. Not changed

`LORE.md`, `MISTAKES.md`, `CROSS_SIGNALS.md`; the archive; the conversation index; Chronicle;
Supermemory; the knowledge graph; mailbox and channel memory; the memory folder's dreaming.
