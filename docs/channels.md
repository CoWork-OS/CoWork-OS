# Channel Integrations

CoWork OS supports messaging and communication channels across chat, community, email, and social surfaces. See the channel list below for the current built-in routes. All channels share these common features:

- Security modes (pairing, allowlist, open)
- Brute-force protection
- Session management
- Rate limiting
- Inbound attachment persistence (files saved to `.cowork/inbox/attachments/`)
- Shared message lifecycle for commands, active tasks, follow-ups, progress delivery, cancellations, and scheduled outputs
- **Ambient mode**: Passively ingest all messages without responding; enable per-channel in settings
- **Self-message capture**: Capture your own outgoing messages as context (`captureSelfMessages` on WhatsApp, iMessage, BlueBubbles)
- **Per-channel routing policy**: Channels can restrict who can talk to the agent, which workspaces/roles they route into, how group/server traffic is filtered, and how much mid-task progress is relayed back into the channel
- **Channel specialization**: Route a whole channel, one chat/group, or one topic/thread to a specific workspace, agent role, prompt guidance, tool restrictions, and optional shared-memory policy
- **Access-profile enforcement**: New channel tasks use the target workspace's access profile, while channel/context restrictions can only narrow it. Command tools do not have a separate shell toggle, and invalid profiles fail closed.

See [Gateway Message Lifecycle](gateway-message-lifecycle.md) for the shared routing, command, active-task, skill-slash, delivery, and scheduled-output behavior. For day-to-day usage examples, see [Using CoWork from WhatsApp and Other Channels](gateway-user-guide.md). For per-channel feature and best-practice guides, see [Channel User Guides](channel-user-guides.md) and the [dedicated channel guide index](channel-guides/).

<p align="center">
  <img src="../resources/branding/images/cowork-os-12.webp" alt="Messaging channel setup" width="700">
  <br><em>Channel settings support provider setup plus per-channel routing, prompts, and security behavior.</em>
</p>

### Common Remote Commands

These commands are available across all channels:

| Command | Description |
|---------|-------------|
| `/help` | Show compact channel help |
| `/commands [category]` | Show the remote command catalog |
| `/status` | Check gateway and task status |
| `/workspaces` | List available workspaces |
| `/workspace <n>` | Select workspace by number |
| `/newtask`, `/new` | Start the next message fresh without cancelling the old task |
| `/new temp` | Start a scratch temporary workspace session |
| `/cancel`, `/stop` | Cancel the running task |
| `/pause`, `/resume` | Pause or resume the current task |
| `/queue <message>` | Send a follow-up to the current task |
| `/steer <guidance>` | Send high-priority guidance to the current task |
| `/background <prompt>` | Start an unlinked background task |
| `/pair <code>` | Pair with code |
| `/simplify [objective]` | Run simplify workflow on current/specified task context |
| `/batch <objective>` | Run parallel batch workflow with safety policy controls |
| `/llm-wiki <objective>` | Build or maintain a persistent research vault in the active workspace |
| `/<skill-slug> args` | Invoke an enabled skill by slash alias or skill slug |
| `/schedule <prompt>` | Schedule a recurring task |
| `/digest [lookback]` | Digest of recent chat messages |
| `/followups [lookback]` | Extract follow-ups/commitments |
| `/brief [today\|week]` | Generate a brief summary (DM only) |

Recognized slash commands are handled by the gateway and are never forwarded as normal task text. Unknown slash commands return an explicit unknown-command reply.

### Slash-Skill Notes

- `/simplify`, `/batch`, and `/llm-wiki` are bundled global skills (enabled by default), available in desktop and gateway channels.
- Enabled skills can also be invoked from gateway channels as `/<skill-slug> args`; use `/skills` to see available skill slugs and `/skill <id>` to toggle a skill.
- Inline chaining is supported in normal messages: `... then run /simplify`, `... then run /batch ...`, and `... then run /llm-wiki ...`.
- WhatsApp natural phrase mapping supports all three commands, including research-vault phrasing for `llm-wiki`.
- `/batch` external policy defaults to `confirm`; `none` blocks known external side-effect actions for the run.
- `/llm-wiki` supports `--mode`, `--path`, and `--obsidian` flags, and allows objective-free maintenance runs for `init`, `lint`, and `refresh`.

See [Universal `/simplify` and `/batch`](simplify-batch.md) and [LLM Wiki](llm-wiki.md) for full syntax and behavior.

## Channel Specialization

Channel specialization lets one connected gateway channel host multiple workflows without creating separate bot runtimes. In **Settings > Channels > [channel] > Channel Specialization**, admins can create durable records for:

- a whole-channel default when no chat/group is selected
- a specific chat/group
- a specific topic/thread when the provider supplies `threadId` context

Each specialization can set a display name, workspace, agent role, prompt guidance, tool restrictions, whether shared context memory is allowed, and whether the record is enabled.

Resolution order is:

1. exact `channelId + chatId + threadId`
2. exact `channelId + chatId`
3. channel-level specialization
4. existing channel config, session preference, or workspace default behavior

New tasks use the resolved specialization for workspace, agent role, prompt guidance, gateway context, tool restrictions, and shared-memory opt-in. Follow-ups to an active task keep that task's existing workspace and role so a conversation does not switch identity mid-run. After a task completes, fails, cancels, or the chat is reset with `/new`, the next ordinary message re-resolves specialization before a new task starts.

The task also carries the target workspace's effective [access profile](access-profiles.md). A
channel specialization, context policy, or approval response may reduce what the profile can do,
but cannot widen its filesystem, command-tool, network, or domain scope. To change profiles, start a
new task after updating the workspace/profile configuration.

Workspace-local router rules still run per message and can override specialization for that message. Tool restrictions are additive with context policies and channel restrictions, with deny rules taking priority. Shared memory remains off for group/public contexts unless the specialization explicitly enables it.

---

## WhatsApp

QR code pairing via Baileys library for Web WhatsApp connections.

WhatsApp uses the shared gateway lifecycle after connection. `/new` and `/newtask` unlink the chat from the current task; `/new temp` starts a scratch temporary workspace session; `/stop` and `/cancel` cancel the active task. Temporary workspaces are hidden from `/workspaces` and from the `/new temp` acknowledgement.

WhatsApp supports typing indicators and editable task-progress messages. CoWork edits the current progress message when possible and falls back to a new message if the provider rejects the edit.

### Setup

1. Open **Settings** > **WhatsApp** tab
2. Click **Add WhatsApp Channel**
3. Scan the QR code with your phone (WhatsApp > Settings > Linked Devices)
4. Once connected, the channel status shows "Connected"

### Self-Chat Mode

| Mode | Description | Best For |
|------|-------------|----------|
| **Self-Chat Mode ON** (default) | Bot only responds in "Message Yourself" chat | Using your personal WhatsApp |
| **Self-Chat Mode OFF** | Bot responds to all incoming messages | Dedicated bot phone number |

### Research Channels

Designate specific groups as link-research channels. Post URLs there and the agent builds a findings report with classification. See [Research Channels](research-channels.md).

### Group Specialization

WhatsApp group chats can be specialized from channel settings. Use this for trusted groups that should always route into a particular workspace and role, such as a customer-support group, research-link group, or personal operations group.

---

## Telegram

Bot commands, streaming responses, workspace selection via grammY.

Telegram uses the shared gateway lifecycle. The bot's `/` menu is populated with the core remote commands such as `/new`, `/stop`, `/commands`, `/queue`, `/steer`, `/background`, `/skills`, `/schedule`, and `/brief`.

### Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token
2. Open **Settings** > **Channels** tab
3. Enter your bot token and click **Add Telegram Channel**
4. Test and enable the channel

### Group Routing Controls

Telegram group behavior can now be tightened without writing custom bot logic:

- **Routing mode**: choose `all`, `mentionsOnly`, `mentionsOrCommands`, or `commandsOnly`
- **Allowed group chat IDs**: optionally restrict routing to a known set of Telegram groups
- **Research channels**: keep using dedicated research groups separately from normal task-routing groups

### Group and Topic Specialization

Telegram groups can be specialized by chat ID, and Telegram forum topics can be specialized further when topic/thread context is available. Topic-level records win over the broader group record, so one group can host separate workspaces or agent roles for engineering, support, and research topics.

### Additional Commands

| Command | Description |
|---------|-------------|
| `/addworkspace <path>` | Add new workspace |

### Research Channels

Designate specific groups as link-research channels. Post URLs there and the agent builds a findings report with classification. See [Research Channels](research-channels.md).

---

## Discord

Slash commands, DM support, guild integration, embeds, polls, select menus, and live message/attachment API.

Discord uses the shared gateway lifecycle through native slash commands and text messages delivered to the bot. `/task <prompt>` remains a native compatibility shortcut for starting a task; use `/status` for current state and `/commands` for the command catalog.

### Setup

1. Create application at [Discord Developer Portal](https://discord.com/developers/applications)
2. Add bot and copy token
3. Enable **Message Content Intent** in Privileged Gateway Intents
4. Invite bot with `bot` and `applications.commands` scopes
5. Configure in **Settings** > **Channels**

### Guild Filtering

If you only want the bot active in certain Discord servers, add allowed **Guild IDs** in the channel settings. Incoming messages and interactions from other guilds are ignored even if the bot is installed there.

### Channel and Thread Specialization

Discord channel settings support specialization for server channels and thread-aware contexts where Discord supplies thread identity. Use channel-level records for broad team spaces and thread-level records for focused project or incident workflows.

### Additional Commands

| Command | Description |
|---------|-------------|
| `/task <prompt>` | Run task directly |
| `/workspace`, `/addworkspace` | Workspace selection |
| `/approve`, `/deny` | Approve or deny pending actions |
| `/pair <code>` | Pair with pairing code |

### Agent Tools (Live Discord API)

The agent can fetch messages and download attachments directly from Discord, not just from the local gateway log:

| Tool | Description |
|------|-------------|
| `channel_fetch_discord_messages` | Fetch up to 100 recent messages from a channel via the live Discord API. Use when you need messages that have not passed through CoWork yet. Messages with attachments are marked `+Natt`. |
| `channel_download_discord_attachment` | Download all attachments from a specific message to the local inbox. Returns file paths for `read_file`. Use when `channel_fetch_discord_messages` shows a message has attachments. |

**Typical flow:** Use `channel_list_chats` with `channel: "discord"` to discover chat IDs, then `channel_fetch_discord_messages` for live history, and `channel_download_discord_attachment` for any message with attachments.

### Supervisor Mode

Discord can run a strict worker/supervisor protocol with a dedicated coordination channel, watched output channels, and human escalation mirrored into Mission Control.

See [Supervisor Mode on Discord](supervisor-mode-discord.md).

---

## Slack

Socket Mode integration with channel mentions, file uploads, and optional curated progress relays.

Slack uses the shared gateway lifecycle for DMs, mentions, and registered Slack slash commands. Slack only sends slash command payloads for commands registered in the Slack app, so add the core commands listed in [Using CoWork from WhatsApp and Other Channels](gateway-user-guide.md#slack-tips) when configuring the app.

### Setup

1. Create app at [Slack API Apps](https://api.slack.com/apps)
2. Enable Socket Mode and create App-Level Token (`xapp-...`)
3. Add bot scopes: `app_mentions:read`, `chat:write`, `im:history`, `im:read`, `im:write`, `users:read`, `files:write`
4. Subscribe to events: `app_mention`, `message.im`
5. Install to workspace and copy Bot Token (`xoxb-...`)
6. Configure in **Settings** > **Channels** > **Slack**

### Multiple Workspaces

CoWork can now keep more than one Slack installation active in the same profile:

- add each Slack workspace as its own Slack channel entry
- select the workspace inside Slack settings to test, toggle, revoke, or remove it
- reply routing stays pinned to the originating Slack workspace so follow-ups go back to the correct installation

### Slack Channel Specialization

Slack channels can be specialized per Slack installation. This lets a `#support`, `#launch`, or `#engineering-reviews` channel route into its expected CoWork workspace, agent role, guidance, and tool policy without relying on every user to pick the right workspace first.

### Progress Relay Modes

Slack exposes a per-workspace **Progress Updates** setting:

- **Minimal** - suppress most executor chatter and only relay compact status updates
- **Curated middle steps** - convert selected planning and execution events into short human-readable updates while the task is running

Curated mode keeps streaming assistant output separate from the transient relay. When Slack supports message editing, CoWork reuses a single progress message for non-streaming status updates and clears it when the task pauses for approval/input or reaches a terminal state.

---

## Feishu / Lark

Webhook-based enterprise messaging integration for Feishu and Lark.

### Setup

1. Create a Feishu/Lark app and enable bot + event subscriptions
2. Copy the App ID, App Secret, verification token, and encryption key
3. Configure the channel in **Settings** > **Channels** > **Feishu / Lark**
4. Set the callback URL shown by CoWork in the Feishu/Lark developer console
5. Enable and test

### Notes

- Supports secure webhook verification and encrypted event handling
- Best fit for a dedicated tenant/app pairing rather than many installs in one profile

---

## WeCom

Enterprise WeCom gateway integration with signed/encrypted event handling.

### Setup

1. Create a WeCom app in your WeCom admin console
2. Copy the Corp ID, Agent ID, Secret, token, and EncodingAESKey
3. Configure the channel in **Settings** > **Channels** > **WeCom**
4. Set the callback URL shown by CoWork in WeCom
5. Enable and test

### Notes

- Supports encrypted webhook/event payloads
- Good fit for internal enterprise operations and alert/task routing

---

## Microsoft Teams

Bot Framework SDK with DM/channel mentions and adaptive cards.

### Prerequisites

- Azure account with Bot Services access
- Microsoft Teams workspace where you can add apps
- Public webhook URL (use ngrok for local development)

### Setup

1. **Create an Azure Bot** at [Azure Portal](https://portal.azure.com/#create/Microsoft.AzureBot) — choose Multi-tenant or Single-tenant
2. **Get Bot Credentials** — copy the Microsoft App ID, then create and copy a client secret under Certificates & secrets
3. **Add Teams Channel** — in the Bot resource, go to Channels and enable Microsoft Teams
4. **Set Up Webhook** (for local dev): `ngrok http 3978` — set messaging endpoint to `https://your-ngrok-url/api/messages`
5. **Configure in CoWork OS** — Settings > Teams tab, enter App ID, App Password, optional Tenant ID, webhook port (default: 3978)

### Message Features

- Direct Messages and channel @mentions
- Adaptive Cards formatting
- File attachments
- Auto-reconnect with exponential backoff

---

## Google Chat

Service account auth, spaces/DMs, threaded conversations.

### Prerequisites

- Google Cloud project with Chat API enabled
- Service account with `Chat Bots Viewer` and `Chat Bots Admin` roles
- Public webhook URL (use ngrok for local development)

### Setup

1. Enable [Google Chat API](https://console.cloud.google.com/apis/library/chat.googleapis.com)
2. Create a service account and download the JSON key
3. Configure the Chat app at the [Chat API Configuration](https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat) page — set HTTP endpoint URL
4. Set up webhook: `ngrok http 3979`
5. Configure in **Settings** > **Google Chat** — enter service account key path, optional Project ID, webhook port (default: 3979)

> **Note:** Google Chat bots only work within Google Workspace organizations.

---

## X (Twitter)

Mention-based task ingress via Bird CLI with allowlist + command-prefix enforcement.

### Setup

1. Open **Settings > X**
2. Enable X integration and test connection
3. Enable **Mention Trigger**
4. Set:
   - command prefix (default `do:`)
   - allowlisted authors (required)
   - poll interval and fetch count
5. Save settings

### Behavior

- Mentions are parsed oldest-to-newest.
- Only allowlisted authors with matching prefix and non-empty command are accepted.
- Tasks are idempotent by tweet id (`sessionKey = xmention:<tweetId>`).
- Temporary workspace routing is default.
- No automatic outbound posting unless explicitly enabled on the native `x` channel.

See [X Mention Triggers](x-mention-triggers.md) for desktop/headless details and troubleshooting.

---

## iMessage (macOS Only)

Native macOS integration via `imsg` CLI tool.

### Prerequisites

- macOS with Messages app signed in
- `imsg` CLI: `brew install steipete/tap/imsg`
- Full Disk Access granted to Terminal

### How It Works

Messages from your own Apple ID are filtered. Use a **dedicated Apple ID** for the bot Mac, then message the bot from your personal devices.

---

## Signal

End-to-end encrypted messaging via `signal-cli`.

### Prerequisites

- **signal-cli**: `brew install signal-cli`
- **Dedicated phone number** (Signal allows only one registration per number)
- **Java Runtime**: Java 17+

### Registration

| Option | Best For |
|--------|----------|
| **Dedicated Number** | Production use |
| **Link as Device** | Testing (limited functionality) |

### Setup

1. Register: `signal-cli -a +1234567890 register` then `verify CODE`
2. Configure in **Settings** > **Signal** tab — enter phone number, data directory, click Add Signal Channel

### Trust Modes

| Mode | Description |
|------|-------------|
| **TOFU** | Auto-trust new identity keys on first contact |
| **Always** | Always trust identity keys |
| **Manual** | Require manual verification |

### Operating Modes

| Mode | Description |
|------|-------------|
| **Native** | Direct signal-cli command execution |
| **Daemon** | Connect to signal-cli JSON-RPC daemon (advanced) |

> **Important:** Registering signal-cli will deregister any existing Signal app using that phone number.

### Sender Policies

Signal settings can now distinguish DM and group behavior:

- `dmPolicy`: `open`, `allowlist`, `pairing`, or `disabled`
- `groupPolicy`: `open`, `allowlist`, or `disabled`
- `allowedNumbers`: explicit allowlist applied consistently for both direct and group senders

---

## Mattermost

REST API and WebSocket for real-time messaging.

### Setup

1. Generate a Personal Access Token in **Account Settings** > **Security** > **Personal Access Tokens**
2. Configure in **Settings** > **Mattermost** — enter server URL, token, optional Team ID

---

## Matrix

Federated messaging with room-based conversations.

### Setup

1. Get your Access Token from your Matrix client (Element: Settings > Help & About > Advanced)
2. Configure in **Settings** > **Matrix** — enter homeserver URL, User ID, Access Token, optional Room IDs

> **Notes:** Matrix is federated (cross-homeserver). E2EE support depends on room settings.

---

## Twitch

IRC chat integration over WebSocket.

### Setup

1. Get OAuth token from [twitchtokengenerator.com](https://twitchtokengenerator.com/) (select Chat Bot type)
2. Configure in **Settings** > **Twitch** — enter username, OAuth token, channel names

### Limitations

- Text-only (no file attachments)
- 20 messages per 30 seconds rate limit
- 500 characters max per message (auto-split for longer responses)
- Whispers may require verified account status

---

## LINE

Messaging API with webhooks and push/reply messages.

### Setup

1. Create a Messaging API channel at [LINE Developers Console](https://developers.line.biz/console/)
2. Copy Channel Access Token and Channel Secret
3. Configure in **Settings** > **LINE** — enter tokens, webhook port (default: 3100)
4. In LINE Console, set webhook URL, enable webhooks, disable auto-reply

### Message Types

- **Reply Messages**: Free, use reply tokens (valid ~1 minute)
- **Push Messages**: Uses monthly quota, for proactive messaging

---

## BlueBubbles

iMessage via BlueBubbles server running on a Mac.

### Prerequisites

- Mac computer running 24/7 with Messages app signed in
- BlueBubbles server installed ([bluebubbles.app](https://bluebubbles.app/))

### Setup

1. Install BlueBubbles Server on Mac and note the server URL and password
2. Configure in **Settings** > **BlueBubbles** — enter server URL, password, optional contact allowlist

### Features

- iMessage and SMS support
- Group chats
- Webhooks or fallback polling

---

## Email

IMAP/SMTP integration — works with any email provider.

### Setup

1. Configure in **Settings** > **Email**.
2. Choose the matching provider preset when available.
3. Use password/app-password auth for Gmail, Yahoo, Microsoft 365, and most generic IMAP/SMTP providers.
4. Use Microsoft OAuth for **Outlook.com / Hotmail / Live / MSN** personal accounts.

### Outlook.com OAuth Setup

For personal Microsoft mailboxes, the Client ID field is not enough by itself. CoWork expects you to bring your own Microsoft Entra app registration.

1. In Azure / Microsoft Entra, create a new app registration.
2. Under **Supported account types**, choose a setting that includes personal Microsoft accounts.
3. Under **Authentication**, add the **Mobile and desktop applications** platform and add the redirect URI `http://localhost`.
4. If Azure shows **Allow public client flows**, enable it for a native/public client registration that uses PKCE.
5. Under **API permissions**, grant delegated `IMAP.AccessAsUser.All` and `SMTP.Send`.
6. In CoWork, choose the **Outlook.com** preset, paste the **Application (client) ID**, leave **Client Secret** empty unless you intentionally created a confidential client, and keep **Tenant** as `consumers` for Outlook.com-family accounts.
7. Click **Connect Microsoft Account** and finish the browser sign-in flow.

### Provider Settings

| Provider | Auth | IMAP Host | IMAP Port | SMTP Host | SMTP Port |
|----------|------|-----------|-----------|-----------|-----------|
| **Gmail** | Password / app password | imap.gmail.com | 993 | smtp.gmail.com | 587 |
| **Microsoft 365** | Password / app password | outlook.office365.com | 993 | smtp.office365.com | 587 |
| **Outlook.com** | Microsoft OAuth | imap-mail.outlook.com | 993 | smtp-mail.outlook.com | 587 |
| **Yahoo** | Password / app password | imap.mail.yahoo.com | 993 | smtp.mail.yahoo.com | 465 |

### Filtering Options

- **Allowed Senders**: Comma-separated exact email addresses or domains (for example `alice@example.com` or `example.com`)
- **Subject Filter**: Only process emails containing specific text (e.g., `[CoWork]`)

### Features

- Reply threading via In-Reply-To headers
- Subject filtering and exact sender/domain allowlist matching
- Universal: works with any IMAP/SMTP provider
- **[LOOM protocol](https://github.com/AlmarionAI/loom-mvn)**: Dual-protocol email system (LOOM for agents, IMAP/SMTP for legacy)

> **Notes:** Gmail with 2FA usually requires an app password. Outlook.com personal accounts use Microsoft OAuth app registration, not password auth. Uses IMAP polling (default 30 seconds).

---

## Menu Bar App (macOS)

Native menu bar companion for quick access. Press **⌘⇧Space** from anywhere to open a floating input window.

Configure in **Settings** > **Menu Bar**.

---

## Mobile Companions (iOS/Android)

Access CoWork OS from mobile devices via local network.

### Setup

1. Enable Control Plane in **Settings** > **Control Plane**
2. Prefer Tailscale or an SSH tunnel for remote access. Use **Allow LAN Connections (Mobile Companions)** only on a trusted private network.
3. Enter server URL on mobile: `ws://<your-mac-ip>:18789` for private LAN, or the Tailscale `wss://...ts.net` URL.
4. Enter authentication token. CoWork generates separate operator and node tokens; mobile companion/node clients use read-scoped node access.

### Security

- LAN/Tailscale only (not exposed to the public internet)
- Token-based authentication
- Ensure firewall allows port 18789
- Both devices must be on the same network
- Headless/managed deployments fail closed on raw public Control Plane binds unless Tailscale, private container context, or an explicit break-glass override is configured

---

## Comparison with Alternative Implementations

See [Channel Comparison](channel-comparison.md) for how CoWork OS channel integrations compare to alternative plugin-based implementations.
