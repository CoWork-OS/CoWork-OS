# Heartbeat V3

Heartbeat v3 is the scheduling and signal-readiness layer inside Workflow Intelligence:

- `Memory` is the source of truth.
- `Heartbeat` decides when enough fresh signal exists.
- `Reflection` evaluates evidence internally.
- `Dreaming` curates memory evidence when drift signals justify it.
- `Suggestions` are the default user-facing output.

It replaces the older queue-first heartbeat internals with a two-lane pipeline designed around three goals, in order:

1. Hybrid control
2. Lower cost
3. Simpler runtime behavior

The key design change is that not every wake is treated as potential task work anymore.

Heartbeat owns the "when should we think?" decision for Reflection, the chief-of-staff (AutonomyEngine) evaluation and heartbeat-triggered Dreaming. Reflection no longer runs its own independent interval loop for normal operation; Heartbeat triggers it when Pulse results or accumulated signals justify another evaluation. AutonomyEngine has no timer of its own: each in-hours, non-deferred pulse evaluates the pulse workspace once (repeat calls for the same workspace within a minute are skipped, since several agents can pulse it). Other background loops (for example core memory distillation, Box Brain polling and task-completion Dreaming) still schedule themselves.

Awareness is a signal producer only. It keeps its 20-second device poll, but its Heartbeat wakes are debounced to one per category (focus, calendar, workflow) and workspace every 5 minutes, carry that category and workspace so they merge, and no longer trigger an AutonomyEngine evaluation per event.

Heartbeat can also trigger Dreaming when the signal ledger contains memory-specific signals such as `memory_drift`, `correction_learning`, or `cross_workspace_patterns`, or when hot-memory pressure changed since the last run. Dreaming runs as background memory curation and produces candidates instead of creating tasks or silently rewriting memory.

## Two-Lane Model

Heartbeat v3 separates cheap awareness from expensive action.

| Lane       | Purpose                                                   | LLM?      | Can create tasks? |
| ---------- | --------------------------------------------------------- | --------- | ----------------- |
| `Pulse`    | Deterministic state reduction and gating                  | No        | No                |
| `Dispatch` | Escalation into visible work only when Pulse justifies it | Sometimes | Yes               |

`Pulse` runs on a cadence or via a manual override. It reads the current heartbeat state and returns one of:

- `idle`
- `deferred`
- `suggestion`
- `dispatch_task`
- `dispatch_runbook`
- `handoff_to_cron`

`Dispatch` only runs when Pulse asks for escalation. Passive `next-heartbeat` wakes alone should not create tasks. A wake with `mode: "now"` requests an immediate pulse (or queues one if a pulse is already running).

Pulses for one agent never overlap: the running slot is reserved before any asynchronous work, rescheduling always clears the previous timer, and manual triggers that arrive during a running pulse share one queued replay.

## Signals, Not Wake Queues

Event producers no longer pile free-form wake requests into a raw queue. They emit normalized heartbeat signals into a signal ledger.

Each signal carries:

- `agentScope`
- `workspaceScope`
- `signalFamily`
- `source`
- `fingerprint`
- `urgency`
- `confidence`
- `expiresAt`
- optional `evidenceRefs`

Signals with the same fingerprint merge instead of accumulating. Wake fingerprints are normalized to source, family, category, workspace and a one-hour bucket; they do not include window titles, file paths or other wake text, so repeated ambient file, git, and awareness activity merges. Manual "now" wakes keep a unique fingerprint.

The signal ledger (`heartbeat-signals-v3.json`) is written asynchronously with a 1-second debounce rather than on every wake. Urgent signals are kept for 2 hours.

## Defer And Compress

Foreground manual work no longer causes wake buildup.

If a user-facing task is already active for the same workspace, Pulse records a deferred state and compresses pending signals into a resumable summary. Active-hours and deferral checks run before a pulse run record is created and before Reflection or Dreaming, so out-of-hours and deferred pulses do no further work. That gives v3 its steady-state behavior:

- no unbounded wake queue growth
- no steady-state saturation behavior
- no repeated low-value wake spam while the user is already working

Manual `wake now` is still an override path and can bypass defer rules.

## Automation Profiles

Heartbeat ownership now lives on `AutomationProfile`.

An automation profile is attached to a generic operator role and stores:

- enabled state
- cadence
- stagger offset
- dispatch cooldown
- dispatch budget
- active hours
- heartbeat profile

## Heartbeat Profiles

Execution behavior is controlled by `heartbeatProfile`, not `autonomyLevel`.

| Profile      | Behavior                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------- |
| `observer`   | Awareness only. Does not execute checklist maintenance. Strong signals surface as suggestions.          |
| `operator`   | Awareness plus checklist and proactive review. Can surface suggestions and run light maintenance paths. |
| `dispatcher` | Full escalation profile. Can create heartbeat tasks; runbook and cron hand-offs are advisory only.      |

This also controls whether `.cowork/HEARTBEAT.md` is actionable. The file is a recurring maintenance checklist input, not general task context.

## Proactive Tasks And `HEARTBEAT.md`

Proactive tasks are cadence-evaluated in Pulse. They are not blindly turned into work every time an agent wakes.

Each proactive task can declare:

- `frequencyMinutes`
- `executionMode`
- `minSignalStrength`
- `priority`

Execution modes are:

| Mode           | Meaning                                                                |
| -------------- | ---------------------------------------------------------------------- |
| `pulse_only`   | Cheap maintenance review surfaced by Pulse without heavy escalation    |
| `dispatch`     | Requires Dispatch before visible work happens                          |
| `cron_handoff` | Should be handed off to an exact-time or heavyweight scheduler/runbook |

`.cowork/HEARTBEAT.md` is read on each pulse; parsed checklist items are cached by a hash of the file content, so the file is only re-parsed when it changes.

Runbook and `cron_handoff` decisions are advisory: they record a `dispatch.advisory` activity entry and do not execute a runbook or create a scheduled job yet. They do not create a dispatch run, spend dispatch budget or cooldown, or mark checklist items done, and they consume only `maintenance` signals. A reported item is not reported again for at least an hour (or its own cadence, if longer).

## One Suggestion Sink

Every suggestion producer — Heartbeat dispatch, Workflow Intelligence, the ProactiveSuggestions generators (due soon, focus, recurring patterns, ...) and AutonomyEngine decisions — proposes through one `SuggestionSink.propose({ entityKey, title, why, source, evidence, confidence })`. Proposals for the same entity merge into one suggestion that lists every proposing source, instead of each producer adding its own:

- The entity key is the producer's id for the thing (`commitment:<id>`, `task:<id>`, a WI target key, ...) or, without one, the normalized title with producer prefixes such as "Review due soon:" or "Follow up on:" removed. Matching titles merge too.
- Dismissing or acting on a suggestion suppresses its entity for every producer for 7 days.
- The daily briefing does not repeat a chief-of-staff decision as "Decision needed" when its entity is already listed as due soon or already surfaced as a suggestion.

## Dispatch Guardrails

Dispatch is intentionally narrow.

- one in-flight dispatch per agent/workspace: a dispatch that creates a task stays `running` until that task reaches a terminal status
- cooldown after success
- shorter retry after failure
- daily dispatch budget via `maxDispatchesPerDay`
- repeated identical low-value signals do not keep retriggering escalation
- task creation requires evidence refs; a task decision without them is downgraded to a suggestion
- one shared background budget per workspace and day (6, the `maxDispatchesPerDay` default) for every producer that creates tasks the user did not ask for: Heartbeat, AutonomyEngine, Workflow Intelligence auto-dispatch and scheduled Strategic Planner runs. It also holds a 2-hour per-entity cooldown across producers. Over budget, Heartbeat and Workflow Intelligence suggest instead, AutonomyEngine keeps the decision as a suggestion and the planner leaves the issue for a later run. Manual pulses and manual planner runs are counted but never refused. The shared ledger is in memory, so it restarts at zero with the app; Heartbeat's per-agent budget is stored and still applies.
- AutonomyEngine does not create tasks by default: every action policy is `suggest_only` or approval-based, and creating tasks is an explicit opt-in (`execute_local` in Memory Hub). Older saved settings that still carried the former `execute_local` defaults are reset once.

Every Pulse and every task-creating Dispatch gets a run record. If Dispatch creates a heartbeat task, that task carries a non-null `heartbeatRunId`. Each pulse settles in-flight dispatch runs from their task's status (or as failed when the task is gone or the run is older than 12 hours), and startup reconciles stale dispatch runs the same way.

Heartbeat's view of assigned work includes tasks that are pending, queued, planning, executing, paused or blocked, and excludes Heartbeat's own dispatched tasks.

Heartbeat run history older than 30 days is pruned daily, keeping the newest 200 runs per agent and never removing running, queued or issue-linked runs.

## Mission Control Semantics

Mission Control should be read as heartbeat truth, not queue pressure. The current UI separates:

- **Heartbeat agents**: enabled roles that may be monitoring, sleeping, or running.
- **Global runtime queue**: executor pressure from tasks running or waiting in the local task queue.
- **Mission Board work**: workspace-scoped tracked work in the board columns.

Those counts can differ without indicating an error.

Heartbeat v3 centers these operator-facing states:

- last pulse result
- last dispatch result
- deferred state
- compressed signal count
- due proactive count
- checklist due count
- dispatch cooldown or budget state

The healthy state is often quiet. A low-cost series of `idle` or `deferred` pulses is expected.

Mission Control also shows the downstream `Core Harness` that learns from heartbeat and workflow-intelligence traces through failure clusters, living evals, experiments, and learnings.

## Ambient Monitoring

Ambient monitoring is upstream of heartbeat v3. It is not the heartbeat system itself.

File, git, and other ambient sources emit low-priority mergeable signals that Pulse can review later. Broad-root watch skips and no-project-marker skips are summarized once at startup instead of spamming the log continuously.

## Dreaming Trigger Contract

Dreaming is a side effect of memory-specific Heartbeat pressure, not a Dispatch lane.

When a non-deferred, in-hours pulse sees memory drift, correction learning, or cross-workspace pattern signals (or changed hot-memory pressure), Heartbeat can ask Dreaming to run for the active workspace. The daemon emits a low-urgency `correction_learning` signal when it detects a user correction; `memory_drift` comes from mailbox automation, and nothing emits `cross_workspace_patterns` today. Dreaming enforces a 6-hour per-workspace cooldown, and Heartbeat skips it when `heartbeatMaintenanceEnabled` is off. Handled memory signals are removed from the ledger after a run. That Dreaming run persists `dreaming_runs` and `dreaming_candidates`, then returns run metadata on the heartbeat result for traceability.

Dreaming should not consume dispatch budget, create heartbeat tasks, or turn general activity signals into memory writes. Its output remains memory candidates; there is no review UI for them yet. See [Dreaming](dreaming.md).

Before a memory-specific Dreaming run, Heartbeat resolves the workspace's [access profile](access-profiles.md)
and builds a read guard for file-backed workspace-kit and transcript evidence. Profile resolution
errors, unavailable profiles, and denied candidate paths fail closed: pressure analysis and Dreaming
are skipped rather than performed with a broader filesystem boundary. Candidate review/application
still follows the normal memory-write governance path.

## Default Configuration

Automation-profile-backed operators now use the v3 decision model by default. The main config fields are:

- `enabled`
- `cadenceMinutes`
- `staggerOffsetMinutes`
- `dispatchCooldownMinutes`
- `maxDispatchesPerDay`
- `activeHours`
- `profile`

Legacy `heartbeatIntervalMinutes` may still exist as a compatibility fallback, but the v3 fields are the current source of truth for behavior.

## Practical Reading

- Use Heartbeat v3 when you want cheap continuous awareness with selective escalation into suggestions or trusted work.
- Use `observer` for roles that should stay cheap and quiet.
- Use `operator` or `dispatcher` for automation-profile-backed operators that should actively review and escalate.
- Keep exact-time or device-routed work in scheduler, trigger, or device surfaces instead of stretching heartbeat into a general control plane.

See also [Workflow Intelligence](workflow-intelligence.md), [Dreaming](dreaming.md), [Core Automation](core-automation.md), and [Mission Control](mission-control.md).
