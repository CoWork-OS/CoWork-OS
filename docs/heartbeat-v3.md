# Heartbeat V3

Heartbeat v3 is the scheduling and signal-readiness layer inside Workflow Intelligence:

- `Memory` is the source of truth.
- `Heartbeat` decides when enough fresh signal exists.
- `Reflection` evaluates evidence internally.
- `Suggestions` are the default user-facing output.

It replaces the older queue-first heartbeat internals with a two-lane pipeline designed around three goals, in order:

1. Hybrid control
2. Lower cost
3. Simpler runtime behavior

The key design change is that not every wake is treated as potential task work anymore.

Heartbeat owns the "when should we think?" decision. Reflection no longer runs its own independent interval loop for normal operation; Heartbeat triggers it when Pulse results or accumulated signals justify another evaluation.

## Two-Lane Model

Heartbeat v3 separates cheap awareness from expensive action.

| Lane | Purpose | LLM? | Can create tasks? |
|------|---------|------|-------------------|
| `Pulse` | Deterministic state reduction and gating | No | No |
| `Dispatch` | Escalation into visible work only when Pulse justifies it | Sometimes | Yes |

`Pulse` runs on a cadence or via a manual override. It reads the current heartbeat state and returns one of:

- `idle`
- `deferred`
- `suggestion`
- `dispatch_task`
- `dispatch_runbook`
- `handoff_to_cron`

`Dispatch` only runs when Pulse asks for escalation. Passive `next-heartbeat` wakes alone should not create tasks.

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

Signals with the same fingerprint merge instead of accumulating. This is what keeps ambient file, git, and awareness activity cheap.

## Defer And Compress

Foreground manual work no longer causes wake buildup.

If a user-facing task is already active for the same workspace, Pulse records a deferred state and compresses pending signals into a resumable summary. That gives v3 its steady-state behavior:

- no unbounded wake queue growth
- no steady-state saturation behavior
- no repeated low-value wake spam while the user is already working

Manual `wake now` is still an override path and can bypass defer rules.

## Automation Profiles

Heartbeat ownership now lives on `AutomationProfile`, not directly on persona templates.

An automation profile is attached to a generic operator role and stores:

- enabled state
- cadence
- stagger offset
- dispatch cooldown
- dispatch budget
- active hours
- heartbeat profile

Digital Twin activation does not create an automation profile automatically. Twins remain optional persona presets and can later be paired with a separate automation profile if you want an always-on operator.

## Heartbeat Profiles

Execution behavior is controlled by `heartbeatProfile`, not `autonomyLevel`.

| Profile | Behavior |
|---------|----------|
| `observer` | Awareness only. Does not execute checklist maintenance. |
| `operator` | Awareness plus checklist and proactive review. Can surface suggestions and run light maintenance paths. |
| `dispatcher` | Full escalation profile. Can create heartbeat tasks, runbooks, and cron handoffs. |

This also controls whether `.cowork/HEARTBEAT.md` is actionable. The file is a recurring maintenance checklist input, not general task context.

## Proactive Tasks And `HEARTBEAT.md`

Proactive tasks are cadence-evaluated in Pulse. They are not blindly turned into work every time an agent wakes.

Each proactive task can declare:

- `frequencyMinutes`
- `executionMode`
- `minSignalStrength`
- `priority`

Execution modes are:

| Mode | Meaning |
|------|---------|
| `pulse_only` | Cheap maintenance review surfaced by Pulse without heavy escalation |
| `dispatch` | Requires Dispatch before visible work happens |
| `cron_handoff` | Should be handed off to an exact-time or heavyweight scheduler/runbook |

`.cowork/HEARTBEAT.md` is parsed into structured checklist items and cached by workspace revision. Pulse evaluates the cached checklist state instead of reparsing the file on every run.

## Dispatch Guardrails

Dispatch is intentionally narrow.

- one in-flight dispatch per agent/workspace
- cooldown after success
- shorter retry after failure
- daily dispatch budget via `maxDispatchesPerDay`
- repeated identical low-value signals do not keep retriggering escalation
- task creation requires evidence refs from Pulse

Every Pulse and every Dispatch gets a run record. If Dispatch creates a heartbeat task, that task carries a non-null `heartbeatRunId`.

## Mission Control Semantics

Mission Control should be read as heartbeat truth, not queue pressure.

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

See also [Workflow Intelligence](workflow-intelligence.md), [Core Automation](core-automation.md), and [Mission Control](mission-control.md).
