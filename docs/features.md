# Features

## Multi-Channel AI Gateway

14 messaging channels with unified operations. See [Channel Integrations](channels.md) for setup details.

- **WhatsApp**: QR code pairing, self-chat mode, markdown support
- **Telegram**: Bot commands, streaming responses, workspace selection
- **Discord**: Slash commands, DM support, guild integration
- **Slack**: Socket Mode, channel mentions, file uploads
- **Microsoft Teams**: Bot Framework SDK, DM/channel mentions, adaptive cards
- **Google Chat**: Service account auth, spaces/DMs, threaded conversations
- **iMessage**: macOS native integration, pairing codes
- **Signal**: End-to-end encrypted messaging via signal-cli
- **Mattermost**: WebSocket real-time, REST API
- **Matrix**: Federated messaging, room-based, end-to-end encryption ready
- **Twitch**: IRC chat integration, multi-channel
- **LINE**: Messaging API webhooks, 200M+ users in Asia
- **BlueBubbles**: iMessage via Mac server, SMS support
- **Email**: IMAP/SMTP, any email provider, threading

---

## Agent Capabilities

- **Task-Based Workflow**: Multi-step execution with plan-execute-observe loops
- **Live Terminal**: Shell commands run in a real-time terminal view — see output as it happens, stop execution, or provide interactive input (e.g. `y`/`n` prompts)
- **Dynamic Re-Planning**: Agent can revise its plan mid-execution
- **100+ Built-in Skills**: GitHub, Slack, Notion, Spotify, Apple Notes, and more
- **Document Creation**: Excel, Word, PDF, PowerPoint with professional formatting
- **Persistent Memory**: Cross-session context with privacy-aware observation capture
- **Knowledge Graph**: SQLite-backed entity/relationship memory with FTS5 search, graph traversal, and auto-extraction
- **Workspace Kit**: `.cowork/` project kit + markdown indexing with context injection
- **Agent Teams**: Multi-agent collaboration with shared checklists, coordinated runs, and team management UI
- **Collaborative Mode**: Auto-create ephemeral teams where multiple agents work on the same task, sharing thoughts in real-time
- **Multi-LLM Mode**: Send the same task to multiple LLM providers/models simultaneously, with a judge agent synthesizing the best result
- **Agent Comparison Mode**: Compare agent or model outputs side by side
- **Git Worktree Isolation**: Tasks run in isolated git worktrees with automatic branch creation, auto-commit, merge, conflict detection, and cleanup
- **Task Pinning**: Pin important tasks in the sidebar for quick access
- **Wrap-Up Task**: Gracefully wrap up running tasks instead of hard-cancelling
- **Capability Matcher**: Auto-select the best agents for a task
- **Performance Reviews**: Score and review agent-role outcomes with autonomy-level recommendations
- **Vision**: Analyze workspace images via `analyze_image` tool (OpenAI, Anthropic, Gemini, or Bedrock)
- **Image Attachments**: Attach images to tasks and follow-ups for multimodal analysis
- **Image Generation**: Multi-provider support (Gemini, OpenAI gpt-image-1/1.5/DALL-E, Azure OpenAI)
- **Visual Annotation**: Iterative image refinement with the Visual Annotator
- **Context Summarization**: Automatic context compression surfaced in the task timeline
- **Action-First Planning**: Agent prioritizes direct action over excessive pre-planning
- **Voice Calls**: Outbound phone calls via ElevenLabs Agents
- **Think With Me Mode**: Socratic brainstorming mode that helps clarify thinking without executing tools. Activated via toggle or auto-detected from brainstorm/trade-off patterns.
- **Problem Framing Pre-flight**: Complex tasks show a structured problem restatement, assumptions, risks, and approach before execution begins
- **Graceful Uncertainty**: Agent expresses uncertainty honestly and rates confidence on recommendations. Low-confidence messages display with an amber indicator.
- **AI Playbook**: Auto-captures successful patterns (approach, outcome, tools) and lessons from failures with error classification (7 categories: tool failure, wrong approach, missing context, permission denied, timeout, rate limit, user correction). Time-based decay scoring deprioritises stale entries. Proven patterns reinforced on repeated success. Mid-task user corrections automatically detected and captured. Relevant entries injected into system prompts. View in Settings > AI Playbook.

### Per-Task Execution Modes

Each task can be launched with one of four modes:

| Mode | Toggle | Behavior |
|------|--------|----------|
| **Autonomous** | Autonomous ON/OFF | Auto-approves all gated actions (shell commands, file deletions, etc.) so the agent runs without pauses. Disables user input prompts. |
| **Collaborative** | Collab ON/OFF | Auto-creates an ephemeral team of agents that analyze the task from multiple perspectives, then a leader synthesizes the results. Phases: dispatch → think → synthesize → complete. |
| **Multi-LLM** | Multi-LLM ON/OFF | Sends the same task to multiple LLM providers/models in parallel. A designated judge model synthesizes the best result. Requires 2+ providers configured. |
| **Think With Me** | Think toggle | Socratic brainstorming mode — agent asks follow-up questions and explores trade-offs without executing tools. Read-only tools only. |

These modes are mutually exclusive — only one can be active per task. All four are toggled in the task creation UI.

> **Note:** Autonomous mode shows a confirmation dialog before enabling, since it bypasses all approval prompts.

---

## Voice Mode

Talk to your AI assistant with voice input and audio responses.

| Feature | Description |
|---------|-------------|
| **Text-to-Speech** | ElevenLabs (premium), OpenAI TTS, or local Web Speech API |
| **Speech-to-Text** | OpenAI Whisper for accurate transcription |
| **Multiple Voices** | ElevenLabs voices or OpenAI voices (alloy, echo, fable, onyx, nova, shimmer) |
| **Outbound Phone Calls** | Initiate calls via ElevenLabs Agents |

| Provider | TTS | STT | Cost |
|----------|-----|-----|------|
| **ElevenLabs** | Yes (premium) | — | Pay-per-character |
| **OpenAI** | Yes | Yes (Whisper) | Pay-per-token |
| **Local** | Yes (Web Speech) | Coming soon | Free |

Configure in **Settings** > **Voice**.

---

## Persistent Memory System

| Feature | Description |
|---------|-------------|
| **Auto-Capture** | Observations, decisions, and errors captured during task execution |
| **Privacy Protection** | Auto-detects sensitive patterns (API keys, passwords, tokens) |
| **FTS5 Search** | Full-text search with relevance ranking |
| **LLM Compression** | Summarizes observations for ~10x token efficiency |
| **Progressive Retrieval** | 3-layer approach: snippets → timeline → full details |
| **Per-Workspace Settings** | Enable/disable, privacy modes, retention policies |

**Privacy Modes:** Normal (auto-detect sensitive data), Strict (all private), Disabled (no capture).

Configure in **Settings** > **Memory**.

---

## Self-Improving Agent

Multi-layered learning system that improves agent behaviour across sessions. No external dependencies — all learning runs locally.

| Layer | Service | What It Learns |
|-------|---------|----------------|
| **Task Patterns** | PlaybookService | Successful approaches, failure categories, error recovery strategies |
| **Core Memory** | MemoryService | Observations, decisions, insights with hybrid semantic + BM25 search |
| **User Profile** | UserProfileService | Name, preferences, location, goals, constraints |
| **Relationship** | RelationshipMemoryService | 5-layer context: identity, preferences, context, history, commitments |
| **Feedback** | FeedbackService | Rejection patterns, preference corrections, workspace-local MISTAKES.md |

**Key mechanisms:**
- **Error classification**: 7 categories for targeted recovery strategies
- **Confidence decay**: older playbook entries receive lower relevance scores (30d: 0.8x, 90d: 0.5x)
- **Reinforcement**: successful patterns are boosted via reinforcement memories
- **Mid-task correction detection**: regex-based detection of user corrections during execution
- **`/learn` skill**: manually teach the agent insights, corrections, preferences, or rules

See [Self-Improving Agent](self-improving-agent.md) for the full architecture guide.

---

## Knowledge Graph

SQLite-backed structured entity and relationship memory with full-text search and graph traversal.

| Feature | Description |
|---------|-------------|
| **10 built-in entity types** | person, organization, project, technology, concept, file, service, api_endpoint, database_table, environment |
| **15 built-in edge types** | uses, depends_on, part_of, created_by, maintained_by, deployed_to, and more |
| **FTS5 search** | Full-text search with BM25 ranking over entity names and descriptions |
| **Graph traversal** | Iterative BFS up to 3 hops with edge type filtering |
| **Observations** | Append-only timestamped fact log per entity |
| **Auto-extraction** | Regex-based entity extraction from completed task results |
| **Confidence decay** | Auto-extracted entities decay over time (floor: 0.3) |
| **9 agent tools** | kg_create_entity, kg_update_entity, kg_delete_entity, kg_create_edge, kg_delete_edge, kg_add_observation, kg_search, kg_get_neighbors, kg_get_subgraph |
| **Context injection** | Relevant entities auto-injected into task system prompts |

See [Knowledge Graph](knowledge-graph.md) for the full architecture guide.

---

## Workspace Kit (.cowork)

Initialize and maintain a `.cowork/` directory inside each workspace for durable context, project scaffolding, and prompt injection.

- Kit initialization with standard `.cowork/` structure and templates
- Project contexts with `ACCESS.md`, `CONTEXT.md`, and `research/`
- Markdown indexing for durable human-edited context
- Context injection into agent prompts automatically
- Global and per-workspace memory settings

Configure in **Settings** > **Memory Hub**.

---

## Role Profile Files

Define per-role personality and operating guidelines in `.cowork/agents/<role-id>/`:

| File | Purpose |
|---|---|
| `SOUL.md` | Role personality, behavior style, execution philosophy |
| `IDENTITY.md` | Role-specific identity and constraints |
| `RULES.md` | Operational rules, safety boundaries, communication defaults |

---

## Agent Teams

| Feature | Description |
|---------|-------------|
| **Team Management** | Create and manage teams with multiple agent members |
| **Persistent Teams** | Mark teams as persistent so they survive across sessions with a default workspace |
| **Shared Checklists** | Agents share checklist items for coordinated task execution |
| **Run Tracking** | Track team runs with status, progress, and history |
| **Collaborative Mode** | Ephemeral teams with real-time thought sharing |
| **Multi-LLM Mode** | Dispatch same task to multiple providers with judge-based synthesis |
| **Collaborative Thoughts** | Real-time thought panel shows agent reasoning as it happens |

Configure in **Mission Control** > **Teams**.

---

## Mission Control

Centralized agent orchestration and monitoring dashboard. Access from **Settings** > **Mission Control**.

| Panel | Purpose |
|-------|---------|
| **Agents** | Active agents list with status dots (working/idle/offline), heartbeat info, and manual wake controls |
| **Mission Queue** | 5-column Kanban board (Inbox → Assigned → In Progress → Review → Done) with drag-and-drop |
| **Feed & Details** | Real-time activity feed with event type and agent filters, plus task detail view with comments and mentions |

**Header controls:** Agent Teams management, Performance Reviews, Standup Report generation, and workspace selector with live stats (active agents, queued tasks, pending mentions).

All panels update in real-time via event subscriptions — no manual refresh needed.

See [Mission Control](mission-control.md) for the full guide.

---

## Build Mode

Dedicated "idea → working prototype" workflow powered by Live Canvas with four phases:

| Phase | Description |
|-------|-------------|
| **Concept** | Restate the idea, identify core requirements, choose tech stack |
| **Plan** | Break down into components, define file structure, outline implementation |
| **Scaffold** | Generate working code, push to canvas, create checkpoint |
| **Iterate** | Refine based on feedback, add features, polish UI |

Each phase creates a named checkpoint. You can revert to any phase, diff between phases, and view the full phase timeline. Build Mode is available as a built-in skill (`build-mode`).

See [Live Canvas](live-canvas.md) for the full guide.

---

## Usage Insights

Dashboard showing task activity, cost trends, and productivity patterns.

| Metric | Description |
|--------|-------------|
| **Task Metrics** | Created, completed, failed, cancelled counts with average completion time |
| **Cost & Tokens** | Total cost, input/output tokens, cost breakdown by model |
| **Activity by Day** | Tasks per day-of-week with peak day indicator |
| **Activity by Hour** | Hourly task histogram with peak hour indicator |
| **Top Skills** | Most-used skills ranked by usage count |

Supports 7, 14, and 30-day period selection. Access from **Settings** > **Usage Insights**.

---

## Daily Briefing

Proactive morning briefing combining:

- **Task summary**: Completed in last 24 hours, currently in progress, scheduled for today
- **Recent highlights**: Key insights and decisions from memory
- **Suggested priorities**: Based on user profile goals, or sensible defaults

Configurable as a scheduled task in **Settings** > **Scheduled Tasks** with time picker and channel delivery.

---

## Adaptive Complexity

Three-tier UI density controlling which features and settings are visible:

| Tier | Description |
|------|-------------|
| **Focused** | Simplified view — hides Connected Tools, Remote Access, Extensions, Infrastructure. Shows only core settings. |
| **Standard** | Default view — all settings visible (default) |
| **Power** | Full power-user view with all settings and advanced options |

Configure in **Settings** > **Appearance**.

---

## Configurable Guardrails

| Guardrail | Default | Range |
|-----------|---------|-------|
| **Token Budget** | 100,000 | 1K - 10M |
| **Cost Budget** | $1.00 (disabled) | $0.01 - $100 |
| **Iteration Limit** | 50 | 5 - 500 |
| **Dangerous Command Blocking** | Enabled | On/Off + custom |
| **Auto-Approve Trusted Commands** | Disabled | On/Off + patterns |
| **File Size Limit** | 50 MB | 1 - 500 MB |
| **Domain Allowlist** | Disabled | On/Off + domains |

---

## Code Tools

Claude Code-style tools for efficient code navigation and editing:

| Tool | Description |
|------|-------------|
| **glob** | Fast pattern-based file search (e.g., `**/*.ts`) |
| **grep** | Regex content search across files with context lines |
| **edit_file** | Surgical file editing with find-and-replace |
| **git_commit** | Commit changes in the workspace (or worktree) |
| **git_diff** | View staged/unstaged changes |
| **git_branch** | List, create, or switch branches |

---

## Live Canvas

Agent-driven visual workspace for interactive content creation and data visualization.

- **Interactive Preview**: Full browser interaction within the canvas
- **Snapshot Mode**: Auto-refresh preview every 2 seconds
- **Canvas Tools**: `canvas_open_session`, `canvas_set_state`, `canvas_eval`, `canvas_close_session`
- **Named Checkpoints**: Save, restore, diff, and label canvas states for easy navigation
- **Build Mode**: Phased idea-to-prototype workflow (Concept → Plan → Scaffold → Iterate) with per-phase checkpoints
- **Visual Annotation**: `visual_open_annotator` and `visual_update_annotator` for iterative image refinement
- **Export**: HTML, open in browser, or reveal in Finder
- **Snapshot History**: Browse previous canvas states
- **Keyboard Shortcuts**: Toolbar controls for common actions

See [Live Canvas](live-canvas.md) for the full guide.

---

## Browser Automation

Full Playwright integration:

- Navigate, screenshot, save as PDF
- Click, fill forms, type text, press keys
- Extract page content, links, and form data
- Supports `chromium` (default), `chrome` (system), `brave`

---

## Web Scraping (Scrapling)

Advanced web scraping powered by [Scrapling](https://github.com/D4Vinci/Scrapling) — anti-bot bypass, stealth browsing, adaptive element tracking, and structured data extraction.

| Feature | Description |
|---------|-------------|
| **Anti-Bot Bypass** | TLS fingerprinting impersonates real browsers at the network level |
| **Stealth Mode** | Cloudflare Turnstile bypass, stealth headers, browser fingerprint masking |
| **Playwright Fetcher** | Full browser rendering for JavaScript-heavy sites |
| **Structured Extraction** | Auto-detect and extract tables, lists, headings, and metadata |
| **Batch Scraping** | Scrape up to 20 URLs in a single operation |
| **Persistent Sessions** | Multi-step workflows with login → navigate → extract |
| **Proxy Support** | Route requests through HTTP/HTTPS/SOCKS5 proxies |
| **Rate Limiting** | Configurable requests-per-minute throttling |

### Agent Tools

| Tool | Description |
|------|-------------|
| `scrape_page` | Scrape a single URL with fetcher selection, CSS selectors, link/image/table extraction |
| `scrape_multiple` | Batch scrape multiple URLs with shared config |
| `scrape_extract` | Extract structured data (tables, lists, headings, meta, or custom selectors) |
| `scrape_session` | Multi-step session with persistent browser state |
| `scraping_status` | Check Scrapling installation and version |

### Fetcher Modes

| Mode | Best For | Speed |
|------|----------|-------|
| **Default** | Most sites — fast HTTP with TLS fingerprinting | Fast |
| **Stealth** | Cloudflare-protected sites, anti-bot detection | Medium |
| **Playwright** | JavaScript-rendered SPAs, dynamic content | Slow |

### Skills

Five scraping-specific skills are included: **Web Scraper** (general-purpose), **Price Tracker** (e-commerce), **Site Mapper** (crawl + structure), **Lead Scraper** (contact extraction), **Content Monitor** (change detection + scheduling).

### Setup

```bash
pip install scrapling
scrapling install   # downloads stealth browsers
```

Configure in **Settings** > **Web Scraping**. Disabled by default — enable to make scraping tools available to agents.

---

## System Tools

- Screenshots (full screen or specific windows)
- Clipboard read/write
- Open applications, URLs, and file paths
- AppleScript automation
- **Apple Calendar**: Create, update, delete events
- **Apple Reminders**: Create, complete, update, list reminders

---

## Remote Access

- **Tailscale Serve**: Expose to your private tailnet
- **Tailscale Funnel**: Public HTTPS endpoint
- **SSH Tunnels**: Standard SSH port forwarding
- **WebSocket API**: Programmatic task management with LAN access

See [Remote Access](remote-access.md) for details.

---

## MCP (Model Context Protocol)

- **MCP Client**: Connect to external MCP servers
- **MCP Host**: Expose CoWork's tools as an MCP server
- **MCP Registry**: Browse and install servers from a catalog

---

## Enterprise MCP Connectors

Pre-built connectors for enterprise integrations. Install from **Settings > MCP Servers > Browse Registry**.

| Connector | Type | Tools |
|-----------|------|-------|
| **Salesforce** | CRM | health, list_objects, describe, get, search, create, update |
| **Jira** | Issue Tracking | health, list_projects, get, search, create, update |
| **HubSpot** | CRM | health, list, get, search, create, update contacts |
| **Zendesk** | Support | health, list, get, search, create, update tickets |
| **ServiceNow** | ITSM | health, list, get, search, create, update incidents |
| **Linear** | Product | health, list, get, search, create, update issues |
| **Asana** | Work Management | health, list, get, search, create, update tasks |
| **Okta** | Identity | health, list, get, search, create, update users |
| **Resend** | Email | health, send, list/create/delete webhooks |

See [Enterprise Connectors](enterprise-connectors.md) for the full contract.

---

## Cloud Integrations

| Service | Tool | Actions |
|---------|------|---------|
| **Notion** | `notion_action` | Search, read, create, update, query data sources |
| **Box** | `box_action` | Search, read, upload, manage files |
| **OneDrive** | `onedrive_action` | Search, read, upload, manage files |
| **Google Workspace** | `gmail_action`, `google_drive_action`, `google_calendar_action` | Gmail, Drive, Calendar with shared OAuth |
| **Dropbox** | `dropbox_action` | List, search, upload, manage files |
| **SharePoint** | `sharepoint_action` | Search sites, manage drive items |

Configure in **Settings** > **Integrations**.

---

## Infrastructure

Built-in cloud infrastructure tools registered as native agent tools — no MCP subprocess, no external dependency at runtime. The agent can provision cloud resources, manage domains, and make payments directly.

### How It Works

Infrastructure tools are registered in the Tool Registry alongside file, shell, and browser tools. When the agent needs cloud resources, it calls these tools directly — no subprocess overhead, no external server. All credentials are stored encrypted in the OS keychain via SecureSettingsRepository.

### Benefits

- **Zero latency overhead**: Tools execute in-process, no MCP subprocess or network hop
- **Unified approval flow**: Payment and registration operations use the same approval dialogs as shell commands and file deletions
- **Encrypted credentials**: API keys and wallet private keys stored via OS keychain (macOS Keychain, Windows DPAPI, Linux libsecret)
- **Provider-based architecture**: Swap E2B for another sandbox provider, or Namecheap for Cloudflare — each capability is a pluggable provider class

### Cloud Sandboxes (E2B)

Spin up isolated Linux VMs for running code, deploying services, or testing in a clean environment.

| Tool | Description |
|------|-------------|
| `cloud_sandbox_create` | Create a new sandbox (name, timeout, env vars) |
| `cloud_sandbox_exec` | Run a shell command in a sandbox |
| `cloud_sandbox_write_file` | Write a file into a sandbox |
| `cloud_sandbox_read_file` | Read a file from a sandbox |
| `cloud_sandbox_list` | List all active sandboxes |
| `cloud_sandbox_delete` | Delete a sandbox and free resources |
| `cloud_sandbox_url` | Get the public URL for an exposed port |

Sandboxes auto-expire per E2B tier (5 min default, configurable up to 60 min on free tier). E2B provides $100 free credits with no credit card required.

### Domain Registration (Namecheap)

Search, register, and manage domains and DNS records.

| Tool | Description |
|------|-------------|
| `domain_search` | Search available domains across TLDs (.com, .io, .ai, .dev, etc.) |
| `domain_register` | Register a domain (requires user approval) |
| `domain_list` | List all registered domains |
| `domain_dns_list` | List DNS records for a domain |
| `domain_dns_add` | Add a DNS record (A, AAAA, CNAME, MX, TXT, NS) |
| `domain_dns_delete` | Delete a DNS record |

Domain registration requires explicit user approval before any purchase is made.

### Wallet & Payments

Built-in USDC wallet on Base network for infrastructure payments.

| Tool | Description |
|------|-------------|
| `wallet_info` | Get wallet address, network, and USDC balance |
| `wallet_balance` | Get current USDC balance |
| `x402_check` | Check if a URL requires x402 payment |
| `x402_fetch` | Fetch a URL with automatic x402 payment (requires approval) |

The wallet is auto-generated on first setup, with the private key encrypted in the OS keychain. The wallet address and balance are displayed in the sidebar. x402 is an HTTP-native payment protocol where the agent signs EIP-712 typed data to authorize USDC payments on Base — useful for paying for API access, premium content, or compute resources.

### Status & Configuration

| Tool | Description |
|------|-------------|
| `infra_status` | Get overall status: provider connections, active sandboxes, wallet state |

Configure in **Settings** > **Infrastructure**. The settings UI shows:
- Provider connection status (E2B, Namecheap, Wallet)
- API key configuration for each provider
- Wallet address with copy button and balance display
- Tool category toggles (enable/disable sandbox, domain, or payment tools independently)

---

## Personality System

Customize agent behavior via Settings or conversation:

- **Personalities**: Professional, Friendly, Concise, Creative, Technical, Casual
- **Personas**: Jarvis, Friday, HAL, Computer, Alfred, Intern, Sensei, Pirate, Noir
- **Response Style**: Emoji usage, response length, code comments, explanation depth
- **Quirks**: Catchphrases, sign-offs, analogy domains
- **Relationship**: Agent remembers your name and tracks interactions

---

## Visual Theme System

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

---

## Scheduled Tasks (Cron Jobs)

Schedule recurring tasks with cron expressions and optional channel delivery.

- Standard cron syntax with workspace binding
- Channel delivery to any of the 14 channels
- Conditional delivery (`deliverOnlyIfResult`)
- Template variables: `{{today}}`, `{{tomorrow}}`, `{{week_end}}`, `{{now}}`
- Chat context variables: `{{chat_messages}}`, `{{chat_since}}`, etc.
- Run history with status and duration

| Schedule | Expression |
|----------|------------|
| Every hour | `0 * * * *` |
| Daily at 9am | `0 9 * * *` |
| Weekdays at 6pm | `0 18 * * 1-5` |
| Weekly on Sunday | `0 0 * * 0` |

---

## Parallel Task Queue

Run multiple tasks concurrently with configurable limits (1-10, default: 3). Tasks beyond the limit are queued in FIFO order with auto-start and persistence across restarts.

---

## Built-in Skills (100+)

| Category | Skills |
|----------|--------|
| **Developer** | GitHub, GitLab, Linear, Jira, Sentry, Code Reviewer, Multi-PR Review, Developer Growth Analysis |
| **Communication** | Slack, Discord, Telegram, Email, Voice Calls |
| **Productivity** | Notion, Obsidian, Todoist, Apple Notes/Reminders/Calendar, PRD Generator, Memory Kit |
| **Media** | Spotify, YouTube, SoundCloud |
| **Image** | Image Generation (Gemini/OpenAI/Azure), Agentic Image Loop |
| **Documents** | Excel, Word, PDF, PowerPoint |
| **Frontend** | Frontend Design, React Native Best Practices |
| **Data** | Supabase SDK Patterns |
| **Search** | Local Web Search (SearXNG), Bird |
| **Finance** | Crypto Trading, Crypto Execution, Trading Foundation |
| **Marketing** | Email Marketing Bible |
| **Use Cases** | Booking Options, Draft Reply, Family Digest, Household Capture, Newsletter Digest, Transaction Scan |

---

## Web Browser Mode (Planned)

Access CoWork OS from any web browser — no Electron desktop app required.

| Aspect | Details |
|--------|---------|
| **How** | `cowork-os --serve --port 3000` starts a Node.js server exposing the full React UI over HTTP/WebSocket |
| **Approach** | Reuses all existing main-process logic (agent, tools, database, gateways). IPC calls are mapped to HTTP/WebSocket endpoints |
| **Desktop features** | System tray, desktop screenshots, and AppleScript degrade gracefully. File dialogs use browser-native pickers |
| **Security** | Challenge-response authentication (extends existing control plane auth). HTTPS recommended for production |
| **Existing foundation** | Control plane already serves a web dashboard at `http://127.0.0.1:18789/`. Web mode extends this to the full React UI |

See [Architecture: Web Browser Mode](architecture.md#web-browser-mode-planned--serve) for the implementation plan.

---

## WebSocket Control Plane

Programmatic API for external automation and mobile companion apps.

- Challenge-response token authentication
- Full task API (create, list, get, cancel)
- Real-time event streaming
- Approval API for remote approval management
- Channel management API
- Web dashboard at `http://127.0.0.1:18789/`

| Mode | Binding | Use Case |
|------|---------|----------|
| **Local Only** | `127.0.0.1:18789` | Desktop automation |
| **LAN Access** | `0.0.0.0:18789` | Mobile companions |

Configure in **Settings** > **Control Plane**.
