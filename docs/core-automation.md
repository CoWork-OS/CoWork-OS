# Core Automation

CoWork separates Workflow Intelligence from user-created automations. Background services run only
inside a process that has started them. “Always-on” describes behavior while that runtime is
available; it is not a hosted-uptime guarantee and does not keep a desktop computer awake.

## Core Boundary

The core runtime is **Workflow Intelligence**:

- `Memory` is the source of truth.
- `Heartbeat` owns scheduling and signal readiness.
- `Reflection` evaluates evidence internally.
- `Dreaming` curates memory evidence into reviewable candidates.
- `Suggestions` are the default user-facing output.

Everything else is a surrounding surface:

- main-sidebar `Automation Studio` is the visual structured-flow product, but not part of the always-on cognitive core
- `Routines` are the saved automation shell and prompt-based compatibility product, but not part of the always-on cognitive core
- `Mission Control` is the cockpit for observing and configuring the core
- `Triggers` are ingress and signal normalization only
- `Devices` are execution routing only

Structured Studio flows and prompt-based Routines sit above several lower-level engines:

- schedule triggers compile into `Scheduled Tasks`
- API triggers compile into `Webhooks`
- event triggers compile into `Event Triggers`

That makes main-sidebar Automation Studio the primary visual multi-step workflow surface while preserving Routines as the shared saved-automation shell. Neither redefines the actual core runtime boundary. See [Automation Studio](automation-studio.md).

## Scheduler Availability Contract

Scheduled Tasks use process-local timers. A desktop app or a CoWork daemon can host the scheduler
when that process is started and the host remains available. Definitions are stored in the active
CoWork profile. Selecting a workspace, worktree, device, or managed environment chooses where work
executes; it does not move the scheduler or bind the saved definition to that host.

The settings view reports the current process and its status at the time of the response. That
snapshot does not promise future availability and does not detect another desktop or daemon using
the same profile. Until exclusive ownership is observed, do not treat the reported process as the
only scheduler for that profile. A daemon also depends on its machine, service, network, and
credentials remaining available.

When a scheduler resumes, an enabled saved Cron job whose next occurrence is overdue may run once.
Intermediate missed slots are not replayed individually. Recurring schedules advance using their
saved recurrence rule. Current interval schedule creators persist an anchor; legacy intervals
without one use the time at which the next occurrence is calculated and can shift after recovery.
A persisted overdue one-shot can be eligible after
restart; creating or re-enabling a one-shot for a time already in the past does not calculate a next
run. “Scheduled for” describes the nominal time, not a promise that the host, credentials,
concurrency, or approvals will allow work to start then.

Disabling a job prevents future triggers but does not cancel a task already in flight. The
scheduler continues tracking a persisted in-flight task so its outcome and delivery can be recorded.
Provider credentials and permissions are not comprehensively preflighted when a schedule is saved;
review the latest run error for connection problems. Pending approvals remain in the native task or
workflow record and must be handled there.

Calendar schedules use their saved IANA timezone. Older schedules without a timezone retain the
scheduler process timezone; the daemon can set that with `COWORK_TZ`. A device execution target does
not change this clock. New or changed calendar schedules reject an invalid IANA timezone. Structured
workflow approvals stay attached to their native review record; a Cron polling timeout does not
necessarily cancel the underlying task or an external side effect. Inspect the task and run record
before retrying uncertain work. The current Cron expression calculator searches at most two years
ahead, so very sparse calendar rules outside that horizon may have no projected next run.

Task view can also create a task-sourced routine with `... > Add automation...`. That flow is not a new core cognition loop; it is a task-prefilled routine authoring shortcut that can continue the existing thread by default or create new tasks on each run. Schedule triggers still compile to `Scheduled Tasks`, API triggers compile to `Webhooks`, and event triggers compile to `Event Triggers`, with the source task title, task ID, and `cowork://tasks/<taskId>` reference preserved. See [Task Automations](task-automations.md).

Use main-sidebar **Automations → Library** to find task-sourced and prompt-based routines alongside structured flows and standalone automation owners. **Activity** shows source-labelled owner history; open the linked native record when exact workflow-step detail is needed. `Settings > Automations` remains the advanced editor and lower-level operations surface. When a routine compiles to a cron job, `Settings > Automations > Scheduled Tasks` also shows aggregate run health, the latest result, delivery status, recent run history, and links to generated sessions or continued threads so lower-level scheduled work can be audited without digging through the general task list.

## Ownership Model

Core automation is owned by `AutomationProfile`, not by raw role editing.

An automation profile is attached to a generic operator agent role and stores:

- enabled state
- cadence
- stagger offset
- dispatch cooldown
- dispatch budget
- active hours
- heartbeat profile

## Cognition Path

The intended flow is:

`signal or evidence -> Heartbeat -> Reflection -> Dreaming when memory drift exists -> Suggestion or memory candidate -> user response -> Memory`

Downstream surfaces can create visible work, but they do not become cognition owners themselves. User response to suggestions is part of the loop: acting reinforces a workflow pattern, editing captures a correction, and snooze/dismiss/ignore lowers similar future suggestions.

Dreaming is the memory-maintenance branch of this path. About once a day (offered by idle Heartbeat pulses) or on **Dream now**, it tidies the memory folder: safe edits are one undoable commit, and edits to your own notes wait in **Settings > Memory > Review**. See [Dreaming](dreaming.md).

## Core Targets

Direct reflection target ownership is intentionally narrow:

- `global`
- `workspace`
- `agent_role`
- `code_workspace`
- `pull_request`

Non-core concepts such as triggers, schedules, briefings, mailbox threads, and devices can still contribute evidence or execute outcomes, but they are not direct cognition targets.

Task-sourced automations follow the same rule: they can execute recurring work, continue a task thread, or produce new task evidence, but the original task, deeplink, schedule, webhook, event trigger, or worktree is not a Workflow Intelligence ownership target.

## Mission Control

Mission Control is the main control surface for the core runtime. It should be read as:

- automation profile state
- heartbeat runs
- workflow-intelligence/reflection runs
- core traces
- failure clusters
- eval cases
- experiments
- learnings

It is not the owner of runtime state; it is the operating cockpit around that state. Mission Control also exposes a global runtime queue summary so operators can see executor pressure, but that queue is separate from Heartbeat state and from workspace-scoped Mission Board work.

## Core Harness

Core automation now includes a learning loop built around:

- core traces
- memory extraction and distillation
- failure mining
- recurring failure clustering
- living eval cases
- gated experiments
- promoted learnings

This gives the always-on runtime a narrow improvement loop centered on operator quality, rather than a broad feature sprawl.

## Approval Model

Core-created automated tasks now inherit a real autonomy policy instead of only `allowUserInput: false`. Workflow Intelligence is review-first by default: it creates suggestions unless explicit policy, low risk, clear scope, and trusted or repeatedly accepted patterns justify auto-create.

The default posture is:

- reviewable suggestions for new or uncertain patterns
- autonomous execution only for trusted routine operator work
- auto-approval only for common automation-safe actions such as profile-permitted command tools and trusted network/external-service operations
- hard guardrails, workspace capability denials, and explicit dangerous actions still remain enforced

Every core-created task also receives an explicit access profile. The profile is the ceiling for
command tools, filesystem access, network/domain scope, sandboxing, and approvals; the core
automation allowlist can reduce prompts only inside that ceiling. It cannot turn on command tools,
restore a denied path, or bypass export/location consent. See [Access Profiles](access-profiles.md).

See [Workflow Intelligence](workflow-intelligence.md), [Heartbeat v3](heartbeat-v3.md), [Mission Control](mission-control.md), and [Permission System](permission-system.md).
