# Mission Control

Mission Control is a centralized agent orchestration and monitoring dashboard. It provides the main cockpit for managing agents, tracking tasks across a Kanban board, monitoring real-time activity, and overseeing team-based collaboration.

Heartbeat v3 is the default background automation model exposed here. Mission Control should be read as pulse/defer/dispatch truth, not as a wake-queue monitor. It also surfaces the `Core Harness` that learns from runtime traces. See [Heartbeat v3](heartbeat-v3.md) and [Core Automation](core-automation.md) for the runtime model.

Access it from **Settings** > **Mission Control**. For company-ops workflows, you can also jump into it directly from **Settings** > **Companies** with the selected company preloaded.

Mission Control now sits alongside the other operational entry points:

- **Devices** for machine-level task routing and remote execution
- **Settings > Automations** for routines, core automation, queueing, scheduling, triggers, briefing, and subconscious policies
- **Settings > Companies** for company graph editing and operator assignment

## Layout

Mission Control is split into three panels:

| Panel | Purpose |
|-------|---------|
| **Left — Agents** | Active agents list with Pulse/Dispatch state, automation-profile-backed cadence, and manual trigger controls |
| **Center — Mission Queue** | Kanban board with 5 columns for task lifecycle management |
| **Right — Feed & Details** | Live activity feed and selected task details with comments/mentions |

The header bar shows workspace selector, key stats (active agents, queued tasks, pending mentions), current time, and buttons for Teams, Reviews, and Standup.

---

## Agents Panel (Left)

View and manage all active agents in the current workspace.

### Agent Information

Each agent card shows:
- Display name, role description, and avatar
- Current active task title (or "No active task")
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

Heartbeat and subconscious ownership no longer live directly in the general role editor. Core-runtime settings are managed through the dedicated automation surfaces.

---

## Mission Queue — Kanban Board (Center)

A 5-column Kanban board for managing the full task lifecycle. Drag tasks between columns to change their status.

| Column | Status | Description |
|--------|--------|-------------|
| **INBOX** | Backlog | Unassigned items waiting for triage |
| **ASSIGNED** | Todo | Queued and assigned to agents |
| **IN PROGRESS** | Active | Currently being executed |
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

This is the main monitoring surface for the `trace -> failure mining -> clustering -> eval -> experiment -> learning` loop behind Heartbeat and Subconscious.

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
- **Track items**: Shared checklists within a run with status tracking
- **Real-time events**: Live tracking of team activity (member changes, run status, item updates)
- **Graph-backed runs**: team work now rides on the same orchestration graph engine used by spawned agents and ACP delegation, so run state and projections stay consistent across surfaces

See [Features — Agent Teams](features.md#agent-teams) for more details.

## Managed Agents

Managed Agents V1 does not have a dedicated Mission Control creation flow yet.

Current behavior:

- managed sessions are created through the Control Plane
- each managed session creates a backing task
- team-mode managed sessions also create a backing team run
- Mission Control remains the main place to observe those backing tasks and team runs once they exist

Use this together with [Managed Agents](managed-agents.md) when manually testing the feature from the app today.

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
