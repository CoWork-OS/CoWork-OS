# Managed Agents

Managed Agents adds a first-class, GUI-first managed resource model to CoWork without replacing the existing task runtime or the new terminal entrypoint. It is one of the core reasons CoWork OS is positioned as a personal AI super app and everything app: users can create reusable agents, spawn work from templates or prompts, inspect configuration, run tests, and monitor execution from visual surfaces, while `cowork` remains available for terminal-native task starts.

V1 introduces three control-plane resources:

- `ManagedAgent`: reusable, versioned execution definition
- `ManagedEnvironment`: reusable local execution template
- `ManagedSession`: durable run resource that owns lifecycle, event history, and resume semantics

The implementation is local-first and additive. Managed resources are exposed through the control plane and Agents Hub, while existing `Task`, `AgentTeamRun`, `task_events`, and `session_runtime_v2` remain the execution primitives underneath.

<p align="center">
  <img src="../resources/branding/images/cowork-os-3.webp" alt="Agents Hub" width="700">
  <br><em>Agents Hub is the main surface for reusable managed agents, templates, and starter prompts.</em>
</p>

## Why This Exists

CoWork already had the low-level pieces for durable execution, team runs, worktree isolation, MCP integration, and resumable task runtime state. Managed Agents packages those pieces into reusable definitions and a stable run identity so GUI and backend surfaces can reason about durable agent runs directly instead of reconstructing them from ad hoc task metadata.

The product goal is that a user can manage many agents visually: create or generate agents, inspect tools and skills, launch tests, spawn starter prompts, watch child tasks, review approvals, and hand work into Mission Control without switching to a CLI workflow.

The model is:

- define reusable behavior in `ManagedAgent`
- define reusable local policy in `ManagedEnvironment`
- execute and observe durable runs through `ManagedSession`

## V1 Scope

Managed Agents V1 is intentionally narrow:

- local execution only through `ManagedEnvironment.kind = "cowork_local"`
- renderer support through the Agents Hub for creation, inspection, governance, and manual runs
- existing task APIs remain supported
- Mission Control and task surfaces observe the backing task or team run created by each managed session
- no private agent-detail chat surface; every runnable action is processed as a normal main-window task

This means Managed Agents is an additive product surface on top of the existing task runtime. The Agents Hub configures reusable agents, but the main task window remains the only place where agent work, questions, responses, approvals, and outputs are shown.

## Control-Plane Surface

Managed Agents is available through the existing dot-style control-plane namespace.

Agent methods:

- `managedAgent.list`
- `managedAgent.get`
- `managedAgent.create`
- `managedAgent.update`
- `managedAgent.archive`
- `managedAgent.version.list`
- `managedAgent.version.get`

Environment methods:

- `managedEnvironment.list`
- `managedEnvironment.get`
- `managedEnvironment.create`
- `managedEnvironment.update`
- `managedEnvironment.archive`

Session methods:

- `managedSession.list`
- `managedSession.get`
- `managedSession.create`
- `managedSession.cancel`
- `managedSession.resume`
- `managedSession.sendEvent`
- `managedSession.events.list`

Managed-session broadcasts:

- `managedSession.created`
- `managedSession.updated`
- `managedSession.event`
- `managedSession.completed`
- `managedSession.failed`

## Runtime Mapping

Managed Agents is not a second executor. It maps onto the existing runtime:

- `ManagedAgentVersion` becomes the source of truth for model, prompt, execution mode, and runtime defaults
- `ManagedEnvironment` becomes the source of truth for workspace binding, tool policy, MCP scope, and execution affordances
- `ManagedSession` creates exactly one backing `Task`
- team-mode `ManagedSession` also creates a backing `AgentTeamRun`
- `task_events` and daemon notifications are mirrored into `managed_session_events`
- `session_runtime_v2` remains task-scoped runtime state owned by `SessionRuntime`
- Agents Hub manual actions create `runtime` managed sessions and then open the backing task in the main task view

The important contract is that `ManagedSession` is the API-facing durable run, while `Task` remains the execution worker.

## Agents Hub Concept

The Agents Hub is the user-facing managed-agent surface in the renderer.

It owns:

- agent discovery across managed agents, templates, scheduled agents, and migrated personas
- natural-language agent creation through the builder
- template-backed drafts, required connectors, selected skills, runtime tools, memory, files, schedule, channels, approvals, sharing, and deployment posture
- managed-agent inspection, publish/suspend controls, Slack/channel status, runtime tool catalog, audit hints, and current instructions

The selected-agent detail screen is intentionally single-pane. It is not a chat room and it does not have a bottom ask box. Clicking a managed agent shows its configuration and action buttons in the main detail page.

The supported action model is:

- **Test this agent** creates a managed session with `surface: "runtime"` and opens the session's backing task in the main task window
- **Preview** follows the same runtime task path
- starter prompt cards follow the same runtime task path
- **Add advanced logic** and **Optimize this agent** open the agent draft/editor surface instead of starting a local conversation
- any follow-up questions, approvals, responses, files, and final outputs belong to the opened task, not to the Agents Hub detail screen

This keeps all agent execution observable through the same task timeline, right-panel artifacts, approvals, notifications, and completion behavior as ordinary user-created tasks.

## Relation To Dreaming

Managed Agents do not own memory curation policy.

Managed sessions can produce task transcripts, task results, and memory observations like ordinary tasks. Dreaming may later review that evidence after task completion or from memory-specific Heartbeat signals, but it writes reviewable `dreaming_candidates` through the normal Workflow Intelligence memory-curation path.

That keeps Managed Agents focused on reusable execution identity while Memory, Heartbeat, Reflection, Dreaming, and Suggestions remain the core Workflow Intelligence runtime. See [Dreaming](dreaming.md).

## Managed Turn Budgets

Managed Agents keep explicit turn caps because managed runs are often unattended or intentionally bounded.

- `ManagedAgentVersion.runtimeDefaults.maxTurns` is passed through as an explicit cap on the backing task when configured
- if a managed agent does not set `runtimeDefaults.maxTurns`, the backing task inherits the same default-unbounded main-task behavior as ordinary interactive sessions
- this differs from older strategy behavior: the runtime no longer invents a low implicit window such as `30` turns just because the task routed as `advice` or `planning`

In practice:

- use `runtimeDefaults.maxTurns` when you want a managed session to stop after a defined number of turns
- leave it unset when you want the run to rely on lifetime caps, emergency fuses, and the normal recovery/safety model instead

## Security And Policy Boundaries

Managed Agents follows the same security posture as the rest of CoWork, with a few managed-specific rules:

- renderer-facing managed environment reads redact `credentialRefs` and `managedAccountRefs`
- managed session events are sanitized before persistence and sanitized again on read
- MCP allowlists fail closed if the referenced server or its cached tool metadata is unavailable
- managed account refs are validated server-side at environment creation/update time
- legacy tasks, runs, and team APIs are unchanged for non-managed flows

These rules keep the managed control-plane surface suitable for UI/backend consumption without exposing sensitive linkage or silently broadening tool access.

## Current UI State

Managed Agents now has a dedicated renderer surface: **Agents Hub**.

Today’s product workflow is:

1. open **Agents** from the primary app navigation
2. create an agent from a prompt, a template, or an existing role/profile conversion
3. review and adjust tools, skills, files, memory, approvals, schedule, channels, and instructions
4. save or publish the agent
5. click **Test this agent**, **Preview**, or a starter prompt
6. observe the resulting backing task in the normal main task UI and Mission Control

The Control Plane remains available for API-level creation and smoke testing, but it is no longer the only practical test path from the desktop app.

## Manual App Test Flow

Use a solo session first:

```js
const workspaces = await request("workspace.list", {});
const workspaceId = workspaces.workspaces[0]?.id;

const environment = await request("managedEnvironment.create", {
  name: "Local Test Env",
  config: {
    workspaceId,
    enableShell: true,
    enableBrowser: true,
  },
});

const agent = await request("managedAgent.create", {
  name: "Managed Test Agent",
  systemPrompt: "You are a precise coding assistant.",
  executionMode: "solo",
  runtimeDefaults: {
    autonomousMode: true,
    allowUserInput: true,
  },
});

const session = await request("managedSession.create", {
  agentId: agent.agent.id,
  environmentId: environment.environment.id,
  title: "Managed Session Smoke Test",
  initialEvent: {
    type: "user.message",
    content: [{ type: "text", text: "Inspect the repo and summarize it." }],
  },
});
```

Then verify:

- a normal task appears in the desktop UI
- the task starts through the normal daemon lifecycle
- `managedSession.get` shows the backing task link and current status
- `managedSession.events.list` returns sanitized event payloads
- Agents Hub-created manual runs open the backing task in the main window rather than rendering a separate agent-panel transcript

For team mode:

- create a `ManagedAgent` with `executionMode: "team"`
- create a managed session
- observe the backing team run from Mission Control and task surfaces
- expect `managedSession.sendEvent` with `user.message` to reject for team-mode sessions in V1

That rejection is intentional until follow-up routing is wired cleanly into the team orchestration path.

## Compatibility Contract

Managed Agents must not break existing flows.

The additive contract is:

- legacy `task.*` methods still create and run ordinary tasks
- legacy task timelines and approvals still work
- Agent Teams still work outside managed sessions
- managed sessions reuse the daemon and runtime instead of bypassing them
- managed resources add a new control-plane namespace; they do not replace existing APIs

When changing this system, preserve that boundary and update the tests that prove it.
