# Mission Control

Mission Control is a centralized agent orchestration and monitoring dashboard. It provides a command center for managing agents, tracking tasks across a Kanban board, monitoring real-time activity, and overseeing team-based collaboration.

Access it from **Settings** > **Mission Control**.

## Layout

Mission Control is split into three panels:

| Panel | Purpose |
|-------|---------|
| **Left — Agents** | Active agents list with status, heartbeat info, and wake controls |
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
- **Status indicator**: green dot (working), gray dot (idle), disabled (offline)
- Next scheduled heartbeat time

### Agent Actions

| Action | Result |
|--------|--------|
| **Click** agent | Select/deselect — filters the activity feed to that agent |
| **Double-click** agent | Open Agent Role Editor to edit configuration |
| **"Wake Agent"** button | Manually trigger heartbeat immediately |
| **"Add Agent"** button | Create a new agent role with configuration modal |

### Agent Role Editor

Configure agent roles with:
- Display name, description, icon, and color
- Personality and model preferences
- Capabilities and tool restrictions
- Autonomy level (lead / specialist / intern)
- Heartbeat settings (enabled, interval, stagger offset)

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

Tabbed panel with two views.

### Live Feed Tab

Real-time activity stream for the current workspace.

**Filter by event type:**
- ALL — Everything
- TASKS — Task creation and status changes
- COMMENTS — Comments and mentions
- STATUS — Heartbeat status updates

**Filter by agent:** Click agent chips to show only that agent's activity.

**Event types shown:**
- Agent heartbeat events (started, found work, completed, errors)
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

---

## Agent Teams

Access from the **Teams** button in the header. Full management UI for coordinated multi-agent collaboration.

- **Create teams**: Name, description, lead agent, max parallel agents, model and personality preferences
- **Manage members**: Add/remove agents, reorder, provide guidance
- **Create team runs**: Execute coordinated multi-agent tasks
- **Track items**: Shared checklists within a run with status tracking
- **Real-time events**: Live tracking of team activity (member changes, run status, item updates)

See [Features — Agent Teams](features.md#agent-teams) for more details.

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
| **Heartbeat events** | Agent status dots (working/idle/offline), feed items |
| **Activity events** | Comments, mentions, assignments in the feed |
| **Task events** | New tasks, status changes on the Kanban board |
| **Task board events** | Column moves, priority changes, label/date updates |
| **Team run events** | Team and member changes, run progress, item status |
| **Mention events** | Pending mention count in header, mention list in task details |

---

## Quick Reference

| Action | How |
|--------|-----|
| Open Mission Control | Settings > Mission Control |
| Add a new agent | Click "Add Agent" in the agents panel |
| Edit an agent | Double-click the agent card |
| Wake an idle agent | Click "Wake Agent" on the agent card |
| Move a task to a new stage | Drag the task card to the target column |
| View task details | Click any task card |
| Post an update on a task | Select task, type in the comment box, click "Post Update" |
| Filter feed by agent | Click an agent chip in the feed panel |
| Create a team | Header > Teams > create team |
| Generate a performance review | Header > Reviews > select agent > Generate |
| Generate a standup report | Header > Standup > Generate Standup Report |
