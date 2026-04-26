# Features

## Multi-Channel AI Gateway

17 messaging channels with unified operations. See [Channel Integrations](channels.md) for setup details.

- **WhatsApp**: QR code pairing, self-chat mode, markdown support
- **Telegram**: Bot commands, streaming responses, workspace selection, group routing modes, and allowed-group allowlists
- **Discord**: Slash commands, DM support, guild integration, guild allowlists, embeds/polls/select menus, live message fetch and attachment download
- **Slack**: Socket Mode, channel mentions, file uploads, multiple workspace installations in one app profile, and optional curated middle-step progress relays
- **Microsoft Teams**: Bot Framework SDK, DM/channel mentions, adaptive cards
- **Google Chat**: Service account auth, spaces/DMs, threaded conversations
- **Feishu / Lark**: Webhook + app credential gateway support for Lark/Feishu tenants
- **WeCom**: Enterprise WeCom webhook and encrypted event routing support
- **iMessage**: macOS native integration, pairing codes
- **Signal**: End-to-end encrypted messaging via signal-cli
- **Mattermost**: WebSocket real-time, REST API
- **Matrix**: Federated messaging, room-based, end-to-end encryption ready
- **Twitch**: IRC chat integration, multi-channel
- **LINE**: Messaging API webhooks, 200M+ users in Asia
- **BlueBubbles**: iMessage via Mac server, SMS support
- **Email**: IMAP/SMTP, any email provider, threading
- **X (Twitter)**: Mention-trigger task ingress (`do:` prefix by default) with allowlist controls and idempotent session keys ([guide](x-mention-triggers.md))
- **Research Channels**: Telegram and WhatsApp groups can be marked as link-research channels that auto-generate a structured findings report from posted URLs

---

## Agent Capabilities

- **Profiles & Portability**: Separate app profiles isolate their own database, credentials, channels, skills, and sessions. Profiles can be exported/imported as bundles for migration or cloning.

- **Ideas Panel**: Curated launch panel accessible from the sidebar above Sessions. Pre-written prompts organized by category let you start common workflows in one click. See [Ideas Panel: Supported Capabilities](ideas-capabilities.md) for the full list of tools each prompt uses and their graceful fallbacks.
- **Task-Based Workflow**: Multi-step execution with plan-execute-observe loops
- **Managed Agents**: versioned managed agents, reusable local environments, and durable managed sessions exposed through the control plane, with backing tasks and team runs still visible in the normal app surfaces. See [Managed Agents](managed-agents.md).
- **Runtime Orchestration**: SessionRuntime owns task-session state, session checklists, resume snapshots, recovery state, and task projection while the turn kernel handles each individual step, follow-up, or text turn; metadata-driven tool scheduling, graph-backed delegation, typed worker roles, verifier verdicts, semantic tool-batch summaries, and terminal-state reconciliation keep delegated work coherent across tasks, follow-ups, teams, and ACP runs.
- **Prompt-Aware Tooling**: visible tools receive concise prompt-local guidance after policy filtering, and planning plus execution share the same render source for compact tool text and provider-facing tool descriptions.
- **Sectioned Prompt Stack**: execution and follow-up prompts are built from named session- and turn-scoped sections with explicit budgets, memoization of stable sections, provider-aware prompt caching, and truncation/drop reporting when token pressure rises.
- **Provider-Aware Prompt Caching**: CoWork keeps stable system blocks cacheable and dynamic turn context uncached, prefers Anthropic automatic caching where supported, uses explicit Claude breakpoints on OpenRouter, and derives stable OpenAI-family cache keys for GPT routes.
- **Session Checklist Primitive**: execution-style tasks can create a session-local ordered checklist with `task_list_create`, maintain it with `task_list_update`, inspect it with `task_list_list`, and surface it read-only in the task UI. The runtime can issue a non-blocking verification nudge when implementation items are done but no verification item exists yet.
- **Structured Delegation Briefs**: `spawn_agent` and `orchestrate_agents` resolve a worker role, package parent-step context plus evidence requirements into a structured brief, and apply the corresponding completion/tool contract to the child.
- **Permission Engine**: layered tool approvals combine explicit modes, per-tool/path/command-prefix/MCP-server rules, session grants, workspace-local rules, profile rules, and hard guardrails; `dangerous_only` adds a lower-friction mode that still prompts on destructive, privacy-sensitive, side-effecting, or ambiguous actions.
- **Live Terminal**: Shell commands run in a real-time terminal view — see output as it happens, stop execution, or provide interactive input (e.g. `y`/`n` prompts)
- **Dynamic Re-Planning**: Agent can revise its plan mid-execution
- **140 Built-in Skills**: GitHub, Slack, Notion, Spotify, Apple Notes, Unity, Unreal, Terraform, Kubernetes, financial analysis, and more. Bundled workflows now include [LLM Wiki](llm-wiki.md) for persistent research vaults, [manim-video](skills/manim-video.md) for deterministic technical animation, [kami](skills/kami.md) for editorial PDFs and slide decks, and `taste-skill` for high-agency frontend design. Optional CLI-based skills (e.g. [aurl](skills/aurl.md) for OpenAPI/GraphQL APIs) appear when the binary is installed.
- **Additive Skill Runtime**: Skills can still be proactively shortlisted from task semantics, but they now apply as additive context and scoped runtime directives. They never replace the original task prompt. See [Skills Runtime Model](skills-runtime-model.md).
- **Chat Mode**: Direct LLM chat with no tools, no step timeline, same-session follow-ups, chat-only streaming for supported providers, and a fixed high output budget for explicit `executionMode: "chat"` sessions. See [Chat Mode](chat-mode.md).
- **Document Creation**: Excel, Word, PDF, PowerPoint with professional formatting, first-class LaTeX/TikZ `.tex` -> PDF compilation when a system TeX engine is installed, plus the bundled [kami](skills/kami.md) workflow for editorial PDFs, resumes, one-pagers, and slide decks
- **Document Editing Sessions**: Inline PDF region editing and DOCX block replacement. Open a document from the Files panel or task artifact surface to enter an editing session with version browsing and document-aware controls.
- **Rich Presentation Previews**: PPTX artifacts open in an in-app slide viewer with thumbnails, previous/next controls, zoom, extracted slide text, and speaker notes. Rendered slide images are best-effort and fall back to text/notes when local conversion tools are unavailable.
- **Persistent Memory**: Cross-session context with curated hot memory, searchable archive recall, session transcript recall, topic packs, privacy-aware observation capture, and an optional Supermemory external provider lane
- **Chronicle (Desktop Research Preview)**: opt-in local recent-screen context for vague prompts like `this`, `that`, `what is this`, `latest draft`, or `why is this failing`, with Memory Hub controls, pause/resume, promoted `screen_context` evidence, and optional linked background memory generation. See [Chronicle](chronicle.md).
- **Knowledge Graph**: SQLite-backed entity/relationship memory with FTS5 search, graph traversal, and auto-extraction
- **Workspace Kit**: `.cowork/` project kit + markdown indexing with context injection
- **Agent Teams**: Multi-agent collaboration with shared checklists, graph-backed coordinated runs, and team management UI
- **Collaborative Mode**: Auto-create ephemeral teams where multiple agents work on the same task, sharing thoughts in real-time through the delegated orchestration graph
- **Multi-LLM Mode**: Send the same task to multiple LLM providers/models simultaneously, with a judge agent synthesizing the best result
- **Workflow Pipeline**: Optional phase-based execution path where decomposed steps run as child tasks with per-phase LLM overrides or capability-based auto-selection
- **Agent Comparison Mode**: Compare agent or model outputs side by side
- **External Agent Orchestration**: Discover ACP agents, target local or remote assignees from orchestration tools, and invoke A2A-compatible remote endpoints behind the normal approval/policy layer; orchestration now flows through the shared graph engine and graph-backed task state
- **ACP Lifecycle Hardening**: ACP task state is persisted locally, survives restarts, supports remote cancel, and enforces scoped task/inbox access for non-operator clients
- **Sub-Task Navigation**: Open a delegated sub-task, inspect its timeline, then jump back to the parent task from the main content view
- **Git Worktree Isolation**: Tasks run in isolated git worktrees with automatic branch creation, auto-commit, merge, conflict detection, and cleanup
- **Task Pinning**: Pin important tasks in the sidebar for quick access
- **Wrap-Up Task**: Gracefully wrap up running tasks instead of hard-cancelling
- **Capability Matcher**: Auto-select the best agents for a task
- **Completion Output Confidence UX**: When tasks finish with file outputs, users get high-signal completion toasts with direct actions (`Open file`, `Show in Finder`, `View in Files`), automatic right-panel focus for the active task, unseen-output badges when reviewing another task/view, and richer completion text composed from semantic summaries plus verifier verdict/report when available.
- **Completion/Resume Coherence**: terminal task state is persisted before terminal events are emitted, and approval- or follow-up-driven resume paths re-check canonical persisted status before writing `executing`, preventing completed tasks from regressing to an in-progress row state.
- **Artifact-First Output Visibility**: Artifact-only tasks are treated the same as file-created outputs across progress, timeline, and Files panel surfaces.
- **Paired LaTeX/PDF Outputs**: Compiled LaTeX artifacts preserve the editable `.tex` source as the durable artifact and pair it with the generated PDF in one task workbench, including Summary, source, and PDF tabs.
- **Performance Reviews**: Score and review agent-role outcomes with autonomy-level recommendations
- **Vision**: Analyze workspace images via `analyze_image` tool (OpenAI, Anthropic, Gemini, or Bedrock)
- **Image Attachments**: Attach images to tasks and follow-ups for multimodal analysis
- **Image Generation**: Multi-provider support (Gemini, OpenAI gpt-image-1/1.5/DALL-E, Azure OpenAI, OpenRouter) with configurable provider ordering
- **Video Generation**: Text-to-video and image-to-video via new video generation providers. Configure preferred video model in Settings > LLM. Generated videos render inline in the task feed.
- **Programmatic Technical Animation**: The bundled [manim-video](skills/manim-video.md) skill scaffolds Manim CE projects for math explainers, algorithm walkthroughs, architecture animations, and data stories with local project files, dependency preflight, and draft-first render helpers.
- **Editorial Document Design**: The bundled [kami](skills/kami.md) skill scaffolds workspace-local source projects for resumes, one-pagers, white papers, letters, portfolios, diagrams, and slide decks, with PDF/PPTX render helpers and a preserved editorial design system.
- **High-Agency Frontend Design**: The bundled `taste-skill` workflow adds a stricter anti-slop frontend option for React/Next.js-style UI work, with stronger layout variance, typography, motion, dependency-check, and responsive-quality rules than the default frontend guidance.
- **Visual Annotation**: Iterative image refinement with the Visual Annotator
- **Context Summarization**: Automatic context compression surfaced in the task timeline
- **Structured Input Requests**: In plan-mode flows, the agent can pause with 1-3 short multiple-choice questions instead of asking ambiguous free-text follow-ups
- **Parallel Tool Timeline**: Concurrent read-only tool bursts are grouped into lane-based timeline cards instead of flooding the event feed; screenshot-heavy refinement loops stay more compact in summary mode
- **Renderer Performance**: In the `CoWork-OS/CoWork-OS` repo, the renderer uses `@chenglou/pretext` for text-heavy sidebar/timeline measurement, with flattened visible sidebar rows and post-render height reconciliation for expanded timeline cards
- **Adaptive Runtime Recovery**: Main interactive tasks no longer receive implicit strategy turn caps. They use explicit-only window caps, bounded follow-up recovery, retry-aware turn guidance, and lifetime/emergency safety-stop escalation instead of default hard-window failure
- **Session Snapshot Resume**: SessionRuntime prefers `session_runtime_v2` checkpoint and event payloads, falls back to legacy `conversationHistory` payloads or event-derived history, and rewrites legacy resumes to V2 on the next checkpoint
- **Workspace Rule Manager**: Settings can list and remove workspace-local permission rules directly, and approval prompts can persist new workspace or profile rules with explicit reasons and scope previews.
- **Path Drift Repair**: `/workspace/...` aliases and drifted relative paths can be normalized back into the active workspace or pinned task root, with strict-fail policies when hard enforcement is preferred
- **Action-First Planning**: Agent prioritizes direct action over excessive pre-planning
- **Operator Runtime Visibility**: Task completion now surfaces the learning progression, unified recall spans tasks/messages/files/workspace notes/memory/KG, persistent shell sessions keep operator state, and live provider routing/fallback decisions are visible in the task UI and Mission Control.
- **Voice Calls**: Outbound phone calls via ElevenLabs Agents
- **Think With Me Mode**: Socratic brainstorming mode that helps clarify thinking without executing tools. Activated via toggle or auto-detected from brainstorm/trade-off patterns.
- **Problem Framing Pre-flight**: Complex tasks show a structured problem restatement, assumptions, risks, and approach before execution begins
- **Graceful Uncertainty**: Agent expresses uncertainty honestly and rates confidence on recommendations. Low-confidence messages display with an amber indicator.
- **AI Playbook**: Auto-captures successful patterns (approach, outcome, tools) and lessons from failures with error classification (7 categories: tool failure, wrong approach, missing context, permission denied, timeout, rate limit, user correction). Time-based decay scoring deprioritises stale entries. Proven patterns reinforced on repeated success. Mid-task user corrections automatically detected and captured. Relevant entries injected into system prompts. View in Settings > AI Playbook.
- **Task Result Feedback**: Completed task banners show 👍 / 👎 controls, with task-level rejections logged as quality signals for Usage Insights. The shared feedback IPC still supports structured message-level feedback for adaptation and future UI surfaces.
- **Evolving Agent Intelligence**: The agent visibly improves over time through a connected set of subsystems — layered memory, retry-aware recovery reuse, adaptive style learning, playbook-to-skill promotion, channel persona adaptation, evolution metrics, and daily operational journaling. See [Evolving Agent Intelligence](evolving-agent-intelligence.md).

### LLM Wiki Research Vaults

CoWork includes `llm-wiki` as a bundled first-class research-vault workflow inspired by Andrej Karpathy's LLM Wiki concept.

- **Persistent vaults**: creates workspace-local markdown knowledge bases instead of one-off research outputs
- **Obsidian-friendly structure**: durable notes, maps, `[[wikilinks]]`, source-preserving `raw/` captures, and filed-back `outputs/`
- **Deterministic workbench**: bundled runtimes handle raw ingest, vault-first search, slide/chart rendering, and graph analysis
- **Deterministic maintenance**: bundled analyzer reports topology, orphan pages, broken links, ambiguous links, weakly linked pages, bridge pages, surprising cross-section links, and suggested follow-up questions
- **GUI-first and slash-friendly**: natural prompts like `Build a persistent research vault for GRPO papers` route into `llm-wiki`, `/llm-wiki` remains available in desktop and supported gateway channels, and the welcome screen surfaces the default vault for browsing
- **Run artifacts + durable state**: each run writes an inspectable manifest and graph report while keeping the vault itself persistent in the workspace

See [LLM Wiki](llm-wiki.md) for command syntax, layout, modes, and analyzer behavior.

### Computer use (macOS)

Desktop automation for **native apps** when MCP, browser automation, and shell are not enough. **Full guide:** [Computer use (macOS)](computer-use.md).

- **Session lifecycle**: One active computer-use session at a time; global **Esc** abort; cleanup when the task finishes or the session ends.
- **Helper-targeted permissions**: Accessibility and Screen Recording are granted to the bundled helper binary through inline bootstrap and surfaced in **Settings → Tools**; restarting the app may be needed after Screen Recording changes.
- **Built-in tools category**: Enable/disable and priority for the `computer_use` tool family alongside other built-in categories.
- **Policy & planning**: Tool availability defers the computer-use lane unless the task signals native/desktop GUI intent; executor guidance treats computer use as last resort after integrations, `browser_*`, and shell. For native GUI tasks, routing prefers **`screenshot`**, **`click`**, **`type_text`**, **`keypress`**, and related tools (plus **`open_application`** when launching the app) over **`run_applescript`** / fragile shell GUI hacks.
- **Tools**: `screenshot`, `click`, `double_click`, `move_mouse`, `drag`, `scroll`, `type_text`, `keypress`, `wait` (with blocklisted dangerous key chords).

### Chronicle (Desktop Research Preview)

Chronicle is the desktop-only recent-screen context lane for underspecified on-screen references.

- **Memory Hub-first controls**: Chronicle is configured from `Settings > Memory Hub > Chronicle`, with consent gating, pause/resume, capture scope, Screen Recording / Accessibility / OCR status, and recent-buffer status
- **Dedicated Chronicle tool lane**: `screen_context_resolve` now lives in its own `chronicle` built-in tool category instead of piggybacking on `computer_use`
- **Screen-context resolution**: `screen_context_resolve` searches recent local frames first and only falls back to a fresh local screenshot when passive context is weak
- **No second memory system**: raw passive frames are ephemeral; only task-used observations are promoted into `.cowork/chronicle/`, unified recall, and optionally linked `screen_context` memory entries
- **Mission Control visibility**: promoted observations appear as `screen_context` evidence, a dedicated learning-progress step, and recall hits
- **Task-level control**: task creation in the main composer and Devices panel can disable Chronicle for one task without changing the global setting
- **Privacy boundary**: passive capture stays local, screen-derived text is marked untrusted, and Chronicle-backed promotion can respect workspace memory privacy/auto-capture settings

See [Chronicle](chronicle.md) for setup, testing, privacy, and contributor details.

### Inbox Agent

Local-first inbox workspace for email triage, normal email handling, follow-up, task capture, cross-channel identity, and operator handoff.

- **Classic + Today modes**: the familiar three-pane inbox remains available, while Today groups work into `Needs action`, `Happening today`, `Good to know`, and `More to browse`
- **Live inbox surfaces**: `Unread`, `Needs reply`, `Suggested Actions`, and `Open Commitments`
- **Mailbox views**: `Inbox`, `Sent`, and `All`, with `Recent` and `Priority` sorting, saved views, account filters, and domain filters
- **Normal email actions**: manual reply, reply-all, forward, To/Cc/Bcc, editable subject/body, and provider-backed send
- **AI draft review**: generated replies can be edited before sending, and the draft card clears after successful send
- **Mailbox Ask**: search local thread evidence, attachment filenames, and on-demand indexed attachment text, with LLM summaries when configured
- **Action rail**: cleanup, follow-up, reply, forward, mark done, thread prep, todo extraction, scheduling, and intel refresh
- **Thread visibility**: received and sent message content are both shown in the thread detail view
- **Cross-channel replies**: reply directly via linked Slack, Teams, WhatsApp, Signal, or iMessage targets when email is not the best channel
- **Unified identity**: manual search/link in Settings can attach Slack, Teams, WhatsApp, Signal, iMessage, and CRM handles to one contact identity
- **Relationship timeline**: the research rail merges email and channel history into one relationship timeline with channel preference hints
- **Mission Control handoff**: threads can be turned into company issues, assigned to an operator, and woken from the inbox
- **Sender cleanup**: noisy senders are ranked by volume, cleanup candidates, and estimated weekly reduction
- **Inbox automations**: rules, reminder cadences, patrol schedules, and Gmail forwarding automations can create tasks, wake agents, and schedule review flows
- **Commitment handling**: accepted commitments become real follow-up tasks; already-handled threads can be marked done
- **Event pipeline**: mailbox sync, triage, draft, send, and action events feed Knowledge Graph, Heartbeat, triggers, playbooks, and briefing
- **Safer review**: sensitive-content warnings, editable drafts, blocked scripts, and provider-permission gates keep outbound actions visible before anything leaves the app
- **Local persistence**: cached mail remains visible after restart while background sync refreshes new mail

See the full workflow guide in [Inbox Agent](inbox-agent.md).

### Managed Devices & Remote Operations

CoWork OS now includes a dedicated Devices tab for running and observing work across multiple machines.

- **Local + remote device inventory**: track the current machine alongside saved remote devices in one view
- **Connection-aware remote cards**: direct, SSH-tunneled, and Tailscale-backed devices expose connection state, last-seen time, active runs, storage summary, app summary, and attention state
- **Remote task dispatch**: start a task on a selected remote device, optionally with shell access, execution mode, or multi-LLM options
- **Remote file picker**: browse remote workspaces and attach files directly from the target machine before dispatching a task
- **Remote task feed**: filter tasks for the selected device, all devices, or attention states, then open those tasks in a remote session view
- **Device overlays**: inspect apps, storage, resource signals, alerts, and observer history without leaving the Devices surface

See [Remote Access](remote-access.md) for connection patterns and [Mission Control](mission-control.md) for the company-level control surface.

### Automations Control Center

Automation features are now grouped together in `Settings > Automations`:

- **Routines**: the primary automation abstraction for saved instructions, execution target, triggers, outputs, approval policy, connector policy, and recent runs
- **Workflow Intelligence**: Memory, Heartbeat, internal Reflection, and reviewable Suggestions form one always-on runtime owned by automation profiles
- **Task Queue**: concurrency, queueing, and background execution policy
- **Workflow Intelligence settings**: target-scoped evidence, hypotheses, critique, winner selection, suggestion dispatch, feedback learning, and guarded auto-create policy
- **Scheduled Tasks**: recurring time-based task execution; now also used as a compiled backend for routine schedule triggers
- **Webhooks**: inbound automation entry points; now also used as a compiled backend for routine API triggers
- **Event Triggers**: condition-based actions triggered by channel, webhook, or runtime events; now also used as a compiled backend for routine event triggers
- **Daily Briefing**: scheduled summaries with workspace, memory, and evolution context

Ownership model:

- `Mission Control` is the cockpit around the core runtime
- `Routines` are the main user-facing automation object
- `Scheduled Tasks`, `Webhooks`, and `Event Triggers` remain low-level or generated infrastructure
- `Triggers` are ingress and normalized evidence only
- `Devices` are execution routing only
- `Digital Twins` are optional persona presets and are not direct cognition owners

The home dashboard also surfaces recent automation runs so background work is visible without opening Settings. See [Core Automation](core-automation.md).

### Routines

`Routines` are now the main way to define saved automation in CoWork OS.

Each routine can carry:

- one saved instruction block
- one execution target (`workspace`, `worktree`, `device`, or `managed_environment`)
- one or more triggers
- one or more outputs
- a connector policy (`prefer` or enforced `allowlist`)
- an approval policy
- durable run history

Supported trigger types include:

- `schedule`
- `api`
- `connector_event`
- `channel_event`
- `mailbox_event`
- `github_event`
- `manual`

Current product stance:

- use `Routines` first when you want one automation object with observability and policy
- use `Scheduled Tasks`, `Webhooks`, or `Event Triggers` directly only when you intentionally want the lower-level surface
- treat `Workflow Intelligence` as the always-on cognitive runtime, not as a routine trigger

### Zero-Human Company Ops

CoWork OS can also be configured as a founder-directed autonomous company shell by composing several existing systems into one operating loop:

- **Venture operator workspace kit**: initializes `.cowork/` with `COMPANY.md`, `OPERATIONS.md`, `KPIS.md`, `PRIORITIES.md`, and `HEARTBEAT.md`
- **Companies control surface**: `Settings > Companies` centralizes company creation, company-graph editing, linked operators, and direct handoff into Digital Twins or Mission Control
- **Operator personas**: venture-oriented templates such as `Founder Office Operator`, `Company Planner`, `Growth Operator`, and `Customer Ops Lead`
- **Automation profiles**: always-on ownership for the chosen operator roles
- **Heartbeat v3 follow-up**: automation-profile-backed operators can proactively review recurring checks defined in `HEARTBEAT.md`, while cheap Pulse cycles stay non-LLM until escalation is justified
- **Strategic planner**: turns company goals, projects, and stalled work into planner-managed issues and optionally auto-dispatches them into tasks
- **Mission Control ops view**: exposes planner config, planner runs, goals, projects, issues, linked tasks, issue comments, and run events
- **Autonomy policy integration**: operator roles can carry reusable autonomy presets instead of relying on one global all-or-nothing mode
- **Persisted company-linked operators**: venture/operator twins can be assigned to a company so the same operator set stays visible across Companies, Digital Twins, and Mission Control
- **Companies tab as the source of truth**: `Settings > Companies` centralizes company metadata, goals, projects, issues, linked operators, planner state, and handoff into company-scoped Mission Control views

This workflow is designed for "human-directed, agent-operated" execution:

- humans define business goals, guardrails, and irreversible approval policy
- agents continuously create, route, and execute operational work
- Mission Control becomes the monitoring and intervention cockpit

See [Zero-Human Company Operations](zero-human-company.md) for architecture, setup recipe, monitoring flow, and example operating models.

### Workflow Intelligence

`Workflow Intelligence` is the primary always-on cognition layer in CoWork OS:

- **Memory as source of truth**: reflection outputs become memory candidates such as preferences, workflow patterns, open loops, corrections, recurring tasks, and ignored noise
- **Heartbeat as scheduler**: Heartbeat decides when accumulated signals justify reflection
- **Reviewable suggestions first**: useful outcomes appear as Next actions under the welcome message box, in the automation inbox, and in the Suggestions panel
- **Global coordinator, namespaced targets**: one coordinator ranks work globally while each workflow target keeps its own history, winner, backlog, and dispatch stream
- **Stable target identities**: supports core-owned targets such as `global`, `workspace`, `agent_role`, `code_workspace`, and `pull_request`
- **Fixed reflective pipeline**: collect evidence, generate 3-5 hypotheses, critique them, synthesize one winner, write backlog, and create a suggestion by default
- **Feedback learning**: act/edit/snooze/dismiss/ignore responses update memory and future scoring
- **Durable artifacts plus SQLite indexing**: compatibility files are written under `.cowork/subconscious/` and indexed for UI/search/filtering
- **Guarded downstream execution**: auto-created tasks require explicit policy, low risk, clear scope, and trusted or repeatedly accepted patterns
- **Recommendation-only success path**: if no executor mapping exists or policy does not allow autonomy, the run still completes with a reviewable suggestion or deferred recommendation
- **No maintainer-only enrollment gate**: safety remains enforced by the existing executor approval and capability policies

See [Workflow Intelligence](workflow-intelligence.md) for the architecture and operational guidance.

### Core Harness

The always-on runtime now includes a learning loop around core traces:

- failure mining
- recurring failure clustering
- living eval cases
- gated experiments
- promoted learnings

Mission Control exposes this through the `Core Harness` view. See [Core Automation](core-automation.md).

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

### Mode Picker

The UI exposes a small set of execution modes. Chat mode is separate from task execution and uses the direct conversation path.

| Mode | Behavior |
|------|----------|
| **Chat** | Direct assistant conversation, no tools, no step timeline, same-session follow-ups, and chat-only streaming for supported providers. |
| **Execute** | Full task execution path with tools, planning, and artifacts. |
| **Plan** | Structured planning path; can pause for `request_user_input` and is intended for non-mutating planning/coordination. |
| **Analyze** | Read-only analysis path that stays evidence-focused and blocks mutating tools. |
| **Verified** | Execute-like path that adds external verification checks after steps before completion. |

These modes are mutually exclusive. Chat is the conversational path; the others are task execution modes.

> **Note:** Verified mode is strongest when you want execution plus an explicit verification gate. Plan mode shows a confirmation dialog only for structured input requests, not because it bypasses approvals.

### Task Toggles

The task creation UI also includes higher-level toggles that change how tasks are orchestrated:

| Toggle | Behavior |
|--------|----------|
| **Autonomous** | Auto-approves all gated actions (shell commands, file deletions, etc.) so the agent runs without pauses. Disables user input prompts. |
| **Collaborative** | Auto-creates an ephemeral team of agents that analyze the task from multiple perspectives, then a leader synthesizes the results. Phases: dispatch → think → synthesize → complete. |
| **Multi-LLM** | Sends the same task to multiple LLM providers/models in parallel. A designated judge model synthesizes the best result. Requires 2+ providers configured. |
| **Think With Me** | Socratic brainstorming mode — agent asks follow-up questions and explores trade-offs without executing tools. Read-only tools only. |

> **Note:** Autonomous mode shows a confirmation dialog before enabling, since it bypasses all approval prompts.

### Chat Mode

Chat mode is the direct assistant conversation surface. It is designed for normal Q&A, not task execution.

- **No tools**: the assistant does not plan or call tools in chat mode
- **No step timeline**: chat turns do not render execution steps
- **Same-session follow-ups**: later questions stay in the current conversation thread
- **Explicit only**: chat behavior is enabled only when `executionMode` is explicitly set to `chat`
- **High output budget**: explicit chat sessions use a fixed 48K target output cap, clamped to the active provider budget
- **History strategy**: long chat sessions use a summary-plus-recent-window prompt strategy with cached summary reuse

See [Chat Mode](chat-mode.md) for the full behavior contract.

When the agent is operating in plan-mode execution, it can also use `request_user_input` to pause for structured multiple-choice decisions. Responses are persisted locally and can be submitted from either the desktop UI or the Control Plane web dashboard.

### Guided Decisions & Runtime Recovery

The runtime now includes a set of decision and recovery contracts aimed at keeping tasks convergent without hiding failures:

| Capability | Behavior |
|------------|----------|
| **Structured input requests** | `request_user_input` asks 1-3 concise multiple-choice questions, pauses the task, and resumes after submit/dismiss. Only available in plan mode. |
| **Explicit turn-window recovery** | Main interactive tasks run without an implicit turn window. If a caller, managed template, or helper explicitly sets `maxTurns` or `windowTurnCap`, the runtime applies the requested `turnBudgetPolicy`, soft-logs exhausted adaptive windows, reserves space for finalization, and allows bounded follow-up recovery before triggering a safety stop. |
| **Context overflow retry** | Context-capacity errors trigger compaction plus retry instead of immediate hard failure when the model context window is exceeded. |
| **Workspace alias repair** | Absolute alias paths such as `/workspace/...` can be remapped into the active workspace for file and directory tools, or blocked via `strict_fail`. |
| **Pinned task-root repair** | Relative paths that drift outside the task's canonical root can be rewritten back under the pinned root, retried with a bounded budget, or rejected under strict policy. |
| **Parallel tool-lane rendering** | Parallel read-only tool groups are projected into stable lane rows in the timeline so summary mode stays readable. |

---

## Digital Twin Personas

Pre-built AI agent templates that create role-specific digital twins for team members. Each twin absorbs cognitively draining work so the human can stay in deep focus.

- **Built-in templates across engineering, management, product, data, operations, and venture/operator roles**: including Software Engineer, Engineering Manager, Product Manager, Company Planner, Founder Office Operator, Growth Operator, and Customer Ops Lead
- **Persona-only by default**: activation creates a role preset, not a core runtime participant
- **Optional automation pairing**: always-on behavior is attached separately through automation profiles in Mission Control
- **10 cognitive offload categories**: context-switching, status-reporting, information-triage, decision-preparation, documentation, review-preparation, dependency-tracking, compliance-checks, knowledge-curation, routine-automation
- **4 bundled skills**: `twin-status-report`, `twin-pr-triage`, `twin-meeting-prep`, `twin-decision-prep`
- **One-click activation**: Browse gallery, customize name, prompt, skills, and company context, then create
- **Enterprise scaling**: Activate one twin per team member across the organization

Access from **Mission Control** > **Add Digital Twin**. See [Digital Twins](digital-twins.md) and [Heartbeat v3](heartbeat-v3.md) for the current runtime model.

---

## Plugin Packs & Customize

Role-specific bundles that group skills, agent roles, connectors, and slash commands into installable packs. Each pack targets a job function and can optionally link to a Digital Twin Persona as an optional role preset.

- **18 bundled packs**: Engineering, Engineering Management, Product Management, DevOps, Mobile Development, Game Development, Data Analysis, QA & Testing, Sales CRM, Customer Support, Content & Marketing, Technical Writing, Equity Research, Financial Analysis, Investment Banking, Private Equity, Wealth Management, and Geo SEO
- **55+ built-in skills**: Code review prep, sprint health, feature triage, incident response, prospect research, DCF modeling, LBO analysis, and more
- **Unified Customize panel**: Browse, enable/disable packs, view skills/commands/agents, click "Try asking" prompts
- **Search & filter**: Real-time sidebar search across pack names, descriptions, categories, and skill names
- **Per-skill toggles**: Enable or disable individual skills within a pack without toggling the entire pack
- **Persistent state**: Pack and skill toggle states survive app restarts (stored in `pack-states.json`)
- **Digital Twin integration**: 7 packs link to persona templates as optional role presets; always-on automation remains a separate core setup step
- **Recommended connectors**: Packs display clickable connector chips that navigate to connector settings
- **Update detection**: Background check against the remote registry with orange dot indicators on packs with newer versions
- **"Try asking" in chat**: Empty chat state shows randomized prompt suggestions from enabled packs for one-click task creation
- **Plugin Store**: In-app marketplace for discovering, installing, and creating packs (from Git repos, URLs, or scaffold)
- **Managed import scanning**: Git and URL pack installs are staged and scanned before activation, with install results surfaced as installed, installed with warning, or quarantined
- **Quarantine & report UX**: blocked imported packs move into a dedicated quarantine area with stored reports, retry scan, and removal actions in the Customize panel
- **Warning-only local detection**: unmanaged local pack folders remain discoverable in v1, but security findings can surface as warning badges and report details
- **Remote Pack Registry**: Community-contributed packs catalog with search and category filtering
- **Extensible**: Create custom packs with JSON manifests in `~/.cowork/extensions/`
- **Active Context sidebar**: Always-visible right-panel section showing connected MCP connectors with branded Lucide icons (44 connectors supported) and enabled skills, with scrollable sub-sections and 30-second auto-refresh
- **Skill conflict detection**: Warns when multiple packs register the same skill ID, preventing silent overwrites
- **Admin Policies**: Organization-level controls for allowed/blocked/required packs, installation permissions, and agent limits

Access from **Settings** > **Customize**. See [Plugin Packs](plugin-packs.md) for full documentation.

---

## Skill Store & External Skills

CoWork OS supports external skill installation through the desktop GUI, not just bundled skills or CoWork-native packs.

- **CoWork Registry tab**: Browse curated skills distributed through CoWork’s own registry flow
- **ClawHub tab**: Search ClawHub directly from the app, view live skill stats, and install from result cards
- **Popular ClawHub list**: Opening the ClawHub tab with no query shows the top downloaded public ClawHub skills
- **External import field**: Install skills from Git repositories, ClawHub page URLs, raw JSON manifests, or raw `SKILL.md` URLs
- **Managed install path**: Imported skills are staged, scanned, and then copied into CoWork’s managed skills directory only when activation is allowed
- **Security outcomes**: installs now return installed, installed with warning, or quarantined, with summary text surfaced directly in the Skill Store UI
- **Quarantine & report UX**: blocked imported skills move to a dedicated quarantine area with stored reports, retry scan, and removal actions
- **Optional external directories**: Add one or more absolute read-only skill folders in Settings so shared team skills can load without being copied into CoWork
- **Warning-only local discovery**: optional external skill directories are not auto-quarantined in v1, but CoWork can still surface unscanned or warning-state badges and reports for those bundles
- **Clear precedence**: Workspace skills override managed installs, managed installs override external directories, and external directories override bundled defaults
- **Cross-ecosystem support**: Other external skill stores are supported when they expose Git repos, raw manifests, or raw `SKILL.md` bundle entry points
- **Shared runtime contract**: Once loaded, external skills follow the same additive execution model as bundled skills. They can add context and scoped directives, but they cannot replace the canonical task prompt.

Access from **Settings** > **Skills** > **Skill Store**. Users can start with bundled global skills such as `llm-wiki`, `kami`, and `taste-skill`, then add third-party skills through the same runtime model. See [Skill Store & External Skills](skill-store-and-external-skills.md) for install/import behavior and [Skills Runtime Model](skills-runtime-model.md) for execution semantics.

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
| **Curated Hot Memory** | Small prompt-visible memory lane for durable user/workspace facts, constraints, workflow rules, project facts, and active commitments |
| **Wake-Up Layers** | The runtime exposes memory as `L0 Identity`, `L1 Essential Story`, `L2 Topic Packs`, and `L3 Deep Recall`; only `L0 + L1` are injected into the live prompt by default |
| **Curated Memory Tools** | `memory_curate` adds/replaces/removes curated entries, and `memory_curated_read` inspects the current hot-memory layer with stable entry IDs for deterministic edits |
| **Archive Memory** | `memory_save` persists observations, decisions, errors, and insights into the larger searchable archive lane for cross-session recall |
| **Checkpoint Capture** | Runtime-native checkpoints are written before compaction, on non-trivial task completion, and every 12 meaningful exchanges, each carrying both a structured summary and a verbatim evidence packet |
| **Session Recall** | `search_sessions` searches recent transcript spans and optional checkpoints when the agent needs to recall what happened in a prior run |
| **Verbatim Quote Recall** | `search_quotes` returns exact spans with provenance from transcripts, task messages, imported memories, and indexed workspace markdown when the agent needs “what was actually said?” |
| **Topic Packs** | `memory_topics_load` loads focused packs from `.cowork/memory/topics`, and `refresh: false` performs a true read-only lookup over existing topic files |
| **Memory Hub Preview** | Memory Hub shows the current `L0/L1` payload and the `L2/L3` layers excluded from default injection, including budget-driven exclusions |
| **Supermemory Provider** | Optional external provider lane with prompt-time profile injection, explicit `supermemory_profile` / `supermemory_search` / `supermemory_remember` / `supermemory_forget` tools, and optional mirroring of non-private `MemoryService.capture(...)` writes |
| **Privacy Protection** | Auto-detects sensitive patterns (API keys, passwords, tokens) |
| **Unified Search** | `search_memories` searches archive memory plus indexed `.cowork/` markdown with hybrid semantic + BM25 ranking |
| **LLM Compression** | Summarizes observations for ~10x token efficiency |
| **Prompt Defaults** | `L0 Identity` and `L1 Essential Story` are injected by default; archive injection is off by default; `L2/L3` recall stays explicit and tool-driven |
| **Temporal Knowledge Graph** | Relationships can carry `valid_from` / `valid_to`, `kg_invalidate_edge` closes an active fact without deleting history, and historical reads can opt into `as_of` |
| **ChatGPT History Import** | Import your full ChatGPT conversation history — eliminates cold start. All data stored locally and encrypted. [Details below](#chatgpt-history-import) |
| **Per-Workspace Settings** | Enable/disable, privacy modes, retention policies |
| **Optional External Memory Provider** | Supermemory can be enabled from Memory Hub for prompt-time profile injection, explicit external memory tools, and optional mirroring of non-private local memory captures. [Guide](supermemory.md) |

**Privacy Modes:** Normal (auto-detect sensitive data), Strict (all private), Disabled (no capture).

Supermemory is additive, not a replacement for local memory. CoWork still keeps the workspace kit, curated hot memory, archive memory, transcript recall, and knowledge graph locally. The current integration mirrors local memory captures only when you opt in; it does not yet stream every chat turn into Supermemory conversations. See [Supermemory Integration](supermemory.md).

Configure in **Settings** > **Memory Hub**.

---

## ChatGPT History Import

Import your full ChatGPT conversation history into CoWork OS's memory system. Instead of starting from scratch, the agent immediately understands your preferences, past projects, communication style, and context from hundreds or thousands of previous conversations.

### How It Works

1. **Export from ChatGPT**: Go to [ChatGPT Settings > Data Controls > Export Data](https://chat.openai.com/#settings/DataControls). OpenAI emails you a `.zip` file containing `conversations.json`.
2. **Import in CoWork OS**: Go to **Settings > Memory Hub > Import ChatGPT History** and select the exported `.zip` or `conversations.json` file.
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
- **Deletable** — You can clear all imported memories at any time from Settings > Memory Hub.

### Why This Matters

Most AI assistants start with zero context about you. Every new tool means re-explaining your preferences, projects, and constraints. ChatGPT history import eliminates this cold-start problem — CoWork OS learns from your existing AI conversations so it can be useful from the first task.

---

## Durable Learning Stack

CoWork OS still keeps a multi-layered learning stack under the reflective loop. These services improve recall, personalization, and future evidence quality across sessions.

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
- **Retry-aware reuse**: retries can reuse playbook patterns during planning, recent session recall during planning/execution/follow-ups, and pending verification checklist state instead of restarting cold
- **`/learn` skill**: manually teach the agent insights, corrections, preferences, or rules

These layers feed `Workflow Intelligence` and the normal task runtime. See [Workflow Intelligence](workflow-intelligence.md) for the full architecture guide.

### Evolving Agent Intelligence

A set of connected subsystems that make improvement visible and measurable over time.

| Subsystem | Purpose |
|-----------|---------|
| **Layered Memory Runtime** | Uses explicit wake-up layers: `<cowork_hot_memory>` for `L0 Identity`, `<cowork_structured_memory>` for `L1 Essential Story`, and tool-driven `L2/L3` recall through `memory_topics_load`, `search_sessions`, `search_memories`, and `search_quotes`. |
| **Retry-Aware Recovery Guidance** | When execution retries or resumes, injects retry count, retry reason/classification, pending verification items, and recent session evidence so the agent keeps moving from the last good state instead of restarting blindly. Planning retries can also include compact playbook context. |
| **Adaptive Style Engine** | Observes message length, emoji usage, technical vocabulary, and structured feedback to gradually shift personality settings (response length, emoji usage, explanation depth). Rate-limited to a configurable number of level-shifts per week. |
| **Playbook-to-Skill Promotion** | When a playbook pattern is reinforced 3+ times, auto-generates a `skill_proposal` for admin review. No skill is created until explicitly approved. |
| **Channel Persona Adapter** | Applies channel-appropriate communication directives (Slack = terse/structured, email = formal/greeting+sign-off, WhatsApp = short/emoji, etc.) on top of the core persona without replacing it. |
| **Evolution Metrics** | Computes 5 on-demand metrics: Correction Rate, Style Adaptations, Knowledge Graph growth, Task Success Rate, and Style Alignment. Produces an overall 0–100 Evolution Score. Surfaced in the Daily Briefing. |
| **Daily Operational Log** | `DailyLogService` manages optional per-day raw logs under `.cowork/memory/daily/<YYYY-MM-DD>.md`. Raw logs are never injected directly into prompts. |
| **Daily Log Summarizer** | Reads pre-written summary files from `.cowork/memory/summaries/<YYYY-MM-DD>.md`, applies recency decay, and feeds ranked summaries into the structured-memory lane. |

**Behavior Adaptation controls** (Settings > Guardrails > Behavior Adaptation):
- **Adaptive Style** toggle — enable/disable style learning (off by default)
- **Max drift per week** — maximum one-level style shifts per 7-day window (default: 1)
- **Reset learned style** — clears all accumulated style adaptations
- **Channel Persona** toggle — enable/disable per-channel communication adaptation (off by default)

See [Evolving Agent Intelligence](evolving-agent-intelligence.md) and [Behavior Adaptation](behavior-adaptation.md) for full details.

---

## Operator Runtime Visibility

CoWork OS now exposes the learning loop as a visible operator surface instead of leaving it buried inside background services.

| Surface | What users see |
|---------|----------------|
| **Task learning progression** | A standardized post-task learning card showing memory capture, playbook reinforcement, skill proposal state, evidence links, and next action. The same event stream also feeds activity feeds and Mission Control task details. |
| **Unified recall** | One “search everything” surface across tasks, messages, files, workspace notes, memory entries, and knowledge-graph context, with shared ranking/dedup logic for UI and prompt injection. |
| **Persistent shell sessions** | Long-lived shell state per task/workspace with retained cwd, env deltas, aliases, reset controls, and one-shot fallback for incompatible commands. |
| **Model routing visibility** | Live active provider/model, routing reason, fallback chain, and retry/fallback state in the task UI and settings surfaces. |
| **Applied skills visibility** | The task header keeps the canonical request visible and shows applied skills separately, including trigger/reason metadata from runtime events. |

This layer is intentionally additive. It makes learning and routing legible while preserving the desktop control plane, channels, inbox, devices, and governed automation that define CoWork OS.

See [Operator Runtime Visibility](operator-runtime-visibility.md) for the cross-surface implementation summary and [Skills Runtime Model](skills-runtime-model.md) for the skill-specific runtime contract.

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

Initialize and maintain a `.cowork/` directory inside each workspace for durable, human-edited context, scoped prompt injection, project scaffolding, and workspace health checks.

The workspace kit is contract-driven: every tracked markdown file has a declared title, scope, parser, prompt budget, freshness window, mutability model, and optional special handling.

### Root workspace files

| File | Title | Scope | Parser | Typical use |
|---|---|---|---|---|
| `AGENTS.md` | Workspace Rules | `task`, `main-session` | `sectioned` | workspace-wide operating guidance and coordination rules |
| `MEMORY.md` | Long-Term Memory | `task`, `main-session` | `decision-log` | durable learnings and long-lived constraints |
| `USER.md` | User Profile | `task`, `main-session` | `kv-lines` | preferences, timezone, communication defaults |
| `TOOLS.md` | Local Setup Notes | `task`, `main-session` | `sectioned` | environment notes, common commands, local conventions |
| `IDENTITY.md` | Workspace Identity | `task`, `main-session`, `role` | `kv-lines` | who the agent is and what it owns |
| `RULES.md` | Operational Rules | `task`, `main-session`, `role`, `company-ops` | `checklist` | must/must-not behavior and approval defaults |
| `SOUL.md` | Workspace Persona | `task`, `main-session`, `role` | `sectioned` | tone, collaboration style, execution philosophy |
| `VIBES.md` | Current Operating Mode | `task`, `role` | `sectioned` | what to optimize for right now |
| `MISTAKES.md` | Recurring Mistakes | `task`, `main-session`, `role` | `decision-log` | recurring failure patterns and corrections |
| `LORE.md` | Durable Context | `task`, `main-session` | `decision-log` | important historical decisions and background context |
| `CROSS_SIGNALS.md` | Cross-Agent Signals | `task`, `main-session`, `company-ops` | `decision-log` | contradictions, risks, amplified opportunities |
| `PRIORITIES.md` | Current Priorities | `company-ops`, `task` | `checklist` | current priorities, owners, review dates |
| `COMPANY.md` | Company Context | `company-ops` | `sectioned` | mission, offer, customer, constraints |
| `OPERATIONS.md` | Operating Model | `company-ops` | `sectioned` | auto-allowed actions, approvals, escalation paths |
| `KPIS.md` | Business Metrics | `company-ops` | `sectioned` | metrics, targets, and guardrails |
| `BOOTSTRAP.md` | Bootstrap Instructions | `bootstrap` | `checklist` | one-time onboarding checklist |
| `HEARTBEAT.md` | Heartbeat Checklist | `heartbeat` | `checklist` | recurring Heartbeat v3 checklist work |

### Project and role subdirectories

- Project-specific context lives under `.cowork/projects/<projectId>/`
- `CONTEXT.md` is the project-scoped task brief, decisions, and notes file
- `ACCESS.md` is the project-scoped access and boundary file for task and role usage
- Per-role persona files live under `.cowork/agents/<roleId>/`
- The health model also tracks supporting directories such as `.cowork/memory/`, `.cowork/memory/hourly/`, `.cowork/memory/weekly/`, `.cowork/projects/`, and `.cowork/agents/`

### Frontmatter, parsing, and injection

Tracked files can begin with simple frontmatter:

```md
---
updated: 2026-03-14
---
```

- `updated` is expected on files with freshness windows so the app can mark stale context correctly
- Bodies are sanitized and redacted before prompt injection
- Oversized files are truncated to each file's prompt budget and reported with a truncation warning
- Parsers are file-specific: `sectioned` for heading-based notes, `kv-lines` for filled key/value fields, `checklist` for rules and recurring lists, and `decision-log` for durable bullet-style history

### Special handling

- `BOOTSTRAP.md` is onboarding-only context, not a durable memory file
- When `BOOTSTRAP.md` is first present, CoWork OS records `bootstrapSeededAt` in `.cowork/workspace-state.json`
- When `BOOTSTRAP.md` is later removed, CoWork OS records `onboardingCompletedAt` and does not recreate it during missing-only init flows
- `HEARTBEAT.md` is reserved for recurring Heartbeat v3 checklist work and is intentionally separate from general task/session context

### Health, linting, and revisions

- The app surfaces workspace-kit health with missing tracked entries, stale files, warning/error counts, revision counts, and onboarding metadata
- `ACCESS.md` and `TOOLS.md` receive additional secret detection to catch likely credentials or copied tokens
- Tracked writes keep snapshots under `.cowork/**/.history/<file>/` together with revision metadata
- `search_memories` indexes `.cowork/` markdown alongside the main memory system
- `npm run kit:lint` validates the current workspace kit from the command line
- `npm run kit:lint -- --json` emits raw status JSON
- `npm run kit:lint -- --strict` exits non-zero on warnings or missing tracked entries

### Quick-open kit files

The Memory Hub exposes **Open USER.md** and **Open MEMORY.md** buttons that open the corresponding `.cowork/` file directly in the system editor. If the file does not exist it is created from a default template (with full frontmatter and section scaffolding) before opening.

Configure in **Settings** > **Memory Hub**.

---

## Role Profile Files

Define per-role personality and operating guidelines in `.cowork/agents/<role-id>/`. These files reuse the same contracts, parser rules, and titles as the root workspace kit, and role/task prompts can combine role files with root workspace files when scopes match.

| File | Title | Purpose |
|---|---|---|
| `IDENTITY.md` | Workspace Identity | role identity, ownership boundaries, confirmation rules |
| `RULES.md` | Operational Rules | role-specific must/must-not behavior and safety defaults |
| `SOUL.md` | Workspace Persona | collaboration style, tone, execution philosophy |
| `VIBES.md` | Current Operating Mode | current emphasis, urgency, and optimization target |

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
| **Agents** | Active agents list with status dots, Pulse/Dispatch state, automation-profile-backed cadence, and manual trigger controls |
| **Mission Queue** | 5-column Kanban board (Inbox → Assigned → In Progress → Review → Done) with drag-and-drop |
| **Feed & Details** | Real-time activity feed with event type and agent filters, plus task detail view with comments and mentions |
| **Core Harness** | Runtime traces, failure clusters, evals, experiments, and learnings |

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

Create role-specific AI digital twins from pre-built persona templates. Each twin absorbs cognitively draining tasks so the human stays in flow. Twins are optional persona presets, not direct owners of the always-on runtime. Accessible via the **"Add Digital Twin"** button in Mission Control's agents panel.

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
| **Cognitive Offload** | Categorized by mental burden relieved: context switching, status reporting, review prep, decision prep, documentation, dependency tracking |
| **Recommended Skills** | Pre-mapped skills with required/optional flags |
| **Autonomy Level** | `specialist` (IC roles) or `lead` (management roles) |

### Activation Flow

1. Click **"Add Digital Twin"** in Mission Control agents panel
2. Browse the **template gallery** — filter by category or search by name/tags
3. Click a template card to open the **activation dialog**
4. Customize: twin name, prompt/persona settings, and recommended skills
5. Click **"Create Digital Twin"** — creates a new AgentRole with persona defaults

The twin appears in the agents panel as a normal role. If you want it to participate in always-on automation, attach a separate automation profile afterwards.

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
| **Cost & Tokens** | Total cost, input/output token counts, cached-token totals, cache-read rate when available, and cost breakdown by model |
| **Agent Efficiency (AWU)** | Agentic Work Unit metrics — see below |
| **Activity by Day** | Tasks per day-of-week with peak day indicator |
| **Activity by Hour** | Hourly task histogram with peak hour indicator |
| **Top Skills** | Most-used skills ranked by usage count |
| **Skill Usage by Pack** | Skills grouped by their parent plugin pack with aggregated usage counts and mini bar charts |
| **Persona Performance** | Per-persona totals, success/failure mix, retry behavior, and cost attribution |
| **Feedback & Quality** | Task-result satisfaction rate, top rejection reasons, retried-task count, and average attempts |

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

Four dedicated agent tools for generating formatted documents from task context:

| Tool | Output | Description |
|------|--------|-------------|
| `compile_latex` | PDF + `.tex` source pairing | Compile a workspace `.tex` file with an installed system engine (`tectonic`, `latexmk`, `xelatex`, `lualatex`, or `pdflatex`) and register the PDF with source metadata |
| `generate_document` | PDF | Generate PDF documents with markdown content and structured sections |
| `generate_presentation` | PPTX | Generate PowerPoint presentations with multiple slides |
| `generate_spreadsheet` | XLSX | Generate Excel spreadsheets with multiple sheets and data |

These tools complement the existing document skills (spreadsheet.ts, document.ts, presentation.ts) by providing direct LLM-callable tool interfaces. Generated files are registered as task artifacts with proper MIME types.

For explicit LaTeX, TeX, TikZ, `.tex`, or "write a paper and compile PDF" requests, the runtime prefers the source-first path: write the editable `.tex` file, then call `compile_latex`. CoWork does not bundle a TeX distribution; if no supported engine is installed, the task keeps the `.tex` source and reports the missing dependency instead of silently falling back to the HTML/markdown PDF generator.

PPTX outputs also participate in the artifact preview system. Task completion cards and `artifact_created` timeline events can show an inline presentation card, and opening the file launches the full presentation viewer. CoWork always extracts slide text and notes from `.pptx`; visual slide thumbnails are generated when local `soffice` and `pdftoppm` binaries are available.

---

## Event Triggers

Condition-based automation engine that fires actions in response to events.

| Feature | Description |
|---------|-------------|
| **Trigger sources** | Channel gateway messages, cron service, webhooks, and MCP connector/resource events |
| **Action types** | `create_task`, `send_message`, `wake_agent` |
| **Condition logic** | "all" (AND) evaluation of multiple conditions |
| **Cooldown** | Configurable cooldown period (default 1 min) to prevent rapid re-firing |
| **Connector content filters** | Optional `serverId`, `connectorId`, and `resourceUri` filters let a trigger subscribe to specific MCP-backed content changes |
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
| **MIME detection** | 20+ common formats (PDF, images, docs, sheets, slides, code, etc.) |
| **Presentation preview** | PPTX decks show slide thumbnails, text, speaker notes, and external open/show actions when opened from task artifacts or Files |
| **Source/rendered pairs** | LaTeX `.tex` files compiled through `compile_latex` are paired with their generated PDFs in task artifact surfaces |

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
| **Multi-provider fallback** | Ordered provider chain with retry/failover across OpenAI, Anthropic, Gemini, Bedrock, and other configured providers |
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

Built-in tools for efficient code navigation and editing:

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

### Web Search (6 providers, always available)

Multi-provider web search with automatic fallback. DuckDuckGo is built-in and requires no API key, so `web_search` works out of the box for every user.

| Provider | Types | API Key | Notes |
|----------|-------|---------|-------|
| **DuckDuckGo** | Web | Not required | Built-in free fallback, always last in chain |
| **Tavily** | Web, News | Required | AI-optimized results (recommended) |
| **Exa** | Web, News | Required | Semantic search and research-heavy retrieval |
| **Brave Search** | Web, News, Images | Required | Privacy-focused |
| **SerpAPI** | Web, News, Images | Required | Google results |
| **Google Custom Search** | Web, Images | Required | Direct Google integration |

Paid providers are tried first in configured order. DuckDuckGo is automatically appended as the last-resort fallback. Includes retry with exponential backoff, provider cooldowns, and explicit primary/fallback ordering in Settings.

### Architecture

```
Tier 0: web_search                   (multi-provider search — always available)
Tier 1: web_fetch / http_request     (no browser — fastest)
Tier 2: browser_* tools              (Playwright in-process — full interaction)
Tier 3: scrape_* tools               (Scrapling — anti-bot bypass)
```

The agent auto-selects the appropriate tier: `web_search` for discovering information, `web_fetch` for reading known URLs, `browser_*` when interaction or JS rendering is needed, and `scrape_*` for anti-bot-protected sites.

### Browser Tools (19 tools — native Playwright)

Native Playwright API integration — no CLI subprocess, no process spawning overhead.

| Tool | Description |
|------|-------------|
| `browser_attach` | Attach to existing Chrome via Chrome DevTools Protocol (signed-in sessions). See [Chrome DevTools attach](#chrome-devtools-attach-mode) below. |
| `browser_act_batch` | Execute batched actions (click, fill, type, press, wait, scroll) in sequence with optional delays |
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

### Chrome DevTools Attach Mode

Attach to an existing Chrome instance to control a signed-in browser session (e.g. Gmail, social media). Uses the Chrome DevTools Protocol.

**Setup:**

1. Launch Chrome with remote debugging: `chrome --remote-debugging-port=9222` (or add `--remote-debugging-port=9222` to your Chrome shortcut).
2. Visit [chrome://inspect/#devices](chrome://inspect/#devices) to verify the endpoint.
3. The agent uses `browser_attach` with `debugger_url: "http://localhost:9222"` (or the WebSocket URL from the version endpoint).
4. After attach, `browser_navigate` and other browser tools operate on the attached session.

See [Chrome Remote Debugging](https://developer.chrome.com/docs/devtools/remote-debugging/) for full setup guides.

**Profile presets vs attach mode:** Use `browser_attach` with `debugger_url` when you want to control an **already running** signed-in Chrome session. Use `profile="user"` when you want to **launch a new** Chrome instance with your system profile — but Chrome must not already be running with that profile (profile lock). For existing sessions, attach mode is the correct choice.

**Note:** If you close the Chrome window while attached, subsequent browser actions will fail with "Target closed". Re-attach with `browser_attach` after relaunching Chrome.

### Browser Features

| Feature | Description |
|---------|-------------|
| **Multi-Browser** | Chromium (bundled), Chrome (system), Brave (auto-discovered) |
| **Profile Presets** | `user` (launch new Chrome with system profile — fails if Chrome is already running), `chrome-relay` (extension relay), `workspace` (workspace default). For existing signed-in sessions, use `browser_attach` instead. |
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
- **Versioned tool snapshots**: Tool discovery tracks a stable catalog hash across native tools and MCP state so status/tool changes invalidate caches immediately

---

## Enterprise MCP Connectors

**44 pre-built connectors** for enterprise integrations. Install from **Settings > Connectors > Browse Registry**.

| Connector | Type | Notes |
|-----------|------|-------|
| **Salesforce** | CRM | OAuth, health, list/search/create/update |
| **Jira** | Issue Tracking | OAuth, health, projects, issues |
| **HubSpot** | CRM | OAuth, contacts, companies, deals |
| **Zendesk** | Support | OAuth, tickets, search |
| **ServiceNow** | ITSM | health, list, get, search, create, update |
| **Linear** | Product | health, projects, issues |
| **Asana** | Work Management | health, projects, tasks |
| **Okta** | Identity | health, users, groups |
| **Resend** | Email | send, webhooks |
| **Discord** | Community | 19 tools: guilds, channels, messages, roles |
| **Google Workspace** | Productivity (OAuth) | Calendar, Drive, Gmail |
| **Figma** | Design | get file, export |
| **Vercel** | Deploy | projects, deployments |
| **Monday** | Work Management | boards, items |
| **Miro** | Whiteboard | boards, content |
| **Supabase** | Database | query, tables, auth |
| **Excalidraw** | Diagrams | create, update elements |
| **Stripe** | Payments | customers, payments, products |
| **Hugging Face** | ML | models, inference, Gradio |
| **Ahrefs** | SEO | search, metrics |
| **Mermaid Chart** | Diagrams | validate, render SVG |
| **Cloudflare** | Infrastructure | Workers, KV, D1, R2 |
| **Make** | Automation | scenarios, modules |
| **Clinical Trials** | Legal/Health | search studies |
| **Smartsheet** | Spreadsheet | sheets, rows |
| **Netlify** | Deploy | sites, deploy |
| **Airtable** | Database | bases, records |
| **PayPal** | Payments | invoices, orders |
| **Square** | Payments | transactions, API |
| **Attio** | CRM | companies, notes |
| **Honeycomb** | Observability | datasets, queries |
| **Cal.com** | Scheduling | bookings, event types |
| **Cloudinary** | Media | upload, find assets |
| **Tavily** | Web Search | search, extract, crawl |
| **tldraw** | Diagrams | read/write .tldr canvases |
| **Amplitude** | Analytics | track events, users |
| **Clerk** | Auth | users, sessions, invitations |
| **Mem** | Notes | mem_it, notes, collections |
| **Grafana** | Monitoring | dashboards, datasources |
| **Mailtrap** | Email | send, templates, sandbox |
| **Socket** | Security | dependency scores |
| **Metabase** | Analytics | dashboards, queries |
| **Shadcn UI** | Components | list, search, install |
| **GrowthBook** | Feature Flags | flags, experiments |
| **Drafts** | Notes (macOS) | create, search drafts |
| **Fantastical** | Calendar (macOS) | events, schedule |
| **Tomba** | Email | finder, verifier, domain search |

GitHub and Notion prefer native CoWork integrations first, with MCP as fallback. See [Enterprise Connectors](enterprise-connectors.md) for the full catalog and contract.

---

## Chat Integration Setup + Skill Proposals

Two orchestration tools are available for runtime setup and governed expansion:

| Tool | Purpose |
|------|---------|
| `integration_setup` | Chat-native Tier-1 integration management with `list`, `inspect`, and `configure`, including OAuth, health checks, and stale-plan protection via `expected_plan_hash` |
| `skill_proposal` | Approval-gated skill proposal lifecycle (`create`, `list`, `approve`, `reject`) with workspace-local persistence and duplicate cooldown controls |

Tier-1 providers currently covered by `integration_setup`: `resend`, `google-workspace`, `jira`, `linear`, `hubspot`, `salesforce`, `zendesk`, `servicenow`.

See [Integration Setup, Skill Proposals, and Bootstrap Lifecycle](integration-skill-bootstrap-lifecycle.md) for full request/response contracts and operational examples.

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

Configure by clicking any card in **Settings** > **Integrations**. Enterprise MCP connectors (Salesforce, Jira, HubSpot, Slack, etc.) are also managed from the same tab.

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
- Channel delivery to any of the 17 channels
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
