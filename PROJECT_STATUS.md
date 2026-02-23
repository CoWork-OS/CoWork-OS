# Project Status

## Production-Ready Implementation

CoWork OS is a **security-first personal AI assistant platform** with multi-channel messaging support, comprehensive guardrails, and extensive test coverage.

### What CoWork OS Is

- **Personal AI Gateway**: Connect your AI assistant to WhatsApp, Telegram, Discord, Slack, and iMessage
- **Security-First Design**: 390+ unit tests, configurable guardrails, approval workflows
- **Multi-Provider Support**: 6 LLM providers including free local models via Ollama
- **Local-First Architecture**: Your data stays on your machine, BYOK model

## What's Built and Working

### 1. Core Architecture

#### Database Layer
- [x] SQLite schema with 6 tables (workspaces, tasks, events, artifacts, approvals, skills)
- [x] Repository pattern for data access
- [x] Type-safe database operations
- [x] Located: `src/electron/database/`

#### Agent System
- [x] AgentDaemon - Main orchestrator
- [x] TaskExecutor - Plan-execute-observe loop
- [x] Tool Registry - Manages all available tools
- [x] Permission system with approval flow
- [x] Context Manager - Conversation context handling
- [x] Located: `src/electron/agent/`

#### Multi-Provider LLM Support
- [x] Anthropic (Claude models)
- [x] Google Gemini
- [x] OpenRouter (multi-model access)
- [x] OpenAI (API Key: GPT-4o, o1 models)
- [x] OpenAI (ChatGPT OAuth: Use your ChatGPT subscription)
- [x] AWS Bedrock
- [x] Ollama (local/free)
- [x] Provider Factory with dynamic selection
- [x] Located: `src/electron/agent/llm/`

#### Web Search Integration
- [x] Tavily (AI-optimized)
- [x] Brave Search
- [x] SerpAPI (Google results)
- [x] Google Custom Search
- [x] Primary + fallback provider support
- [x] Located: `src/electron/agent/search/`

#### Browser Automation
- [x] Playwright integration
- [x] Navigation, screenshots, PDF export
- [x] Click, fill, type, press keys
- [x] Content extraction (text, links, forms)
- [x] Scroll, wait for elements
- [x] Located: `src/electron/agent/browser/`

#### Channel Integrations
- [x] WhatsApp bot with QR code pairing and self-chat mode
- [x] Telegram bot with commands
- [x] Discord bot with slash commands
- [x] Slack bot with Socket Mode
- [x] Session management
- [x] Security modes (pairing, allowlist, open)
- [x] Located: `src/electron/gateway/`

### 2. Tools & Skills

#### File Operations (7 tools)
- [x] read_file - Read file contents
- [x] write_file - Create or overwrite files
- [x] list_directory - List folder contents
- [x] rename_file - Rename or move files
- [x] delete_file - Delete with approval
- [x] create_directory - Create folders
- [x] search_files - Search by name/content

#### Document Skills (4 skills)
- [x] Spreadsheet - Excel .xlsx (exceljs)
- [x] Document - Word .docx and PDF (docx, pdfkit)
- [x] Presentation - PowerPoint .pptx (pptxgenjs)
- [x] Folder Organizer - By type/date

#### Browser Tools (12 tools)
- [x] browser_navigate
- [x] browser_screenshot
- [x] browser_save_pdf
- [x] browser_click
- [x] browser_fill
- [x] browser_type
- [x] browser_press
- [x] browser_get_content
- [x] browser_get_links
- [x] browser_get_forms
- [x] browser_scroll
- [x] browser_wait

#### Search Tools
- [x] web_search - Multi-provider web search

#### Code Tools (3 tools)
- [x] glob - Fast pattern-based file search
- [x] grep - Regex content search across files
- [x] edit_file - Surgical file editing with find-and-replace

#### Web Fetch Tools (2 tools)
- [x] web_fetch - Fetch and parse web pages
- [x] http_request - Full HTTP client (curl-like)

#### Web Scraping Tools (5 tools, Scrapling integration)
- [x] scrape_page - Anti-bot bypass scraping with TLS fingerprinting, Cloudflare bypass, stealth mode
- [x] scrape_multiple - Batch scrape up to 20 URLs
- [x] scrape_extract - Structured data extraction (tables, lists, headings, metadata, custom selectors)
- [x] scrape_session - Multi-step persistent sessions (login → navigate → extract)
- [x] scraping_status - Installation and version check
- [x] Python bridge architecture (stdin/stdout JSON)
- [x] Three fetcher modes: default (HTTP+TLS), stealth (Cloudflare bypass), playwright (full browser)
- [x] Proxy support, rate limiting, configurable timeout
- [x] Settings UI with installation status check
- [x] Five bundled skills: web-scraper, price-tracker, site-mapper, lead-scraper, content-monitor
- [x] Located: `src/electron/scraping/`, `src/electron/agent/tools/scraping-tools.ts`

#### Shell Tools
- [x] execute_command - Shell command execution (requires approval)

#### System Tools
- [x] take_screenshot - Full screen or specific windows
- [x] clipboard_read / clipboard_write - Clipboard access
- [x] open_application / open_url / open_path - Launch apps and URLs
- [x] show_in_finder - Reveal files in Finder
- [x] get_system_info - System information and environment

#### Custom Skills
- [x] User-defined reusable workflows
- [x] YAML-based skill definitions
- [x] Priority-based sorting
- [x] Parameter input modal for skill variables
- [x] Located: `~/Library/Application Support/cowork-os/skills/`

#### Think With Me Mode
- [x] Socratic brainstorming mode (`think` conversation mode)
- [x] Auto-detection from brainstorm/trade-off/pros-and-cons patterns
- [x] Read-only tool restriction in think mode
- [x] "Think with me" toggle in task creation UI

#### Problem Framing & Uncertainty
- [x] Task complexity scoring (`low | medium | high`) on intent routes
- [x] Pre-flight problem restatement for complex execution tasks
- [x] Graceful uncertainty system prompt instructions
- [x] Low-confidence amber indicator in assistant messages

#### AI Playbook
- [x] Auto-capture successful patterns (approach, outcome, tools used)
- [x] Lesson capture from task failures
- [x] Relevant playbook injection into system prompts
- [x] Playbook viewer in Settings > AI Playbook
- [x] Located: `src/electron/memory/PlaybookService.ts`

#### Daily Briefing
- [x] Morning briefing with task stats, memory highlights, goal-based priorities
- [x] Auto-created disabled cron job on first workspace load
- [x] Configurable time picker and channel delivery
- [x] Located: `src/electron/reports/DailyBriefingService.ts`

#### Build Mode
- [x] Four-phase canvas workflow (Concept → Plan → Scaffold → Iterate)
- [x] Named phase checkpoints with revert and diff support
- [x] Build Mode orchestrator with session management
- [x] Build Mode skill definition (`resources/skills/build-mode.json`)
- [x] Located: `src/electron/canvas/build-mode-orchestrator.ts`

#### Usage Insights
- [x] Task metrics (created, completed, failed, avg completion time)
- [x] Cost/token tracking by model
- [x] Activity heatmap by day-of-week and hour
- [x] Top skills usage ranking
- [x] 7/14/30-day period selector
- [x] Located: `src/electron/reports/UsageInsightsService.ts`, `src/renderer/components/UsageInsightsPanel.tsx`

#### Persistent Agent Teams
- [x] Teams survive across sessions with `persistent` flag
- [x] Default workspace assignment per team
- [x] `listPersistent()` repository method
- [x] DB migration for persistent and default_workspace_id columns
- [x] UI toggle and badge in Agent Teams panel

#### Adaptive Complexity
- [x] Three-tier UI density (focused, standard, power)
- [x] Focused mode hides advanced settings
- [x] Power mode shows all settings and features
- [x] Configurable in Settings > Appearance

#### Infrastructure (Native Cloud Tools)
- [x] Cloud sandboxes via E2B (create, exec, file read/write, list, delete, expose ports)
- [x] Domain registration via Namecheap (search, register, DNS management)
- [x] Built-in USDC wallet on Base (auto-generated, OS keychain encrypted, balance polling)
- [x] x402 payment protocol (EIP-712 signed USDC payments for HTTP APIs)
- [x] Infrastructure status tool for provider health checks
- [x] Approval gating for all payment and registration operations
- [x] Settings UI with provider status, API key config, wallet display, and tool toggles
- [x] Located: `src/electron/infra/`

#### Starter Missions & Skills
- [x] 10 one-click starter mission templates with categories
- [x] Displayed in onboarding and empty-state welcome screen
- [x] Competitive research skill (`resources/skills/competitive-research.json`)
- [x] Idea validation skill (`resources/skills/idea-validation.json`)

#### Plain-Language Settings
- [x] Renamed jargon labels in Settings sidebar
- [x] Technical names preserved in tooltips

#### Personality System
- [x] 6 personality styles (professional, friendly, concise, creative, technical, casual)
- [x] 9 persona overlays (jarvis, friday, hal, computer, alfred, intern, sensei, pirate, noir)
- [x] Response style options (emoji usage, response length, code comments, explanation depth)
- [x] Quirks (catchphrase, sign-off, analogy domain)
- [x] Prompt-based control via conversation
- [x] Relationship tracking (user name, interaction count)
- [x] Located: `src/electron/settings/personality-manager.ts`

#### MCP (Model Context Protocol)
- [x] MCP Client - Connect to external MCP servers
- [x] MCP Host - Expose CoWork's tools as MCP server
- [x] MCP Registry - One-click server installation
- [x] SSE and WebSocket transports
- [x] Located: `src/electron/mcp/`

### 3. User Interface

#### Main Components
- [x] Workspace selector with folder picker
- [x] Task list with status indicators
- [x] Task detail view with timeline
- [x] Approval dialog system
- [x] Real-time event streaming
- [x] Quick Task FAB (floating action button)
- [x] Toast notifications for task completion
- [x] In-app file viewer for artifacts
- [x] Parallel task queue panel

#### Settings UI
- [x] LLM provider configuration
- [x] Model selection
- [x] Search provider configuration
- [x] Telegram bot settings
- [x] Discord bot settings
- [x] Slack bot settings
- [x] Update settings
- [x] Guardrail settings (budgets, limits)
- [x] Queue settings (concurrency)
- [x] Custom Skills management
- [x] Personality settings (styles, personas, quirks)
- [x] MCP server configuration

### 4. Infrastructure

#### Security
- [x] Secure credential storage (safeStorage)
- [x] Path traversal protection
- [x] Content Security Policy
- [x] Input validation
- [x] Approval flow for destructive operations

#### Configurable Guardrails
- [x] Token budget per task (1K - 10M)
- [x] Cost budget per task ($0.01 - $100)
- [x] Iteration limit (5 - 500)
- [x] Dangerous command blocking
- [x] Auto-approve trusted commands
- [x] File size limits
- [x] Domain allowlist for browser

#### Goal Mode & Re-planning
- [x] Success criteria (shell commands or file checks)
- [x] Auto-retry up to N attempts
- [x] Dynamic re-planning mid-execution
- [x] `revise_plan` tool for agent adaptation

#### Parallel Task Queue
- [x] Configurable concurrency (1-10)
- [x] FIFO queue management
- [x] Auto-start next task
- [x] Queue persistence across restarts

#### Auto-Update System
- [x] Update checking
- [x] Download progress
- [x] One-click install
- [x] GitHub releases integration

#### Build System
- [x] Electron + React + TypeScript
- [x] Vite for development
- [x] electron-builder for packaging
- [x] macOS entitlements

## File Structure

```
cowork-os/
├── src/
│   ├── electron/
│   │   ├── main.ts
│   │   ├── preload.ts
│   │   ├── database/
│   │   │   ├── schema.ts
│   │   │   └── repositories.ts
│   │   ├── agent/
│   │   │   ├── daemon.ts
│   │   │   ├── executor.ts
│   │   │   ├── queue-manager.ts    # Parallel task queue
│   │   │   ├── context-manager.ts
│   │   │   ├── custom-skill-loader.ts
│   │   │   ├── llm/           # 5 providers
│   │   │   ├── search/        # 4 providers
│   │   │   ├── browser/       # Playwright service
│   │   │   ├── tools/         # All tool implementations
│   │   │   ├── skills/        # Document skills
│   │   │   └── guardrails/    # Safety limits
│   │   ├── gateway/           # WhatsApp, Telegram, Discord & Slack
│   │   ├── canvas/            # Canvas manager, Build Mode orchestrator
│   │   ├── infra/             # Infrastructure (E2B, domains, wallet, x402)
│   │   ├── reports/           # Usage insights, daily briefing
│   │   ├── memory/            # Memory, playbook, user profile
│   │   ├── agents/            # Agent teams, orchestrator
│   │   ├── settings/          # Personality manager
│   │   ├── mcp/               # Model Context Protocol
│   │   │   ├── client/        # Connect to servers
│   │   │   ├── host/          # Expose tools
│   │   │   └── registry/      # Server catalog
│   │   ├── updater/           # Auto-update
│   │   ├── ipc/
│   │   └── utils/
│   ├── renderer/
│   │   ├── App.tsx
│   │   ├── components/        # 20+ components
│   │   └── styles/
│   └── shared/
│       └── types.ts
├── build/
│   └── entitlements.mac.plist
└── package.json
```

## How It Works

### Execution Flow

```
1. User selects workspace folder
   |
2. User creates task with description
   |
3. AgentDaemon starts TaskExecutor
   |
4. TaskExecutor calls LLM (any configured provider) to create plan
   |
5. For each plan step:
   - LLM decides which tools to use
   - TaskExecutor calls tools via ToolRegistry
   - Tools perform operations (with permission checks)
   - Results sent back to LLM
   - Events logged and streamed to UI
   |
6. If approval needed:
   - TaskExecutor pauses
   - ApprovalDialog shown to user
   - User approves/denies
   - Execution continues or fails
   |
7. Task completes
   - Status updated to "completed"
   - All events logged in database
   - Artifacts tracked
```

### Permission Model

```
Workspace Permissions:
├── Read: Enabled by default
├── Write: Enabled by default
├── Delete: Enabled, requires approval
├── Network: Enabled (for web search)
└── Shell: Requires approval

Operations Requiring Approval:
├── Delete file
├── Delete multiple files
├── Bulk rename (>10 files)
├── Shell command execution
└── External service calls
```

## What's NOT Implemented (Planned)

### VM Sandbox
- **Status**: Stub implementation
- **File**: `src/electron/agent/sandbox/runner.ts`
- **What's needed**:
  - macOS Virtualization.framework integration
  - Linux VM image
  - Workspace mount
  - Network egress controls

### Sub-Agents
- **Status**: Not started
- **What's needed**:
  - Agent pool management
  - Task splitting logic
  - Result merging
  - Resource allocation

## Ready to Use

### You Can:
1. Select workspaces and create tasks
2. Use any of 6 LLM providers (including free local Ollama)
3. Execute multi-step file operations
4. Create real Office documents (.xlsx, .docx, .pdf, .pptx)
5. Search the web with multiple providers
6. Automate browser interactions
7. Run tasks remotely via WhatsApp, Telegram, Discord, or Slack
8. Track all agent activity in real-time
9. Approve/deny destructive operations
10. Receive automatic updates
11. Use Goal Mode with success criteria and auto-retry
12. Create custom skills with reusable workflows
13. Connect to MCP servers for extended tool access
14. Run multiple tasks in parallel (1-10 concurrent)
15. Configure safety guardrails (budgets, blocked commands)
16. Use system tools (screenshots, clipboard, open apps)
17. View artifacts with the in-app file viewer
18. Customize agent personality via Settings or conversation prompts
19. Use "Think With Me" mode for brainstorming and decision-making
20. Build prototypes with Build Mode (idea → working prototype)
21. View usage insights with cost/token tracking and activity patterns
22. Auto-capture successful patterns with AI Playbook
23. Receive proactive daily briefings with task stats and priorities
24. Create persistent agent teams that survive across sessions
25. Adjust UI complexity (focused, standard, power) to match your experience level
26. Spin up cloud sandboxes and run code in isolated Linux VMs
27. Search and register domains with DNS management
28. Use a built-in crypto wallet for infrastructure payments
29. Make x402 HTTP payments for API access and premium content

### You Cannot (Yet):
1. Execute arbitrary code in a VM sandbox
2. Run tasks with coordinated sub-agents
3. Apply network egress controls

## Dependencies

### Production
- `react` & `react-dom` - UI framework
- `better-sqlite3` - Local database
- `@anthropic-ai/sdk` - Anthropic API
- `@google/generative-ai` - Gemini API
- `@aws-sdk/client-bedrock-runtime` - AWS Bedrock
- `playwright` - Browser automation
- `discord.js` - Discord bot
- `grammy` - Telegram bot
- `@slack/bolt` - Slack bot
- `exceljs` - Excel creation
- `docx` - Word document creation
- `pdfkit` - PDF creation
- `pptxgenjs` - PowerPoint creation
- `e2b` - Cloud sandbox VMs
- `ethers` - Crypto wallet and EIP-712 signing
- `electron-updater` - Auto-updates

### Development
- `electron` - Desktop framework
- `vite` - Build tool
- `typescript` - Type safety
- `electron-builder` - App packaging

## Quick Test Checklist

Before first run, verify:

- [ ] Node.js 18+ installed
- [ ] `npm install` completed successfully
- [ ] On macOS (required for Electron native features)

Then run:
```bash
npm run dev
```

Expected behavior:
1. Vite dev server starts (port 5173)
2. Electron window opens
3. DevTools open automatically
4. Workspace selector appears
5. Configure API credentials in Settings (gear icon)

## Performance Characteristics

### Token Usage (varies by provider)
- **Plan creation**: ~500-1000 tokens
- **Step execution**: ~1000-3000 tokens per step
- **Average task**: 5000-10000 tokens total

### Timing
- **Plan creation**: 2-5 seconds
- **Simple file operation**: 3-6 seconds per step
- **Document creation**: 5-10 seconds
- **Browser automation**: 2-10 seconds per action
- **Web search**: 1-3 seconds

### Resource Usage
- **Memory**: ~200-400MB (Electron + Playwright when active)
- **Database**: <1MB per task
- **CPU**: Minimal (except during API calls)

## Summary

**CoWork OS is a production-ready, security-first personal AI assistant platform:**

### Core Strengths
- **Security**: 390+ unit tests, configurable guardrails, approval workflows, brute-force protection
- **Multi-Channel**: WhatsApp, Telegram, Discord, Slack, iMessage integration
- **Multi-Provider**: 6 LLM providers (Claude, GPT, Gemini, Bedrock, OpenRouter, Ollama)
- **Local-First**: Your data stays on your machine, BYOK model
- **Extensible**: MCP support (Client, Host, Registry), 75+ bundled skills

### Feature Highlights
- Real Office document creation (Excel, Word, PDF, PowerPoint)
- Web search and browser automation
- Code tools (glob, grep, edit_file)
- Personality customization (6 styles, 9 personas)
- Goal Mode with auto-retry
- Parallel task queue (1-10 concurrent)
- Remote access (Tailscale, SSH, WebSocket API)
- Think With Me mode for Socratic brainstorming
- Build Mode for idea-to-prototype canvas workflows
- Usage Insights dashboard with cost/activity analytics
- AI Playbook with auto-captured success patterns
- Persistent agent teams and adaptive UI complexity
- Native infrastructure: cloud sandboxes, domain registration, wallet, x402 payments

### Planned
- VM sandbox using macOS Virtualization.framework
- Network egress controls with proxy
- Cross-platform support (Windows, Linux)
- Web Browser Mode (`--serve`) — full app accessible from any browser via HTTP/WebSocket

The architecture is extensible. All future features can be added without refactoring core systems.

Ready to run with: `npm install && npm run dev`
