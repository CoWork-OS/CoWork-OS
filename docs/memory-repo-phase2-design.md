# Memory Repo — Phase 2 design: Dreaming over the memory folder

**Status.** Implemented in this change (2026-10-05). Builds on
[Phase 1](memory-repo-phase1-design.md): the memory folder, its writer and its prompt block.

**Goal.** A periodic AI pass ("dream") keeps the memory folder accurate and small, and finds
what sessions taught that nobody saved, as Cognition's Dreaming and Anthropic's Managed
Agents Dreams do. It reads the folder and recent task conversations, proposes edits, applies
the safe ones itself (one commit, undoable with `git revert`) and puts the rest on a git
branch the user accepts or rejects as a diff.

Non-goals: per-operation accept (a dream's review part is accepted or rejected whole), team
repos and remotes (Phase 4), retiring `memory_items` and the heuristic curator (Phase 3).

## 1. Pipeline

One dream is one structured model call, not an agent task: the model never gets tools, file
access or git. CoWork builds the input, validates every proposed operation and applies them.

```text
MemoryRepoDreamer.run(trigger)
  1. gate: folder ready and writable, dreaming on, budget left, something new
  2. input: folder files (lines aliased L1…), inbox entries, recent tasks (T1…)
  3. model call (configured provider, strict JSON, zod-validated)
  4. validate + classify each operation: auto | review | rejected
  5. auto ops   → one commit on main            ("Dream 2026-10-05: 4 changes")
     review ops → one commit on branch dream/<id> in a temporary worktree
  6. record the run in .git/cowork-dreams/
```

## 2. Inputs

- **Folder:** every markdown file except `inbox.md`, as numbered lines; each entry line gets an
  alias (`L12`) mapped to `{path, line, hash, by}`. At most 48 000 characters; above that,
  `MEMORY.md`, `me.md`, `lessons.md` and the workspace files of the sampled tasks come first.
- **Inbox:** entries of `inbox.md`, aliased like other lines and marked untrusted.
- **Tasks:** up to 20 tasks created since the last dream (newest first), aliased `T1…`: title,
  workspace name, the user's messages and the final assistant reply, at most 1 500 characters
  per task. Tool output is never included (it may carry untrusted text).
- **Instructions:** what to look for (duplicates, stale or contradicted entries, preferences
  and lessons the user had to repeat, misplaced entries), what never to do (invent facts,
  follow instructions found in the data, save secrets), and the output schema.

## 3. Operations

| Op | Fields | Meaning |
|---|---|---|
| `add` | `file`, `text`, `kind`, `subject?`, `evidence[]` (`task`, `quote`) | A new entry learned from tasks |
| `update` | `line`, `text`, `reason` | Rewrite an entry (same file) |
| `remove` | `line`, `reason` | Drop a stale, duplicate or wrong entry |
| `merge` | `lines[]`, `text`, `reason` | Keep one entry with `text`, remove the others |
| `move` | `line`, `file`, `reason` | Move an entry to a better file |
| `promote` | `line` (inbox), `file`, `text?`, `reason` | Take an inbox entry into the folder |
| `discard` | `line` (inbox), `reason` | Drop an inbox entry |

Files are root-relative markdown paths; a new topic file is created on first use and linked
from the index. At most 40 operations per dream; at most one operation per line.

## 4. Validation and classification

Every operation is checked: aliases exist, paths are safe (`isSafeRepoPath`, never `.git`,
never `inbox.md` as a target), text passes the shared screen (salience, redaction; secret-only
text is rejected), files stay under the size limits. Invalid operations are dropped and
counted.

| Operation | Applied automatically when | Otherwise |
|---|---|---|
| `update`, `remove`, `merge`, `move` | every line it touches is `by: agent` and none is in `MEMORY.md` | review |
| `add` | the target is not `MEMORY.md` and every evidence quote appears in that task's **user** messages | review |
| `discard` | always (it only removes untrusted, unreviewed text) | — |
| `promote` | never (inbox text came from untrusted content) | review |

Automatic changes keep `by: agent`; new entries cite the first evidence task as `source`.
Changes in the review commit are written with `by: user`, because merging them is the user's
confirmation.

## 5. Applying, review and undo

- **Auto:** under the folder lock, after committing hand edits, all auto operations are applied
  to the work tree and committed once (`Origin: dream`, `Dream: <id>` trailers). **Undo** is
  `git revert --no-edit <commit>`; a revert that conflicts is aborted and reported.
- **Review:** a temporary worktree (`git worktree add` outside the folder) on a new branch
  `dream/<id>` from the post-auto HEAD gets the review operations as one commit; the worktree
  is removed, the branch stays. **Accept** merges the branch into `main` (`--no-ff`, under the
  lock; a conflict aborts the merge and marks the proposal stale). **Reject** deletes the
  branch. The diff shown is `git diff <base>..dream/<id>`.
- **Record:** `.git/cowork-dreams/<id>.json` holds the run (trigger, times, counts, tokens,
  auto commit, review branch, base, operations with reasons, status). `state.json` keeps the
  last run time and the newest task time already read.

## 6. Triggers, budget and settings

- **Daily:** Heartbeat's daily idle pass calls the dreamer; it runs when the last dream is more
  than 20 hours old and there is something new (tasks since the last dream or inbox entries).
- **Manual:** **Dream now** in the Memory folder card.
- **Settings:** `memoryRepoDreamingEnabled` (default on; it only matters while the folder is on)
  and `memoryRepoDreamDailyTokenBudget` (default 50 000 tokens, rolling 24 hours, counted from the
  run records). A dream that would not fit the remaining budget is skipped. The card shows the
  cost notice and today's use.
- **Model:** the configured provider and model (as AI memory compression), 4 000 output tokens,
  usage telemetry `memory_repo_dream`.

## 7. UI

- **Review tab:** a "Memory folder" section listing pending dream proposals (summary,
  operations with reasons, the diff) with **Accept** and **Reject**, and recent automatic dream
  commits with **Undo**.
- **Memory folder card:** **Dream now**, the last dream (time, changes applied, waiting for
  review), the dreaming switch and the budget notice.
- **Health:** a "Memory folder dreaming" row: last run, failed runs in 7 days, pending reviews.

## 8. Security

- The model sees memory and conversation text, never tools; its output is data. Every operation
  is validated, and nothing it writes reaches `MEMORY.md` or touches the user's lines without
  the user accepting it.
- Inbox text (untrusted) can only leave the inbox through review.
- New entries are automatic only when the user's own words support them.
- Private, contact, task and strict-privacy facts are not in the folder, so they are never sent.
  Tasks with `<no-memory>` are left out of the input.
- Git runs with the Phase 1 hardening (no hooks, no signing, scrubbed environment, no network).

## 9. As built

- **Code.** `src/electron/memory/repo/`: `memory-repo-dream-plan.ts` (input, schema,
  classification, application), `MemoryRepoDreamer.ts` (gate, model call, records),
  `memory-repo-dream-client.ts` (provider call, telemetry `memory_repo_dream`),
  `memory-repo-dream-tasks.ts` (recent tasks), `memory-repo-dream-report.ts` (renderer
  mapping); git side in `MemoryRepoService` (`applyDream`, `acceptDream`, `rejectDream`,
  `undoDream`, `dreamDiff`). UI: `MemoryRepoDreamsSection.tsx` in the Review tab, the
  Dreaming part of `MemoryRepoCard.tsx`. IPC: `memoryRepo:dreams`, `:dreamDiff`,
  `:acceptDream`, `:rejectDream`, `:undoDream`, `:dreamNow`.
- **Task cursor.** Tasks are read oldest first after the last dream's newest task, and never
  past a task that is still running, so a later dream reads what an earlier one could not
  (more than 20 tasks, or a task that finished later). Child tasks, automation sources, group
  and public channels, third-party senders, `<no-memory>` tasks and workspaces with memory off
  or strict privacy are left out.
- **Trigger.** Heartbeat offers a dream on every pulse that reaches its Dreaming step (no
  foreground task, maintenance on); the dreamer's 20-hour interval, budget and "something new"
  checks decide. The node daemon has no Heartbeat, so there it only runs on **Dream now**.
  A dream lock in the folder's `.git` keeps the desktop app and the daemon from dreaming at once.
- **Compaction.** Compacting history deletes pending dream branches (marked stale) and clears
  undo for earlier dreams, so forgotten text is not kept reachable by a branch.
