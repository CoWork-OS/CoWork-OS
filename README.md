<p align="center">
  <img src="screenshots/cowork-oss-logo.png" alt="CoWork-OSS Logo" width="120">
</p>

# CoWork-OSS

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

**You bring your own model credentials (Anthropic API / Google Gemini / OpenRouter / AWS Bedrock) or run locally with Ollama; usage is billed by your provider (or free with Ollama).**

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
- **Skill System**: Built-in skills for creating professional outputs:
  - **Excel spreadsheets** (.xlsx) with multiple sheets, auto-fit columns, formatting, and filters
  - **Word documents** (.docx) with headings, paragraphs, lists, tables, and code blocks
  - **PDF documents** with professional formatting and custom fonts
  - **PowerPoint presentations** (.pptx) with multiple layouts, themes, and speaker notes
  - **Folder organization** by type, date, or custom rules
- **Real-Time Timeline**: Live activity feed showing agent actions and tool calls
- **Artifact Tracking**: All created/modified files are tracked and viewable
- **Model Selection**: Choose between Opus, Sonnet, or Haiku models
- **Telegram Bot**: Run tasks remotely via Telegram with workspace selection and streaming responses
- **Discord Bot**: Run tasks via Discord with slash commands and direct messages
- **Web Search**: Multi-provider web search (Tavily, Brave, SerpAPI, Google) with fallback support
- **Browser Automation**: Full web browser control with Playwright:
  - Navigate to URLs, take screenshots, save pages as PDF
  - Click, fill forms, type text, press keys
  - Extract page content, links, and form data
  - Scroll pages, wait for elements, execute JavaScript
- **System Tools**: Access to system-level capabilities:
  - Take screenshots (full screen or specific windows)
  - Read/write clipboard content
  - Open applications, URLs, and file paths
  - Show files in Finder
  - Get system information and environment variables
- **Update Notifications**: Automatic check for new releases with in-app notification banner

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
└─────────────────────────────────────────────────┘
                      ↕ IPC
┌─────────────────────────────────────────────────┐
│            Agent Daemon (Main Process)           │
│  - Task Orchestration                            │
│  - Agent Executor (Plan-Execute Loop)            │
│  - Tool Registry                                 │
│  - Permission Manager                            │
└─────────────────────────────────────────────────┘
                      ↕
┌─────────────────────────────────────────────────┐
│                  Execution Layer                 │
│  - File Operations                               │
│  - Skills (Document Creation)                    │
│  - LLM Providers (Anthropic/Gemini/OpenRouter/Bedrock/Ollama)│
│  - Search Providers (Tavily/Brave/SerpAPI/Google)│
└─────────────────────────────────────────────────┘
                      ↕
┌─────────────────────────────────────────────────┐
│              SQLite Local Database               │
│  - Tasks, Events, Artifacts, Workspaces          │
└─────────────────────────────────────────────────┘
```

---

## Setup

### Prerequisites

- Node.js 18+ and npm
- macOS (for Electron native features)
- One of: Anthropic API key, Google Gemini API key, OpenRouter API key, AWS Bedrock access, or Ollama installed locally

### Installation

```bash
# Clone the repository
git clone https://github.com/mesutfelat/cowork-oss.git
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
- [x] Multi-provider support (Anthropic API / Google Gemini / OpenRouter / AWS Bedrock / Ollama)
- [x] Model selection (Opus, Sonnet, Haiku, or any Ollama model)
- [x] Built-in skills (documents, spreadsheets, presentations)
- [x] **Real Office format support** (Excel .xlsx, Word .docx, PDF, PowerPoint .pptx)
- [x] SQLite local persistence
- [x] Telegram bot integration for remote task execution
- [x] **Discord bot integration** with slash commands and DM support
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

### Planned
- [ ] VM sandbox using macOS Virtualization.framework
- [ ] MCP connector host and registry
- [ ] Sub-agent coordination for parallel tasks
- [ ] Network egress controls with proxy
- [ ] Skill marketplace/loader

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

## Technology Stack

- **Frontend**: React 19 + TypeScript + Vite
- **Backend**: Electron 40 + Node.js
- **Database**: better-sqlite3 (embedded SQLite)
- **Build**: electron-builder

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
│   │   │   ├── llm/           # Provider abstraction
│   │   │   ├── search/        # Web search providers
│   │   │   ├── tools/         # Tool implementations
│   │   │   └── skills/        # Document creation skills
│   │   └── ipc/               # IPC handlers
│   ├── renderer/              # React UI
│   │   ├── App.tsx            # Main app component
│   │   ├── components/        # UI components
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

1. Create skill implementation in `skills/` directory
2. Add skill tool definition in `tools/skill-tools.ts`
3. Implement the skill method in SkillTools class

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
- MCP connector support
- Network security controls
- Test coverage

---


## License

[MIT](LICENSE)
