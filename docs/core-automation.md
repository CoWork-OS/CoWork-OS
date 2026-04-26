# Core Automation

CoWork OS now treats always-on automation as a strict core runtime, not a blended product story.

## Core Boundary

The core runtime is **Workflow Intelligence**:

- `Memory` is the source of truth.
- `Heartbeat` owns scheduling and signal readiness.
- `Reflection` evaluates evidence internally.
- `Suggestions` are the default user-facing output.

Everything else is a surrounding surface:

- `Routines` are the top-level saved automation product, but not part of the always-on cognitive core
- `Mission Control` is the cockpit for observing and configuring the core
- `Triggers` are ingress and signal normalization only
- `Devices` are execution routing only
- `Digital Twins` are optional persona presets and are not part of core ownership

`Routines` now sit above several lower-level engines:

- schedule triggers compile into `Scheduled Tasks`
- API triggers compile into `Webhooks`
- event triggers compile into `Event Triggers`

That makes `Routines` the main user-facing automation abstraction without redefining the actual core runtime boundary.

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

`signal or evidence -> Heartbeat -> Reflection -> Suggestion -> user response -> Memory`

Downstream surfaces can create visible work, but they do not become cognition owners themselves. User response to suggestions is part of the loop: acting reinforces a workflow pattern, editing captures a correction, and snooze/dismiss/ignore lowers similar future suggestions.

## Core Targets

Direct reflection target ownership is intentionally narrow:

- `global`
- `workspace`
- `agent_role`
- `code_workspace`
- `pull_request`

Non-core concepts such as triggers, schedules, briefings, mailbox threads, and devices can still contribute evidence or execute outcomes, but they are not direct cognition targets.

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

It is not the owner of runtime state; it is the operating cockpit around that state.

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
