# Mission Control

Mission Control is a centralized, GUI-first agent orchestration and monitoring dashboard. It provides the main cockpit for managing many agents, tracking board work, monitoring the global runtime queue, reviewing approvals, and overseeing team-based collaboration without reducing agent operations to terminal output.

Heartbeat v3 is the default background automation model exposed here. Mission Control should be read as pulse/defer/dispatch truth, not as a wake-queue monitor. Mission Control also surfaces the `Core Harness` and should eventually surface Dreaming runs/candidates as the reviewable memory-curation lane. See [Heartbeat v3](heartbeat-v3.md), [Dreaming](dreaming.md), and [Core Automation](core-automation.md) for the runtime model.

Open **Mission Control** from **More** on the left icon rail (in both the standard and Calm interfaces; pin it to keep it on the rail). The exact path depends on the app release; see the [release surface reference](release-surface-reference.md) before following a version-specific navigation path.

Mission Control observes and configures tasks; it is not a second permission
plane. When creating or editing an agent or automation, review the attached
[access profile](access-profiles.md) alongside its access limit, tool, connector,
and workspace settings. Planner, Heartbeat, and dispatch policies can narrow
or defer work, but they cannot widen the profile or revive an unavailable one.

<p align="center">
  <img src="../resources/branding/images/cowork-os-8.webp" alt="Mission Control board" width="700">
  <br><em>Mission Control brings global runtime queue state, assigned board work, the evidence feed, and review state into one operations view.</em>
</p>

Mission Control now sits alongside the other operational entry points:

- **Devices** (in **Team** in the Calm theme) for machine-level task routing and remote execution
- main-sidebar **Automations** for structured flow authoring, activation, approvals, and step-level Activity
- **Settings > Automations** for prompt-based routines, core automation, queueing, scheduling, triggers, briefing, and Workflow Intelligence policies
- **Settings > Memory** for the memory folder, structured observations, and dream changes waiting in **Review**

## Layout

Mission Control has a header, a row of tabs and the selected tab's view. Selecting a task or an issue opens its details in a panel on the right; close it with the X or Esc.

| Tab               | What it shows                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------------- |
| **Brief**         | The command brief: headline numbers, the global runtime queue, what needs you and what Mission Control flagged |
| **Work**          | The Mission Board: tracked work in five columns, with filters                                                   |
| **Intelligence**  | Learnings, awareness and reviews, read-only                                                                     |
| **Evidence Feed** | Grouped activity with its evidence, filterable by category, status and agent                                    |
| **Operations**    | Company operations, including the Core Harness and the Strategic Planner; shown only when a company exists     |

The header has the workspace selector (**All Workspaces** by default), **Refresh**, **Agent teams**, the agents button, a clock, and operational counters grouped by source:

- **Heartbeat agents**: enabled background roles that may be monitoring or idle.
- **Global runtime queue**: tasks currently running or waiting for an execution slot. This matches the chat/right-panel queue and can include work from another workspace.
- **Board work**: open work items tracked on the Mission Control board.
- **Mentions**: pending human or agent mentions.

The header's **Bots** button opens the Bots page, where agents are created and configured. In the Calm theme it reads **Team** and opens Team, which shows each agent with what it is doing, what it waits on you for and where it runs.

These numbers can differ. For example, two Heartbeat agents can be enabled while zero board items are open in the selected workspace and four global runtime tasks are waiting in chat. If the queue service is still loading or unavailable, Mission Control shows that state explicitly instead of reporting `0` or `All clear`.

---

## Agents

Mission Control doesn't keep its own agent list. Agents are created on the Bots page and configured there or in Team (the header's **Bots** button, or **Team** in the Calm theme):

- **Team** shows what each agent is doing, what it is waiting on you for, and **May do alone**, its [access limit](access-profiles.md#agent-access-limits). **Edit agent** opens its full settings.
- On the Bots page, **Edit bot** changes the character, name, purpose and instructions; **More settings** opens the full settings.
- The full settings cover the display name, description, icon and color, model and personality, capabilities and tool restrictions, and **Seniority** (Intern, Specialist or Lead). Seniority sets how often the agent checks in (every 20 minutes for a lead, 30 otherwise), whether it hands out work by default, and who leads an agent team. It isn't a permission.

On the Work board, the lightning icon on a task card (**Wake owner**) runs the assigned agent's heartbeat review now.

---

## Brief

The **Brief** tab opens first. Under **Command Brief** (with **Refresh brief** and a link to the Evidence Feed), the metric buttons jump to their section or tab: **global runtime queue**, **need you**, **open board work**, **learnings**, **awareness** and **evidence rows**.

- **need you** counts the approvals, questions and paused sessions waiting on you in the selected workspace (and agent, when one is selected in the Evidence Feed). The **Needs You** section lists up to six, each opening where it is decided, then **+N more in Today**. Today, Bots and the bell count the same decisions.
- **Flagged** lists Mission Control's own flags. **Latest Decisions**, **Learnings**, **Awareness**, **Active Work** and **Upcoming Reviews** follow; each item opens its task.

### Global Runtime Queue

The Brief tab includes a **Global Runtime Queue** card. It is sourced from the same task executor queue used by chat and the right-panel lineup:

- **Running** tasks are currently occupying execution slots.
- **Waiting** tasks are queued for the next available execution slot.
- **Unavailable** means the queue service could not be read, so Mission Control cannot truthfully claim the queue is empty.

This queue is global to the local CoWork runtime. It can include tasks from workspaces outside the current Mission Control workspace selector. When a queued task belongs outside the visible workspace scope, Mission Control still includes it in the global queue count and marks the row as outside scope instead of hiding the discrepancy. Each list shows four rows, then **+N more in chat queue**.

The **Mission Board** remains workspace-scoped tracked work. A workspace can have no open board work while the global runtime queue still has running or waiting tasks.

---

## Work: the Mission Board

The **Work** tab is a five-column board of the recent tasks in the selected workspace (every workspace under **All Workspaces**). Nothing is added to it by hand: a task started from the composer, by an agent's heartbeat, a team or the planner shows up on its own, in the column that matches its state. So the board has no **New task** or **Link existing** buttons; start work from the composer and it appears here. The board is separate from the live global runtime queue: runtime tasks can be running or waiting even when the board has no open work in the current view.

| Column             | What lands here                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| **Not started**    | Open tasks with no owner that aren't running                                                                      |
| **Ready to start** | Open tasks with an assigned agent that aren't running, or moved here                                              |
| **Working**        | Tasks being planned or executed, and tasks moved here                                                             |
| **Needs review**   | Tasks moved here for approval or human review                                                                     |
| **Done**           | Completed, failed, cancelled and interrupted tasks, and tasks moved here; shown with **History** or **All tasks** |

A finished task always sits in **Done**, and a running one in **Working** unless it was moved to **Needs review** or **Done**.

Column headers show the count (red past the column's work-in-progress limit) and how many cards need attention, are overdue or are stale.

- **Presets**: **Active**, **Needs attention**, **All tasks**, plus **History** for finished work.
- **Search** by title, label, owner or reason; filter by agent, label, priority, status and, under All Workspaces, workspace; sort by urgency, last update, due date or priority. **Show empty** keeps empty columns visible.
- **Cards** show priority (P0 to P4), labels, title, status, last update, why the card needs attention, the owner, and due date, estimate or a stale marker. The icons on a card open its details, cycle its priority, wake its owner, or move it to the next stage.
- **Drag** a card to another column to change its stage; click it (or press Enter or Space) to open its details.

### Task details

The detail panel shows the task's status and why it needs attention, with **Wake owner**, **Move to** the next stage and **Due today**. Below:

- a summary (owner, priority, due date, estimate, health, labels) and controls to change the assignee, stage, priority, estimate, due date and labels;
- **Brief**: the task's prompt;
- **What Cowork learned**: memory captured, playbook reinforcement, skill proposal state, evidence links (including Chronicle `screen_context` evidence when used) and the next step when a review is needed;
- **Search everything**: search tasks, messages, the conversation index, files, workspace notes, memory, screen context and the knowledge graph from one box. Tasks and activity are searched over every row of the workspace and ranked by how many query terms match; the lanes are fused by reciprocal rank. Searching records no memory use and starts no index sync; notes are read through the workspace's access profile. Details: [Memory Engine](memory-engine.md) §4b;
- **Updates**: the task's activity, with **Post Update**;
- **Mentions**: mention an agent with `@` and track each mention's status.

Chronicle shows up in task details as a learning step named **Chronicle screen context used**, as `screen_context` evidence refs when a task promoted recent-screen context, and as search hits for promoted observations.

---

## Intelligence

The **Intelligence** tab lists **Learnings**, **Awareness** and **Reviews** (up to twelve each), each with its severity, time, summary and the decision or next step. It is read-only; **Open Evidence Feed** shows the underlying items.

---

## Evidence Feed

The **Evidence Feed** groups activity into items you can filter:

- **Category**: All, Attention, Work, Reviews, Learnings, Awareness, Evidence.
- **Status**: Any status, Action needed, Monitor only, Successful, Failed.
- **Agent**: click an agent chip. Selecting an agent also scopes the Brief and its Needs You list to that agent.

Each item shows its severity, category, agent, workspace and time, a summary and the decision or next step, with **Open task** and **Show evidence** for the rows behind it.

---

## Operations

The **Operations** tab is the company-operations view. It appears when a company exists and has these sub-tabs:

- **Overview**: active goals and projects, open issues, pending review and valuable outputs.
- **Core Harness**: the learning loop around always-on automation, with recurring failure clusters, recent failure records, eval and experiment activity, and recent learnings. This is the main monitoring surface for the `trace -> failure mining -> clustering -> eval -> experiment -> learning` loop behind Heartbeat and Workflow Intelligence.
- **Operators**: each operator's mandate, bottleneck, last useful output, heartbeat and health.
- **Outputs & Review**: the operations feed and the review queue.
- **Execution Map**: planner-managed issues.
- **Planner**: the Strategic Planner (below).
- **Automation**: recent automation outcomes, each with its task, the next step and **Retry notification**.
- **Hygiene**: generated software nobody uses, owns, or that depends on something gone (below). It covers the whole profile, so it also works without a company.

### Hygiene

Hygiene checks the skills you or the agent made (managed and workspace skills; bundled and read-only external skills are not listed), Playbook entries, scheduled automations, event triggers and curated rules. An item is listed when:

- **Unused 60+ / 90+ days**: no use since then. Uses are skill applications and Playbook recalls (counted in `lifecycle_meta`), automation runs, trigger fires and rule recalls (from each one's own store). An automation with a next scheduled run is never unused, however rarely it runs.
- **No owner**: a skill, automation or trigger with nobody recorded as responsible. A skill's author counts; you can type an owner in the row.
- **Broken dependency**: it depends on a workspace that no longer exists or an item that was retired or removed. Automations, triggers, Playbook entries and rules depend on their workspace.
- **No evidence**: a rule unused for 90 days that names no failure it prevents (see [Rules](evolving-agent-intelligence.md#rules-what-they-protect-and-their-evidence)).

Nothing is deleted. **Retire** disables a skill, automation or trigger, archives a rule, and stops a Playbook entry from being recalled; it also marks the item retired, so anything that depends on it shows a broken dependency. **Keep** restarts the item's 90-day timer. **Show everything** lists every checked item, to set owners and rule evidence before anything is flagged.

Not covered yet: generated artifacts (they are opened by file path, with no per-artifact use record).

Selecting an issue opens its details: description, **Open linked task**, recent comments, and recent runs with their timeline.

If the work itself is being executed on another machine, pair Mission Control with **More > Devices** (**Team** in the Calm theme): Mission Control gives you company-level orchestration, while Devices gives you machine-level routing and remote task inspection.

---

## Strategic Planner

The strategic planner lives in **Operations > Planner**, where you configure and review company-ops planning:

- **Schedule runs** and **Auto-dispatch**
- **Interval** (at least 5 minutes)
- **Workspace** and **Agent** (Auto-pick by default)
- **Approval**: Manual, Safe autonomy or Founder edge
- **Run Planner** to run now
- **Recent Runs**, each showing what it created, updated and dispatched, with the issues it touched

This is the main desktop entry point for company planning loops.

---

## Agent Teams

Access from the **Agent teams** button in the header, with one workspace selected (the button is unavailable under All Workspaces). It opens the team management UI for coordinated multi-agent collaboration.

- **Create teams**: Name, description, lead agent, max parallel agents, model and personality preferences
- **Manage members**: Add/remove agents, reorder, provide guidance
- **Create team runs**: Execute coordinated multi-agent tasks
- **Multitask runs**: `/multitask [N] <task>` creates an ephemeral team run with lane-specific checklist items and uses the same tracking surfaces
- **Track items**: Shared checklists within a run with status tracking
- **Real-time events**: Live tracking of team activity (member changes, run status, item updates)
- **Graph-backed runs**: team work now rides on the same orchestration graph engine used by spawned agents and ACP delegation, so run state and projections stay consistent across surfaces

See [Features — Agent Teams](features.md#agent-teams) for more details.

## Managed Agents

Managed Agents are created and configured in **Workspace agents** on the Bots page, not inside Mission Control.

Current behavior:

- managed sessions are created through Workspace agents actions or the Control Plane
- each managed session creates a backing task
- team-mode managed sessions also create a backing team run
- Mission Control remains the main place to observe those backing tasks and team runs once they exist
- the selected-agent detail screen in Workspace agents does not host its own chat transcript; test, preview, and starter-prompt actions open the backing task in the main task UI

Use this together with [Managed Agents](managed-agents.md) when testing reusable agents from the app.

---

## Real-Time Updates

Mission Control subscribes to live event streams — no manual refresh needed:

| Event Stream             | What It Updates                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| **Heartbeat v3 events**  | Heartbeat agent counts, pulse and dispatch state, deferred state, feed items                     |
| **Activity events**      | Comments, mentions and assignments                                                               |
| **Learning events**      | Post-task learning progression in the open task's details                                        |
| **Task events**          | New tasks and status changes on the Work board                                                   |
| **Task board events**    | Column moves, priority changes, label/date updates                                               |
| **Runtime queue events** | Global running/waiting counts and queue task summaries in the Brief tab                          |
| **Team run events**      | Team and member changes, run progress, item status                                               |
| **Mention events**       | Pending mention count in header, mention list in task details                                    |

---

## Quick Reference

| Action                              | How                                                                        |
| ----------------------------------- | -------------------------------------------------------------------------- |
| Open Mission Control                | More > Mission Control; see the [release surface reference](release-surface-reference.md)                 |
| Add an agent                        | Header > Bots (Team in Calm)                                               |
| Change an agent's settings          | Team > **Edit agent**, or Bots > edit > **More settings**                  |
| Review core automation learning     | Operations > **Core Harness**                                              |
| Configure the company planner       | Operations > **Planner**                                                   |
| Inspect company ops                 | Operations > **Overview**                                                  |
| Trigger immediate heartbeat review  | **Wake owner** (lightning icon) on a Work board card                       |
| Move a task to a new stage          | Drag the card to the target column, or use its **Move to next stage**      |
| Put new work on the board           | Start a task from the composer; it appears on **Work** by itself           |
| View task details                   | Click any task card                                                        |
| Post an update on a task            | Select task, type in the comment box, click "Post Update"                  |
| Filter feed by agent                | Click an agent chip in the Evidence Feed                                   |
| Create a team                       | Header > Agent teams > create team                                         |
