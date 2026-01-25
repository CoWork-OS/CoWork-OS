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

**You bring your own model credentials (Anthropic API / AWS Bedrock) or run locally with Ollama; usage is billed by your provider (or free with Ollama).**

> **Independent project.** CoWork-OSS is not affiliated with, endorsed by, or sponsored by Anthropic.
> This project implements a local, folder-scoped agent workflow pattern in open source.

**Status**: macOS desktop app (cross-platform support planned).

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
| Anthropic API | Set `ANTHROPIC_API_KEY` in `.env` | Pay-per-token |
| AWS Bedrock | Configure AWS credentials in Settings | Pay-per-token via AWS |
| Ollama (Local) | Install Ollama and pull models | **Free** (runs locally) |

**Your usage is billed directly by your provider.** CoWork-OSS does not proxy or resell model access. With Ollama, everything runs on your machine for free.

---

## Features

### Core Capabilities

- **Task-Based Workflow**: Multi-step task execution with plan-execute-observe loops
- **Workspace Management**: Sandboxed file operations within selected folders
- **Permission System**: Explicit approval for destructive operations
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
- **Web Search**: Multi-provider web search (Tavily, Brave, SerpAPI, Google) with fallback support

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
│  - LLM Providers (Anthropic/Bedrock/Ollama)      │
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
- One of: Anthropic API key, AWS Bedrock access, or Ollama installed locally

### Installation

```bash
# Clone the repository
git clone https://github.com/mesutfelat/cowork-oss.git
cd cowork-oss

# Install dependencies
npm install

# Configure your API credentials
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY

# Run in development mode
npm run dev
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
}
```

### Approval Requirements

The following operations always require user approval:
- File deletion
- Bulk rename (>10 files)
- Network access beyond allowlist
- External service calls

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
- [x] Multi-provider support (Anthropic API / AWS Bedrock / Ollama)
- [x] Model selection (Opus, Sonnet, Haiku, or any Ollama model)
- [x] Built-in skills (documents, spreadsheets, presentations)
- [x] **Real Office format support** (Excel .xlsx, Word .docx, PDF, PowerPoint .pptx)
- [x] SQLite local persistence
- [x] Telegram bot integration for remote task execution
- [x] Web search integration (Tavily, Brave, SerpAPI, Google)
- [x] Local LLM support via Ollama (free, runs on your machine)

### Planned
- [ ] VM sandbox using macOS Virtualization.framework
- [ ] MCP connector host and registry
- [ ] Sub-agent coordination for parallel tasks
- [ ] Network egress controls with proxy
- [ ] Browser automation
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

Configure at least one provider by adding API keys to your `.env` file:

```bash
# Tavily (recommended) - https://tavily.com/
TAVILY_API_KEY=tvly-...

# Brave Search - https://brave.com/search/api/
BRAVE_API_KEY=BSA...

# SerpAPI - https://serpapi.com/
SERPAPI_KEY=...

# Google Custom Search - https://developers.google.com/custom-search/
GOOGLE_API_KEY=AIza...
GOOGLE_SEARCH_ENGINE_ID=...   # Required with GOOGLE_API_KEY
```

### Settings UI

Once providers are configured, you can manage them in the app:

1. Open **Settings** (gear icon)
2. Navigate to the **Web Search** tab
3. Select your **Primary Provider** - used for all searches by default
4. Optionally select a **Fallback Provider** - used automatically if primary fails

The settings panel shows:
- Which providers are configured (based on environment variables)
- Test button for each provider to verify connectivity
- Provider capabilities (web, news, images support)

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

If no provider is explicitly selected, CoWork-OSS auto-detects available providers in this priority order:
1. Tavily (if `TAVILY_API_KEY` is set)
2. Brave (if `BRAVE_API_KEY` is set)
3. SerpAPI (if `SERPAPI_KEY` is set)
4. Google (if both `GOOGLE_API_KEY` and `GOOGLE_SEARCH_ENGINE_ID` are set)

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
3. Click **Refresh Models** to load available models
4. Select your preferred model from the dropdown
5. Click **Test Connection** to verify
6. Save settings

### Environment Variables (Optional)

```bash
# Custom server URL (defaults to localhost:11434)
OLLAMA_BASE_URL=http://localhost:11434

# API key for remote Ollama servers with authentication
OLLAMA_API_KEY=your_key_if_needed
```

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

### "ANTHROPIC_API_KEY not found"

Set the environment variable in your `.env` file or export it:
```bash
export ANTHROPIC_API_KEY=your_key_here
npm run dev
```

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
