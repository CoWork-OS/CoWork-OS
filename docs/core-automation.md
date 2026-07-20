# Core Automation

CoWork OS now treats always-on automation as a strict core runtime, not a blended product story.

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
- `Digital Twins` are optional persona presets and are not part of core ownership

Structured Studio flows and prompt-based Routines sit above several lower-level engines:

- schedule triggers compile into `Scheduled Tasks`
- API triggers compile into `Webhooks`
- event triggers compile into `Event Triggers`

That makes main-sidebar Automation Studio the primary visual multi-step workflow surface while preserving Routines as the shared saved-automation shell. Neither redefines the actual core runtime boundary. See [Automation Studio](automation-studio.md).

Task view can also create a task-sourced routine with `... > Add automation...`. That flow is not a new core cognition loop; it is a task-prefilled routine authoring shortcut that can continue the existing thread by default or create new tasks on each run. Schedule triggers still compile to `Scheduled Tasks`, API triggers compile to `Webhooks`, and event triggers compile to `Event Triggers`, with the source task title, task ID, and `cowork://tasks/<taskId>` reference preserved. See [Task Automations](task-automations.md).

Use main-sidebar **Automations → Activity** for structured workflow run and step evidence. `Settings > Automations > Routines` remains the primary observability surface for task-sourced and prompt-based automations. When a routine compiles to a cron job, `Settings > Automations > Scheduled Tasks` also shows aggregate run health, the latest result, delivery status, recent run history, and links to generated sessions or continued threads so lower-level scheduled work can be audited without digging through the general task list.

<p align="center">
  <img src="../resources/branding/images/cowork-os-6.webp" alt="Automations control center" width="700">
  <br><em>The advanced Settings surface separates prompt-based routines, scheduled work, triggered work, and core automation controls; structured flows live in the main Automations tab.</em>
</p>

## Ownership Model

Core automation is owned by `AutomationProfile`, not by persona templates and not by raw role editing.

An automation profile is attached to a generic operator agent role and stores:

- enabled state
- cadence
- stagger offset
- dispatch cooldown
- dispatch budget
- active hours
- heartbeat profile

Digital Twin roles do not own automation profiles and do not create heartbeat or workflow-intelligence state when activated.

## Cognition Path

The intended flow is:

`signal or evidence -> Heartbeat -> Reflection -> Dreaming when memory drift exists -> Suggestion or memory candidate -> user response -> Memory`

Downstream surfaces can create visible work, but they do not become cognition owners themselves. User response to suggestions is part of the loop: acting reinforces a workflow pattern, editing captures a correction, and snooze/dismiss/ignore lowers similar future suggestions.

Dreaming is the memory-maintenance branch of this path. It can run after task completion or from memory-specific Heartbeat signals, persists `dreaming_runs` and `dreaming_candidates`, and leaves final mutation to the existing memory services.

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
- auto-approval only for common automation-safe actions such as shell commands and trusted network/external-service operations
- hard guardrails, workspace capability denials, and explicit dangerous actions still remain enforced

See [Workflow Intelligence](workflow-intelligence.md), [Heartbeat v3](heartbeat-v3.md), [Mission Control](mission-control.md), and [Permission System](permission-system.md).
