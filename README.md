<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="screenshots/cowork-os-logo-text-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="screenshots/cowork-os-logo-text.png">
    <img src="screenshots/cowork-os-logo-text.png" alt="CoWork OS" width="360">
  </picture>
</p>

<p align="center">
  <strong>Looking for an OpenClaw alternative? CoWork OS is a local-first option for production workflows.</strong><br>
  Security-hardened, local-first AI operating system — 30+ LLM providers, 14 channels, 130+ skills
</p>

<p align="center">
  <a href="https://github.com/CoWork-OS/CoWork-OS/actions/workflows/ci.yml"><img src="https://github.com/CoWork-OS/CoWork-OS/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/cowork-os"><img src="https://img.shields.io/npm/v/cowork-os.svg" alt="npm"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <a href="https://www.apple.com/macos/"><img src="https://img.shields.io/badge/platform-macOS-blue.svg" alt="macOS"></a>
</p>

<p align="center">
  <a href="docs/getting-started.md">Getting Started</a> &middot;
  <a href="docs/showcase.md">Use Cases</a> &middot;
  <a href="docs/openclaw-comparison.md">OpenClaw Alternative Guide</a> &middot;
  <a href="docs/">Documentation</a> &middot;
  <a href="CHANGELOG.md">Changelog</a> &middot;
  <a href="SECURITY.md">Security</a> &middot;
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <img src="screenshots/cowork-os-main-focus.png" alt="CoWork OS Interface" width="700">
</p>

### Why CoWork OS?

- **30+ LLM providers** — Anthropic, OpenAI, Google, Ollama, AWS Bedrock, OpenRouter, and more. Bring your own keys.
- **14 messaging channels** — WhatsApp, Telegram, Discord, Slack, Teams, iMessage, Signal, and more. Chat with your AI from anywhere.
- **130+ built-in skills** — Documents, code review, web search, image generation, cloud integrations, game development, mobile development, infrastructure-as-code, and more.
- **Digital Twin Personas** — Pre-built AI twins for every role (engineer, manager, PM, director). Each twin absorbs cognitively draining work — PR triage, meeting prep, status reports, dependency tracking — so the human stays in flow.
- **Plugin Platform** — 12 bundled role-specific packs (including Mobile Development and Game Development) with 45+ skills, in-app Plugin Store for installing community packs, remote registry, and enterprise admin policies for organization-wide control.
- **Active Context sidebar** — Always-visible panel showing connected MCP connectors with branded Lucide icons and enabled skills, auto-refreshed every 30 seconds.
- **Agent teams** — Multi-agent collaboration with shared checklists, collaborative mode, multi-LLM synthesis, and persistent teams.
- **Think With Me mode** — Socratic brainstorming that helps you clarify thinking without executing actions.
- **Build Mode** — Go from idea to working prototype with a phased canvas workflow (Concept → Plan → Scaffold → Iterate) and named checkpoints.
- **AI Playbook** — Auto-captures what worked from successful tasks and injects relevant patterns into future prompts.
- **Usage Insights** — Dashboard showing task stats, cost/token tracking by model, activity heatmaps, top skills, and per-pack analytics.
- **ChatGPT History Import** — Import your full ChatGPT conversation history. CoWork OS instantly knows your preferences, past projects, and context — no cold start. All data stays encrypted on your Mac and never leaves your machine.
- **Security-first** — Approval workflows, sandboxed execution, configurable guardrails, encrypted storage, and 3200+ tests.
- **Local-first & BYOK** — Your data and API keys stay on your machine. No telemetry. No middleman.

### Looking for an OpenClaw Alternative?

OpenClaw has a large and passionate community for agent experimentation. CoWork OS is a respectful alternative for teams and builders who want local-first operations with approvals, guardrails, and reliable multi-channel execution.

| Positioning Lens | OpenClaw | CoWork OS |
|---|---|---|
| Category | Agent toolkit / experimentation layer | Security-hardened AI operating system |
| Primary use case | Build and iterate on agent workflows | Run agent workflows in production |
| Security posture | Varies by workflow and setup | Built-in approvals, guardrails, sandbox isolation, encrypted local storage |
| Runtime surfaces | CLI-centric control paths | Desktop app + headless daemon + 14-channel gateway |
| Data ownership model | BYOK/self-hosting workflows | Local-first, BYOK, no telemetry, optional offline Ollama |

See the full guide: [OpenClaw alternative: CoWork OS vs OpenClaw](docs/openclaw-comparison.md)

## Quick Start

### Download the App

Download the latest `.dmg` from [GitHub Releases](https://github.com/CoWork-OS/CoWork-OS/releases/latest) and drag CoWork OS into Applications.

> **First launch:** The app is currently unsigned. On first open, macOS will block it — go to **System Settings > Privacy & Security > Open Anyway**, or run: `xattr -dr com.apple.quarantine "/Applications/CoWork OS.app"`

> Works out of the box — defaults to [OpenRouter's free model router](https://openrouter.ai), no API key needed.

### Or Install via npm

```bash
npm install -g cowork-os
cowork-os
```

### Or Build from Source

```bash
git clone https://github.com/CoWork-OS/CoWork-OS.git
cd CoWork-OS
npm install && npm run setup
npm run build && npm run package
```

See the [Development Guide](docs/development.md) for prerequisites and details.

## How It Works

1. **Create a task** — Describe what you want ("organize my Downloads by file type", "create a quarterly report spreadsheet"). No workspace needed — a temp folder is used automatically if you don't select one.
2. **Choose a mode** — Run normally, or toggle **Autonomous** (auto-approve actions), **Collaborative** (multi-agent perspectives), or **Multi-LLM** (compare providers with a judge) per task.
3. **Monitor execution** — Watch the real-time task timeline as the agent plans, executes, and produces artifacts. Shell commands run in a live terminal view where you can see output in real-time, stop execution, or provide input (e.g. `y`/`n`) directly.
4. **Approve when needed** — Destructive operations require your explicit approval (unless Autonomous mode is on).

## Features

### Agent Runtime

Task-based execution with dynamic re-planning, four per-task modes (Autonomous, Collaborative, Multi-LLM, Think With Me), agent teams with persistence, agent comparison, git worktree isolation, AI playbook, and performance reviews. [Learn more](docs/features.md#agent-capabilities)

### Mission Control

Centralized agent orchestration dashboard with a Kanban task board, real-time activity feed, agent heartbeat monitoring, standup reports, and performance reviews. [Learn more](docs/mission-control.md)

### Digital Twin Personas

Role-specific AI twins that proactively handle cognitive overhead. Pick a template (Software Engineer, Engineering Manager, Product Manager, VP, etc.), customize it, and activate — the twin runs on a heartbeat, automatically executing tasks like PR triage, status digests, meeting prep, and dependency scans. 10 built-in templates across engineering, management, product, data, and operations. Scale across an organization by activating one twin per team member. [Learn more](docs/digital-twins.md)

### Live Canvas & Build Mode

Agent-driven visual workspace for interactive HTML/CSS/JS content, data visualization, and iterative image annotation. **Build Mode** adds a phased idea-to-prototype workflow with named checkpoints and revert support. [Learn more](docs/live-canvas.md)

### Multichannel Gateway

Unified AI gateway across 14 channels with security modes, rate limiting, ambient mode, scheduled tasks, and chat commands. [Learn more](docs/channels.md)

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

- **Cloud Storage**: Notion, Box, OneDrive, Google Workspace, Dropbox, SharePoint
- **Enterprise Connectors**: Salesforce, Jira, HubSpot, Zendesk, ServiceNow, Linear, Asana, Okta, Discord, Slack, Resend
- **Developer Tools**: Claude Code-style `glob`/`grep`/`edit_file`, Playwright browser automation, MCP client/host/registry

[Learn more](docs/features.md)

### Active Context Sidebar

Real-time overview of your active integrations, always visible in the right panel. Shows connected MCP connectors with branded Lucide icons (HubSpot, Salesforce, Slack, GitHub, Postgres, and 30+ more) and green status dots, plus enabled skills from active packs. Each section shows 4 items with internal scrolling for more. Auto-refreshes every 30 seconds. [Learn more](docs/plugin-packs.md#context-panel)

### Usage Insights

Dashboard with task metrics, cost/token tracking by model, activity heatmaps (day-of-week and hourly), top skills usage, and per-pack analytics (skill usage grouped by plugin pack) with 7/14/30-day period selection. Access from **Settings** > **Usage Insights**. [Learn more](docs/features.md#usage-insights)

### LLM Providers

12 built-in providers + 20+ compatible/gateway providers. Use cloud APIs or run fully offline with Ollama. [Learn more](docs/providers.md)

### Plugin Platform & Customize

Unified plugin platform with 10 bundled role-specific packs (Engineering, DevOps, Product, Sales, QA, and more), each bundling skills, agent roles, connectors, and "Try asking" prompts. Packs can link to Digital Twin personas for proactive background work.

- **Search & filter**: Real-time sidebar search across pack names, descriptions, categories, and skill names
- **Per-skill control**: Enable or disable individual skills within a pack without toggling the whole pack
- **Persistent toggles**: Pack and skill states survive app restarts
- **Update detection**: Background version checks against the registry with visual indicators
- **"Try asking" in chat**: Empty chat shows randomized prompt suggestions from active packs
- **Plugin Store**: In-app marketplace for browsing, installing (Git/URL), and scaffolding custom packs
- **Remote Registry**: Community pack catalog with search and category filtering
- **Admin Policies**: Organization-level controls — allow/block/require packs, restrict installations, set agent limits, distribute org-managed packs from a shared directory
- **Per-pack analytics**: Usage Insights dashboard groups skill usage by parent pack

Access from **Settings** > **Customize**. [Learn more](docs/plugin-packs.md)

### Extensibility

- **130+ built-in skills** across developer, productivity, communication, documents, game development, mobile development, infrastructure-as-code, and more
- **Custom skills** in `~/Library/Application Support/cowork-os/skills/`
- **12 bundled plugin packs** with 45+ role-specific skills and Digital Twin integration
- **Plugin Store** — browse, install from Git/URL, or scaffold custom packs
- **MCP support** — client, host, and registry

### Voice Mode

Text-to-speech (ElevenLabs, OpenAI, Web Speech API), speech-to-text (Whisper), and outbound phone calls. [Learn more](docs/features.md#voice-mode)

### Knowledge Graph

Built-in structured entity and relationship memory backed by SQLite. The agent builds a knowledge graph of your workspace — people, projects, technologies, services, and their relationships — with 9 dedicated tools, FTS5 search, multi-hop graph traversal, auto-extraction from task results, and confidence scoring with decay. [Learn more](docs/knowledge-graph.md)

### Memory & Context

Persistent memory with privacy protection, FTS5 search, LLM compression, and workspace kit (`.cowork/`) for durable project context. **Import your ChatGPT history** to eliminate the cold-start problem — CoWork OS knows you from day one. All imported data is stored locally and encrypted on your Mac. **Proactive session compaction** automatically generates comprehensive structured summaries when context reaches 90% capacity — preserving user messages, decisions, file changes, errors, and pending work so the agent continues seamlessly without losing critical context. [Learn more](docs/features.md#persistent-memory-system) | [Context Compaction](docs/context-compaction.md)

<p align="center">
  <img src="screenshots/cowork-os-main3.png" alt="Collaborative Mode" width="700">
  <br>
  <em>Multi-agent collaborative mode with real-time thought sharing</em>
</p>

## Architecture

```
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
```

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
- **Sandbox isolation**: macOS `sandbox-exec` (native) or Docker containers
- **Encrypted storage**: OS keychain + AES-256 fallback
- **3200+ tests** including 132+ security unit tests and 259+ WebSocket protocol tests

See [Security Guide](docs/security-guide.md) and [Security Architecture](docs/security/) for details.

## Deployment

| Mode | Platform | Guide |
|------|----------|-------|
| **Desktop App** | macOS | [Getting Started](docs/getting-started.md) |
| **Headless / Server** | Linux VPS | [VPS Guide](docs/vps-linux.md) |
| **Self-Hosted** | Docker / systemd | [Self-Hosting](docs/self-hosting.md) |
| **Remote Access** | Tailscale / SSH | [Remote Access](docs/remote-access.md) |

## Screenshots

<p align="center">
  <img src="screenshots/cowork-os-main2.png" alt="Task Timeline" width="700">
  <br><em>Task timeline and execution view</em>
</p>

<p align="center">
  <img src="screenshots/cowork-os-settings1.png" alt="Settings" width="700">
  <br><em>AI provider and channel configuration</em>
</p>

## Roadmap

### Planned

- [ ] VM sandbox using macOS Virtualization.framework
- [ ] Network egress controls with proxy
- [ ] Cross-platform UI support (Windows, Linux)

See [CHANGELOG.md](CHANGELOG.md) for the full history of completed features.

## Documentation

| Guide | Description |
|-------|-------------|
| [Getting Started](docs/getting-started.md) | First-time setup and usage |
| [Use Case Showcase](docs/showcase.md) | Comprehensive guide to what you can build and automate |
| [Features](docs/features.md) | Complete feature reference |
| [OpenClaw Alternative Guide](docs/openclaw-comparison.md) | Respectful category framing for users evaluating an OpenClaw alternative |
| [Channels](docs/channels.md) | Messaging channel setup (14 channels) |
| [Providers](docs/providers.md) | LLM provider configuration |
| [Migration from OpenClaw](docs/migration.md#from-openclaw-to-cowork-os) | Practical checklist for teams moving from OpenClaw to CoWork OS |
| [Development](docs/development.md) | Build from source, project structure |
| [Architecture](docs/architecture.md) | Technical architecture deep-dive |
| [Security Guide](docs/security-guide.md) | Security model and best practices |
| [Enterprise Connectors](docs/enterprise-connectors.md) | MCP connector development |
| [Self-Hosting](docs/self-hosting.md) | Docker and systemd deployment |
| [VPS/Linux](docs/vps-linux.md) | Headless server deployment |
| [Remote Access](docs/remote-access.md) | Tailscale, SSH tunnels, WebSocket API |
| [Knowledge Graph](docs/knowledge-graph.md) | Structured entity/relationship memory |
| [Context Compaction](docs/context-compaction.md) | Proactive session compaction with structured summaries |
| [Mission Control](docs/mission-control.md) | Agent orchestration dashboard |
| [Plugin Packs](docs/plugin-packs.md) | Plugin platform, Customize panel, and Plugin Store |
| [Admin Policies](docs/admin-policies.md) | Enterprise admin policies and organization pack management |
| [Digital Twins](docs/digital-twins.md) | Role-based AI twin personas and cognitive offload |
| [Digital Twins Guide](docs/digital-twin-personas-guide.md) | Comprehensive guide with scenarios and expanded job areas |
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
