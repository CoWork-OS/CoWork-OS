# Side Chat

Side Chat is a right-side conversation panel for asking questions about an active session while the parent session keeps running. It is designed for quick inspection, status checks, and clarification without steering, pausing, or replacing the work already in progress.

Use Side Chat when you want to ask things like:

- `How is it going in 1-2 sentences?`
- `Why did that command fail?`
- `What file is it editing right now?`
- `What is the latest visible status?`
- `What should I watch for before this finishes?`

Use the main composer instead when you want to change the active task, add instructions, approve work, cancel execution, or ask the agent to do something new.

## Starting Side Chat

Side Chat starts from the main task composer while a task is selected:

```text
/side
```

You can also launch it with the first question inline:

```text
/side how is it going?
```

CoWork opens a right-side Side Chat panel and keeps the parent task selected on the left. Follow-up questions typed into the Side Chat composer stay inside the side conversation. Closing the panel only hides the side conversation; it does not stop the parent task.

## Behavior Contract

Side Chat is a first-class session type with a stricter contract than a normal task fork:

| Guarantee | Behavior |
|-----------|----------|
| **Non-steering** | Side questions do not append instructions to the parent task, change the parent plan, cancel work, approve tools, or alter the active queue. |
| **Parent keeps running** | The active parent session continues independently while the side response is generated. |
| **Read-only chat** | Side Chat runs in chat execution mode with command tools unavailable, autonomous mode off, worktree creation off, and mutating tools denied. |
| **Hidden inherited context** | The side task can receive read-only parent transcript and runtime context, but cloned parent events are hidden from the visible Side Chat transcript. |
| **Visible side-only transcript** | The panel shows only messages asked and answered directly in Side Chat. It does not replay the original parent prompt or parent answers at the top of the panel. |
| **Fresh status checks** | Status/progress questions inject a live parent-status snapshot for that turn. The assistant must prefer that snapshot over older side-chat history. |
| **Markdown rendering** | Side answers render Markdown, including inline code, lists, and fenced code blocks. |

## Status Questions

For questions about current progress, Side Chat does not rely only on previous visible messages. The runtime builds a fresh parent-status block from the active parent task before the side turn runs.

The status snapshot can include:

- parent task status, title, model, and mode
- current runtime state, if the parent is active in memory
- current timeline stage or checklist state
- active, recent, completed, and failed steps
- recent parent task events and result/error summaries

The side assistant should answer from this live snapshot first. If the latest parent state does not contain newer evidence, the answer should say that explicitly instead of implying a fresh tool check occurred.

Examples of status-style prompts include:

- `how is it going?`
- `how is it going now?`
- `latest status?`
- `is it still running?`
- `what changed since I asked?`
- `is it done yet?`

## Relationship To Forked Sessions

Side Chat uses the same lineage idea as session forks, but it is not a normal editable branch.

A normal fork creates a new pending task from copied history, then lets the user steer that fork with a new prompt. Side Chat creates a side-specific fork that is immediately treated as read-only chat about the parent. It has independent side messages and can be opened as a full thread for inspection, but it must not mutate or steer the parent session.

See [Session Runtime](session-runtime.md) and [Execution Runtime Model](execution-runtime-model.md) for the broader session-fork lifecycle.

## User Interface

The Side Chat panel is anchored on the right side of the task workspace. It contains:

- a compact header with the parent task title and side task status
- a scrollable transcript containing only side-chat messages
- a bottom composer aligned with the main task composer height and send-button level
- a send action for side questions
- controls to close the panel or open the side conversation as a full task thread

The side composer accepts text questions only. Attachments and task-steering controls belong to the main composer.

## Security And Tooling Boundary

Side Chat should be safe to use while sensitive work is running because it is not an execution lane.

Side Chat is intentionally narrower than the parent [access profile](access-profiles.md). Selecting
Full access on the parent does not turn Side Chat into a command or filesystem execution surface.

- `source` is marked as `side_chat`
- `conversationMode` and `executionMode` are set to `chat`
- command tools are unavailable and the side session cannot widen its inherited access profile
- `requireWorktree` is disabled
- `autonomousMode` is disabled
- `toolRestrictions` contains the deny-all marker
- `allowedTools` is empty

This means Side Chat can explain what it can see from inherited and live parent context, but it should not claim that it ran commands, inspected files, changed state, or controlled the parent task.

## Implementation Landmarks

| Area | Files |
|------|-------|
| `/side` shortcut parsing | `src/shared/message-shortcuts.ts` |
| Side task type | `src/shared/types.ts` |
| Fork creation, hidden context, and live parent-status injection | `src/electron/agent/daemon.ts` |
| Side-chat prompt rules and chat-mode behavior | `src/electron/agent/executor.ts` |
| Tool deny-all enforcement | `src/electron/agent/runtime/ToolPolicyPipeline.ts` |
| IPC bridge | `src/electron/ipc/handlers.ts`, `src/electron/preload.ts` |
| Main app wiring | `src/renderer/App.tsx` |
| Main composer `/side` trigger | `src/renderer/components/MainContent/MainContent.tsx` |
| Side panel UI and Markdown rendering | `src/renderer/components/SideChatPanel.tsx`, `src/renderer/components/side-chat-panel.css` |

## Focused Checks

Run the focused Side Chat checks with:

```bash
npx vitest run \
  src/electron/agent/__tests__/daemon-fork-session.test.ts \
  src/electron/agent/__tests__/executor-chat-mode.test.ts \
  src/electron/agent/__tests__/tool-policy-pipeline.test.ts \
  src/renderer/components/__tests__/side-chat-panel.test.ts \
  src/renderer/components/__tests__/main-content-working-state.test.ts \
  src/shared/__tests__/message-shortcuts.test.ts
```

For broader validation after UI or prompt changes, also run:

```bash
npm run build:react
npm run build:electron
npm run build:daemon
```
