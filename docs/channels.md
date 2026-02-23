# Channel Integrations

CoWork OS supports 14 messaging channels. All channels share these common features:

- Security modes (pairing, allowlist, open)
- Brute-force protection
- Session management
- Rate limiting
- Inbound attachment persistence (files saved to `.cowork/inbox/attachments/`)
- Chat commands: `/schedule`, `/digest`, `/followups`, `/brief`
- **Ambient mode**: Passively ingest all messages without responding; enable per-channel in settings
- **Self-message capture**: Capture your own outgoing messages as context (`captureSelfMessages` on WhatsApp, iMessage, BlueBubbles)

### Common Bot Commands

These commands are available across all channels:

| Command | Description |
|---------|-------------|
| `/workspaces` | List available workspaces |
| `/workspace <n>` | Select workspace by number |
| `/newtask` | Start fresh conversation |
| `/status` | Check bot status |
| `/cancel` | Cancel running task |
| `/pair <code>` | Pair with code |
| `/schedule <prompt>` | Schedule a recurring task |
| `/digest [lookback]` | Digest of recent chat messages |
| `/followups [lookback]` | Extract follow-ups/commitments |
| `/brief [today\|week]` | Generate a brief summary (DM only) |

---

## WhatsApp

QR code pairing via Baileys library for Web WhatsApp connections.

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

---

## Telegram

Bot commands, streaming responses, workspace selection via grammY.

### Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token
2. Open **Settings** > **Channels** tab
3. Enter your bot token and click **Add Telegram Channel**
4. Test and enable the channel

### Additional Commands

| Command | Description |
|---------|-------------|
| `/addworkspace <path>` | Add new workspace |

---

## Discord

Slash commands, DM support, guild integration.

### Setup

1. Create application at [Discord Developer Portal](https://discord.com/developers/applications)
2. Add bot and copy token
3. Enable **Message Content Intent** in Privileged Gateway Intents
4. Invite bot with `bot` and `applications.commands` scopes
5. Configure in **Settings** > **Channels**

### Additional Commands

| Command | Description |
|---------|-------------|
| `/task <prompt>` | Run task directly |

---

## Slack

Socket Mode integration with channel mentions and file uploads.

### Setup

1. Create app at [Slack API Apps](https://api.slack.com/apps)
2. Enable Socket Mode and create App-Level Token (`xapp-...`)
3. Add bot scopes: `app_mentions:read`, `chat:write`, `im:history`, `im:read`, `im:write`, `users:read`, `files:write`
4. Subscribe to events: `app_mention`, `message.im`
5. Install to workspace and copy Bot Token (`xoxb-...`)
6. Configure in **Settings** > **Channels** > **Slack**

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

1. Configure in **Settings** > **Email** — use quick setup for Gmail, Outlook, or Yahoo
2. Enter email address and password/app password
3. Configure IMAP/SMTP settings if using other provider

### Provider Settings

| Provider | IMAP Host | IMAP Port | SMTP Host | SMTP Port |
|----------|-----------|-----------|-----------|-----------|
| **Gmail** | imap.gmail.com | 993 | smtp.gmail.com | 587 |
| **Outlook** | outlook.office365.com | 993 | smtp.office365.com | 587 |
| **Yahoo** | imap.mail.yahoo.com | 993 | smtp.mail.yahoo.com | 465 |

### Filtering Options

- **Allowed Senders**: Comma-separated email addresses to accept
- **Subject Filter**: Only process emails containing specific text (e.g., `[CoWork]`)

### Features

- Reply threading via In-Reply-To headers
- Subject filtering and sender allowlist
- Universal: works with any IMAP/SMTP provider

> **Notes:** Gmail/Outlook with 2FA require app passwords. Uses IMAP polling (default 30 seconds).

---

## Menu Bar App (macOS)

Native menu bar companion for quick access. Press **⌘⇧Space** from anywhere to open a floating input window.

Configure in **Settings** > **Menu Bar**.

---

## Mobile Companions (iOS/Android)

Access CoWork OS from mobile devices via local network.

### Setup

1. Enable Control Plane in **Settings** > **Control Plane**
2. Check **Allow LAN Connections (Mobile Companions)**
3. Enter server URL on mobile: `ws://<your-mac-ip>:18789`
4. Enter authentication token

### Security

- LAN only (not exposed to internet)
- Token-based authentication
- Ensure firewall allows port 18789
- Both devices must be on the same network
