<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="screenshots/cowork-os-sl-dark-logo.png">
    <source media="(prefers-color-scheme: light)" srcset="screenshots/cowork-os-sl-color-logo.png">
    <img src="screenshots/cowork-os-sl-color-logo.png" alt="CoWork OS" width="600">
  </picture>
</p>

<p align="center">
  <strong>CoWork OS is a local-first option for production workflows.</strong><br>
  Security-hardened, local-first AI operating system — 34 LLM provider options, 17 messaging channels, 140 built-in skills
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
  <a href="docs/release-notes-0.5.40.md">Release Notes 0.5.40</a> &middot;
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

- **Inbox Agent** — local-first email workspace with Classic and Today modes, AI triage, Mailbox Ask, manual reply/reply-all/forward, editable AI drafts, sender cleanup, commitments, and background sync.
- **Workflow Intelligence** — Always-on cognition is now framed as one reviewable loop: Memory is the source of truth, Heartbeat schedules reflection, Reflection evaluates evidence internally, and Suggestions are the user-facing output.
- **Digital Twin Personas** — Pre-built opt-in persona presets for every role. Twins stay visible and activatable, but they no longer own heartbeat, workflow-intelligence, or memory runtime state.
- **Zero-Human Company Ops** — Configure CoWork OS as a founder-directed autonomous company shell with venture workspace kits, automation-profile-backed operator agents, strategic planner loops, and Mission Control ops monitoring.
- **Managed Devices** — Run and inspect tasks across saved remote machines from a dedicated Devices tab with connection controls, summaries, remote task feeds, and remote file attachment picking.
- **Automations Control Center** — A single Automations section now separates Core Automation, Triggered Work, Remote/Device Work, and optional Twin surfaces instead of blending them into one runtime.
- **34 LLM provider options** — 13 built-in providers plus 21 compatible/gateway options, including Claude, OpenAI, Google, Ollama, AWS Bedrock, and OpenRouter. Bring your own keys or run local models.
- **17 messaging channels** — WhatsApp, Telegram, Discord, Slack, Teams, Google Chat, Feishu/Lark, WeCom, iMessage, Signal, X, and more. Chat with your AI from anywhere.
- **44 MCP connectors** — Pre-built enterprise integrations across CRM, support, productivity, analytics, and payments, with native connector support for the most common internal surfaces.
- **18 bundled role-specific packs** — including Mobile Development, Game Development, and 5 Financial packs, with 55+ skills, in-app Plugin Store for installing community packs, remote registry, and enterprise admin policies for organization-wide control.
- **140 built-in skills** — Documents, code review, web search, image generation, cloud integrations, game development, mobile development, financial analysis, infrastructure-as-code, and more, including bundled workflows such as `llm-wiki` for persistent research vaults, `manim-video` for programmatic technical animation, `kami` for editorial PDFs and slide decks, and `taste-skill` for high-agency frontend design.
- **Profiles & portability** — run separate CoWork profiles with isolated app data, export/import complete profile bundles, and keep credentials, channels, skills, and sessions separated by profile.
- **Active Context sidebar** — Always-visible panel showing 44 available MCP connectors with branded Lucide icons and enabled skills, auto-refreshed every 30 seconds.
- **Agent teams** — Multi-agent collaboration with shared checklists, graph-backed runs, collaborative mode, multi-LLM synthesis, persistent teams, and ACP-targeted delegation for local or remote specialists.
- **External agent orchestration** — Discover ACP agents, delegate work to A2A-compatible remote endpoints, and keep remote calls under the same approval and policy model as other governed actions, with persisted ACP tasks, restart-safe resume, remote cancel support, and the shared orchestration graph as the runtime backbone.
- **Think With Me mode** — Socratic brainstorming that helps you clarify thinking without executing actions.
- **Chat mode** — Direct LLM chat with no tools, no step timeline, same-session follow-ups, and chat-only streaming for supported providers.
- **Build Mode** — Go from idea to working prototype with a phased canvas workflow (Concept → Plan → Scaffold → Iterate) and named checkpoints.
- **AI Playbook** — Auto-captures what worked from successful tasks and injects relevant patterns into future prompts. Repeated patterns auto-promote to governed, one-click-approvable skills via the Playbook-to-Skill pipeline.
- **Evolving Intelligence** — The layered memory runtime keeps curated hot memory prompt-visible by default, leaves archive recall off by default, and adds explicit `search_sessions` / `memory_topics_load` recall paths for recent runs and topical packs. Adaptive Style Engine learns your communication preferences from message patterns and feedback. Evolution Metrics dashboard quantifies improvement over time (correction rate, knowledge growth, style alignment).
- **Operator Runtime Visibility** — Task completion now shows what Cowork learned, semantic batch labels and follow-up completions stay visible, unified recall spans tasks/messages/files, persistent shell sessions preserve operator state, and model routing/fallback is visible in the UI and Mission Control.
- **Chronicle (Desktop Research Preview)** — Opt-in local recent-screen context for vague prompts like “what is this?”, “why is this failing?”, or “sync the latest draft”, with consent-gated passive capture, pause/resume controls, promoted `screen_context` evidence in Mission Control, and optional linked background memory generation. **Documentation:** [docs/chronicle.md](docs/chronicle.md).
- **Configurable fallback chains** — LLM and web-search providers can run in an explicit ordered fallback chain, including Exa for search, immediate failover on retryable provider errors, provider/model-level failover visibility in the UI, and a configurable cooldown before retrying the primary LLM route.
- **Provider-aware prompt caching** — Prompt caching is on by default for supported routes. CoWork keeps stable system sections cacheable, keeps volatile turn context out of the cached prefix, uses Anthropic automatic caching when available, falls back to explicit Claude breakpoints on OpenRouter, and derives stable OpenAI-family cache keys for GPT routes such as Azure `gpt-5.4` / `gpt-5.4-mini`.
- **Usage Insights** — Dashboard showing task stats, cost/token tracking by model, activity heatmaps, top skills, per-pack analytics, per-persona success/retry metrics, and task-result satisfaction signals.
- **ChatGPT History Import** — Import your full ChatGPT conversation history. CoWork OS instantly knows your preferences, past projects, and context — no cold start. All data stays encrypted on your machine and never leaves it.
- **Computer use (macOS)** — Native desktop control via `screenshot`, `click`, `type_text`, `keypress`, and related tools with helper-targeted Accessibility + Screen Recording permissions, single-session sequential execution, **Esc** to abort, screenshot-relative coordinates, and stale-`captureId` protection. Prefer browser and shell tools for web and repo work; computer use is routed as a last-resort lane in policy and planning guidance. **Documentation:** [docs/computer-use.md](docs/computer-use.md).
- **Security-first** — Approval workflows, sandboxed execution, configurable guardrails, encrypted storage, and a verified suite of 4,932 automated tests across 390 test files.
- **Structured guidance** — In plan-mode flows, the agent can pause with short multiple-choice prompts instead of ambiguous free-text follow-ups.
- **Runtime resilience** — Main interactive tasks run without an implicit turn window, while explicit turn caps, lifetime safety fuses, context-overflow recovery, and safe path normalization keep long-running work moving without silent file drift.
- **Local-first & BYOK** — Your data and API keys stay on your machine. No telemetry. No middleman.

### Ideas & Media

Stable workflow entry points for the newest high-impact capabilities.

- **Ideas panel** — curated launchpad of pre-written workflow prompts and capability-aware starting points, with deep links into common tasks.
- **Research vaults (`llm-wiki`)** — first-class workspace-local knowledge bases inspired by Andrej Karpathy's LLM Wiki concept, with deterministic raw-source capture, Obsidian-friendly notes, filed-back outputs, vault search, and vault-health analysis. [Learn more](docs/llm-wiki.md)
- **Document editing sessions** — inline PDF region editing, DOCX block replacement, version browsing, and document-aware file viewing for active editing sessions.
- **Designed editorial documents** — bundled `kami` skill for resumes, one-pagers, white papers, letters, portfolios, diagrams, and slide decks with workspace-local source scaffolding and PDF/PPTX export helpers. [Learn more](docs/skills/kami.md)
- **Rich presentation previews** — generated `.pptx` artifacts open in CoWork with slide thumbnails, slide navigation, extracted speaker notes, and best-effort rendered slide images. If local conversion tools are missing, CoWork still shows text and notes from the deck.
- **Image generation** — configurable provider ordering across Gemini, OpenAI, Azure OpenAI, and OpenRouter.
- **Video generation** — text-to-video and image-to-video routing with polling tools and inline preview.
- **Programmatic technical video** — bundled `manim-video` skill for Manim CE explainers, equation walkthroughs, algorithm visualizations, and animated architecture/data stories. [Learn more](docs/skills/manim-video.md)
- **High-agency frontend design** — bundled `taste-skill` for stricter anti-slop frontend work with stronger layout variance, typography, motion, and implementation rules.

See [Workflow Intelligence](docs/workflow-intelligence.md), [Core Automation](docs/core-automation.md), [I Gave CoWork OS Workflow Intelligence, And Now It Learns From Reviewable Work | Full Guide](docs/continual-learning-in-cowork.md), [Features](docs/features.md), [Heartbeat v3](docs/heartbeat-v3.md), [Providers](docs/providers.md), and [Plugin Packs](docs/plugin-packs.md) for current runtime details.

### Latest Release

**`0.5.40`** packages Chronicle desktop screen context, Workflow Intelligence, routines, AgentMail, the expanded Inbox Agent, Managed Agents Hub improvements, multi-provider image generation, rich PPTX previews, LaTeX/PDF artifacts, and the bundled `kami` and `taste-skill` workflows into the latest release. Start with [Release Notes 0.5.40](docs/release-notes-0.5.40.md), then [Features](docs/features.md), [Getting Started](docs/getting-started.md), [Channels](docs/channels.md), and the [Changelog](CHANGELOG.md).

## Quick Start

### Download the App

Download the latest release from [GitHub Releases](https://github.com/CoWork-OS/CoWork-OS/releases/latest):

| Platform | Download | Install |
|----------|----------|---------|
| **macOS** | `.dmg` | Drag CoWork OS into Applications |
| **Windows** | `.exe` (NSIS installer) | Run the installer and follow the prompts |

> **macOS first launch:** The app is currently unsigned. On first open, macOS will block it — go to **System Settings > Privacy & Security > Open Anyway**, or run: `xattr -dr com.apple.quarantine "/Applications/CoWork OS.app"`
> Release maintainers can create this fallback build with `npm run package:mac:unsigned`; signed/notarized builds require an explicit `.env.mac` signing identity.

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

Task-based execution with dynamic re-planning, five runtime modes (Chat, Execute, Plan, Analyze, Verified) plus orchestration toggles (Autonomous, Collaborative, Multi-LLM, Think With Me), a shared turn kernel, metadata-driven tool scheduling, graph-backed delegation, typed worker roles, optional workflow-pipeline execution with per-phase model routing, agent teams with persistence, agent comparison, git worktree isolation, AI playbook, and performance reviews. [Learn more](docs/features.md#agent-capabilities)

Skills now follow an additive runtime model: CoWork can proactively shortlist or apply a relevant skill, but the original task remains canonical. Skills add context and scoped execution modifiers instead of replacing the task prompt. [Learn more](docs/skills-runtime-model.md)

### Chronicle (Desktop Research Preview)

Chronicle is an opt-in desktop-only recent-screen context lane for vague on-screen references such as `this`, `that`, `the failing one`, `latest draft`, or `why is this failing`. Configure it from **Settings > Memory Hub > Chronicle**: passive capture is consent-gated, can be paused from Settings or the tray, resolves through `screen_context_resolve`, and promotes only task-used observations into existing recall, evidence, and optional linked `screen_context` memory entries instead of creating a second memory system. [Learn more](docs/chronicle.md)

### Research Vaults (`llm-wiki`)

CoWork OS includes `llm-wiki` as a bundled, first-class research-vault workflow inspired by Andrej Karpathy's LLM Wiki idea: keep a `/raw` corpus, build durable linked notes on top, and make the result easy for agents to traverse later.

You can launch it from the GUI with a normal prompt such as `Build a persistent Obsidian-friendly research vault for GRPO papers`, from the welcome/onboarding starter cards, or with `/llm-wiki` when you want explicit slash syntax.

`llm-wiki` creates and maintains a workspace-local markdown wiki with:

- immutable `raw/` source captures
- deterministic ingest helpers for articles, papers, repos, datasets, and images
- durable Obsidian-friendly notes and maps
- deterministic vault-first search across notes, raw captures, and filed slide decks
- filed-back Marp slide decks and SVG charts under `outputs/`
- `SCHEMA.md`, `index.md`, `log.md`, and `inbox.md`
- a GUI vault browser on the welcome screen for core files, recent notes, recent queries, outputs, and raw captures
- deterministic vault analysis for orphans, broken links, bridge pages, surprising cross-section links, and suggested follow-up questions

It works in desktop and gateway channels, supports inline chaining, and writes inspectable run artifacts alongside the persistent vault. GUI-first prompts can start the flow even before you supply a topic, in which case CoWork asks one short scoping question first. [Learn more](docs/llm-wiki.md)

Operator Runtime Visibility makes the runtime's learning and routing visible: task detail surfaces now show the learning progression, unified recall spans tasks/messages/files/workspace notes/memory/KG, shell sessions preserve operator state, and live routing/fallback events are surfaced in Mission Control and the task UI. [Learn more](docs/operator-runtime-visibility.md)

Workflow Intelligence reflections now use the same runtime with stricter safeguards: they start only after memory services are initialized, write durable target-scoped artifacts under `.cowork/subconscious/` for compatibility, default to reviewable suggestions, learn from act/edit/snooze/dismiss/ignore feedback, require isolated git worktrees for trusted code-change auto-create paths, and skip non-git workspaces when isolation is required. See [Workflow Intelligence](docs/workflow-intelligence.md) and [Troubleshooting](docs/troubleshooting.md#workflow-intelligence-startup-warnings-in-development).

### Output Completion UX

Completion state and file availability are now explicit:

- **High-signal completion toast**: finished tasks with outputs show `Task complete` with filename/count and actions for **Open file**, **Show in Finder**, and **View in Files**
- **Right-sidebar focus**: if you are viewing the completed task and the panel is collapsed, the Files panel auto-opens and highlights the primary output
- **Unseen-output badge**: if completion happens in another task/view, the collapsed right-panel toggle shows a numeric badge until you open Files
- **Filename-first rows with clear location context**: Files rows stay filename-only, with output folder context shown separately (or **Workspace root**)
- **Artifact parity**: artifact-only outputs are treated the same as normal file outputs in completion toasts, timeline details, and Files panel
- **LaTeX/PDF artifact workbench**: explicit LaTeX/TikZ paper tasks can write `.tex`, compile it with a system TeX engine, and show the source plus rendered PDF together with Summary, source, and PDF tabs
- **Presentation previews**: `.pptx` outputs show inline deck cards in task events and open into a slide viewer with thumbnails, previous/next navigation, zoom, and speaker notes
- **Semantic completion labels**: completed tool batches and verifier verdicts now feed the richer completion text shown in timelines, feed relays, and export surfaces

### Guided Input & Runtime Recovery

Long-running tasks now have clearer operator handoffs and stronger recovery defaults:

- **Structured input cards**: plan-mode tasks can pause with 1-3 short multiple-choice prompts, with answers captured inline in the desktop UI or via the Control Plane web dashboard
- **Adaptive turn recovery**: main execute-mode tasks are uncapped at the turn-window level by default, still reserve room for a final answer, and use lifetime/emergency safety stops plus bounded follow-up recovery instead of strategy-assigned `30/30` style windows; explicit `maxTurns` / `windowTurnCap` still opt tasks into capped behavior
- **Context overflow retry**: context-capacity failures trigger compaction and retry instead of immediate hard failure when the model context window is exceeded
- **Path repair**: `/workspace/...` aliases and drifted relative paths can be normalized back into the active workspace or pinned task root, with strict-fail policies available when you want hard enforcement
- **Parallel timeline lanes**: read-only tool batches render as grouped timeline rows so the UI stays readable even when searches/fetches run concurrently

### Mission Control

Centralized orchestration and monitoring cockpit with a Kanban board, real-time activity feed, core automation profile visibility, and a `Core Harness` view for traces, failure clusters, evals, experiments, and learnings. [Learn more](docs/mission-control.md) | [Core Automation](docs/core-automation.md)

### Devices

The Devices tab turns CoWork OS into a multi-machine control surface. Save and reconnect remote CoWork nodes, inspect device summaries (activity, apps, storage, alerts, resource signals), launch tasks against a selected machine, browse that machine's remote workspaces, and attach files directly from the remote filesystem before dispatching a task. [Learn more](docs/remote-access.md)

### Automations

Automations are now organized around a hard boundary: **Workflow Intelligence** is the always-on cognitive loop, while `Routines` are the main saved-automation product layered on top of lower-level execution surfaces. `Scheduled Tasks`, `Webhooks`, and `Event Triggers` still exist, but they now also serve as advanced or compiled backends for routines rather than competing first-class automation concepts. The home dashboard, welcome-screen Next actions, and routines panel surface recent automation suggestions/runs so you can monitor background systems without hunting through tabs. [Learn more](docs/core-automation.md)

### Zero-Human Company Ops

CoWork OS can be configured as a founder-operated autonomous company shell: venture workspace kit context, a dedicated `Settings > Companies` control surface, company-linked operator agents, automation profiles, strategic planner issue generation, and Mission Control ops monitoring. Create the company in `Companies`, activate operator personas such as `Company Planner` and `Founder Office Operator`, then attach automation where needed and monitor the company loop from Mission Control. [Learn more](docs/zero-human-company.md) | [Core Automation](docs/core-automation.md)

### Digital Twin Personas

Role-specific AI twins that handle cognitive overhead as optional persona presets. Pick a template (Software Engineer, Engineering Manager, Product Manager, VP, Founder Office Operator, Company Planner, and more), customize it, and activate it as a role preset with recommended skills and prompt/personality defaults. Twins can be linked to a company for company-aware operations, but they no longer own heartbeat or Workflow Intelligence policy directly. [Learn more](docs/digital-twins.md)

### Live Canvas & Build Mode

Agent-driven visual workspace for interactive HTML/CSS/JS content, data visualization, and iterative image annotation. **Build Mode** adds a phased idea-to-prototype workflow with named checkpoints and revert support. [Learn more](docs/live-canvas.md)

### Multichannel Gateway

Unified AI gateway across 17 channels with security modes, rate limiting, ambient mode, scheduled tasks, and chat commands. Slack now supports multiple workspaces, Telegram supports group-routing policies and allowlists, Discord can be limited to specific guilds, and Feishu/Lark plus WeCom are now first-class channels. [Learn more](docs/channels.md)

### Inbox Agent

Local-first inbox workspace that turns email into an action queue while preserving normal email-client controls. It keeps cached mail visible on restart, syncs in the background, supports manual reply/reply-all/forward, and surfaces the right next step for each thread: triage, draft, cleanup, commitment tracking, and scheduling. [Learn more](docs/inbox-agent.md)

- **Classic + Today modes**: use the familiar three-pane inbox or the Today lanes for Needs action, Happening today, Good to know, and More to browse
- **Action cards**: Unread, Needs reply, Suggested Actions, Open Commitments
- **Mailbox views**: Inbox, Sent, All, plus Recent/Priority sorting, saved views, account filters, and practical domain filters
- **Normal email actions**: manual Reply, Reply all, Forward, To/Cc/Bcc, editable subject/body, and provider-backed send
- **AI draft handling**: generated replies are editable before send, and sent drafts disappear after successful send
- **Mailbox Ask**: search local mailbox evidence and indexed attachment text, with LLM summaries when configured
- **Workflow buttons**: Cleanup, Follow-up, Reply, Forward, Mark done, Prep thread, Extract todos, Schedule, Refresh intel
- **Gmail auto-forwarding**: create forwarding automations from a Gmail thread with dry-run support, attachment filters, per-message dedupe, and thread-scoped execution
- **Commitment tracking**: accept commitments into real follow-up tasks, mark already-handled threads done, or dismiss items
- **Background sync**: load from the local database immediately and refresh in the background without blanking the inbox on restart

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
- **44 MCP Connectors**: pre-built enterprise integrations for CRM, support, productivity, analytics, and payments (Salesforce, Jira, HubSpot, Zendesk, Stripe, Tavily, Grafana, Metabase, Socket, and more), with connector notifications available as trigger inputs for automations
- **Developer Tools**: `glob`/`grep`/`edit_file`, Playwright browser automation, MCP client/host/registry

[Learn more](docs/features.md)

### Active Context Sidebar

Real-time overview of your active integrations, always visible in the right panel. Shows connected MCP connectors (44 available) and native integrations with branded Lucide icons (HubSpot, Salesforce, Google Workspace, Discord, GitHub, Postgres, and more) and green status dots, plus enabled skills from active packs. Each section shows 4 items with internal scrolling for more. Auto-refreshes every 30 seconds. [Learn more](docs/plugin-packs.md#context-panel)

### Usage Insights

Dashboard with task metrics, cost/token tracking by model, prompt-cache read telemetry (`cachedTokens` and cache-read rate where available), activity heatmaps (day-of-week and hourly), top skills usage, per-pack analytics, persona-level success/retry/cost breakdowns, and task-result thumbs up/down quality signals with 7/14/30-day period selection. Access from **Settings** > **Usage Insights**. [Learn more](docs/features.md#usage-insights)

### LLM Providers

34 provider options, with 13 built-in providers and 21 compatible/gateway providers. Use cloud APIs or run fully offline with Ollama, configure an ordered fallback chain for runtime failover, and get default-on prompt caching on supported Claude and GPT-style routes. Claude supports both direct API keys and Claude subscription tokens from `claude setup-token`, with live **Refresh Models** support in Settings. [Learn more](docs/providers.md)

### Plugin Platform & Customize

Unified plugin platform with 18 bundled role-specific packs (Engineering, DevOps, Product, Sales, QA, Finance, and more), each bundling skills, agent roles, connectors, and "Try asking" prompts. Packs can link to Digital Twin personas as optional role presets.

- **Search & filter**: Real-time sidebar search across pack names, descriptions, categories, and skill names
- **Per-skill control**: Enable or disable individual skills within a pack without toggling the whole pack
- **Persistent toggles**: Pack and skill states survive app restarts
- **Update detection**: Background version checks against the registry with visual indicators
- **"Try asking" in chat**: Empty chat shows randomized prompt suggestions from active packs
- **Plugin Store**: In-app marketplace for browsing, installing (Git/URL), and scaffolding custom packs, now with install-time security scanning and quarantine handling for imported packs
- **Skill Store & external skills**: Desktop GUI support for CoWork Registry skills, direct ClawHub installs, and generic external skill imports from Git repos, raw manifests, and `SKILL.md` bundles, with managed scan reports and quarantine for unsafe imports
- **External skill directories**: Add shared read-only skill folders without importing or copying those skills into CoWork's managed directory
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

- **140 built-in skills** across developer, productivity, communication, documents, game development, mobile development, financial analysis, infrastructure-as-code, and more
- **Custom skills** in `~/Library/Application Support/cowork-os/skills/` (macOS) or `%APPDATA%\cowork-os\skills\` (Windows)
- **18 bundled plugin packs** with 55+ role-specific skills and Digital Twin integration
- **Plugin Store** — browse, install from Git/URL, scaffold custom packs, and review quarantine/report state for imported packs
- **Skill Store** — browse CoWork Registry skills, search ClawHub, import external skills from Git, raw JSON, or raw `SKILL.md`, and review quarantine/report state for imported skills
- **MCP support** — client, host, and registry

### Voice Mode

Text-to-speech (ElevenLabs, OpenAI, Web Speech API), speech-to-text (Whisper), and outbound phone calls. [Learn more](docs/features.md#voice-mode)

### Knowledge Graph

Built-in structured entity and relationship memory backed by SQLite. The agent builds a knowledge graph of your workspace — people, projects, technologies, services, and their relationships — with 10 dedicated tools, FTS5 search, multi-hop graph traversal, temporal validity on edges (`valid_from` / `valid_to`), historical `as_of` queries, auto-extraction from task results, and confidence scoring with decay. [Learn more](docs/knowledge-graph.md)

### Memory & Context

Persistent memory with privacy protection, FTS5 search, LLM compression, and a contract-driven workspace kit (`.cowork/`) for durable human-edited context. The runtime now makes memory explicit as a four-layer wake-up model: `L0 Identity` and `L1 Essential Story` are prompt-visible by default, while `L2 Topic Packs` and `L3 Deep Recall` stay tool-driven through `memory_topics_load`, `search_sessions`, `search_memories`, and exact-span `search_quotes`. Runtime-native checkpoints capture both compact structured summaries and verbatim evidence packets before compaction, on meaningful task completion, and periodically during long runs.

The workspace kit separates workspace-wide files such as `AGENTS.md`, `USER.md`, `MEMORY.md`, `TOOLS.md`, `SOUL.md`, `IDENTITY.md`, `RULES.md`, `VIBES.md`, and `LORE.md` from project-scoped files such as `.cowork/projects/<projectId>/CONTEXT.md` and `.cowork/projects/<projectId>/ACCESS.md`. Special files get dedicated lifecycle handling: `BOOTSTRAP.md` is a one-time onboarding checklist tracked through `.cowork/workspace-state.json`, while `HEARTBEAT.md` is reserved for recurring Heartbeat v3 checklist work instead of general task context.

Every tracked file follows a shared parser/linter model with freshness windows, secret detection, missing-file status, and revision snapshots stored under `.cowork/**/.history/`. Workspace kit health is surfaced in the app and can be checked locally with `npm run kit:lint` for human-readable output or JSON export. **Import your ChatGPT history** to eliminate the cold-start problem — CoWork OS knows you from day one. All imported data is stored locally and encrypted on your machine. **Optional Supermemory integration** adds an external provider lane with `supermemory_profile`, `supermemory_search`, `supermemory_remember`, and `supermemory_forget`, plus optional prompt-time profile injection and background mirroring of non-private local memory captures. **Proactive session compaction** automatically generates comprehensive structured summaries when context reaches 90% capacity, and checkpoint capture preserves exact supporting spans so recall quality survives compaction. [Learn more](docs/features.md#persistent-memory-system) | [Supermemory](docs/supermemory.md) | [Context Compaction](docs/context-compaction.md)

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
- **4,932 automated tests** in the suite across **390 test files** (`4,854 passed`, `78 skipped`), including **135+** security unit tests under `tests/security/` and **250+** control-plane and WebSocket protocol tests

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
| [Beginner's Guide](docs/cowork-school.md) | Practical guide to what CoWork OS is for and which workflows to try first |
| [Release Notes 0.5.19](docs/release-notes-0.5.19.md) | What is new in the latest release |
| [Use Case Showcase](docs/showcase.md) | Comprehensive guide to what you can build and automate |
| [Features](docs/features.md) | Complete feature reference |
| [Chat Mode](docs/chat-mode.md) | Direct chat-only mode with no tools and same-session follow-ups |
| [Platform Updates](docs/integration-skill-bootstrap-lifecycle.md) | Detailed implementation notes for integration setup, skill proposals, workspace-kit contracts, and bootstrap lifecycle |
| [Channels](docs/channels.md) | Messaging channel setup (17 channels) |
| [X Mention Triggers](docs/x-mention-triggers.md) | Configure `do:` mention-triggered task ingress on desktop and headless |
| [Providers](docs/providers.md) | LLM and search provider configuration, costs, and fallback chains |
| [Migration Guide](docs/migration.md) | Migration checklist and compatibility notes |
| [Development](docs/development.md) | Build from source, project structure |
| [Architecture](docs/architecture.md) | Technical architecture deep-dive |
| [Skills Runtime Model](docs/skills-runtime-model.md) | Canonical prompt invariant, additive skill application, routing shortlist model, and `use_skill` contract |
| [LLM Wiki](docs/llm-wiki.md) | First-class research vault workflow, slash syntax, vault layout, analyzer outputs, and Obsidian-friendly knowledge-base behavior |
| [Kami Skill](docs/skills/kami.md) | Bundled editorial document workflow for resumes, one-pagers, white papers, diagrams, and slide decks |
| [manim-video Skill](docs/skills/manim-video.md) | Bundled Manim CE workflow for technical animation, project scaffolding, and draft-to-production render flow |
| [Workflow Intelligence](docs/workflow-intelligence.md) | Memory + Heartbeat + Reflection + Suggestions model, reviewable outputs, and feedback learning |
| [Core Automation](docs/core-automation.md) | Runtime boundary for Workflow Intelligence, automation profiles, and the core harness |
| [Heartbeat v3](docs/heartbeat-v3.md) | Default two-lane heartbeat architecture, signals, Pulse, Dispatch, and automation-profile-backed operator semantics |
| [Security Guide](docs/security-guide.md) | Security model and best practices |
| [Enterprise Connectors](docs/enterprise-connectors.md) | MCP connector development |
| [Self-Hosting](docs/self-hosting.md) | Docker and systemd deployment |
| [VPS/Linux](docs/vps-linux.md) | Headless server deployment |
| [Remote Access](docs/remote-access.md) | Tailscale, SSH tunnels, WebSocket API |
| [Knowledge Graph](docs/knowledge-graph.md) | Structured entity/relationship memory |
| [Context Compaction](docs/context-compaction.md) | Proactive session compaction with structured summaries and chat-history summarization |
| [Mission Control](docs/mission-control.md) | Agent orchestration dashboard |
| [Subconscious Loop](docs/subconscious-loop.md) | Compatibility redirect for the former name of Workflow Intelligence |
| [Zero-Human Company Ops](docs/zero-human-company.md) | Founder-directed company planning, operators, and Mission Control ops workflows |
| [Plugin Packs](docs/plugin-packs.md) | Plugin platform, Customize panel, and Plugin Store |
| [Skill Store & External Skills](docs/skill-store-and-external-skills.md) | ClawHub support, external skill imports, and managed-skill install flows |
| [Best-Fit Workflows](docs/best-fit-workflows.md) | Support Ops, IT Ops, and Sales Ops — where CoWork OS delivers the strongest ROI |
| [Admin Policies](docs/admin-policies.md) | Enterprise admin policies and organization pack management |
| [Digital Twins](docs/digital-twins.md) | Optional role-based persona presets and cognitive offload without core-runtime ownership |
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
