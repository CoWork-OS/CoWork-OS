# Workflow Intelligence

Workflow Intelligence is the user-facing concept for CoWork OS's always-on learning and next-action system.

It replaces the older product framing around `Subconscious` with a clearer model:

- `Memory` is the source of truth.
- `Heartbeat` owns scheduling and signal readiness.
- `Reflection` is the internal evaluation phase.
- `Dreaming` is the background memory-curation phase.
- `Suggestions` are the default user-facing output.

The goal is not opaque background autonomy. The goal is reviewable help that gets better from how the user responds.

## What Changed

The previous model exposed too much of the reflective internals. It also let the reflective layer behave like a parallel memory product and a separate scheduler.

The new model makes the boundaries explicit:

| Layer         | Responsibility                                                                                                     | User-facing?                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| `Memory`      | Stores durable preferences, workflow patterns, corrections, open loops, recurring tasks, and ignored-noise signals | Yes, through Memory Hub and retrieved context |
| `Heartbeat`   | Decides when enough fresh signal exists to think again                                                             | Mostly visible through Mission Control status |
| `Reflection`  | Evaluates evidence, generates hypotheses, critiques them, and chooses a recommended next action                    | No, except in diagnostics/settings            |
| `Dreaming`    | Curates `memory_items`: merges, resolves conflicts, promotes recurring outcomes, decays and expires facts           | Yes, through the Memory Hub Review tab        |
| `Suggestions` | Presents reviewable next actions with evidence, confidence, and controls                                           | Yes                                           |

`Subconscious` remains an internal compatibility name in some code paths, database tables, artifact folders, and logs. Product copy and docs should use `Workflow Intelligence` unless they are describing those internals directly.

`Dreaming` is the new name for the memory-curation phase inside this loop. It should not be described as a generic reflective loop or as a second memory system.

## Operating Loop

Workflow Intelligence runs as a closed feedback loop:

```text
workspace activity, memory, mailbox, tasks, git, schedules, triggers
    -> Heartbeat signal ledger
    -> Heartbeat Pulse decides whether reflection is useful now
    -> Reflection collects evidence, critiques options, and selects a recommendation
    -> Dreaming curates memory_items (safe operations applied, the rest queued for review)
    -> Memory receives curated facts and durable feedback signals
    -> Suggestions show reviewable next actions
    -> user acts, edits, snoozes, dismisses, or ignores
    -> feedback updates memory and future suggestion scoring
```

This keeps learning grounded in observable user behavior rather than hidden assumptions.

## Suggestion Contract

Every user-facing suggestion should carry enough context to be trusted or rejected quickly:

- **Title**: the proposed work in plain language
- **Why now**: the timing reason
- **Source evidence**: recent signals or modules that led to the suggestion
- **Confidence**: a lightweight score for ranking and triage
- **Suggested action**: the prompt/action CoWork can start from
- **Controls**: act, edit, snooze, dismiss

The welcome screen can show these as **Next actions** under the message box when the optional home widget is enabled. The same suggestion objects can also appear in the automation inbox and Suggestions panel.

## Learning From Response

User response is now part of the learning model:

| Response  | Learning effect                                                                               |
| --------- | --------------------------------------------------------------------------------------------- |
| `Act`     | Reinforces the suggestion class/source as useful and captures a workflow-pattern memory       |
| `Edit`    | Captures a correction memory with the original and edited action                              |
| `Snooze`  | Hides the suggestion until the snooze time and slightly lowers similar timing/source patterns |
| `Dismiss` | Captures ignored-noise feedback and lowers similar future suggestions                         |
| `Ignore`  | If a surfaced suggestion sits stale long enough, it becomes weak ignored-noise feedback       |

This is the missing loop that turns suggestions from a static list into a system that adapts to the user's workflow.

## Memory As Source Of Truth

Reflection no longer treats its local memory index as the main learning product.

Reflection outputs are converted into core memory candidates, including:

- user preference
- workflow pattern
- open loop
- correction
- recurring task
- ignored noise
- watch item
- constraint

Accepted candidates flow through the core memory distillation path: fact types become `inferred` `memory_items` through `MemoryWriter`, events (open loops, watch items, recurring-workflow hints) become archive rows, and ignored noise is a runtime signal that is never written. This keeps durable learning in the existing memory stack instead of creating a parallel source of truth.

## Dreaming As Memory Curation

Dreaming is the offline memory-maintenance lane. It runs after task completion when `backgroundConsolidationEnabled` is on (default off), and Heartbeat can trigger it when `memory_drift` or `correction_learning` signals appear (the daemon emits `correction_learning` when it detects a user correction) or hot-memory pressure changes. Automatic runs are limited to one per workspace every 6 hours.

Dreaming is the curator of `memory_items`. It reads the workspace's active facts, archive outcomes of the last 30 days and conversation evidence of finished commitments. Safe operations on inferred facts (merges, promotions of outcomes that recur in two or more tasks, decay, closing done commitments) are applied through `MemoryWriter`, one audited and undoable operation each; everything else, and anything the user stated or confirmed, is queued for the Memory Hub Review tab. A once-daily idle pass curates recently active workspaces, and an optional, budgeted LLM synthesis step (off by default) can add proposals that always go to review.

This keeps Dreaming from becoming a second memory system: it has no store of its own and every change goes through the same writer as every other producer.

See [Dreaming](dreaming.md) for the canonical memory-curation contract.

## Heartbeat As Scheduler

Heartbeat owns the "when should we think?" decision for Reflection and the chief-of-staff (AutonomyEngine) evaluation. Some other background loops (for example core memory distillation and Box Brain polling) still run on their own timers. Workflow Intelligence task and code-change dispatches draw from the shared per-workspace background budget (see [Heartbeat v3](heartbeat-v3.md)); over budget, or for a target dispatched within the last 2 hours, the decision becomes a review suggestion.

Heartbeat can trigger reflection when signals justify it, for example:

- non-idle Pulse outcome
- multiple actionable signals
- several relevant recent activities
- assigned work that may need follow-up
- due checklist or proactive items

Reflection no longer runs its own independent interval loop. It can still be run manually from settings for inspection/debugging.

## Review Before Autonomy

Workflow Intelligence defaults to reviewable suggestions.

Auto-created tasks are allowed only when all of these are true:

- auto-create is explicitly enabled
- the recommendation is low risk
- the target scope is clear
- policy allows the executor
- either the target is trusted or similar suggestions were repeatedly accepted

This keeps CoWork useful before it becomes autonomous and avoids surprising task creation from weak signals.

## Product Surfaces

Workflow Intelligence appears in:

- **Welcome screen**: optional `Next actions` under the message box, enabled from **Settings > Appearance > Home widgets > Show next actions**
- **Home dashboard**: automation inbox items and recent automation activity
- **Settings > Automations > Workflow Intelligence**: policy, target, run, and diagnostic controls
- **Suggestions panel**: review, act, snooze, and dismiss active suggestions
- **Mission Control**: heartbeat state, traces, core harness learning, and dispatched work
- **Memory Hub**: "What CoWork knows" (facts), the **Review** tab for Dreaming proposals and undo, and pending memory writes.

Reflection internals remain inspectable for power users, but suggestions are the primary user-facing output.

## Durable State And Compatibility

Current implementation details still use legacy names in some places:

- `.cowork/subconscious/` artifact folders
- `SubconsciousLoopService` logs
- `subconscious_*` SQLite tables
- IPC names such as `runSubconsciousNow`

Those names are compatibility details. New documentation, labels, and product copy should use `Workflow Intelligence`.

The artifact contract remains useful for debugging:

```text
.cowork/subconscious/
  brain/state.json
  brain/dreams/*.json
  journal/YYYY-MM-DD.jsonl
  targets/<targetKey>/state.json
  targets/<targetKey>/backlog.md
  targets/<targetKey>/runs/<runId>/evidence.json
  targets/<targetKey>/runs/<runId>/ideas.jsonl
  targets/<targetKey>/runs/<runId>/critique.jsonl
  targets/<targetKey>/runs/<runId>/decision.json
  targets/<targetKey>/runs/<runId>/winning-recommendation.md
  targets/<targetKey>/runs/<runId>/dispatch.json
```

SQLite remains the fast index/query layer. Memory remains the durable learning source of truth.

A daily retention job removes `subconscious_*` rows older than 90 days, and run artifact directories and journal files older than `artifactRetentionDays`.

## Relation To Core Harness

Workflow Intelligence feeds and consumes the core harness:

- Heartbeat and reflection create core traces.
- Traces produce memory candidates.
- Failures can become clusters and eval cases.
- Accepted memory candidates improve later retrieval and suggestion scoring.
- User response feedback tunes future suggestion ranking.

The core harness is the measurable improvement system. Workflow Intelligence is the product loop that turns that learning into reviewable work.

## Related Docs

- [Core Automation](core-automation.md)
- [Dreaming](dreaming.md)
- [Heartbeat v3](heartbeat-v3.md)
- [Mission Control](mission-control.md)
- [Memory and Workspace Flow](workspace-memory-flow.md)
- [Getting Started](getting-started.md)
- [Troubleshooting](troubleshooting.md#workflow-intelligence-startup-warnings-in-development)
