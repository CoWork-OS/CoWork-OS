# Channel User Guides

This guide explains how to use each CoWork messaging channel after it is connected. It focuses on end-user behavior, best practices, and channel-specific strengths rather than setup details.

For setup steps, see [Channel Integrations](channels.md). For shared command behavior, see [Gateway Message Lifecycle](gateway-message-lifecycle.md). For daily command examples, see [Using CoWork from WhatsApp and Other Channels](gateway-user-guide.md).

Admins can configure [Channel Specialization](channels.md#channel-specialization) for a whole channel, specific chat/group, or topic/thread so new tasks from that scope default to the right workspace, agent role, prompt guidance, tool restrictions, and shared-memory policy.

## Separate Channel Guides

Use these dedicated guides when you want channel-specific details without scanning the full comparison page:

| Channel | Dedicated guide |
|---------|-----------------|
| WhatsApp | [WhatsApp User Guide](channel-guides/whatsapp.md) |
| Telegram | [Telegram User Guide](channel-guides/telegram.md) |
| Discord | [Discord User Guide](channel-guides/discord.md) |
| Slack | [Slack User Guide](channel-guides/slack.md) |
| Microsoft Teams | [Microsoft Teams User Guide](channel-guides/microsoft-teams.md) |
| Google Chat | [Google Chat User Guide](channel-guides/google-chat.md) |
| Feishu / Lark | [Feishu / Lark User Guide](channel-guides/feishu-lark.md) |
| WeCom | [WeCom User Guide](channel-guides/wecom.md) |
| iMessage | [iMessage User Guide](channel-guides/imessage.md) |
| Signal | [Signal User Guide](channel-guides/signal.md) |
| Mattermost | [Mattermost User Guide](channel-guides/mattermost.md) |
| Matrix | [Matrix User Guide](channel-guides/matrix.md) |
| Twitch | [Twitch User Guide](channel-guides/twitch.md) |
| LINE | [LINE User Guide](channel-guides/line.md) |
| BlueBubbles | [BlueBubbles User Guide](channel-guides/bluebubbles.md) |
| Email | [Email User Guide](channel-guides/email.md) |
| X Mention Triggers | [X Mention Triggers User Guide](channel-guides/x-mention-triggers.md) |

## Shared Usage Model

All messaging channels use the same core gateway model:

- Send a normal message to start a task.
- Send normal text during a running task to add a follow-up.
- Use `/new` to make the next message start fresh without cancelling the old task.
- Use `/stop` or `/cancel` to stop the active task.
- Use `/commands` for the command catalog.
- Use `/skills` to see enabled skills and `/<skill-slug> args` to run one where the platform delivers typed slash text.
- Scheduled results, final answers, approvals, cancellations, and task progress are delivered back through the same channel delivery path.
- New tasks use the target workspace's [access profile](access-profiles.md); command tools,
  sandboxing, filesystem scope, network/domain scope, and approvals follow that profile.

Best practices for every channel:

- Pick one channel per workflow when possible so context stays coherent.
- Use channel specialization for dedicated groups, channels, or topics that should always start in the same workspace or role.
- Select the workspace before asking CoWork to edit project files.
- Use `/new` before changing topics.
- Use `/new temp` for scratch work that should not attach to a normal project workspace.
- Use `/stop` when the current task should not continue.
- Use `/queue <message>` or `/steer <guidance>` when an active task needs explicit direction.
- Keep high-risk approvals in direct messages or private channels.
- Do not treat a channel message or approval response as a way to widen a finite access-profile
  scope. Start a fresh task after selecting a different profile.

## WhatsApp

Best for:

- Personal mobile control from the "Message Yourself" chat.
- Quick task starts, follow-ups, approvals, and daily briefs.
- Lightweight research channels where groups post links for later analysis.

Features:

- QR-based WhatsApp Web connection.
- Self-chat mode for personal use.
- Natural shortcuts such as `help`, `status`, `new task`, `new temp`, `stop`, `queue ...`, and `background ...`.
- Typing indicators.
- Editable progress messages where provider support allows it.
- Optional response prefix to distinguish CoWork replies.
- Link-research group support.

Best practices:

- Use self-chat mode when connecting your personal WhatsApp number.
- Use a short response prefix if CoWork replies are hard to distinguish from your own messages.
- Use `/new temp` for quick experiments, drafts, and one-off analysis.
- Use `/workspaces` only for real workspaces; temporary workspaces are intentionally hidden.
- In groups, choose a routing mode that matches the room: mention/command routing for busy groups, all-message routing for dedicated task rooms.
- Keep approvals in self-chat or trusted groups.

Watch-outs:

- WhatsApp is excellent for compact task control, but not ideal for long code review output.
- Group routing can become noisy if every message is routed to CoWork.
- Media behavior should stay simple: attach files when needed, but use a desktop workspace for large file-heavy workflows.

## Telegram

Best for:

- Power users who want a native slash menu.
- Private bot chats for task control.
- Groups that need configurable mention/command routing.
- Link-research rooms.

Features:

- Bot command menu populated with core remote commands.
- DM, group, and topic/thread support where Telegram provides context.
- Group routing modes: all, mentions only, mentions or commands, commands only.
- Allowed group chat IDs.
- Reactions and draft-style streaming behavior for responsive feedback.
- Attachment and voice handling where supported.

Best practices:

- Use the Telegram `/` menu for common commands such as `/new`, `/stop`, `/queue`, `/steer`, and `/background`.
- In groups, use commands-only or mentions-or-commands mode unless the group is dedicated to CoWork tasks.
- Use `/queue <message>` when adding context from a busy group.
- Use `/steer <guidance>` for task-critical corrections.
- Use dedicated research groups for link capture instead of mixing research links into general task rooms.

Watch-outs:

- Telegram groups can have many messages quickly; permissive routing may create unintended tasks.
- If multiple users share one group session, agree on who owns task direction before approving actions.
- Long outputs are better summarized in Telegram and inspected in the desktop app when detail matters.

## Discord

Best for:

- Team or community workspaces.
- Engineering groups that want native slash commands, threads, and richer task interactions.
- Supervisor-style workflows with dedicated coordination channels.
- Fetching live Discord messages and attachments for agent context.

Features:

- Native slash commands for core lifecycle controls.
- DM and server channel support.
- Guild allowlists.
- Thread-aware routing where Discord provides thread context.
- Buttons, select menus, embeds, and approval controls.
- Live Discord message fetch and attachment download tools.
- Optional supervisor mode for structured worker/supervisor operations.
- `/task <prompt>` compatibility shortcut for starting a task from native slash UI.

Best practices:

- Use `/new mode:temp` for scratch tasks from Discord.
- Use `/status` for state and `/commands` for the command catalog.
- Use `/task prompt:...` only when you intentionally want to start task text from the Discord slash UI.
- Use threads for focused task discussions.
- Restrict guild IDs if the bot is installed in multiple servers.
- Keep supervisor mode in dedicated channels so normal chat does not mix with coordination protocol messages.

Watch-outs:

- Discord slash commands must be registered and may take time to propagate globally.
- Message Content Intent must be enabled for normal text routing.
- In large servers, avoid all-channel access unless the bot is meant to be broadly available.

## Slack

Best for:

- Workplace teams that already coordinate in Slack.
- Channel mentions and direct-message workflows.
- Curated task progress in shared operational channels.
- Multi-workspace Slack installations in one CoWork profile.

Features:

- Socket Mode integration.
- DM and `@mention` routing.
- Registered Slack slash command payload routing.
- Multiple Slack workspace installations.
- File uploads.
- Editable progress messages in curated progress mode.
- Optional minimal or curated progress relay.

Best practices:

- Register the core Slack slash commands you want users to see, such as `/new`, `/stop`, `/commands`, `/queue`, `/steer`, and `/background`.
- Use DMs for personal tasks and approvals.
- Use channel mentions for shared tasks.
- Use curated progress in operational channels where short status updates are valuable.
- Use minimal progress in noisy channels.
- Keep one Slack channel tied to one kind of recurring work when possible.

Watch-outs:

- Slack does not deliver unregistered slash commands to CoWork.
- Socket Mode still requires correct app-level and bot tokens.
- Avoid broad channel access if only a few channels should route tasks.

## Microsoft Teams

Best for:

- Microsoft 365 organizations.
- Enterprise teams that prefer Teams chats and channels.
- Approval-heavy workflows where users live in Teams.

Features:

- Bot Framework integration.
- Direct messages and channel mentions.
- Adaptive Card formatting.
- File attachment support.
- Auto-reconnect behavior.

Best practices:

- Use DMs for personal tasks, approvals, and sensitive context.
- Use channel mentions for shared work.
- Keep Teams app installation scoped to the teams/channels that should use CoWork.
- Use `/new` before switching from one operational topic to another.
- Use scheduled delivery for routine summaries into team channels.

Watch-outs:

- Setup depends on Azure Bot credentials and Teams channel configuration.
- Tenant and app policies can affect whether users can install or message the bot.
- Long outputs are usually better summarized in-channel with details available in CoWork.

## Google Chat

Best for:

- Google Workspace organizations.
- Spaces and DMs where teams already coordinate around Google tools.
- Recurring summaries into shared spaces.

Features:

- Google Chat app integration.
- Spaces and direct messages.
- Threaded conversations.
- Service-account based setup.

Best practices:

- Use DMs for personal work and approvals.
- Use spaces for shared team workflows and scheduled summaries.
- Keep prompts explicit about the final channel output so scheduled jobs produce concise results.
- Use `/new` when moving between unrelated space topics.

Watch-outs:

- Google Chat bots require Google Workspace support.
- Admin configuration can affect where the app is available.
- Service account permissions should be scoped and managed carefully.

## Feishu / Lark

Best for:

- Teams using Feishu or Lark as their primary enterprise chat.
- Tenant-specific bot deployments.
- Internal operational workflows with signed/encrypted events.

Features:

- Webhook and app-credential gateway support.
- Secure webhook verification.
- Encrypted event handling.
- Channel-style task ingress and replies.

Best practices:

- Use a dedicated app per tenant or organization.
- Keep bot access scoped to the spaces where CoWork should operate.
- Use commands for lifecycle control in busy groups.
- Prefer direct chats for approvals and sensitive task context.

Watch-outs:

- Enterprise app permissions and callback URLs must be correct.
- Best used as a deliberate tenant deployment rather than a casual personal channel.

## WeCom

Best for:

- Enterprise WeCom workspaces.
- Internal operations, alerts, and approval workflows.
- Controlled corporate environments.

Features:

- WeCom app integration.
- Signed and encrypted event routing.
- Enterprise bot credentials.
- Channel replies for tasks and scheduled results.

Best practices:

- Use WeCom for structured internal workflows, not broad ad hoc task intake.
- Keep command usage explicit in groups.
- Restrict access to the departments or conversations where CoWork should operate.
- Use scheduled summaries for operational reporting.

Watch-outs:

- Requires correct Corp ID, Agent ID, Secret, token, and EncodingAESKey.
- Corporate admin policies may affect delivery and visibility.

## iMessage

Best for:

- macOS users who want native Apple Messages access.
- Personal direct-message control from Apple devices.
- Lightweight task starts and approvals.

Features:

- Native macOS integration through the `imsg` CLI.
- Direct message task control.
- Self-message capture behavior where configured.

Best practices:

- Use a dedicated Apple ID for the bot Mac.
- Use direct messages for task control.
- Keep messages concise; use the desktop app for large outputs and file-heavy work.
- Use `/new` before changing topics.

Watch-outs:

- Requires macOS and Messages app access.
- Full Disk Access and CLI setup are needed.
- Not ideal for multi-user team routing compared with Slack, Discord, or Teams.

## Signal

Best for:

- Privacy-sensitive direct messaging.
- Small trusted groups with clear sender policies.
- Mobile-first task control with encrypted transport.

Features:

- signal-cli integration.
- Direct and group sender policies.
- Trust modes for identity handling.
- Native or daemon operating mode.
- Allowlist support.

Best practices:

- Use a dedicated Signal number for production.
- Use allowlists for both DMs and groups.
- Choose trust mode deliberately; manual trust is safer but more operational work.
- Keep approvals in direct chats.
- Use commands in groups to reduce accidental task starts.

Watch-outs:

- Registering signal-cli can deregister an existing Signal app for that number.
- Signal identity changes require attention.
- Large or highly formatted outputs are better reviewed in CoWork.

## Mattermost

Best for:

- Self-hosted team chat environments.
- Engineering or operations teams already using Mattermost.
- Real-time channel-based task routing.

Features:

- REST API plus WebSocket real-time messaging.
- Personal access token setup.
- Optional Team ID scoping.
- Message edits where supported by the adapter.

Best practices:

- Use dedicated task channels for shared CoWork work.
- Scope the bot to the relevant team.
- Use commands in busy channels.
- Use scheduled summaries for recurring team updates.

Watch-outs:

- Server URL and token permissions must match the target Mattermost instance.
- Self-hosted network and TLS configuration can affect connectivity.

## Matrix

Best for:

- Federated rooms.
- Open protocol teams using Element or other Matrix clients.
- Cross-homeserver collaboration where room-based routing is useful.

Features:

- Homeserver and access-token configuration.
- Room-based conversations.
- Federated messaging.
- Typing support where enabled.
- Message editing support depends on adapter/platform capability.

Best practices:

- Use dedicated rooms for CoWork tasks.
- Restrict room IDs when only specific rooms should route to CoWork.
- Use command-first workflows in busy rooms.
- Avoid relying on encrypted room behavior unless your deployment has confirmed support.

Watch-outs:

- End-to-end encryption support depends on room settings and adapter capability.
- Federation can add delivery variability.
- Access tokens should be treated as sensitive credentials.

## Twitch

Best for:

- Live-stream chat interaction.
- Lightweight audience prompts or moderator-controlled bot usage.
- Streaming workflows where CoWork responds in chat.

Features:

- IRC chat integration over WebSocket.
- Multi-channel support.
- Text-only responses.
- Automatic splitting for longer replies.

Best practices:

- Use moderator-only or command-only patterns for serious tasks.
- Keep prompts short and outputs concise.
- Use Twitch for public interaction, not sensitive work.
- Route deeper work to a private channel or desktop session.

Watch-outs:

- Twitch has strict message length and rate limits.
- No file attachments.
- Public chat should be treated as untrusted input.

## LINE

Best for:

- Teams or users in regions where LINE is the primary chat app.
- Mobile-first task intake.
- Customer or community workflows that use LINE official accounts.

Features:

- LINE Messaging API integration.
- Webhooks.
- Reply messages and push messages.
- Text and supported media message handling.

Best practices:

- Use reply-message flows for normal interactions when possible.
- Be aware of push-message quota usage.
- Use allowlists or pairing for controlled access.
- Keep messages concise for mobile reading.

Watch-outs:

- Reply tokens expire quickly.
- Push messages can consume monthly quota.
- Webhook URL and channel secret must stay correct.

## BlueBubbles

Best for:

- iMessage/SMS access through a Mac running BlueBubbles.
- Users who want Apple Messages style workflows without direct native `imsg` setup.
- Group chats where BlueBubbles already provides the bridge.

Features:

- iMessage and SMS support.
- Group chats.
- Webhooks or fallback polling.
- Self-message capture behavior where configured.

Best practices:

- Run the BlueBubbles server on a Mac that stays online.
- Use contact allowlists for controlled access.
- Use direct chats for approvals and sensitive context.
- Use group chats only where everyone understands CoWork may respond.

Watch-outs:

- Requires a 24/7 Mac server with Messages signed in.
- SMS behavior may differ from iMessage.
- Bridge availability controls whether CoWork can receive and send messages.

## Email

Best for:

- Asynchronous task intake.
- Users who prefer email workflows.
- Filtered automation through sender and subject rules.
- Long-form task requests with attachments.

Features:

- IMAP/SMTP support for many providers.
- Provider presets.
- Outlook.com OAuth for personal Microsoft accounts.
- Reply threading.
- Sender/domain allowlists.
- Subject filters.
- Attachment ingestion.

Best practices:

- Use a dedicated subject prefix such as `[CoWork]` for task email.
- Configure allowed senders or domains.
- Keep one request per email thread.
- Include desired output and workspace context in the email.
- Use scheduled tasks or inbox workflows for recurring email summaries.

Watch-outs:

- Email is slower than real-time chat because it uses polling.
- Provider authentication varies; Gmail often requires app passwords, while Outlook.com personal accounts use OAuth.
- Avoid broad open sender policies for task execution.

## X Mention Triggers

Best for:

- Public or semi-public task intake through mentions.
- Lightweight social trigger workflows.
- Allowlisted users who trigger tasks with a prefix.

Features:

- Mention polling through Bird CLI.
- Command prefix enforcement, defaulting to `do:`.
- Allowlisted authors.
- Idempotent task creation by tweet ID.
- Temporary workspace routing by default.

Best practices:

- Keep allowlists tight.
- Use a clear prefix so casual mentions do not become tasks.
- Treat all public content as untrusted.
- Keep outbound posting disabled unless the workflow explicitly requires it.
- Use temporary workspaces for social-triggered tasks.

Watch-outs:

- Mentions are public unless the account/post context says otherwise.
- Network/API limits and polling intervals affect latency.
- Do not route public input into sensitive workspaces without review.

## Choosing a Channel

| Need | Best channel choices |
|------|----------------------|
| Personal mobile control | WhatsApp, Telegram, Signal, iMessage |
| Workplace team chat | Slack, Teams, Google Chat, Mattermost |
| Engineering/community workflows | Discord, Slack, Mattermost, Matrix |
| Enterprise tenant chat | Teams, Google Chat, Feishu/Lark, WeCom |
| Apple Messages workflows | iMessage, BlueBubbles |
| Public interaction | Twitch, X mention triggers |
| Asynchronous requests | Email |
| Privacy-sensitive mobile chat | Signal |
| Link research rooms | WhatsApp, Telegram |

## Operational Best Practices

- Start with one or two channels, then add more once routing and permissions are clear.
- Use allowlists or pairing for channels that can receive messages from many users.
- Prefer DMs for approvals, credentials, private documents, and sensitive context.
- Prefer dedicated group/channel rooms for recurring shared workflows.
- Keep public channels isolated from private workspaces.
- Review scheduled channel deliveries so recurring jobs do not spam busy rooms.
- Use `/commands` and `/status` as first-line troubleshooting commands.
- Use developer logs when debugging runtime behavior from a local dev build.
