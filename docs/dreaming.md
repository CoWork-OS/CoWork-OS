# Dreaming

Dreaming in CoWork OS is the periodic AI pass over the **memory folder**: it reads the folder
and recent task conversations, applies safe edits as one undoable commit and puts the rest on a
branch you accept or reject as a diff in the Memory Hub **Review** tab. The design, triggers,
budget and settings are in [Memory Repo Phase 2](memory-repo-phase2-design.md).

## Lessons from execution

Dreaming can propose a workspace lesson from a runtime verification check recorded after
successful task completion. It keeps the observed check separate from the inferred lesson:
for example, a test command exiting successfully can suggest a useful check for a similar
future task. It does not establish that every step worked or that the lesson always applies.

These lessons always appear in **Review** before they enter memory. They cite the task,
completion event and evidence snapshot, and stay in that task's workspace. Execution evidence
cannot supply personal facts or preferences through this path. User-quoted additions keep
their existing behavior.

Only explicit successful shell, file-existence and HTTP checks qualify. Assistant claims,
ordinary tool acknowledgments, unverified or partial completions, and tasks without a runtime
receipt do not. Earlier tasks are not retroactively treated as verified. Receipt text is
bounded and screened; raw tool output is not sent to dreaming. Automatic capture must be on
with normal workspace privacy, and the usual owner/task and `<no-memory>` exclusions apply.
Evidence quotes must preserve a complete check line of at most 160 characters, including
its target and qualifications. Longer checks and tasks that fill the 80-event source window
cannot supply lessons in this version.

The task, receipt and privacy policy are checked again before staging and accepting a lesson.
A follow-up, changed/deleted receipt, missing task, reassigned workspace file or disabled capture makes the proposal
unavailable or stale. These are historical observations: acceptance does not rerun commands
or promise that a file, URL or external service still has the same state. Dreaming cannot
rewrite, merge or move an execution lesson while retaining its old evidence; a replacement
needs fresh evidence and review.

## Source changes

A memory folder entry saved from a workspace file or a connector record is flagged when that
source changes ([memory-engine.md §5c](memory-engine.md#5c-source-tied-memories)). A dream
handles up to 10 flagged entries, most recently changed first:

- a pending flag counts as something new, so the daily dream runs even with no new tasks;
- the files holding flagged entries go first; any sources omitted by the size caps stay flagged;
- each flagged line is marked "(source changed)", and a `<source_changes>` section gives its
  source, the day it changed and the current text (the first 1,500 characters of a file; a
  connector record has no copy, only the note that it changed; 12,000 characters in all). The
  model proposes an update/removal or leaves the entry unchanged, and gives each source a
  `confirmed`, `contradicted`, or `insufficient_evidence` verdict;
- a warning clears only for an unchanged entry explicitly confirmed with supporting words
  quoted from the supplied source excerpt. The file must still match the snapshot the dream
  read, with no newer source-change notification. Merely seeing the entry is not confirmation;
- unavailable sources, missing verdicts, and proposed corrections (including pending or
  rejected edits) keep the warning. Connector content is not fetched during dreaming, so
  those warnings remain until the memory is explicitly saved again from its source;
- when a memory has several changed sources, confirming one does not clear the others.
  A link whose entry no longer exists is dropped on the next dream.

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
