# Dreaming

Dreaming is CoWork OS's background memory curator. It is the only process that maintains the
`memory_items` fact store between direct user actions: it merges duplicates, resolves
conflicts, promotes recurring outcomes into facts, decays unused inferences and closes finished
commitments. The full contract (operations, thresholds, undo) is in
[memory-engine.md §5b](memory-engine.md#5b-dreaming-the-curator-of-memory_items-phase-3).

It is part of Workflow Intelligence, but it has a narrower job than Reflection:

- Reflection decides what recommendation or next action may be useful.
- Dreaming keeps the memory store accurate and small.

Dreaming never changes what the user stated or confirmed on its own. Safe operations on
inferred memory are applied automatically, one audited and undoable operation each; everything
else waits in the **Review** tab of the Memory Hub.

## Where It Fits

| Layer         | Responsibility                                                                                     |
| ------------- | -------------------------------------------------------------------------------------------------- |
| `Memory`      | Durable source of truth: `memory_items` (facts) and the archive (episodic outcomes)               |
| `Heartbeat`   | Scheduling and signal-readiness layer; the only scheduler that starts automatic Dreaming runs      |
| `Reflection`  | Internal evaluation layer for recommendations and next actions                                     |
| `Dreaming`    | Background curation of stale, duplicated, conflicting, missing or overdue memory                   |
| `Suggestions` | User-facing review surface for next actions                                                        |

## Trigger Sources

| Trigger           | When It Runs                                                                                                   | Scope                       |
| ----------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `task_completion` | After task completion, only when `backgroundConsolidationEnabled` is on (default off)                          | The completed task's workspace |
| `heartbeat`       | A Heartbeat pulse that sees memory signals or changed hot-memory pressure, or the once-daily idle pass         | The pulse's workspace       |
| `system`          | After a Box Brain sync                                                                                         | The synced workspace        |
| `manual`          | "Run Dreaming now" in the Memory Hub Review tab                                                                | The selected workspace      |

Heartbeat-triggered Dreaming reacts to memory-relevant signals and pressure:

- `correction_learning`: emitted by the daemon when it detects a user correction in a task message (no user text is carried in the signal)
- `memory_drift`: emitted by mailbox automation
- `cross_workspace_patterns`: accepted, but no producer emits it today
- hot-memory pressure: triggers only when the pressure report changed since the last run that handled it

**Daily idle pass.** A pulse with no other Dreaming trigger and no foreground task curates the
next workspace that had a task in the last 14 days and no Dreaming run in the last 24 hours
(the pulse's workspace first, one per pulse). There is no timer of its own. Heartbeat skips
Dreaming when `heartbeatMaintenanceEnabled` is off.

### Cooldown and overlap

Automatic runs are spaced at least **6 hours** apart per workspace. Manual runs bypass the
cooldown. At most one run per workspace is in progress at a time; an overlapping request shares
the running one. Runs wait for the startup lane migration.

## Inputs

Per workspace:

- active `global` and `workspace` items in `memory_items` (contact and task items are never curated)
- archive outcomes of the last 30 days (decisions, errors, insights including corrections, preferences, constraints, workflow patterns); suppressed and redacted rows are excluded
- conversation-index hits that show an overdue commitment was done

## Operations

| Operation            | What it does                                                                     | Applied automatically when                                                  |
| -------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `merge`              | Folds near-duplicate facts into the strongest one                               | all items have the same trust and none is user-stated or user-confirmed    |
| `resolve_conflict`   | Flags two facts that contradict each other and suggests the more trusted/newer  | never (always review)                                                       |
| `promote`            | Turns an outcome that recurred in at least two tasks into an `inferred` fact    | not a `rule`, and no evidence is private, imported or screen-captured      |
| `decay`              | Archives long-unused, low-trust facts (never `identity` or `rule`, never pinned) | the source is `inferred`                                                    |
| `expire_commitment`  | Closes a commitment that is done or long overdue                                 | there is a done signal and the user did not state or confirm it            |

At most 25 automatic operations and 20 queued proposals per run, and at most one operation per
item per run.

## Review, Undo and LLM Synthesis

- **Review tab** (Memory Hub): pending proposals with their items, why, why they need review and
  the evidence, with Accept / Reject; recent changes with **Undo**; the AI synthesis switch and
  today's token use. The tab label shows the pending count. Accepting a promotion writes the fact
  as `user_confirmed`.
- **Undo** restores the prior state of every item an operation touched and removes items it
  created. Undo is refused when an item changed since. Undone and rejected changes are never
  applied or proposed again.
- **Audit log.** Every applied operation is one transaction with its `memory_curation_log` row
  (before/after snapshots, origin `auto` or `review`). Log rows are dropped after 90 days and
  when the items they quote are deleted.
- **Optional LLM synthesis** (`dreamingLlmEnabled`, off by default; daily token budget
  `dreamingLlmDailyTokenBudget`, default 20 000). One call per run on the configured provider;
  the model sees aliases, never ids or private items, must answer with strict JSON and may only
  propose `merge`, `resolve_conflict`, `promote` and `decay`. Everything it proposes goes to
  review.

## Access Boundary

Background Dreaming is not an access-profile bypass. Heartbeat-triggered runs resolve the active
workspace's [access profile](access-profiles.md) before reading file-backed evidence; if the
profile cannot be resolved or a path is outside the effective boundary, that evidence is skipped.
Every change goes through `MemoryWriter` (salience, redaction and policy steps included).

## Durable State

| Table                 | Purpose                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------- |
| `dreaming_runs`       | One row per run: trigger, scope, status, `applied_count`, `queued_count`, `llm_tokens`, `llm_calls`, per-operation stats |
| `dreaming_candidates` | Proposals queued for the Review tab                                                           |
| `memory_curation_log` | Applied operations with snapshots for undo                                                    |

The daily `MemoryRetentionService` job removes Dreaming runs and settled candidates older than
90 days; candidates awaiting review are kept. Clear All Memories removes a workspace's Dreaming
rows. The pre-curator constant-text candidates were closed as `dismissed` by a schema upgrade.

## Non-Goals

Dreaming is not:

- a second memory store
- a general scheduler
- a hidden task creator
- a replacement for Reflection
- an always-on LLM loop

## Related Docs

- [Memory Engine](memory-engine.md)
- [Workflow Intelligence](workflow-intelligence.md)
- [Heartbeat v3](heartbeat-v3.md)
- [Workspace Memory Flow](workspace-memory-flow.md)
- [Structured Memory Observations](memory-observations.md)
- [Core Automation](core-automation.md)
