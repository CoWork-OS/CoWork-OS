# Dreaming

Dreaming in CoWork OS is the periodic AI pass over the **memory folder**: it reads the folder
and recent task conversations, applies safe edits as one undoable commit and puts the rest on a
branch you accept or reject as a diff in the Memory Hub **Review** tab. The design, triggers,
budget and settings are in [Memory Repo Phase 2](memory-repo-phase2-design.md).

## Source changes

A memory folder entry saved from a workspace file or a connector record is flagged when that
source changes ([memory-engine.md §5c](memory-engine.md#5c-source-tied-memories)). A dream
handles up to 10 flagged entries, most recently changed first:

- a pending flag counts as something new, so the daily dream runs even with no new tasks;
- the files holding flagged entries go first, so the folder size cap never leaves them out;
- each flagged line is marked "(source changed)", and a `<source_changes>` section gives its
  source, the day it changed and the current text (the first 1,500 characters of a file; a
  connector record has no copy, only the note that it changed; 12,000 characters in all). The
  model updates the entry, removes it, or leaves it when the source still supports it;
- after the dream, the entries it was shown are marked reviewed against the source's current
  content. A link whose entry no longer exists is dropped.

## What it replaced

Earlier versions had a heuristic curator, also called Dreaming, that merged, promoted, decayed
and expired rows of `memory_items` and queued proposals for review. Phase 3
([design §6](memory-repo-phase3-design.md#6-retired)) retired it, because global and workspace
facts now live in the memory folder:

- the curator (`DreamingService`, `MemoryCurator`, the optional LLM synthesis step), its
  proposal queue and the "Run Dreaming now" button are gone;
- the settings `dreamingLlmEnabled` and `dreamingLlmDailyTokenBudget` and the Dreaming health
  checks are gone (the "Memory folder dreaming" health row stays);
- task completion and Box Brain imports no longer start a curation run;
- the `dreaming_runs` and `dreaming_candidates` tables stay for history and are pruned by
  retention; open proposals were closed as `dismissed`.

## Commitment expiry

Commitments (open loops with due dates) still live in `memory_items`. The Heartbeat pulse runs
a commitment sweep once a day (`CommitmentExpiryService`): a commitment at least a day past due
is closed when later activity (task outcomes or the conversation index) says it was done.
Commitments you made yourself are never closed automatically, and nothing is queued for review.
Each expiry is logged and can be undone under **Closed commitments** in the Review tab; an
undone expiry is never applied again. See
[memory-engine.md §5b](memory-engine.md#5b-commitment-expiry-phase-3).
