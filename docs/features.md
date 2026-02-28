# Features

## Multi-Channel AI Gateway

15 messaging channels with unified operations. See [Channel Integrations](channels.md) for setup details.

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
- **X (Twitter)**: Mention-trigger task ingress (`do:` prefix by default) with allowlist controls and idempotent session keys ([guide](x-mention-triggers.md))

---

## Agent Capabilities

- **Task-Based Workflow**: Multi-step execution with plan-execute-observe loops
- **Live Terminal**: Shell commands run in a real-time terminal view — see output as it happens, stop execution, or provide interactive input (e.g. `y`/`n` prompts)
- **Dynamic Re-Planning**: Agent can revise its plan mid-execution
- **139 Built-in Skills**: GitHub, Slack, Notion, Spotify, Apple Notes, Unity, Unreal, Terraform, Kubernetes, financial analysis, and more
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
- **Completion Output Confidence UX**: When tasks finish with file outputs, users get high-signal completion toasts with direct actions (`Open file`, `Show in Finder`, `View in Files`), automatic right-panel focus for the active task, and unseen-output badges when reviewing another task/view.
- **Artifact-First Output Visibility**: Artifact-only tasks are treated the same as file-created outputs across progress, timeline, and Files panel surfaces.
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

### Reliability Flywheel

Reliability is built as a continuous loop: capture failures -> replay deterministically -> gate risky completions -> harden nightly/release workflows.

| Reliability Capability | What It Does |
|------------------------|--------------|
| **Eval Corpus (local)** | Converts failed/partial tasks into replayable eval cases stored in local SQLite |
| **Deterministic Replay** | Re-runs eval suites to catch regressions before they reappear in production usage |
| **Risk-Based Review Gate** | Scores task risk (`low`/`medium`/`high`) and escalates review/verification only when justified |
| **Policy Modes** | `off`, `balanced`, and `strict` review policies for domain-appropriate guard strength |
| **Skill/Prompt Hardening** | Uses modular prompt sections, explicit token budgets, and skill shortlist routing to reduce drift and context overload |
| **PR Reliability Contract** | Enforces “production failure fix must add/update eval case” in CI |
| **Nightly Hardening** | Runs eval + battery loops nightly, produces grouped and machine-readable artifacts |
| **Release Gate** | Applies hardening checks before release with a date-based stability-window promotion |
| **Local-Only Data Policy** | Keeps reliability artifacts local; no required telemetry upload path |

See [Reliability Flywheel](reliability-flywheel.md) for architecture, schema, scripts, IPC endpoints, CI workflows, and operational commands.

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

## Digital Twin Personas

Pre-built AI agent templates that create role-specific digital twins for team members. Each twin absorbs cognitively draining work so the human can stay in deep focus.

- **10 built-in templates**: Software Engineer, Hardware Engineer, Engineering Manager, QA/Test Engineer, Technical Director, VP of Engineering, Product Manager, DevOps/SRE, Technical Writer, Data Scientist
- **Proactive heartbeat tasks**: PR triage, status digests, dependency scans, test coverage checks — run automatically on a configurable interval
- **10 cognitive offload categories**: context-switching, status-reporting, information-triage, decision-preparation, documentation, review-preparation, dependency-tracking, compliance-checks, knowledge-curation, routine-automation
- **4 bundled skills**: `twin-status-report`, `twin-pr-triage`, `twin-meeting-prep`, `twin-decision-prep`
- **One-click activation**: Browse gallery, customize name and heartbeat interval, toggle proactive tasks, create
- **Enterprise scaling**: Activate one twin per team member across the organization

Access from **Mission Control** > **Add Digital Twin**. See [Digital Twins](digital-twins.md) for full documentation.

---

## Plugin Packs & Customize

Role-specific bundles that group skills, agent roles, connectors, and slash commands into installable packs. Each pack targets a job function and can optionally link to a Digital Twin Persona for proactive background work.

- **17 bundled packs**: Engineering, Engineering Management, Product Management, DevOps, Mobile Development, Game Development, Data Analysis, QA & Testing, Sales CRM, Customer Support, Content & Marketing, Technical Writing, Equity Research, Financial Analysis, Investment Banking, Private Equity, Wealth Management
- **55+ built-in skills**: Code review prep, sprint health, feature triage, incident response, prospect research, DCF modeling, LBO analysis, and more
- **Unified Customize panel**: Browse, enable/disable packs, view skills/commands/agents, click "Try asking" prompts
- **Search & filter**: Real-time sidebar search across pack names, descriptions, categories, and skill names
- **Per-skill toggles**: Enable or disable individual skills within a pack without toggling the entire pack
- **Persistent state**: Pack and skill toggle states survive app restarts (stored in `pack-states.json`)
- **Digital Twin integration**: 7 packs link to persona templates for proactive heartbeat-driven automation
- **Recommended connectors**: Packs display clickable connector chips that navigate to connector settings
- **Update detection**: Background check against the remote registry with orange dot indicators on packs with newer versions
- **"Try asking" in chat**: Empty chat state shows randomized prompt suggestions from enabled packs for one-click task creation
- **Plugin Store**: In-app marketplace for discovering, installing, and creating packs (from Git repos, URLs, or scaffold)
- **Remote Pack Registry**: Community-contributed packs catalog with search and category filtering
- **Extensible**: Create custom packs with JSON manifests in `~/.cowork/extensions/`
- **Active Context sidebar**: Always-visible right-panel section showing connected MCP connectors with branded Lucide icons (36 known services mapped) and enabled skills, with scrollable sub-sections and 30-second auto-refresh
- **Skill conflict detection**: Warns when multiple packs register the same skill ID, preventing silent overwrites
- **Admin Policies**: Organization-level controls for allowed/blocked/required packs, installation permissions, and agent limits

Access from **Settings** > **Customize**. See [Plugin Packs](plugin-packs.md) for full documentation.

---

## Admin Policies (Enterprise)

Organization-level policy controls for managing plugin packs, connectors, and agents across teams.

| Policy Area | Capabilities |
|-------------|-------------|
| **Pack policies** | Allow, block, or require specific packs by ID. Whitelist mode restricts to approved packs only. |
| **Connector policies** | Block specific MCP connectors |
| **Agent policies** | Set max heartbeat frequency (min 60s) and max concurrent agents per workspace |
| **Installation controls** | Toggle custom pack creation, Git-based install, URL-based install |
| **Organization directory** | Distribute admin-managed packs from a shared directory to all users |

**Policy enforcement:**
- Blocked packs appear disabled in the Customize panel and cannot be enabled
- Required packs cannot be disabled by users
- Installation policies block scaffold, Git install, and URL install at the handler level
- Organization packs load from a configurable shared directory

Access from **Settings** > **Admin Policies** (Power density mode). See [Admin Policies](admin-policies.md) for full documentation.

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
| **Agent-Initiated Save** | Agents can explicitly save insights, decisions, observations, and errors via `memory_save` tool for cross-session recall |
| **Privacy Protection** | Auto-detects sensitive patterns (API keys, passwords, tokens) |
| **Unified Search** | `search_memories` searches both the memory DB and `.cowork/` workspace markdown files with hybrid semantic + BM25 ranking |
| **LLM Compression** | Summarizes observations for ~10x token efficiency |
| **Progressive Retrieval** | 3-layer approach: snippets → timeline → full details |
| **ChatGPT History Import** | Import your full ChatGPT conversation history — eliminates cold start. All data stored locally and encrypted. [Details below](#chatgpt-history-import) |
| **Per-Workspace Settings** | Enable/disable, privacy modes, retention policies |

**Privacy Modes:** Normal (auto-detect sensitive data), Strict (all private), Disabled (no capture).

Configure in **Settings** > **Memory**.

---

## ChatGPT History Import

Import your full ChatGPT conversation history into CoWork OS's memory system. Instead of starting from scratch, the agent immediately understands your preferences, past projects, communication style, and context from hundreds or thousands of previous conversations.

### How It Works

1. **Export from ChatGPT**: Go to [ChatGPT Settings > Data Controls > Export Data](https://chat.openai.com/#settings/DataControls). OpenAI emails you a `.zip` file containing `conversations.json`.
2. **Import in CoWork OS**: Go to **Settings > Memory > Import ChatGPT History** and select the exported `.zip` or `conversations.json` file.
3. **Processing**: Conversations are parsed, deduplicated, and stored as memory entries with full-text search indexing. User messages are captured as context; assistant responses are summarized for token efficiency.

### What Gets Imported

| Data | How It's Used |
|------|---------------|
| **Your messages** | Stored as observations — reveals your interests, projects, preferences, and communication style |
| **Assistant responses** | Summarized and stored as insights — captures decisions, recommendations, and solutions you received |
| **Conversation titles** | Indexed for semantic search — helps match relevant past context to new tasks |
| **Timestamps** | Preserved for time-based relevance ranking — recent conversations weighted higher |

### Security & Privacy

- **Stored locally only** — All imported data is written to the local SQLite database on your Mac. Nothing is uploaded, synced, or sent anywhere.
- **Encrypted at rest** — The database is protected by the same AES-256 encryption and OS keychain integration used for all CoWork OS data.
- **Privacy filtering** — The same auto-detection that filters API keys, passwords, and tokens from regular memories applies to imported history.
- **No provider access** — Imported memories are injected into prompts locally. Your ChatGPT history is never sent back to OpenAI or any other provider — only the relevant snippets are included in task context.
- **Deletable** — You can clear all imported memories at any time from Settings > Memory.

### Why This Matters

Most AI assistants start with zero context about you. Every new tool means re-explaining your preferences, projects, and constraints. ChatGPT history import eliminates this cold-start problem — CoWork OS learns from your existing AI conversations so it can be useful from the first task.

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
- Markdown indexing for durable human-edited context — searchable via `search_memories`
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

**Dispatched Agents Progress:** When you mention agents in a task prompt (e.g. `@Security Analyst review this codebase`), the parent task's main window shows a live progress panel with:
- Agent chips showing each dispatched agent's status (working/completed/failed)
- Phase indicator (Dispatched → Working → Complete)
- Real-time event stream from all child agent tasks (plans, steps, results)
- Click any agent chip to jump to that agent's full task view

Cancelling a parent task automatically cascades to all dispatched child tasks.

See [Mission Control](mission-control.md) for the full guide.

---

## Digital Twins (Persona Templates)

Create role-specific AI digital twins from pre-built persona templates. Each twin absorbs cognitively draining tasks so the human stays in flow. Accessible via the **"Add Digital Twin"** button in Mission Control's agents panel.

### Templates (10 roles, 5 categories)

| Category | Templates |
|----------|-----------|
| **Engineering** | Software Engineer, Hardware Engineer, QA/Test Engineer, DevOps/SRE, Technical Writer |
| **Management** | Engineering Manager, Technical Director, VP Engineering |
| **Product** | Product Manager |
| **Data & Analytics** | Data Scientist / Analyst |

### What Each Template Includes

| Component | Description |
|-----------|-------------|
| **System Prompt** | Role-tailored persona with behavior guidelines |
| **Capabilities** | Skill tags (code, review, test, analyze, document, etc.) |
| **Proactive Tasks** | Heartbeat-triggered background tasks (PR triage, dependency checks, sprint health, etc.) |
| **Cognitive Offload** | Categorized by mental burden relieved: context switching, status reporting, review prep, decision prep, documentation, dependency tracking |
| **Recommended Skills** | Pre-mapped skills with required/optional flags |
| **Autonomy Level** | `specialist` (IC roles) or `lead` (management roles) |

### Activation Flow

1. Click **"Add Digital Twin"** in Mission Control agents panel
2. Browse the **template gallery** — filter by category or search by name/tags
3. Click a template card to open the **activation dialog**
4. Customize: twin name, heartbeat interval (5min–4hr), toggle proactive tasks
5. Click **"Create Digital Twin"** — creates a new AgentRole with background heartbeat tasks

The twin appears in the agents panel and begins running proactive tasks on the configured heartbeat interval.

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

Dashboard showing task activity, cost trends, agent efficiency, and productivity patterns. Access from **Settings** > **Usage Insights**.

### Overview

The panel opens with a **hero stats row** showing four key metrics at a glance:

| Stat | Description |
|------|-------------|
| **Completed** | Total tasks completed in the selected period |
| **Success Rate** | Percentage of completed tasks out of total, with a color-coded progress bar (green ≥ 70%, amber ≥ 40%, red < 40%) |
| **Failed** | Total failed tasks |
| **Avg Time** | Average completion time across completed tasks |

Below the hero row, detailed sections are arranged in a **two-column grid** for information density.

### Workspace Filtering

The workspace dropdown at the top lets you filter insights to a single workspace or view **All Workspaces** (the default). "All Workspaces" aggregates metrics across every workspace, giving you a global view of your agent usage.

### Sections

| Section | Description |
|---------|-------------|
| **Cost & Tokens** | Total cost, input/output token counts, and cost breakdown by model |
| **Agent Efficiency (AWU)** | Agentic Work Unit metrics — see below |
| **Activity by Day** | Tasks per day-of-week with peak day indicator |
| **Activity by Hour** | Hourly task histogram with peak hour indicator |
| **Top Skills** | Most-used skills ranked by usage count |
| **Skill Usage by Pack** | Skills grouped by their parent plugin pack with aggregated usage counts and mini bar charts |

### Agentic Work Units (AWU)

Inspired by [Salesforce's AWU concept](https://www.salesforce.com/agentforce/agentic-work-unit/), an **Agentic Work Unit** represents one successfully completed unit of agent work.

**Definition:** 1 AWU = 1 task with `status = 'completed'` AND `terminal_status` of `ok` or `partial_success`.

The AWU section shows:

| Metric | Description |
|--------|-------------|
| **AWU Count** | Number of completed work units in the period |
| **Tokens per AWU** | Total tokens consumed ÷ AWU count (lower is more efficient) |
| **Cost per AWU** | Total cost ÷ AWU count (lower is cheaper) |
| **AWUs per Dollar** | AWU count ÷ total cost (higher is better ROI) |
| **Efficiency Trend** | Percentage change in tokens/AWU and cost/AWU vs the previous period. A downward arrow (green) means improvement; upward (red) means regression |

The trend comparison uses the same period length — e.g., if you're viewing a 7-day window, it compares against the prior 7 days. The AWU section is hidden when no tasks were completed in the period.

### Period Selection

Supports **7-day**, **14-day**, and **30-day** windows. Per-pack analytics cross-reference skill usage with plugin pack membership, showing which packs drive the most value.

---

## Daily Briefing

Proactive morning briefing combining:

- **Task summary**: Completed in last 24 hours, currently in progress, scheduled for today
- **Recent highlights**: Key insights and decisions from memory
- **Suggested priorities**: Based on user profile goals, or sensible defaults

Configurable as a scheduled task in **Settings** > **Scheduled Tasks** with time picker and channel delivery.

---

## Citation Engine

Automatic source attribution for web research. When agents use `web_search` or `web_fetch`, the Citation Engine tracks and deduplicates all referenced URLs, assigning sequential citation indices.

| Feature | Description |
|---------|-------------|
| **Auto-tracking** | Intercepts results from `web_search` and `web_fetch` tools |
| **Deduplication** | Same URL referenced multiple times gets a single [N] index |
| **System prompt injection** | Formatted citation list injected into LLM context so the agent can reference sources |
| **Citation panel** | UI panel showing all sources with URL, title, domain, snippet, and access timestamp |

Citations appear inline in agent responses as `[1]`, `[2]`, etc. and link to the source in the Citation Panel.

---

## Scratchpad Tools

Session-scoped note-taking system for agents during long-running tasks.

| Tool | Description |
|------|-------------|
| `scratchpad_write` | Write or update notes with key-value pairs (max 100-char keys, 10,000-char values) |
| `scratchpad_read` | Retrieve all notes or a specific note by key |

Notes persist to `.cowork/scratchpad-{taskId}.json` for crash recovery. The scratchpad is ephemeral per task — useful for agents to track intermediate findings, partial results, and working state during complex multi-step tasks.

---

## Workflow Pipeline & Deep Work Mode

### Workflow Pipeline

Multi-phase task execution for complex workflows. The Workflow Decomposer detects multi-step prompts (using connectives like "then", "after that", "next", "finally") and splits them into sequential phases.

| Feature | Description |
|---------|-------------|
| **Auto-detection** | Regex-based decomposition of multi-phase prompts |
| **5 phase types** | research, create, deliver, analyze, general |
| **Sequential execution** | Each phase creates a child task; output pipes into the next phase |
| **LLM fallback** | Complex prompts that resist regex decomposition use LLM-powered splitting |
| **Pipeline events** | `pipeline_started`, `phase_started`, `phase_completed`, `pipeline_completed` |

### Deep Work Mode

Extended execution mode for complex tasks that need sustained focus:

- **Extended timeouts** — Deep work tasks get longer execution budgets
- **Progress journaling** — Agent records progress notes during execution, visible in the task timeline
- **Memory compression pause** — Memory service pauses background compression during active deep work to avoid context disruption

---

## Document Generation Tools

Three dedicated agent tools for generating formatted documents from task context:

| Tool | Output | Description |
|------|--------|-------------|
| `generate_document` | PDF | Generate PDF documents with markdown content and structured sections |
| `generate_presentation` | PPTX | Generate PowerPoint presentations with multiple slides |
| `generate_spreadsheet` | XLSX | Generate Excel spreadsheets with multiple sheets and data |

These tools complement the existing document skills (spreadsheet.ts, document.ts, presentation.ts) by providing direct LLM-callable tool interfaces. Generated files are registered as task artifacts with proper MIME types.

---

## Event Triggers

Condition-based automation engine that fires actions in response to events.

| Feature | Description |
|---------|-------------|
| **Trigger sources** | Channel gateway messages, cron service, webhooks |
| **Action types** | `create_task`, `send_message`, `wake_agent` |
| **Condition logic** | "all" (AND) evaluation of multiple conditions |
| **Cooldown** | Configurable cooldown period (default 1 min) to prevent rapid re-firing |
| **Variable substitution** | Event data can be injected into action prompts/titles |
| **History** | Last 50 fires per trigger stored for audit |

Configure in **Settings** > **Event Triggers**.

---

## File Hub

Unified file aggregation service combining local workspace files, task artifacts, and cloud storage into a single searchable interface.

| Feature | Description |
|---------|-------------|
| **Multi-source** | Local workspace files, task artifacts, connected cloud storage |
| **Search** | Filename-based search across all connected sources |
| **Recent files** | Tracks recently accessed files with timestamps |
| **MIME detection** | 20+ common formats (PDF, images, docs, sheets, code, etc.) |

Access from the **File Hub** panel in the sidebar.

---

## Web Access

Serve CoWork OS as a web application accessible from any browser on the network.

| Feature | Description |
|---------|-------------|
| **HTTP server** | Configurable host/port with static file serving |
| **Authentication** | Bearer token with timing-safe comparison |
| **CORS** | Origin whitelisting for cross-origin access |
| **REST API** | Maps endpoints to IPC channels (tasks, workspaces, accounts, briefings, suggestions) |
| **WebSocket** | Real-time event streaming for connected clients |
| **Health check** | Unauthenticated `/api/health` endpoint for monitoring |

Configure in **Settings** > **Web Access**.

---

## Vision Tools

Multi-provider image and PDF analysis with caching and optimization.

| Tool | Description |
|------|-------------|
| `analyze_image` | Analyze any image with vision LLM (OpenAI, Anthropic, Gemini, Bedrock) |
| `read_pdf_visual` | Convert PDF pages to images and analyze layout/design |

| Feature | Description |
|---------|-------------|
| **Result caching** | SHA1-keyed cache (128 entries) prevents redundant vision API calls |
| **Auto-downscaling** | Images >2MB automatically downscaled to 1600×1200 at 80% quality |
| **Multi-provider fallback** | OpenAI → Anthropic → Gemini → Bedrock fallback chain |
| **Retry logic** | Transient errors (429, 5xx, timeouts) trigger single retry |
| **PDF conversion** | Uses `pdftoppm` to convert PDF pages to PNG at 72 DPI (5-page max) |

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

Three-tier web interaction stack — from lightweight HTTP fetching to full browser automation to anti-bot scraping — all as native agent tools with no external CLI dependencies.

### Web Search (5 providers, always available)

Multi-provider web search with automatic fallback. DuckDuckGo is built-in and requires no API key, so `web_search` works out of the box for every user.

| Provider | Types | API Key | Notes |
|----------|-------|---------|-------|
| **DuckDuckGo** | Web | Not required | Built-in free fallback, always last in chain |
| **Tavily** | Web, News | Required | AI-optimized results (recommended) |
| **Brave Search** | Web, News, Images | Required | Privacy-focused |
| **SerpAPI** | Web, News, Images | Required | Google results |
| **Google Custom Search** | Web, Images | Required | Direct Google integration |

Paid providers are tried first in configured order. DuckDuckGo is automatically appended as the last-resort fallback. Includes retry with exponential backoff for transient errors.

### Architecture

```
Tier 0: web_search                   (multi-provider search — always available)
Tier 1: web_fetch / http_request     (no browser — fastest)
Tier 2: browser_* tools              (Playwright in-process — full interaction)
Tier 3: scrape_* tools               (Scrapling — anti-bot bypass)
```

The agent auto-selects the appropriate tier: `web_search` for discovering information, `web_fetch` for reading known URLs, `browser_*` when interaction or JS rendering is needed, and `scrape_*` for anti-bot-protected sites.

### Browser Tools (17 tools — native Playwright)

Native Playwright API integration — no CLI subprocess, no process spawning overhead.

| Tool | Description |
|------|-------------|
| `browser_navigate` | Navigate to URL with configurable wait states (load, networkidle, domcontentloaded) |
| `browser_screenshot` | Capture viewport or full-page screenshots |
| `browser_get_content` | Extract text, links, and form data from current page |
| `browser_click` | Click elements via CSS selectors |
| `browser_fill` | Fill form fields (clears existing text) |
| `browser_type` | Type text character-by-character (triggers autocomplete/key events) |
| `browser_press` | Press keyboard keys (Enter, Tab, Escape, shortcuts) |
| `browser_wait` | Wait for element visibility with timeout |
| `browser_scroll` | Scroll page (up, down, top, bottom) |
| `browser_select` | Select dropdown options |
| `browser_get_text` | Extract text from specific elements |
| `browser_evaluate` | Execute JavaScript in browser context |
| `browser_back` | Navigate browser history back |
| `browser_forward` | Navigate browser history forward |
| `browser_reload` | Reload the current page |
| `browser_save_pdf` | Save page as PDF file |
| `browser_close` | Close browser session and free resources |

### Web Fetch Tools (2 tools)

Lightweight HTTP without browser overhead — preferred for reading known URLs.

| Tool | Description |
|------|-------------|
| `web_fetch` | Fetch URL → HTML-to-Markdown conversion with optional CSS selector filtering |
| `http_request` | Raw HTTP requests (GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS) with custom headers/body |

### Browser Features

| Feature | Description |
|---------|-------------|
| **Multi-Browser** | Chromium (bundled), Chrome (system), Brave (auto-discovered) |
| **Persistent Profiles** | Cookies and storage persist across tasks in `.cowork/browser-profiles/` |
| **Consent Auto-Dismiss** | 40+ pattern detectors for cookie/GDPR consent popups |
| **Retry Logic** | 2-attempt retry with per-attempt timeout calculation |
| **Failure Diagnostics** | Screenshot + page content + URL captured on failure |
| **Domain Guardrails** | Whitelist enforcement via GuardrailManager |
| **Headless/Headed** | Toggle visible browser window for debugging |
| **Configurable Timeouts** | Per-tool `timeout_ms` parameter (default: 90s) |

### Comparison with ClawHub Agent Browser

| Capability | ClawHub Agent Browser | CoWork OS Browser |
|---|---|---|
| **Architecture** | External Rust CLI, commands via Bash shell | Native Playwright API, in-process (no spawning) |
| **Performance** | CLI process spawn per command + JSON serialization | Direct API calls, persistent browser instance |
| **Navigation** | `open`, `back`, `forward`, `reload` | `browser_navigate`, `browser_back`, `browser_forward`, `browser_reload` |
| **Element interaction** | 12 commands (click, fill, type, hover, drag, check, select, etc.) | 6 tools (click, fill, type, press, scroll, select) |
| **Page analysis** | Accessibility tree snapshots with `@ref` identifiers | Content extraction (text + links + forms), element text |
| **Screenshots/PDF** | Screenshot + full-page + PDF export | `browser_screenshot` (viewport/full) + `browser_save_pdf` |
| **JavaScript** | `eval "expression"` | `browser_evaluate` (full JS execution) |
| **Wait strategies** | Element, text, URL, network idle, JS condition | Element visibility with timeout |
| **Tabs/frames** | Tab management, iframe switching | Single-page focus |
| **State management** | `state save/load` JSON files | Persistent browser profiles (automatic) |
| **Network interception** | Route, mock, block requests | Not exposed as tools |
| **Video recording** | `record start/stop` to WebM | Not available |
| **Device emulation** | Presets ("iPhone 14"), geolocation, viewport | Viewport configurable |
| **Cookies/storage** | Manual cookie and localStorage management | Automatic via persistent profiles |
| **Anti-bot bypass** | None | Scrapling integration (TLS fingerprinting, Cloudflare bypass) |
| **Consent popups** | None | Auto-dismissal with 40+ pattern detectors |
| **Retry on failure** | None (single attempt) | 2-attempt retry with diagnostics |
| **Domain guardrails** | None | Whitelist enforcement |
| **Lightweight fetch** | None (always launches browser) | `web_fetch` for reads without browser overhead |
| **Multi-browser** | Playwright only | Chromium, Chrome, Brave |
| **Integration** | Loose (CLI → Bash → agent) | Tight (in-process, daemon logging, artifact registry) |

**Key advantage:** CoWork OS's in-process Playwright approach avoids the overhead of spawning a CLI process per command while providing tighter integration with the agent runtime (retry logic, failure diagnostics, domain guardrails, consent auto-dismiss). The three-tier architecture also means the agent doesn't launch a browser when a simple HTTP fetch suffices.

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
| **Discord** | Community | 19 tools: guilds, channels, messages, threads, roles, reactions, webhooks, members |
| **Google Workspace** | Productivity (OAuth) | Calendar, Drive, Gmail with shared OAuth and PKCE flow |
| **DocuSign** | E-signatures (OAuth) | health, send/get/list envelopes |
| **Outreach** | Sales (OAuth) | health, list/get prospects, create sequences |
| **Slack** | Messaging (OAuth) | health, list channels, send/search messages |

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
- Coinbase Agentic Wallet remote signer configuration (`wallet.provider = coinbase_agentic`) — see [Coinbase Agentic Signer Contract](coinbase-agentic-signer.md)

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

## Built-in Skills (139)

| Category | Skills |
|----------|--------|
| **Developer** | GitHub, GitLab, Linear, Jira, Sentry, Code Reviewer, Multi-PR Review, Developer Growth Analysis |
| **Communication** | Slack, Discord, Telegram, Email, Voice Calls |
| **Productivity** | Notion, Obsidian, Todoist, Apple Notes/Reminders/Calendar, PRD Generator, Memory Kit |
| **Media** | Spotify, YouTube, SoundCloud |
| **Image** | Image Generation (Gemini/OpenAI/Azure), Agentic Image Loop |
| **Documents** | Excel, Word, PDF, PowerPoint |
| **Frontend** | Frontend Design, React Native Best Practices |
| **Mobile** | iOS Development, Android Development |
| **Game Dev** | Unity Development, Unreal Engine Development, Game Performance Optimization |
| **IaC / DevOps** | Terraform Operations, Kubernetes Operations, Cloud Migration, Docker Compose Operations |
| **Data** | Supabase SDK Patterns |
| **Search** | Local Web Search (SearXNG), Bird |
| **Finance** | Crypto Trading, Crypto Execution, Trading Foundation, DCF Valuation, Earnings Analyzer, ESG Scorer, Financial Modeling, Market Screener, Portfolio Optimizer, Risk Analyzer, Tax Optimizer |
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
