<p align="center">
  <img src="screenshots/cowork-oss-logo-new.png" alt="CoWork OS Logo" width="120">
</p>

<div align="center">
<pre>
  ██████╗ ██████╗ ██╗    ██╗ ██████╗ ██████╗ ██╗  ██╗      ██████╗ ███████╗
 ██╔════╝██╔═══██╗██║    ██║██╔═══██╗██╔══██╗██║ ██╔╝     ██╔═══██╗██╔════╝
 ██║     ██║   ██║██║ █╗ ██║██║   ██║██████╔╝█████╔╝      ██║   ██║███████╗
 ██║     ██║   ██║██║███╗██║██║   ██║██╔══██╗██╔═██╗      ██║   ██║╚════██║
 ╚██████╗╚██████╔╝╚███╔███╔╝╚██████╔╝██║  ██║██║  ██╗     ╚██████╔╝███████║
  ╚═════╝ ╚═════╝  ╚══╝╚══╝  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝      ╚═════╝ ╚══════╝
</pre>
</div>

<p align="center">
  <a href="https://github.com/CoWork-OS/CoWork-OS/actions/workflows/ci.yml"><img src="https://github.com/CoWork-OS/CoWork-OS/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <a href="https://www.apple.com/macos/"><img src="https://img.shields.io/badge/platform-macOS-blue.svg" alt="macOS"></a>
  <a href="https://www.electronjs.org/"><img src="https://img.shields.io/badge/electron-40.0.0-47848F.svg" alt="Electron"></a>
</p>

**The operating system for personal AI assistants**

Your AI needs a secure home. CoWork OS provides the runtime, security layers, and I/O channels to run AI agents across WhatsApp, Telegram, Discord, Slack, Microsoft Teams, Google Chat, iMessage, Signal, Mattermost, Matrix, Twitch, LINE, BlueBubbles, and Email — with the control you expect from an operating system.

| | |
|---|---|
| **20+ AI Providers** | Claude, OpenAI, Gemini, Bedrock, OpenRouter, Ollama (free/local), Groq, xAI, Kimi, Mistral, Cerebras, MiniMax, Qwen, Copilot, and more |
| **14 Messaging Channels** | WhatsApp, Telegram, Discord, Slack, Teams, Google Chat, iMessage, Signal, Mattermost, Matrix, Twitch, LINE, BlueBubbles, Email |
| **8 Enterprise Connectors** | Salesforce, Jira, HubSpot, Zendesk, ServiceNow, Linear, Asana, Okta |
| **6 Cloud Storage** | Notion, Box, OneDrive, Google Workspace (Drive/Gmail/Calendar), Dropbox, SharePoint |
| **Voice Calls** | Outbound phone calls via ElevenLabs Agents |
| **Agent Teams** | Multi-agent collaboration with shared checklists and coordinated runs |
| **Workspace Kit** | Workspace `.cowork/` kit (projects, access rules, context injection, per-workspace settings) |
| **Security-First** | 2800+ unit tests, configurable guardrails, approval workflows, gateway hardening |
| **Local-First** | Your data stays on your machine. BYOK (Bring Your Own Key) |

> **Status**: macOS desktop app + headless/server mode (Linux/VPS). Cross-platform desktop support planned.

---

## Installation

### macOS App (Recommended)

- Download the latest build from [GitHub Releases](https://github.com/CoWork-OS/CoWork-OS/releases/latest)
- In Assets, download the newest Apple Silicon DMG (`CoWork-OS-<version>-arm64.dmg`)
- Open the `.dmg` and drag **CoWork OS** into **Applications**
- Eject the mounted DMG after copying, then launch only **/Applications/CoWork OS.app** (prevents duplicate app instances/icons)
- This app is currently distributed as an unsigned build. On first launch, use **System Settings > Privacy & Security > Open Anyway** once.
- Terminal fallback: `xattr -dr com.apple.quarantine "/Applications/CoWork OS.app"`
- If the app closes immediately with a `dyld` signature error, run: `codesign --force --deep --sign - "/Applications/CoWork OS.app"`
- `spctl --add` / `spctl --enable` are deprecated on newer macOS and may show "This operation is no longer supported"

### From npm (CLI Launch)

Use this flow to test like a first-time user in a clean folder:

```bash
# Install into a local folder
mkdir -p /tmp/cowork-run
cd /tmp/cowork-run
npm install cowork-os@latest --no-audit --no-fund

# Ensure no previously running CoWork instance is active
pkill -f '/cowork-os' || true

# Start app
npx cowork-os
```

You can also install globally and launch directly:

```bash
npm install -g cowork-os

# Optional: verify installed version
npm list -g cowork-os --depth=0

# Ensure no previously running CoWork instance is active
pkill -f '/cowork-os' || true

cowork-os
```

If the app opens but shows `vUnknown` or `Error invoking remote method 'app:getVersion'`, you likely connected to an older already-running instance.

Run:

```bash
pkill -f '/cowork-os' || true
cowork-os
```

### From GitHub Source (Development)

#### Prerequisites

- Node.js 22+ and npm
- macOS 12 (Monterey) or later
- One of: any supported LLM provider credentials (API key/token or AWS credentials) or Ollama installed locally
- Xcode Command Line Tools (needed to build `better-sqlite3` for Electron): `xcode-select --install`

```bash
# Clone the repository
git clone https://github.com/CoWork-OS/CoWork-OS.git
cd CoWork-OS

# Install dependencies and set up native modules (includes automatic macOS retry handling)
npm run setup

# Run in development mode
npm run dev

# Configure your API credentials in Settings (gear icon)
```

#### Troubleshooting: macOS "Killed: 9" during setup

If you see `Killed: 9` during `npm run setup`, macOS terminated a native build due to memory pressure.

`npm run setup` already retries native setup automatically with backoff. Let it continue until it exits. If it still exits non-zero, close heavy apps and run the same command again:

```bash
npm run setup
```

#### Build for Production

```bash
npm run setup   # if not already done
npm run build
npm run package
```

The packaged app will be in the `release/` directory.

### Linux VPS (Headless / Server Mode)

If this is your first VPS install, start here (Node-only, no Docker):

1. On your VPS (SSH terminal), install and start CoWork OS:

```bash
ssh user@your-vps
npm install -g cowork-os@latest
export COWORK_IMPORT_ENV_SETTINGS=1
export OPENAI_API_KEY=your_key_here   # or ANTHROPIC_API_KEY=your_key_here
coworkd-node --print-control-plane-token
```

Keep this terminal open. It runs the server and prints your Control Plane token.

2. On your local machine (second terminal), create the SSH tunnel:

```bash
ssh -N -L 18789:127.0.0.1:18789 user@your-vps
```

If local port `18789` is busy:

```bash
ssh -N -L 28789:127.0.0.1:18789 user@your-vps
```

3. Open the web UI in your browser:

- `http://127.0.0.1:18789/` (or `http://127.0.0.1:28789/` if you used 28789)
- Paste the token from step 1

For production/persistent setup and Docker/systemd options, use:

- Guide: `docs/vps-linux.md`
- Overview: `docs/self-hosting.md`

---

### Security Verified by ZeroLeaks

<p align="center">
  <img src="screenshots/ZeroLeaks-result-010226.png" alt="ZeroLeaks Security Assessment Result" width="600">
  <br>
  <em>CoWork OS achieves one of the highest security scores on <a href="https://zeroleaks.ai/">ZeroLeaks</a> — outperforming many commercial solutions in prompt injection resistance</em>
  <br>
  <a href="ZeroLeaks-Report-jn70f56art03m4rj7fp4b5k9p180aqfd.pdf">View Full Security Assessment Report</a>
</p>

---

<p align="center">
  <img src="screenshots/cowork-os-main.png" alt="CoWork OS Interface" width="700">
  <br>
  <em>Switch between Modern (default) and Terminal visual themes with a real-time task timeline</em>
</p>

---

## Why CoWork OS?

### Security Without Compromise

- **Configurable guardrails**: Token budgets, cost limits, iteration caps
- **Dangerous command blocking**: Built-in patterns + custom regex rules
- **Approval workflows**: User consent required for destructive operations
- **Pairing & allowlists**: Control who can access your AI via messaging channels
- **2800+ tests**: Comprehensive test coverage for access control and policies

### Your Data, Your Control

- **100% local-first**: Database, credentials, and artifacts stay on your machine
- **No telemetry**: We don't track you
- **BYOK**: Bring your own API keys — no middleman, no proxy
- **Open source**: Audit the code yourself

### Connect from Anywhere

- Message your AI from WhatsApp, Telegram, Discord, Slack, Microsoft Teams, Google Chat, iMessage, Signal, Mattermost, Matrix, Twitch, LINE, BlueBubbles, or Email
- **Mobile Companions**: iOS and Android apps for on-the-go access via local network
- Schedule recurring tasks with cron expressions
- Secure remote access via Tailscale or SSH tunnels
- WebSocket API for custom integrations

### Developer-Friendly Tools

- Claude Code-style tools: `glob`, `grep`, `edit_file`
- Browser automation with Playwright
- 85+ bundled skills for popular services
- MCP (Model Context Protocol) support for extensibility

---

## Security Architecture

CoWork OS is designed with security as a core principle, not an afterthought.

### Defense in Depth

| Layer | Protection |
|-------|------------|
| **Channel Access** | Pairing codes, allowlists, brute-force lockout (5 attempts, 15 min cooldown) |
| **Context Policies** | Per-context security modes (DM vs group), tool restrictions per context |
| **Encrypted Storage** | OS keychain (macOS/Windows/Linux) + AES-256 fallback, SHA-256 integrity checks |
| **Gateway Hardening** | Requester-only approval in group chats, tool restrictions, streaming coalescing |
| **Tool Execution** | Risk-level categorization, context-aware isolation, denied tools/groups enforcement |
| **Sandbox Isolation** | Docker containers (cross-platform) or macOS sandbox-exec |
| **File Operations** | Workspace boundaries, path traversal protection |
| **Shell Commands** | Dangerous command blocking, explicit approval required |
| **Browser Automation** | Domain allowlist, configurable restrictions |
| **Resource Limits** | Token budgets, cost caps, iteration limits, file size limits |

### Security Test Coverage

- **132+ security unit tests** for access control and policy enforcement
- **259+ WebSocket protocol tests** for API security
- Monotonic policy precedence (deny-wins across security layers)
- Context-aware tool isolation for shared gateway environments

### Sandbox Isolation

Shell commands run in isolated sandboxes:

| Platform | Sandbox Type | Features |
|----------|--------------|----------|
| **macOS** | `sandbox-exec` | Native Apple sandbox profiles, no setup required |
| **Linux/Windows** | Docker | Container isolation, resource limits, network isolation |
| **Fallback** | Process isolation | Timeouts, resource limits (when Docker unavailable) |

Docker sandbox features:
- CPU and memory limits (`--cpus`, `--memory`)
- Network isolation (`--network none` by default)
- Read-only workspace mounting option
- Automatic cleanup of containers

### Per-Context Security Policies

Different security settings for direct messages vs group chats:

| Context | Default Mode | Default Restrictions |
|---------|--------------|---------------------|
| **DM** | Pairing | No restrictions |
| **Group** | Pairing | Memory tools blocked (clipboard) |

Configure per-context policies in **Settings > Channels > [Channel] > Context Policies**.

> **See also:** [docs/security/](docs/security/) for comprehensive security documentation.

---

## Providers & Costs (BYOK)

CoWork OS is **free and open source**. To run tasks, configure your own model credentials or use local models.

| Provider | Configuration | Billing |
|----------|---------------|---------|
| Anthropic API | API key in Settings | Pay-per-token |
| Google Gemini | API key in Settings | Pay-per-token (free tier available) |
| OpenRouter | API key in Settings | Pay-per-token (multi-model access) |
| OpenAI (API Key) | API key in Settings | Pay-per-token |
| OpenAI (ChatGPT OAuth) | Sign in with ChatGPT account | Uses your ChatGPT subscription |
| AWS Bedrock | AWS credentials in Settings (auto-resolves inference profiles) | Pay-per-token via AWS |
| Ollama (Local) | Install Ollama and pull models | **Free** (runs locally) |
| Groq | API key in Settings | Pay-per-token |
| xAI (Grok) | API key in Settings | Pay-per-token |
| Kimi (Moonshot) | API key in Settings | Pay-per-token |

### Compatible / Gateway Providers

| Provider | Configuration | Billing |
|----------|---------------|---------|
| OpenCode Zen | API key + base URL in Settings | Provider billing |
| Google Vertex | Access token + base URL in Settings | Provider billing |
| Google Antigravity | Access token + base URL in Settings | Provider billing |
| Google Gemini CLI | Access token + base URL in Settings | Provider billing |
| Z.AI | API key + base URL in Settings | Provider billing |
| GLM | API key + base URL in Settings | Provider billing |
| Vercel AI Gateway | API key in Settings | Provider billing |
| Cerebras | API key in Settings | Provider billing |
| Mistral | API key in Settings | Provider billing |
| GitHub Copilot | GitHub token in Settings | Subscription-based |
| Moonshot (Kimi) | API key in Settings | Provider billing |
| Qwen Portal | API key in Settings | Provider billing |
| MiniMax | API key in Settings | Provider billing |
| MiniMax Portal | API key in Settings | Provider billing |
| Xiaomi MiMo | API key in Settings | Provider billing |
| Venice AI | API key in Settings | Provider billing |
| Synthetic | API key in Settings | Provider billing |
| Kimi Code | API key in Settings | Provider billing |
| OpenAI-Compatible (Custom) | API key + base URL in Settings | Provider billing |
| Anthropic-Compatible (Custom) | API key + base URL in Settings | Provider billing |

**Your usage is billed directly by your provider.** CoWork OS does not proxy or resell model access.

---

## Features

### Multi-Channel AI Gateway

- **WhatsApp**: QR code pairing, self-chat mode, markdown support
- **Telegram**: Bot commands, streaming responses, workspace selection
- **Discord**: Slash commands, DM support, guild integration
- **Slack**: Socket Mode, channel mentions, file uploads
- **Microsoft Teams**: Bot Framework SDK, DM/channel mentions, adaptive cards
- **Google Chat**: Service account auth, spaces/DMs, threaded conversations, cards
- **iMessage**: macOS native integration, pairing codes
- **Signal**: End-to-end encrypted messaging via signal-cli
- **Mattermost**: WebSocket real-time, REST API, team/channel support
- **Matrix**: Federated messaging, room-based, end-to-end encryption ready
- **Twitch**: IRC chat integration, multi-channel, whisper support
- **LINE**: Messaging API webhooks, reply tokens, 200M+ users in Asia
- **BlueBubbles**: iMessage via Mac server, SMS support, attachments
- **Email**: IMAP/SMTP, any email provider, subject filtering, threading

All channels support:
- Security modes (pairing, allowlist, open)
- Brute-force protection
- Session management
- Rate limiting
- Inbound attachment persistence (files saved to `.cowork/inbox/attachments/`)
- Chat commands: `/schedule`, `/digest`, `/followups`, `/brief` (see channel docs below)
- **Ambient mode**: Passively ingest all messages without responding (slash commands still routed); enable per-channel in settings
- **Self-message capture**: Capture your own outgoing messages as context (`captureSelfMessages` on WhatsApp, iMessage, BlueBubbles)

### Visual Theme System

Customize the app appearance with visual style and color mode options.

| Visual Style | Description |
|-------------|-------------|
| **Modern** | Refined non-terminal UI style with rounded components (default) |
| **Terminal** | CLI-inspired interface with prompt-style visuals |

| Color Mode | Description |
|------------|-------------|
| **System** | Follows your macOS light/dark mode preference |
| **Light** | Clean light interface |
| **Dark** | Dark mode for reduced eye strain |

Configure in **Settings** > **Appearance**.

### Agent Capabilities

- **Task-Based Workflow**: Multi-step execution with plan-execute-observe loops
- **Goal Mode**: Define success criteria and auto-retry until verification passes
- **Dynamic Re-Planning**: Agent can revise its plan mid-execution
- **85+ Built-in Skills**: GitHub, Slack, Notion, Spotify, Apple Notes, and more
- **Document Creation**: Excel, Word, PDF, PowerPoint with professional formatting
- **Persistent Memory**: Cross-session context with privacy-aware observation capture
- **Workspace Kit**: `.cowork/` project kit + markdown indexing with context injection
- **Agent Teams**: Multi-agent collaboration with shared checklists, coordinated runs, and team management UI
- **Performance Reviews**: Score and review agent-role outcomes, with autonomy-level recommendations
- **Voice Calls**: Outbound phone calls via ElevenLabs Agents (list agents, list numbers, initiate calls)
- **Vision**: Analyze workspace images (screenshots, photos, diagrams) via `analyze_image` tool (OpenAI, Anthropic, or Gemini)
- **Image Generation**: Create images via `generate_image` with multi-provider support (Gemini, OpenAI gpt-image-1/1.5/DALL-E, Azure OpenAI) and automatic provider selection
- **Visual Annotation**: Iterative image refinement with the Visual Annotator — generate, annotate, refine, repeat until approved
- **Email IMAP Access**: Direct IMAP mailbox access via `email_imap_unread` — check unread emails without needing Google Workspace
- **Workspace Recency**: Workspaces ordered by last used time for quick access

### Voice Mode

Talk to your AI assistant with voice input and audio responses, plus make outbound phone calls.

| Feature | Description |
|---------|-------------|
| **Text-to-Speech** | ElevenLabs (premium), OpenAI TTS, or local Web Speech API |
| **Speech-to-Text** | OpenAI Whisper for accurate transcription |
| **Multiple Voices** | Choose from ElevenLabs voices or OpenAI voices (alloy, echo, fable, onyx, nova, shimmer) |
| **Outbound Phone Calls** | Initiate phone calls via ElevenLabs Agents (list agents, list numbers, make calls) |
| **Customizable** | Volume, speech rate, language settings |
| **Secure Storage** | All settings encrypted via OS keychain (macOS/Windows/Linux) with AES-256 fallback |

**Supported Providers:**

| Provider | TTS | STT | Cost |
|----------|-----|-----|------|
| **ElevenLabs** | ✓ (Premium quality) | — | Pay-per-character |
| **OpenAI** | ✓ | ✓ (Whisper) | Pay-per-token |
| **Local** | ✓ (Web Speech API) | Coming soon | Free |

Configure in **Settings** > **Voice**.

### Persistent Memory System

Capture and recall observations across sessions for improved context continuity.

| Feature | Description |
|---------|-------------|
| **Auto-Capture** | Observations, decisions, and errors captured during task execution |
| **Privacy Protection** | Auto-detects sensitive patterns (API keys, passwords, tokens) |
| **FTS5 Search** | Full-text search with relevance ranking |
| **LLM Compression** | Summarizes observations for ~10x token efficiency |
| **Progressive Retrieval** | 3-layer approach: snippets → timeline → full details |
| **Per-Workspace Settings** | Enable/disable, privacy modes, retention policies |

**Privacy Modes:**

| Mode | Description |
|------|-------------|
| **Normal** | Auto-detect and mark sensitive data as private |
| **Strict** | Mark all memories as private (local only) |
| **Disabled** | No memory capture |

Configure in **Settings** > **Memory** for each workspace.

### Workspace Kit (.cowork)

Initialize and maintain a `.cowork/` directory inside each workspace for durable context, project scaffolding, and prompt injection.

| Feature | Description |
|---------|-------------|
| **Kit Initialization** | Creates a standard `.cowork/` structure + templates (agents, identity, memory, etc.) |
| **Project Contexts** | Create `.cowork/projects/<projectId>/` with `ACCESS.md`, `CONTEXT.md`, and `research/` |
| **Markdown Indexing** | Indexes `.cowork/` markdown files for durable human-edited context |
| **Keyword Search** | Search by keyword matching against indexed sections |
| **Context Injection** | Aggregates workspace kit files (and relevant project contexts) into agent prompts automatically |
| **Global Toggles** | Enable/disable memory features globally via Memory Hub settings |
| **Per-Workspace Settings** | Configure memory behavior per workspace |
| **Mixed Search Results** | Supports both database and markdown-backed search results |

Notes:
- Context injection is only enabled for private tasks and can be toggled in **Settings** > **Memory Hub**.
- Project access rules are enforced for file/edit/grep tools and for project context injection.

Configure in **Settings** > **Memory Hub**.

### Agent Teams

Coordinate multiple agents working together on complex tasks with shared state.

| Feature | Description |
|---------|-------------|
| **Team Management** | Create and manage teams with multiple agent members |
| **Shared Checklists** | Agents share checklist items for coordinated task execution |
| **Run Tracking** | Track team runs with status, progress, and history |
| **Member Roles** | Assign different agents to team members |
| **Defaults** | Set default model + personality preferences for spawned work |
| **Queue-Friendly** | Team runs respect global concurrency limits by default |
| **UI Panel** | Full React UI for creating, managing, and monitoring agent teams |
| **Data Persistence** | SQLite-backed repositories for teams, members, items, and runs |

Configure in **Mission Control** > **Teams**.

### Performance Reviews

Generate performance reviews for agent roles based on recent task outcomes and apply recommended autonomy levels.

| Feature | Description |
|---------|-------------|
| **Ratings + Metrics** | Deterministic scoring based on completion/failure and throughput |
| **Autonomy Recommendations** | Suggests `intern` / `specialist` / `lead` based on recent performance |
| **History** | Stored locally for audit and comparison |

Configure in **Mission Control** > **Reviews**.

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
- **Apple Calendar**: Create, update, delete calendar events via `apple_calendar_action`
- **Apple Reminders**: Create, complete, update, list reminders via `apple_reminders_action`

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

- **Stored locally**: Task metadata, timeline events, artifact index, workspace config, memories (SQLite)
- **Sent to provider**: Task prompt and context you choose to include
- **Not sent**: Your API keys (stored locally via OS keychain), private memories (marked sensitive)

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
│  Permission Manager | Cron Service | Memory Service              │
└─────────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────────┐
│                    Execution Layer                               │
│  File Operations | Document Skills | Browser Automation          │
│  LLM Providers (20+) | Search Providers (4) | MCP Client          │
└─────────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────────┐
│  SQLite Database | MCP Host Server | WebSocket Control Plane     │
│  Tailscale / SSH Tunnel Remote Access                            │
└─────────────────────────────────────────────────────────────────┘
```

---

## System Requirements

| Requirement | Minimum | Recommended |
|-------------|---------|-------------|
| **macOS** | 12 (Monterey) | 13+ (Ventura or later) |
| **RAM** | 4 GB | 8 GB+ |
| **CPU** | 2 cores | 4+ cores |
| **Architecture** | Intel (x64) or Apple Silicon (arm64) | Apple Silicon |

### Supported macOS Versions

- macOS 12 Monterey
- macOS 13 Ventura
- macOS 14 Sonoma
- macOS 15 Sequoia

### Resource Usage Notes

- **Base memory**: ~300-500 MB (Electron + React UI)
- **Per bot integration**: ~50-100 MB additional (WhatsApp, Telegram, etc.)
- **Playwright automation**: ~200-500 MB when active
- **CPU**: Mostly idle; spikes during AI API calls (network I/O bound)

### Running on a macOS VM

If you prefer not to run CoWork OS on your main Mac, you can install it on a macOS virtual machine:

| Platform | VM Options |
|----------|------------|
| **Apple Silicon Mac** | UTM, Parallels Desktop, VMware Fusion |
| **Intel Mac** | Parallels Desktop, VMware Fusion, VirtualBox |

**Recommended VM specs:**
- 4+ GB RAM allocated to VM
- 2+ CPU cores
- 40+ GB disk space

This is a good option for:
- Testing before installing on your main machine
- Isolating AI agent file operations from your primary system
- Running experimental tasks in a sandboxed environment

---

## Screenshots

<p align="center">
  <img src="screenshots/cowork-os-main2.png" alt="CoWork OS Interface" width="800">
  <br>
  <em>Main interface with task timeline and execution view</em>
</p>

<p align="center">
  <img src="screenshots/cowork-os-settings1.png" alt="CoWork OS Settings" width="800">
  <br>
  <em>Settings panel for AI providers and channel configuration</em>
</p>

<p align="center">
  <img src="screenshots/cowork-os-settings3.png" alt="CoWork OS Channel Settings" width="800">
  <br>
  <em>Messaging channel integrations and security modes</em>
</p>

---

## Usage

### 1. Select a Workspace

On first launch, select a folder where CoWork OS can work. This folder will be:
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
  <img src="screenshots/cowork-os-settings2.png" alt="CoWork OS Security Settings" width="800">
  <br>
  <em>Security and workspace configuration options</em>
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
- **Channel Delivery**: Send results to Telegram, Discord, Slack, Teams, Google Chat, WhatsApp, iMessage, Signal, Mattermost, Matrix, Twitch, LINE, BlueBubbles, or Email
- **Conditional Delivery**: Only post results when non-empty (`deliverOnlyIfResult`) — useful for monitors that should stay silent on no-ops
- **Template Variables**: Use `{{today}}`, `{{tomorrow}}`, `{{week_end}}`, `{{now}}` in job prompts for dynamic date context
- **Chat Context Variables**: Jobs with channel delivery can use `{{chat_messages}}`, `{{chat_since}}`, `{{chat_until}}`, `{{chat_message_count}}`, `{{chat_truncated}}` to inject recent chat history into prompts
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
| `/schedule <prompt>` | Schedule a recurring task |
| `/digest [lookback]` | Digest of recent chat messages |
| `/followups [lookback]` | Extract follow-ups/commitments |
| `/brief [today\|week]` | Generate a brief summary (DM only) |

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
| `/schedule <prompt>` | Schedule a recurring task |
| `/digest [lookback]` | Digest of recent chat messages |
| `/followups [lookback]` | Extract follow-ups/commitments |
| `/brief [today\|week]` | Generate a brief summary (DM only) |

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
| `/schedule <prompt>` | Schedule a recurring task |
| `/digest [lookback]` | Digest of recent chat messages |
| `/followups [lookback]` | Extract follow-ups/commitments |
| `/brief [today\|week]` | Generate a brief summary (DM only) |

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

## Microsoft Teams Bot Integration

Run tasks via Microsoft Teams using the Bot Framework SDK for full bi-directional messaging.

### Prerequisites

- Azure account with Bot Services access
- Microsoft Teams workspace where you can add apps
- Public webhook URL (use ngrok for local development)

### Setting Up Teams

1. **Create an Azure Bot**:
   - Go to [Azure Portal - Create Bot](https://portal.azure.com/#create/Microsoft.AzureBot)
   - Choose **Multi-tenant** or **Single-tenant** type
   - Create or select a resource group
   - Click **Create**

2. **Get Bot Credentials**:
   - In the Bot resource, go to **Configuration**
   - Copy the **Microsoft App ID**
   - Click **Manage Password** to go to App Registration
   - Under **Certificates & secrets**, create a new client secret
   - Copy the secret value (shown only once)

3. **Add Teams Channel**:
   - In the Bot resource, go to **Channels**
   - Click **Microsoft Teams** and enable the channel

4. **Set Up Webhook (for local development)**:
   ```bash
   ngrok http 3978
   ```
   - Copy the HTTPS URL from ngrok
   - In Azure Bot **Configuration**, set Messaging endpoint to: `https://your-ngrok-url/api/messages`

5. **Configure in CoWork OS**:
   - Open **Settings** > **Teams** tab
   - Enter your Microsoft App ID
   - Enter your App Password (client secret)
   - Optionally enter Tenant ID (for single-tenant apps)
   - Set webhook port (default: 3978)
   - Click **Add Teams Bot**

### Security Modes

| Mode | Description |
|------|-------------|
| **Pairing** (default) | Users must enter a pairing code to interact |
| **Allowlist** | Only pre-approved Teams users can message |
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
| `/schedule <prompt>` | Schedule a recurring task |
| `/digest [lookback]` | Digest of recent chat messages |
| `/followups [lookback]` | Extract follow-ups/commitments |
| `/brief [today\|week]` | Generate a brief summary (DM only) |

### Message Features

- **Direct Messages**: Chat directly with the bot
- **Channel Mentions**: @mention the bot in any channel it's added to
- **Adaptive Cards**: Rich card formatting for responses
- **Markdown Support**: Basic markdown in messages
- **File Attachments**: Send documents and images
- **Message Editing**: Edit and delete messages

### Important Notes

- **Webhook Required**: A public endpoint is needed to receive messages from Teams
- **ngrok for Development**: Use ngrok or similar to expose local port 3978
- **Rate Limits**: Teams has rate limits (50 requests/second per bot)
- **Auto-Reconnect**: Built-in reconnection with exponential backoff

---

## Google Chat Bot Integration

Run tasks via Google Chat using the Google Chat API with service account authentication.

### Prerequisites

- Google Cloud project with Chat API enabled
- Service account with appropriate permissions
- Public webhook URL (use ngrok for local development)

### Setting Up Google Chat

1. **Enable Google Chat API**:
   - Go to [Google Cloud Console](https://console.cloud.google.com/apis/library/chat.googleapis.com)
   - Enable the Google Chat API for your project

2. **Create a Service Account**:
   - Go to **IAM & Admin** > **Service Accounts**
   - Click **Create Service Account**
   - Give it a name and description
   - Grant roles: `Chat Bots Viewer` and `Chat Bots Admin`
   - Create a JSON key and download it

3. **Configure Chat App**:
   - Go to [Chat API Configuration](https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat)
   - Set **App Status** to "Live"
   - Under **Connection settings**, select "HTTP endpoint URL"
   - Enter your public webhook URL (e.g., `https://your-ngrok-url/googlechat/webhook`)

4. **Set Up Webhook (for local development)**:
   ```bash
   ngrok http 3979
   ```
   - Copy the HTTPS URL and use it in the Chat API configuration

5. **Configure in CoWork OS**:
   - Open **Settings** > **Google Chat** tab
   - Enter the path to your service account JSON key file
   - Optionally enter Project ID
   - Set webhook port (default: 3979)
   - Click **Add Google Chat Bot**

### Security Modes

| Mode | Description |
|------|-------------|
| **Pairing** (default) | Users must enter a pairing code to interact |
| **Allowlist** | Only pre-approved Google users can message |
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
| `/schedule <prompt>` | Schedule a recurring task |
| `/digest [lookback]` | Digest of recent chat messages |
| `/followups [lookback]` | Extract follow-ups/commitments |
| `/brief [today\|week]` | Generate a brief summary (DM only) |

### Message Features

- **Direct Messages**: Chat directly with the bot in 1:1 conversations
- **Spaces**: Add the bot to Google Chat spaces for team access
- **Threaded Replies**: Maintains conversation threads
- **Cards**: Rich card formatting for responses (coming soon)
- **Message Editing**: Edit and delete messages

### Important Notes

- **Webhook Required**: A public endpoint is needed to receive messages from Google Chat
- **ngrok for Development**: Use ngrok or similar to expose local port 3979
- **Service Account**: Different from OAuth - uses JWT for server-to-server auth
- **Workspace Users Only**: Google Chat bots only work within Google Workspace organizations

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

## Signal Bot Integration

Run tasks via Signal with end-to-end encryption using `signal-cli`.

### Prerequisites

- **signal-cli**: Install via Homebrew or from [GitHub](https://github.com/AsamK/signal-cli)
  ```bash
  brew install signal-cli
  ```
- **Dedicated phone number**: Signal allows only one registration per phone number. Using the bot will deregister your existing Signal app on that number.
- **Java Runtime**: signal-cli requires Java 17+

### Registration Options

| Option | Description | Best For |
|--------|-------------|----------|
| **Dedicated Number** | Register with a separate phone number | Production use |
| **Link as Device** | Link signal-cli as secondary device to existing account | Testing (limited functionality) |

### Setting Up Signal

1. **Register your phone number** (if using dedicated number):
   ```bash
   signal-cli -a +1234567890 register
   # Enter verification code when received
   signal-cli -a +1234567890 verify CODE
   ```

2. **Configure in CoWork OS**:
   - Open **Settings** > **Signal** tab
   - Enter your phone number
   - Select data directory (default: `~/.local/share/signal-cli`)
   - Click **Add Signal Channel**

3. **Check registration status** using the "Check Registration" button

### Security Modes

| Mode | Description |
|------|-------------|
| **Pairing** (default) | Users must enter a pairing code to interact |
| **Allowlist** | Only pre-approved phone numbers can message |
| **Open** | Anyone can message (not recommended) |

### Trust Modes

| Mode | Description |
|------|-------------|
| **TOFU** (Trust On First Use) | Auto-trust new identity keys on first contact |
| **Always** | Always trust identity keys (less secure) |
| **Manual** | Require manual verification of identity keys |

### Operating Modes

| Mode | Description |
|------|-------------|
| **Native** | Direct signal-cli command execution |
| **Daemon** | Connect to signal-cli JSON-RPC daemon (advanced) |

### Bot Commands

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

### Important Notes

- **Single Registration Limitation**: Signal only allows one active registration per phone number. Registering signal-cli will deregister any existing Signal app using that number.
- **Verification Codes**: You'll need access to receive SMS or voice calls on the phone number for verification.
- **Identity Keys**: Signal uses identity keys for end-to-end encryption. The trust mode determines how new keys are handled.

---

## Mattermost Bot Integration

Run tasks via Mattermost using the REST API and WebSocket for real-time messaging.

### Prerequisites

- Mattermost server (self-hosted or cloud)
- Personal Access Token with appropriate permissions

### Setting Up Mattermost

1. **Generate a Personal Access Token**:
   - Go to **Account Settings** > **Security** > **Personal Access Tokens**
   - Click **Create Token** and copy the token

2. **Configure in CoWork OS**:
   - Open **Settings** > **Mattermost** tab
   - Enter your server URL (e.g., `https://your-team.mattermost.com`)
   - Enter your Personal Access Token
   - Optionally specify a Team ID
   - Click **Connect Mattermost**

### Security Modes

| Mode | Description |
|------|-------------|
| **Pairing** (default) | Users must enter a pairing code to interact |
| **Allowlist** | Only pre-approved users can message |
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
| `/schedule <prompt>` | Schedule a recurring task |
| `/digest [lookback]` | Digest of recent chat messages |
| `/followups [lookback]` | Extract follow-ups/commitments |
| `/brief [today\|week]` | Generate a brief summary (DM only) |

---

## Matrix Bot Integration

Run tasks via Matrix protocol with support for federated messaging and rooms.

### Prerequisites

- Matrix homeserver (Matrix.org, Element, Synapse, or self-hosted)
- Access token for your Matrix account

### Setting Up Matrix

1. **Get your Access Token**:
   - Log into your Matrix client (Element, etc.)
   - Go to **Settings** > **Help & About** > **Advanced**
   - Copy your Access Token
   - Or use the Matrix API to generate one

2. **Configure in CoWork OS**:
   - Open **Settings** > **Matrix** tab
   - Enter your homeserver URL (e.g., `https://matrix.org`)
   - Enter your User ID (e.g., `@yourbot:matrix.org`)
   - Enter your Access Token
   - Optionally specify Room IDs to monitor
   - Click **Connect Matrix**

### Security Modes

| Mode | Description |
|------|-------------|
| **Pairing** (default) | Users must enter a pairing code to interact |
| **Allowlist** | Only pre-approved Matrix users can message |
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
| `/schedule <prompt>` | Schedule a recurring task |
| `/digest [lookback]` | Digest of recent chat messages |
| `/followups [lookback]` | Extract follow-ups/commitments |
| `/brief [today\|week]` | Generate a brief summary (DM only) |

### Important Notes

- **Room-Based**: Matrix operates on rooms. Configure specific room IDs or let the bot respond in any room it's invited to.
- **Federation**: Matrix is federated, allowing communication across different homeservers.
- **E2EE**: End-to-end encryption support depends on room settings.

---

## Twitch Bot Integration

Run tasks via Twitch chat using IRC over WebSocket.

### Prerequisites

- Twitch account for the bot
- OAuth token with chat permissions

### Getting an OAuth Token

1. Visit [twitchtokengenerator.com](https://twitchtokengenerator.com/)
2. Select **Chat Bot** token type
3. Authorize with your Twitch account
4. Copy the OAuth token (starts with `oauth:`)

### Setting Up Twitch

1. **Configure in CoWork OS**:
   - Open **Settings** > **Twitch** tab
   - Enter your Twitch username
   - Enter your OAuth token
   - Enter channel names to join (comma-separated, without #)
   - Optionally enable whispers (DMs)
   - Click **Connect Twitch**

### Security Modes

| Mode | Description |
|------|-------------|
| **Pairing** (default) | Users must enter a pairing code to interact |
| **Allowlist** | Only pre-approved Twitch users can message |
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
| `/schedule <prompt>` | Schedule a recurring task |
| `/digest [lookback]` | Digest of recent chat messages |
| `/followups [lookback]` | Extract follow-ups/commitments |
| `/brief [today\|week]` | Generate a brief summary (DM only) |

### Limitations

- **No File Attachments**: Twitch chat is text-only
- **Rate Limited**: 20 messages per 30 seconds
- **Message Length**: 500 characters max per message (auto-split for longer responses)
- **Whispers**: May require verified account status

---

## LINE Bot Integration

Run tasks via LINE Messaging API with webhooks and push/reply messages.

### Prerequisites

- LINE Developers account ([developers.line.biz](https://developers.line.biz/))
- Messaging API channel with Channel Access Token and Channel Secret
- Public webhook URL (use ngrok or cloudflare tunnel for development)

### Setting Up LINE

1. **Create a LINE Messaging API Channel**:
   - Go to [LINE Developers Console](https://developers.line.biz/console/)
   - Create a new provider or select existing
   - Create a new Messaging API channel
   - Copy the Channel Access Token (long-lived)
   - Copy the Channel Secret

2. **Configure in CoWork OS**:
   - Open **Settings** > **LINE** tab
   - Enter your Channel Access Token
   - Enter your Channel Secret
   - Configure webhook port (default: 3100)
   - Click **Connect LINE**

3. **Configure Webhook in LINE Console**:
   - Set webhook URL to your public endpoint (e.g., `https://your-domain.com/line/webhook`)
   - Enable "Use webhook"
   - Disable "Auto-reply messages" and "Greeting messages"

### Security Modes

| Mode | Description |
|------|-------------|
| **Pairing** (default) | Users must enter a pairing code to interact |
| **Allowlist** | Only pre-approved LINE user IDs can message |
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
| `/schedule <prompt>` | Schedule a recurring task |
| `/digest [lookback]` | Digest of recent chat messages |
| `/followups [lookback]` | Extract follow-ups/commitments |
| `/brief [today\|week]` | Generate a brief summary (DM only) |

### Message Types

- **Reply Messages**: Free, use reply tokens (valid 1 minute)
- **Push Messages**: Uses monthly quota, for proactive messaging

### Important Notes

- **Reply tokens are ephemeral** - valid only for ~1 minute after receiving a message
- **Push messages count against quota** - free plan has limited monthly messages
- **Media messages** require hosting URLs (image/video sending not fully implemented)

---

## BlueBubbles Bot Integration

Run tasks via iMessage using BlueBubbles server running on a Mac.

### Prerequisites

- Mac computer running 24/7 with Messages app signed in
- BlueBubbles server installed ([bluebubbles.app](https://bluebubbles.app/))
- Network access to the BlueBubbles server

### Setting Up BlueBubbles

1. **Install BlueBubbles Server on Mac**:
   - Download from [bluebubbles.app](https://bluebubbles.app/)
   - Follow setup wizard to configure
   - Note the server URL and password

2. **Configure in CoWork OS**:
   - Open **Settings** > **BlueBubbles** tab
   - Enter your server URL (e.g., `http://192.168.1.100:1234`)
   - Enter your server password
   - Optionally configure contact allowlist
   - Click **Connect BlueBubbles**

### Security Modes

| Mode | Description |
|------|-------------|
| **Pairing** (default) | Users must enter a pairing code to interact |
| **Allowlist** | Only pre-approved phone numbers/emails can message |
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
| `/schedule <prompt>` | Schedule a recurring task |
| `/digest [lookback]` | Digest of recent chat messages |
| `/followups [lookback]` | Extract follow-ups/commitments |
| `/brief [today\|week]` | Generate a brief summary (DM only) |

### Features

- **iMessage and SMS**: Send to both iMessage and SMS contacts
- **Group Chats**: Support for group conversations
- **Webhooks or Polling**: Real-time via webhooks or fallback polling

### Important Notes

- **Requires Mac running 24/7** - BlueBubbles server must stay online
- **iMessage limitations** - No message editing or deletion (iMessage doesn't support it)
- **Network access** - CoWork OS must be able to reach the BlueBubbles server

---

## Email Bot Integration

Run tasks via email using IMAP/SMTP. Universal channel that works with any email provider.

### Prerequisites

- Email account with IMAP and SMTP access
- App password (for Gmail, Outlook, Yahoo with 2FA enabled)

### Setting Up Email

1. **Configure in CoWork OS**:
   - Open **Settings** > **Email** tab
   - Use quick setup for Gmail, Outlook, or Yahoo (fills server details)
   - Enter your email address
   - Enter your password or app password
   - Configure IMAP and SMTP settings if using other provider
   - Click **Connect Email**

### Email Provider Settings

| Provider | IMAP Host | IMAP Port | SMTP Host | SMTP Port |
|----------|-----------|-----------|-----------|-----------|
| **Gmail** | imap.gmail.com | 993 | smtp.gmail.com | 587 |
| **Outlook** | outlook.office365.com | 993 | smtp.office365.com | 587 |
| **Yahoo** | imap.mail.yahoo.com | 993 | smtp.mail.yahoo.com | 465 |

### Security Modes

| Mode | Description |
|------|-------------|
| **Pairing** (default) | Users must enter a pairing code to interact |
| **Allowlist** | Only pre-approved email addresses can message |
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
| `/schedule <prompt>` | Schedule a recurring task |
| `/digest [lookback]` | Digest of recent chat messages |
| `/followups [lookback]` | Extract follow-ups/commitments |
| `/brief [today\|week]` | Generate a brief summary (DM only) |

### Filtering Options

- **Allowed Senders**: Comma-separated email addresses to accept (leave empty for all)
- **Subject Filter**: Only process emails containing this text in subject (e.g., `[CoWork]`)

### Features

- **Reply Threading**: Maintains conversation threads via In-Reply-To headers
- **Subject Filtering**: Only process emails with specific subject patterns
- **Sender Allowlist**: Restrict to specific email addresses
- **Universal**: Works with any email provider supporting IMAP/SMTP

### Important Notes

- **App Passwords**: Gmail/Outlook with 2FA require app passwords, not regular passwords
- **No editing/deletion**: Email doesn't support modifying sent messages
- **Attachments**: Not yet implemented
- **Polling**: Uses IMAP polling (default 30 seconds) - not instant delivery

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

## Mobile Companions (iOS/Android)

Access CoWork OS from your iPhone, iPad, or Android device via the local network.

### Prerequisites

- CoWork OS running on your Mac
- Mobile device on the same local network (WiFi)
- Control Plane enabled with LAN access

### Setting Up Mobile Access

1. **Enable Control Plane**:
   - Open **Settings** > **Control Plane**
   - Check **Enable Control Plane**
   - Check **Allow LAN Connections (Mobile Companions)**

2. **Get Connection Details**:
   - Note your Mac's local IP address (shown in Control Plane settings or run `ipconfig getifaddr en0`)
   - Copy the authentication token (click **Show** then **Copy**)

3. **Connect from Mobile App**:
   - Enter server URL: `ws://<your-mac-ip>:18789` (e.g., `ws://192.168.1.100:18789`)
   - Enter authentication token
   - Tap **Connect**

### Features

| Feature | Description |
|---------|-------------|
| **Task Creation** | Create and run tasks from your mobile device |
| **Real-time Updates** | See task progress and results in real-time |
| **Workspace Selection** | Switch between workspaces |
| **Secure Authentication** | Token-based authentication protects access |

### Security Considerations

- **LAN Only**: Mobile companions connect via local network only (not exposed to internet)
- **Token Required**: Each connection requires the authentication token
- **Firewall**: Ensure your Mac's firewall allows connections on port 18789
- **Same Network**: Mobile device must be on the same WiFi network as your Mac

### Troubleshooting

| Issue | Solution |
|-------|----------|
| Cannot connect | Verify "Allow LAN Connections" is enabled and restart the server |
| Connection refused | Check firewall settings, ensure port 18789 is accessible |
| Authentication failed | Regenerate and re-enter the authentication token |
| Server not found | Verify Mac's IP address, ensure both devices are on same network |

---

## Web Search Integration

Multi-provider web search for research tasks with automatic retry and fallback.

### Features

- **Automatic Retry**: Transient errors (rate limits, timeouts) trigger automatic retry with exponential backoff
- **Provider Fallback**: If one provider fails, automatically tries the next configured provider
- **Graceful Degradation**: Returns helpful error messages instead of failing silently

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

**Smart Document Detection**: Automatically detects document-heavy workspaces (PDF/DOCX) and provides helpful guidance to use `read_file` instead, since grep only searches text files.

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

## Notion Integration

Configure in **Settings > Integrations > Notion**. Use `notion_action` to search, read, and update Notion content. Write actions (create, update, append, delete) require approval.

### Search pages or data sources

```ts
notion_action({
  action: "search",
  query: "Roadmap"
});
```

### Query a data source with filters and sorts

```ts
notion_action({
  action: "query_data_source",
  data_source_id: "YOUR_DATA_SOURCE_ID",
  filter: {
    property: "Status",
    select: { equals: "Active" }
  },
  sorts: [
    { property: "Updated", direction: "descending" }
  ],
  page_size: 25
});
```

### Paginate a data source query

```ts
notion_action({
  action: "query_data_source",
  data_source_id: "YOUR_DATA_SOURCE_ID",
  start_cursor: "NEXT_CURSOR_FROM_PREVIOUS_RESPONSE",
  page_size: 25
});
```

### Update or delete a block

```ts
notion_action({
  action: "update_block",
  block_id: "BLOCK_ID",
  block_type: "paragraph",
  block: {
    rich_text: [{ text: { content: "Updated text" } }]
  }
});

notion_action({
  action: "delete_block",
  block_id: "BLOCK_ID"
});
```

---

## Box Integration

Configure in **Settings > Integrations > Box**. Use `box_action` to search, read, and manage Box files and folders. Write actions (create, upload, delete) require approval.

### Search for files

```ts
box_action({
  action: "search",
  query: "Q4 report",
  type: "file",
  limit: 25
});
```

### Upload a file

```ts
box_action({
  action: "upload_file",
  file_path: "reports/summary.pdf",
  parent_id: "0"
});
```

---

## OneDrive Integration

Configure in **Settings > Integrations > OneDrive**. Use `onedrive_action` to search, read, and manage OneDrive files and folders. Write actions (create, upload, delete) require approval.

### Search for files

```ts
onedrive_action({
  action: "search",
  query: "Roadmap"
});
```

### Upload a file

```ts
onedrive_action({
  action: "upload_file",
  file_path: "reports/summary.pdf"
});
```

---

## Google Workspace Integration

Configure in **Settings > Integrations > Google Workspace**. Unified access to Gmail, Google Calendar, and Google Drive with shared OAuth authentication.

### Available Tools

| Service | Tool | Actions |
|---------|------|---------|
| **Drive** | `google_drive_action` | list_files, search, upload_file, download_file, delete_file |
| **Gmail** | `gmail_action` | list_messages, search, send_email, read_email, create_draft |
| **Calendar** | `google_calendar_action` | list_events, create_event, update_event, delete_event |

### Gmail - Send an email

```ts
gmail_action({
  action: "send_email",
  to: "recipient@example.com",
  subject: "Weekly Report",
  body: "Please find the attached report..."
});
```

### Calendar - Create an event

```ts
google_calendar_action({
  action: "create_event",
  title: "Team Standup",
  start_time: "2025-02-10T09:00:00",
  end_time: "2025-02-10T09:30:00",
  attendees: ["team@example.com"]
});
```

### Drive - List files

```ts
google_drive_action({
  action: "list_files",
  page_size: 20
});
```

---

## Dropbox Integration

Configure in **Settings > Integrations > Dropbox**. Use `dropbox_action` to search, read, and manage Dropbox files and folders. Write actions (create, upload, delete) require approval.

### List folder contents

```ts
dropbox_action({
  action: "list_folder",
  path: "/Reports"
});
```

### Upload a file

```ts
dropbox_action({
  action: "upload_file",
  file_path: "reports/summary.pdf",
  path: "/Reports/summary.pdf"
});
```

---

## SharePoint Integration

Configure in **Settings > Integrations > SharePoint**. Use `sharepoint_action` to search sites and manage drive items. Write actions (create, upload, delete) require approval.

### Search sites

```ts
sharepoint_action({
  action: "search_sites",
  query: "Marketing"
});
```

### Upload a file

```ts
sharepoint_action({
  action: "upload_file",
  file_path: "reports/summary.pdf"
});
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

## Additional LLM Providers

Configure these in **Settings** > **LLM Provider** by entering API keys/tokens, model IDs, and base URLs when required.

| Provider | Compatibility |
|----------|---------------|
| OpenCode Zen | OpenAI-compatible |
| Google Vertex | OpenAI-compatible |
| Google Antigravity | OpenAI-compatible |
| Google Gemini CLI | OpenAI-compatible |
| Z.AI | OpenAI-compatible |
| GLM | OpenAI-compatible |
| Vercel AI Gateway | Anthropic-compatible |
| Cerebras | OpenAI-compatible |
| Mistral | OpenAI-compatible |
| GitHub Copilot | OpenAI-compatible |
| Moonshot (Kimi) | OpenAI-compatible |
| Qwen Portal | Anthropic-compatible |
| MiniMax | OpenAI-compatible |
| MiniMax Portal | Anthropic-compatible |
| Xiaomi MiMo | Anthropic-compatible |
| Venice AI | OpenAI-compatible |
| Synthetic | Anthropic-compatible |
| Kimi Code | OpenAI-compatible |
| OpenAI-Compatible (Custom) | OpenAI-compatible |
| Anthropic-Compatible (Custom) | Anthropic-compatible |

---

## Built-in Skills (85+)

| Category | Skills |
|----------|--------|
| **Developer** | GitHub, GitLab, Linear, Jira, Sentry, Code Reviewer, Multi-PR Review, Developer Growth Analysis |
| **Communication** | Slack, Discord, Telegram, Email, Voice Calls (ElevenLabs Agents) |
| **Productivity** | Notion, Obsidian, Todoist, Apple Notes/Reminders/Calendar, PRD Generator, Memory Kit |
| **Media** | Spotify, YouTube, SoundCloud |
| **Image** | Image Generation (Gemini/OpenAI/Azure), Agentic Image Loop (visual annotation workflow) |
| **Documents** | Excel, Word, PDF, PowerPoint |
| **Frontend** | Frontend Design, React Native Best Practices |
| **Data** | Supabase SDK Patterns |
| **Search** | Local Web Search (SearXNG), Bird |
| **Use Cases** | Booking Options, Draft Reply, Family Digest, Household Capture, Newsletter Digest, Transaction Scan |

---

## MCP (Model Context Protocol)

### MCP Client

Connect to external MCP servers for extended capabilities.

### MCP Host

Expose CoWork's tools as an MCP server for external clients.

### MCP Registry

Browse and install servers from a catalog with one-click installation.

---

## Enterprise MCP Connectors

Pre-built MCP server connectors for enterprise integrations. Install from **Settings > MCP Servers > Browse Registry**.

### Available Connectors

| Connector | Type | Tools |
|-----------|------|-------|
| **Salesforce** | CRM | `health`, `list_objects`, `describe_object`, `get_record`, `search_records`, `create_record`, `update_record` |
| **Jira** | Issue Tracking | `health`, `list_projects`, `get_issue`, `search_issues`, `create_issue`, `update_issue` |
| **HubSpot** | CRM | `health`, `list_contacts`, `get_contact`, `search_contacts`, `create_contact`, `update_contact` |
| **Zendesk** | Support | `health`, `list_tickets`, `get_ticket`, `search_tickets`, `create_ticket`, `update_ticket` |
| **ServiceNow** | ITSM | `health`, `list_incidents`, `get_incident`, `search_incidents`, `create_incident`, `update_incident` |
| **Linear** | Product/Issue | `health`, `list_issues`, `get_issue`, `search_issues`, `create_issue`, `update_issue` |
| **Asana** | Work Management | `health`, `list_tasks`, `get_task`, `search_tasks`, `create_task`, `update_task` |
| **Okta** | Identity | `health`, `list_users`, `get_user`, `search_users`, `create_user`, `update_user` |

### Setup

1. Go to **Settings > MCP Servers > Browse Registry**
2. Find the connector you need (e.g., Salesforce)
3. Click **Install**
4. Configure credentials when prompted (API keys, OAuth tokens, etc.)
5. The connector tools become available to the agent

### Building Custom Connectors

Use the connector template to build your own:

```bash
cp -r connectors/templates/mcp-connector connectors/my-connector
cd connectors/my-connector
npm install
# Edit src/index.ts to implement your tools
npm run build
```

See [docs/enterprise-connectors.md](docs/enterprise-connectors.md) for the full connector contract and conventions.

---

## WebSocket Control Plane

Programmatic API for external automation and mobile companion apps.

### Features

- Challenge-response token authentication
- Request/response/event protocol
- Rate limiting for auth attempts
- Full task API (create, list, get, cancel)
- Real-time event streaming
- **LAN Access**: Enable "Allow LAN Connections" for mobile companion support
- **Web Dashboard**: Built-in HTML dashboard at `http://127.0.0.1:18789/` for headless management (tasks, approvals, workspaces, channels)
- **Approval API**: List and respond to pending approvals remotely (`approval.list`, `approval.respond`)
- **Channel Management**: Create, update, enable/disable, test, and remove channels via API

### Connection Modes

| Mode | Binding | Use Case |
|------|---------|----------|
| **Local Only** | `127.0.0.1:18789` | Desktop automation, localhost only |
| **LAN Access** | `0.0.0.0:18789` | Mobile companions, local network access |

Configure in **Settings** > **Control Plane**.

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

- [x] Multi-provider LLM support (20+ providers including Groq, xAI, Kimi, GitHub Copilot, OpenAI/Anthropic-compatible)
- [x] Multi-channel messaging (14 channels)
- [x] Configurable guardrails and security
- [x] Browser automation with Playwright
- [x] Code tools (glob, grep, edit_file)
- [x] Document creation (Excel, Word, PDF, PowerPoint)
- [x] MCP support (Client, Host, Registry)
- [x] WebSocket Control Plane with API
- [x] Tailscale and SSH remote access
- [x] Personality system
- [x] 85+ bundled skills (code reviewer, PRD, multi-PR review, frontend design, local websearch, developer growth, React Native, Supabase, bird)
- [x] 2800+ unit tests
- [x] Docker-based sandboxing (cross-platform)
- [x] Per-context security policies (DM vs group)
- [x] Enhanced pairing code UI with countdown
- [x] Persistent memory system with privacy protection
- [x] Mobile Companions with LAN access support
- [x] Voice Mode with ElevenLabs and OpenAI integration
- [x] Enterprise MCP Connectors (Salesforce, Jira, HubSpot, Zendesk, ServiceNow, Linear, Asana, Okta)
- [x] Cloud Storage Integrations (Notion, Box, OneDrive, Google Drive, Dropbox, SharePoint)
- [x] Visual Theme System (Modern/Terminal visual styles + Light/Dark/System color modes)
- [x] Workspace recency ordering
- [x] Web search retry with exponential backoff
- [x] Google Workspace Integration (Gmail, Calendar, Drive with shared OAuth)
- [x] Gateway channel cleanup and enhanced security (Matrix direct rooms, Slack groups)
- [x] Agent transient error retry logic for improved reliability
- [x] Smart parameter inference for document creation tools
- [x] Bedrock inference profile auto-resolution (auto-resolves model IDs to inference profiles)
- [x] Gateway hardening (group chat security, streaming coalescing, restart resilience, tool restrictions)
- [x] Outbound phone calls via ElevenLabs Agents (voice_call tool)
- [x] Workspace Kit (`.cowork/` init + projects, markdown indexing, context injection, memory hub settings)
- [x] Agent Teams (multi-agent collaboration with shared checklists, coordinated runs, team UI)
- [x] Gateway pending selection state for workspace/provider commands (improved WhatsApp/iMessage UX)
- [x] Task result summary persistence from executor to daemon
- [x] Memory retention isolation for sub-agents and public contexts
- [x] Vision tool (`analyze_image`) for workspace image analysis via OpenAI, Anthropic, or Gemini
- [x] Email IMAP tool (`email_imap_unread`) for direct mailbox access without Google Workspace
- [x] Chat commands: `/schedule`, `/digest`, `/followups`, `/brief` across all gateway channels
- [x] Inbound attachment persistence (channel messages save files to `.cowork/inbox/attachments/`)
- [x] Cron template variables (`{{today}}`, `{{chat_messages}}`, etc.) and conditional delivery
- [x] Image generation via `generate_image` with multi-provider support (Gemini, OpenAI, Azure OpenAI)
- [x] Visual annotation tools and Agentic Image Loop skill for iterative image refinement
- [x] Inline image preview in task event timeline
- [x] Local memory embeddings and cross-workspace ChatGPT imported memory search
- [x] Apple Calendar and Reminders tools (macOS native via AppleScript)
- [x] Gateway ambient mode (passive message ingestion) and self-message capture
- [x] Use-case skill templates (booking, draft reply, family digest, household capture, newsletter digest, transaction scan)
- [x] Headless Electron mode with env-based credential import (`COWORK_IMPORT_ENV_SETTINGS`)
- [x] Node.js daemon entrypoint for non-Electron headless deployments (`coworkd-node.js`)
- [x] Control plane web dashboard, approval API, and channel management API
- [x] Docker and VPS deployment support (Dockerfiles, docker-compose, systemd units)
- [x] Dedicated workspaces for scheduled cron jobs (auto-created from temp workspace)

### Planned

- [ ] VM sandbox using macOS Virtualization.framework
- [ ] Network egress controls with proxy
- [ ] Cross-platform UI support (Windows, Linux)

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

---

## Security

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

For end-user security guidance, see:
- [SECURITY_GUIDE.md](SECURITY_GUIDE.md) - Quick reference
- [docs/security/](docs/security/) - Comprehensive security documentation
  - [Security Model](docs/security/security-model.md) - Architecture overview
  - [Trust Boundaries](docs/security/trust-boundaries.md) - Isolation layers
  - [Configuration Guide](docs/security/configuration-guide.md) - Setup instructions
  - [Best Practices](docs/security/best-practices.md) - Recommended settings

---

## License

MIT License. See [LICENSE](LICENSE).

---

## Legal

"Cowork" is an Anthropic product name. CoWork OS is an independent open-source project and is not affiliated with, endorsed by, or sponsored by Anthropic. If requested by the rights holder, we will update naming/branding.
