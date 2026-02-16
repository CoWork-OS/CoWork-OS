# CoWork OS Reference (What It Is, What It Does, How It Works)

This is the **living reference** for CoWork OS.

- Audience: contributors and power users who want a single place to understand the system.
- Scope: product capabilities, architecture, major subsystems, data storage, security model, and repo map.
- Update rule: **if a change affects behavior, capabilities, defaults, or architecture, update this file in the same PR**.
- Note: this file is also used as an optional "map" for the Memory Kit context injector (`src/electron/memory/WorkspaceKitContext.ts`), so keep the top section high-signal.

If you are looking for setup and usage docs first, start with:
- `README.md`
- `GETTING_STARTED.md`

## What CoWork OS Is

CoWork OS is a **local-first, security-first desktop runtime** for running AI agents with:
- A task execution engine (plan -> execute -> observe loops)
- A tool runtime (file ops, web, browser automation, shell, integrations)
- Messaging gateways (WhatsApp/Telegram/Discord/Slack/Teams/etc.) so you can interact with your agent remotely
- Extensibility via MCP (Model Context Protocol) servers and connectors

The app is built as an **Electron main process** (backend/orchestration) plus a **React renderer** (UI).

CoWork OS also supports **server/headless deployments** intended for Linux VPS installs:

- Headless Electron daemon: `bin/coworkd.js`
- Node-only daemon (no Electron/Xvfb): `bin/coworkd-node.js` (entry: `src/daemon/main.ts`)

See: `docs/vps-linux.md`.

## What CoWork OS Can Do (Capabilities)

### 1. Run Tasks (Agent Runtime)

- Create tasks in a selected **workspace folder** and watch execution via an event timeline.
- Execute steps by calling tools (file ops, browser automation, search, connectors, etc.).
- Pause for **approvals** before destructive or high-risk actions.

Key code:
- Agent orchestration: `src/electron/agent/daemon.ts`, `src/electron/agent/executor.ts`, `src/electron/agent/queue-manager.ts`
- Tool runtime: `src/electron/agent/tools/registry.ts`

#### Intent Routing & Strategy Layer

Each task prompt is classified by `IntentRouter` into one of five intent types (`chat`, `advice`, `planning`, `execution`, `mixed`) with a confidence score. `TaskStrategyService` then derives execution defaults (conversation mode, max turns, quality passes, answer-first bias, bounded research, timeout-finalize bias) from the classified intent. Strategy is applied at task creation in the daemon and re-applied when queued tasks are dequeued.

Key code:
- Intent classifier: `src/electron/agent/strategy/IntentRouter.ts`
- Strategy service: `src/electron/agent/strategy/TaskStrategyService.ts`
- Strategy integration: `src/electron/agent/daemon.ts` (task creation), `src/electron/agent/context-manager.ts` (context injection)

#### Completion Contract & Timeout Recovery

The executor tracks cancellation reasons (`user`, `timeout`, `shutdown`, `system`) and uses a completion-first approach where the agent is biased to provide an answer before performing tool work. On timeout, `finalizeWithTimeoutRecovery()` attempts a best-effort finalization pass that produces a partial answer rather than an empty failure. Retry logic includes adaptive token capping (`applyRetryTokenCap`) and timeout scaling (`getRetryTimeoutMs`) informed by observed output tokens/sec.

Key code:
- Timeout recovery: `src/electron/agent/executor.ts` (`finalizeWithTimeoutRecovery`, `finalizeTaskBestEffort`, `buildTimeoutRecoveryAnswer`)
- Retry helpers: `src/electron/agent/executor.ts` (`applyRetryTokenCap`, `getRetryTimeoutMs`, `isAbortLikeError`)

### 2. Use Tools and Skills

CoWork OS exposes "tools" to the agent. Tools include:
- Filesystem: read/write/list/rename/delete, safe path handling
- Code navigation/editing: `glob`, `grep`, `edit_file`
- Web search + web fetch (multi-provider)
- Browser automation (Playwright)
- Shell execution (sandboxed + approvals)
- Vision: analyze workspace images (screenshots/photos) via `analyze_image`
- Image generation: `generate_image` with multi-provider support (Gemini, OpenAI, Azure OpenAI) and automatic provider selection
- Visual annotation: `visual_open_annotator` / `visual_update_annotator` for iterative image refinement via Live Canvas
- Apple Calendar: create, update, delete calendar events via `apple_calendar_action` (macOS AppleScript)
- Apple Reminders: create, complete, update, list reminders via `apple_reminders_action` (macOS AppleScript)
- Integrations: Google Drive/Gmail/Calendar, Dropbox, Box, OneDrive, SharePoint, Notion
- MCP tools from external MCP servers

Headless mode:
- When running in headless/daemon mode, `SystemTools.getToolDefinitions({ headless: true })` returns a reduced subset (system_info, get_env, get_app_paths, search_memories) — clipboard, screenshot, open_application, open_url, and other desktop-only tools are excluded.

Key code:
- Tool registry and execution: `src/electron/agent/tools/registry.ts`
- Apple Calendar tools: `src/electron/agent/tools/apple-calendar-tools.ts`
- Apple Reminders tools: `src/electron/agent/tools/apple-reminders-tools.ts`
- Image generation: `src/electron/agent/skills/image-generator.ts`
- Visual annotation tools: `src/electron/agent/tools/visual-tools.ts`
- Sandbox runner: `src/electron/agent/sandbox/runner.ts`
- Built-in skill definitions (prompted workflows): `resources/skills/`
- Skill loading precedence: `src/electron/agent/custom-skill-loader.ts`

Notes on "skills":
- Skills are JSON files (`*.json`) that define reusable workflows/prompts.
- Skill sources and precedence (highest wins):
  - Workspace skills: `<workspace>/skills/`
  - Managed skills: Electron `userData/skills/` (on macOS typically `~/Library/Application Support/cowork-os/skills/`)
  - Bundled skills: `resources/skills/` (includes use-case templates: booking options, draft reply, family digest, household capture, newsletter digest, transaction scan, inbox manager, chief-of-staff briefing, smart-home brain, dev task queue, figure-it-out agent)

### 3. Messaging Gateway (Channels)

CoWork OS can run as a multi-channel gateway, letting users message the agent via supported platforms.

Implemented channel adapters live in: `src/electron/gateway/channels/`

Current built-in channels (see files in that folder):
- WhatsApp
- Telegram
- Discord
- Slack
- Microsoft Teams
- Google Chat
- iMessage
- Signal
- Mattermost
- Matrix
- Twitch
- LINE
- BlueBubbles
- Email

Core gateway code:
- Gateway manager: `src/electron/gateway/index.ts`
- Router: `src/electron/gateway/router.ts`
- Shared channel types: `src/electron/gateway/channels/types.ts`

Channel commands (chat):
- `/inbox [triage|autopilot|followups] [limit]` runs DM-only inbox triage workflow with confirmation gates for external actions.
- `/brief [morning|today|tomorrow|week]` generates a DM-only chief-of-staff style brief.
- `/schedule ...` creates scheduled agent tasks that deliver results back to the originating chat (works in DM + group contexts).
- `/digest [lookback]` generates an on-demand digest of recent chat messages (group-safe; uses the local channel message store).
- `/followups [lookback]` extracts follow-ups/commitments from recent chat messages (group-safe; uses the local channel message store).
- `/activation [on|off]` toggles channel activation state.
- `/memorytrust [on|off]` toggles memory trust for the channel (controls whether agent stores memories from this channel).
- `/selfchat [on|off]` toggles self-message capture mode.
- `/ambient [on|off]` toggles ambient mode (ingest-only, no agent replies for non-command messages).
- `/ingest [on|off]` toggles ingest-only mode for the channel.
- `/prefix [text|clear]` sets or clears a response prefix for agent replies on this channel.
- `/numbers` lists allowed phone numbers for the channel.
- `/allow <number>` adds a phone number to the channel allowlist.
- `/disallow <number>` removes a phone number from the channel allowlist.

Attachment handling:
- If an inbound channel message includes `attachments`, the gateway persists them under `<workspace>/.cowork/inbox/attachments/...`
- The persisted workspace paths are appended into the task prompt so agents can inspect them with normal file tools (and `analyze_image` for images)
- File extraction supports DOCX/PDF/PPTX content, and local image previews can optionally run OCR when `tesseract` is available

Channel operational modes:
- **Ambient mode**: When `ambientMode` is enabled on a channel config, all non-slash-command messages are ingested (persisted to the local message store) but NOT routed to the agent. Slash commands and pairing codes still pass through. Unauthorized messages are silently dropped (no error reply).
- **Self-message capture**: Channels with `captureSelfMessages` enabled (WhatsApp, iMessage, BlueBubbles) ingest outgoing user messages as `direction: 'outgoing_user'` with `ingestOnly: true`, providing conversation context without triggering reply loops.

Security modes commonly used by channels:
- `pairing`: require a pairing code
- `allowlist`: require explicit allowlisting
- `open`: no pairing/allowlist gate (still subject to tool policy)

Per-context policy:
- CoWork OS supports different tool/security restrictions for DM vs group contexts.
- See: `docs/security/trust-boundaries.md` and `src/electron/security/policy-manager.ts`

### 4. LLM Providers (BYOK) + Search Providers

LLM providers are configured in Settings (encrypted at rest) and billed directly by the provider.

Provider code:
- LLM providers: `src/electron/agent/llm/`
- LLM provider types: `src/shared/types.ts` (`LLM_PROVIDER_TYPES`)
- Search providers: `src/electron/agent/search/`

### 5. MCP (Model Context Protocol)

CoWork OS supports MCP in two directions:
- **MCP client**: connect to external MCP servers and import their tools into the agent
- **MCP host**: expose CoWork OS tools as an MCP server (stdio)

Key code:
- MCP client: `src/electron/mcp/client/`
- MCP host server: `src/electron/mcp/host/MCPHostServer.ts`
- Registry/one-click installs: `src/electron/mcp/registry/MCPRegistryManager.ts`

Enterprise connectors included in this repo (as MCP servers):
- `connectors/*-mcp/` (Salesforce, Jira, HubSpot, Zendesk, ServiceNow, Linear, Asana, Okta, Resend)
- Reference doc: `docs/enterprise-connectors.md`

### 6. Memory System (Local-First)

CoWork OS can store and retrieve local memories per workspace, with:
- Auto-capture from task execution
- Privacy protection (sensitive detection, private memories)
- Search + progressive retrieval
- Optional workspace kit (`.cowork/`) initialization + indexing for durable human-edited context
- Project contexts under `.cowork/projects/<projectId>/` with per-project access rules
- ChatGPT export import (distilled via LLM, stored locally)
- Cross-workspace search for imported ChatGPT memories (`searchImportedGlobal`)
- Local vector embeddings for memory similarity (no external API required)

Key code:
- Memory service: `src/electron/memory/MemoryService.ts`
- Local embeddings: `src/electron/memory/local-embedding.ts`
- Workspace kit extraction: `src/electron/memory/WorkspaceKitContext.ts`
- Markdown indexing + redaction: `src/electron/memory/MarkdownMemoryIndexService.ts`
- ChatGPT importer: `src/electron/memory/ChatGPTImporter.ts`
- Embedding repository: `src/electron/database/repositories.ts` (`MemoryEmbeddingRepository`)
 - Project access rules: `src/electron/security/project-access.ts`

Docs:
- Security-focused memory guidance: `docs/security/best-practices.md`
- Relationship agent architecture: `docs/relationship-agent-architecture.md`

#### Relationship Memory

Layered continuity memory that persists user identity, preferences, working context, interaction history, and commitments across sessions. `RelationshipMemoryService` manages five memory layers with upsert deduplication and builds a prompt context block injected into task execution. `UserProfileService` extracts user facts from messages and feedback, compositing them with relationship memory for personalization. The daemon records relationship memory entries on task completion.

Key code:
- Relationship memory: `src/electron/memory/RelationshipMemoryService.ts`
- User profile extraction: `src/electron/memory/UserProfileService.ts`
- IPC handlers: `src/electron/ipc/handlers.ts` (`memory:relationshipList`, `memory:relationshipUpdate`, `memory:relationshipDelete`, `memory:commitmentsGet`, `memory:commitmentsDueSoon`)
- UI: `src/renderer/components/MemorySettings.tsx`

### 7. Live Canvas (Agent-Driven UI)

Live Canvas lets agents render and interact with dynamic HTML/CSS/JS during a task (with in-app preview).

Docs:
- `docs/live-canvas.md`

Code:
- Canvas runtime: `src/electron/canvas/`
- IPC handlers: `src/electron/ipc/canvas-handlers.ts`

### 8. Scheduling (Cron) + Webhook Ingress (Hooks)

Scheduling:
- Cron jobs can create tasks on schedules (`at`, `every`, `cron`) and optionally deliver results to channels.
- When scheduling from the global temp workspace, a dedicated managed workspace is auto-created under `<userDataDir>/scheduled-workspaces/` to ensure job persistence.
- Cron webhooks can trigger jobs externally (disabled by default).
- For noisy monitors, delivery can be configured to only post on success when a non-empty result is available (used by `/schedule ... --if-result ...`).
- Job prompts support template variables such as `{{today}}`, `{{tomorrow}}`, `{{week_end}}`, `{{now}}`.
- If a job is configured with channel delivery (for example jobs created via `/schedule`), prompts can also use:
  - `{{chat_messages}}` (recent incoming messages for that chat)
  - `{{chat_since}}`, `{{chat_until}}` (ISO timestamps for the rendered window)
  - `{{chat_message_count}}`, `{{chat_truncated}}`

Code:
- Cron service: `src/electron/cron/service.ts`
- Cron types: `src/electron/cron/types.ts`

Defaults (see `src/electron/main.ts`):
- Cron webhook port: `9876` (disabled by default)

Webhook ingress ("Hooks"):
- Hooks provide a small HTTP server for "wake" and isolated agent runs, plus Gmail watcher support.

Code:
- Hooks server: `src/electron/hooks/server.ts`
- Hooks settings: `src/electron/hooks/settings.ts`
- Hooks types/defaults: `src/electron/hooks/types.ts`

Defaults:
- Hooks port: `9877` (when enabled)
- Hooks base path: `/hooks`

### 9. Control Plane (WebSocket Remote Management)

Control Plane is a local WebSocket server for remote clients (default loopback-only for safety).
It can be exposed via SSH tunnels or Tailscale (Serve/Funnel).

Docs:
- `docs/remote-access.md`

Web UI:
- The control plane serves a built-in HTML dashboard at `/` (same host/port) for headless management.
- Manage LLM setup, tasks, approvals, workspaces, and channels from a browser via SSH tunnel or Tailscale.
- Code: `src/electron/control-plane/web-ui.ts`

Code:
- Control plane server: `src/electron/control-plane/server.ts`
- Control plane protocol: `src/electron/control-plane/protocol.ts`
- Web UI: `src/electron/control-plane/web-ui.ts`
- Tailscale integration: `src/electron/tailscale/`

Defaults:
- Bind host: `127.0.0.1`
- Port: `18789`

Capabilities:
- Operators can manage workspaces and tasks remotely over WebSocket.
- Authentication yields different client roles:
  - `operator` clients get `admin` scope (full task/workspace access, can create/cancel tasks).
  - `node` clients (mobile companions) get `read` scope and receive **redacted** task/workspace views (no prompts, no local filesystem paths).

Key methods (see `src/electron/control-plane/protocol.ts`):
- Workspaces: `workspace.list`, `workspace.get`
- Workspaces (admin): `workspace.create`
- Tasks: `task.create`, `task.get`, `task.list`, `task.cancel`, `task.sendMessage`
- Tasks (admin): `task.events`
- Approvals (admin): `approval.list`, `approval.respond`
- Channels: `channel.list`, `channel.get`
- Channels (admin): `channel.create`, `channel.update`, `channel.test`, `channel.enable`, `channel.disable`, `channel.remove`
- LLM setup (admin): `llm.configure`
- Config/Health: `config.get` (sanitized, no secrets)

Key events:
- `task.event` is broadcast to **operators only** (payloads are sanitized and size-capped).
- Node lifecycle + capability events: `node.connected`, `node.disconnected`, `node.capabilities_changed`, `node.event`.

### 10. Voice

Voice capabilities include:
- TTS/STT in the desktop app (ElevenLabs/OpenAI/Azure depending on settings)
- Outbound phone call tooling via ElevenLabs "ConvAI" endpoints (approval gated)

Code:
- Voice service: `src/electron/voice/VoiceService.ts`
- Phone call tool: `src/electron/agent/tools/voice-call-tools.ts`

### 11. Extensions (Plugin System)

There is a plugin/extension system scaffolded to load `cowork.plugin.json` manifests.
Treat this as **experimental** until the project formally documents/commits to the plugin ABI.

Code:
- Registry/loader/types: `src/electron/extensions/`

### 12. Mission Control (Agent Roles, Heartbeats, Standups, Task Board)

Mission Control is the in-app control surface for managing multiple agent roles and operational workflows:
- Agent roles (persona/model/tool restrictions)
- Heartbeats (scheduled "check-in" runs per agent role)
- Standup reports (daily summaries generated from task state)
- Task subscriptions (agents "watching" tasks/threads)
- Task board (columns/priorities/labels)
- Agentic Tribe (multi-agent collaboration with shared checklists, synchronized run context, and coordinated execution)
- Performance reviews (ratings + autonomy-level recommendations for agent roles)

Key code:
- IPC handlers: `src/electron/ipc/mission-control-handlers.ts`, `src/electron/ipc/handlers.ts`
- Repos/services: `src/electron/agents/`, `src/electron/reports/StandupReportService.ts`, `src/electron/activity/`
- UI: `src/renderer/components/MissionControlPanel.tsx`, `src/renderer/components/AgentRoleEditor.tsx`, `src/renderer/components/TaskBoard.tsx`, `src/renderer/components/StandupReportViewer.tsx`, `src/renderer/components/AgentTeamsPanel.tsx`, `src/renderer/components/AgentPerformanceReviewViewer.tsx`

### 13. Desktop Shell (Tray, Notifications, Updates)

CoWork OS includes standard "app shell" features:
- Menu bar tray icon + quick input window
- Local notification store + system notifications
- Auto-update checks and GitHub releases integration (electron-updater)

Key code:
- Tray: `src/electron/tray/TrayManager.ts`, `src/electron/tray/QuickInputWindow.ts`
- Notifications: `src/electron/notifications/`
- Updates: `src/electron/updater/update-manager.ts`

### 14. Reporting / Export (Local)

CoWork OS includes local task export utilities (intended for reporting/sharing without any "phone home" telemetry).

Key code:
- Task export: `src/electron/reports/task-export.ts`

### 15. Agentic Tribe

There is a "Tribe Lead + Members" model for agentic collaboration with a shared checklist and run lifecycle.
The tribe runtime aligns tool-calling, child-task execution, and task outcomes into a single shared state.

Docs/code:
- Contract: `docs/agent-teams-contract.md`
- Orchestrator: `src/electron/agents/AgentTeamOrchestrator.ts`
- Repos: `src/electron/agents/AgentTeam*Repository.ts`
- UI: `src/renderer/components/AgentTeamsPanel.tsx`

## Security Model (Summary)

CoWork OS is designed with **deny-wins** security policy precedence across multiple layers:
1. Global guardrails (blocked commands/patterns, allowed domains, budgets)
2. Workspace permissions (read/write/delete/shell/network)
3. Context restrictions (DM vs group)
4. Tool-specific rules

Key code:
- Policy engine: `src/electron/security/policy-manager.ts`
- Guardrails settings: `src/electron/guardrails/guardrail-manager.ts`
- Input/output sanitization: `src/electron/agent/security/`
- Secure settings storage: `src/electron/database/SecureSettingsRepository.ts`

Security docs:
- `docs/security/README.md`
- `SECURITY_GUIDE.md`

## Architecture Overview (Component Map)

```mermaid
flowchart LR
  subgraph Renderer["Renderer (React UI)"]
    UI["Task list, timeline, settings, approvals"]
  end

  subgraph Main["Electron Main (Node.js)"]
    DB["SQLite (better-sqlite3)\n+ encrypted settings"]
    Daemon["AgentDaemon\n(task lifecycle)"]
    Exec["TaskExecutor\n(plan/execute/observe)"]
    Tools["ToolRegistry\n+ sandbox + approvals"]
    Gateway["ChannelGateway\n(WhatsApp/Telegram/...)" ]
    MCP["MCP Client/Host\n+ Registry"]
    Memory["Memory Service\n+ Workspace Kit"]
    Cron["Cron Service\n(schedules + webhook triggers)"]
    Hooks["Hooks Server\n(webhook ingress)"]
    CP["Control Plane\n(WebSocket)"]
    Canvas["Live Canvas"]
  end

  UI <--> |IPC (preload context bridge)| Main
  Daemon <--> Exec
  Exec <--> Tools
  Tools <--> DB
  Gateway <--> Daemon
  MCP <--> Tools
  Memory <--> DB
  Cron <--> Daemon
  Hooks <--> Daemon
  CP <--> Daemon
  Canvas <--> Exec
```

Entry points:
- Main process boot: `src/electron/main.ts`
- Renderer boot: `src/renderer/main.tsx`
- IPC bridge: `src/electron/preload.ts`
- Node daemon boot: `src/daemon/main.ts` (non-Electron headless)
- CLI entry: `bin/coworkd.js` (headless Electron), `bin/coworkd-node.js` (Node-only), `bin/coworkctl.js` (control client)

Headless credential import:
- When `COWORK_IMPORT_ENV_SETTINGS=1` is set, `importProcessEnvToSettings()` reads LLM and search provider keys from environment variables (e.g. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `TAVILY_API_KEY`, etc.) and writes them into encrypted settings on startup. Supports `merge` (default, fill blanks only) and `overwrite` modes.
- Code: `src/electron/utils/env-migration.ts`

## Repo Map (Where Things Live)

Top-level:
- `src/electron/`: Electron main process runtime (backend)
- `src/daemon/`: Node-only daemon entrypoint (headless, no Electron dependency)
- `src/renderer/`: React UI (frontend)
- `src/shared/`: shared types and utilities used by both processes
- `resources/skills/`: bundled skill JSON files shipped with the app
- `connectors/`: MCP connector servers (enterprise integrations)
- `deploy/`: deployment artifacts (systemd unit files, env examples)
- `docs/`: focused technical docs (security, remote access, canvas, connectors)

Notable main-process subsystems:
- Agent runtime: `src/electron/agent/` (includes `strategy/` for intent routing)
- Messaging gateway: `src/electron/gateway/`
- Security + guardrails: `src/electron/security/`, `src/electron/guardrails/`
- Control plane: `src/electron/control-plane/`
- Cron scheduler: `src/electron/cron/`
- Hooks: `src/electron/hooks/`
- Memory: `src/electron/memory/`
- Canvas: `src/electron/canvas/`
- MCP: `src/electron/mcp/`
- Database: `src/electron/database/`

## Data, Storage, and Persistence

### Electron `userData` directory

CoWork OS persists state under a configurable user-data directory, resolved by `getUserDataDir()` (`src/electron/utils/user-data-dir.ts`).

Resolution order:
1. `COWORK_USER_DATA_DIR` environment variable (supports `~` expansion)
2. `--user-data-dir <path>` CLI argument
3. Electron `app.getPath('userData')` (macOS: `~/Library/Application Support/cowork-os/`)
4. Fallback: `$HOME/.cowork` (when running without Electron, e.g. Node daemon)

What is stored there (see `src/electron/database/schema.ts` migration logic):
- SQLite DB: `cowork-os.db`
- Skills (managed): `userData/skills/`
- WhatsApp auth/session data: `userData/whatsapp-auth/`
- Cron store: `userData/cron/`
- Canvas session data: `userData/canvas/`
- Notifications state: `userData/notifications/`

### Database schema (high level)

Schema creation and migrations:
- `src/electron/database/schema.ts`

Major table families (non-exhaustive):
- Tasks and execution logs: `tasks`, `task_events`, `artifacts`, `approvals`
- Workspaces: `workspaces`
- Channels + gateway state: `channels`, `channel_users`, `channel_sessions`, `channel_messages`, plus queue/rate limit/audit tables
- Memory: `memories`, `memory_summaries`, `memory_settings`, `memory_embeddings`, and optional FTS tables/triggers
- Secure encrypted settings: `secure_settings`
- "Mission Control" features: `agent_roles`, `agent_mentions`, `agent_working_state`, `task_subscriptions`, `standup_reports`, etc.

## Development Workflow

Build system:
- TypeScript + Vite (renderer) + Electron (main) + Vitest (tests)

Common commands:
```bash
npm install
npm run dev
npm run test
npm run lint
npm run build
npm run package
```

See also:
- `CONTRIBUTING.md`
- `CHANGELOG.md`

## Documentation Map (Other Important Docs)

- `README.md`: product overview and feature documentation
- `GETTING_STARTED.md`: developer quick start + configuration
- `SECURITY_GUIDE.md`: detailed security model, guardrails, and best practices
- `docs/security/*`: deeper security docs (model, trust boundaries, configuration)
- `docs/remote-access.md`: control plane exposure via SSH/Tailscale
- `docs/live-canvas.md`: live canvas UX + API/tools
- `docs/enterprise-connectors.md`: connector contract + MCP-first strategy
- `docs/node-daemon.md`: Node-only daemon setup and configuration
- `docs/vps-linux.md`: VPS/Linux deployment with Docker and systemd
- `docs/use-cases.md`: use-case skill template documentation

## Keeping This File Updated (Process)

Update `docs/architecture.md` when you change:
- Supported messaging channels, channel security modes, pairing/allowlist behavior
- Tool names, tool groups, approval rules, sandboxing behavior, guardrails
- LLM/search provider support or settings
- Storage locations, DB schema, migrations, or encrypted settings categories
- Control plane protocol/ports or remote access defaults
- Cron/hooks default ports/paths or behavior
- MCP client/host behavior, registry, or built-in connectors
- Memory system behavior (retention, injection, redaction, indexing, embeddings)
- Image generation providers, visual annotation tools, or related skills

Suggested PR checklist addition (recommended policy):
- If your change is user-visible or changes defaults: include a doc update in the same PR.
