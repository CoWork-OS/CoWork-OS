<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="screenshots/cowork-os-sl-dark-logo.png">
    <source media="(prefers-color-scheme: light)" srcset="screenshots/cowork-os-sl-color-logo.png">
    <img src="screenshots/cowork-os-sl-color-logo.png" alt="CoWork OS" width="600">
  </picture>
</p>

<p align="center">
  <strong>CoWork OS is a local-first option for production workflows.</strong><br>
  Security-hardened, local-first AI operating system — 34 LLM provider options, 15 messaging channels, 137 built-in skills
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/cowork-os"><img src="https://img.shields.io/npm/v/cowork-os.svg" alt="npm"></a>
  <a href="https://github.com/CoWork-OS/CoWork-OS/actions/workflows/ci.yml"><img src="https://github.com/CoWork-OS/CoWork-OS/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <a href="https://www.apple.com/macos/"><img src="https://img.shields.io/badge/platform-macOS-blue.svg" alt="macOS"></a>
  <a href="https://www.microsoft.com/windows"><img src="https://img.shields.io/badge/platform-Windows-0078D6.svg" alt="Windows"></a>
</p>

<p align="center">
  <a href="docs/getting-started.md">Getting Started</a> &middot;
  <a href="docs/showcase.md">Use Cases</a> &middot;
  <a href="docs/release-notes-0.5.17.md">Release Notes 0.5.17</a> &middot;
  <a href="docs/integration-skill-bootstrap-lifecycle.md">Platform Updates</a> &middot;
  <a href="docs/">Documentation</a> &middot;
  <a href="CHANGELOG.md">Changelog</a> &middot;
  <a href="SECURITY.md">Security</a> &middot;
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <img src="screenshots/cowork-os-home.png" alt="CoWork OS Interface" width="700">
</p>

### Why CoWork OS?

- **Inbox Agent** — local-first email triage with AI classification, action-needed / suggested-actions / commitments views, draft handling, follow-up creation, and background sync.
- **Digital Twin Personas** — Pre-built AI twins for every role (engineer, manager, PM, director). Heartbeat v3 keeps them cheap by default: deterministic Pulse checks run quietly, and Dispatch escalates only when signals, cadence, or manual intervention justify visible work.
- **Zero-Human Company Ops** — Configure CoWork OS as a founder-directed autonomous company shell with venture workspace kits, a dedicated Companies tab, persistent operator twins, strategic planner loops, and Mission Control ops monitoring.
- **Managed Devices** — Run and inspect tasks across saved remote machines from a dedicated Devices tab with connection controls, summaries, remote task feeds, and remote file attachment picking.
- **Automations Control Center** — A single Automations section now groups task queueing, scheduled tasks, event triggers, webhooks, daily briefings, and the self-improvement loop.
- **34 LLM provider options** — 13 built-in providers plus 21 compatible/gateway options, including Anthropic, OpenAI, Google, Ollama, AWS Bedrock, and OpenRouter. Bring your own keys or run local models.
- **15 messaging channels** — WhatsApp, Telegram, Discord, Slack, Teams, iMessage, Signal, X, and more. Chat with your AI from anywhere.
- **44 MCP connectors** — Pre-built enterprise integrations across CRM, support, productivity, analytics, and payments, with native connector support for the most common internal surfaces.
- **18 bundled role-specific packs** — including Mobile Development, Game Development, and 5 Financial packs, with 55+ skills, in-app Plugin Store for installing community packs, remote registry, and enterprise admin policies for organization-wide control.
- **137 built-in skills** — Documents, code review, web search, image generation, cloud integrations, game development, mobile development, financial analysis, infrastructure-as-code, and more.
- **Active Context sidebar** — Always-visible panel showing 44 available MCP connectors with branded Lucide icons and enabled skills, auto-refreshed every 30 seconds.
- **Agent teams** — Multi-agent collaboration with shared checklists, collaborative mode, multi-LLM synthesis, and persistent teams.
- **Think With Me mode** — Socratic brainstorming that helps you clarify thinking without executing actions.
- **Chat mode** — Direct LLM chat with no tools, no step timeline, same-session follow-ups, and chat-only streaming for supported providers.
- **Build Mode** — Go from idea to working prototype with a phased canvas workflow (Concept → Plan → Scaffold → Iterate) and named checkpoints.
- **AI Playbook** — Auto-captures what worked from successful tasks and injects relevant patterns into future prompts. Repeated patterns auto-promote to governed, one-click-approvable skills via the Playbook-to-Skill pipeline.
- **Evolving Intelligence** — Unified Memory Synthesizer merges all 6 memory subsystems into a single coherent context block. Adaptive Style Engine learns your communication preferences from message patterns and feedback. Evolution Metrics dashboard quantifies improvement over time (correction rate, knowledge growth, style alignment).
- **Operator Runtime Visibility** — Task completion now shows what Cowork learned, unified recall spans tasks/messages/files, persistent shell sessions preserve operator state, and model routing/fallback is visible in the UI and Mission Control.
- **Usage Insights** — Dashboard showing task stats, cost/token tracking by model, activity heatmaps, top skills, and per-pack analytics.
- **ChatGPT History Import** — Import your full ChatGPT conversation history. CoWork OS instantly knows your preferences, past projects, and context — no cold start. All data stays encrypted on your machine and never leaves it.
- **Security-first** — Approval workflows, sandboxed execution, configurable guardrails, encrypted storage, and 4000+ tests.
- **Structured guidance** — In plan-mode flows, the agent can pause with short multiple-choice prompts instead of ambiguous free-text follow-ups.
- **Runtime resilience** — Adaptive turn budgets, context-overflow recovery, and safe path normalization keep long-running tasks moving without silent file drift.
- **Local-first & BYOK** — Your data and API keys stay on your machine. No telemetry. No middleman.

### Ideas & Media

Stable workflow entry points for the newest high-impact capabilities.

- **Ideas panel** — curated launchpad of pre-written workflow prompts and capability-aware starting points, with deep links into common tasks.
- **Document editing sessions** — inline PDF region editing, DOCX block replacement, version browsing, and document-aware file viewing for active editing sessions.
- **Image generation** — configurable provider ordering across Gemini, OpenAI, Azure OpenAI, and OpenRouter.
- **Video generation** — text-to-video and image-to-video routing with polling tools and inline preview.

See [Features](docs/features.md), [Heartbeat v3](docs/heartbeat-v3.md), [Providers](docs/providers.md), and [Plugin Packs](docs/plugin-packs.md) for current runtime details.

### Latest Release

`0.5.17` centers on five product areas: visible runtime learning/routing state, Discord supervisor mode, Microsoft OAuth for Outlook.com-family personal mailboxes, ClawHub/external skill imports, and mailbox/security hardening, with additional Devices/Dispatch and Inbox UX cleanup plus release-gate and release-validation fixes. Start with the [Release Notes 0.5.17](docs/release-notes-0.5.17.md), then use the [Changelog](CHANGELOG.md) for the condensed delta from `v0.5.14`.

## Quick Start

### Download the App

Download the latest release from [GitHub Releases](https://github.com/CoWork-OS/CoWork-OS/releases/latest):

| Platform | Download | Install |
|----------|----------|---------|
| **macOS** | `.dmg` | Drag CoWork OS into Applications |
| **Windows** | `.exe` (NSIS installer) | Run the installer and follow the prompts |

> **macOS first launch:** The app is currently unsigned. On first open, macOS will block it — go to **System Settings > Privacy & Security > Open Anyway**, or run: `xattr -dr com.apple.quarantine "/Applications/CoWork OS.app"`

> **Windows first launch:** Windows SmartScreen may show a warning for unrecognized apps. Click **More info** > **Run anyway** to proceed.

> Works out of the box — defaults to [OpenRouter's free model router](https://openrouter.ai), no API key needed.

### Or Install via npm

```bash
npm install -g cowork-os
cowork-os
```

> **Windows npm install notes:**
> - Run `npm install -g cowork-os` / `npm uninstall -g cowork-os` from `%USERPROFILE%` (or another neutral directory), **not** from `%APPDATA%\npm\node_modules\cowork-os`, to avoid `EBUSY` lock errors.
> - On Windows ARM64, first launch may take longer while native modules are rebuilt; this can run multiple fallback steps before the app opens.
> - If native rebuild fails, install [Visual Studio Build Tools 2022 (C++)](https://visualstudio.microsoft.com/visual-cpp-build-tools/) and Python 3, then retry.
> - If startup logs show `ERR_FILE_NOT_FOUND ... dist/renderer/index.html`, reinstall the latest package and check [Troubleshooting](docs/troubleshooting.md).

### Or Build from Source

```bash
git clone https://github.com/CoWork-OS/CoWork-OS.git
cd CoWork-OS
npm install && npm run setup
npm run build && npm run package
```

> **Windows prerequisites:** Native module setup may require [Visual Studio Build Tools 2022 (C++)](https://visualstudio.microsoft.com/visual-cpp-build-tools/) and Python 3. On Windows ARM64, setup automatically falls back to x64 Electron emulation when ARM64 native prebuilds are unavailable.
>
> `npm run setup` also installs local git hooks (`.githooks/`) including a pre-commit secret scan. If needed, reinstall hooks with `npm run hooks:install`.

See the [Development Guide](docs/development.md) for prerequisites and details.

## How It Works

1. **Create a task or start from Ideas** — Describe what you want ("organize my Downloads by file type", "create a quarterly report spreadsheet") or begin from a curated Ideas prompt. No workspace needed — a temp folder is used automatically if you don't select one.
2. **Choose a mode** — Pick **Chat**, **Execute**, **Plan**, **Analyze**, or **Verified** for the runtime behavior, then optionally toggle **Autonomous** (auto-approve actions), **Collaborative** (multi-agent perspectives), or **Multi-LLM** (compare providers with a judge) per task.
3. **Monitor execution** — Watch the real-time task timeline as the agent plans, executes, and produces artifacts. Parallel tool bursts are grouped into lane summaries, and shell commands run in a live terminal view where you can see output in real-time, stop execution, or provide input (e.g. `y`/`n`) directly.
4. **Respond when needed** — Destructive operations require explicit approval (unless Autonomous mode is on), and plan-mode tasks can pause for structured multiple-choice input before continuing.

## Features

### Agent Runtime

Task-based execution with dynamic re-planning, five runtime modes (Chat, Execute, Plan, Analyze, Verified) plus orchestration toggles (Autonomous, Collaborative, Multi-LLM, Think With Me), agent teams with persistence, agent comparison, git worktree isolation, AI playbook, and performance reviews. [Learn more](docs/features.md#agent-capabilities)

Operator Runtime Visibility makes the runtime's learning and routing visible: task detail surfaces now show the learning progression, unified recall spans tasks/messages/files/workspace notes/memory/KG, shell sessions preserve operator state, and live routing/fallback events are surfaced in Mission Control and the task UI. [Learn more](docs/operator-runtime-visibility.md)

Autonomous self-improvement runs now use the same runtime with stricter safeguards: they start only after memory services are initialized, require isolated git worktrees by default, skip non-git workspaces when worktree isolation is required, and can notify you when runs start, fail, or open a PR. See [Self-Improving Agent Architecture](docs/self-improving-agent.md) and [Troubleshooting](docs/troubleshooting.md#self-improvement-startup-warnings-in-development).

### Output Completion UX

Completion state and file availability are now explicit:

- **High-signal completion toast**: finished tasks with outputs show `Task complete` with filename/count and actions for **Open file**, **Show in Finder**, and **View in Files**
- **Right-sidebar focus**: if you are viewing the completed task and the panel is collapsed, the Files panel auto-opens and highlights the primary output
- **Unseen-output badge**: if completion happens in another task/view, the collapsed right-panel toggle shows a numeric badge until you open Files
- **Filename-first rows with clear location context**: Files rows stay filename-only, with output folder context shown separately (or **Workspace root**)
- **Artifact parity**: artifact-only outputs are treated the same as normal file outputs in completion toasts, timeline details, and Files panel

### Guided Input & Runtime Recovery

Long-running tasks now have clearer operator handoffs and stronger recovery defaults:

- **Structured input cards**: plan-mode tasks can pause with 1-3 short multiple-choice prompts, with answers captured inline in the desktop UI or via the Control Plane web dashboard
- **Adaptive turn recovery**: execute-mode tasks reserve room for a final answer, soft-stop exhausted follow-up windows, and make a bounded recovery attempt before triggering a safety stop
- **Context overflow retry**: context-capacity failures trigger compaction and retry instead of immediate hard failure when the model context window is exceeded
- **Path repair**: `/workspace/...` aliases and drifted relative paths can be normalized back into the active workspace or pinned task root, with strict-fail policies available when you want hard enforcement
- **Parallel timeline lanes**: read-only tool batches render as grouped timeline rows so the UI stays readable even when searches/fetches run concurrently

### Mission Control

Centralized agent orchestration dashboard with a Kanban task board, real-time activity feed, and Heartbeat v3 monitoring for pulse, defer, dispatch, cooldown, and budget state. [Learn more](docs/mission-control.md) | [Heartbeat v3](docs/heartbeat-v3.md)

### Devices

The Devices tab turns CoWork OS into a multi-machine control surface. Save and reconnect remote CoWork nodes, inspect device summaries (activity, apps, storage, alerts, resource signals), launch tasks against a selected machine, browse that machine's remote workspaces, and attach files directly from the remote filesystem before dispatching a task. [Learn more](docs/remote-access.md)

### Automations

Automations are now organized as a first-class operating surface instead of a scattered set of settings pages. The Automations section in Settings groups Task Queue, Self-Improve, Scheduled Tasks, Webhooks, Event Triggers, and Daily Briefing, while the home dashboard surfaces recent automation runs so you can monitor background systems without hunting through tabs. [Learn more](docs/features.md#automations-control-center)

### Zero-Human Company Ops

CoWork OS can be configured as a founder-operated autonomous company shell: venture workspace kit context, a dedicated `Settings > Companies` control surface, persistent company-linked operator agents, Heartbeat v3 operator loops, strategic planner issue generation, and Mission Control ops monitoring. Create the company in `Companies`, activate operator twins such as `Company Planner` and `Founder Office Operator`, then run and monitor the company loop from Mission Control. [Learn more](docs/zero-human-company.md) | [Heartbeat v3](docs/heartbeat-v3.md)

### Digital Twin Personas

Role-specific AI twins that proactively handle cognitive overhead. Pick a template (Software Engineer, Engineering Manager, Product Manager, VP, Founder Office Operator, Company Planner, and more), customize it, and activate — Heartbeat v3 runs cheap non-LLM Pulse checks by default, evaluates proactive cadence and checklist state, and only Dispatches into suggestions, tasks, runbooks, or cron handoff when justified. Built-in templates span engineering, management, product, data, operations, and venture/operator roles, and can now be persistently linked to a company for company-aware operations. [Learn more](docs/digital-twins.md) | [Heartbeat v3](docs/heartbeat-v3.md)

### Live Canvas & Build Mode

Agent-driven visual workspace for interactive HTML/CSS/JS content, data visualization, and iterative image annotation. **Build Mode** adds a phased idea-to-prototype workflow with named checkpoints and revert support. [Learn more](docs/live-canvas.md)

### Multichannel Gateway

Unified AI gateway across 15 channels with security modes, rate limiting, ambient mode, scheduled tasks, and chat commands. [Learn more](docs/channels.md)

### Inbox Agent

Local-first inbox workspace that turns email into an action queue. It keeps cached mail visible on restart, syncs in the background, and surfaces the right next step for each thread: triage, draft, cleanup, commitment tracking, and scheduling. [Learn more](docs/inbox-agent.md)

- **Action cards**: Unread, Action Needed, Suggested Actions, Open Commitments
- **Mailbox views**: Inbox, Sent, All, plus Recent/Priority sorting
- **Workflow buttons**: Cleanup, Follow-up, Prep thread, Extract todos, Schedule, Refresh intel
- **Draft handling**: Send or discard generated replies before anything is posted externally
- **Commitment tracking**: Accept commitments into real follow-up tasks, then mark them done or dismiss them
- **Background sync**: Load from the local database immediately and refresh in the background without blanking the inbox on restart

### Infrastructure

Built-in cloud infrastructure tools — no external processes or MCP servers needed. The agent can spin up sandboxes, register domains, and make payments natively.

- **Cloud Sandboxes (E2B)**: Create, manage, and execute commands in isolated Linux VMs. Expose ports, read/write files — all from natural language.
- **Domain Registration (Namecheap)**: Search available domains, register, and manage DNS records (A, AAAA, CNAME, MX, TXT).
- **Crypto Wallet**: Built-in USDC wallet on Base network. Auto-generated, encrypted in OS keychain. Balance displayed in sidebar.
- **x402 Payments**: Machine-to-machine HTTP payment protocol. Agent can pay for API access automatically with EIP-712 signed USDC transactions (requires approval).

All infrastructure operations that involve spending (domain registration, x402 payments) require explicit user approval. Configure in **Settings** > **Infrastructure**. [Learn more](docs/features.md#infrastructure)

### Web Scraping

Advanced web scraping powered by [Scrapling](https://github.com/D4Vinci/Scrapling) with anti-bot bypass, stealth browsing, and structured data extraction. Three fetcher modes — fast HTTP with TLS fingerprinting, stealth with Cloudflare bypass, and full Playwright browser. Includes batch scraping, persistent sessions, proxy support, and five built-in skills (web scraper, price tracker, site mapper, lead scraper, content monitor). Configure in **Settings** > **Web Scraping**. [Learn more](docs/features.md#web-scraping-scrapling)

### Integrations

- **Cloud Storage**: 6 integrations, including Notion, Box, OneDrive, Google Workspace, Dropbox, and SharePoint
- **44 MCP Connectors**: pre-built enterprise integrations for CRM, support, productivity, analytics, and payments (Salesforce, Jira, HubSpot, Zendesk, Stripe, Tavily, Grafana, Metabase, Socket, and more)
- **Developer Tools**: Claude Code-style `glob`/`grep`/`edit_file`, Playwright browser automation, MCP client/host/registry

[Learn more](docs/features.md)

### Active Context Sidebar

Real-time overview of your active integrations, always visible in the right panel. Shows connected MCP connectors (44 available) and native integrations with branded Lucide icons (HubSpot, Salesforce, Google Workspace, Discord, GitHub, Postgres, and more) and green status dots, plus enabled skills from active packs. Each section shows 4 items with internal scrolling for more. Auto-refreshes every 30 seconds. [Learn more](docs/plugin-packs.md#context-panel)

### Usage Insights

Dashboard with task metrics, cost/token tracking by model, activity heatmaps (day-of-week and hourly), top skills usage, and per-pack analytics (skill usage grouped by plugin pack) with 7/14/30-day period selection. Access from **Settings** > **Usage Insights**. [Learn more](docs/features.md#usage-insights)

### LLM Providers

34 provider options, with 13 built-in providers and 21 compatible/gateway providers. Use cloud APIs or run fully offline with Ollama. [Learn more](docs/providers.md)

### Plugin Platform & Customize

Unified plugin platform with 18 bundled role-specific packs (Engineering, DevOps, Product, Sales, QA, Finance, and more), each bundling skills, agent roles, connectors, and "Try asking" prompts. Packs can link to Digital Twin personas for proactive background work.

- **Search & filter**: Real-time sidebar search across pack names, descriptions, categories, and skill names
- **Per-skill control**: Enable or disable individual skills within a pack without toggling the whole pack
- **Persistent toggles**: Pack and skill states survive app restarts
- **Update detection**: Background version checks against the registry with visual indicators
- **"Try asking" in chat**: Empty chat shows randomized prompt suggestions from active packs
- **Plugin Store**: In-app marketplace for browsing, installing (Git/URL), and scaffolding custom packs
- **Skill Store & external skills**: Desktop GUI support for CoWork Registry skills, direct ClawHub installs, and generic external skill imports from Git repos, raw manifests, and `SKILL.md` bundles
- **Remote Registry**: Community pack catalog with search and category filtering
- **Admin Policies**: Organization-level controls — allow/block/require packs, restrict installations, set agent limits, distribute org-managed packs from a shared directory
- **Per-pack analytics**: Usage Insights dashboard groups skill usage by parent pack

Access from **Settings** > **Customize**. [Learn more](docs/plugin-packs.md)

### Best-Fit Workflows

CoWork OS ships purpose-built packs and Tier-1 connectors for three operational lanes where governed AI delivery has the clearest ROI:

| Lane | Pack | Connectors |
|------|------|------------|
| **Support Ops** | Customer Support Pack | Zendesk, ServiceNow |
| **IT Ops** | DevOps Pack | ServiceNow, Jira, Linear |
| **Sales Ops** | Sales CRM Pack | HubSpot, Salesforce |

These are the workflows where approval gates, local data control, and measurable outcome delivery pay off most — and where CoWork OS is a vendor-swap-friendly alternative to point solutions or BPO tooling. [Learn more](docs/best-fit-workflows.md)

### Extensibility

- **137 built-in skills** across developer, productivity, communication, documents, game development, mobile development, financial analysis, infrastructure-as-code, and more
- **Custom skills** in `~/Library/Application Support/cowork-os/skills/` (macOS) or `%APPDATA%\cowork-os\skills\` (Windows)
- **18 bundled plugin packs** with 55+ role-specific skills and Digital Twin integration
- **Plugin Store** — browse, install from Git/URL, or scaffold custom packs
- **Skill Store** — browse CoWork Registry skills, search ClawHub, and import external skills from Git, raw JSON, or raw `SKILL.md`
- **MCP support** — client, host, and registry

### Voice Mode

Text-to-speech (ElevenLabs, OpenAI, Web Speech API), speech-to-text (Whisper), and outbound phone calls. [Learn more](docs/features.md#voice-mode)

### Knowledge Graph

Built-in structured entity and relationship memory backed by SQLite. The agent builds a knowledge graph of your workspace — people, projects, technologies, services, and their relationships — with 9 dedicated tools, FTS5 search, multi-hop graph traversal, auto-extraction from task results, and confidence scoring with decay. [Learn more](docs/knowledge-graph.md)

### Memory & Context

Persistent memory with privacy protection, FTS5 search, LLM compression, and a contract-driven workspace kit (`.cowork/`) for durable human-edited context. The workspace kit now separates workspace-wide files such as `AGENTS.md`, `USER.md`, `MEMORY.md`, `TOOLS.md`, `SOUL.md`, `IDENTITY.md`, `RULES.md`, `VIBES.md`, and `LORE.md` from project-scoped files such as `.cowork/projects/<projectId>/CONTEXT.md` and `.cowork/projects/<projectId>/ACCESS.md`. Special files get dedicated lifecycle handling: `BOOTSTRAP.md` is a one-time onboarding checklist tracked through `.cowork/workspace-state.json`, while `HEARTBEAT.md` is reserved for recurring Heartbeat v3 checklist work instead of general task context.

Every tracked file follows a shared parser/linter model with freshness windows, secret detection, missing-file status, and revision snapshots stored under `.cowork/**/.history/`. Workspace kit health is surfaced in the app and can be checked locally with `npm run kit:lint` for human-readable output or JSON export. **Import your ChatGPT history** to eliminate the cold-start problem — CoWork OS knows you from day one. All imported data is stored locally and encrypted on your machine. **Proactive session compaction** automatically generates comprehensive structured summaries when context reaches 90% capacity — preserving user messages, decisions, file changes, errors, and pending work so the agent continues seamlessly without losing critical context. [Learn more](docs/features.md#persistent-memory-system) | [Context Compaction](docs/context-compaction.md)

<p align="center">
  <img src="screenshots/cowork-os-agents.png" alt="Agent Personas" width="700">
  <br>
  <em>Role-specific agent personas and intent-first task startup</em>
</p>

## Architecture

<div align="center">
<pre>
┌─────────────────────────────────────────────────────────────────┐
│                    Security Layers                               │
│  Channel Access Control │ Guardrails & Limits │ Approval Flows   │
└─────────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────────┐
│                    React UI (Renderer)                           │
│  Task List │ Timeline │ Approval Dialogs │ Live Canvas           │
└─────────────────────────────────────────────────────────────────┘
                              ↕ IPC
┌─────────────────────────────────────────────────────────────────┐
│                 Agent Daemon (Main Process)                      │
│  Task Queue │ Agent Executor │ Tool Registry │ Cron Service      │
└─────────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────────┐
│                    Execution Layer                               │
│  File Ops │ Skills │ Browser │ LLM Providers (30+) │ MCP        │
│  Infrastructure (E2B Sandboxes │ Domains │ Wallet │ x402)       │
└─────────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────────┐
│  SQLite DB │ Knowledge Graph │ MCP Host │ WebSocket │ Remote Access  │
└─────────────────────────────────────────────────────────────────┘
</pre>
</div>

See [Architecture](docs/architecture.md) for the full technical deep-dive.

## Security

<p align="center">
  <img src="screenshots/ZeroLeaks-result-010226.png" alt="ZeroLeaks Security Assessment" width="500">
  <br>
  <em>Top security score on <a href="https://zeroleaks.ai/">ZeroLeaks</a> — outperforming many commercial solutions</em>
  <br>
  <a href="ZeroLeaks-Report-jn70f56art03m4rj7fp4b5k9p180aqfd.pdf">View Full Report</a>
</p>

- **Configurable guardrails**: Token budgets, cost limits, iteration caps, dangerous command blocking
- **Approval workflows**: User consent required for destructive operations
- **Sandbox isolation**: macOS `sandbox-exec` (native), Docker containers, or process-level isolation on Windows
- **Encrypted storage**: OS keychain + AES-256 fallback
- **4000+ tests** including 132+ security unit tests and 259+ WebSocket protocol tests

See [Security Guide](docs/security-guide.md) and [Security Architecture](docs/security/) for details.

## Deployment

| Mode | Platform | Guide |
|------|----------|-------|
| **Desktop App** | macOS, Windows | [Getting Started](docs/getting-started.md) |
| **Headless / Server** | Linux VPS | [VPS Guide](docs/vps-linux.md) |
| **Self-Hosted** | Docker / systemd | [Self-Hosting](docs/self-hosting.md) |
| **Remote Access** | Tailscale / SSH | [Remote Access](docs/remote-access.md) |

## Screenshots

<p align="center">
  <img src="screenshots/cowork-os-canvas.png" alt="Live Canvas" width="700">
  <br><em>Live Canvas for visual, iterative build workflows</em>
</p>

<p align="center">
  <img src="screenshots/cowork-os-excel.png" alt="Spreadsheet Output" width="700">
  <br><em>Structured spreadsheet outputs generated directly in chat</em>
</p>

<p align="center">
  <img src="screenshots/cowork-os-connectors.png" alt="Connector Setup" width="700">
  <br><em>Enterprise connector setup with OAuth and credential management</em>
</p>

<p align="center">
  <img src="screenshots/cowork-os-usageinsights.png" alt="Usage Insights Dashboard" width="700">
  <br><em>Usage Insights dashboard with performance, efficiency, and activity trends</em>
</p>

<p align="center">
  <img src="screenshots/cowork-os-extensions.png" alt="Extensions Manager" width="700">
  <br><em>Extensions manager for installed plugin packs and lifecycle controls</em>
</p>

<p align="center">
  <img src="screenshots/cowork-os-skillpacks.png" alt="Customize Skill Packs" width="700">
  <br><em>Pack-level customization with per-skill toggles and suggested prompts</em>
</p>

## Roadmap

### Planned

- [ ] VM sandbox using macOS Virtualization.framework
- [ ] Network egress controls with proxy
- [ ] Linux desktop support

See [CHANGELOG.md](CHANGELOG.md) for the full history of completed features.

## Documentation

| Guide | Description |
|-------|-------------|
| [Getting Started](docs/getting-started.md) | First-time setup and usage |
| [Use Case Showcase](docs/showcase.md) | Comprehensive guide to what you can build and automate |
| [Features](docs/features.md) | Complete feature reference |
| [Chat Mode](docs/chat-mode.md) | Direct chat-only mode with no tools and same-session follow-ups |
| [Platform Updates](docs/integration-skill-bootstrap-lifecycle.md) | Detailed implementation notes for integration setup, skill proposals, workspace-kit contracts, and bootstrap lifecycle |
| [Channels](docs/channels.md) | Messaging channel setup (15 channels) |
| [X Mention Triggers](docs/x-mention-triggers.md) | Configure `do:` mention-triggered task ingress on desktop and headless |
| [Providers](docs/providers.md) | LLM provider configuration |
| [Migration Guide](docs/migration.md) | Migration checklist and compatibility notes |
| [Development](docs/development.md) | Build from source, project structure |
| [Architecture](docs/architecture.md) | Technical architecture deep-dive |
| [Heartbeat v3](docs/heartbeat-v3.md) | Default two-lane heartbeat architecture, signals, Pulse, Dispatch, and operator semantics |
| [Security Guide](docs/security-guide.md) | Security model and best practices |
| [Enterprise Connectors](docs/enterprise-connectors.md) | MCP connector development |
| [Self-Hosting](docs/self-hosting.md) | Docker and systemd deployment |
| [VPS/Linux](docs/vps-linux.md) | Headless server deployment |
| [Remote Access](docs/remote-access.md) | Tailscale, SSH tunnels, WebSocket API |
| [Knowledge Graph](docs/knowledge-graph.md) | Structured entity/relationship memory |
| [Context Compaction](docs/context-compaction.md) | Proactive session compaction with structured summaries and chat-history summarization |
| [Mission Control](docs/mission-control.md) | Agent orchestration dashboard |
| [Self-Improving Agent](docs/self-improving-agent.md) | Architecture and operating model for bounded autonomous improvement campaigns |
| [Zero-Human Company Ops](docs/zero-human-company.md) | Founder-directed company planning, operators, and Mission Control ops workflows |
| [Plugin Packs](docs/plugin-packs.md) | Plugin platform, Customize panel, and Plugin Store |
| [Skill Store & External Skills](docs/skill-store-and-external-skills.md) | ClawHub support, external skill imports, and managed-skill install flows |
| [Best-Fit Workflows](docs/best-fit-workflows.md) | Support Ops, IT Ops, and Sales Ops — where CoWork OS delivers the strongest ROI |
| [Admin Policies](docs/admin-policies.md) | Enterprise admin policies and organization pack management |
| [Digital Twins](docs/digital-twins.md) | Role-based AI twin personas and cognitive offload |
| [Digital Twins Guide](docs/digital-twin-personas-guide.md) | Comprehensive guide with scenarios and expanded job areas |
| [Windows npm Smoke Test](docs/windows-npm-smoke-test.md) | Clean Windows install/launch validation checklist for npm releases |
| [Troubleshooting](docs/troubleshooting.md) | Common issues and fixes |
| [Uninstall](docs/uninstall.md) | Uninstall instructions |

## Data Handling

- **Stored locally**: Task metadata, timeline events, artifacts, workspace config, memories (SQLite)
- **Sent to provider**: Task prompt and context you choose to include
- **Not sent**: Your API keys (stored via OS keychain), private memories

## Compliance

Users must comply with their model provider's terms: [Anthropic](https://www.anthropic.com/legal/commercial-terms) · [AWS Bedrock](https://aws.amazon.com/legal/bedrock/third-party-models/)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT License. See [LICENSE](LICENSE).

---

<sub>"Cowork" is an Anthropic product name. CoWork OS is an independent open-source project and is not affiliated with, endorsed by, or sponsored by Anthropic. If requested by the rights holder, we will update naming/branding.</sub>
