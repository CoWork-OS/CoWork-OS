# CoWork OS Architecture

CoWork OS is a GUI-first, CLI-capable local AI super app, everything app, and runtime for task execution, many-agent orchestration, generated knowledge-work artifacts, background operator loops, and multi-surface automation.

## Core Architecture

- **Electron main process**: task orchestration, agent runtime, heartbeat orchestration, IPC, and tool execution
- **React renderer**: desktop UI, Agents Hub, Mission Control, task timeline, settings, task boards, approval dialogs, xterm.js terminal tabs, and monitoring surfaces for managing many agents visually while the external CLI covers terminal-native starts
- **Tool and connector layer**: file, shell, browser, web, native integrations, document generation/compilation tools including source-first LaTeX PDF compilation, MCP connectors, remote execution, and **computer use** (`screenshot`, `click`, `type_text`, and related tools) as a governed desktop-GUI lane (platform helper, single-session lock, policy-gated routing). See [Computer use](computer-use.md).
- **Secure MCP tunnel layer**: outbound-only WebSocket clients can expose selected local/private MCP JSON-RPC endpoints through a CoWork-operated or self-hosted relay, with separate client/caller tokens, relay-side policy, local policy, request limits, and audit events. See [Secure MCP Tunnels](secure-mcp-tunnels.md).
- **Terminal tab layer**: workspace terminal tabs use xterm.js in the renderer and `node-pty` in Electron so user-visible terminal work flows through native PTYs instead of custom text emulation. macOS launches the user's login shell with zsh prompt/cwd integration; Windows launches `cmd.exe` through node-pty's ConPTY/winpty backend with a cwd-only prompt. See [Terminal Tabs](terminal-tabs.md).
- **CLI runtime layer**: the `cowork` command provides an interactive terminal UI and local one-shot task runner on top of the same database, settings, providers, workspaces, skills, MCP servers, and agent runtime as the desktop app. Local `cowork run` prefers a hidden Electron app-entry mode (`--cowork-cli-direct-run`) so encrypted desktop settings keep the same app identity. `--remote` is the explicit Control Plane client path. See [CoWork OS CLI](cli.md).
- **Composer mention layer**: the renderer and Electron preload expose a grouped `@` autocomplete for Agents, configured Integrations, and Files. Integration mentions are resolved locally, render as rich chips, persist in task/session metadata, and inject soft routing guidance into the executor without changing permissions or `allowedTools`. See [Composer Mentions](composer-mentions.md).
- **Message shortcut layer**: the renderer exposes one `/` picker for deterministic app commands and skill-backed workflow shortcuts. Shared app command parsing handles `/schedule`, `/clear`, `/plan`, `/cost`, `/multitask`, `/compact`, `/doctor`, and `/undo`; plugin-pack aliases resolve to target skill IDs before generic skill slash execution. Skill-backed picker selections insert editable slash tokens before launch, and Claude-for-Legal workflows can surface structured main-view matter intake cards. See [Message Box Shortcuts](message-box-shortcuts.md) and [Claude-for-Legal Workflows](claude-for-legal.md).
- **Chronicle screen-context lane**: desktop-only passive recent-screen capture, local ranking/OCR enrichment, source resolution, provenance-aware `screen_context_resolve` tool exposure, and promotion of task-used observations into workspace-backed `screen_context` evidence plus optional linked background memory generation. See [Chronicle](chronicle.md).
- **Managed resource layer**: first-class `ManagedAgent`, `ManagedEnvironment`, and `ManagedSession` resources package reusable execution definitions and durable run identities on top of existing `Task`, `AgentTeamRun`, and `SessionRuntime` primitives. The renderer exposes them through Agents Hub, but all manual agent actions create runtime managed sessions and open their backing tasks in the main task view rather than running in a separate agent-detail chat surface. See [Managed Agents](managed-agents.md).
- **Structured automation layer**: main-sidebar Automation Studio authors a versioned `RoutineWorkflowDefinition` graph with one starter, typed inputs, variables, branch ports, bounded loops, per-step risk/approval/retry policy, Google account bindings, and retention settings. The Electron runtime validates and activates immutable versions, normalizes schedule/Google/channel signals into a durable deduplicated inbox, runs version-pinned deterministic steps, persists approval/cancellation/recovery state, and applies connector, network, scope, secret, redaction, and retention policy. Prompt-based Routines and task automations continue to compile to Scheduled Tasks, Webhooks, and Event Triggers through compatibility paths. See [Automation Studio](automation-studio.md).
- **Automation/event ingress layer**: scheduled tasks, webhooks, channel events, Google pollers, and MCP connector/resource notifications feed trigger services; structured workflow signals are intercepted into `routine_event_inbox` before execution so restart recovery and idempotency do not depend on renderer state
- **Gateway specialization layer**: channel messages can resolve durable channel/chat/thread specialization records before task creation, applying workspace, agent role, prompt guidance, tool restrictions, gateway context, and shared-memory opt-in on top of the existing gateway session and context-policy model
- **Integration auth notification layer**: shared Electron-side auth detection classifies stale tokens, revoked OAuth grants, missing scopes, sign-in challenges, and connector auth failures; it creates de-duped warning notifications through the existing notification service so users can reconnect integrations in Settings instead of background workers retrying silently
- **Turn and tool orchestration**: a session-scoped `SessionRuntime` owns task-session state, session checklists, permission state, turn coordination, resume/snapshot persistence, and task projection, while a lower-level `TurnKernel` handles the active step, follow-up, or text turn; a metadata-driven `ToolScheduler` batches concurrency-safe reads, serializes conflicting writes, and keeps tool-result ordering stable
- **Prompt stack and tool guidance**: execution prompts are assembled from named session- and turn-scoped sections with explicit budgets; stable session sections form a provider-cacheable prefix, volatile turn sections stay uncached, layered memory injects only `L0 Identity` + `L1 Essential Story` by default while `L2 Topic Packs` and `L3 Deep Recall` remain tool-driven, retry-aware recovery guidance can inject attempt/retry state plus recent session evidence, and visible tools receive prompt-aware descriptions rendered only after policy and mode filtering
- **Mixture of Agents LLM layer**: the provider factory can expose MoA presets as virtual model routes. A preset resolves tool-free advisor slots first, appends bounded advisory context as a separate user message, and then runs the aggregator slot with the original tools and tool choice. Slot providers can use their own fallback chains, while whole-preset MoA fallback remains explicit. See [Mixture of Agents](mixture-of-agents.md).
- **Additive skill runtime**: canonical task text remains immutable for skill routing purposes, while `use_skill` attaches structured `SkillApplication` context plus scoped runtime directives instead of rewriting the task prompt
- **Delegation graph**: delegated work now runs through a normalized orchestration graph engine so spawned agents, `/multitask` lane runs, team work, workflow phases, and ACP tasks share one run/node/event model
- **Worker roles and verification**: built-in worker roles (`researcher`, `implementer`, `verifier`, `synthesizer`) carry hard tool scopes, delegated work receives a structured brief instead of raw prompt passthrough, and verification runs use both early nudges and a dedicated verdict/report contract
- **Adaptive model routing**: the executor can switch into a workflow-pipeline path where decomposed phases run as child tasks with per-phase model overrides or capability-based auto-selection
- **Federated agent orchestration**: ACP registry + remote invocation let orchestrators target local roles or remote A2A-compatible agents under shared approval and policy controls
- **Local persistence**: SQLite, local files, curated hot-memory entries, archive memory rows and summaries, transcript spans/checkpoints with structured summaries + verbatim evidence packets, Dreaming runs/candidates for reviewable memory curation, knowledge graph state including temporal edge validity, run records, structured workflow versions/runs/steps/event inbox/event samples/starter cursors, orchestration graph nodes/events, ACP agent registrations and ACP task state, usage telemetry, feedback events, `session_runtime_v2` task snapshots, managed-agent tables (`managed_agents`, `managed_agent_versions`, `managed_environments`, `managed_sessions`, `managed_session_events`), `.cowork/memory/topics`, and workspace-kit contracts in `.cowork/`
- **Artifact preview layer**: file preview IPC resolves workspace-contained outputs, extracts document content, and enriches artifacts with renderer-ready previews. Spreadsheet previews are extracted in Electron into shared sheet structures (`spreadsheetPreview`) for sheet names, used bounds, display values, formulas, styles, and column widths; workbook formats use `exceljs`, while CSV/TSV use a delimited parser and save back with the original delimiter. Native/app-owned spreadsheet formats such as Numbers and Google Sheets shortcuts are recognized as artifacts but open externally. Word-style document previews are extracted into `documentPreview`; DOCX-like files use Mammoth plus editable block metadata, RTF and ODT/OTT use best-effort local text extraction, legacy DOC attempts local converter fallback, and Pages is recognized for external handling. Web page previews are extracted into `webPreview`; HTML/HTM files and built React output entrypoints return sandbox-ready iframe HTML with local assets inlined where possible, while React-style projects without build output return a structured preview-unavailable state. Existing `content` and `htmlContent` fallbacks remain for compatibility. PPTX previews use `presentationPreview` with fast text/notes extraction, cached `imageUrl` slide PNGs, background full rendering through Codex `@oai/artifact-tool`, local `soffice` + `pdftoppm` fallback, in-flight render dedupe, and text-only fallback when image rendering is unavailable.
- **Browser V2 workbench layer**: interactive browser-use tools target a renderer-owned Electron webview by default, with main-process automation owned by `BrowserSessionManager` and routed through Electron `webContents.debugger` / CDP. The main process maps `{ taskId, sessionId }` to the webview's `webContentsId`; browser tools route navigation, accessibility snapshots, ref-aware click/fill/type/read/hover/drag/upload actions, dialogs, downloads, diagnostics, emulation, tracing, and screenshots to that visible session. The renderer opens the resizable right-sidebar/fullscreen Browser Workbench on demand and carries status, screenshot capture, annotation handoff, diagnostics UI, snapshot overlay state, cursor events, and viewport events so users can see agent movement and responsive breakpoint changes over the page. The embedded session uses a persistent per-workspace partition isolated from system Chrome; explicit forced-headless, profile, browser-channel, Chrome DevTools attach, and Browser Use Cloud provider options keep Playwright/local, external-CDP, and remote stealth-browser fallback paths available when explicitly needed. Real-browser profile control requires explicit consent, and Browser Use Cloud is explicit opt-in for public HTTP(S) targets with private/local target blocking and remote-session stop handling. See [Browser Workbench](browser-workbench.md) and [Browser V2 Architecture](browser-v2-architecture.md).
- **Permission engine**: layered tool approval decisions combine workspace capabilities, explicit rules, hard guardrails, session grants, workspace-local policy files, and mode defaults including `dangerous_only`, with workspace rule browsing/removal in Settings
- **Runtime visibility surfaces**: the task runtime emits learning progression, unified recall, persistent shell, live terminal tabs, routing events, semantic tool-batch summaries, curated external progress relays for text-first channels, session-checklist events, and follow-up completion events into Mission Control and the renderer so operator state stays visible instead of hidden in services
- **Everything Workbench artifact surfaces**: completion cards, timeline details, and Files panels share output metadata so generated docs, sheets, decks, web pages, PDFs, previews, and live browser sessions stay attached to the task that produced or used them. Spreadsheet outputs render as compact cards; editable workbook/CSV/TSV files open into a sidebar/fullscreen artifact workbench with editable grid state, persisted sidebar width, and fullscreen follow-up context, while native app formats keep external-app/folder actions. Word-style document outputs render as compact cards; DOCX opens into a direct-edit sidebar/fullscreen document workbench with Google Docs-style controls, save/copy actions, persisted sidebar width, fullscreen follow-up context, and preview refresh after follow-up edits, while non-editable document formats keep best-effort preview and external-app/folder actions. Presentation outputs render as compact cards; PPTX opens into a sidebar/fullscreen presentation workbench with thumbnails, navigation, zoom, speaker notes, cached slide rendering, persisted sidebar width, and deferred refresh after follow-up completion, while legacy PowerPoint formats keep external actions. Web page outputs render as compact cards; generated HTML/HTM and built React output open into a sandboxed sidebar/fullscreen iframe workbench with browser/folder/copy actions, persisted sidebar width, and deferred refresh after follow-up completion, while React-style projects without build output show a build-output-needed state instead of starting a dev server. Live website testing opens a browser workbench in the same right-sidebar/fullscreen model so the agent can interact with a visible page and validate responsive breakpoints without launching an external browser. LaTeX PDFs compiled through `compile_latex` carry `sourcePath` metadata so the renderer can pair the editable `.tex` source with the generated PDF in one artifact workbench.
- **Lifecycle reconciliation**: completion persists terminal task state before emitting terminal events, and resume paths re-derive canonical persisted status before writing `executing`, so late approval or follow-up resumes cannot reopen completed tasks
- **Completion hardening**: verified-mode evidence bundles, step-intent alignment/decomposition heuristics, read-only entropy sweeps, and verifier verdict/report projection make completion checks more explicit without mutating the task's final result

## Profiles and Isolation

CoWork supports multiple app profiles so one install can keep separate operating environments for different users, clients, or trust zones.

- each profile has its own user-data root, SQLite database, encrypted settings, channel configs, managed skills, and session history
- profile export/import moves a complete app profile bundle without merging it into another profile implicitly
- workspaces still live outside the app profile, but the profile controls the credentials, automations, channels, and runtime state that operate on those workspaces
- profile switching is an app-level concern, separate from personality export/import or workspace-kit files

## Heartbeat V3

Heartbeat v3 is the default background automation architecture.

- **Signal ledger**: ambient changes, mentions, manual wakes, and awareness events emit normalized heartbeat signals instead of accumulating raw wake requests
- **Pulse**: cheap, deterministic, non-LLM state reduction that evaluates merged signals, due proactive work, checklist cadence, foreground contention, and dispatch guardrails
- **Dispatch**: escalation lane invoked only when Pulse decides the situation warrants user-visible or task-visible work
- **Run records**: every Pulse and Dispatch execution is tracked, and any heartbeat-created task is linked back to its originating heartbeat run
- **Defer and compress**: foreground manual work suppresses churn by compressing pending signals into resumable deferred state instead of growing a queue
- **Dreaming handoff**: memory-specific signals can trigger Dreaming, which creates reviewable memory candidates without consuming dispatch budget or creating tasks

See [Heartbeat v3](heartbeat-v3.md) for the detailed runtime contract.

## Dreaming

Dreaming is the background memory-curation phase inside Workflow Intelligence.

It runs after meaningful task completion or memory-specific Heartbeat signals, reads bounded evidence from transcripts, structured observations, and curated hot memory, and persists `dreaming_runs` plus `dreaming_candidates`.

Dreaming candidates are proposals, not final mutations. Accepted candidates must still flow through the owning Memory, Curated Memory, topic-pack, or Core Harness path. See [Dreaming](dreaming.md).

## Workspace Kit

The `.cowork/` workspace kit holds durable human-edited operating context.

- `BOOTSTRAP.md` is a one-time onboarding checklist
- `HEARTBEAT.md` is reserved for recurring heartbeat checklist work
- `USER.md` and `MEMORY.md` can contain both human-authored content and auto-managed curated-memory blocks
- project-scoped context lives under `.cowork/projects/<projectId>/`

## Skills Runtime Model

The skill system now follows an additive contract:

- the canonical user request is resolved as `rawPrompt -> userPrompt -> prompt`
- task creation normalizes prompt fields centrally so new tasks always persist canonical prompt data
- skill routing works as shortlist-and-hint guidance, not prompt takeover
- slash commands can still invoke skills deterministically, including first-class bundled workflows such as `/simplify`, `/batch`, `/llm-wiki`, direct skill IDs, and plugin-pack aliases from the message box shortcut picker, but the result is applied additively
- `use_skill` returns structured context plus scoped directives, not a replacement task definition
- the executor builds runtime context from canonical prompt + task notes + applied skill content
- the renderer always shows canonical task text and renders applied skills separately

This prevents skills from hijacking the task while preserving proactive skill selection.

See [Skills Runtime Model](skills-runtime-model.md) for the detailed contract.

## Gateway Message Lifecycle

Remote channel messages are routed through a shared lifecycle for command dispatch, task-session ownership, specialization lookup, follow-ups, cancellations, progress delivery, skill slash invocation, and scheduled-task output delivery. The gateway treats recognized slash commands as owned commands, not task text, resolves channel/chat/thread specialization before creating fresh tasks, and uses generation guards so stale task updates are not delivered after a chat starts fresh or cancels.

See [Gateway Message Lifecycle](gateway-message-lifecycle.md) for the user-facing command and delivery model.

## Integration Auth Notifications

Integration auth failures are surfaced through `src/electron/notifications/integration-auth.ts`. The helper owns auth-error classification, reason redaction, and per-integration de-duping before it writes a standard warning notification through `NotificationService`.

Current producers are:

- Google Workspace API helpers for Gmail, Calendar, Drive, and shared native/MCP token refresh or scope failures
- X (Twitter) tool failures that indicate login, challenge, verification, or authorization blocking
- MCP connector tool/status errors that look like auth failures

MCP transport disconnects that classify as auth failures stop at `error` rather than scheduling reconnect backoff. Non-auth transient disconnects still use the normal reconnect path.

## Repo Landmarks

- `src/electron/`: main-process runtime, services, database, scheduling, monitoring
- `src/electron/agent/runtime/SessionRuntime.ts`: canonical task-session owner for execution, recovery, snapshotting, and task projection
- `src/cli/`: `cowork` CLI argument parsing, terminal UI, local one-shot runner, diagnostics, and remote Control Plane dispatch
- `bin/cowork-cli.js`: npm binary launcher for the `cowork` command
- `src/renderer/components/RightPanel.tsx`: renderer-side read-only projection of the latest session checklist state
- `src/electron/agent/runtime/PermissionEngine.ts`: layered tool-approval evaluation, rule matching, and fallback escalation
- `src/renderer/`: React UI and settings surfaces
- `src/shared/`: shared contracts and types
- `docs/`: product and architecture documentation
- `.cowork/`: local workspace operating context

## Desktop Location

`get_current_location` exposes the user's desktop location for nearby-place, walking-distance, and local-errand queries. The implementation lives in `src/electron/location/DesktopLocationService.ts` and delegates to platform-specific helpers that share a common JSON envelope format.

- **macOS**: a compiled Swift helper (`native/location-helper-macos/`) uses Core Location. The `.app` bundle is code-signed with the `com.apple.security.personal-information.location` entitlement and launched via `open -W -n`. Built by `scripts/build_location_helper_macos.mjs`.
- **Windows**: a bundled PowerShell script (`native/location-helper-windows/Get-Location.ps1`) uses the `Windows.Devices.Geolocation` WinRT API. Invoked via `powershell.exe -ExecutionPolicy Bypass`. No compilation step.
- **Linux**: a bundled Bash script (`native/location-helper-linux/get-location.sh`) uses GeoClue2 over the system D-Bus via `gdbus`. Requires `gdbus` (part of glib2 utilities). No compilation step.

Each helper accepts `--accuracy coarse|precise`, `--timeout-ms N`, and `--response-file <path>`, and outputs `{ ok, location }` or `{ ok: false, error: { code, message } }`. Error codes: `LOCATION_DENIED`, `LOCATION_UNAVAILABLE`, `LOCATION_TIMEOUT`, `LOCATION_NOT_CONFIGURED`, `LOCATION_UNSUPPORTED_PLATFORM`.

The permission engine treats `get_current_location` as a `location_access` approval — it requires explicit one-time user consent, cannot be auto-approved, and does not persist across tasks. Failed location requests are cached for 2 minutes to prevent retry storms.

The bundled Maps MCP connector (`connectors/maps-mcp/`) consumes location coordinates for nearby place search and walking route calculations.

## Computer use

Native GUI control is implemented in the main process (`src/electron/computer-use/`, `src/electron/agent/tools/computer-use-tools.ts`) with a persistent platform helper runtime and a **singleton session** that coordinates single-task ownership plus **Esc** abort. macOS uses helper-targeted permission bootstrap; Windows uses a bundled Win32 helper for visible, non-minimized windows. Tool policy and the executor only expose the computer-use lane when **native desktop GUI intent** is detected so routine web and repo work stays on browser and shell paths. Product-level behavior, permissions, and troubleshooting are documented in [Computer use](computer-use.md).

## Terminal Tabs

Terminal tabs are implemented with a renderer/main split:

- `src/renderer/components/TerminalTabsDock.tsx` owns the dock UI, tab controls, xterm instances, fitting, focus, keyboard input forwarding, and output rendering.
- `src/electron/terminal/TerminalPtyManager.ts` owns `node-pty` processes, replay buffers, cwd/status metadata, PTY resize, and tab lifecycle.
- `src/electron/ipc/handlers.ts`, `src/electron/preload.ts`, and `src/shared/types.ts` expose typed channels for create/list/write/resize/stop/close/output.

The design keeps structured shell tools available for agent-run commands while giving humans a real terminal work surface in the same task workspace. This is the terminal counterpart to the Everything Workbench and Browser Workbench: direct CLI work no longer has to leave CoWork OS. Product behavior and QA guidance are documented in [Terminal Tabs](terminal-tabs.md).

## CoWork CLI

The standalone `cowork` CLI is implemented separately from in-app terminal tabs:

- `bin/cowork-cli.js` resolves the installed package and launches built CLI output.
- `src/cli/main.ts` owns argument parsing, the interactive welcome screen, slash commands, local diagnostics, and remote-mode handling.
- `src/cli/direct-run.ts` owns one-shot local task execution once the app runtime has initialized.
- `src/electron/main.ts` recognizes `--cowork-cli-direct-run` and starts a hidden Electron runner without opening the desktop window.

The local path is intentionally not a Control Plane dependency. It initializes the local database, settings manager, provider routing, workspace state, skill registry, MCP manager, and `AgentDaemon`, then creates and waits on a task. The daemon is started with startup recovery disabled in CLI direct-run mode so a short-lived terminal process does not recover or rewrite GUI-owned tasks.

Use `cowork run ... --remote` for the token-gated Control Plane client path. Product behavior and first-run guidance are documented in [CoWork OS CLI](cli.md).

## Chronicle

Chronicle is implemented as a dedicated desktop screen-context subsystem under `src/electron/chronicle/`.

- `ChronicleCaptureService` maintains the local recent-screen ring buffer in app-local storage
- `ChronicleSelector` ranks frames by recency, app/window metadata, and OCR-derived local text
- `ChronicleSourceResolver` enriches Chronicle captures with frontmost URL/file/app references when available
- `ChronicleProvenance` turns screen-derived text into untrusted, provenance-tagged context
- `ChronicleObservationRepository` promotes only task-used observations into `.cowork/chronicle/`
- `ChronicleMemoryService` can create linked `screen_context` memory rows through the normal memory pipeline
- `screen_context_resolve` is registered from the agent tool registry, exposed through the dedicated built-in `chronicle` tool category, and hidden when Chronicle is disabled, paused, or unavailable
- Mission Control and runtime visibility consume promoted observations as `screen_context`, not as a separate memory database
- renderer surfaces for Chronicle now live in Memory Hub, Memory settings, task-creation toggles, and tray/menu-bar controls

Chronicle shares the Screen Recording prerequisite with computer use, but it is a different lane: local screen understanding rather than direct GUI control. Product-level behavior, testing, and privacy boundaries are documented in [Chronicle](chronicle.md).

## Update Rule

If defaults, behavior, or architecture change, update this file in the same PR.
