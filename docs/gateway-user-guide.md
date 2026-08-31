# Using CoWork from WhatsApp and Other Channels

This guide explains how to use CoWork from remote chat channels such as WhatsApp, Telegram, Slack, Discord, and other configured messaging integrations.

It focuses on daily usage: starting work, following up, stopping tasks, using temporary sessions, invoking skills, and getting scheduled results back in chat. For setup, see [Channel Integrations](channels.md). For per-channel features and best practices, see [Channel User Guides](channel-user-guides.md). For the lower-level lifecycle model, see [Gateway Message Lifecycle](gateway-message-lifecycle.md).

## Mental Model

Think of each chat as a remote control for CoWork.

You can:

- send a normal message to start a task
- send another normal message to add context to the current task
- use commands when you want to control the task lifecycle
- use skill slashes when you want a specific workflow
- receive progress, approvals, final answers, and scheduled results in the same chat

The most important rule is simple: ordinary text during a running task is treated as a follow-up, not as a new task.

If you want a new task, send `/new`. If you want to stop the current task, send `/stop`.

Admins can also specialize a channel, group/chat, or topic/thread in channel settings. When a specialization exists, new tasks from that scope automatically use its workspace, agent role, prompt guidance, tool restrictions, and shared-memory policy. Running tasks keep their existing workspace and role until they finish or you start fresh.

## Starting a Task

Send the task directly:

```text
Update the README with the new onboarding flow.
```

```text
Research the latest pricing for these three tools and summarize the differences.
```

```text
Draft a customer reply based on the last email thread.
```

CoWork will route the message into the selected workspace for that chat. If no workspace is selected, it may ask you to choose one or use the channel's default behavior.

If the chat has an admin-configured specialization, that specialization becomes the default for new tasks from that chat. Workspace router rules can still override it for a specific message when the workspace policy says so.

Best practices:

- Be specific about the desired output.
- Mention files, folders, links, or constraints up front when you know them.
- Use follow-up messages for corrections or extra context while the task is still running.
- Use `/new` before changing topics.

## Following Up on a Running Task

When a task is active, normal chat messages become follow-ups:

```text
Also make sure the examples use TypeScript.
```

```text
Ignore the old API section. That is deprecated.
```

```text
Use the shorter version and keep it under 500 words.
```

This is useful when you notice something mid-run. You do not need a command for ordinary context, corrections, or extra requirements.

If you want to make the follow-up more explicit, use:

```text
/queue Add tests for the retry behavior too.
```

Use `/queue <message>` when you want the text to clearly be handled as task input rather than a command or a new topic.

## Steering a Task

Use `/steer` for high-priority guidance during an active task:

```text
/steer Prioritize correctness over speed. Do not change public APIs.
```

```text
/steer Stop editing docs and focus only on the failing test.
```

Use this for corrections that should affect the current run immediately. For ordinary extra details, a normal message is usually enough.

Best practices:

- Keep steering messages short and directive.
- Use `/steer` for constraints, not for unrelated new work.
- If the task is going in the wrong direction entirely, use `/stop` and then start again.

## Starting Fresh Without Stopping the Old Task

Use `/new` or `/newtask` when you want the next message to start a new task:

```text
/new
```

Then send the new request:

```text
Now write a short launch announcement for the feature.
```

`/new` unlinks the chat from the current task. It does not cancel the old task. This is useful when a task can continue in the background but you want to move on in the chat.

Best practices:

- Use `/new` when changing topics.
- Use `/new` before asking an unrelated question while a task is still running.
- Use `/stop` instead if the old task should not continue.

## Stopping a Task

Use `/stop` or `/cancel` to cancel the active task:

```text
/stop
```

```text
/cancel
```

After cancellation, CoWork clears that chat's task association so late updates from the stopped task are not sent back into the chat.

Best practices:

- Use `/stop` when the task is wrong, obsolete, or no longer worth completing.
- Use `/new` instead when the task may continue but you want the chat to move on.
- After `/stop`, send a fresh task message with the corrected request.

## Temporary Sessions

Use `/new temp` for scratch work:

```text
/new temp
```

Then send a task:

```text
Prototype a small Node script that parses this CSV shape.
```

Temporary sessions are useful for experiments, one-off analysis, and work that should not attach to a normal project workspace.

CoWork hides temporary workspace paths from chat replies and from `/workspaces` so the workspace list stays focused on real user workspaces.

Best practices:

- Use `/new temp` for scratch prototypes, quick writing drafts, isolated analysis, or throwaway experiments.
- Use a real workspace when the task should edit project files or use project context.
- Do not expect temporary sessions to be a long-term project home.

## Checking Status

Use `/status` for gateway and task status:

```text
/status
```

Use `/task` for a current task snapshot:

```text
/task
```

Use `/queue` to inspect queued work:

```text
/queue
```

Best practices:

- Use `/task` when you want to know what CoWork thinks it is currently doing.
- Use `/queue` when multiple tasks or follow-ups may be waiting.
- Use `/status` when you are checking whether the channel is connected and responsive.

## Pausing and Resuming

Use:

```text
/pause
```

```text
/resume
```

Pause is useful when you need time to review, provide missing context, or stop the agent from continuing temporarily without cancelling the task.

Best practices:

- Use `/pause` when you intend to continue the same task.
- Use `/stop` when you do not want the task to continue.
- Send any missing context before `/resume`.

## Background Tasks

Use `/background`, `/bg`, or `/btw` to start a task that should not take over the current chat task:

```text
/background Prepare a short competitor summary for Linear, Asana, and Trello.
```

```text
/bg Check whether the docs mention the old product name.
```

```text
/btw Draft a weekly update from this workspace context.
```

Background tasks are useful for side work. They should be self-contained because they are intentionally unlinked from the active chat task.

Best practices:

- Use background tasks for independent work.
- Include enough context in the command itself.
- Do not use background tasks for urgent corrections to the active task; use a normal follow-up or `/steer`.

## Workspace Selection

Use `/workspaces` to list available workspaces:

```text
/workspaces
```

Use `/workspace` to select one:

```text
/workspace 2
```

```text
/workspace cowork
```

Temporary scratch workspaces are hidden from `/workspaces`.

Best practices:

- Select the workspace before asking CoWork to edit files.
- Use clear workspace names where possible.
- Use `/new temp` instead of adding a temporary folder to the normal workspace list.

## Commands and Help

Use `/help` for a compact reminder:

```text
/help
```

Use `/commands` for the fuller command catalog:

```text
/commands
```

Some channels support category views:

```text
/commands task
```

Best practices:

- Use `/help` when you only need the basics.
- Use `/commands` when looking for less common controls.
- If you type an unknown slash command, CoWork will tell you it is unknown instead of treating it as a task.

## Skill Slash Commands

Skills are specialized workflows. Use `/skills` to see what is available:

```text
/skills
```

Toggle a skill with:

```text
/skill skill-id
```

Run an enabled skill with its slash form:

```text
/simplify Make this proposal shorter and clearer.
```

```text
/batch Update every docs page that still uses the old term.
```

```text
/llm-wiki Build a research vault for agent workflow patterns.
```

Enabled skills can also be invoked by their skill slug:

```text
/react-best-practices Review this component architecture.
```

Best practices:

- Use skill slashes when you know the workflow you want.
- Use normal language when you want CoWork to choose the approach.
- Keep `/skill <id>` for toggling skills; use `/<skill-slug> args` to run one.
- If a skill is disabled, enable it first or ask CoWork to use another approach.

## Approvals

Tasks started from a channel use the target workspace's [access profile](access-profiles.md).
Command tools are available only when that profile exposes them; there is no separate shell
enable/disable command. A profile or administrator boundary can still deny an action after a user
has approved an individual request, and finite filesystem/domain scopes cannot be widened by an
approval shortcut.

When CoWork asks for approval, respond with:

```text
/approve
```

or:

```text
/yes
```

To reject:

```text
/deny
```

or:

```text
/no
```

Best practices:

- Read approval prompts carefully before approving.
- Use `/deny` when the requested action is too broad, risky, or no longer needed.
- Add a short follow-up after denial if you want CoWork to try a safer alternative.

## Scheduled Results in Chat

Scheduled tasks can deliver results back to a channel. The result is formatted and delivered through the same path as normal chat replies.

Examples:

```text
/schedule Every weekday at 9am, summarize new issues in this repo.
```

```text
/brief schedule morning
```

Scheduled tasks should produce the final result as task output. CoWork handles sending that output to the selected chat.

Best practices:

- Make scheduled prompts explicit about the desired final answer.
- Use `deliverOnlyIfResult` when empty successful runs should stay quiet.
- Include the relevant chat transcript variables only when the recurring job needs recent chat context.
- Avoid asking the scheduled task to message you directly; delivery is handled by the scheduler.

## WhatsApp-Specific Tips

WhatsApp supports a few conveniences:

- natural shortcuts such as `help`, `status`, `new task`, `new temp`, `stop`, `queue ...`, and `background ...`
- typing indicators while CoWork is working
- editable progress messages, so repeated progress updates can update one message instead of spamming the chat
- self-chat mode for using your personal "Message Yourself" thread
- response prefixes when you want bot replies to be visually distinct

Best practices:

- Use self-chat mode when connecting your personal WhatsApp number.
- Set a short response prefix if your own messages and CoWork replies are hard to distinguish.
- Use `/new temp` for scratch work instead of creating random temporary folders.
- Use `/commands` when you forget the exact slash form.

## Telegram Tips

Telegram exposes the core gateway commands in the bot's `/` menu after the bot connects.

Useful commands:

- `/new` and `/newtask` start the next message fresh.
- `/stop` and `/cancel` stop the active task.
- `/queue message` adds an explicit follow-up to the current task.
- `/steer guidance` sends high-priority guidance to the active task.
- `/background prompt` starts unlinked side work.
- `/commands` shows the full remote command catalog.

Best practices:

- Use the Telegram `/` menu for common controls.
- In groups, check the configured routing mode. Some groups route only mentions or commands.
- Reply to the bot or mention it when using Telegram group modes that require a mention.
- Telegram can show draft-style streaming for assistant text; concise follow-ups keep the chat easier to read.

## Discord Tips

Discord supports native slash commands for the core lifecycle controls.

Useful commands:

- `/new mode:temp` starts a scratch temporary session.
- `/stop` cancels the active task.
- `/commands category:task control` browses command groups.
- `/queue message:...` sends an explicit follow-up.
- `/steer guidance:...` steers the active task.
- `/background prompt:...` starts unlinked side work.
- `/task prompt:...` remains a compatibility shortcut for starting a task directly.

Best practices:

- Use `/task prompt:...` only when you want to start task text from Discord's native slash UI.
- Use `/status` for current state; `/task` in normal text channels is the gateway task snapshot command when delivered as text.
- In servers, confirm the bot has access to the channel and that the server is allowed by the channel configuration.
- In threads, CoWork preserves thread context where the adapter can provide it.

## Slack Tips

Slack can route messages from DMs, mentions, and registered slash commands. CoWork can handle the command text once Slack delivers it, but Slack slash commands must be registered in the Slack app configuration first.

Recommended Slack slash commands:

```text
/help
/commands
/status
/workspaces
/workspace
/new
/newtask
/stop
/cancel
/pause
/resume
/queue
/steer
/background
/skills
/skill
/schedule
/brief
/approve
/deny
/models
/providers
/agent
```

Manifest-style snippet:

```yaml
features:
  slash_commands:
    - command: /new
      description: Start the next CoWork message fresh
      usage_hint: "[temp]"
      should_escape: false
    - command: /stop
      description: Stop the active CoWork task
      should_escape: false
    - command: /commands
      description: Browse CoWork commands
      usage_hint: "[category]"
      should_escape: false
    - command: /queue
      description: Show queue status or add a task follow-up
      usage_hint: "[clear|message]"
      should_escape: false
    - command: /steer
      description: Send guidance to the active task
      usage_hint: "<guidance>"
      should_escape: false
    - command: /background
      description: Start unlinked side work
      usage_hint: "<prompt>"
      should_escape: false
```

Repeat that pattern for the remaining core commands you want visible in Slack. In Socket Mode setups, keep the existing Socket Mode receiver and app tokens; the command entries just make Slack deliver those slash payloads to CoWork.

Best practices:

- Register the core slash commands in the Slack app manifest or app settings.
- Use Slack DMs for personal work and channel mentions for shared work.
- Prefer `/queue message` or `/steer guidance` for active-task input in busy channels.
- Slack supports message edits for curated progress, so one progress message can be updated instead of sending repeated status messages.

## Common Patterns

Start a project task:

```text
/workspace cowork
Update the channel docs to mention editable WhatsApp progress.
```

Add context while it runs:

```text
Also mention that /stop cancels and /new only starts fresh.
```

Steer the task:

```text
/steer Keep this end-user facing. Avoid implementation details.
```

Move on without cancelling:

```text
/new
Draft a short changelog entry for the same feature.
```

Cancel and restart:

```text
/stop
Rewrite the request from scratch: focus only on WhatsApp, not all channels.
```

Use scratch mode:

```text
/new temp
Create a quick outline for a support article about remote commands.
```

Run a skill:

```text
/simplify Make this announcement clearer for non-technical users.
```

Run side work:

```text
/background Check if any docs still mention the old command list.
```

## Troubleshooting

If CoWork does not respond:

- send `/status`
- check that the channel is enabled
- check self-chat or group routing settings
- confirm the sender is allowed by the channel security mode
- use `/workspaces` to confirm the chat has a usable workspace

If a message went to the wrong task:

- use `/new` before changing topics
- use `/task` to inspect the active task
- use `/stop` if the active task should be cancelled

If a slash command does not work:

- send `/commands`
- check spelling and aliases
- use `/skills` if it is a skill command
- enable the skill with `/skill <id>` if needed

If progress messages look noisy:

- prefer WhatsApp or channels with editable progress where available
- use concise follow-ups
- avoid repeatedly sending unrelated messages into an active task

## Quick Reference

| Goal | Command |
|------|---------|
| Show help | `/help` |
| Show command catalog | `/commands` |
| Check status | `/status` |
| Show current task | `/task` |
| Start next message fresh | `/new` |
| Start scratch temporary session | `/new temp` |
| Stop active task | `/stop` |
| Pause active task | `/pause` |
| Resume active task | `/resume` |
| Send explicit follow-up | `/queue <message>` |
| Steer active task | `/steer <guidance>` |
| Start side work | `/background <prompt>` |
| List workspaces | `/workspaces` |
| Select workspace | `/workspace <name or number>` |
| List skills | `/skills` |
| Toggle skill | `/skill <id>` |
| Run skill | `/<skill-slug> args` |
| Approve action | `/approve` or `/yes` |
| Deny action | `/deny` or `/no` |
