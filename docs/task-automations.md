# Task Automations

Task automations turn an existing task into a recurring scheduled task without leaving the task view.

They are intentionally a bridge into CoWork's existing `Scheduled Tasks` engine, not a separate Codex heartbeat system and not a new `Routine` object. Use this flow when a one-off task proves useful enough to repeat.

## Where It Fits

CoWork's current automation model has three layers:

- `Workflow Intelligence` is the always-on cognitive runtime.
- `Routines` are the primary saved automation product for policy, triggers, outputs, and observability.
- `Scheduled Tasks` are the lower-level cron-backed execution engine used directly by advanced users and as a compiled backend for schedules.

Task automations use the third layer. They create a real cron scheduled task from a selected task by calling the same scheduler API used by `Settings > Automations > Scheduled Tasks`.

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
- `taskTitle`: current task title
- `prompt`: current task prompt
- `workspaceId`: current task workspace
- `description`: `Created from task <taskId>` plus the task deeplink
- `taskPrompt`: the edited automation prompt plus a source reference containing the original task title, task ID, and deeplink

The modal includes:

- a large prompt editor prefilled from the task
- a footer `Run in` selector
- an editable automation name control
- a schedule selector
- `Cancel` and `Save`
- a `Use template` view with built-in template prompts

`Save` is disabled until the name, prompt, workspace, and schedule are valid. If scheduler creation fails, the modal shows the returned error inline and stays open.

## Run Modes

`Chat` is the default run mode. It creates the safest unattended automation:

- `shellAccess: false`
- `allowUserInput: false`

`Local` runs in the current workspace and enables shell access:

- `shellAccess: true`
- `allowUserInput: false`

`Worktree` is shown only for tasks with a worktree path. It is currently disabled because the cron creation API stores a workspace target but does not yet preserve an individual task worktree execution context. The UI should make that limitation visible instead of silently creating a job in the wrong place.

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

Built-in templates cover common scheduled-task examples:

- daily summary
- scan recent changes
- CI failure summary
- weekly update
- inbox check-in
- regression watch

Templates are deliberately small and local to the task automation modal. They are starting points for the scheduled-task prompt, not separate managed routines.

## Scheduler Payload

Saving calls `window.electronAPI.addCronJob` with a `CronJobCreate` payload:

```ts
{
  name,
  description,
  enabled: true,
  shellAccess,
  allowUserInput: false,
  deleteAfterRun: false,
  schedule,
  workspaceId,
  taskTitle,
  taskPrompt,
}
```

The resulting job appears in `Settings > Automations > Scheduled Tasks` and uses the normal cron runtime, history, enable/disable behavior, and scheduler persistence.

## Current Limitations

- Task automations create cron scheduled tasks directly; they do not create a high-level `Routine`.
- Worktree execution context is not preserved yet, so `Worktree` is visibly disabled when the current task has a worktree.
- Automations are unattended by default: `allowUserInput` is false. A prompt that requires interactive clarification should be rewritten before saving.
- Remote-session task views should not create local automations from the remote shadow task.

## Implementation Notes

The task automation UI is implemented in `src/renderer/components/MainContent.tsx`.

Important helper exports:

- `TaskAutomationModal`
- `TASK_AUTOMATION_TEMPLATES`
- `buildTaskAutomationSchedule`
- `buildTaskAutomationPrompt`
- `buildTaskAutomationCronJobCreate`

The focused renderer test coverage lives in `src/renderer/components/__tests__/main-content-working-state.test.ts` and verifies:

- modal defaults from a selected task
- default `Every 30m` scheduler payload
- template defaults
- `Local` run mode enabling `shellAccess`

When changing this flow, run:

```bash
npx vitest run src/renderer/components/__tests__/main-content-working-state.test.ts
npm run build:react
```
