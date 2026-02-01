<p align="center">
  <img src="screenshots/cowork-oss-logo.png" alt="CoWork-OSS Logo" width="120">
</p>

# CoWork-OSS

[![CI](https://github.com/CoWork-OS/cowork-oss/actions/workflows/ci.yml/badge.svg)](https://github.com/CoWork-OS/cowork-oss/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![macOS](https://img.shields.io/badge/platform-macOS-blue.svg)](https://www.apple.com/macos/)
[![Electron](https://img.shields.io/badge/electron-40.0.0-47848F.svg)](https://www.electronjs.org/)

**Self-hosted personal AI assistant with security-first design**

Run your own AI assistant across WhatsApp, Telegram, Discord, Slack, and iMessage — with full control over your data, configurable guardrails, and comprehensive security.

| | |
|---|---|
| **6 AI Providers** | Claude, GPT-4, Gemini, Bedrock, OpenRouter, Ollama (free/local) |
| **5 Messaging Channels** | WhatsApp, Telegram, Discord, Slack, iMessage |
| **Security-First** | 390+ unit tests, configurable guardrails, approval workflows |
| **Local-First** | Your data stays on your machine. BYOK (Bring Your Own Key) |

> **Status**: macOS desktop app (cross-platform support planned)

---

<p align="center">
  <img src="screenshots/cowork-oss4.jpeg" alt="CoWork-OSS Interface" width="700">
  <br>
  <em>Terminal-inspired UI with real-time task timeline</em>
</p>

---

## Why CoWork-OSS?

### Security Without Compromise

- **Configurable guardrails**: Token budgets, cost limits, iteration caps
- **Dangerous command blocking**: Built-in patterns + custom regex rules
- **Approval workflows**: User consent required for destructive operations
- **Pairing & allowlists**: Control who can access your AI via messaging channels
- **390+ security tests**: Comprehensive test coverage for access control and policies

### Your Data, Your Control

- **100% local-first**: Database, credentials, and artifacts stay on your machine
- **No telemetry**: We don't track you
- **BYOK**: Bring your own API keys — no middleman, no proxy
- **Open source**: Audit the code yourself

### Connect from Anywhere

- Message your AI from WhatsApp, Telegram, Discord, Slack, or iMessage
- Schedule recurring tasks with cron expressions
- Secure remote access via Tailscale or SSH tunnels
- WebSocket API for custom integrations

### Developer-Friendly Tools

- Claude Code-style tools: `glob`, `grep`, `edit_file`
- Browser automation with Playwright
- 75+ bundled skills for popular services
- MCP (Model Context Protocol) support for extensibility

---

## Security Architecture

CoWork-OSS is designed with security as a core principle, not an afterthought.

### Defense in Depth

| Layer | Protection |
|-------|------------|
| **Channel Access** | Pairing codes, allowlists, brute-force lockout (5 attempts, 15 min cooldown) |
| **Tool Execution** | Risk-level categorization, context-aware isolation |
| **File Operations** | Workspace boundaries, path traversal protection |
| **Shell Commands** | Dangerous command blocking, explicit approval required |
| **Browser Automation** | Domain allowlist, configurable restrictions |
| **Resource Limits** | Token budgets, cost caps, iteration limits, file size limits |

### Security Test Coverage

- **132 security unit tests** for access control and policy enforcement
- **259 WebSocket protocol tests** for API security
- Monotonic policy precedence (deny-wins across security layers)
- Context-aware tool isolation for shared gateway environments

---

## Providers & Costs (BYOK)

CoWork-OSS is **free and open source**. To run tasks, configure your own model credentials or use local models.

| Provider | Configuration | Billing |
|----------|---------------|---------|
| Anthropic API | API key in Settings | Pay-per-token |
| Google Gemini | API key in Settings | Pay-per-token (free tier available) |
| OpenRouter | API key in Settings | Pay-per-token (multi-model access) |
| OpenAI (API Key) | API key in Settings | Pay-per-token |
| OpenAI (ChatGPT OAuth) | Sign in with ChatGPT account | Uses your ChatGPT subscription |
| AWS Bedrock | AWS credentials in Settings | Pay-per-token via AWS |
| Ollama (Local) | Install Ollama and pull models | **Free** (runs locally) |

**Your usage is billed directly by your provider.** CoWork-OSS does not proxy or resell model access.

---

## Features

### Multi-Channel AI Gateway

- **WhatsApp**: QR code pairing, self-chat mode, markdown support
- **Telegram**: Bot commands, streaming responses, workspace selection
- **Discord**: Slash commands, DM support, guild integration
- **Slack**: Socket Mode, channel mentions, file uploads
- **iMessage**: macOS native integration, pairing codes

All channels support:
- Security modes (pairing, allowlist, open)
- Brute-force protection
- Session management
- Rate limiting

### Agent Capabilities

- **Task-Based Workflow**: Multi-step execution with plan-execute-observe loops
- **Goal Mode**: Define success criteria and auto-retry until verification passes
- **Dynamic Re-Planning**: Agent can revise its plan mid-execution
- **75+ Built-in Skills**: GitHub, Slack, Notion, Spotify, Apple Notes, and more
- **Document Creation**: Excel, Word, PDF, PowerPoint with professional formatting

### Configurable Guardrails

| Guardrail | Description | Default | Range |
|-----------|-------------|---------|-------|
| **Token Budget** | Total tokens (input + output) per task | 100,000 | 1K - 10M |
| **Cost Budget** | Estimated cost (USD) per task | $1.00 (disabled) | $0.01 - $100 |
| **Iteration Limit** | LLM calls per task | 50 | 5 - 500 |
| **Dangerous Command Blocking** | Block shell commands matching patterns | Enabled | On/Off + custom |
| **Auto-Approve Trusted Commands** | Skip approval for safe commands | Disabled | On/Off + patterns |
| **File Size Limit** | Max file size agent can write | 50 MB | 1 - 500 MB |
| **Domain Allowlist** | Restrict browser to approved domains | Disabled | On/Off + domains |

### Code Tools

Claude Code-style tools for efficient code navigation and editing:

| Tool | Description |
|------|-------------|
| **glob** | Fast pattern-based file search (e.g., `**/*.ts`, `src/**/*.tsx`) |
| **grep** | Regex content search across files with context lines |
| **edit_file** | Surgical file editing with find-and-replace |

### Browser Automation

Full Playwright integration:
- Navigate to URLs, take screenshots, save as PDF
- Click, fill forms, type text, press keys
- Extract page content, links, and form data
- Scroll pages, wait for elements, execute JavaScript

### System Tools

- Take screenshots (full screen or specific windows)
- Read/write clipboard content
- Open applications, URLs, and file paths
- Run AppleScript to automate macOS apps
- Get system information and environment variables

### Remote Access

- **Tailscale Serve**: Expose to your private tailnet
- **Tailscale Funnel**: Public HTTPS endpoint via Tailscale edge
- **SSH Tunnels**: Standard SSH port forwarding
- **WebSocket API**: Programmatic task management

### MCP (Model Context Protocol)

- **MCP Client**: Connect to external MCP servers
- **MCP Host**: Expose CoWork's tools as an MCP server
- **MCP Registry**: Browse and install servers from a catalog

### Personality System

Customize agent behavior via Settings or conversation:

- **Personalities**: Professional, Friendly, Concise, Creative, Technical, Casual
- **Personas**: Jarvis, Friday, HAL, Computer, Alfred, Intern, Sensei, Pirate, Noir
- **Response Style**: Emoji usage, response length, code comments, explanation depth
- **Quirks**: Catchphrases, sign-offs, analogy domains
- **Relationship**: Agent remembers your name and tracks interactions

---

## Data Handling

- **Stored locally**: Task metadata, timeline events, artifact index, workspace config (SQLite)
- **Sent to provider**: Task prompt and context you choose to include
- **Not sent**: Your API keys (stored locally via OS keychain)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Security Layers                               │
├─────────────────────────────────────────────────────────────────┤
│  Channel Access Control: Pairing | Allowlist | Rate Limiting     │
│  Guardrails & Limits: Token Budget | Cost Cap | Iterations       │
│  Approval Workflows: Shell | Delete | Bulk Operations            │
│  Workspace Isolation: Path Traversal | File Boundaries           │
└─────────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────────┐
│                    React UI (Renderer)                           │
│  Task List | Timeline | Approval Dialogs | Live Canvas           │
│  Settings | Notification Panel | MCP Registry                    │
└─────────────────────────────────────────────────────────────────┘
                              ↕ IPC
┌─────────────────────────────────────────────────────────────────┐
│                 Agent Daemon (Main Process)                      │
│  Task Queue Manager | Agent Executor | Tool Registry             │
│  Permission Manager | Cron Service | Canvas Manager              │
└─────────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────────┐
│                    Execution Layer                               │
│  File Operations | Document Skills | Browser Automation          │
│  LLM Providers (6) | Search Providers (4) | MCP Client           │
└─────────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────────┐
│  SQLite Database | MCP Host Server | WebSocket Control Plane     │
│  Tailscale / SSH Tunnel Remote Access                            │
└─────────────────────────────────────────────────────────────────┘
```

---

## Setup

### Prerequisites

- Node.js 18+ and npm
- macOS (for Electron native features)
- One of: Anthropic API key, Google Gemini API key, OpenRouter API key, OpenAI API key, AWS Bedrock access, or Ollama installed locally

### Installation

```bash
# Clone the repository
git clone https://github.com/CoWork-OS/cowork-oss.git
cd cowork-oss

# Install dependencies
npm install

# Run in development mode
npm run dev

# Configure your API credentials in Settings (gear icon)
```

### Building for Production

```bash
npm run build
npm run package
```

The packaged app will be in the `release/` directory.

---

## Screenshots

<p align="center">
  <img src="screenshots/cowork-oss2.jpeg" alt="CoWork-OSS Welcome Screen" width="800">
  <br>
  <em>Welcome screen with AI disclosure and quick commands</em>
</p>

<p align="center">
  <img src="screenshots/cowork-oss3.jpeg" alt="CoWork-OSS Task Execution" width="800">
  <br>
  <em>Real-time task execution with plan steps and tool calls</em>
</p>

---

## Usage

### 1. Select a Workspace

On first launch, select a folder where CoWork-OSS can work. This folder will be:
- Mounted for read/write access
- Protected by permission boundaries
- Used as the working directory for all tasks

### 2. Create a Task

Click "New Task" and describe what you want to accomplish:

**Example Tasks:**
- "Organize my Downloads folder by file type"
- "Create a quarterly report spreadsheet with Q1-Q4 data"
- "Generate a presentation about our product roadmap"
- "Analyze these CSV files and create a summary document"

### 3. Monitor Execution

Watch the task timeline as the agent:
- Creates an execution plan
- Executes steps using available tools
- Requests approvals for destructive operations
- Produces artifacts (files)

<p align="center">
  <img src="screenshots/cowork-oss1.jpeg" alt="Task Completion" width="800">
  <br>
  <em>Task completion with verification and file tracking</em>
</p>

### 4. Approve Requests

When the agent needs to perform destructive actions, you'll see an approval dialog. Review the details and approve or deny.

---

## Security & Safety

> **See also:** [SECURITY_GUIDE.md](SECURITY_GUIDE.md) for a comprehensive guide on the app's security model, permissions, and best practices.

### Important Warnings

- **Don't point this at sensitive folders** — select only folders you're comfortable giving the agent access to
- **Use version control / backups** — always have backups of important files before running tasks
- **Review approvals carefully** — read what the agent wants to do before approving
- **Treat web content as untrusted input** — be cautious with tasks involving external data

### Workspace Boundaries

All file operations are constrained to the selected workspace folder. Path traversal attempts are rejected.

### Permission Model

```typescript
interface WorkspacePermissions {
  read: boolean;      // Read files
  write: boolean;     // Create/modify files
  delete: boolean;    // Delete files (requires approval)
  network: boolean;   // Network access
  shell: boolean;     // Execute shell commands (requires approval)
}
```

### Approval Requirements

The following operations always require user approval:
- File deletion
- Shell command execution (when enabled)
- Bulk rename (>10 files)
- Network access beyond allowlist
- External service calls

---

## Parallel Task Queue

Run multiple tasks concurrently with configurable limits.

### How It Works

1. **Concurrency Limit**: Set maximum simultaneous tasks (1-10, default: 3)
2. **FIFO Queue**: Tasks beyond the limit are queued in order
3. **Auto-Start**: Completed tasks trigger the next in queue
4. **Persistence**: Queued tasks survive app restarts

### Queue Panel

When tasks are running or queued, a panel shows:
- **Running tasks** with spinner indicator
- **Queued tasks** with position (#1, #2, etc.)
- **View** and **Cancel** buttons for each task

### Quick Task FAB

Floating action button for rapid task creation:
1. Click the **+** button
2. Type your task prompt
3. Press Enter to queue

---

## Scheduled Tasks (Cron Jobs)

Schedule recurring tasks with cron expressions and optional channel delivery.

### Features

- **Cron Expressions**: Standard cron syntax (minute, hour, day, month, weekday)
- **Workspace Binding**: Each job runs in a specific workspace
- **Channel Delivery**: Send results to Telegram, Discord, Slack, WhatsApp, or iMessage
- **Run History**: View execution history with status and duration
- **Enable/Disable**: Toggle jobs without deleting them

### Cron Expression Examples

| Schedule | Expression | Description |
|----------|------------|-------------|
| Every hour | `0 * * * *` | Start of every hour |
| Daily at 9am | `0 9 * * *` | Every day at 9:00 AM |
| Weekdays at 6pm | `0 18 * * 1-5` | Monday-Friday at 6:00 PM |
| Weekly on Sunday | `0 0 * * 0` | Every Sunday at midnight |

---

## WhatsApp Bot Integration

Run tasks via WhatsApp using the Baileys library for Web WhatsApp connections.

### Setting Up WhatsApp

1. Open **Settings** > **WhatsApp** tab
2. Click **Add WhatsApp Channel**
3. Scan the QR code with your phone (WhatsApp > Settings > Linked Devices)
4. Once connected, the channel status shows "Connected"

### Self-Chat Mode

| Mode | Description | Best For |
|------|-------------|----------|
| **Self-Chat Mode ON** (default) | Bot only responds in "Message Yourself" chat | Using your personal WhatsApp |
| **Self-Chat Mode OFF** | Bot responds to all incoming messages | Dedicated bot phone number |

### Security Modes

| Mode | Description |
|------|-------------|
| **Pairing** (default) | Users must enter a pairing code |
| **Allowlist** | Only pre-approved phone numbers |
| **Open** | Anyone can message (not recommended) |

### Bot Commands

| Command | Description |
|---------|-------------|
| `/workspaces` | List available workspaces |
| `/workspace <n>` | Select workspace by number |
| `/newtask` | Start fresh conversation |
| `/status` | Check bot status |
| `/cancel` | Cancel running task |
| `/pair <code>` | Pair with code |

---

## Telegram Bot Integration

Run tasks remotely via Telegram bot.

### Setting Up Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token
2. Open **Settings** > **Channels** tab
3. Enter your bot token and click **Add Telegram Channel**
4. Test and enable the channel

### Bot Commands

| Command | Description |
|---------|-------------|
| `/workspaces` | List workspaces |
| `/workspace <n>` | Select workspace |
| `/addworkspace <path>` | Add new workspace |
| `/status` | Show session status |
| `/cancel` | Cancel running task |

---

## Discord Bot Integration

Run tasks via Discord slash commands or direct messages.

### Setting Up Discord

1. Create application at [Discord Developer Portal](https://discord.com/developers/applications)
2. Add bot and copy token
3. Enable **Message Content Intent** in Privileged Gateway Intents
4. Invite bot with `bot` and `applications.commands` scopes
5. Configure in **Settings** > **Channels**

### Slash Commands

| Command | Description |
|---------|-------------|
| `/workspaces` | List workspaces |
| `/workspace [path]` | Select workspace |
| `/task <prompt>` | Run task directly |
| `/status` | Show session status |
| `/cancel` | Cancel running task |

---

## Slack Bot Integration

Run tasks via Slack using Socket Mode.

### Setting Up Slack

1. Create app at [Slack API Apps](https://api.slack.com/apps)
2. Enable Socket Mode and create App-Level Token (`xapp-...`)
3. Add bot scopes: `app_mentions:read`, `chat:write`, `im:history`, `im:read`, `im:write`, `users:read`, `files:write`
4. Subscribe to events: `app_mention`, `message.im`
5. Install to workspace and copy Bot Token (`xoxb-...`)
6. Configure in **Settings** > **Channels** > **Slack**

---

## iMessage Bot Integration (macOS Only)

Run tasks via iMessage using the `imsg` CLI tool.

### Prerequisites

- macOS with Messages app signed in
- `imsg` CLI: `brew install steipete/tap/imsg`
- Full Disk Access granted to Terminal

### How It Works

Messages from your own Apple ID are filtered. To use the bot:
- Use a **dedicated Apple ID** for the bot Mac
- Message the bot from your personal devices

---

## Menu Bar App (macOS)

Native menu bar companion for quick access without the main window.

### Features

- Quick access to workspaces and tasks
- Channel connection status
- New task shortcut
- Configure in **Settings** > **Menu Bar**

### Quick Input Window

Press **⌘⇧Space** from anywhere to open a floating input window:
- Global shortcut works from any app
- See responses inline
- Copy results to clipboard

---

## Web Search Integration

Multi-provider web search for research tasks.

### Supported Providers

| Provider | Types | Best For |
|----------|-------|----------|
| **Tavily** | Web, News | AI-optimized results (recommended) |
| **Brave Search** | Web, News, Images | Privacy-focused |
| **SerpAPI** | Web, News, Images | Google results |
| **Google Custom Search** | Web, Images | Direct Google integration |

Configure in **Settings** > **Web Search**.

---

## Code Tools

Claude Code-style tools for developers.

### glob - Pattern-Based File Search

```
"Find all TypeScript test files"
→ glob pattern="**/*.test.ts"
```

### grep - Regex Content Search

```
"Find all TODO comments"
→ grep pattern="TODO:" glob="*.ts"
```

### edit_file - Surgical Editing

```
"Rename function getUser to fetchUser"
→ edit_file file_path="src/api.ts" old_string="function getUser" new_string="function fetchUser"
```

---

## Web Fetch Tools

### web_fetch

Fetch and parse web pages with HTML-to-text conversion.

```
"Get main content from docs"
→ web_fetch url="https://docs.example.com" selector="main"
```

### http_request

Full HTTP client for API calls (curl-like).

```
"Check API endpoint"
→ http_request url="https://api.example.com/health" method="GET"
```

---

## Personality & Customization

Tell the agent what you want:

| Say this | Effect |
|----------|--------|
| "be more professional" | Changes to formal style |
| "be like Jarvis" | Adopts Jarvis persona |
| "use more emojis" | Increases emoji usage |
| "be brief" | Shorter responses |
| "call yourself Max" | Changes agent name |

---

## Ollama Integration (Local LLMs)

Run completely offline and free.

### Setup

```bash
# Install
brew install ollama

# Pull a model
ollama pull llama3.2

# Start server
ollama serve
```

### Recommended Models

| Model | Size | Best For |
|-------|------|----------|
| `llama3.2` | 3B | Quick tasks |
| `qwen2.5:14b` | 14B | Balanced performance |
| `deepseek-r1:14b` | 14B | Coding tasks |

---

## Google Gemini Integration

### Setup

1. Get API key from [Google AI Studio](https://aistudio.google.com/apikey)
2. Configure in **Settings** > **Google Gemini**

### Models

- `gemini-2.0-flash` (default)
- `gemini-2.5-pro` (most capable)
- `gemini-2.5-flash` (fast)

---

## OpenRouter Integration

Access multiple AI providers through one API.

### Setup

1. Get API key from [OpenRouter](https://openrouter.ai/keys)
2. Configure in **Settings** > **OpenRouter**

### Available Models

Claude, GPT-4, Gemini, Llama, Mistral, and more — see [openrouter.ai/models](https://openrouter.ai/models)

---

## OpenAI / ChatGPT Integration

### Option 1: API Key

Standard pay-per-token access to GPT models.

### Option 2: ChatGPT OAuth

Sign in with your ChatGPT subscription to use without additional API costs.

---

## Built-in Skills (75+)

| Category | Skills |
|----------|--------|
| **Developer** | GitHub, GitLab, Linear, Jira, Sentry |
| **Communication** | Slack, Discord, Telegram, Email |
| **Productivity** | Notion, Obsidian, Todoist, Apple Notes/Reminders |
| **Media** | Spotify, YouTube, SoundCloud |
| **Documents** | Excel, Word, PDF, PowerPoint |

---

## MCP (Model Context Protocol)

### MCP Client

Connect to external MCP servers for extended capabilities.

### MCP Host

Expose CoWork's tools as an MCP server for external clients.

### MCP Registry

Browse and install servers from a catalog with one-click installation.

---

## WebSocket Control Plane

Programmatic API for external automation.

### Features

- Challenge-response token authentication
- Request/response/event protocol
- Rate limiting for auth attempts
- Full task API (create, list, get, cancel)
- Real-time event streaming

---

## Tailscale Integration

Secure remote access without port forwarding.

- **Serve Mode**: Expose to your private tailnet
- **Funnel Mode**: Public HTTPS via Tailscale edge network
- Automatic TLS certificates

---

## SSH Tunnel Support

Standard SSH port forwarding for remote access.

- Connect to remote instances
- Auto-reconnection with backoff
- Encrypted transport with keychain storage

---

## Compliance

Users must comply with their model provider's terms:

- [Anthropic Commercial Terms](https://www.anthropic.com/legal/commercial-terms)
- [Anthropic Usage Policy](https://www.anthropic.com/legal/aup)
- [AWS Bedrock Third-Party Model Terms](https://aws.amazon.com/legal/bedrock/third-party-models/)

---

## Roadmap

### Completed

- [x] Multi-provider LLM support (6 providers)
- [x] Multi-channel messaging (5 channels)
- [x] Configurable guardrails and security
- [x] Browser automation with Playwright
- [x] Code tools (glob, grep, edit_file)
- [x] Document creation (Excel, Word, PDF, PowerPoint)
- [x] MCP support (Client, Host, Registry)
- [x] WebSocket Control Plane with API
- [x] Tailscale and SSH remote access
- [x] Personality system
- [x] 75+ bundled skills
- [x] 390+ unit tests

### Planned

- [ ] VM sandbox using macOS Virtualization.framework
- [ ] Network egress controls with proxy
- [ ] Cross-platform support (Windows, Linux)

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

---

## Security

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

For end-user security guidance, see [SECURITY_GUIDE.md](SECURITY_GUIDE.md).

---

## License

MIT License. See [LICENSE](LICENSE).

---

## Legal

"Cowork" is an Anthropic product name. CoWork-OSS is an independent open-source project and is not affiliated with, endorsed by, or sponsored by Anthropic. If requested by the rights holder, we will update naming/branding.
