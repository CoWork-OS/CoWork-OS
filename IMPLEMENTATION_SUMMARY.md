# CoWork OS Implementation Summary

## What You Have Now

A **fully functional macOS desktop application** for agentic task automation with:

- **Multi-provider LLM support**: Anthropic, Google Gemini, OpenRouter, AWS Bedrock, and Ollama (local/free)
- **Real Office document creation**: Excel (.xlsx), Word (.docx), PDF, PowerPoint (.pptx)
- **Web search integration**: Tavily, Brave, SerpAPI, Google Custom Search
- **Browser automation**: Full Playwright integration for web interactions
- **Channel integrations**: WhatsApp, Telegram, Discord, and Slack bots for remote task execution
- **In-app Settings**: Secure credential storage with no .env files required
- **Auto-updates**: Built-in update manager for seamless upgrades

## Architecture Overview

```
+---------------------------------------------------------------+
|                    COWORK-OSS APPLICATION                      |
+---------------------------------------------------------------+
|                                                                 |
|  +-----------------------------------------------------------+ |
|  |           React UI (Renderer Process)                      | |
|  |  - Task List & Selection                                   | |
|  |  - Real-Time Timeline                                      | |
|  |  - Workspace Selector                                      | |
|  |  - Settings Page (LLM, Search, Channels, Updates)          | |
|  |  - Approval Dialogs                                        | |
|  +---------------------------+-------------------------------+ |
|                              | IPC (Context Bridge)            |
|  +---------------------------v-------------------------------+ |
|  |        Electron Main Process (Node.js)                     | |
|  |                                                             | |
|  |  +-------------------------------------------------------+ | |
|  |  |         Agent Daemon (Orchestrator)                    | | |
|  |  |  - Task State Management                               | | |
|  |  |  - Event Streaming                                     | | |
|  |  |  - Approval Flow                                       | | |
|  |  +------------------------+------------------------------+ | |
|  |                           |                                | |
|  |  +------------------------v------------------------------+ | |
|  |  |      Task Executor (Agent Loop)                        | | |
|  |  |  - Plan Creation via LLM                               | | |
|  |  |  - Step Execution                                      | | |
|  |  |  - Tool Orchestration                                  | | |
|  |  +------------------------+------------------------------+ | |
|  |                           |                                | |
|  |  +------------------------v------------------------------+ | |
|  |  |           Tool Registry                                | | |
|  |  |  - File Operations (7 tools)                           | | |
|  |  |  - Code Tools (glob, grep, edit_file)                  | | |
|  |  |  - Web Fetch Tools (web_fetch, http_request)           | | |
|  |  |  - Skill Tools (4 skills)                              | | |
|  |  |  - Search Tools (web search)                           | | |
|  |  |  - Browser Tools (12 tools)                            | | |
|  |  |  - Shell Tools (command execution)                     | | |
|  |  +-------------------------------------------------------+ | |
|  |                                                             | |
|  |  +-------------------------------------------------------+ | |
|  |  |    LLM Provider Factory                                | | |
|  |  |  - Anthropic (Claude)                                  | | |
|  |  |  - Google Gemini                                       | | |
|  |  |  - OpenRouter (multi-model)                            | | |
|  |  |  - AWS Bedrock                                         | | |
|  |  |  - Ollama (local)                                      | | |
|  |  +-------------------------------------------------------+ | |
|  |                                                             | |
|  |  +-------------------------------------------------------+ | |
|  |  |    Search Provider Factory                             | | |
|  |  |  - Tavily | Brave | SerpAPI | Google                   | | |
|  |  +-------------------------------------------------------+ | |
|  |                                                             | |
|  |  +-------------------------------------------------------+ | |
|  |  |    Channel Gateway                                     | | |
|  |  |  - Telegram Bot                                        | | |
|  |  |  - Discord Bot                                         | | |
|  |  |  - Slack Bot (Socket Mode)                             | | |
|  |  +-------------------------------------------------------+ | |
|  |                                                             | |
|  |  +-------------------------------------------------------+ | |
|  |  |    Browser Service (Playwright)                        | | |
|  |  |  - Navigation, Screenshots, PDF                        | | |
|  |  |  - Click, Fill, Type, Press Keys                       | | |
|  |  |  - Content Extraction                                  | | |
|  |  +-------------------------------------------------------+ | |
|  |                                                             | |
|  |  +-------------------------------------------------------+ | |
|  |  |    SQLite Database                                     | | |
|  |  |  - Tasks, Events, Artifacts                            | | |
|  |  |  - Workspaces, Approvals, Skills                       | | |
|  |  +-------------------------------------------------------+ | |
|  +-----------------------------------------------------------+ |
|                                                                 |
|  +-----------------------------------------------------------+ |
|  |         Workspace Folder (User's Filesystem)               | |
|  |  - Read/Write with Permission Boundaries                   | |
|  |  - All artifacts saved here                                | |
|  +-----------------------------------------------------------+ |
+---------------------------------------------------------------+
```

## Key Components

### 1. LLM Provider System

**Location**: `src/electron/agent/llm/`

Multi-provider support with unified interface:

| Provider | File | Features |
|----------|------|----------|
| Anthropic | `anthropic-provider.ts` | Claude models, native tool use |
| Google Gemini | `gemini-provider.ts` | Gemini models, free tier available |
| OpenRouter | `openrouter-provider.ts` | Multi-model access |
| AWS Bedrock | `bedrock-provider.ts` | Enterprise AWS integration |
| Ollama | `ollama-provider.ts` | Local models, free, offline |

**Provider Factory** (`provider-factory.ts`):
- Dynamic provider selection
- Model listing per provider
- Connection testing
- Secure credential storage

### 2. Search Provider System

**Location**: `src/electron/agent/search/`

Web search with fallback support:

| Provider | File | Capabilities |
|----------|------|--------------|
| DuckDuckGo | `duckduckgo-provider.ts` | Web (free, built-in, no API key) |
| Tavily | `tavily-provider.ts` | Web, News (AI-optimized) |
| Brave | `brave-provider.ts` | Web, News, Images |
| SerpAPI | `serpapi-provider.ts` | Web, News, Images (Google results) |
| Google | `google-provider.ts` | Web, Images |

**Features**:
- Primary + fallback provider configuration
- DuckDuckGo as automatic last-resort fallback (no API key required)
- Auto-detection of available providers
- Rate limiting and error handling

### 3. Channel Gateway

**Location**: `src/electron/gateway/`

Remote task execution via messaging platforms:

#### Telegram (`channels/telegram.ts`)
- Bot commands: `/workspaces`, `/workspace`, `/status`, `/cancel`
- Streaming responses with Markdown formatting
- Security modes: Pairing, Allowlist, Open

#### Discord (`channels/discord.ts`)
- Slash commands with auto-registration
- DM and server channel support
- Multi-user session management

#### Slack (`channels/slack.ts`)
- Socket Mode for real-time WebSocket connections
- Direct messages and channel mentions
- Markdown to Slack mrkdwn conversion
- File upload support
- Security modes: Pairing, Allowlist, Open

**Gateway Features**:
- Session management (`session.ts`)
- Message routing (`router.ts`)
- Security validation (`security.ts`)

### 4. Browser Automation

**Location**: `src/electron/agent/browser/`

Full Playwright integration:

**Browser Service** (`browser-service.ts`):
- Headless or visible browser
- Page lifecycle management
- Screenshot and PDF capture

**Browser Tools** (`tools/browser-tools.ts`):
- `browser_navigate` - Go to URL
- `browser_screenshot` - Capture page
- `browser_save_pdf` - Save as PDF
- `browser_click` - Click elements
- `browser_fill` - Fill form inputs
- `browser_type` - Type text
- `browser_press` - Press keys
- `browser_get_content` - Extract text
- `browser_get_links` - List links
- `browser_get_forms` - List forms
- `browser_scroll` - Scroll page
- `browser_wait` - Wait for elements

### 5. Document Skills (Real Office Formats)

**Location**: `src/electron/agent/skills/`

Production-ready document creation:

| Skill | File | Output | Library |
|-------|------|--------|---------|
| Spreadsheet | `spreadsheet.ts` | .xlsx | exceljs |
| Document | `document.ts` | .docx, .pdf | docx, pdfkit |
| Presentation | `presentation.ts` | .pptx | pptxgenjs |
| Organizer | `organizer.ts` | Folders | Native |

**Spreadsheet Features**:
- Multiple sheets
- Auto-fit columns
- Cell formatting
- Auto-filters
- Formula support

**Document Features**:
- Headings (H1-H6)
- Paragraphs with formatting
- Bullet/numbered lists
- Tables
- Code blocks

**Presentation Features**:
- Multiple layouts (Title, Content, Two-column)
- Themes (Corporate, Creative, Minimal)
- Speaker notes
- Bullet points

### 6. Database Layer

**Location**: `src/electron/database/`

SQLite with 6 tables:
- `workspaces` - Folder permissions and metadata
- `tasks` - Task definitions and status
- `task_events` - Complete audit trail
- `artifacts` - Created/modified files
- `approvals` - Permission requests
- `skills` - Reusable automation patterns

### 7. React UI

**Location**: `src/renderer/`

**Components**:
| Component | File | Purpose |
|-----------|------|---------|
| Sidebar | `Sidebar.tsx` | Task list, workspace info |
| MainContent | `MainContent.tsx` | Central content area |
| RightPanel | `RightPanel.tsx` | Context panel |
| TaskView | `TaskView.tsx` | Task details |
| TaskTimeline | `TaskTimeline.tsx` | Real-time events |
| Settings | `Settings.tsx` | Configuration UI |
| SearchSettings | `SearchSettings.tsx` | Search provider config |
| TelegramSettings | `TelegramSettings.tsx` | Telegram bot config |
| DiscordSettings | `DiscordSettings.tsx` | Discord bot config |
| SlackSettings | `SlackSettings.tsx` | Slack bot config |
| UpdateSettings | `UpdateSettings.tsx` | Auto-update config |
| GuardrailSettings | `GuardrailSettings.tsx` | Safety limits config |
| QueueSettings | `QueueSettings.tsx` | Parallel queue config |
| SkillsSettings | `SkillsSettings.tsx` | Custom skills management |
| PersonalitySettings | `PersonalitySettings.tsx` | Agent personality config |
| MCPSettings | `MCPSettings.tsx` | MCP server config |
| WorkspaceSelector | `WorkspaceSelector.tsx` | Folder picker |
| ApprovalDialog | `ApprovalDialog.tsx` | Permission requests |
| FileViewer | `FileViewer.tsx` | In-app artifact viewer |

### 8. Auto-Update System

**Location**: `src/electron/updater/`

- Automatic update checking
- Download progress tracking
- User notification
- One-click install

### 9. MCP (Model Context Protocol)

**Location**: `src/electron/mcp/`

Full MCP support for extensibility:

- **MCP Client** (`client/`): Connect to external MCP servers
- **MCP Host** (`host/`): Expose CoWork's tools as an MCP server
- **MCP Registry** (`registry/`): Browse and install servers with one click
- **Transports**: stdio, SSE, and WebSocket support

### 10. Custom Skills System

**Location**: `src/electron/agent/custom-skill-loader.ts`

User-defined reusable workflows:

- Skills stored as YAML in `~/Library/Application Support/cowork-os/skills/`
- Custom prompts and tool configurations
- Priority-based sorting
- Parameter input modal for skills with variables

### 11. Personality System

**Location**: `src/electron/settings/personality-manager.ts`

Customizable agent personality and behavior:

**Components**:
- **PersonalityManager** - Centralized personality settings management
- **PersonalitySettings** UI - React component for configuration
- **Personality Tools** - Prompt-based personality control

**Personalities** (Communication Styles):
| ID | Name | Description |
|----|------|-------------|
| professional | Professional | Formal, thorough, business-appropriate |
| friendly | Friendly | Warm, approachable, conversational |
| concise | Concise | Brief, direct, minimal |
| creative | Creative | Expressive, uses analogies |
| technical | Technical | Detailed, precise, jargon-comfortable |
| casual | Casual | Relaxed, informal |

**Personas** (Character Overlays):
| ID | Name | Description |
|----|------|-------------|
| jarvis | J.A.R.V.I.S. | Sophisticated AI assistant |
| friday | F.R.I.D.A.Y. | Helpful, personable AI |
| hal | HAL 9000 | Calm, measured, formal |
| computer | Computer | Star Trek style |
| alfred | Alfred | British butler manner |
| intern | Intern | Eager, asks questions |
| sensei | Sensei | Wise mentor style |
| pirate | Pirate | Nautical vocabulary |
| noir | Noir Detective | 1940s detective style |

**Response Style Options**:
- `emoji_usage`: none, minimal, moderate, expressive
- `response_length`: brief, standard, detailed, comprehensive
- `code_comments`: none, minimal, moderate, extensive
- `explanation_depth`: surface, standard, deep, exhaustive

**Quirks**:
- `catchphrase`: Custom phrase used occasionally
- `sign_off`: Custom message to end conversations
- `analogy_domain`: cooking, sports, space, music, nature, gaming, movies, construction

**Prompt-Based Control Tools**:
- `set_personality` - Change communication style
- `set_persona` - Apply character overlay
- `set_response_style` - Adjust response formatting
- `set_quirks` - Set catchphrase, sign-off, analogy domain
- `set_agent_name` - Change agent's display name
- `set_user_name` - Set user's preferred name

### 12. System Tools

**Location**: `src/electron/agent/tools/system-tools.ts`

System-level capabilities:

- `take_screenshot` - Full screen or specific windows
- `clipboard_read` / `clipboard_write` - Clipboard access
- `open_application` / `open_url` / `open_path` - Launch apps and URLs
- `show_in_finder` - Reveal files in Finder
- `get_system_info` - System information and environment

### 13. Configurable Guardrails

**Location**: `src/electron/agent/guardrails/`

Safety limits configurable in Settings:

- Token budget per task (1K - 10M)
- Cost budget per task ($0.01 - $100)
- Iteration limit (5 - 500)
- Dangerous command blocking with custom patterns
- Auto-approve trusted command patterns
- File size limits (1 - 500 MB)
- Domain allowlist for browser automation

### 14. Parallel Task Queue

**Location**: `src/electron/agent/queue-manager.ts`

Run multiple tasks concurrently:

- Configurable concurrency (1-10 tasks)
- FIFO queue for pending tasks
- Auto-start next task on completion
- Persistence across app restarts

## File Structure

```
cowork-os/
├── package.json
├── tsconfig.json
├── tsconfig.electron.json
├── vite.config.ts
├── .gitignore
├── README.md
├── GETTING_STARTED.md
├── PROJECT_STATUS.md
├── IMPLEMENTATION_SUMMARY.md
├── CONTRIBUTING.md
├── CHANGELOG.md
├── SECURITY.md
│
├── build/
│   └── entitlements.mac.plist
│
└── src/
    ├── shared/
    │   └── types.ts
    │
    ├── electron/
    │   ├── main.ts
    │   ├── preload.ts
    │   │
    │   ├── database/
    │   │   ├── schema.ts
    │   │   └── repositories.ts
    │   │
    │   ├── ipc/
    │   │   └── handlers.ts
    │   │
    │   ├── updater/
    │   │   ├── index.ts
    │   │   └── update-manager.ts
    │   │
    │   ├── gateway/
    │   │   ├── index.ts
    │   │   ├── router.ts
    │   │   ├── session.ts
    │   │   ├── security.ts
    │   │   └── channels/
    │   │       ├── index.ts
    │   │       ├── types.ts
    │   │       ├── telegram.ts
    │   │       ├── discord.ts
    │   │       └── slack.ts
    │   │
    │   ├── utils/
    │   │   ├── rate-limiter.ts
    │   │   ├── validation.ts
    │   │   └── env-migration.ts
    │   │
    │   ├── settings/
    │   │   └── personality-manager.ts
    │   │
    │   └── agent/
    │       ├── daemon.ts
    │       ├── executor.ts
    │       ├── context-manager.ts
    │       │
    │       ├── llm/
    │       │   ├── index.ts
    │       │   ├── types.ts
    │       │   ├── provider-factory.ts
    │       │   ├── anthropic-provider.ts
    │       │   ├── gemini-provider.ts
    │       │   ├── openrouter-provider.ts
    │       │   ├── bedrock-provider.ts
    │       │   └── ollama-provider.ts
    │       │
    │       ├── search/
    │       │   ├── index.ts
    │       │   ├── types.ts
    │       │   ├── provider-factory.ts
    │       │   ├── tavily-provider.ts
    │       │   ├── brave-provider.ts
    │       │   ├── serpapi-provider.ts
    │       │   └── google-provider.ts
    │       │
    │       ├── browser/
    │       │   └── browser-service.ts
    │       │
    │       ├── tools/
    │       │   ├── registry.ts
    │       │   ├── file-tools.ts
    │       │   ├── glob-tools.ts
    │       │   ├── grep-tools.ts
    │       │   ├── edit-tools.ts
    │       │   ├── web-fetch-tools.ts
    │       │   ├── skill-tools.ts
    │       │   ├── search-tools.ts
    │       │   ├── browser-tools.ts
    │       │   └── shell-tools.ts
    │       │
    │       ├── skills/
    │       │   ├── spreadsheet.ts
    │       │   ├── document.ts
    │       │   ├── presentation.ts
    │       │   └── organizer.ts
    │       │
    │       └── sandbox/
    │           └── runner.ts
    │
    └── renderer/
        ├── index.html
        ├── main.tsx
        ├── App.tsx
        │
        ├── components/
        │   ├── Sidebar.tsx
        │   ├── MainContent.tsx
        │   ├── RightPanel.tsx
        │   ├── TaskView.tsx
        │   ├── TaskTimeline.tsx
        │   ├── Settings.tsx
        │   ├── SearchSettings.tsx
        │   ├── TelegramSettings.tsx
        │   ├── DiscordSettings.tsx
        │   ├── SlackSettings.tsx
        │   ├── UpdateSettings.tsx
        │   ├── PersonalitySettings.tsx
        │   ├── WorkspaceSelector.tsx
        │   └── ApprovalDialog.tsx
        │
        └── styles/
            └── index.css
```

## How to Run

### Quick Start

```bash
# Clone and install
git clone https://github.com/CoWork-OS/CoWork-OS.git
cd CoWork-OS
npm install

# Run in development mode
npm run dev

# Configure API credentials in Settings (gear icon)
```

### Available Commands

```bash
npm run dev              # Start development mode (hot reload)
npm run build            # Build for production
npm run package          # Create macOS .dmg installer
npm run lint             # Run ESLint
npm run type-check       # Check TypeScript types
```

## Feature Status

### Completed

| Feature | Status | Notes |
|---------|--------|-------|
| Task management | Production | Full CRUD, real-time updates |
| File operations | Production | 7 tools with permission checks |
| Document creation | Production | Real Office formats (.xlsx, .docx, .pdf, .pptx) |
| Multi-LLM support | Production | 5 providers |
| Web search | Production | 4 providers with fallback |
| Browser automation | Production | 12 Playwright tools |
| Code tools | Production | glob, grep, edit_file |
| Web fetch tools | Production | web_fetch, http_request |
| Telegram bot | Production | Full integration |
| Discord bot | Production | Slash commands + DMs |
| Slack bot | Production | Socket Mode + DMs + mentions |
| In-app Settings | Production | Secure storage |
| Auto-updates | Production | GitHub releases |
| Approval system | Production | User confirmation for destructive ops |
| Goal Mode | Production | Success criteria with auto-retry |
| Dynamic re-planning | Production | Agent revises plan mid-execution |
| Configurable guardrails | Production | Token/cost budgets, blocked commands |
| System tools | Production | Screenshots, clipboard, open apps |
| Auto-approve commands | Production | Skip approval for trusted patterns |
| Parallel task queue | Production | Run 1-10 tasks concurrently |
| Quick Task FAB | Production | Floating action button |
| Toast notifications | Production | Task completion alerts |
| Custom Skills | Production | User-defined reusable workflows |
| MCP Client | Production | Connect to external MCP servers |
| MCP Host | Production | Expose tools as MCP server |
| MCP Registry | Production | One-click server installation |
| MCP SSE/WebSocket | Production | Web-based MCP transports |
| In-app file viewer | Production | View artifacts without leaving app |
| Personality System | Production | Customizable agent behavior, personas, response styles |
| Citation Engine | Production | Auto-tracks web sources with deduplication and inline references |
| Scratchpad Tools | Production | Session-scoped note-taking for agents during long tasks |
| Workflow Pipeline | Production | Multi-phase task decomposition and sequential execution |
| Deep Work Mode | Production | Extended execution with progress journaling |
| Document Generation Tools | Production | PDF, PPTX, XLSX generation as agent tools |
| Event Triggers | Production | Condition-based automation (cron, webhook, channel) |
| File Hub | Production | Unified file aggregation across workspace, artifacts, cloud |
| Web Access Server | Production | HTTP/WebSocket server for browser-based access |
| Vision Tools (enhanced) | Production | Result caching, auto-downscaling, multi-provider fallback |
| DuckDuckGo Search | Production | Free built-in web search, always available |
| Discord MCP Connector | Production | 19-tool REST API connector for Discord bots |
| OAuth Connectors | Production | Google Workspace, DocuSign, Outreach, Slack OAuth flows |
| Financial Plugin Packs | Production | 5 packs: Equity Research, Financial Analysis, IB, PE, Wealth |
| Scoped Temp Workspaces | Production | Scope-aware isolation (ui, gateway, hooks, tray) with lease protection |
| Sandbox Profile Cleanup | Production | Periodic pruning of stale .sb files from temp directory |
| Managed Cron Workspaces | Production | Deterministic paths under userData with per-run directories |
| Cron Workspace Context | Production | Runtime workspace migration, template variables for run paths |
| Idle Session Cleanup | Production | Gateway auto-prunes idle sessions older than 7 days |
| Workspace Cascade Delete | Production | Transactional deletion of workspace + all related data |

### Planned

| Feature | Status | Complexity |
|---------|--------|------------|
| VM sandbox | Not started | High |
| Sub-agent coordination | Not started | High |
| Network egress controls | Not started | Medium |

## Technology Stack

### Frontend
- React 19
- TypeScript 5.7
- Vite 7

### Backend
- Electron 40
- Node.js 20+
- better-sqlite3

### Document Libraries
- exceljs (Excel)
- docx (Word)
- pdfkit (PDF)
- pptxgenjs (PowerPoint)

### AI/ML
- @anthropic-ai/sdk
- @google/generative-ai
- @aws-sdk/client-bedrock-runtime

### Automation
- Playwright (browser)
- discord.js (Discord)
- grammy (Telegram)
- @slack/bolt (Slack)

## Security Model

### Current Security Features

1. **Path Isolation**: All operations constrained to workspace folder
2. **Permission Checks**: Every operation validates permissions
3. **Approval Flow**: Destructive ops require user confirmation
4. **Audit Trail**: Every action logged in database
5. **Context Isolation**: Renderer process isolated from Node.js
6. **Secure Storage**: Credentials stored with system keychain (safeStorage)
7. **CSP Headers**: Content Security Policy in production
8. **Input Validation**: All IPC inputs validated

### Security Limitations

1. **No VM Sandbox**: Code runs in main process (not isolated)
2. **No Network Controls**: Can make API calls freely
3. **No Resource Limits**: Can consume unlimited memory/CPU

## Comparison to Original Cowork Concept

| Feature | Target | Current | Status |
|---------|--------|---------|--------|
| Task-based UI | Yes | Yes | Complete |
| Multi-step execution | Yes | Yes | Complete |
| File operations | Yes | Yes | Complete |
| Approval system | Yes | Yes | Complete |
| Real-time timeline | Yes | Yes | Complete |
| Workspace isolation | Yes | Yes | Complete |
| Document creation | Yes | Yes (real Office) | Complete |
| Web search | Yes | Yes | Complete |
| Browser automation | Yes | Yes | Complete |
| Multi-provider LLM | Yes | Yes | Complete |
| Remote channels | Yes | Yes (WhatsApp, Telegram, Discord, Slack) | Complete |
| Goal Mode | Yes | Yes | Complete |
| Dynamic re-planning | Yes | Yes | Complete |
| System tools | Yes | Yes | Complete |
| Configurable guardrails | Yes | Yes | Complete |
| Custom Skills | Yes | Yes | Complete |
| MCP connectors | Yes | Yes (Client, Host, Registry) | Complete |
| Parallel task queue | Yes | Yes | Complete |
| Personality System | Yes | Yes (6 personalities, 9 personas) | Complete |
| VM sandbox | Yes | No | Planned |
| Sub-agents | Yes | No | Planned |

**Overall Implementation**: ~95%

## Summary

CoWork OS is a production-ready agentic task automation app with:

- **5 LLM providers** (cloud and local)
- **5 search providers** with fallback (including DuckDuckGo free built-in)
- **17 browser automation tools**
- **3 code tools** (glob, grep, edit_file)
- **2 web fetch tools** (web_fetch, http_request)
- **4 document skills** with real Office output + 3 document generation tools (PDF, PPTX, XLSX)
- **4 channel integrations** (WhatsApp, Telegram, Discord, Slack)
- **17 bundled plugin packs** with 55+ role-specific skills
- **139 built-in standalone skills**
- **Full MCP support** (Client, Host, Registry with SSE/WebSocket)
- **Custom Skills** (user-defined reusable workflows)
- **Personality System** (6 personalities, 9 personas, response styles, quirks)
- **Goal Mode** (success criteria with auto-retry)
- **Configurable guardrails** (token/cost budgets, blocked commands)
- **Parallel task queue** (1-10 concurrent tasks)
- **System tools** (screenshots, clipboard, open apps)
- **Full in-app configuration** (no .env required)
- **Auto-update support**
- **Comprehensive security** (path isolation, approvals, audit logging)

Ready to use: `npm run dev`
Ready to distribute: `npm run package`
