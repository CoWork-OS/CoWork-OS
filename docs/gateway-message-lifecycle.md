# Gateway Message Lifecycle

CoWork's messaging gateway handles remote chat messages as task lifecycle events, not just as raw chat text. This applies to WhatsApp and the other channel adapters that route messages into the desktop or daemon task runtime.

This page covers message handling after a channel is connected. Channel setup, pairing, allowlists, and QR/auth flows remain documented in [Channel Integrations](channels.md). For practical command examples, see [Using CoWork from WhatsApp and Other Channels](gateway-user-guide.md). For per-channel feature and best-practice guidance, see [Channel User Guides](channel-user-guides.md).

## Incoming Messages

Every inbound message follows the same high-level path:

1. The channel adapter receives the provider event and normalizes it into a gateway message.
2. Gateway security checks apply pairing, allowlists, group routing, self-chat mode, and ambient-mode policy.
3. The router resolves the chat session, channel specialization, selected workspace, preferred role, and any current task association.
4. Slash commands and WhatsApp natural shortcuts are routed through the remote command registry.
5. Non-command text is handled by the task session controller as a new task or a follow-up to the active task.
6. Replies, progress, approvals, cancellations, and scheduled-task outputs are delivered through one shared delivery service.

Recognized commands are never forwarded to the agent as ordinary task text. Unknown slash commands return an explicit unknown-command response so accidental `/something` messages do not start unintended work.

## Channel Specialization

Before creating a new task, the router checks whether the channel, chat/group, or topic/thread has an enabled specialization. A specialization can provide a workspace, agent role, prompt guidance, tool restrictions, gateway context, and shared-memory opt-in.

Specialization lookup uses the most specific matching record:

1. `channelId + chatId + threadId`
2. `channelId + chatId`
3. channel-level default

If no specialization matches, the gateway falls back to the existing channel config, chat session preference, and normal workspace selection behavior.

Workspace-local router rules still run for each message. Their explicit role or workspace choice takes precedence over specialization for that message. Otherwise the role order is router rule, specialization, session preference, then channel default. Tool restrictions are merged with context-policy restrictions using deny-first behavior.

### Access profile on channel ingress

New tasks created from a channel inherit the selected workspace's default [access profile](access-profiles.md)
unless the ingress path supplies an explicit profile. Channel specialization and context policy can
further restrict the task, but they cannot widen the profile or reintroduce a separate shell
enable/disable decision. Follow-ups keep the profile already attached to the active task; use a
fresh task when a different profile is required.

Command tools, filesystem access, network/domain scope, sandboxing, and approvals are enforced by
the daemon on the target workspace. An unavailable named profile fails closed and is surfaced as a
task needing attention rather than silently using a broader profile.

Active follow-ups do not reassign the task's workspace or role. When a chat already has a running task, ordinary text is delivered to that task under the existing task configuration. Once the active task is completed, failed, cancelled, or unlinked with `/new`, the next normal message resolves specialization again before starting a fresh task.

## Active Task Policy

Ordinary remote text sent while a task is running is treated as a follow-up to that task. This keeps chat usage natural: send more context, corrections, files, or constraints without needing a special command.

Use explicit commands when you want to change the task lifecycle:

| Command | Behavior |
|---------|----------|
| `/stop`, `/cancel` | Cancel the running daemon task and clear the chat's task association. |
| `/new`, `/newtask` | Unlink the chat from the current task without cancelling that task. The next ordinary message starts fresh. |
| `/new temp`, `/newtask temp` | Start a fresh temporary workspace session for scratch work. Temporary workspace paths are hidden from command replies and workspace lists. |
| `/pause`, `/resume` | Pause or resume the active task. |
| `/status`, `/task` | Inspect gateway status or the current task snapshot. |

The gateway tracks task ownership and generation state for each chat. If a task produces late updates after `/new`, `/newtask`, `/stop`, or `/cancel`, those stale updates are not sent back into the chat.

## Remote Commands

The remote command registry defines command names, aliases, descriptions, categories, and active-task behavior. Send `/commands` from a channel for the compact command menu, or `/commands <category>` for a focused list when supported.

Telegram and Discord use this registry to populate their native command menus for the core lifecycle commands. Slack routes the same commands after they are registered in the Slack app. Dynamic skill slugs are not registered as native platform slash commands; use `/skills` to discover them and type `/<skill-slug> args` in channels that deliver that text to CoWork.

Core commands:

| Command | Description |
|---------|-------------|
| `/help` | Show the compact channel help. |
| `/commands` | Show the command catalog. |
| `/status` | Show gateway and task status. |
| `/workspaces` | List non-temporary workspaces. |
| `/workspace <name or number>` | Select a workspace for the chat. |
| `/new`, `/newtask` | Fresh task association for the next message. |
| `/new temp` | Fresh temporary workspace session. |
| `/stop`, `/cancel` | Stop the active task. |

Task-flow commands:

| Command | Description |
|---------|-------------|
| `/queue` | Show queue status. |
| `/queue clear` | Clear queued work where supported. |
| `/queue <message>`, `/q <message>` | Add a follow-up message to the current task. |
| `/steer <guidance>` | Send high-priority guidance to the current task. |
| `/background <prompt>` | Start an unlinked background task. |
| `/bg <prompt>`, `/btw <prompt>` | Short aliases for `/background`. |
| `/retry` | Retry a failed task. |

Approval and settings commands:

| Command | Description |
|---------|-------------|
| `/approve`, `/yes` | Approve a pending action. |
| `/deny`, `/no` | Deny a pending action. |
| `/brief`, `/schedule`, `/digest`, `/followups`, `/inbox` | Run channel-friendly productivity workflows. |
| `/models`, `/model <name>`, `/providers`, `/provider <name>` | Inspect or change model/provider routing. |
| `/agent`, `/agents`, `/agent <name|id|clear>` | Inspect or choose the preferred agent role for the chat. |

WhatsApp also maps common plain-language shortcuts such as `help`, `status`, `new task`, `new temp`, `stop`, `queue ...`, `q ...`, `steer ...`, `background ...`, and `btw ...` into their slash-command equivalents before routing.

## Skill Slash Commands

Bundled and enabled skills can be invoked from gateway channels with slash syntax.

| Command | Behavior |
|---------|----------|
| `/skills` | List skills and show the runnable slash form for enabled skills. |
| `/skill <id>` | Toggle a skill on or off for the profile. |
| `/simplify [objective]` | Run the simplify workflow. |
| `/batch <objective>` | Run the batch workflow. |
| `/llm-wiki <objective>` | Run the research-vault workflow. |
| `/<skill-slug> args` | Invoke an enabled skill by its slash alias or skill slug. |

If a skill alias points to a disabled or missing skill, the gateway returns an actionable error instead of treating the slash text as a normal task.

## Outbound Delivery

All remote output goes through the channel delivery service:

- command replies
- task acknowledgements
- progress updates
- final answers
- cancellation notices
- approval prompts
- scheduled-task results

The delivery service centralizes idempotency keys, message logging, response prefixing, simple-channel formatting, markdown conversion, chunking, and delivery-error handling. This keeps normal replies, command replies, and automated outputs consistent.

WhatsApp supports typing indicators and editable progress messages. When a task has a progress message, later progress replaces that message where possible. If editing fails, CoWork falls back to sending a new message. Long messages remain chunked around the provider-safe 4000-character range, and existing media attachment behavior is unchanged.

## Scheduled Task Delivery

Scheduled tasks use the same delivery path as live chat replies. Channel delivery applies the scheduled run idempotency key, normalizes markdown for simple channels, and uses the outbox retry path when a delivery failure occurs.

Scheduled prompts should produce the final result as normal task output. The scheduler handles delivery to the selected channel, so scheduled tasks should not try to message the user directly from inside the task.

`deliverOnlyIfResult` still suppresses empty successful runs, and chat transcript template variables such as `{{chat_messages}}` and `{{chat_since}}` remain available for chat-aware recurring jobs.
