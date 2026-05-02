# CoWork OS Architecture

CoWork OS is a local-first desktop runtime and AI workbench for task execution, generated knowledge-work artifacts, background operator loops, and multi-surface automation.

## Core Architecture

- **Electron main process**: task orchestration, agent runtime, heartbeat orchestration, IPC, and tool execution
- **React renderer**: desktop UI, Mission Control, task timeline, settings, and monitoring surfaces
- **Tool and connector layer**: file, shell, browser, web, native integrations, document generation/compilation tools including source-first LaTeX PDF compilation, MCP connectors, remote execution, and **macOS computer use** (`screenshot`, `click`, `type_text`, and related tools) as a governed desktop-GUI lane (helper-targeted permissions, single-session lock, policy-gated routing). See [Computer use (macOS)](computer-use.md).
- **Composer mention layer**: the renderer and Electron preload expose a grouped `@` autocomplete for Agents, configured Integrations, and Files. Integration mentions are resolved locally, render as rich chips, persist in task/session metadata, and inject soft routing guidance into the executor without changing permissions or `allowedTools`. See [Composer Mentions](composer-mentions.md).
- **Message shortcut layer**: the renderer exposes one `/` picker for deterministic app commands and skill-backed workflow shortcuts. Shared app command parsing handles `/schedule`, `/clear`, `/plan`, `/cost`, `/compact`, `/doctor`, and `/undo`; plugin-pack aliases resolve to target skill IDs before generic skill slash execution. See [Message Box Shortcuts](message-box-shortcuts.md).
- **Chronicle screen-context lane**: desktop-only passive recent-screen capture, local ranking/OCR enrichment, source resolution, provenance-aware `screen_context_resolve` tool exposure, and promotion of task-used observations into workspace-backed `screen_context` evidence plus optional linked background memory generation. See [Chronicle](chronicle.md).
- **Managed resource layer**: first-class `ManagedAgent`, `ManagedEnvironment`, and `ManagedSession` control-plane resources package reusable execution definitions and durable run identities on top of existing `Task`, `AgentTeamRun`, and `SessionRuntime` primitives. See [Managed Agents](managed-agents.md).
- **Automation/event layer**: scheduled tasks, webhooks, channel events, and MCP connector/resource notifications all flow through the same trigger engine
- **Turn and tool orchestration**: a session-scoped `SessionRuntime` owns task-session state, session checklists, permission state, turn coordination, resume/snapshot persistence, and task projection, while a lower-level `TurnKernel` handles the active step, follow-up, or text turn; a metadata-driven `ToolScheduler` batches concurrency-safe reads, serializes conflicting writes, and keeps tool-result ordering stable
- **Prompt stack and tool guidance**: execution prompts are assembled from named session- and turn-scoped sections with explicit budgets; stable session sections form a provider-cacheable prefix, volatile turn sections stay uncached, layered memory injects only `L0 Identity` + `L1 Essential Story` by default while `L2 Topic Packs` and `L3 Deep Recall` remain tool-driven, retry-aware recovery guidance can inject attempt/retry state plus recent session evidence, and visible tools receive prompt-aware descriptions rendered only after policy and mode filtering
- **Additive skill runtime**: canonical task text remains immutable for skill routing purposes, while `use_skill` attaches structured `SkillApplication` context plus scoped runtime directives instead of rewriting the task prompt
- **Delegation graph**: delegated work now runs through a normalized orchestration graph engine so spawned agents, team work, workflow phases, and ACP tasks share one run/node/event model
- **Worker roles and verification**: built-in worker roles (`researcher`, `implementer`, `verifier`, `synthesizer`) carry hard tool scopes, delegated work receives a structured brief instead of raw prompt passthrough, and verification runs use both early nudges and a dedicated verdict/report contract
- **Adaptive model routing**: the executor can switch into a workflow-pipeline path where decomposed phases run as child tasks with per-phase model overrides or capability-based auto-selection
- **Federated agent orchestration**: ACP registry + remote invocation let orchestrators target local roles or remote A2A-compatible agents under shared approval and policy controls
- **Local persistence**: SQLite, local files, curated hot-memory entries, archive memory rows and summaries, transcript spans/checkpoints with structured summaries + verbatim evidence packets, knowledge graph state including temporal edge validity, run records, orchestration graph nodes/events, ACP agent registrations and ACP task state, usage telemetry, feedback events, `session_runtime_v2` task snapshots, managed-agent tables (`managed_agents`, `managed_agent_versions`, `managed_environments`, `managed_sessions`, `managed_session_events`), `.cowork/memory/topics`, and workspace-kit contracts in `.cowork/`
- **Artifact preview layer**: file preview IPC resolves workspace-contained outputs, extracts document content, and enriches artifacts with renderer-ready previews. Spreadsheet previews are extracted in Electron into shared sheet structures (`spreadsheetPreview`) for sheet names, used bounds, display values, formulas, styles, and column widths; workbook formats use `exceljs`, while CSV/TSV use a delimited parser and save back with the original delimiter. Native/app-owned spreadsheet formats such as Numbers and Google Sheets shortcuts are recognized as artifacts but open externally. Word-style document previews are extracted into `documentPreview`; DOCX-like files use Mammoth plus editable block metadata, RTF and ODT/OTT use best-effort local text extraction, legacy DOC attempts local converter fallback, and Pages is recognized for external handling. Web page previews are extracted into `webPreview`; HTML/HTM files and built React output entrypoints return sandbox-ready iframe HTML with local assets inlined where possible, while React-style projects without build output return a structured preview-unavailable state. Existing `content` and `htmlContent` fallbacks remain for compatibility. PPTX previews use `presentationPreview` with fast text/notes extraction, cached `imageUrl` slide PNGs, background full rendering through Codex `@oai/artifact-tool`, local `soffice` + `pdftoppm` fallback, in-flight render dedupe, and text-only fallback when image rendering is unavailable.
- **Browser workbench layer**: interactive browser-use tools target a renderer-owned Electron webview by default. The main process maps `{ taskId, sessionId }` to the webview's `webContentsId`, browser tools route navigation/click/fill/type/press/scroll/wait/content/evaluate/screenshot actions to that visible session, and the renderer opens the resizable right-sidebar browser workbench on demand when a task starts website testing. The same IPC lane carries status, screenshot capture, annotation handoff, and cursor events so users can see agent movement over the page while it clicks, fills, types, reads, scrolls, and navigates. The embedded session uses a persistent per-workspace partition isolated from system Chrome; explicit forced-headless, profile, browser-channel, and Chrome DevTools attach options keep the existing Playwright fallback path available for remote/headless or signed-in Chrome cases. See [Browser Workbench](browser-workbench.md).
- **Permission engine**: layered tool approval decisions combine workspace capabilities, explicit rules, hard guardrails, session grants, workspace-local policy files, and mode defaults including `dangerous_only`, with workspace rule browsing/removal in Settings
- **Runtime visibility surfaces**: the task runtime emits learning progression, unified recall, persistent shell, live routing events, semantic tool-batch summaries, curated external progress relays for text-first channels, session-checklist events, and follow-up completion events into Mission Control and the renderer so operator state stays visible instead of hidden in services
- **Everything Workbench artifact surfaces**: completion cards, timeline details, and Files panels share output metadata so generated docs, sheets, decks, web pages, PDFs, previews, and live browser sessions stay attached to the task that produced or used them. Spreadsheet outputs render as compact cards; editable workbook/CSV/TSV files open into a sidebar/fullscreen artifact workbench with editable grid state, persisted sidebar width, and fullscreen follow-up context, while native app formats keep external-app/folder actions. Word-style document outputs render as compact cards; DOCX opens into a direct-edit sidebar/fullscreen document workbench with Google Docs-style controls, save/copy actions, persisted sidebar width, fullscreen follow-up context, and preview refresh after follow-up edits, while non-editable document formats keep best-effort preview and external-app/folder actions. Presentation outputs render as compact cards; PPTX opens into a sidebar/fullscreen presentation workbench with thumbnails, navigation, zoom, speaker notes, cached slide rendering, persisted sidebar width, and deferred refresh after follow-up completion, while legacy PowerPoint formats keep external actions. Web page outputs render as compact cards; generated HTML/HTM and built React output open into a sandboxed sidebar/fullscreen iframe workbench with browser/folder/copy actions, persisted sidebar width, and deferred refresh after follow-up completion, while React-style projects without build output show a build-output-needed state instead of starting a dev server. Live website testing opens a browser workbench in the same right-sidebar/fullscreen model so the agent can interact with a visible page without launching an external browser. LaTeX PDFs compiled through `compile_latex` carry `sourcePath` metadata so the renderer can pair the editable `.tex` source with the generated PDF in one artifact workbench.
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

See [Heartbeat v3](heartbeat-v3.md) for the detailed runtime contract.

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

## Repo Landmarks

- `src/electron/`: main-process runtime, services, database, scheduling, monitoring
- `src/electron/agent/runtime/SessionRuntime.ts`: canonical task-session owner for execution, recovery, snapshotting, and task projection
- `src/renderer/components/RightPanel.tsx`: renderer-side read-only projection of the latest session checklist state
- `src/electron/agent/runtime/PermissionEngine.ts`: layered tool-approval evaluation, rule matching, and fallback escalation
- `src/renderer/`: React UI and settings surfaces
- `src/shared/`: shared contracts and types
- `docs/`: product and architecture documentation
- `.cowork/`: local workspace operating context

## Computer use (macOS)

Native GUI control is implemented in the main process (`src/electron/computer-use/`, `src/electron/agent/tools/computer-use-tools.ts`) with a persistent helper runtime, helper-targeted permission bootstrap, and a **singleton session** that coordinates single-task ownership plus **Esc** abort. Tool policy and the executor only expose the computer-use lane when **native desktop GUI intent** is detected so routine web and repo work stays on browser and shell paths. Product-level behavior, permissions, and troubleshooting are documented in [Computer use (macOS)](computer-use.md).

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
