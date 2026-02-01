<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="screenshots/cowork-oss-logo.png">
    <source media="(prefers-color-scheme: light)" srcset="screenshots/cowork-oss-logo.png">
    <img src="screenshots/cowork-oss-logo.png" alt="CoWork-OSS Logo" width="120">
  </picture>
</p>

# CoWork-OSS

[![npm version](https://img.shields.io/npm/v/cowork-oss.svg)](https://www.npmjs.com/package/cowork-oss)
[![npm downloads](https://img.shields.io/npm/dm/cowork-oss.svg)](https://www.npmjs.com/package/cowork-oss)
[![CI](https://github.com/mesutfelat/cowork-oss/actions/workflows/ci.yml/badge.svg)](https://github.com/mesutfelat/cowork-oss/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![macOS](https://img.shields.io/badge/platform-macOS-blue.svg)](https://www.apple.com/macos/)
[![Electron](https://img.shields.io/badge/electron-40.0.0-47848F.svg)](https://www.electronjs.org/)

**Local-first agent workbench for folder-scoped tasks (BYOK)**

```
  ██████╗ ██████╗ ██╗    ██╗ ██████╗ ██████╗ ██╗  ██╗       ██████╗ ███████╗███████╗
 ██╔════╝██╔═══██╗██║    ██║██╔═══██╗██╔══██╗██║ ██╔╝      ██╔═══██╗██╔════╝██╔════╝
 ██║     ██║   ██║██║ █╗ ██║██║   ██║██████╔╝█████╔╝ █████╗██║   ██║███████╗███████╗
 ██║     ██║   ██║██║███╗██║██║   ██║██╔══██╗██╔═██╗ ╚════╝██║   ██║╚════██║╚════██║
 ╚██████╗╚██████╔╝╚███╔███╔╝╚██████╔╝██║  ██║██║  ██╗      ╚██████╔╝███████║███████║
  ╚═════╝ ╚═════╝  ╚══╝╚══╝  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝       ╚═════╝ ╚══════╝╚══════╝
```

CoWork-OSS is an open-source, local-first agent workbench for running multi-step tasks in a folder-scoped workspace, with explicit approvals for destructive actions and built-in skills for generating documents, spreadsheets, and presentations.

**You bring your own model credentials (Anthropic API / Google Gemini / OpenRouter / OpenAI / AWS Bedrock) or run locally with Ollama; usage is billed by your provider (or free with Ollama).**

> **Independent project.** CoWork-OSS is not affiliated with, endorsed by, or sponsored by Anthropic.
> This project implements a local, folder-scoped agent workflow pattern in open source.

**Status**: macOS desktop app (cross-platform support planned).

---

## ⚠️ Safety & Data Loss Warning

**CoWork-OSS can modify, move, overwrite, or delete files** as part of normal operation — or due to bugs, misuse, or unexpected AI behavior. Before using this software, please understand and follow these guidelines:

1. **Use a separate environment when possible.** Run CoWork-OSS on a dedicated Mac, a separate user account, or a virtual machine to isolate it from your primary data.

2. **Work only in non-critical folders.** If you cannot use a separate environment, select only folders you can afford to lose. **Never point CoWork-OSS at important personal files, system folders, or production data.**

3. **Enable and verify backups before use.** Ensure Time Machine or another backup solution is running and has recent, verified backups. Test that you can restore files before relying on them.

4. **Review all approval requests carefully.** The agent will ask for permission before destructive operations, but approvals are your responsibility. Read what the agent wants to do before clicking "Approve."

5. **Expect the unexpected.** AI systems can behave unpredictably. Files may be modified or deleted even when you don't expect it. Treat every workspace as potentially at risk.

> **Disclaimer:** The maintainers and contributors of CoWork-OSS are **not responsible** for any data loss, file corruption, or other damage resulting from the use of this software. You use CoWork-OSS entirely at your own risk.

---

<p align="center">
  <img src="screenshots/cowork-oss4.jpeg" alt="CoWork-OSS Interface" width="700">
  <br>
  <em>Terminal-inspired UI — because GUIs shouldn't feel like GUIs</em>
</p>

---

## Why CoWork-OSS?

- **CLI-style interface**: Terminal-inspired UI with monospace fonts, status indicators `[✓]`, and keyboard-friendly navigation
- **Local-first state**: Tasks/events/artifacts are stored locally in SQLite; model requests are sent to your configured provider (Anthropic/Bedrock). No telemetry by default
- **Folder-scoped security**: File operations are constrained to your selected workspace with path traversal protection
- **Permissioned execution**: Explicit user approval required for destructive operations (delete, bulk rename)
- **Transparent runtime**: Real-time timeline showing every step, tool call, and decision
- **BYOK (Bring Your Own Key)**: Use your own API credentials — no proxy, no reselling

**Note**: Today CoWork-OSS enforces workspace boundaries in-app; a VM sandbox is on the roadmap.

---

## Providers & Costs (BYOK)

CoWork-OSS is **free and open source**. To run tasks, you must configure your own model credentials or use local models.

| Provider | Configuration | Billing |
|----------|---------------|---------|
| Anthropic API | Configure API key in Settings | Pay-per-token |
| Google Gemini | Configure API key in Settings | Pay-per-token (free tier available) |
| OpenRouter | Configure API key in Settings | Pay-per-token (multi-model access) |
| OpenAI (API Key) | Configure API key in Settings | Pay-per-token |
| OpenAI (ChatGPT OAuth) | Sign in with your ChatGPT account | Uses your ChatGPT subscription |
| AWS Bedrock | Configure AWS credentials in Settings | Pay-per-token via AWS |
| Ollama (Local) | Install Ollama and pull models | **Free** (runs locally) |

**Your usage is billed directly by your provider.** CoWork-OSS does not proxy or resell model access. With Ollama, everything runs on your machine for free.

---

## Features

### Core Capabilities

- **Task-Based Workflow**: Multi-step task execution with plan-execute-observe loops
- **Goal Mode**: Define success criteria (shell commands or file checks) and let the agent auto-retry up to N attempts until verification passes
- **Dynamic Re-Planning**: Agent can revise its plan mid-execution based on new information or obstacles
- **Workspace Management**: Sandboxed file operations within selected folders (with optional broader filesystem access)
- **Permission System**: Explicit approval for destructive operations
- **Auto-Approve Trusted Commands**: Configure patterns for safe shell commands that auto-approve without prompts
- **75+ Built-in Skills**: Ready-to-use integrations with popular services:
  - **Developer Tools**: GitHub, GitLab, Linear, Jira, Sentry
  - **Communication**: Slack, Discord, Telegram, Email
  - **Productivity**: Notion, Obsidian, Todoist, Apple Notes/Reminders
  - **Media**: Spotify, YouTube, SoundCloud
  - **Document Creation**: Excel, Word, PDF, PowerPoint with professional formatting
  - **And many more**: Smart home, cloud storage, AI services, utilities
- **Real-Time Timeline**: Live activity feed showing agent actions and tool calls
- **Artifact Tracking**: All created/modified files are tracked and viewable
- **Model Selection**: Choose between Opus, Sonnet, or Haiku models
- **Parallel Task Queue**: Run multiple tasks concurrently with configurable limits (1-10, default 3)
- **Quick Task FAB**: Floating action button for rapid task creation
- **Toast Notifications**: Real-time notifications for task completion and failures
- **Scheduled Tasks**: Schedule recurring tasks with cron expressions, channel delivery, and run history
- **In-App Notification Center**: Bell icon notification panel with mark as read, delete, and click-to-navigate
- **WhatsApp Bot**: Run tasks via WhatsApp with QR code pairing, self-chat mode, and markdown support
- **Telegram Bot**: Run tasks remotely via Telegram with workspace selection and streaming responses
- **Discord Bot**: Run tasks via Discord with slash commands and direct messages
- **Slack Bot**: Run tasks via Slack with Socket Mode, direct messages, and channel mentions
- **iMessage Bot** (macOS): Run tasks via iMessage using the imsg CLI with pairing support
- **Menu Bar App** (macOS): Native menu bar companion with quick access to workspaces and tasks
- **Quick Input Window** (macOS): Global shortcut (⌘⇧Space) for instant task input from anywhere
- **Web Search**: Multi-provider web search (Tavily, Brave, SerpAPI, Google) with fallback support
- **Browser Automation**: Full web browser control with Playwright:
  - Navigate to URLs, take screenshots, save pages as PDF
  - Click, fill forms, type text, press keys
  - Extract page content, links, and form data
  - Scroll pages, wait for elements, execute JavaScript
- **Live Canvas**: Agent-driven visual workspace for dynamic content:
  - Create interactive HTML/CSS/JavaScript visualizations
  - **In-app preview**: Live preview embedded in the task view with two modes:
    - **Interactive mode** (default): Full browser-like interaction directly in the preview
    - **Snapshot mode**: Static screenshot with auto-refresh every 2 seconds
  - Resize preview by dragging the bottom edge
  - Open in separate window for expanded view
  - Execute JavaScript in canvas context and retrieve results
  - A2UI (Agent-to-UI) communication for interactive workflows
  - Export options: Download HTML, open in browser, show in Finder
  - Perfect for dashboards, charts, forms, and prototypes
- **Code Tools**: Claude Code-style tools for code navigation and editing:
  - **glob** - Fast pattern-based file search (e.g., `**/*.ts`, `src/**/*.tsx`)
  - **grep** - Regex content search across files with context lines
  - **edit_file** - Surgical file editing with find-and-replace
- **Web Fetch Tools**: Lightweight HTTP tools for fetching web content:
  - **web_fetch** - Fetch and parse web pages with optional CSS selectors
  - **http_request** - Full HTTP client with custom methods, headers, and body (curl-like)
- **System Tools**: Access to system-level capabilities:
  - Take screenshots (full screen or specific windows)
  - Read/write clipboard content
  - Open applications, URLs, and file paths
  - Show files in Finder
  - Get system information and environment variables
  - **Run AppleScript** - Execute AppleScript to automate macOS apps and system tasks
- **Update Notifications**: Automatic check for new releases with in-app notification banner
- **Bundled Skills Library**: 75+ pre-configured skills for common workflows
  - GitHub, Slack, Notion, Spotify, and many more integrations
  - Apple ecosystem support via AppleScript (Notes, Reminders, Calendar)
  - Context-aware prompts that guide the agent for each service
- **MCP (Model Context Protocol)**: Full MCP support for extensibility:
  - **MCP Client**: Connect to external MCP servers (filesystem, databases, APIs)
  - **MCP Host**: Expose CoWork's tools as an MCP server for external clients
  - **MCP Registry**: Browse and install MCP servers from a catalog with one-click installation
- **WebSocket Control Plane**: Programmatic API for external automation:
  - Challenge-response token authentication
  - Request/response/event protocol over WebSocket
  - Rate limiting for authentication attempts
  - Full task management API (create, list, cancel, send messages)
- **Tailscale Integration**: Secure remote access without port forwarding:
  - **Serve mode**: Expose locally to your Tailscale network (tailnet)
  - **Funnel mode**: Expose publicly via Tailscale's global edge network
  - Automatic HTTPS with valid certificates
  - No firewall or router configuration required
- **SSH Tunnel Support**: Secure remote access via standard SSH:
  - Connect to remote CoWork instances through SSH port forwarding
  - No additional software required (uses standard SSH)
  - Encrypted transport with OS keychain token storage
  - Auto-reconnection with exponential backoff
  - Connection testing before committing
- **Mobile Companions**: Connect iOS/Android devices as remote nodes:
  - Mobile devices connect via WebSocket as "nodes" with device-specific capabilities
  - Camera capture (front/back), GPS location, screen recording, SMS (Android)
  - AI agent tools for interacting with mobile devices
  - Real-time node status and event broadcasting
  - Settings UI for viewing and testing connected devices
- **Personality & Customization**: Customize agent behavior via prompts or Settings UI:
  - **Personalities**: Communication styles (professional, friendly, concise, creative, technical, casual)
  - **Personas**: Character overlays (Jarvis, Friday, HAL, Computer, Alfred, Intern, Sensei, Pirate, Noir)
  - **Response Style**: Emoji usage, response length, code comments, explanation depth
  - **Quirks**: Catchphrases, sign-offs, analogy domains
  - **Relationship**: Agent remembers your name and tracks completed tasks

## Data handling (local-first, BYOK)
- Stored locally: task metadata, timeline events, artifact index, workspace config (SQLite).
- Sent to provider: the task prompt and any context you choose to include (e.g., selected file contents/snippets) to generate outputs.
- Not sent: your API keys (stored locally).

### Architecture

```
┌─────────────────────────────────────────────────┐
│              React UI (Renderer)                 │
│  - Task List                                     │
│  - Task Timeline                                 │
│  - Approval Dialogs                              │
│  - Workspace Selector                            │
│  - Notification Panel                            │
│  - Live Command Output (In-app terminal view)    │
│  - Live Canvas Preview (Interactive browser)     │
│  - MCP Settings & Registry Browser               │
└─────────────────────────────────────────────────┘
                      ↕ IPC
┌─────────────────────────────────────────────────┐
│            Agent Daemon (Main Process)           │
│  - Task Queue Manager (Parallel Execution)       │
│  - Agent Executor (Plan-Execute Loop)            │
│  - Tool Registry (Built-in + MCP Tools)          │
│  - Permission Manager                            │
│  - Custom Skill Loader                           │
│  - Cron Service (Scheduled Tasks)                │
│  - Notification Service                          │
│  - Canvas Manager (Live visual workspace)        │
└─────────────────────────────────────────────────┘
                      ↕
┌─────────────────────────────────────────────────┐
│                  Execution Layer                 │
│  - File Operations                               │
│  - Skills (Document Creation)                    │
│  - LLM Providers (Anthropic/Gemini/OpenRouter/OpenAI/Bedrock/Ollama)│
│  - Search Providers (Tavily/Brave/SerpAPI/Google)│
│  - MCP Client (External Tool Servers)            │
└─────────────────────────────────────────────────┘
                      ↕
┌─────────────────────────────────────────────────┐
│              SQLite Local Database               │
│  - Tasks, Events, Artifacts, Workspaces          │
└─────────────────────────────────────────────────┘
                      ↕
┌─────────────────────────────────────────────────┐
│              MCP Host Server (Optional)          │
│  - Expose CoWork tools to external clients       │
│  - JSON-RPC over stdio                           │
└─────────────────────────────────────────────────┘
                      ↕
┌─────────────────────────────────────────────────┐
│           WebSocket Control Plane (Optional)     │
│  - REST/WebSocket API for external automation    │
│  - Token-based authentication                    │
│  - Task management (create, cancel, monitor)     │
│  - Real-time event streaming                     │
│  - Mobile companion node management              │
└─────────────────────────────────────────────────┘
                      ↕
┌─────────────────────────────────────────────────┐
│           Mobile Companions (Optional)           │
│  - iOS/Android devices as remote nodes           │
│  - Camera, location, screen, SMS capabilities    │
│  - WebSocket connection with role-based auth     │
│  - Real-time device status and events            │
└─────────────────────────────────────────────────┘
                      ↕
┌─────────────────────────────────────────────────┐
│           Remote Access (Optional)               │
│  - Tailscale Serve: Local tailnet access         │
│  - Tailscale Funnel: Public HTTPS endpoint       │
│  - SSH Tunnel: Standard SSH port forwarding      │
│  - Auto TLS certificates                         │
└─────────────────────────────────────────────────┘
```

---

## Setup

### Prerequisites

- Node.js 18+ and npm
- macOS (for Electron native features)
- One of: Anthropic API key, Google Gemini API key, OpenRouter API key, OpenAI API key, AWS Bedrock access, or Ollama installed locally

### Installation

#### Option 1: Install via npm (Recommended)

```bash
# Install globally
npm install -g cowork-oss

# Run the app
cowork-oss
# or simply:
cowork
```

#### Option 2: Install from Source (Development)

```bash
# Clone the repository
git clone https://github.com/mesutfelat/cowork-oss.git
cd cowork-oss

# Install dependencies
npm install

# Run in development mode
npm run dev
```

After launching, configure your API credentials in Settings (gear icon).

### Updating

```bash
# Check for updates
npm outdated -g cowork-oss

# Update to latest version
npm update -g cowork-oss

# Or reinstall to force latest
npm install -g cowork-oss@latest
```

### Uninstalling

```bash
npm uninstall -g cowork-oss
```

### Building for Production

For contributors building distributable packages:

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

> **See also:** [⚠️ Safety & Data Loss Warning](#%EF%B8%8F-safety--data-loss-warning) at the top of this document for critical safety guidelines.
>
> **For a comprehensive security guide**, see [SECURITY_GUIDE.md](SECURITY_GUIDE.md) which covers the app's permissions model, data storage, network connections, and best practices.

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
  network: boolean;   // Network access (future)
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

## Configurable Guardrails

CoWork-OSS includes configurable safety guardrails that you can customize in **Settings > Guardrails**. These provide additional protection against runaway tasks, excessive costs, and dangerous operations.

### Available Guardrails

| Guardrail | Description | Default | Range |
|-----------|-------------|---------|-------|
| **Token Budget** | Limits total tokens (input + output) per task | 100,000 | 1K - 10M |
| **Cost Budget** | Limits estimated cost (USD) per task | $1.00 (disabled) | $0.01 - $100 |
| **Iteration Limit** | Limits LLM calls per task to prevent infinite loops | 50 | 5 - 500 |
| **Dangerous Command Blocking** | Blocks shell commands matching dangerous patterns | Enabled | On/Off + custom patterns |
| **Auto-Approve Trusted Commands** | Skip approval for safe commands (npm test, git status, etc.) | Disabled | On/Off + patterns |
| **File Size Limit** | Limits the size of files the agent can write | 50 MB | 1 - 500 MB |
| **Domain Allowlist** | Restricts browser automation to approved domains | Disabled | On/Off + domain list |

### Token & Cost Budgets

Token and cost budgets help prevent runaway tasks from consuming excessive resources:

- **Token Budget**: Tracks total input + output tokens across all LLM calls in a task
- **Cost Budget**: Calculates estimated cost based on model pricing (Claude, Gemini, GPT-4, Llama, etc.)

When a budget is exceeded, the task stops with a clear error message showing usage vs. limit.

### Dangerous Command Blocking

Built-in patterns block potentially destructive shell commands **before** they reach the approval dialog:

**Default blocked patterns:**
- `sudo` - Elevated privileges
- `rm -rf /` - Recursive deletion of root
- `mkfs` - Filesystem formatting
- `dd if=` - Direct disk writes
- Fork bombs - Process exhaustion attacks
- `curl|bash` - Piped execution from internet

You can add custom patterns (regex supported) to block additional commands specific to your environment.

### Auto-Approve Trusted Commands

For productivity, you can configure patterns for commands that auto-approve without prompts:

**Default trusted patterns** (when enabled):
- `npm test*`, `npm run *`, `npm install*` - Package manager commands
- `git status*`, `git diff*`, `git log*` - Read-only git commands
- `ls`, `pwd`, `cat *`, `head *`, `tail *` - File inspection commands
- Version checks (`node --version`, `python --version`, etc.)

You can add custom patterns using glob-style syntax (e.g., `cargo build*`, `make test*`).

### Domain Allowlist

When enabled, browser automation is restricted to approved domains only:

- Specify exact domains: `github.com`
- Use wildcards: `*.google.com` (matches all subdomains)
- Block all navigation when enabled with no domains configured

This prevents the agent from navigating to unexpected websites during browser automation tasks.

### Configuration

1. Open **Settings** (gear icon)
2. Navigate to the **Guardrails** tab
3. Enable/disable guardrails using toggle switches
4. Adjust values as needed
5. Add custom blocked patterns or allowed domains
6. Click **Save Settings**

Settings are stored locally and persist across app restarts.

---

## Parallel Task Queue

CoWork-OSS supports running multiple tasks in parallel with a configurable concurrency limit. This allows you to queue up several tasks and have them execute automatically without waiting for each one to complete.

### How It Works

1. **Concurrency Limit**: Set the maximum number of tasks that can run simultaneously (1-10, default: 3)
2. **FIFO Queue**: Tasks beyond the limit are queued and processed in the order they were created
3. **Auto-Start**: When a running task completes, the next queued task automatically starts
4. **Persistence**: Queued tasks survive app restarts - they'll resume when you reopen CoWork-OSS

### Queue Panel

When tasks are running or queued, a panel appears showing:
- **Running tasks** with a spinner indicator
- **Queued tasks** with their position in the queue (#1, #2, etc.)
- **View** button to see task details
- **Cancel** button to stop or remove tasks

### Quick Task FAB

A floating action button (FAB) in the bottom-right corner lets you quickly create new tasks:
1. Click the **+** button
2. Type your task prompt
3. Press Enter or click submit
4. The task is created and queued automatically

### Toast Notifications

Real-time notifications appear when:
- A task **completes successfully** (green toast)
- A task **fails** with an error (red toast)

Click a toast to jump to that task's details.

### Configuration

1. Open **Settings** (gear icon)
2. Navigate to the **Task Queue** tab
3. Adjust the **Maximum concurrent tasks** slider (1-10)
4. Click **Save Settings**

### Use Cases

- **Batch Processing**: Queue multiple file organization or document generation tasks
- **Research Tasks**: Run several web search or analysis tasks in parallel
- **Multi-Project Work**: Work on tasks across different parts of your workspace simultaneously

---

## Scheduled Tasks (Cron Jobs)

CoWork-OSS supports scheduling recurring tasks using cron expressions. This allows you to automate repetitive tasks to run at specific times or intervals, with optional delivery of results to messaging channels.

### Features

- **Cron Expressions**: Schedule tasks using standard cron syntax (minute, hour, day, month, weekday)
- **Workspace Binding**: Each scheduled task runs in a specific workspace
- **Channel Delivery**: Optionally send task results to Telegram, Discord, Slack, WhatsApp, or iMessage
- **Run History**: View execution history with status, duration, and error details
- **Enable/Disable**: Toggle jobs on or off without deleting them
- **Manual Trigger**: Run any scheduled task on-demand

### Setting Up Scheduled Tasks

1. Open **Settings** (gear icon)
2. Navigate to the **Schedule** tab
3. Click **Add Scheduled Task**
4. Configure your task:
   - **Name**: A descriptive name for the job
   - **Schedule**: Cron expression or use the visual schedule builder
   - **Workspace**: Select the workspace where the task will run
   - **Task Prompt**: What the agent should do when triggered
   - **Channel Delivery** (optional): Select a connected channel to receive results

### Cron Expression Examples

| Schedule | Cron Expression | Description |
|----------|-----------------|-------------|
| Every hour | `0 * * * *` | Runs at the start of every hour |
| Daily at 9am | `0 9 * * *` | Runs every day at 9:00 AM |
| Every weekday at 6pm | `0 18 * * 1-5` | Runs Monday-Friday at 6:00 PM |
| Weekly on Sunday | `0 0 * * 0` | Runs every Sunday at midnight |
| Every 30 minutes | `*/30 * * * *` | Runs every 30 minutes |
| First of month | `0 0 1 * *` | Runs on the 1st of every month at midnight |

### Visual Schedule Builder

If you're not familiar with cron syntax, use the visual schedule builder:
- Select frequency: **Hourly**, **Daily**, **Weekly**, **Monthly**
- Choose specific times and days
- The cron expression is generated automatically

### Channel Delivery

When channel delivery is enabled, task results are sent to your configured messaging channels:

1. **Task Completion**: Receive a summary when the task finishes successfully
2. **Task Failure**: Get notified immediately if a task fails
3. **Summary Mode**: Option to send only a brief summary vs. full results

Supported channels:
- Telegram
- Discord
- Slack
- WhatsApp
- iMessage

### Run History

View the execution history for each scheduled task:
- **Status**: Success ✅, Failed ❌, or Timed Out ⏱️
- **Duration**: How long the task took to execute
- **Started At**: When the task began
- **Error Details**: Error message if the task failed
- **Task ID**: Link to the full task details

### Example Use Cases

- **Daily Backup Report**: "Every day at 6 PM, check my project folders for uncommitted changes and send a summary to Telegram"
- **Weekly Code Review**: "Every Monday at 9 AM, analyze the codebase for TODO comments and create a report"
- **Hourly Monitoring**: "Every hour, check if the build passes and notify me on Discord if it fails"
- **Monthly Cleanup**: "On the first of each month, organize my Downloads folder by file type"

---

## In-App Notification Center

CoWork-OSS includes a notification center accessible from the title bar, providing a centralized place to view and manage notifications for scheduled tasks and other events.

### Features

- **Bell Icon**: Notification bell in the top-right corner with unread badge count
- **Notification Panel**: Click the bell to open a dropdown panel with all notifications
- **Click to Navigate**: Click any notification to jump to the related task
- **Mark as Read**: Individual or bulk "mark all as read" actions
- **Delete Notifications**: Remove individual notifications or clear all
- **Real-Time Updates**: New notifications appear instantly without refresh
- **macOS Native Notifications**: Desktop notifications for scheduled task completions

### Notification Types

| Type | Icon | Description |
|------|------|-------------|
| Task Completed | ✅ | A task or scheduled task finished successfully |
| Task Failed | ❌ | A task encountered an error |
| Scheduled Task | ⏰ | A scheduled task event notification |
| Info | ℹ️ | Informational notification |
| Warning | ⚠️ | Warning notification |
| Error | 🚨 | Error notification |

### Using the Notification Center

1. **View Notifications**: Click the bell icon in the top-right corner
2. **Unread Badge**: The red badge shows the count of unread notifications
3. **Click Notification**: Opens the related task in the main view
4. **Mark as Read**: Clicking a notification automatically marks it as read
5. **Mark All Read**: Click "Mark all read" to clear the unread badge
6. **Delete**: Hover over a notification and click the X to delete it
7. **Clear All**: Click "Clear all" to remove all notifications

### Desktop Notifications

When a scheduled task completes, you'll receive:
1. **macOS Native Notification**: Shows task status and allows clicking to focus the app
2. **In-App Notification**: Stored in the notification center for later reference

### Notification Persistence

Notifications are stored locally and persist across app restarts. They include:
- Notification title and message
- Timestamp
- Read/unread status
- Links to related tasks or scheduled jobs

---

## In-App Views

CoWork-OSS provides embedded views for monitoring and interacting with agent activities directly within the main window.

### Live Command Output

When the agent executes shell commands, a live terminal view appears showing:
- **Real-time output**: See command stdout/stderr as it streams
- **Running indicator**: Visual feedback while commands execute
- **Exit code**: Shows success (0) or failure codes when complete
- **Dismissible**: Close the output panel when done reviewing
- **Auto-show**: Automatically appears when a new command starts

### Live Canvas Preview

When the agent creates visual content using Live Canvas, an interactive preview appears:
- **Interactive mode** (default): Full browser-like interaction directly in the preview
  - Click buttons, fill forms, scroll content
  - No need to open external windows for basic interactions
- **Snapshot mode**: Static screenshot with auto-refresh every 2 seconds
- **Toggle with I key**: Switch between interactive and snapshot modes
- **Resizable**: Drag the bottom edge to adjust preview height
- **Export options**: Download HTML, open in browser, show in Finder
- **History panel**: Browse through previous snapshots
- **Keyboard shortcuts**: Quick access to all features (see [Live Canvas docs](docs/live-canvas.md))

Both views appear inline in the task timeline, allowing you to monitor agent activities without switching windows.

---

## Compliance

This project requires users to comply with their model provider's terms and policies:

- [Anthropic Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms)
- [Anthropic Usage Policy](https://www.anthropic.com/legal/aup)
- [AWS Bedrock Third-Party Model Terms](https://aws.amazon.com/legal/bedrock/third-party-models/)

**Note:** For consumer-facing use, Anthropic’s Usage Policy requires disclosing that users are interacting with AI at the beginning of each session. CoWork-OSS shows an explicit “AI system” disclosure when starting a new task/session.

## Trademark notice
“Cowork” is an Anthropic product name. CoWork-OSS is an independent open-source project and is not affiliated with Anthropic.
If requested by the rights holder, we will update naming/branding to avoid confusion.

---

## Roadmap

### Completed
- [x] Folder-scoped workspace + path traversal protection
- [x] Approval gates for destructive operations
- [x] Task timeline + artifact outputs
- [x] Multi-provider support (Anthropic API / Google Gemini / OpenRouter / OpenAI / AWS Bedrock / Ollama)
- [x] Model selection (Opus, Sonnet, Haiku, or any Ollama model)
- [x] Built-in skills (documents, spreadsheets, presentations)
- [x] **Real Office format support** (Excel .xlsx, Word .docx, PDF, PowerPoint .pptx)
- [x] SQLite local persistence
- [x] **WhatsApp bot integration** with QR code pairing and self-chat mode
- [x] Telegram bot integration for remote task execution
- [x] **Discord bot integration** with slash commands and DM support
- [x] **Slack bot integration** with Socket Mode and channel mentions
- [x] **iMessage bot integration** (macOS) with imsg CLI and pairing support
- [x] **Menu bar app** (macOS) - native companion with quick access to workspaces and tasks
- [x] **Quick Input window** (macOS) - global shortcut (⌘⇧Space) for instant task input from anywhere
- [x] Web search integration (Tavily, Brave, SerpAPI, Google)
- [x] Local LLM support via Ollama (free, runs on your machine)
- [x] **Browser automation** with Playwright (navigate, click, fill, screenshot, PDF)
- [x] **Configurable guardrails** (token/cost budgets, iteration limits, command blocking, file size limits, domain allowlist)
- [x] **Goal Mode** - Define success criteria and auto-retry until verification passes
- [x] **Dynamic re-planning** - Agent can revise plan mid-execution with `revise_plan` tool
- [x] **System tools** - Screenshots, clipboard, open apps/URLs/paths, system info
- [x] **Auto-approve trusted commands** - Skip approval for safe shell commands matching patterns
- [x] **Broader filesystem access** - Optional access to files outside workspace boundaries
- [x] **Update notifications** - In-app banner when new releases are available
- [x] **Parallel task queue** - Run multiple tasks concurrently with configurable limits and queue management
- [x] **Quick Task FAB** - Floating action button for rapid task creation
- [x] **Toast notifications** - Real-time notifications for task completion and failures
- [x] **Scheduled Tasks** - Cron-based task scheduling with channel delivery and run history
- [x] **In-App Notification Center** - Bell icon notification panel with mark as read, delete, and click-to-navigate
- [x] **Live Canvas Interactive Mode** - In-app browser preview with interactive/snapshot modes, export options, and history
- [x] **Live Command Output** - In-app terminal view showing real-time shell command execution
- [x] **75+ Bundled Skills** - Pre-configured integrations for GitHub, Slack, Notion, Spotify, Apple Notes/Reminders, and many more
- [x] **MCP Client** - Connect to external MCP servers and use their tools
- [x] **MCP Host** - Expose CoWork's tools as an MCP server for external clients
- [x] **MCP Registry** - Browse and install MCP servers from a catalog with one-click installation
- [x] **MCP SSE Transport** - Connect to web-based MCP servers via Server-Sent Events
- [x] **MCP WebSocket Transport** - Real-time bidirectional MCP communication
- [x] **Advanced Security Framework** - Comprehensive security improvements:
  - **Tool Groups & Risk Levels** - Tools categorized by risk (read/write/destructive/system/network)
  - **Monotonic Policy Precedence** - Deny-wins policy system across multiple security layers
  - **Context-Aware Tool Isolation** - Memory/clipboard tools blocked in shared gateway contexts
  - **Concurrent Access Safety** - Mutex locks and idempotency for critical operations
  - **macOS Sandbox Profiles** - Shell command sandboxing with filesystem/network restrictions
  - **Brute-Force Protection** - Pairing code lockout after 5 failed attempts (15 min cooldown)
  - **132 Security Unit Tests** - Comprehensive test suite for security components
- [x] **WebSocket Control Plane** - Programmatic API for external automation:
  - **Challenge-Response Auth** - Secure token-based authentication with nonce
  - **Typed Protocol** - Request/response/event frames with JSON serialization
  - **Rate Limiting** - IP-based auth attempt limiting with configurable ban duration
  - **Full Task API** - Create, list, get, cancel tasks; send messages to running tasks
  - **Real-Time Events** - Subscribe to task updates and system events
  - **259 Unit Tests** - Comprehensive test coverage for protocol and server
- [x] **Tailscale Integration** - Secure remote access without port forwarding:
  - **Serve Mode** - Expose Control Plane to your private tailnet
  - **Funnel Mode** - Expose publicly via Tailscale's global edge network
  - **Auto TLS** - Automatic HTTPS with valid certificates
  - **CLI Detection** - Automatic Tailscale CLI detection and status checking
- [x] **SSH Tunnel Support** - Secure remote access via standard SSH:
  - **Remote Client Mode** - Connect to a Control Plane on another machine
  - **SSH Port Forwarding** - Use standard `ssh -L` for encrypted transport
  - **Auto-Reconnection** - Exponential backoff with configurable retries
  - **Connection Testing** - Verify connectivity before saving configuration
  - **Secure Token Storage** - Remote tokens encrypted via OS keychain

### Planned
- [ ] VM sandbox using macOS Virtualization.framework
- [ ] Network egress controls with proxy

---

## WhatsApp Bot Integration

CoWork-OSS supports running tasks via WhatsApp using the Baileys library for Web WhatsApp connections. This allows you to interact with your agent from WhatsApp on any device.

### Setting Up WhatsApp

#### 1. Add WhatsApp Channel in CoWork-OSS

1. Open CoWork-OSS and go to **Settings** (gear icon)
2. Navigate to the **WhatsApp** tab
3. Click **Add WhatsApp Channel**
4. A QR code will appear on screen

#### 2. Scan the QR Code

1. Open WhatsApp on your phone
2. Go to **Settings** > **Linked Devices**
3. Tap **Link a Device**
4. Scan the QR code displayed in CoWork-OSS
5. Once connected, the channel status will show "Connected"

### Self-Chat Mode

WhatsApp integration supports a unique **Self-Chat Mode** for users who want to use their own WhatsApp number:

| Mode | Description | Best For |
|------|-------------|----------|
| **Self-Chat Mode ON** (default) | Bot only responds in your "Message Yourself" chat | Using your personal WhatsApp |
| **Self-Chat Mode OFF** | Bot responds to all incoming messages | Dedicated bot phone number |

#### Configuring Self-Chat Mode

1. In Settings → WhatsApp, toggle **Self-Chat Mode**
2. Set a **Response Prefix** (e.g., "🤖") to distinguish bot responses from your messages
3. When enabled, the bot only processes messages in your self-chat (the "Message Yourself" conversation)

### Security Modes

Choose the appropriate security mode for your use case:

| Mode | Description | Best For |
|------|-------------|----------|
| **Pairing** (default) | Users must enter a pairing code generated in the app | Personal use, shared devices |
| **Allowlist** | Only pre-approved phone numbers can interact | Team use with known users |
| **Open** | Anyone can message the bot | ⚠️ Not recommended |

### Pairing a User

1. In CoWork-OSS Settings → WhatsApp, click **Generate Code**
2. The user sends the 6-character code to the bot via WhatsApp
3. Once verified, the user is authorized to use the bot
4. Pairing codes expire after 5 minutes

### Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Start the bot and get help |
| `/help` | Show available commands |
| `/workspaces` | List all available workspaces |
| `/workspace` | Select or show current workspace |
| `/newtask` | Start a fresh task/conversation |
| `/status` | Check bot and session status |
| `/cancel` | Cancel the running task |
| `/pair <code>` | Pair with a pairing code |

### Using the Bot

**In Self-Chat Mode:**
1. Open your "Message Yourself" chat in WhatsApp
2. Type your task or command
3. The bot responds with a prefix (e.g., "🤖 Here's the result...")

**With a Dedicated Number:**
1. Message the bot's WhatsApp number directly
2. Type your task or command
3. Receive responses in real-time

### Example Conversation

```
You: /workspaces
Bot: 🤖 Available workspaces:
     1. ~/Documents/project-a
     2. ~/Downloads

You: /workspace 1
Bot: 🤖 Workspace selected: ~/Documents/project-a

You: List all TypeScript files and summarize them
Bot: 🤖 Task created... [streaming updates]
Bot: 🤖 Found 12 TypeScript files. Here's a summary...
```

### Markdown Support

The bot converts standard Markdown to WhatsApp-compatible formatting:
- `**bold**` → `*bold*`
- `### Headers` → `*Headers*` (bold)
- `~~strikethrough~~` → `~strikethrough~`
- `[link](url)` → `link (url)`
- Code blocks are preserved with triple backticks

### Logout and Re-pairing

To disconnect and re-pair WhatsApp:
1. In Settings → WhatsApp, click **Logout**
2. This clears the session credentials
3. Click **Enable** to generate a new QR code
4. Scan again with your phone

### Troubleshooting

**QR Code not appearing:**
- Ensure no other WhatsApp Web sessions are blocking
- Try clicking "Logout" then "Enable" again

**Messages not being received:**
- Check that the channel status shows "Connected"
- Verify Self-Chat Mode setting matches your use case
- In Self-Chat Mode, messages must be in your "Message Yourself" chat

**Bot responding to wrong chats:**
- Enable Self-Chat Mode if using your personal number
- The bot will only respond in your self-chat when this is enabled

---

## Telegram Bot Integration

CoWork-OSS supports running tasks remotely via a Telegram bot. This allows you to interact with your agent from anywhere using Telegram.

### Setting Up the Telegram Bot

#### 1. Create a Bot with BotFather

1. Open Telegram and search for [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts to create your bot
3. Copy the bot token (looks like `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

#### 2. Configure in CoWork-OSS

1. Open CoWork-OSS and go to **Settings** (gear icon)
2. Navigate to the **Channels** tab
3. Enter your bot token and click **Add Telegram Channel**
4. Test the connection, then enable the channel

### Security Modes

Choose the appropriate security mode for your use case:

| Mode | Description | Best For |
|------|-------------|----------|
| **Pairing** (default) | Users must enter a pairing code generated in the app | Personal use, shared devices |
| **Allowlist** | Only pre-approved Telegram user IDs can interact | Team use with known users |
| **Open** | Anyone can use the bot | ⚠️ Not recommended |

### Pairing Your Telegram Account

1. In CoWork-OSS Settings → Channels, click **Generate Pairing Code**
2. Open your Telegram bot and send the pairing code
3. Once paired, you can start using the bot

### Bot Commands

| Command | Description |
|---------|-------------|
| `/workspaces` | List all available workspaces |
| `/workspace <number>` | Select a workspace by number |
| `/addworkspace <path>` | Add a new workspace directory |
| `/status` | Show current session status |
| `/cancel` | Cancel the running task |

### Using the Bot

1. **Select a workspace**: Send `/workspaces` to see available folders, then `/workspace 1` to select one
2. **Create a task**: Simply type your request (e.g., "organize my downloads by file type")
3. **Monitor progress**: The bot will stream updates as the task executes
4. **View results**: Final results are sent when the task completes

### Example Conversation

```
You: /workspaces
Bot: 📂 Available workspaces:
     1. ~/Documents/project-a
     2. ~/Downloads

You: /workspace 1
Bot: ✓ Workspace selected: ~/Documents/project-a

You: List all TypeScript files and count the lines of code
Bot: 🔄 Task created... [streaming updates]
Bot: ✓ Found 23 TypeScript files with 4,521 total lines of code.
```

### Markdown Support

The bot converts responses to Telegram-compatible formatting:
- Tables are displayed as code blocks for readability
- Bold text and code formatting are preserved
- If formatting fails, plain text is sent as fallback

---

## Discord Bot Integration

CoWork-OSS supports running tasks via a Discord bot. Use slash commands or direct messages to interact with your agent from any Discord server or DM.

### Setting Up the Discord Bot

#### 1. Create a Discord Application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application** and give it a name (e.g., "CoWork Bot")
3. Go to the **Bot** section and click **Add Bot**
4. Copy the **Bot Token** (click "Reset Token" if needed)
5. Enable these **Privileged Gateway Intents**:
   - Message Content Intent (required for reading messages)
6. Copy your **Application ID** from the General Information page

#### 2. Invite the Bot to Your Server

1. Go to **OAuth2** → **URL Generator**
2. Select scopes: `bot`, `applications.commands`
3. Select bot permissions:
   - Send Messages
   - Read Message History
   - Use Slash Commands
   - Attach Files
4. Copy the generated URL and open it to invite the bot

#### 3. Configure in CoWork-OSS

1. Open CoWork-OSS and go to **Settings** (gear icon)
2. Navigate to the **Channels** tab
3. Enter your **Bot Token** and **Application ID**
4. Optionally add **Guild IDs** for faster slash command registration (development)
5. Click **Add Discord Channel**
6. Test the connection, then enable the channel

### Bot Commands (Slash Commands)

| Command | Description |
|---------|-------------|
| `/start` | Start the bot and get help |
| `/help` | Show available commands |
| `/workspaces` | List all available workspaces |
| `/workspace [path]` | Select or show current workspace |
| `/addworkspace <path>` | Add a new workspace directory |
| `/newtask` | Start a fresh task/conversation |
| `/provider [name]` | Change or show current LLM provider |
| `/models` | List available AI models |
| `/model [name]` | Change or show current model |
| `/status` | Show current session status |
| `/cancel` | Cancel the running task |
| `/task <prompt>` | Run a task directly |

### Using the Bot

**Via Slash Commands:**
```
/workspaces
/workspace ~/Documents/project
/task Create a summary of all markdown files
```

**Via Direct Messages:**
Simply DM the bot with your request. Commands can also be typed as `/command` in DMs.

**Via Mentions:**
In a server channel, mention the bot with your task:
```
@CoWorkBot organize my project files by type
```

### Example Conversation

```
You: /workspaces
Bot: Available workspaces:
     1. ~/Documents/project-a
     2. ~/Downloads

You: /workspace ~/Documents/project-a
Bot: Workspace selected: ~/Documents/project-a

You: /task List all JavaScript files and count lines of code
Bot: Task created... [streaming updates]
Bot: Found 15 JavaScript files with 2,847 total lines of code.
```

### Security Modes

| Mode | Description | Best For |
|------|-------------|----------|
| **Pairing** (default) | Users must enter a pairing code generated in the app | Personal use |
| **Allowlist** | Only pre-approved Discord user IDs can interact | Team use |
| **Open** | Anyone can use the bot | Not recommended |

### Guild IDs (Optional)

For faster slash command registration during development, specify Guild IDs:
- Global commands take up to 1 hour to propagate
- Guild-specific commands register instantly
- Leave empty for production (global commands)

---

## Slack Bot Integration

CoWork-OSS supports running tasks via a Slack bot using Socket Mode for real-time WebSocket connections without exposing webhooks.

### Setting Up the Slack Bot

#### 1. Create a Slack App

1. Go to the [Slack API Apps](https://api.slack.com/apps) page
2. Click **Create New App** and choose **From scratch**
3. Give your app a name (e.g., "CoWork Bot") and select your workspace

#### 2. Enable Socket Mode

1. Go to **Socket Mode** in the sidebar
2. Toggle **Enable Socket Mode** on
3. Click **Generate** to create an App-Level Token
4. Give it a name (e.g., "cowork-socket") and add the `connections:write` scope
5. Copy the **App-Level Token** (starts with `xapp-...`)

#### 3. Configure OAuth & Permissions

1. Go to **OAuth & Permissions** in the sidebar
2. Under **Bot Token Scopes**, add these scopes:
   - `app_mentions:read` - Receive mention events
   - `chat:write` - Send messages
   - `im:history` - Read DM history
   - `im:read` - View DM info
   - `im:write` - Start DMs
   - `users:read` - Get user info
   - `files:write` - Upload files
3. Click **Install to Workspace** (or reinstall if already installed)
4. Copy the **Bot User OAuth Token** (starts with `xoxb-...`)

#### 4. Configure Event Subscriptions

1. Go to **Event Subscriptions** in the sidebar
2. Toggle **Enable Events** on
3. Under **Subscribe to bot events**, add:
   - `app_mention` - When someone mentions @YourBot
   - `message.im` - Direct messages to the bot

#### 5. Configure in CoWork-OSS

1. Open CoWork-OSS and go to **Settings** (gear icon)
2. Navigate to the **Channels** tab and select **Slack**
3. Enter your credentials:
   - **Bot Token**: The `xoxb-...` token from OAuth & Permissions
   - **App-Level Token**: The `xapp-...` token from Socket Mode
   - **Signing Secret** (optional): Found in Basic Information
4. Click **Add Slack Bot**
5. Test the connection, then enable the channel

### Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Start the bot and get help |
| `/help` | Show available commands |
| `/workspaces` | List all available workspaces |
| `/workspace` | Select or show current workspace |
| `/newtask` | Start a fresh task/conversation |
| `/status` | Check bot status |
| `/cancel` | Cancel the running task |
| `/pair` | Pair with a pairing code |

### Using the Bot

**Via Direct Messages:**
Simply DM the bot with your request. The bot will process your message and respond with results.

**Via Channel Mentions:**
In any channel where the bot is a member, mention it with your task:
```
@CoWorkBot organize these files by date
```

### Example Conversation

```
You: /workspaces
Bot: Available workspaces:
     1. ~/Documents/project-a
     2. ~/Downloads

You: /workspace 1
Bot: Workspace selected: ~/Documents/project-a

You: Create a summary of all markdown files in this project
Bot: Task created... [streaming updates]
Bot: Found 8 markdown files. Here's a summary...
```

### Security Modes

| Mode | Description | Best For |
|------|-------------|----------|
| **Pairing** (default) | Users must enter a pairing code generated in the app | Personal use |
| **Allowlist** | Only pre-approved Slack user IDs can interact | Team use |
| **Open** | Anyone can use the bot | Not recommended |

### Pairing Your Slack Account

1. In CoWork-OSS Settings → Channels → Slack, click **Generate Code**
2. In Slack, DM the bot with `/pair <code>` using the generated code
3. Once paired, you can start using the bot

### Markdown Support

The bot converts responses to Slack mrkdwn format:
- Headers become bold text
- Code blocks are preserved
- Links use Slack's `<url|text>` format
- Long messages are automatically chunked (Slack's 4000 char limit)

---

## iMessage Bot Integration (macOS Only)

CoWork-OSS supports running tasks via iMessage on macOS using the `imsg` CLI tool. This allows you to interact with your agent through Apple's native messaging platform.

### Prerequisites

- macOS with Messages app signed in
- `imsg` CLI tool installed
- Full Disk Access permission granted

### Setting Up iMessage

#### 1. Install the imsg CLI

```bash
brew install steipete/tap/imsg
```

#### 2. Grant Full Disk Access

The imsg CLI needs Full Disk Access to read the Messages database:

1. Open **System Settings** → **Privacy & Security** → **Full Disk Access**
2. Enable access for your **Terminal** application (or CoWork-OSS if running as a packaged app)

#### 3. Configure in CoWork-OSS

1. Open CoWork-OSS and go to **Settings** (gear icon)
2. Navigate to the **iMessage** tab
3. Configure settings:
   - **Channel Name**: Display name for the channel
   - **Security Mode**: Choose Pairing, Allowlist, or Open
   - **DM Policy**: How to handle direct messages
   - **Group Policy**: How to handle group messages
4. Click **Connect iMessage**

### How iMessage Integration Works

Unlike other messaging platforms, iMessage integration has a unique behavior:

- **Messages from the same Apple ID** (your iPhone, iPad, etc.) are filtered as "from self"
- **Messages from other Apple IDs** are processed by the bot

This means to use the bot, you need **someone else** to message your Mac's Apple ID, or use a **different Apple ID** for the bot.

### Typical Setup

The recommended setup for an iMessage bot:

1. **Bot Mac**: Sign into Messages with a dedicated Apple ID (e.g., `bot@icloud.com`)
2. **Your Phone**: Use your personal Apple ID
3. **Message the bot**: Send messages from your phone to `bot@icloud.com`
4. **Bot responds**: Responses appear in your conversation with the bot account

### Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Start the bot and get help |
| `/help` | Show available commands |
| `/workspaces` | List all available workspaces |
| `/workspace <name>` | Select a workspace |
| `/newtask` | Start a fresh task/conversation |
| `/status` | Check bot status |
| `/cancel` | Cancel the running task |
| `/pair <code>` | Pair with a pairing code |
| `/approve` | Approve a pending request |
| `/deny` | Deny a pending request |

### Security Modes

| Mode | Description | Best For |
|------|-------------|----------|
| **Pairing** (default) | Users must enter a pairing code generated in the app | Personal use |
| **Allowlist** | Only pre-approved contacts can interact | Team use |
| **Open** | Anyone can message the bot | Not recommended |

### Pairing a User

1. In CoWork-OSS Settings → iMessage, click **Generate Pairing Code**
2. The user sends the 6-character code to the bot via iMessage
3. Once verified, the user is authorized to use the bot
4. Pairing codes expire after 5 minutes

### Example Conversation

```
User: /workspaces
Bot: 📁 Available Workspaces

     1. *project-a*
        `/Users/me/Documents/project-a`

     2. *Downloads*
        `/Users/me/Downloads`

     ━━━━━━━━━━━━━━━
     Reply with the number or name to select.
     Example: `1` or `myproject`

User: 1
Bot: ✅ *project-a* selected!
     You can now send me tasks.

User: List all JavaScript files
Bot: ⏳ Working on it...
Bot: ✅ Done!
     Found 15 JavaScript files in the workspace...
```

### Troubleshooting

**"Permission denied" error:**
- Ensure Full Disk Access is granted for Terminal or CoWork-OSS
- Try running `imsg --version` in Terminal to verify the CLI works

**Messages not being received:**
- Check that the channel status shows "Connected"
- Verify the sender is using a different Apple ID than your Mac
- Messages from your own devices (same Apple ID) are filtered out

**Bot not responding:**
- Check the CoWork-OSS logs for errors
- Ensure a workspace is selected
- Verify the user is paired/authorized

---

## Menu Bar App (macOS)

CoWork-OSS includes a native macOS menu bar companion that provides quick access to your workspaces and tasks without having the main window open.

### Features

- **Quick Access**: Click the menu bar icon to show/hide the main window
- **Status Display**: See connected channel status at a glance
- **Workspace Selection**: Switch between workspaces from the menu
- **New Task**: Create a new task directly from the menu bar
- **Settings Access**: Quick link to settings

### Configuration

Navigate to **Settings → Menu Bar** to configure:

| Setting | Description |
|---------|-------------|
| **Enable Menu Bar Icon** | Show/hide the menu bar icon |
| **Show Dock Icon** | Show/hide the app in the macOS Dock |
| **Start Minimized** | Start with the main window hidden |
| **Close to Menu Bar** | Closing the window minimizes to menu bar instead of quitting |
| **Show Notifications** | Enable system notifications for task completions |

### How It Works

1. **Left-click** the menu bar icon to toggle the main window
2. **Right-click** (or click) to show the quick menu with:
   - Channel connection status
   - Workspace list for quick switching
   - New task shortcut
   - Settings and quit options

### Menu Bar Only Mode

For a minimal footprint, you can run CoWork-OSS entirely from the menu bar:

1. Go to **Settings → Menu Bar**
2. Enable **Start Minimized**
3. Disable **Show Dock Icon**
4. Enable **Close to Menu Bar**

The app will now run silently in the menu bar, accessible with a single click.

### Quick Input Window

The Quick Input window is a floating, always-on-top input that lets you create tasks instantly from anywhere on your Mac using a global keyboard shortcut.

#### Keyboard Shortcut

Press **⌘⇧Space** (Command + Shift + Space) from anywhere to open the Quick Input window.

#### Features

- **Global Shortcut**: Works from any app, even when CoWork-OSS is minimized
- **Floating Design**: Apple-like transparent design with backdrop blur
- **Inline Responses**: See the agent's response directly in the floating window
- **Copy to Clipboard**: One-click copy of the response text
- **Persistent Results**: Window stays visible after task completion (doesn't auto-hide)
- **Draggable**: Drag the window to any position on screen

#### How It Works

1. Press **⌘⇧Space** to open the Quick Input window
2. Type your task or question
3. Press **Enter** or click the submit button
4. Watch the response stream in real-time
5. Click the copy button to copy the response
6. Press **Escape** or click "New Task" to start fresh

#### Tips

- The window follows you across macOS Spaces and full-screen apps
- Hover over the expanded window to reveal action buttons (copy, new task, close)
- The input field auto-focuses when the window appears

---

## Web Search Integration

CoWork-OSS includes a multi-provider web search system that allows the agent to search the web for information during task execution. This is useful for tasks that require current information, research, or fact-checking.

### Supported Providers

| Provider | Search Types | Best For |
|----------|--------------|----------|
| **Tavily** | Web, News | AI-optimized search results, recommended for most use cases |
| **Brave Search** | Web, News, Images | Privacy-focused search with good coverage |
| **SerpAPI** | Web, News, Images | Google results via API, comprehensive coverage |
| **Google Custom Search** | Web, Images | Direct Google integration, requires Search Engine ID |

### Configuration

Configure search providers in the Settings UI:

1. Open **Settings** (gear icon)
2. Navigate to the **Web Search** tab
3. Enter your API key(s) for your preferred providers:
   - **Tavily** (recommended) - Get key from [tavily.com](https://tavily.com/)
   - **Brave Search** - Get key from [brave.com/search/api](https://brave.com/search/api/)
   - **SerpAPI** - Get key from [serpapi.com](https://serpapi.com/)
   - **Google Custom Search** - Get key and Search Engine ID from [Google Cloud Console](https://console.cloud.google.com/)
4. Select your **Primary Provider** - used for all searches by default
5. Optionally select a **Fallback Provider** - used automatically if primary fails
6. Click **Test** to verify connectivity
7. Save settings

The settings panel shows provider capabilities (web, news, images support) and configuration status.

### How the Agent Uses Search

When the `web_search` tool is available, the agent can:
- Search the web for current information
- Look up news articles on specific topics
- Find images (with supported providers)
- Research facts to complete tasks accurately

**Example tasks that benefit from web search:**
- "Research the latest trends in renewable energy and create a summary"
- "Find the current stock price of Apple and create a report"
- "Look up recent news about AI regulation"

### Fallback Behavior

When multiple providers are configured:
1. The **Primary Provider** is tried first
2. If it fails (network error, rate limit, etc.), the **Fallback Provider** is automatically used
3. This ensures reliable search even if one provider has issues

### Provider Auto-Detection

If no provider is explicitly selected, CoWork-OSS auto-detects available providers based on which ones have API keys configured in Settings, in this priority order:
1. Tavily
2. Brave
3. SerpAPI
4. Google (requires both API key and Search Engine ID)

---
---

## Code Tools

CoWork-OSS includes Claude Code-style tools for efficient code navigation and editing. These tools are designed for developers who need fast, precise file operations within their workspace.

### Available Tools

| Tool | Description |
|------|-------------|
| **glob** | Fast pattern-based file search using glob patterns |
| **grep** | Regex-powered content search across files |
| **edit_file** | Surgical file editing with find-and-replace |

### glob - Pattern-Based File Search

Find files matching glob patterns like `**/*.ts` or `src/**/*.tsx`. Results are sorted by modification time (newest first).

**Parameters:**
- `pattern` (required): Glob pattern to match (e.g., `**/*.ts`, `*.{js,jsx,ts,tsx}`)
- `path` (optional): Directory to search in (defaults to workspace root)
- `maxResults` (optional): Maximum number of results (default: 100)

**Example usage by the agent:**
```
"Find all TypeScript test files"
→ glob pattern="**/*.test.ts"

"List React components in src/components"
→ glob pattern="*.tsx" path="src/components"
```

### grep - Regex Content Search

Search file contents using regular expressions. Supports context lines and multiple output modes.

**Parameters:**
- `pattern` (required): Regex pattern to search for
- `path` (optional): Directory or file to search in
- `glob` (optional): File pattern filter (e.g., `*.ts`)
- `ignoreCase` (optional): Case-insensitive search
- `contextLines` (optional): Lines of context to show around matches
- `maxResults` (optional): Maximum number of results
- `outputMode` (optional): `content` (default), `files_only`, or `count`

**Example usage by the agent:**
```
"Find all TODO comments in TypeScript files"
→ grep pattern="TODO:" glob="*.ts"

"Search for function definitions"
→ grep pattern="function\s+\w+" contextLines=2
```

### edit_file - Surgical File Editing

Make precise text replacements in files. Requires an exact match of the old string.

**Parameters:**
- `file_path` (required): Path to the file to edit
- `old_string` (required): Exact text to replace
- `new_string` (required): Replacement text
- `replace_all` (optional): Replace all occurrences (default: false)

**Example usage by the agent:**
```
"Rename the function getUser to fetchUser"
→ edit_file file_path="src/api.ts" old_string="function getUser" new_string="function fetchUser"

"Update the version number"
→ edit_file file_path="package.json" old_string="\"version\": \"1.0.0\"" new_string="\"version\": \"1.1.0\""
```

### Security

All code tools respect workspace boundaries:
- Paths outside the workspace are rejected
- Path traversal attempts (e.g., `../../../etc/passwd`) are blocked
- Operations are logged in the task timeline

---

## Web Fetch Tools

CoWork-OSS provides lightweight HTTP tools for fetching web content and making API requests.

### Available Tools

| Tool | Description |
|------|-------------|
| **web_fetch** | Fetch and parse web pages with HTML-to-text conversion |
| **http_request** | Full HTTP client for API calls (curl-like) |

### web_fetch - Web Page Fetching

Fetch web pages and extract content. Automatically converts HTML to readable text and can extract specific elements using CSS selectors.

**Parameters:**
- `url` (required): URL to fetch (HTTP/HTTPS)
- `selector` (optional): CSS selector to extract specific content
- `includeLinks` (optional): Include links in output (default: true)
- `maxLength` (optional): Maximum response length (default: 100000)

**Example usage by the agent:**
```
"Get the main content from a documentation page"
→ web_fetch url="https://docs.example.com/guide" selector="main"

"Fetch a webpage and include all links"
→ web_fetch url="https://example.com" includeLinks=true
```

### http_request - HTTP Client

Full-featured HTTP client for making API requests with custom methods, headers, and request bodies.

**Parameters:**
- `url` (required): URL for the request (HTTP/HTTPS)
- `method` (optional): HTTP method - GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS (default: GET)
- `headers` (optional): Custom request headers as key-value pairs
- `body` (optional): Request body (for POST, PUT, PATCH)
- `timeout` (optional): Request timeout in milliseconds (default: 30000)
- `followRedirects` (optional): Whether to follow redirects (default: true)
- `maxLength` (optional): Maximum response length (default: 100000)

**Example usage by the agent:**
```
"Check if an API endpoint is accessible"
→ http_request url="https://api.example.com/health" method="GET"

"Create a new resource via API"
→ http_request url="https://api.example.com/items" method="POST"
  headers={"Content-Type": "application/json", "Authorization": "Bearer token"}
  body="{\"name\": \"test\"}"

"Check headers without downloading body"
→ http_request url="https://example.com/large-file.zip" method="HEAD"
```

### Response Handling

- **JSON responses**: Automatically pretty-printed for readability
- **HTML responses**: Raw HTML returned (use `web_fetch` for parsed content)
- **Large responses**: Automatically truncated with `[Response truncated]` marker
- **Error responses**: Include status code, status text, and error body

### Security

- Only HTTP and HTTPS URLs are supported
- Requests include a `User-Agent` header identifying CoWork-OSS
- Response size is limited to prevent memory issues
- Timeout prevents hanging on slow responses

---

## Personality & Customization

CoWork-OSS includes a comprehensive personality system that lets you customize how the agent communicates. All settings can be changed via natural language prompts or the **Settings > Personality** tab.

### Conversation Commands

Simply tell the agent what you want:

| What to say | What happens |
|-------------|--------------|
| "be more professional" | Changes to professional communication style |
| "be like Jarvis" | Adopts the Jarvis persona (sophisticated AI butler) |
| "use more emojis" | Sets emoji usage to expressive |
| "be brief" | Sets response length to terse |
| "explain like I'm a beginner" | Sets explanation depth to teaching |
| "use space analogies" | Uses space-themed analogies and examples |
| "call yourself Max" | Changes the agent's name to Max |
| "I'm Alice" | Agent remembers your name for future sessions |

### Available Personalities

| Style | Description |
|-------|-------------|
| Professional | Formal, business-oriented communication |
| Friendly | Warm, encouraging, supportive |
| Concise | Brief, to-the-point responses |
| Creative | Imaginative, expressive language |
| Technical | Detailed, precise explanations |
| Casual | Relaxed, informal tone |

### Available Personas

| Persona | Description |
|---------|-------------|
| Jarvis | Sophisticated AI butler (Iron Man style) |
| Friday | Friendly AI colleague |
| HAL | Calm, formal AI (2001: A Space Odyssey) |
| Computer | Star Trek efficient assistant |
| Alfred | Refined gentleman's gentleman |
| Intern | Eager, enthusiastic learner |
| Sensei | Wise, patient teacher |
| Pirate | Swashbuckling adventurer |
| Noir | 1940s detective style |

### Response Style Options

- **Emoji Usage**: none, minimal, moderate, expressive
- **Response Length**: terse, balanced, detailed
- **Code Comments**: minimal, moderate, verbose
- **Explanation Depth**: expert, balanced, teaching

### Quirks

- **Catchphrase**: A signature phrase (e.g., "At your service!")
- **Sign-off**: How to end responses (e.g., "Happy coding!")
- **Analogy Domain**: Theme for examples (cooking, sports, space, music, gaming, movies, etc.)

### Relationship Tracking

The agent remembers your name and tracks your working relationship across sessions, enabling personalized greetings and milestone celebrations.

---

## Ollama Integration (Local LLMs)

CoWork-OSS supports running local language models via Ollama, allowing you to use the agent completely offline and free of charge.

### Setting Up Ollama

#### 1. Install Ollama

Download and install from [ollama.ai](https://ollama.ai/):

```bash
# macOS (via Homebrew)
brew install ollama

# Or download directly from https://ollama.ai/download
```

#### 2. Pull a Model

```bash
# Recommended models for agent tasks
ollama pull llama3.2        # Fast, good for most tasks
ollama pull qwen2.5:14b     # Better reasoning
ollama pull deepseek-r1:14b # Strong coding abilities
```

#### 3. Start Ollama Server

```bash
ollama serve
# Server runs at http://localhost:11434
```

### Configuring in CoWork-OSS

1. Open **Settings** (gear icon)
2. Select **Ollama (Local)** as your provider
3. Optionally change the **Base URL** (defaults to `http://localhost:11434`)
4. If using a remote Ollama server with authentication, enter the **API Key**
5. Click **Refresh Models** to load available models
6. Select your preferred model from the dropdown
7. Click **Test Connection** to verify
8. Save settings

### Recommended Models

| Model | Size | Best For |
|-------|------|----------|
| `llama3.2` | 3B | Quick tasks, low memory |
| `llama3.2:70b` | 70B | Complex reasoning (needs ~40GB RAM) |
| `qwen2.5:14b` | 14B | Balanced performance |
| `deepseek-r1:14b` | 14B | Coding and technical tasks |
| `mistral` | 7B | General purpose |

### Notes

- **Performance**: Local models are slower than cloud APIs but completely private
- **Memory**: Larger models need more RAM (e.g., 14B models need ~16GB RAM)
- **Tool Calling**: Works best with models that support function calling (llama3.2, qwen2.5)
- **Offline**: Once models are downloaded, no internet connection is required

---

## Google Gemini Integration

CoWork-OSS supports Google's Gemini models via Google AI Studio, offering powerful AI capabilities with a generous free tier.

### Setting Up Gemini

#### 1. Get an API Key

1. Go to [Google AI Studio](https://aistudio.google.com/apikey)
2. Sign in with your Google account
3. Click **Create API Key**
4. Copy the generated API key (starts with `AIza...`)

#### 2. Configure in CoWork-OSS

1. Open **Settings** (gear icon)
2. Select **Google Gemini** as your provider
3. Enter your API key
4. Click **Refresh Models** to load available models
5. Select your preferred model
6. Click **Test Connection** to verify
7. Save settings

### Available Models

| Model | Description |
|-------|-------------|
| `gemini-2.0-flash` | Default. Balanced speed and capability |
| `gemini-2.5-pro` | Most capable for complex tasks |
| `gemini-2.5-flash` | Fast and efficient |
| `gemini-2.0-flash-lite` | Fastest and most cost-effective |
| `gemini-1.5-pro` | Previous generation pro model |
| `gemini-1.5-flash` | Previous generation flash model |

### Notes

- **Free Tier**: Google AI Studio offers a generous free tier for experimentation
- **Tool Calling**: Full support for function calling/tools
- **Rate Limits**: Free tier has lower rate limits than paid tiers

---

## OpenRouter Integration

CoWork-OSS supports OpenRouter, a multi-model API gateway that provides access to various AI models from different providers (Claude, GPT-4, Llama, Mistral, etc.) through a unified API.

### Setting Up OpenRouter

#### 1. Get an API Key

1. Go to [OpenRouter](https://openrouter.ai/keys)
2. Create an account or sign in
3. Click **Create Key**
4. Copy the generated API key (starts with `sk-or-...`)

#### 2. Configure in CoWork-OSS

1. Open **Settings** (gear icon)
2. Select **OpenRouter** as your provider
3. Enter your API key
4. Click **Refresh Models** to load available models
5. Select your preferred model
6. Click **Test Connection** to verify
7. Save settings

### Available Models

OpenRouter provides access to many models, including:

| Model | Provider | Description |
|-------|----------|-------------|
| `anthropic/claude-3.5-sonnet` | Anthropic | Default. Balanced model |
| `anthropic/claude-3-opus` | Anthropic | Most capable Claude model |
| `openai/gpt-4o` | OpenAI | OpenAI's flagship model |
| `openai/gpt-4o-mini` | OpenAI | Fast and affordable |
| `google/gemini-pro-1.5` | Google | Google's advanced model |
| `meta-llama/llama-3.1-405b-instruct` | Meta | Largest open model |
| `mistralai/mistral-large` | Mistral | Mistral's flagship |
| `deepseek/deepseek-chat` | DeepSeek | Conversational model |

See all available models at [openrouter.ai/models](https://openrouter.ai/models)

### Benefits

- **Multi-Model Access**: Switch between models without changing API keys
- **Pay-As-You-Go**: Pay only for what you use
- **Model Variety**: Access models from OpenAI, Anthropic, Google, Meta, and more
- **Unified API**: OpenAI-compatible API format

---

## OpenAI / ChatGPT Integration

CoWork-OSS supports OpenAI models through two authentication methods: API Key or ChatGPT OAuth.

### Option 1: API Key (Pay-per-token)

Use your OpenAI API key to access GPT models with pay-per-token billing.

#### Setup

1. Go to [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
2. Create an API key
3. In CoWork-OSS: **Settings** > **LLM Provider** > **OpenAI**
4. Select **API Key** tab
5. Enter your API key
6. Click **Refresh Models** to load available models
7. Select your preferred model
8. Click **Test Connection** to verify
9. Save settings

### Option 2: ChatGPT OAuth (Use Your Subscription)

If you have a ChatGPT Plus, Pro, or Team subscription, you can sign in with your ChatGPT account to use your subscription's models without additional API costs.

#### Setup

1. In CoWork-OSS: **Settings** > **LLM Provider** > **OpenAI**
2. Select **Sign in with ChatGPT** tab
3. Click **Sign in with ChatGPT**
4. A browser window opens - log in to your ChatGPT account
5. Authorize the connection
6. Once connected, your available models are loaded automatically
7. Select your preferred model
8. Save settings

### Available Models

| Model | Description |
|-------|-------------|
| `gpt-5.2-codex` | Most advanced reasoning (ChatGPT OAuth) |
| `gpt-5.2` | Advanced reasoning (ChatGPT OAuth) |
| `gpt-5.1-codex-max` | Maximum capability (ChatGPT OAuth) |
| `gpt-5.1-codex-mini` | Fast and efficient (ChatGPT OAuth) |
| `gpt-5.1` | Balanced performance (ChatGPT OAuth) |
| `gpt-4o` | Most capable (API Key) |
| `gpt-4o-mini` | Fast and affordable (API Key) |
| `o1` | Advanced reasoning (API Key) |
| `o1-mini` | Fast reasoning (API Key) |

**Note:** ChatGPT OAuth provides access to internal ChatGPT models (gpt-5.x series), while API Key provides access to public OpenAI API models (gpt-4o, o1, etc.).

### Benefits

- **ChatGPT OAuth**: Use your existing ChatGPT subscription without additional API costs
- **API Key**: Pay-per-token access to the latest OpenAI models
- **Full Tool Support**: Both authentication methods support function calling for all CoWork tools

---

## Built-in Skills (75+)

CoWork-OSS comes bundled with **75+ ready-to-use skills** that enable the agent to interact with popular services, automate workflows, and perform specialized tasks.

### Skill Categories

| Category | Skills | Description |
|----------|--------|-------------|
| **Developer Tools** | GitHub, GitLab, Linear, Jira, Sentry | Issue tracking, PR management, error monitoring |
| **Communication** | Slack, Discord, Telegram, Email | Send messages, manage channels, notifications |
| **Productivity** | Notion, Obsidian, Todoist, Things, Reminders | Note-taking, task management, knowledge bases |
| **Apple Ecosystem** | Apple Notes, Apple Reminders, Calendar, Contacts | Native macOS app integration via AppleScript |
| **Cloud Storage** | Google Drive, Dropbox, iCloud | File management and sync |
| **Media & Music** | Spotify, YouTube, SoundCloud | Playback control, playlist management |
| **Smart Home** | HomeKit, Philips Hue | Device control and automation |
| **Finance** | Banking, Invoicing | Financial data and document generation |
| **AI Services** | DALL-E, Stable Diffusion, ElevenLabs | Image generation, text-to-speech |
| **Utilities** | Archive, QR Code, Screenshot | File compression, code generation, screen capture |

### Featured Skills

#### GitHub Integration
- Create and manage issues, pull requests, and releases
- Search repositories and code
- Review and merge pull requests
- Manage labels, milestones, and projects

#### Slack Integration
- Send messages to channels and DMs
- Create and manage channels
- Search message history
- Upload files and share content

#### Notion Integration
- Create and update pages and databases
- Search across your workspace
- Manage properties and relations
- Export content in various formats

#### Apple Notes & Reminders
- Create and organize notes with folders
- Set reminders with due dates and priorities
- Sync across your Apple devices
- Use natural language for scheduling

#### Spotify Integration
- Control playback (play, pause, skip)
- Search for tracks, albums, and artists
- Manage playlists
- Get currently playing information

### How Skills Work

Skills are context-aware prompts that guide the agent on how to interact with specific services. When you mention a service or task related to a skill, the agent automatically uses the appropriate skill's knowledge to complete the task.

**Example tasks using skills:**
- "Create a GitHub issue for the login bug we discussed"
- "Send a Slack message to #engineering about the deployment"
- "Add a reminder to call the dentist tomorrow at 10am"
- "Play my Discover Weekly playlist on Spotify"
- "Create a Notion page summarizing today's meeting"

### Skill Guidelines

Some skills include **guidelines** - always-active context that helps the agent make better decisions. For example, coding guidelines ensure consistent code style across your projects.

### SkillHub (Skill Registry)

SkillHub is CoWork-OSS's built-in skill registry for discovering, installing, and managing skills.

#### Accessing SkillHub

1. Open **Settings** (gear icon)
2. Navigate to the **SkillHub** tab
3. Browse installed skills or search the registry

#### SkillHub Features

| Tab | Description |
|-----|-------------|
| **Installed** | View and manage skills installed from the registry |
| **Browse Registry** | Search and install new skills from skill-hub.com |
| **Status** | Dashboard showing all skills with eligibility status |

#### Configuration

| Environment Variable | Description | Default |
|---------------------|-------------|---------|
| `SKILLHUB_REGISTRY` | Custom registry URL for skill discovery | `https://skill-hub.com/api` |

To use a custom registry, set the environment variable before launching the app:
```bash
export SKILLHUB_REGISTRY=https://your-registry.com/api
```

#### Skill Sources (Precedence)

Skills are loaded from three locations. Higher precedence sources override lower ones:

| Source | Location | Precedence |
|--------|----------|------------|
| **Workspace** | `workspace/skills/` | Highest |
| **Managed** | `~/Library/Application Support/cowork-oss/skills/` | Medium |
| **Bundled** | `resources/skills/` (in app) | Lowest |

#### Skill Requirements

Skills can specify requirements that must be met to be eligible:

```json
{
  "requires": {
    "bins": ["git", "node"],
    "anyBins": ["npm", "pnpm", "yarn"],
    "env": ["GITHUB_TOKEN"],
    "os": ["darwin", "linux"]
  }
}
```

- **bins**: All these binaries must exist in PATH
- **anyBins**: At least one of these must exist
- **env**: All these environment variables must be set
- **os**: Must match current OS (darwin/linux/win32)

#### Skill Eligibility Status

| Status | Meaning |
|--------|---------|
| **Ready** | All requirements met, skill is active |
| **Disabled** | Manually disabled by user |
| **Blocked** | Blocked by allowlist/denylist |
| **Missing Requirements** | Binary, env var, or OS requirement not met |

---

## MCP (Model Context Protocol)

CoWork-OSS includes full support for the Model Context Protocol (MCP), allowing you to extend the agent's capabilities with external tool servers and expose CoWork's tools to external clients.

### What is MCP?

MCP is an open protocol for connecting AI models to external tools and data sources. It enables:
- **Extensibility**: Add new tools without modifying CoWork-OSS
- **Interoperability**: Use tools from any MCP-compatible server
- **Aggregation**: Combine tools from multiple sources

### MCP Client (Connect to External Servers)

Connect to external MCP servers to use their tools within CoWork-OSS.

#### Configuration

1. Open **Settings** (gear icon)
2. Navigate to the **MCP Servers** tab
3. Click **Add Server** to manually configure, or browse the **Registry**

#### Manual Server Configuration

- **Name**: Display name for the server
- **Command**: The command to launch the server (e.g., `npx`)
- **Arguments**: Command arguments (e.g., `-y @modelcontextprotocol/server-filesystem /path`)
- **Environment Variables**: Any required environment variables

#### Example: Filesystem Server

```
Command: npx
Arguments: -y @modelcontextprotocol/server-filesystem /Users/me/Documents
```

This exposes file operations on the specified directory as MCP tools.

### MCP Registry (One-Click Installation)

Browse and install MCP servers from the built-in registry:

1. Go to **Settings > MCP Servers > Browse Registry**
2. Search or filter by category
3. Click **Install** on any server
4. The server is automatically configured and ready to use

#### Available Servers

| Server | Description |
|--------|-------------|
| **Filesystem** | Read/write files in specified directories |
| **GitHub** | Interact with GitHub repos, issues, PRs |
| **Brave Search** | Web search via Brave |
| **Puppeteer** | Browser automation |
| **Memory** | Persistent key-value storage |
| **SQLite** | Query SQLite databases |
| **PostgreSQL** | Query PostgreSQL databases |
| **Fetch** | HTTP requests to external APIs |

### MCP Host (Expose CoWork's Tools)

Enable MCP Host mode to expose CoWork's tools as an MCP server for external clients like Claude Code.

#### Enabling Host Mode

1. Go to **Settings > MCP Servers > Settings**
2. Enable **MCP Host Mode**
3. The server listens on stdio for incoming connections

#### Connecting from Claude Code

Add CoWork-OSS as an MCP server in your Claude Code configuration:

```json
{
  "mcpServers": {
    "cowork": {
      "command": "/Applications/CoWork-OSS.app/Contents/MacOS/CoWork-OSS",
      "args": ["--mcp-host"]
    }
  }
}
```

### Tool Namespacing

MCP tools are prefixed with `mcp_` by default to avoid conflicts with built-in tools. You can customize this prefix in Settings.

Example: If an MCP server provides a `read_file` tool, it appears as `mcp_read_file` in CoWork-OSS.

---

## WebSocket Control Plane

CoWork-OSS includes a WebSocket-based Control Plane API that allows external applications to programmatically control tasks, monitor progress, and receive real-time events.

### Overview

The Control Plane provides:
- **REST-style API over WebSocket** for task management
- **Token-based authentication** with challenge-response handshake
- **Real-time event streaming** for task updates
- **Rate limiting** to prevent brute-force attacks

### Enabling the Control Plane

1. Open **Settings** (gear icon)
2. Navigate to the **Control Plane** tab
3. Toggle **Enable Control Plane**
4. A secure token is automatically generated (or click **Regenerate Token**)
5. Note the port (default: `18789`) and token for client connections
6. Click **Save Settings**

### Authentication Flow

1. Client connects to `ws://127.0.0.1:18789`
2. Server sends a `connect.challenge` event with a nonce
3. Client sends a `connect` request with the token
4. Server validates token and sends `connect.success` event
5. Client can now send requests and receive events

### Protocol

The Control Plane uses a JSON-based frame protocol:

**Request Frame:**
```json
{
  "type": "req",
  "id": "unique-request-id",
  "method": "task.create",
  "params": { "prompt": "Organize my files", "workspaceId": "ws-123" }
}
```

**Response Frame:**
```json
{
  "type": "res",
  "id": "unique-request-id",
  "ok": true,
  "payload": { "taskId": "task-456" }
}
```

**Event Frame:**
```json
{
  "type": "event",
  "event": "task.updated",
  "payload": { "taskId": "task-456", "status": "running" },
  "seq": 42
}
```

### Available Methods

| Method | Description | Parameters |
|--------|-------------|------------|
| `connect` | Authenticate with the server | `token`, `deviceName?`, `nonce?` |
| `ping` | Health check | - |
| `health` | Get server health status | - |
| `task.create` | Create a new task | `prompt`, `workspaceId`, `model?` |
| `task.get` | Get task details | `taskId` |
| `task.list` | List all tasks | `limit?`, `offset?`, `status?` |
| `task.cancel` | Cancel a running task | `taskId` |
| `task.sendMessage` | Send a message to a task | `taskId`, `message` |
| `status` | Get server status | - |
| `workspace.list` | List workspaces | - |
| `workspace.get` | Get workspace details | `workspaceId` |

### Events

| Event | Description |
|-------|-------------|
| `connect.challenge` | Authentication challenge with nonce |
| `connect.success` | Authentication successful |
| `task.created` | New task created |
| `task.updated` | Task status changed |
| `task.completed` | Task finished successfully |
| `task.failed` | Task encountered an error |
| `task.event` | Task timeline event |
| `heartbeat` | Server heartbeat |

### Example Client (TypeScript)

```typescript
import WebSocket from 'ws';

const ws = new WebSocket('ws://127.0.0.1:18789');
const token = 'your-control-plane-token';

ws.on('message', (data) => {
  const frame = JSON.parse(data.toString());

  if (frame.type === 'event' && frame.event === 'connect.challenge') {
    // Respond to challenge with token
    ws.send(JSON.stringify({
      type: 'req',
      id: crypto.randomUUID(),
      method: 'connect',
      params: { token, deviceName: 'My Client' }
    }));
  }

  if (frame.type === 'event' && frame.event === 'connect.success') {
    // Authenticated! Create a task
    ws.send(JSON.stringify({
      type: 'req',
      id: crypto.randomUUID(),
      method: 'task.create',
      params: {
        prompt: 'List all files in the workspace',
        workspaceId: 'your-workspace-id'
      }
    }));
  }

  if (frame.type === 'event' && frame.event === 'task.completed') {
    console.log('Task completed:', frame.payload);
  }
});
```

### Rate Limiting

The Control Plane includes built-in protection against brute-force attacks:
- **Max attempts**: 5 failed auth attempts before ban (configurable)
- **Ban duration**: 5 minutes (configurable)
- **IP-based**: Tracks attempts by remote IP address

### Security Considerations

- The Control Plane binds to `127.0.0.1` by default (localhost only)
- Use Tailscale Serve/Funnel for secure remote access
- Regenerate the token if compromised
- Monitor the server events for unauthorized access attempts

---

## Mobile Companions

Mobile Companions allow you to connect iOS and Android devices as remote "nodes" to CoWork-OSS, exposing device-specific capabilities like camera, GPS, screen recording, and SMS to the AI agent.

### Overview

Mobile devices connect to the Control Plane as "nodes" via WebSocket, providing:
- **Device Capabilities**: Camera capture, GPS location, screen recording, SMS sending
- **Role-Based Auth**: Nodes authenticate with a separate role from operators
- **Real-Time Status**: Foreground/background state, permission tracking
- **Event Broadcasting**: Operators receive node connect/disconnect events

### Enabling Mobile Companions

1. Enable the **Control Plane** in Settings (required)
2. Navigate to **Settings > Mobile Companions**
3. Follow the pairing instructions for your mobile device
4. Connected devices appear in the list with their capabilities

### Supported Capabilities

| Capability | Description | iOS | Android |
|------------|-------------|-----|---------|
| Camera | Photo capture (front/back) | ✓ | ✓ |
| Location | GPS coordinates (coarse/precise) | ✓ | ✓ |
| Screen | Screen recording | ✓ | ✓ |
| SMS | Send text messages | - | ✓ |
| Voice | Audio recording | ✓ | ✓ |

### Standard Commands

| Command | Description | Parameters |
|---------|-------------|------------|
| `camera.snap` | Take a photo | `facing?: 'front' \| 'back'`, `maxWidth?`, `quality?` |
| `camera.clip` | Record video | `durationMs`, `facing?`, `noAudio?` |
| `location.get` | Get GPS location | `accuracy?: 'coarse' \| 'precise'`, `maxAge?` |
| `screen.record` | Record screen | `durationMs`, `fps?`, `noAudio?` |
| `sms.send` | Send SMS (Android) | `to`, `message` |

### AI Agent Tools

The AI agent can interact with mobile companions using these tools:

| Tool | Description |
|------|-------------|
| `node_list` | List connected mobile companions |
| `node_describe` | Get detailed info about a specific node |
| `node_camera_snap` | Take a photo using a mobile node's camera |
| `node_location` | Get current location from a mobile node |
| `node_screen_record` | Record screen on a mobile node |
| `node_sms_send` | Send SMS via an Android node |

### Protocol

Nodes connect using the same WebSocket protocol as operators, but with `role: 'node'`:

**Connect Request (Node):**
```json
{
  "type": "req",
  "id": "uuid",
  "method": "connect",
  "params": {
    "token": "auth-token",
    "role": "node",
    "client": {
      "id": "device-uuid",
      "displayName": "iPhone 15 Pro",
      "version": "1.0.0",
      "platform": "ios"
    },
    "capabilities": ["camera", "location", "screen"],
    "commands": ["camera.snap", "camera.clip", "location.get", "screen.record"],
    "permissions": {
      "camera": true,
      "location": true,
      "screen_record": false
    }
  }
}
```

**Invoke Command:**
```json
{
  "type": "req",
  "id": "uuid",
  "method": "node.invoke",
  "params": {
    "nodeId": "device-uuid",
    "command": "camera.snap",
    "params": { "facing": "back" }
  }
}
```

### Foreground Requirement

Some commands require the mobile app to be in the foreground:
- `camera.snap`, `camera.clip` - Camera access requires foreground
- `screen.record` - Screen recording requires foreground

The server tracks foreground state and returns an error if the app is in background.

---

## Tailscale Integration

CoWork-OSS integrates with [Tailscale](https://tailscale.com/) to securely expose the Control Plane to your private network (tailnet) or the public internet without complex firewall or router configuration.

### Prerequisites

- Tailscale installed and running on your Mac
- Logged in to your Tailscale account
- Tailscale CLI available (`/Applications/Tailscale.app/Contents/MacOS/Tailscale`)

### Exposure Modes

| Mode | Description | Access |
|------|-------------|--------|
| **Off** | Control Plane only accessible locally | `ws://127.0.0.1:18789` |
| **Serve** | Exposed to your private tailnet | `https://your-machine.your-tailnet.ts.net:18789` |
| **Funnel** | Exposed publicly via Tailscale edge | `https://your-machine.your-tailnet.ts.net` (port 443) |

### Setting Up Tailscale Exposure

1. Open **Settings** (gear icon)
2. Navigate to the **Control Plane** tab
3. Enable **Control Plane** if not already enabled
4. Under **Tailscale Exposure**, select a mode:
   - **Off**: Local access only
   - **Serve**: Private tailnet access
   - **Funnel**: Public internet access
5. Click **Save Settings**

### Serve Mode

Serve mode exposes the Control Plane to devices on your Tailscale network:

- **Access URL**: `https://your-machine.your-tailnet.ts.net:18789`
- **TLS**: Automatic HTTPS with valid Tailscale certificates
- **Auth**: Still requires Control Plane token
- **Who can access**: Only devices on your tailnet

**Use cases:**
- Access CoWork-OSS from your phone or tablet
- Control tasks from another computer on your tailnet
- Build integrations that run on other machines

### Funnel Mode

Funnel mode exposes the Control Plane to the public internet:

- **Access URL**: `https://your-machine.your-tailnet.ts.net` (port 443)
- **TLS**: Automatic HTTPS via Tailscale's edge network
- **Auth**: Still requires Control Plane token
- **Who can access**: Anyone on the internet (with token)

**Use cases:**
- Webhook integrations from external services
- Mobile apps when not on tailnet
- CI/CD pipelines triggering tasks

### Checking Tailscale Status

The Settings UI shows Tailscale status:
- **Available**: Tailscale is installed and the CLI is accessible
- **Running**: Tailscale daemon is active
- **Logged In**: You're authenticated with Tailscale
- **Machine Name**: Your device's Tailscale hostname

### Troubleshooting

**"Tailscale not available"**
- Ensure Tailscale is installed: `brew install tailscale` or download from tailscale.com
- Check if the CLI exists: `ls /Applications/Tailscale.app/Contents/MacOS/Tailscale`

**"Tailscale not running"**
- Open the Tailscale app from Applications
- Or run: `sudo tailscaled`

**"Not logged in to Tailscale"**
- Run: `tailscale login`
- Or click "Log in" in the Tailscale menu bar app

**"Serve/Funnel not working"**
- Ensure Tailscale version supports serve/funnel (v1.34+)
- Check if funnel is enabled for your tailnet (admin console)
- View logs: `tailscale serve status`

### Security Notes

- **Token required**: Even with Tailscale exposure, clients must authenticate with the Control Plane token
- **Funnel risks**: Funnel exposes your Control Plane to the internet; ensure your token is strong and secret
- **Audit access**: Monitor `task.event` and server events for unauthorized attempts
- **Disable when not needed**: Set mode to "Off" when remote access isn't required

---

## SSH Tunnel Support

For environments where Tailscale isn't available or preferred, CoWork-OSS supports remote access via SSH port forwarding. This provides secure, encrypted access to your Control Plane through any SSH-accessible server.

### How It Works

The Control Plane server binds to localhost (`127.0.0.1:18789`) by default. SSH tunneling forwards this local port to a remote machine, allowing clients on other networks to connect securely through the encrypted SSH connection.

```
┌─────────────────┐        SSH Tunnel        ┌─────────────────┐
│  Remote Client  │ ──────────────────────── │   Your Mac      │
│                 │   Encrypted Connection   │                 │
│ ws://localhost  │◄────────────────────────►│ Control Plane   │
│    :18789       │                          │ 127.0.0.1:18789 │
└─────────────────┘                          └─────────────────┘
```

### Setting Up an SSH Tunnel

**On the client machine** (where you want to access CoWork-OSS from):

```bash
# Create SSH tunnel - forwards local port 18789 to remote CoWork machine
ssh -N -L 18789:127.0.0.1:18789 user@your-mac-hostname

# Options explained:
#   -N    Don't execute remote commands (tunnel only)
#   -L    Local port forwarding: local:host:remote
```

**Keep the tunnel running** in a terminal window, or run in background:

```bash
ssh -f -N -L 18789:127.0.0.1:18789 user@your-mac-hostname
```

### Connecting as Remote Client

Once the SSH tunnel is established, you can either:

1. **Use the Settings UI**:
   - Open **Settings** → **Control Plane** tab
   - Select **Remote** connection mode
   - Enter `ws://127.0.0.1:18789` as the gateway URL
   - Enter your Control Plane token
   - Click **Connect**

2. **Use a WebSocket client programmatically**:
   ```javascript
   const ws = new WebSocket('ws://127.0.0.1:18789');

   ws.on('open', () => {
     // Send authentication
     ws.send(JSON.stringify({
       type: 'request',
       id: '1',
       method: 'connect',
       params: { token: 'your-control-plane-token' }
     }));
   });
   ```

### Connection Modes

The Control Plane supports two connection modes:

| Mode | Description |
|------|-------------|
| **Local** | Host the Control Plane server (default) |
| **Remote** | Connect to an external Control Plane as a client |

Switch modes in **Settings** → **Control Plane** → **Connection Mode**.

### Remote Gateway Configuration

When using Remote mode, configure:

- **Gateway URL**: WebSocket URL (e.g., `ws://127.0.0.1:18789` or `wss://host:port`)
- **Auth Token**: Control Plane token from the host machine
- **Device Name**: Identifier for this client connection
- **Auto Reconnect**: Automatically reconnect on disconnection

### Security Considerations

- **SSH Key Authentication**: Use SSH keys instead of passwords for tunnel setup
- **Token Protection**: Keep your Control Plane token secret; it grants full access
- **Firewall Rules**: The Control Plane only binds to localhost; no direct external exposure
- **Connection Auditing**: Monitor server events for unauthorized connection attempts

### Troubleshooting

**"Connection refused" on client**
- Verify SSH tunnel is running: `ps aux | grep ssh`
- Check local port is forwarded: `lsof -i :18789`
- Ensure Control Plane is running on the host machine

**"Authentication failed"**
- Verify the token matches the one on the host machine
- Check that the token hasn't been regenerated since you copied it

**SSH tunnel drops frequently**
- Add keepalive to SSH config:
  ```
  Host your-mac
    ServerAliveInterval 60
    ServerAliveCountMax 3
  ```
- Consider using `autossh` for persistent tunnels:
  ```bash
  autossh -M 0 -f -N -L 18789:127.0.0.1:18789 user@your-mac
  ```

---

## Technology Stack

- **Frontend**: React 19 + TypeScript + Vite
- **Backend**: Electron 40 + Node.js
- **Database**: better-sqlite3 (embedded SQLite)
- **Build**: electron-builder

---

## About This Project

**This entire application was built without writing a single line of code manually.**

I "vibe-coded" CoWork-OSS from start to finish using AI coding assistants — primarily [Claude Code](https://claude.ai/claude-code) and OpenAI Codex. Every feature, every component, every bug fix was generated through conversations with AI. Yes, it burned through quite a lot of USD in API costs.

I built this tool entirely for my own use — to automate repetitive tasks on my Mac with an AI agent I could trust to stay within boundaries I set. I have **no commercial expectations** from this project.

I'm releasing it as open source so that:
- **The community can benefit** from a local-first, privacy-respecting agent workbench
- **Others can find and fix bugs** that I don't have time to track down myself
- **Developers can learn** from (or be horrified by) what AI-generated code looks like at scale

If you find bugs, please [open an issue](https://github.com/mesutfelat/cowork-oss/issues). If you fix them, even better — PRs are welcome!

---

## Project Structure

```
cowork-oss/
├── src/
│   ├── electron/               # Main process (Node.js)
│   │   ├── main.ts            # Electron entry point
│   │   ├── preload.ts         # IPC bridge
│   │   ├── database/          # SQLite schema & repositories
│   │   ├── agent/             # Agent orchestration
│   │   │   ├── daemon.ts      # Task coordinator
│   │   │   ├── executor.ts    # Agent execution loop
│   │   │   ├── queue-manager.ts # Parallel task queue
│   │   │   ├── custom-skill-loader.ts # Custom skill management
│   │   │   ├── llm/           # Provider abstraction
│   │   │   ├── search/        # Web search providers
│   │   │   ├── tools/         # Tool implementations
│   │   │   └── skills/        # Document creation skills
│   │   ├── mcp/               # Model Context Protocol
│   │   │   ├── client/        # MCP client (connect to servers)
│   │   │   ├── host/          # MCP host (expose tools)
│   │   │   ├── registry/      # MCP server registry
│   │   │   ├── types.ts       # MCP type definitions
│   │   │   └── settings.ts    # MCP settings management
│   │   ├── cron/              # Scheduled task execution
│   │   │   ├── service.ts     # Cron service with job management
│   │   │   └── index.ts       # Cron exports
│   │   ├── notifications/     # In-app notification system
│   │   │   ├── service.ts     # Notification service
│   │   │   └── store.ts       # Persistent notification storage
│   │   ├── control-plane/     # WebSocket Control Plane API
│   │   │   ├── server.ts      # WebSocket server with auth
│   │   │   ├── client.ts      # Client registry and management
│   │   │   ├── protocol.ts    # Frame types and serialization
│   │   │   ├── handlers.ts    # Method handlers (task operations)
│   │   │   ├── settings.ts    # Settings persistence
│   │   │   ├── remote-client.ts # Remote gateway client (SSH tunnel)
│   │   │   └── node-manager.ts  # Mobile companion node management
│   │   ├── tailscale/         # Tailscale integration
│   │   │   ├── tailscale.ts   # CLI wrapper and status
│   │   │   ├── exposure.ts    # Serve/Funnel mode manager
│   │   │   └── settings.ts    # Tailscale settings
│   │   └── ipc/               # IPC handlers
│   ├── renderer/              # React UI
│   │   ├── App.tsx            # Main app component
│   │   ├── components/        # UI components
│   │   │   ├── NotificationPanel.tsx  # Bell icon notification center
│   │   │   └── ...            # Other UI components
│   │   └── styles/            # CSS styles
│   └── shared/                # Shared types
├── package.json
├── tsconfig.json
└── vite.config.ts
```

---

## Development

### Hot Reload

Development mode provides hot reload for both:
- React UI (Vite HMR)
- Electron main process (auto-restart on changes)

### Adding New Tools

1. Define tool schema in `tools/registry.ts`
2. Implement tool logic in `tools/file-tools.ts` or create new file
3. Register tool in `getTools()` method
4. Add execution handler in `executeTool()`

### Adding New Skills

Skills are JSON files stored in one of three locations (see [SkillHub](#skillhub-skill-registry)).

#### Skill JSON Format

```json
{
  "id": "my-skill",
  "name": "My Skill",
  "description": "What this skill does and when to use it",
  "icon": "🔧",
  "category": "Tools",
  "prompt": "Instructions injected into context when skill is triggered",
  "parameters": [],
  "enabled": true,
  "type": "task",
  "requires": {
    "bins": ["required-binary"],
    "env": ["API_KEY"]
  },
  "metadata": {
    "version": "1.0.0",
    "author": "Author Name",
    "tags": ["tag1", "tag2"]
  }
}
```

#### Required Fields

| Field | Description |
|-------|-------------|
| `id` | Unique identifier (lowercase, hyphens allowed) |
| `name` | Display name |
| `description` | What the skill does (used for triggering) |
| `icon` | Emoji or icon |
| `prompt` | Instructions/content injected into context |

#### Optional Fields

| Field | Description |
|-------|-------------|
| `category` | For grouping in UI |
| `parameters` | Array of input parameters |
| `enabled` | Whether skill is active (default: true) |
| `type` | `"task"` (default) or `"guideline"` |
| `requires` | Requirements for eligibility |
| `install` | Installation specs for dependencies |
| `metadata` | Extended information (version, author, etc.) |

#### Skill Types

- **task**: Executable skill selected for specific tasks
- **guideline**: Always injected into system prompt when enabled

#### Creating a Skill

1. Create a `.json` file in `~/Library/Application Support/cowork-oss/skills/`
2. Add the required fields (id, name, description, icon, prompt)
3. Optionally add requirements and metadata
4. The skill will be loaded automatically on next restart (or use SkillHub > Reload)

---

## Troubleshooting

### "No LLM provider configured"

Open **Settings** (gear icon) and configure at least one LLM provider with your API credentials.

### Electron won't start

Clear cache and rebuild:
```bash
rm -rf node_modules dist
npm install
npm run dev
```

### Database locked

Close all instances of the app and delete the lock file:
```bash
rm ~/Library/Application\ Support/cowork-oss/cowork-oss.db-journal
```

---

## Contributing

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md) first.

Areas where help is especially needed:
- VM sandbox implementation using Virtualization.framework
- Additional model provider integrations
- Network security controls
- Additional MCP server integrations
- Test coverage

---

## Contact

- **X/Twitter**: [@MesutGenAI](https://x.com/MesutGenAI)
- **GitHub Issues**: [Report bugs or request features](https://github.com/mesutfelat/cowork-oss/issues)
- **Discussions**: [Ask questions or share ideas](https://github.com/mesutfelat/cowork-oss/discussions)

---

## Star History

<a href="https://star-history.com/#mesutfelat/cowork-oss&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=mesutfelat/cowork-oss&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=mesutfelat/cowork-oss&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=mesutfelat/cowork-oss&type=Date" />
 </picture>
</a>

---

## License

[MIT](LICENSE)
