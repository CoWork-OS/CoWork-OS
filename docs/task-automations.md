# Task Automations

Task automations turn an existing task into scheduled or triggered follow-up work without leaving the task view. By default, they continue the same conversation thread so future runs keep the context that was already built up.

<p align="center">
  <img src="../resources/branding/images/cowork-os-6.webp" alt="Automations dashboard" width="700">
  <br><em>Task-sourced prompt automations and their compiled scheduled work remain visible in the advanced Automations settings.</em>
</p>

## Where It Fits

CoWork's automation model has four related layers:

- `Workflow Intelligence` is the always-on cognitive runtime.
- main-sidebar `Automation Studio` builds versioned deterministic multi-step flows.
- `Routines` are the shared saved-automation shell and the prompt-based product for instructions, targets, triggers, outputs, policy, and observability.
- `Scheduled Tasks`, `Webhooks`, and `Event Triggers` are lower-level execution engines used directly by advanced users and as compiled backends for routines.

Task automations create task-sourced `Routines`. A routine can then compile to the lower-level engine that matches its trigger:

- schedule triggers compile into `Scheduled Tasks`
- API triggers compile into `Webhooks`
- event triggers compile into `Event Triggers`

This keeps the task menu on the prompt-based Routine path while still using the durable cron, hook, and event infrastructure underneath. Use [Automation Studio](automation-studio.md) when the automation needs an explicit structured action graph, variables, branches, dry-run scope review, or step-level approvals.

## Task Overflow Menu

In task view, the task title includes a three-dot overflow menu. The menu exposes actions that are supported by the current task surface:

- `Pin task` / `Unpin task`
- `Rename task`
- `Archive task`
- `Copy working directory`
- `Copy task ID`
- `Copy deeplink`
- `Copy as Markdown`
- `Fork session`
- `Add automation...`
- `View outputs` when task outputs are available

`Copy deeplink` copies `cowork://tasks/<taskId>`. The app handles that URL by reopening the matching task, so copied links can be pasted into another task, a note, or an external place that can launch the CoWork URL scheme.

## Add Automation Flow

Clicking `Add automation...` opens an `Add automation` modal over the current task.

Defaults come from the selected task:

- `name`: current task title
- `prompt`: current task prompt
- `workspaceId`: current task workspace
- `target`: `Continue thread`
- `description`: `Created from task <taskId>` plus the task deeplink
- saved instructions: the edited automation prompt plus a source reference containing the original task title, task ID, and deeplink

The modal includes:

- a large prompt editor prefilled from the task
- a footer `Run in` selector
- a `Target` selector for `Continue thread` or `New task`
- an editable automation name control
- a schedule selector
- `Cancel` and `Save`
- a `Use template` view with built-in template prompts

`Save` is disabled until the name, prompt, workspace, target, and schedule are valid. If routine creation fails, the modal shows the returned error inline and stays open.

## Target Modes

`Continue thread` is the default. Scheduled, API, and event-triggered runs append a follow-up message to the source task, preserving the conversation context and timeline. This is the closest equivalent to Codex-style thread wakeups.

`New task` creates a standalone run for each automation execution. Use this when the recurring work should not mutate or lengthen the original conversation.

Worktree execution is not compatible with `Continue thread`. The UI prevents that combination, and lower-level worktree automation payloads force `New task` so a worktree run never silently targets an existing thread without the right execution context.

## Run Modes

`Chat` is the default run mode. It creates the safest unattended automation:

- `shellAccess: false`
- `allowUserInput: false`

`Local` runs in the current workspace and enables shell access:

- `shellAccess: true`
- `allowUserInput: false`

`Worktree` is shown only for tasks with a worktree path. It is disabled for same-thread automations because a thread follow-up must run against the original task context, while a worktree automation needs an isolated run target.

## Schedule Presets

The modal supports these presets:

| Preset | Scheduler payload |
|--------|-------------------|
| `Every 30m` | `{ kind: "every", everyMs: 1800000 }` |
| `Hourly` | `{ kind: "every", everyMs: 3600000 }` |
| `Daily` | `{ kind: "cron", expr: "0 9 * * *" }` |
| `Weekdays` | `{ kind: "cron", expr: "0 9 * * 1-5" }` |
| `Weekly` | `{ kind: "cron", expr: "0 9 * * 1" }` |
| `Custom` | user-entered cron expression |

Custom schedules use the existing cron-expression path and are invalid until the expression is non-empty.

## Templates

`Use template` opens a compact template grid. Selecting a template returns to the create modal and fills:

- automation name
- prompt
- schedule preset

Built-in templates cover common recurring examples:

- daily summary
- scan recent changes
- CI failure summary
- weekly update
- inbox check-in
- regression watch

Templates are deliberately small and local to the task automation modal. They are starting points for routine instructions, not separate managed agents.

## Compiled Payloads

Saving calls `window.electronAPI.createRoutine` with a task-sourced routine payload.

For schedule triggers, the routine service creates a cron job. Same-thread schedules use:

```ts
{
  runMode: "thread_follow_up",
  targetTaskId,
  threadAutomation: {
    source: "routine",
    routineId,
    taskId: targetTaskId,
  },
}
```

New-task schedules use the normal `runMode: "new_task"` cron path.

For API triggers, the routine service creates a webhook mapping with `action: "task_message"` when the target is `Continue thread`. The handler sends the request body as a follow-up to the target task and only includes the task ID in the response when the mapping explicitly asks for it.

For event triggers, the routine service creates an event trigger whose action carries the same run target. A `thread_follow_up` event trigger must include `targetTaskId`; invalid configurations fail instead of falling back to a new task.

Automation-specific agent settings are applied as transient run overrides. They do not overwrite the saved agent configuration on the target task.

## Monitoring Results

`Settings > Automations > Routines` is the primary place to inspect task-sourced automations because it owns the saved instruction, trigger, target, policy, and recent routine run state.

When a task automation compiles to a scheduled task, `Settings > Automations > Scheduled Tasks` also shows the lower-level cron job. The panel summarizes:

- total scheduled tasks and active tasks
- aggregate run success rate
- the next scheduler wake-up and any currently running job
- jobs needing attention because their latest run failed, timed out, or needs user action
- whether a job creates a new task or continues an existing thread

Expanding a scheduled task shows:

- the latest run status in plain language
- total run count, success rate, and latest duration
- delivery state for channel-backed scheduled outputs
- latest error text when a run or delivery failed
- a run-folder indicator when the scheduler created a dedicated run workspace
- a direct `Open generated task` or thread link when available

The run-history ledger keeps recent runs together with status, duration, delivery outcome, and an `Open` action for each generated task or target thread. `Refresh` reloads scheduler history from the cron service, while `Clear` removes the scheduler history counters for that job without deleting task sessions.

## Current Limitations

- Automations are unattended by default: `allowUserInput` is false and human-input policy is effectively `none`. A prompt that requires interactive clarification should be rewritten before saving.
- Worktree execution cannot continue an existing thread. Choose `New task` for worktree-style automation.
- Remote-session task views should not create local automations from the remote shadow task.

## Implementation Notes

The task automation UI is implemented in `src/renderer/components/MainContent.tsx`.

Important helper exports:

- `TaskAutomationModal`
- `TASK_AUTOMATION_TEMPLATES`
- `buildTaskAutomationSchedule`
- `buildTaskAutomationPrompt`
- `buildTaskRoutineCreate`
- `buildTaskAutomationCronJobCreate` for low-level scheduled-task payload coverage

The focused renderer test coverage lives in `src/renderer/components/__tests__/main-content-working-state.test.ts` and verifies:

- modal defaults from a selected task
- default `Every 30m` schedule payload
- default same-thread target
- template defaults
- `Local` run mode enabling `shellAccess`
- worktree target protection

When changing this flow, run:

```bash
npx vitest run src/renderer/components/__tests__/main-content-working-state.test.ts
npm run build:react
```
