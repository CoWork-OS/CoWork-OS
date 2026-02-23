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
- **Dynamic Re-Planning**: Agent can revise its plan mid-execution
- **100+ Built-in Skills**: GitHub, Slack, Notion, Spotify, Apple Notes, and more
- **Document Creation**: Excel, Word, PDF, PowerPoint with professional formatting
- **Persistent Memory**: Cross-session context with privacy-aware observation capture
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
| **Shared Checklists** | Agents share checklist items for coordinated task execution |
| **Run Tracking** | Track team runs with status, progress, and history |
| **Collaborative Mode** | Ephemeral teams with real-time thought sharing |
| **Multi-LLM Mode** | Dispatch same task to multiple providers with judge-based synthesis |
| **Collaborative Thoughts** | Real-time thought panel shows agent reasoning as it happens |

Configure in **Mission Control** > **Teams**.

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
