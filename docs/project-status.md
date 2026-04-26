# Project Status

## Production-Ready Implementation

CoWork OS is a **security-first personal AI assistant platform** with multi-channel messaging support, comprehensive guardrails, and extensive test coverage.

### What CoWork OS Is

- **Personal AI Gateway**: Connect your AI assistant to WhatsApp, Telegram, Discord, Slack, and iMessage
- **Managed Devices**: Operate local and remote CoWork machines from a dedicated Devices tab
- **Automations Surface**: One settings group for queueing, scheduling, triggers, briefing, and Workflow Intelligence suggestions/reflection
- **Renderer Performance**: Sidebar and timeline virtualization in the `CoWork-OS/CoWork-OS` repo use `@chenglou/pretext` for text measurement and keep long task feeds responsive
- **Security-First Design**: 4,932 automated tests across 390 test files, configurable guardrails, layered permission rules, workspace-local policy files, and approval workflows
- **Imported Capability Security**: managed skill and pack imports are staged, scanned, reported, and quarantined when blocked instead of being activated directly
- **Multi-Provider Support**: 30+ LLM providers including free local models via Ollama
- **Local-First Architecture**: Your data stays on your machine, BYOK model

## What's Built and Working

### 1. Core Architecture

#### Reliability Flywheel (Eval + Risk Gates)
- [x] Eval corpus extraction from failed/partial tasks (`scripts/qa/build_eval_corpus.cjs`)
- [x] Deterministic eval suite replay runner (`scripts/qa/run_eval_suite.cjs`)
- [x] Eval schema and task metadata (`eval_cases`, `eval_suites`, `eval_runs`, `eval_case_runs`, task risk/eval columns)
- [x] Eval service and IPC endpoints (`eval:listSuites`, `eval:runSuite`, `eval:getRun`, `eval:getCase`, `eval:createCaseFromTask`)
- [x] Risk scoring and policy-driven tiered review gate (`off`, `balanced`, `strict`)
- [x] Prompt reliability hardening (modular prompt sections, shared policy dedupe, token budgets)
- [x] Session- and turn-scoped prompt section memoization for execution and follow-up prompt assembly
- [x] Provider-aware prompt caching with stable-prefix hashing, Anthropic/OpenRouter/OpenAI-family routing, and cache telemetry
- [x] Prompt-aware tool rendering with compact planning text and provider-facing description reuse
- [x] Skill shortlist routing with low-confidence fallback and text budget caps
- [x] Earlier verification nudges through checklist tool-result reminders and pre-finalization prompt reminders
- [x] PR regression policy gate for production incident fixes
- [x] Nightly hardening workflow with machine-readable report artifact
- [x] Release hardening gate (date-based strictness window)
- [x] Local-only reliability data policy (no required telemetry upload path)
- [x] Reference: `docs/reliability-flywheel.md`

#### Database Layer
- [x] SQLite schema with 6 tables (workspaces, tasks, events, artifacts, approvals, skills)
- [x] Repository pattern for data access
- [x] Type-safe database operations
- [x] Located: `src/electron/database/`

#### Agent System
- [x] AgentDaemon - Main orchestrator with worktree isolation and collaborative mode
- [x] TaskExecutor - Shared turn kernel, metadata-driven tool scheduler, delegated-work orchestration, and terminal-state-safe completion/resume handoff
- [x] SessionRuntime - Canonical owner for task-session state, session checklists, snapshots, recovery, and task projection
- [x] Prompt-cache runtime state - stable system blocks, stable-prefix hashing, provider-family mode tracking, and resume-safe cache invalidation
- [x] ExecutorEventEmitter - Typed event system for executor lifecycle
- [x] LifecycleMutex - Concurrency control for executor operations
- [x] Tool Registry - Manages all available tools and scheduler metadata
- [x] Tool prompt layer - Internal prompt metadata renders visible-tool guidance after filtering without changing provider schemas
- [x] Session checklist runtime tools - `task_list_create`, `task_list_update`, and `task_list_list` for execution-style tasks
- [x] Orchestration graph engine - Normalized delegation runs for spawn_agent, workflow phases, teams, and ACP tasks
- [x] Worker roles - researcher, implementer, verifier, and synthesizer with hard tool scopes
- [x] Structured delegation brief - child tasks inherit objective, scope, evidence, deliverable, and completion contracts
- [x] Permission system with layered rules, workspace policy files, and approval flow
- [x] Context Manager - Conversation context handling
- [x] Capability Matcher - Auto-select agents based on task requirements
- [x] Located: `src/electron/agent/`

#### Multi-Provider LLM Support
- [x] Anthropic (Claude models)
- [x] Google Gemini
- [x] OpenRouter (multi-model access)
- [x] OpenAI (API Key: GPT-4o, o1 models)
- [x] OpenAI (ChatGPT OAuth: Use your ChatGPT subscription)
- [x] Prompt caching defaults for Anthropic, Azure Anthropic, OpenAI, Azure OpenAI, and OpenRouter GPT/Claude routes
- [x] AWS Bedrock
- [x] Ollama (local/free)
- [x] Provider Factory with dynamic selection
- [x] Located: `src/electron/agent/llm/`

#### Web Search Integration
- [x] DuckDuckGo (free built-in, no API key — automatic last-resort fallback)
- [x] Tavily (AI-optimized)
- [x] Brave Search
- [x] SerpAPI (Google results)
- [x] Google Custom Search
- [x] Primary + fallback provider support
- [x] web_search tool always available (DuckDuckGo ensures zero-config search)
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

#### Document Tools and Skills
- [x] Spreadsheet - Excel .xlsx (exceljs)
- [x] Document - Word .docx and PDF (docx, pdfkit)
- [x] LaTeX compilation - `.tex` source to PDF via system `tectonic`, `latexmk`, `xelatex`, `lualatex`, or `pdflatex`
- [x] Presentation - PowerPoint .pptx (pptxgenjs)
- [x] Presentation previews - PPTX slide thumbnails, navigation, extracted text, and speaker notes in the in-app viewer
- [x] Folder Organizer - By type/date
- [x] Kami - Editorial PDFs, resumes, one-pagers, diagrams, and slide decks with workspace-local scaffolding

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

#### Git Tools (3 tools)
- [x] git_commit - Commit changes in workspace or worktree
- [x] git_diff - View staged/unstaged changes
- [x] git_branch - List, create, or switch branches

#### Web Fetch Tools (2 tools)
- [x] web_fetch - Fetch and parse web pages
- [x] http_request - Full HTTP client (curl-like)

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
- [x] Managed import scanning, persisted security reports, quarantine, and digest recheck for imported skill bundles
- [x] Located: `~/Library/Application Support/cowork-os/skills/`

#### Research Vault Workflow
- [x] First-class bundled `llm-wiki` skill
- [x] Workspace-local markdown vault structure with `SCHEMA.md`, `index.md`, `log.md`, `inbox.md`, and durable `raw/` captures
- [x] Obsidian-friendly note/link conventions
- [x] Deterministic vault analyzer for link health, bridge pages, surprising cross-section links, and suggested follow-up questions
- [x] Desktop + gateway slash-command support with inline chaining
- [x] Located: `resources/skills/llm-wiki.json` and `resources/skills/llm-wiki/`

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
- [x] Task list with status indicators and task pinning
- [x] Task detail view with timeline and scroll-to-bottom button
- [x] Right-panel checklist section showing the latest read-only session checklist and verification nudge state
- [x] Task learning progression surface with memory, playbook, and skill proposal visibility
- [x] Approval dialog system
- [x] Real-time event streaming
- [x] Quick Task FAB (floating action button)
- [x] Toast notifications for task completion
- [x] In-app file viewer for artifacts
- [x] Paired LaTeX/PDF artifact workbench with Summary, `.tex source`, and PDF tabs
- [x] Rich PPTX artifact viewer with inline deck cards and full-slide preview
- [x] Parallel task queue panel
- [x] Collaborative Thoughts Panel - Real-time agent thinking display
- [x] Comparison View - Side-by-side agent/model output comparison
- [x] Multi-LLM Selection Panel - Configure multi-provider runs
- [x] Live router visibility - active provider, active model, and fallback state surfaced in the task UI
- [x] Unified recall search across tasks, messages, files, memory, and knowledge-graph context
- [x] Persistent shell session status and retained-state controls for long-running operator workflows
- [x] Worktree Settings - Git worktree configuration UI
- [x] Devices tab - saved remote devices, remote task feed, remote workspace browser, remote file picker
- [x] Companies tab - company shell setup, goals, projects, issues, linked operators
- [x] Workflow Intelligence settings - heartbeat-triggered reflection, target kinds, last winner visibility, namespaced backlog, suggestion output, and dispatch history

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
- [x] Automations settings group (queue, Workflow Intelligence, scheduled, hooks, triggers, briefing)
- [x] Custom Skills management
- [x] Quarantined Imports sections for skills and plugin packs with report, retry scan, and removal actions
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
│   │   │   ├── executor-*-utils.ts # Modular executor utilities
│   │   │   ├── executor-event-emitter.ts
│   │   │   ├── executor-lifecycle-mutex.ts
│   │   │   ├── llm/           # 30+ providers and compatible gateways
│   │   │   ├── search/        # 4 providers
│   │   │   ├── browser/       # Playwright service
│   │   │   ├── tools/         # All tool implementations + git tools
│   │   │   ├── skills/        # Document skills
│   │   │   └── guardrails/    # Safety limits
│   │   ├── git/               # Git worktree & comparison service
│   │   ├── agents/            # Agent teams, thoughts, capability matcher
│   │   ├── gateway/           # WhatsApp, Telegram, Discord & Slack
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
4. TaskExecutor builds or refreshes SessionRuntime and delegates the next turn request to it
   |
5. SessionRuntime prepares the message set, owns the turn-loop mirror state, and constructs the active TurnKernel for the step, follow-up, or text turn
   |
6. For each plan step:
   - LLM decides which tools to use
   - TaskExecutor routes the batch through ToolScheduler and ToolRegistry
   - Tools perform operations (with permission checks)
   - Results sent back to LLM
   - Events logged and streamed to UI
   |
7. If approval needed:
   - TaskExecutor pauses
   - ApprovalDialog shown to user
   - User approves/denies
   - Execution continues or fails
   |
8. Task completes
   - Status updated to "completed"
   - All events and semantic completion summaries logged in database
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

### Agent Integrity and Trap Defense
- **Status**: Planned
- **Spec**: `docs/agent-integrity-and-trap-defense-spec.md`
- **Why it matters**:
  - hardens CoWork OS against hidden-content prompt injection, semantic manipulation, poisoned memory, malicious delegation, and approval-fatigue attacks
  - turns current non-blocking prompt-injection detection into a durable runtime integrity model spanning ingestion, memory, permissions, delegation, and operator review
- **Planned phases**:
  - Phase 1: content integrity records and task-level risk classification for web, browser, scraping, email, and imported documents
  - Phase 2: trusted vs untrusted memory lanes and promotion gates for KG, playbooks, and skill proposals
  - Phase 3: provenance-aware approvals and permission decisions for sensitive actions
  - Phase 4: taint propagation and restrictions across agent teams, child tasks, and remote delegation
  - Phase 5: integrity dashboard plus eval and red-team coverage for agent-trap scenarios

### VM Sandbox
- **Status**: Stub implementation
- **File**: `src/electron/agent/sandbox/runner.ts`
- **What's needed**:
  - macOS Virtualization.framework integration
  - Linux VM image
  - Workspace mount
  - Network egress controls

### Sub-Agents / Multi-Agent Collaboration
- **Status**: Implemented (Collaborative Mode, Multi-LLM Mode, Agent Comparison)
- **What's built**:
  - Collaborative Mode: ephemeral multi-agent teams with real-time thought sharing
  - Multi-LLM Mode: same task dispatched to multiple providers with judge synthesis
  - Agent Comparison Mode: side-by-side output comparison across agents/models
  - Capability Matcher: auto-select agents based on task requirements
  - Git Worktree Isolation: per-task isolated branches with auto-commit/merge/cleanup

## Ready to Use

### You Can:
1. Select workspaces and create tasks
2. Use any configured LLM provider, including local Ollama and 30+ supported provider/gateway options
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
17. View artifacts with the in-app file viewer, including rich `.pptx` deck previews
18. Customize agent personality via Settings or conversation prompts
19. Run tasks in isolated git worktrees with auto-commit and merge
20. Use collaborative mode for multi-agent team reasoning
21. Use multi-LLM mode to compare outputs across providers
22. Compare agent outputs side by side
23. Pin tasks for quick access
24. Gracefully wrap up running tasks
25. Use git tools (commit, diff, branch) within tasks

### You Cannot (Yet):
1. Execute arbitrary code in a VM sandbox
2. Apply network egress controls

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
- `electron-updater` - Auto-updates

### Development
- `electron` - Desktop framework
- `vite` - Build tool
- `typescript` - Type safety
- `electron-builder` - App packaging

## Quick Test Checklist

Before first run, verify:

- [ ] Node.js 24+ installed
- [ ] `npm install` completed successfully
- [ ] On macOS or Windows (required for Electron desktop features)

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
- **Security**: 4,932 automated tests across 390 test files, configurable guardrails, layered permission rules, approval workflows, and brute-force protection
- **Multi-Channel**: WhatsApp, Telegram, Discord, Slack, iMessage integration
- **Multi-Provider**: 30+ LLM providers and compatible gateways, including Claude, GPT, Gemini, Bedrock, OpenRouter, and Ollama
- **Local-First**: Your data stays on your machine, BYOK model
- **Extensible**: MCP support (Client, Host, Registry), 140 built-in skills, and plugin packs

### Feature Highlights
- Real Office document creation (Excel, Word, PDF, PowerPoint)
- Web search and browser automation
- Code tools (glob, grep, edit_file) and git tools (commit, diff, branch)
- Collaborative Mode with real-time thought sharing
- Multi-LLM Mode with judge-based synthesis
- Agent Comparison Mode for side-by-side output comparison
- Git Worktree Isolation for per-task branch isolation
- Task pinning and graceful wrap-up
- Personality customization (6 styles, 9 personas)
- Goal Mode with auto-retry
- Parallel task queue (1-10 concurrent)
- Remote access (Tailscale, SSH, WebSocket API)

### Planned
- Agent Integrity and Trap Defense runtime across ingestion, memory, approvals, and delegation
- VM sandbox using macOS Virtualization.framework
- Network egress controls with proxy
- Linux desktop support
- Web Browser Mode (`--serve`) — full app accessible from any browser via HTTP/WebSocket

The architecture is extensible. All future features can be added without refactoring core systems.

Ready to run with: `npm install && npm run dev`
