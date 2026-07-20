# Mission Control

Mission Control is a centralized, GUI-first agent orchestration and monitoring dashboard. It provides the main cockpit for managing many agents, tracking board work, monitoring the global runtime queue, reviewing approvals, and overseeing team-based collaboration without reducing agent operations to terminal output.

Heartbeat v3 is the default background automation model exposed here. Mission Control should be read as pulse/defer/dispatch truth, not as a wake-queue monitor. Mission Control also surfaces the `Core Harness` and should eventually surface Dreaming runs/candidates as the reviewable memory-curation lane. See [Heartbeat v3](heartbeat-v3.md), [Dreaming](dreaming.md), and [Core Automation](core-automation.md) for the runtime model.

Access it from **Settings** > **Mission Control**. For company-ops workflows, you can also jump into it directly from **Settings** > **Companies** with the selected company preloaded.

<p align="center">
  <img src="../resources/branding/images/cowork-os-8.webp" alt="Mission Control board" width="700">
  <br><em>Mission Control brings global runtime queue state, assigned board work, live feed, and review state into one operations view.</em>
</p>

Mission Control now sits alongside the other operational entry points:

- **Devices** for machine-level task routing and remote execution
- main-sidebar **Automations** for structured flow authoring, activation, approvals, and step-level Activity
- **Settings > Automations** for prompt-based routines, core automation, queueing, scheduling, triggers, briefing, and Workflow Intelligence policies
- **Settings > Memory Hub** for durable memory, structured observations, and future Dreaming candidate review
- **Settings > Companies** for company graph editing and operator assignment

## Layout

Mission Control is split into three panels:

| Panel | Purpose |
|-------|---------|
| **Left — Agents** | Heartbeat-enabled agent list with Pulse/Dispatch state, automation-profile-backed cadence, idle/running state, and manual trigger controls |
| **Center — Mission Board** | Kanban board with 5 columns for tracked work lifecycle management |
| **Right — Feed & Details** | Live activity feed and selected task details with comments/mentions |

The header bar shows workspace selector, current time, and operational counters grouped by source:

- **Heartbeat agents**: enabled background roles that may be monitoring or idle.
- **Global runtime queue**: tasks currently running or waiting for an execution slot. This matches the chat/right-panel queue and can include work from another workspace.
- **Board work**: open work items tracked on the Mission Control board.
- **Mentions**: pending human or agent mentions.

These numbers can differ. For example, two Heartbeat agents can be enabled while zero board items are open in the selected workspace and four global runtime tasks are waiting in chat. If the queue service is still loading or unavailable, Mission Control shows that state explicitly instead of reporting `0` or `All clear`.

---

## Agents Panel (Left)

View and manage enabled agents in the current workspace. An enabled agent is not necessarily executing a task; it may be monitoring, sleeping, or waiting for its next Heartbeat pulse.

### Agent Information

Each agent card shows:
- Display name, role description, and avatar
- Current running task title, tracked task title, or "No active task"
- **Autonomy level badge**: LEAD, SPC (Specialist), or INT (Intern)
- **Heartbeat profile**: `observer`, `operator`, or `dispatcher`
- **Status indicator**: green dot (working), gray dot (idle), disabled (offline)
- Next scheduled Pulse time
- Latest Pulse result and latest Dispatch result
- Deferred, cooldown, and dispatch-budget state when relevant

### Agent Actions

| Action | Result |
|--------|--------|
| **Click** agent | Select/deselect — filters the activity feed to that agent |
| **Double-click** agent | Open Agent Role Editor to edit configuration |
| **Trigger Pulse** button | Manually trigger Heartbeat v3 review immediately |
| **"Add Agent"** button | Create a new agent role with configuration modal |

### Agent Role Editor

Configure agent roles with:
- Display name, description, icon, and color
- Personality and model preferences
- Capabilities and tool restrictions
- Autonomy level (lead / specialist / intern)
- link-out to the attached automation profile when the role participates in the always-on core

Heartbeat, Dreaming, and Workflow Intelligence ownership no longer live directly in the general role editor. Core-runtime settings are managed through the dedicated automation and memory surfaces.

---

## Mission Board — Kanban Board (Center)

A 5-column Kanban board for managing tracked work. Drag tasks between columns to change their status. This board is separate from the live global runtime queue: runtime tasks can be running or waiting even when the board has no open work in the current view.

| Column | Status | Description |
|--------|--------|-------------|
| **INBOX** | Backlog | Unassigned items waiting for triage |
| **ASSIGNED** | Todo | Assigned board work ready to start |
| **IN PROGRESS** | Active | Board work currently being executed or planned |
| **REVIEW** | Pending review | Awaiting approval or human review |
| **DONE** | Completed | Finished tasks |

### Task Cards

Each card shows:
- Task title
- Assigned agent (avatar + name)
- Status pill with color coding
- Time since last update (relative: "5m ago", "2h ago")

### Interactions

- **Drag and drop** tasks between columns to change status
- **Click** a task card to view its details in the right panel

---

## Global Runtime Queue

The Brief tab includes a **Global Runtime Queue** card. It is sourced from the same task executor queue used by chat and the right-panel lineup:

- **Running** tasks are currently occupying execution slots.
- **Waiting** tasks are queued for the next available execution slot.
- **Unavailable** means the queue service could not be read, so Mission Control cannot truthfully claim the queue is empty.

This queue is global to the local CoWork runtime. It can include tasks from workspaces outside the current Mission Control workspace selector. When a queued task belongs outside the visible workspace scope, Mission Control still includes it in the global queue count and marks the row as outside scope instead of hiding the discrepancy.

The **Mission Board** remains workspace-scoped tracked work. A workspace can have no open board work while the global runtime queue still has running or waiting tasks.

---

## Feed & Task Details (Right)

Tabbed panel with three views.

### Live Feed Tab

Real-time activity stream for the current workspace.

**Filter by event type:**
- ALL — Everything
- TASKS — Task creation and status changes
- COMMENTS — Comments and mentions
- STATUS — Heartbeat status updates

**Filter by agent:** Click agent chips to show only that agent's activity.

**Event types shown:**
- Pulse results (`idle`, `deferred`, `suggestion`, `dispatch_task`, `dispatch_runbook`, `handoff_to_cron`)
- Dispatch results (`silent`, `suggestion`, `task`, `runbook`, `cron_handoff`)
- Task comments and mentions
- Task status changes
- Agent assignments

### Task Details Tab

Click any task card to see its full details:

- **Title and status** with color-coded pill
- **Assignment controls**: Change assignee (agent dropdown) and stage (column dropdown)
- **Task brief**: Full prompt/description
- **Updates**: Activity feed for this task with comment box to post updates
- **Mentions**: Create and manage mentions with status tracking (pending, acknowledged, completed, dismissed)
- **Completion projection**: task detail completion rows now include semantic batch labels, verifier verdicts, and follow-up trigger text when available

### Learning, Recall, and Runtime State

Task details now surface the new runtime visibility signals that used to live only in background services:

- **What Cowork learned**: the completion card shows memory captured, playbook reinforcement, skill proposal state, evidence links, Chronicle-backed `screen_context` evidence when used, and the next action when a human review is needed
- **Unified recall**: task detail search spans tasks, messages, files, workspace notes, memory entries, Chronicle `screen_context`, and knowledge-graph context from one surface
- **Shell session status**: long-lived shell sessions show when cwd/env/alias state is being retained or reset, so operator workflows are easier to trust
- **Model routing status**: the active provider/model, route reason, and fallback transitions are visible in the task UI and settings surfaces

Chronicle now shows up in three places inside task detail:

- a learning-progress step named **Chronicle screen context used**
- `screen_context` evidence refs when a task promoted recent-screen context
- unified recall hits for promoted observations and any linked `screen_context` memory

These signals are also mirrored into the live feed so Mission Control stays the primary desktop control plane for understanding what the runtime is doing.

### Ops Tab

The `Ops` tab is the company-operations view used by the zero-human-company workflow.

It exposes:

- company snapshot
- goals and projects
- planner-managed issues
- planner-cycle issue drill-down
- issue comments
- issue execution runs
- run timeline events
- linked task navigation

Use it together with the strategic planner strip to watch company-level planning move into executable task work.

The `Ops` tab is most useful when the company graph is maintained in **Settings** > **Companies**, since that tab is where companies, goals, projects, issues, and linked operators are created and edited.

If the work itself is being executed on another machine, pair Mission Control with the **Devices** tab: Mission Control gives you company-level orchestration, while Devices gives you machine-level routing and remote task inspection.

### Core Harness

Mission Control now includes a `Core Harness` view for the learning loop around always-on automation.

It surfaces:

- recurring core failure clusters
- living eval cases
- proposed and gated experiments
- promoted learnings

This is the main monitoring surface for the `trace -> failure mining -> clustering -> eval -> experiment -> learning` loop behind Heartbeat and Workflow Intelligence.

---

## Strategic Planner Strip

Mission Control now includes a planner strip above the three-panel layout for company-ops configuration and review.

Available controls:

- company selector
- planner enabled/disabled toggle
- auto-dispatch toggle
- planner interval
- planning workspace selector
- planner-agent selector
- approval preset selector
- manual `Run Planner`
- recent planner cycle history

This is the main desktop entry point for zero-human-company planning loops.

Companies created in **Settings** > **Companies** appear here in the company selector. If you opened Mission Control from a company page, that company is preselected.

---

## Agent Teams

Access from the **Teams** button in the header. Full management UI for coordinated multi-agent collaboration.

- **Create teams**: Name, description, lead agent, max parallel agents, model and personality preferences
- **Manage members**: Add/remove agents, reorder, provide guidance
- **Create team runs**: Execute coordinated multi-agent tasks
- **Multitask runs**: `/multitask [N] <task>` creates an ephemeral team run with lane-specific checklist items and uses the same tracking surfaces
- **Track items**: Shared checklists within a run with status tracking
- **Real-time events**: Live tracking of team activity (member changes, run status, item updates)
- **Graph-backed runs**: team work now rides on the same orchestration graph engine used by spawned agents and ACP delegation, so run state and projections stay consistent across surfaces

See [Features — Agent Teams](features.md#agent-teams) for more details.

## Managed Agents

Managed Agents are created and configured in **Agents Hub**, not inside Mission Control.

Current behavior:

- managed sessions are created through Agents Hub actions or the Control Plane
- each managed session creates a backing task
- team-mode managed sessions also create a backing team run
- Mission Control remains the main place to observe those backing tasks and team runs once they exist
- the selected-agent detail screen in Agents Hub does not host its own chat transcript; test, preview, and starter-prompt actions open the backing task in the main task UI

Use this together with [Managed Agents](managed-agents.md) when testing reusable agents from the app.

---

## Digital Twin Personas

Access from the **Add Digital Twin** button in the agents panel (next to Add Agent).

Browse pre-built persona templates — Software Engineer, Engineering Manager, Product Manager, and more — and activate them in one click. Twins are now optional persona presets and do not directly own the always-on core runtime.

Each twin comes with:

- **Prompt and personality defaults**
- **Cognitive offload categories** targeting the mental work that fragments focus
- **Recommended skills** for on-demand use (meeting prep, decision packages, status reports)

Mission Control is also the best place to monitor venture/operator twins such as:

- `Founder Office Operator`
- `Company Planner`
- `Growth Operator`
- `Customer Ops Lead`

If those twins were created from a company context, they still appear in Mission Control as normal agents, but they retain their company assignment for use in `Ops`, `Companies`, and company-aware Digital Twins views. If you want one of those operators to become always-on, attach a separate automation profile instead of relying on the twin template itself.

See [Digital Twins](digital-twins.md) for full documentation, enterprise scenarios, and template reference.

---

## Performance Reviews

Access from the **Reviews** button in the header.

- **Select agent** and review period (1-90 days, default 7)
- **Generate review**: Analyzes task completion rate, error rates, and autonomy effectiveness
- **View history**: Browse previous reviews per agent
- **Apply recommendation**: Auto-update an agent's autonomy level based on the review

---

## Standup Reports

Access from the **Standup** button in the header.

- **Generate standup**: Auto-generate a summary of recent workspace activity
- **View reports**: Browse up to 30 recent standup reports
- **Metrics included**: Completed tasks, in-progress tasks, blocked tasks with titles and statuses

---

## Real-Time Updates

Mission Control subscribes to live event streams — no manual refresh needed:

| Event Stream | What It Updates |
|-------------|-----------------|
| **Heartbeat v3 events** | Agent status dots, pulse/dispatch indicators, deferred state, feed items |
| **Core harness events** | Failure clusters, eval upkeep, experiment progression, and learning summaries |
| **Activity events** | Comments, mentions, assignments in the feed |
| **Learning events** | Post-task learning progression, skill promotion states, and evidence-linked completion summaries |
| **Routing events** | Provider/model switches, fallback transitions, and route-reason updates |
| **Task events** | New tasks, status changes on the Kanban board |
| **Task board events** | Column moves, priority changes, label/date updates |
| **Runtime queue events** | Global running/waiting counts and queue task summaries in the Brief tab |
| **Team run events** | Team and member changes, run progress, item status |
| **Mention events** | Pending mention count in header, mention list in task details |

---

## Quick Reference

| Action | How |
|--------|-----|
| Open Mission Control | Settings > Mission Control |
| Open company-scoped Mission Control | Settings > Companies > Open in Mission Control |
| Add a new agent | Click "Add Agent" in the agents panel |
| Add a digital twin | Click "Add Digital Twin" in the agents panel ([details](digital-twins.md)) |
| Review core automation learning | Open the `Core Harness` view |
| Configure the company planner | Use the planner strip above the board |
| Inspect company ops | Open the `Ops` tab in the right panel |
| Edit an agent | Double-click the agent card |
| Trigger immediate heartbeat review | Click `Trigger Pulse` on the agent card |
| Move a task to a new stage | Drag the task card to the target column |
| View task details | Click any task card |
| Post an update on a task | Select task, type in the comment box, click "Post Update" |
| Filter feed by agent | Click an agent chip in the feed panel |
| Create a team | Header > Teams > create team |
| Generate a performance review | Header > Reviews > select agent > Generate |
| Generate a standup report | Header > Standup > Generate Standup Report |

For a full founder-directed autonomous-company setup, see [Zero-Human Company Operations](zero-human-company.md).
