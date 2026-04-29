# Changelog

All notable changes to CoWork OS will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.41] - 2026-04-29

### Added
- **Release notes for 0.5.41**: see [Release Notes 0.5.41](release-notes-0.5.41.md).
- **Everything Workbench positioning docs**: added the canonical [Everything Workbench](everything-workbench.md) page and refreshed product copy around CoWork OS as a local-first personal agentic OS and everything app for coding, web design, research, generated docs, sheets, decks, web pages, PDFs, previews, tasks, channels, devices, and automations.
- **Document artifact workbench**: Word-style document artifact cards now recognize DOCX, DOCM, DOTX, DOTM, DOC, RTF, ODT, OTT, and Pages outputs. DOCX opens directly into an editable sidebar/fullscreen document surface with Google Docs-style controls, save/copy actions, external app actions, functional follow-up composer controls, and automatic preview refresh after follow-up edits. See [Document Artifacts](document-artifacts.md).
- **Spreadsheet artifact format support**: spreadsheet artifact cards now recognize Excel workbooks, CSV/TSV, Numbers, Google Sheets shortcut files, ODS, and XLSB. Editable in-app mode supports workbook and delimited formats; native/app-owned formats keep the same artifact card and external-app/folder actions. See [Spreadsheet Artifacts](spreadsheet-artifacts.md).
- **Presentation artifact workbench**: PPTX outputs now render as compact artifact cards and open by default in a resizable sidebar/fullscreen presentation viewer with thumbnails, navigation, zoom, speaker notes, fast text-first loading, cached rendered slide images, external actions, and functional follow-up composer controls. Legacy PowerPoint formats are recognized with external-app/folder actions. See [Presentation Artifacts and PPTX Preview](pptx-generation-and-preview.md).
- **Web page artifact workbench**: generated `.html` / `.htm` files and built React output entrypoints now render as compact artifact cards and open by default in a resizable sidebar/fullscreen sandboxed iframe preview with browser/folder/copy actions and functional follow-up composer controls. React-style projects without build output show a build-output-needed state instead of auto-starting a dev server. See [Web Page Artifacts](web-page-artifacts.md).
- **Browser Workbench**: interactive browser-use tasks now open a visible right-sidebar/fullscreen browser by default, with a persistent workspace browser profile, functional navigation controls, screenshots, screenshot annotation, follow-up handoff, and visible cursor movement during agent actions. See [Browser Workbench](browser-workbench.md).
- **Structured Memory Observations docs**: documented the new local-first observation metadata sidecar, progressive recall tools, Memory Hub Inspector actions, deterministic rebuild/backfill model, workspace-scoped mutation boundary, soft-delete suppression, inline privacy controls, Supermemory mirroring exclusions, and mock-level test expectations. See [Structured Memory Observations](memory-observations.md).
- **Structured dev logging**: Developer logging now writes redacted human-readable logs and structured JSONL logs for each captured `npm run dev` run, mirrors the latest run to `logs/dev-latest.log` / `logs/dev-latest.jsonl`, and records retained-run metadata in `logs/dev-runs.json`.
- **Format-aware in-app file preview popup**: the file preview modal that opens when a file link is clicked in chat is now format-aware. Each format has its own modal width/height profile (compact for text/code, wider for HTML/PDF/image/video, narrow for audio, presentation-sized for `.pptx`). The header shows a format-specific subtitle (e.g. `PNG · 1920×1080 · 240 KB`, `PDF · 12 pages · 1.4 MB`, `CSV · 412 rows · 24 KB`, `Audio · 3:42 · 5.1 MB`) and a unified action bar with Copy path, Show in Finder, Open externally, and Close on every format. New first-class branches: collapsible JSON tree view for `.json/.jsonl/.geojson` (with raw/tree toggle and parse-error fallback), CSV/TSV table rendering with an RFC-4180 quoted-field parser, an audio player for `.mp3/.wav/.ogg/.m4a/.flac/.aac` with duration metadata, and `highlight.js`-driven syntax highlighting for code and LaTeX. Image previews add a fit/actual-size toggle, dimension readout, and an alpha checkerboard for PNG/SVG/WebP/GIF/ICO. The hardcoded modal background and PDF summary colors were replaced with theme tokens, so light theme renders correctly across all formats.

### Changed
- **Product positioning**: README, docs home, Features, Getting Started, Showcase, Use Cases, GTM, best-fit workflows, artifact docs, architecture, development, troubleshooting, and status docs now frame document, spreadsheet, presentation, web page, PDF, and preview surfaces as one unified artifact workbench inside the broader personal agentic OS/everything app positioning. The workbench reduces app switching for generated knowledge work without claiming full office-suite replacement.
- **Document output concept**: README, Features, Architecture, Development, Getting Started, Troubleshooting, Project Status, and the docs index now describe Word-style outputs as first-class document artifacts with sidebar/fullscreen editing for DOCX and preview/external handling for other document formats.
- **Spreadsheet output concept**: README, Features, Architecture, Development, Getting Started, Troubleshooting, Project Status, and the docs index now describe Excel outputs as first-class spreadsheet artifacts with sidebar/fullscreen workbench behavior rather than only generic XLSX file previews.
- **Presentation output concept**: README, Features, Architecture, Development, Getting Started, Troubleshooting, Project Status, Use Cases, and the docs index now describe PowerPoint outputs as first-class presentation artifacts with fast text-first preview, cached rendered slides, sidebar/fullscreen review, and deferred refresh after follow-up completion.
- **Web output concept**: README, Features, Architecture, Development, Getting Started, Troubleshooting, Project Status, Use Cases, Live Canvas, and the docs index now describe generated web pages as first-class artifacts with sandboxed sidebar/fullscreen preview, built React output handling, no automatic dev-server startup, and deferred refresh after follow-up completion.
- **Browser-use concept**: README, Features, Architecture, Development, Getting Started, Troubleshooting, Use Cases, Web Page Artifacts, and the docs index now distinguish generated web artifacts from live Browser Workbench sessions, with visible sidebar browser automation as the default for normal-user website testing.
- **Memory docs refresh**: README, Getting Started, Features, Workspace Memory Flow, Supermemory, and the docs index now describe structured archive observations as the inspectable control plane over local memory rather than a replacement for CoWork's authoritative `memories` table.
- **Renderer startup bundle split**: secondary renderer views now lazy-load from the app shell, Mermaid loads only when rendering Mermaid code blocks, and syntax highlighting uses `highlight.js/lib/core` with a bounded language set instead of the package root. The production renderer entry chunk dropped from about `4,842 kB` minified (`1,267 kB` gzip) to about `1,259 kB` minified (`364 kB` gzip); see [Development Guide](development.md#renderer-bundle-size).
- **Dev log retention and ingestion**: Dev log capture now redacts common secrets before writing files, keeps the last 14 days plus at least the newest 20 runs, caps retained run logs at 100 MB by default, supports `COWORK_DEV_LOG_RETENTION_DAYS`, `COWORK_DEV_LOG_MIN_RUNS`, and `COWORK_DEV_LOG_MAX_MB`, and self-improvement diagnostics prefer `dev-latest.jsonl` before falling back to `dev-latest.log`.
- **File preview type detection**: `getFileType` (in `src/electron/ipc/handlers.ts`) and the `FileViewerResult.fileType` union now recognize `audio`, `json`, and `csv` as first-class types instead of routing them through `code`/`text`. JSON moved out of the generic code list, CSV/TSV moved out of the plain-text list, and a new `MAX_AUDIO_SIZE` (200 MB) caps audio previews. Audio reuses the existing video `playbackUrl` data-URL/streaming flow, so no new IPC channel was added.

## [0.5.40] - 2026-04-26

### Added
- **Release notes for 0.5.40**: see [Release Notes 0.5.40](release-notes-0.5.40.md).
- **Workflow Intelligence docs**: added the canonical Workflow Intelligence architecture guide and kept the former Subconscious page as a compatibility redirect.
- **Chronicle (Desktop Research Preview) docs**: added and refreshed Chronicle documentation across the README and docs set, including Memory Hub-first setup, consent/pause controls, dedicated built-in tool category, per-task toggles, observation management, linked `screen_context` memory generation, and updated troubleshooting/security guidance.
- **Routines reset docs and product copy**: documented the new routines-first automation model, including expanded routine definitions, execution targets, outputs, trigger coverage, routine runs, and the role of Scheduled Tasks/Webhooks/Event Triggers as lower-level engines or compiled backends.
- **AgentMail and expanded Inbox Agent workflows**: added AgentMail configuration/realtime support and documented Inbox Agent Classic/Today modes, Mailbox Ask, attachment search, manual reply/reply-all/forward, editable AI drafts, sender cleanup, commitments, and Gmail forwarding automations.
- **Managed Agents Hub improvements**: managed agents now include templates, role/profile conversion, runtime tool catalogs, routines, governance, insights, audit history, Slack health, workpapers, and image-generation profiles.
- **Multi-provider image generation**: image settings now cover OpenAI, OpenAI Codex/OAuth, Azure, OpenRouter, and Gemini providers with default/backup routing, model selection, timeouts, and provider-attempt progress.
- **LaTeX/PDF artifact workflow docs**: documented the new `compile_latex` source-first workflow across README, feature, use-case, architecture, runtime, troubleshooting, development, showcase, status, ideas, changelog, and docs index surfaces.
- **Bundled `kami` skill**: added a new editorial-document workflow for resumes, one-pagers, white papers, letters, portfolios, diagrams, and slide decks, with workspace-local scaffolding, PDF/PPTX render helpers, and related docs.
- **Bundled `taste-skill` frontend workflow**: CoWork OS now ships `taste-skill` as a global bundled skill for high-agency frontend design with stricter anti-slop layout, typography, motion, dependency, and responsive-implementation rules.
- **Rich PPTX artifact previews**: PowerPoint outputs now open in an in-app presentation viewer with slide thumbnails, navigation, zoom, extracted slide text, and speaker notes. Visual slide images are cached when local `soffice` + `pdftoppm` are available and fall back to text-only previews otherwise.

### Changed
- **Workflow Intelligence concept refresh**: updated README, feature, getting-started, Mission Control, Heartbeat, core automation, digital twin, company-ops, troubleshooting, and status docs to describe Memory as source of truth, Heartbeat as scheduler, Reflection as internal evaluation, and Suggestions as the reviewable user-facing output.
- **Bundled-skill docs**: README, features, skill-store, and related status/comparison docs now reflect the bundled `taste-skill` addition and the built-in skill count increase to 140.
- **Computer use runtime and docs**: macOS computer use now documents helper-targeted permissions, normalized tool names, screenshot-relative coordinates, fresh `captureId` validation, single-session sequential execution, Esc abort, and clearer Chronicle-vs-GUI-control boundaries.
- **Artifact and settings surfaces**: task outputs, Files, timeline details, AI model settings, Automations, Memory Hub, Tools, and integration settings were updated for presentation previews, LaTeX/PDF pairs, image providers, routines, Chronicle, and AgentMail.
- **Developer and packaging guidance**: documented focused build commands, Oxfmt/Oxlint/type-check commands, staged skills-check strictness, Kami validation, PPTX preview dependencies, LaTeX troubleshooting, dev-start Electron repair, skill assets, computer-use resources, and refreshed app icons.

### Fixed
- **Mailbox autosync**: autosync is scoped to the singleton IPC service instead of starting from every `MailboxService` instance.
- **Mailbox search and attachments**: upgraded mailboxes now backfill FTS before trusting search results, and attachment-content filters search decrypted extracted text.
- **Suggestion feedback**: welcome suggestions are recorded as acted-on only after prompt submission.
- **Image generation dedupe**: duplicate protection blocks identical repeated image requests without blocking distinct prompts in the same task.
- **Image OAuth and managed routines**: fixed derived Codex API key usage for OAuth image generation and synchronized managed routine lifecycle through the routines service.
- **Runtime reliability**: tightened workflow-intelligence evidence gating, restart/catch-up behavior, hook token scoping, private workspace path exclusions, Azure streaming/tool-call parsing, sidebar/session loading, task replay state, and task pause messaging.

## [0.5.35] - 2026-04-12

### Added
- **Release notes for 0.5.35**: see [Release Notes 0.5.35](release-notes-0.5.35.md).
- **Managed Agents and Managed Sessions**: CoWork now includes versioned managed-agent definitions, durable managed-session runtime plumbing, and Mission Control/control-plane surfaces for operating longer-lived reusable agents.
- **Optional Supermemory integration**: Supermemory can now act as an external memory lane with setup flows, tool exposure, runtime metadata, Memory Hub controls, and prompt-time profile context injection.
- **Task Trace Debugger**: a new debugger surface exposes trace requests, projections, formatting helpers, and renderer tabs for inspecting task execution traces directly in the app.
- **Bundled `novelist` skill and CoWork School guide**: the shipped skill set now includes a novelist workflow, and the docs now include a beginner-oriented `cowork-school` guide.

### Changed
- **Explicit-only turn budgets**: main interactive tasks no longer receive implicit strategy-derived `maxTurns` windows. `maxTurns` and `windowTurnCap` are now explicit-only caps, while uncapped tasks rely on lifetime limits, emergency fuses, and existing recovery safeguards.
- **Runtime telemetry and docs**: turn-budget events, runtime docs, and session/runtime ownership docs now distinguish explicit capped runs from default-unbounded main-task execution more clearly.
- **Renderer task-event playback**: renderer event handling now batches, throttles, and derives UI state more aggressively so larger task histories replay more smoothly.
- **Mission Control, Memory Hub, and provider settings**: the UI now surfaces Supermemory controls, trace-debugger controls, provider-specific failover chains, updated lane actions, and more consistent board-card/task summaries.
- **Daily briefings and context quality**: briefing generation now favors higher-signal context and filters low-signal background automation noise more aggressively.
- **Release and packaging guidance**: docs and packaging scripts now better enforce artifact-name consistency and local release validation.

### Fixed
- **Release smoke installs**: restored the Electron runtime as an installed dependency so `npm run release:smoke` no longer falls back into dependency bootstrap on clean consumer installs.
- **Chat MCP discovery**: fixed MCP tool discovery inside chat sessions.
- **Workspace path recovery**: stale absolute file paths can now be remapped into the active workspace more reliably during file reads.
- **Executor/runtime edge cases**: completion evidence checks, pending skill-parameter handling, iCloud execution routing, and extra JSON Schema keys in tool definitions are handled more safely.
- **Remote/task data cleanup**: remote shadow-task pruning now deletes only rows covered by the fetched remote window.

## [0.5.34] - 2026-04-08

### Added
- **Release notes for 0.5.34**: see [Release Notes 0.5.34](release-notes-0.5.34.md).
- **Core automation profiles**: automation profiles now own the always-on runtime surface, replacing the older heartbeat-centric ownership path.
- **Core automation pipelines**: the runtime now persists traces, failures, failure clusters, eval cases, harness experiments, learnings, memory candidates, regression gates, and memory-distill runs as first-class data.
- **Memory distillation**: core memory distillation now has a dedicated service layer, scoped memory resolution, and supporting repositories.
- **Research vaults (`LLM Wiki`)**: workspace-local research vaults inspired by Andrej Karpathy's LLM Wiki concept now support deterministic source capture, vault search, graph reporting, and filed-back outputs.
- **Programmatic video skill (`manim-video`)**: a bundled skill now plans and scaffolds Manim CE explainers, equation walkthroughs, algorithm visualizations, and animated architecture/data stories.
- **Curated memory and recall**: new curated-memory, quote-recall, and session-recall services expand durable context handling.
- **PDF text and workspace healing**: PDF text extraction and workspace-path healing are now handled by dedicated utility layers.
- **File provenance tracking**: imported and exported files can now carry trust/provenance metadata through a dedicated registry.

### Changed
- **Mission Control and onboarding**: the UI now surfaces automation profiles, distillation controls, core failures, learnings, companion inbox state, and shared onboarding data more clearly.
- **Renderer and completion UX**: task completion, disclosure handling, memory hub settings, permission settings, Slack settings, and onboarding screens were updated to fit the new runtime model.
- **Gateway and messaging routing**: WhatsApp command handling, channel routing, and email/report delivery were updated to match the richer runtime and task-state model.
- **Tooling and skill execution**: explicit skill invocation matching, runtime tool metadata, tool exposure, and tool-policy inference were refined across the executor and loader layers.
- **Provider behavior**: OpenRouter and provider-factory behavior were tightened with better catalog loading, logging, and model-selection handling.
- **Security and approval flows**: approval controls, workspace rule handling, control-plane sanitization, and export-permission context handling were strengthened.
- **Documentation and tests**: release notes, changelog surfaces, architecture docs, feature docs, security docs, and onboarding guidance were refreshed alongside broader test coverage.

### Fixed
- **Legacy task migration**: fixed legacy task-event migration paths so older task data upgrades cleanly into the newer runtime model.
- **Heartbeat compatibility**: preserved compatibility while routing dispatch state through automation profiles and handling deferred heartbeat state more carefully.
- **Completion evidence**: fixed report-task contract inference and completion evidence handling so task finalization is more reliable.
- **OpenRouter noise**: reduced noisy provider catalog loading and made structured logging more predictable.
- **Tool-call sanitization**: tightened tool-call and task-message sanitization so malformed payloads are less likely to leak into runtime state.
- **Workspace boundaries**: edits to workspace ignore files now respect workspace boundaries more strictly.
- **Approval and runtime edge cases**: updated approval handling, tool exposure, and runtime policy decisions so guarded actions fail more predictably.
- **Release artifacts**: release artifact naming and packaging logic were aligned with updater metadata so published assets stay consistent.

## [0.5.23] - 2026-04-05

### Added
- **Release notes for 0.5.23**: see [Release Notes 0.5.23](release-notes-0.5.23.md).
- **Subconscious reflective loop**: CoWork now includes a new reflective automation subsystem with persisted targets, backlog items, hypotheses, critiques, dispatch records, artifact storage, migration support, and a dedicated settings surface under Automations.
- **Provider-aware prompt caching**: stable prompt sections can now be cached across Anthropic, OpenRouter Claude, Azure OpenAI, and OpenAI-family routes, with shared cache metadata persisted in `SessionRuntime`.
- **Adaptive output token policy**: request-kind-aware output budgeting now classifies truncation modes, adjusts output-token limits by provider family, and guides retry or continuation behavior when a response hits output ceilings.
- **Prompt-aware tool descriptions**: built-in tools now carry prompt metadata so the runtime can render concise execution-facing descriptions and compact planning text from one shared definition.
- **Imported capability security**: managed skills and plugin packs now stage through a shared security gate with persisted reports, quarantine handling, retry/remove actions, and explicit file-import approval tracking.
- **Usage Insights projector**: usage metrics now support incremental backfill/projection, richer provider breakdowns, retry metrics, normalized provider names, and new renderer helpers for periods and formatting.
- **Task feedback controls**: completed tasks can now collect user feedback directly from the right panel.

### Changed
- **Execution runtime**: prompt assembly now uses cache-aware session- and turn-scoped sections, shared prompt-section hashing, adaptive output-budget state, prompt-aware tool text, and normalized delegation-role inference.
- **Provider routing and failover**: fallback settings now preserve cached model metadata, respect a configurable retry-to-primary cooldown, keep active failover routes stable, and expose the new behavior in settings and provider docs.
- **Anthropic, OpenAI, Azure, and OpenRouter integrations**: provider implementations now handle scoped system blocks, prompt-cache metadata, richer usage accounting, safer credential handling, and normalized display names more consistently.
- **Import and extension loading**: imported skills and plugin packs now carry persisted security reports through loader, installer, registry, IPC, and renderer surfaces instead of surfacing ad hoc warnings.
- **Automations terminology and docs**: product copy, settings labels, comparisons, and troubleshooting guides now consistently use `Subconscious` or `subconscious loop` in place of the older self-improvement language where appropriate.
- **Usage Insights UI**: the LLM section and charts now use normalized provider names, richer charting, one-day and shared period presets, and extracted formatting helpers.
- **Approval and task-detail UX**: approval dialogs now render safer command previews, and task detail feedback moved into the right panel.
- **Gateway, daemon, and worktree plumbing**: workspace bootstrap, channel gateway startup, secure worktree persistence, and health snapshots now carry richer routing and provider state.

### Fixed
- **OpenRouter attribution**: request headers now use a single normalized attribution category set across OpenRouter calls.
- **Fallback routing stability**: retryable provider failures now move through fallback routes more reliably without immediately snapping back to the primary route.
- **LLM settings persistence**: saving provider settings now preserves fallback chains, retry cooldowns, and cached model metadata more reliably.
- **Tool-result reminder payloads**: JSON envelopes remain valid when model reminders are attached to tool results.
- **Approval command previews**: long or multiline commands now render as truncated previews instead of overflowing approval dialogs.
- **Managed import integrity**: imported skills and packs are rechecked and can be quarantined consistently when their stored bundle no longer matches the expected digest or security outcome.
- **Task cleanup bookkeeping**: deleting task rows now clears subconscious task references so reflective automation state does not retain stale task pointers.
- **Empty follow-up end turns**: follow-up loops now retry empty `end_turn` responses instead of silently finalizing with no text, and repeated empty follow-up responses are surfaced as provider errors.

## [0.5.19] - 2026-03-30

### Added
- **App profiles**: isolated `userData` per profile with export/import bundles for migration and multi-environment use (`Settings → Profiles`).
- **Feishu/Lark and WeCom channels**: enterprise messaging adapters, settings UI, and gateway registration with webhook and encrypted event handling.
- **Gateway channel instances**: per-`channelId` adapter routing so multiple Slack workspaces, distinct channel configs, and correct reply routing coexist in one profile.
- **Slack multi-workspace**: add more than one Slack channel entry; each workspace is a separate gateway instance.
- **Telegram group controls**: routing modes and optional allowed group chat IDs.
- **Discord guild allowlist**: ignore traffic from guilds not in the configured list.
- **Signal and email policy alignment**: DM/group policies and exact sender or domain allowlists for email ingress.
- **Exa web search**: new search provider in Settings with ordered fallback integration alongside Tavily, Brave, SerpAPI, Google, and DuckDuckGo.
- **Ordered LLM fallback chain**: configure up to five ordered fallback providers/models for runtime failover.
- **External skill directories**: optional read-only absolute skill folders with precedence `bundled < external < managed < workspace`; Settings UI and secure settings persistence.
- **ACP task persistence**: `acp_tasks` SQLite table and handler persistence for restart-safe ACP task state.
- **ACP remote invoker**: remote HTTP calls with endpoint validation, timeouts, HTTPS preference, loopback-only `http`, private IP rejection, and remote **task cancel**.
- **ACP scoped access**: control-plane scope gates and stricter task/inbox visibility for non-operator clients.
- **RuntimeVisibilityService**: consolidates runtime learning/recall visibility wiring (replaces legacy internal parity helper).
- **Computer use (macOS)**: session manager, permissions/risk helpers, settings and approval UI; see [Computer use (macOS)](computer-use.md).
- **Usage Insights LLM section**: model/provider-oriented usage reporting with shared helpers where applicable.
- **MCP host**: `CoWorkHostProvider` and host server improvements; tests for MCP host behavior.
- **Heartbeat policy repository**: persisted heartbeat policy hooks integrated with pulse/heartbeat services.
- **Connector-backed Event Triggers**: MCP connector notifications and resource updates as trigger inputs with subscription sync (see docs).
- **Per-phase workflow model routing**: workflow pipeline phases with LLM overrides or capability-based auto-selection.
- **Federated ACP orchestration**: persisted remote agents and A2A-style invocation with orchestration targeting `acp_agent_id`.
- **Usage Insights quality metrics**: persona breakdowns, retry metrics, and task-result satisfaction signals.
- **Release notes for 0.5.19**: see [Release Notes 0.5.19](release-notes-0.5.19.md).

### Changed
- **Gateway router and IPC**: refactored for channel-instance maps, pending task metadata, and adapter lifecycle consistency.
- **Video tools**: validate reference media paths before provider calls.
- **Secure settings categories**: `skills` and `acp` categories for new persistence.
- **Documentation**: README, docs home, getting started, features, channels, providers, architecture, ACP, enterprise connectors, security, skill store, showcase, GTM, and related pages updated for 17 channels, profiles, Exa, fallback chains, and ACP hardening.
- **Automated tests**: suite now **4,583+ passing tests** across **331+ test files** (`npm run test`; 68 tests skipped in default run).

### Fixed
- **ACP Vitest stability**: handler tests use an in-memory DB fake to avoid `better-sqlite3` native ABI mismatches in Node test runners.
- **Gateway edge cases**: router/channel fixes (e.g. `channelId` on pending maps, stricter typing and allowlist behavior) and related adapter tests.

### Removed
- **Legacy parity helper**: removed in favor of `RuntimeVisibilityService` and updated tests.

## [0.5.18] - 2026-03-30

### Fixed
- **macOS CI release pipeline**: explicitly install Electron binary after `npm ci` to prevent silent postinstall failures that blocked the macOS release job.
- **Shell session manager test portability**: resolve temp directory symlinks at creation time to avoid `/var` vs `/private/var` mismatches on macOS.
- **Completion hardening**: verified evidence and entropy sweeps wired into execution, step intent alignment scoring, and LLM fallback for oversized workflow steps.

## [0.5.17] - 2026-03-30

### Added
- **Release notes for 0.5.17**: added a detailed summary page covering runtime visibility, Discord supervisor mode, Microsoft email OAuth, mailbox hardening, external skill imports, the related Devices/Inbox UX updates, and the release reliability fixes. See [Release Notes 0.5.17](release-notes-0.5.17.md).
- **Operator runtime visibility**: task completion now surfaces learning progression, unified recall spans tasks/messages/files/workspace notes/memory/knowledge graph, persistent shell sessions preserve task state, and live provider routing/fallback status is visible in task detail and settings.
- **Discord supervisor mode**: Discord channels can now run a strict worker/supervisor protocol with persisted exchanges, escalation workflows, Mission Control feed integration, resolve actions, and workspace `SUPERVISOR.md` guidance.
- **Skill Store and external skills**: the desktop app can now browse curated skills, search ClawHub, and import external skills from Git repositories, ClawHub pages, raw manifests, or raw `SKILL.md` URLs into the managed skills directory.
- **Microsoft email OAuth**: Outlook.com, Hotmail, Live, and MSN personal accounts now support Microsoft OAuth with PKCE, token refresh, connector auth wiring, and Outlook-focused email setup presets.

### Changed
- **Mailbox and email workflows**: mailbox sync, thread actions, and settings now support per-account filtering, no-reply sender handling, Loom recent-message fetches, and OAuth-backed IMAP/SMTP connections with stronger provider validation.
- **Mission Control and operator UI**: Mission Control now supports an all-workspaces view with workspace badges across board/feed/agent/detail surfaces, task detail shows learning and recall context, and temporary workspaces no longer expose unsupported reporting actions.
- **Devices and dispatch surfaces**: Dispatch onboarding now lives inside the Devices panel, the standalone Dispatch panel/sidebar entry were removed, Home Dashboard workspace naming now resolves from visible workspaces, and Inbox Agent filter/pulse controls were compacted.
- **Security hardening**: channel configs are encrypted at rest when available, mailbox bodies/summaries/excerpts are encrypted locally, database/user-data permissions are restricted during setup, mailbox IPC is limited to the main app window, and OAuth secrets are sanitized from renderer-visible channel configs.
- **Documentation and positioning**: README, features, channels, mission control, architecture, project status, and new comparison/reference pages were refreshed to reflect runtime visibility, supervisor mode, and external skill support.
- **Renderer performance**: in the `CoWork-OS/CoWork-OS` repo, sidebar rows now flatten before virtualization, timeline cards use `@chenglou/pretext` estimates with `ResizeObserver` reconciliation, and the main transcript cap stays conservative until the transcript surface is virtualized.

### Fixed
- **Release hardening gate**: deterministic eval runs against fresh CI/release databases can now be explicitly configured to allow an empty regression corpus instead of failing every tag-triggered release before packaging starts.
- **Release validation on macOS**: shell command unit tests no longer pull the full Electron daemon/runtime graph into Vitest, approval mocks are reset between cases, tool-group risk metadata now matches the security invariants, and the shell-session integration test has a CI-safe timeout budget.
- **Unsupported Outlook manual setup**: manual password-based IMAP/SMTP setup is now rejected for Outlook.com-family consumer accounts, steering users to Microsoft OAuth instead of failing later in the transport stack.
- **Outlook MIME handling**: Outlook-style multipart emails are parsed more reliably without leaking MIME boundary artifacts into visible message bodies.
- **Supervisor and mailbox edge cases**: supervisor configs now validate required routing fields up front, escalated exchanges can be resolved from the activity feed, and mailbox cleanup/no-reply handling is less likely to generate bad follow-up actions.

## [0.5.14] - 2026-03-29

### Added
- **Release notes for 0.5.14**: detailed summary page covering inbox identity, Mission Control handoff, mailbox automation, Google Workspace helpers, and the related UI and branding refresh. See [Release Notes 0.5.14](release-notes-0.5.14.md).
- **Inbox identity and handoff**: Inbox Agent now links contact identities across email and messaging, can reply through the active channel, and can hand threads off to Mission Control.
- **Mailbox automation**: rules, reminder cadences, and patrol schedules are now modeled as first-class inbox automation flows.

### Changed
- **Workspace surfaces**: inbox, settings, and Mission Control views now reflect the new cross-channel inbox workflow.
- **Documentation counts**: docs home and feature references were synchronized to the current product counts.

## [0.5.11] - 2026-03-20

### Added
- **Release notes for 0.5.11**: added a detailed summary page covering mission control, QA, native health, connectors, and runtime routing changes included in this release. See [Release Notes 0.5.11](release-notes-0.5.11.md).
- **aurl skill**: Optional skill for [aurl](https://github.com/ShawnPana/aurl) — register OpenAPI/GraphQL APIs by name, explore endpoints, make validated requests. Opt-in: skill appears only when `aurl` is installed. See [aurl skill docs](skills/aurl.md).
- **14 new MCP connectors** (44 total): Tavily (web search), tldraw (diagrams), Amplitude (analytics), Clerk (auth), Mem (notes), Grafana (monitoring), Mailtrap (email), Socket (dependency security), Metabase (analytics), Shadcn UI (components), GrowthBook (feature flags), Drafts (macOS notes), Fantastical (macOS calendar), Tomba (email finder/verifier). All npm-installable from Settings > Connectors.

### Changed
- **Mission Control and health surfaces**: new Mission Control tabs, a dedicated Health panel, Dispatch panel, and connector profile view now extend the primary operator surface.
- **Runtime and agent routing**: chat-mode and context-mode detection, proactive suggestions, managed output paths, tool-policy changes, and executor/provider refreshes tightened task routing.
- **Operator intelligence**: autonomy/awareness services, heartbeat orchestration, briefing updates, strategic planner changes, mode-suggestion detection, automated-task detection, connector profiles, and health primitives were refreshed.
- **Renderer refresh**: sidebar, settings, home dashboard, notification, and personality surfaces were broadly updated for the new release layout.
- **Shared release assets**: bundled skills, document generators, and type/provider formatting updates were added to support the expanded runtime.

## [0.5.1] - 2026-03-18

### Added
- **Chrome DevTools attach mode**: `browser_attach` tool for connecting to existing Chrome via CDP. See [Browser Automation](features.md#chrome-devtools-attach-mode).
- **Batched browser actions**: `browser_act_batch` for sequential click, fill, type, press, wait, scroll with optional delays.
- **Browser profile presets**: `user`, `chrome-relay`, `workspace` presets. Use `browser_attach` for existing signed-in sessions.
- **Docker timezone**: `COWORK_TZ` env var for IANA timezone in Docker and systemd. Invalid values fall back to UTC.
- **Gateway exec approval fallback**: Per-agent policy and allowlist honored for channel-originated `run_command`; trusted commands auto-approved when approval UI unavailable.
- **Managed devices docs refresh**: documented the Devices tab, saved remote devices, remote task launching, per-device summaries, and remote file selection workflows.
- **Automation control center docs refresh**: documented the consolidated `Automations` settings group and the relationship between Task Queue, Scheduled Tasks, Webhooks, Event Triggers, Daily Briefing, and the reflective automation surface available at the time.
- **Zero-human-company docs refresh**: documented the `Settings > Companies` workflow, persisted company-linked digital twins, and company-aware handoff between Companies, Digital Twins, and Mission Control.
- **HuggingFace Local AI provider**: added `hf-agents` + `llama.cpp` local-model support with installation checks, model selection, and local server lifecycle management from Settings.
- **Research channels**: Telegram and WhatsApp chats can now be designated as link-research channels that automatically turn posted URLs into a structured findings report.
- **Tool catalog versioning**: tool discovery now emits a stable SHA-1 catalog hash that covers native tools and MCP state, with immediate snapshot rebuilds after MCP status or `tools_changed` updates.

### Changed
- **Dashboard chat UI**: Batched tool events (400ms flush) to avoid UI freeze; flush on subscription cleanup.
- **README and feature documentation**: updated product-facing docs to reflect managed devices, automation navigation, bounded reflective automation for git-backed workflows, remote session inspection, and the current companies workflow.
- **Self-improvement documentation**: added detailed architecture and troubleshooting coverage for staged autonomous campaigns, startup ordering, worktree requirements, candidate parking/cooldowns, notification flow, and `logs/dev-latest.log` verification steps.
- **IPC contract documentation**: clarified that `kit:openFile`, `kit:resetAdaptiveStyle`, and `kit:submitMessageFeedback` live in the shared `IPC_CHANNELS` registry used by preload, renderer, and Electron handlers.
- **Connector surface consolidation**: the shipped MCP allowlist is now Salesforce, Jira, HubSpot, Zendesk, ServiceNow, Linear, Asana, Okta, Resend, Discord, and Google Workspace. Google services are consolidated under `google-workspace`; DocuSign, Outreach, and Slack were removed from the shipped Tier-1 connector surface.
- **Native-first GitHub and Notion routing**: GitHub and Notion workflows now prefer CoWork's direct API paths and fall back to MCP only when needed.
- **Collaborative task UI**: sidebar/task views now use inline agent headers, Lucide role icons, markdown normalization for collaborative output, and explicit sub-task back-navigation.
- **Notifications**: task notifications now use cleaner titles, humanized statuses, and direct view actions.

### Fixed
- **Browser profile=user errors**: Clearer messages when Chrome not installed or profile locked.
- **Invalid COWORK_TZ**: Validation with UTC fallback.
- **Event batch loss**: Flush pending events on subscription cleanup.
- **Autonomous improvement startup race**: `ImprovementLoopService` now starts after `MemoryService` initialization, skips non-worktree-capable workspaces when isolated git execution is required, and suppresses misleading legacy `ERR_UNHANDLED_ERROR` log noise from unhandled `"error"` alias emission during startup failures.
- **Improvement loop candidate persistence**: fixed the `improvement_candidates` repository insert mismatch that could fail startup with `SqliteError: 27 values for 28 columns` and prevent `ImprovementLoopService` initialization.
- **Workspace Kit / behavior-adaptation IPC constants**: restored the shared `IPC_CHANNELS` entries for `KIT_OPEN_FILE`, `KIT_RESET_ADAPTIVE_STYLE`, and `KIT_SUBMIT_MESSAGE_FEEDBACK` so preload, renderer, and handler code stay aligned.
- **Executor tool cache invalidation**: executor-side tool snapshots are now invalidated consistently when the shared catalog version changes.
- **Sidebar task navigation polish**: sessions header layout, filter affordance, and sub-task navigation behavior were tightened for collaborative runs.

## [0.4.13] - 2026-03-05

### Added
- **Universal workflow slash skills**: `/simplify` and `/batch` now work across desktop and gateway channels, including inline chaining (`then run /simplify`) and shared parsing/normalization.
- **Zero-config web search fallback**: DuckDuckGo now acts as a built-in last-resort search provider, so `web_search` works even without paid API keys.
- **Structured input requests**: plan-mode tasks can use `request_user_input` to pause for persisted multiple-choice decisions, with submission from the desktop UI or Control Plane dashboard.
- **Tier-1 integration orchestration**: new `integration_setup` flow supports `list`, `inspect`, and `configure` for Resend, Slack, the Google family, Jira, Linear, and HubSpot with `expected_plan_hash` stale-plan protection.
- **Approval-gated skill expansion**: new `skill_proposal` lifecycle lets agents draft, list, approve, and reject workspace-local skill proposals instead of mutating skills directly.
- **Workspace bootstrap lifecycle**: `.cowork/BOOTSTRAP.md`, `.cowork/VIBES.md`, `.cowork/LORE.md`, and `.cowork/workspace-state.json` now track onboarding/bootstrap state and heartbeat-ready context.
- **Workspace agent policy**: optional `agent-policy.toml` can require tool families, filter tools, tune loop thresholds, and attach pre-tool / stop-attempt hooks per workspace.
- **New bundled skills**: added Polymarket, Humanizer, YouTube video intelligence, Stock analysis, Calendly scheduling, Moltbook, and Marketing Strategist skills.
- **Developer logging capture**: `npm run dev` can mirror timestamped output to `logs/dev-latest.log`, with `npm run dev:log` forcing capture regardless of the Settings toggle.

### Changed
- **Adaptive executor defaults**: execution-oriented tasks now default to adaptive turn-window recovery, follow-up safety stops, and bounded context-overflow retries instead of treating window exhaustion as an immediate hard failure.
- **Path reliability policies**: the executor and file tools can normalize `/workspace/...` aliases and rewrite drifted relative paths back under a pinned task root, with `strict_fail` policies available when hard enforcement is desired.
- **Timeline rendering**: parallel read-only tool bursts are projected into grouped lane cards, task completion is inferred more reliably from timeline payloads, and input-request / recovery events now map cleanly across shared status and timeline models.
- **Completion and insights UX**: usage insights now surface token/runtime/top-tool metrics and reliability outcomes, while renderer timelines and output surfaces continue the filename-first, output-ready workflow.
- **Pi provider compatibility**: OpenAI ChatGPT OAuth and Pi-backed model discovery now load `@mariozechner/pi-ai` 0.56.1 through lazy ESM loaders so Electron/CommonJS bundles keep working.
- **Remote and headless operations**: the Control Plane dashboard now handles pending structured input requests in addition to tasks, approvals, workspaces, and channels.

### Fixed
- **Shell protocol violations**: `run_command` now rejects direct or wrapped `apply_patch` invocations and tells the agent to use the dedicated patch tool.
- **Task-root rewrites**: pinned-root recovery no longer skips rewrites just because an unpinned root-level path already exists, preventing drifted writes from mutating the wrong files.
- **Legacy read-only resumes**: tasks resumed without `executionModeSource` now keep user-selected non-`execute` modes instead of being auto-promoted to mutation-capable execution.
- **Electron-optional OAuth imports**: connector and Google Workspace OAuth helpers now resolve `shell.openExternal` lazily so plain Node test/release environments can import them without a packaged Electron runtime.
- **Task execution heuristics**: write-intent detection, duplicate-mutation bypass, follow-up tool locking, and browser-session verification heuristics were tightened to reduce false stalls and false completions.
- **Canvas URL validation**: canvas browsing now rejects non-HTTP(S) schemes explicitly.
- **Documentation alignment**: README, architecture, remote-access, development, and getting-started docs now reflect structured input, recovery policies, and Control Plane input-request handling.

## [0.4.12] - 2026-02-28

### Added
- **Agentic Work Unit (AWU) metric**: Usage Insights now tracks agent efficiency via AWU — successfully completed tasks measured against tokens and cost consumed. Shows AWU count, tokens/AWU, cost/AWU, AWUs per dollar, and period-over-period trend comparison.
- **All Workspaces aggregation**: Usage Insights defaults to "All Workspaces" view, aggregating metrics across every workspace. Individual workspace filtering remains available via dropdown.
- **Completion output summary payload**: `task_completed` events now support an optional `outputSummary` contract with normalized output metadata (`created`, `modifiedFallback`, `primaryOutputPath`, `outputCount`, `folders`). This keeps completion UX accurate even when renderer event history is capped.
- **Completion output UX actions**: completion toasts now show output-aware copy (including filename/count) and include direct actions for `Open file`, `Show in Finder`, and `View in Files`.
- **Shared renderer completion UX utilities**: added reusable helpers for completion toast construction, output badge behavior, panel auto-open decisions, and output/event visibility rules.
- **Artifact visibility parity across bridges**: `artifact_created` is now included in collaborative child-file merging and in the control-plane task event bridge allowlist, so artifact-only tasks are visible consistently in all surfaces.

### Changed
- **Usage Insights UI redesign**: Replaced single-column layout with compact hero stats row (completed, success rate with color-coded progress bar, failed, avg time) and two-column grid for detailed sections (Cost & AWU side-by-side, Activity Day & Hour side-by-side, Skills & Packs side-by-side).
- **Output detection rule**: completion output detection now prefers newly created outputs (`file_created`, `artifact_created`) and only falls back to modified outputs when no created outputs exist.
- **Right panel file-output emphasis**: Files section now highlights primary output, shows an output count badge, and adds a separate location context line while keeping filename-only rows.
- **Completion timeline details**: `task_completed` now renders an explicit "Output ready" details card (with actions) when outputs exist; `artifact_created` is treated as important and expandable in summary/technical timelines.
- **Status-map coherence for artifact events**: `artifact_created` now maps to `executing` in shared task event status mapping for consistent in-progress state display.

### Fixed
- **Database startup migration ordering**: moved task evaluation/index-related index creation from bootstrap table creation to post-migration execution so databases created pre-`risk_level` and `eval_*` columns no longer fail on startup (`no such column: risk_level`).
- **Hidden extensionless outputs in files list**: output files without a dot in the filename are no longer filtered out from the right-panel files section.

## [0.3.90] - 2026-02-23

### Added
- **Git Worktree Isolation**: Tasks can run in isolated git worktrees with automatic branch creation (`cowork/<task-slug>`), auto-commit, merge back to base branch, conflict detection, and worktree cleanup after completion.
- **Collaborative Mode**: Auto-create ephemeral multi-agent teams for a task. Multiple agents work in parallel, sharing their analysis and reasoning in real-time via the Collaborative Thoughts Panel, with a leader agent synthesizing the final result.
- **Multi-LLM Mode**: Send the same task to multiple LLM providers/models simultaneously. A judge agent synthesizes the best result from all participants. Configure participants and judge via the Multi-LLM Selection Panel.
- **Agent Comparison Mode**: Run the same task across different agents or models side by side using the ComparisonService. View results in a dedicated comparison UI with diff viewer.
- **Task Pinning**: Pin/unpin tasks in the sidebar for quick access. Pinned tasks always appear at the top regardless of sort order. Toggle via context menu or keyboard shortcut.
- **Wrap-Up Task**: Gracefully wrap up running tasks instead of hard-cancelling. The agent finishes its current thought and produces a summary before stopping. Available for both individual tasks and team runs.
- **Git Tools**: New agent tools for git operations — `git_commit`, `git_diff`, and `git_branch` — with worktree-aware execution for isolated task environments.
- **Capability Matcher**: Auto-select the best agents for a task based on capability matching against agent role skills and the task requirements.
- **Collaborative Thoughts Panel**: Real-time UI component showing agent thinking, analysis, and synthesis during collaborative and multi-LLM mode runs. Includes phase indicators and streaming thought bubbles.
- **Scroll-to-bottom button**: Floating button in task view for quick navigation to the latest events.
- **VPS uninstall documentation**: Added uninstall/removal instructions for VPS deployments covering both partial (keep data) and full (irreversible) paths for Docker and systemd setups.
- **New skill packs**: Crypto Trading, Crypto Execution, Trading Foundation, and Email Marketing Bible skill definitions with scripts and tests.
- **XLSX file support**: Excel spreadsheets (.xlsx/.xls) can now be read and extracted as tab-separated text in the file viewer, with formula result, rich text, and date support.
- **Attachment chips in chat bubbles**: user message bubbles render compact file-attachment chips instead of raw file-path listings.
- **Varied failure loop detection**: executor detects when a tool fails 5+ times with different inputs and nudges the agent to switch strategy.

### Changed
- **Executor modular refactoring**: TaskExecutor split into dedicated utility modules — completion logic, canvas rendering, prompt heuristics, tool execution, loop management, LLM turn handling, assistant output processing, and workspace preflight checks. New ExecutorEventEmitter and LifecycleMutex for cleaner concurrency control.
- **Task event bridge contract**: Inline event type allowlist extracted from control-plane handlers into a shared `task-event-bridge-contract` module, making it reusable and testable.
- **Task event status map**: Inline status mapping extracted to a shared `task-event-status-map` module used by both renderer and control plane.
- **Agent team orchestrator**: Extended with collaborative mode phases, thought capture, wrap-up support, multi-LLM synthesis, and run phase tracking.
- **Database schema**: Added `is_pinned` column to tasks, `agent_team_thoughts` table, `phase`/`collaborative_mode`/`multi_llm_mode` columns to agent_team_runs, worktree and comparison_session tables.
- **Document creation defaults**: Markdown (.md) is now the preferred output format; `create_document` (DOCX/PDF) only triggers on explicit user request.
- **Hooks auto-token**: enabled hooks server auto-generates a missing authentication token instead of silently disabling.
- **Reduced startup log noise**: zero-count messages for plugins, canvas sessions, and legacy settings are suppressed; MCP stderr demoted to debug.
- **Slack Socket Mode timeouts**: relaxed ping/pong timeouts (15s/60s) to reduce reconnection churn on unstable networks.

### Fixed
- **Stuck 'executing' status**: tasks can no longer remain in `executing` state after follow-ups — safety nets ensure completed or restored status.
- **User identity leakage**: personality prompt now explicitly instructs the LLM to ignore names from file paths, filenames, and OS metadata when a preferred name is stored.
- **WhatsApp connection flap detection**: rapid disconnect/reconnect cycles are detected and throttled with enforced backoff.
- **Artifact false positives**: attachment filenames (e.g. "26targets.xlsx") no longer falsely trigger document-creation mode; read-only steps skip artifact output requirement.
- **Collapsible user bubble toggle**: shows both "Show more" and "Show less" (previously button disappeared after expanding).
- **Daemon shutdown task persistence**: active tasks are marked cancelled in DB before executor cancellation to prevent orphaned-task detection on restart.

## [0.3.86] - 2026-02-14

### Added
- **ACP and Canvas control-plane endpoints**: introduced ACP task-delegation handlers and new canvas APIs (`canvas.list/get/snapshot/content/push/eval/checkpoint.*`) with corresponding protocol constants and IPC wiring.
- **Canvas checkpoint tooling**: added `canvas_checkpoint`, `canvas_restore`, and `canvas_checkpoints` tools, plus in-memory checkpoint history and restore flows in `CanvasManager`.
- **Renderer i18n support**: added language resources and UI selection for English, Japanese, and Simplified Chinese, with persisted language preference.
- **Talk Mode UX**: introduced continuous voice talk-mode hook and UI controls for conversational voice interaction in main task view.

### Changed
- **Agent execution flow hardening**: executor now emits long-running tool heartbeats, tracks recovered failures more precisely, and preflights shell-permission requirements when command execution is required.
- **Shell approvals and safety**: `run_command` now supports single-approval bundle mode for safe command sequences and normalizes signatures more robustly for duplicate detection.
- **Gateway routing extensibility**: router now supports channel-level `defaultAgentRoleId`, `defaultWorkspaceId`, and `allowedAgentRoleIds`, plus new `set_agent` router-rule action.
- **Skill registry backend**: default registry now points to GitHub static catalog mode with client-side cached search and static skill fetch/install paths.
- **Plugin discovery behavior**: plugin registry initializes at startup and supports incremental discovery of newly-added plugins without full re-init.

### Fixed
- **Sensitive shell output leakage**: command output now redacts seed phrases and private-key material before logging/model context.
- **Isolated macOS install keychain prompt safety**: added `COWORK_DISABLE_OS_KEYCHAIN=1` path to bypass OS keychain integration in disposable test environments.
- **Task activity signaling in UI**: task “working” indicators now consider tool calls/results and tool-execution progress heartbeats, reducing false idle states.
- **Install reliability carry-forward**: retains prior setup retry behavior and low-memory setup defaults while validating clean first-install flow.

## [0.3.85] - 2026-02-14

### Fixed
- **Hoisted Electron detection in setup**: `npm run setup` now treats `../electron` as valid in npm-hoisted installs, so first-time setup no longer triggers unnecessary full dependency bootstrap.
- **Native setup install scope**: missing `better-sqlite3` recovery and rebuild now run from the actual install root (not inside `node_modules/cowork-os`), reducing first-run reify pressure that caused frequent macOS `SIGKILL`.
- **Release publish gating**: npm/GitHub package publish jobs now depend on the release validation job, and smoke tests fail if setup unexpectedly falls back to dependency bootstrap.
- **Install docs hardening**: README now includes a direct native retry-wrapper fallback when `npm run --prefix node_modules/cowork-os setup` is terminated by `zsh: killed`, and recommends local bin launch over `npx` for first run.

## [0.3.84] - 2026-02-14

### Fixed
- **Release smoke-test module resolution**: installability validation now runs Electron with `cwd` set to the installed `cowork-os` package directory so `require('better-sqlite3')` resolves correctly after setup.
- **Release continuity**: keeps the 0.3.82 npm SIGKILL regression fix while restoring end-to-end GitHub release packaging path after CI validation.

## [0.3.83] - 2026-02-14

### Fixed
- **Release workflow syntax fix**: corrected the installability smoke-test shell step so the release pipeline no longer exits with `syntax error: unexpected end of file` before desktop packaging.
- **Release continuity**: preserves the 0.3.82 npm SIGKILL fix while restoring full GitHub release asset publishing (DMG/ZIP).

## [0.3.82] - 2026-02-14

### Fixed
- **SIGKILL regression fix for npm installs**: `setup_native` no longer uses `npm install --ignore-scripts=false` when recovering missing `better-sqlite3`, preventing `electron-winstaller` lifecycle scripts from being executed during first-time setup.
- **Recovery install hardening**: missing runtime dependency repair now uses `--omit=dev` and `--package-lock=false` to avoid reifying packaging/dev dependency trees in user runtime installs.

## [0.3.81] - 2026-02-14

### Fixed
- **README install path hardening**: `npm run setup` now skips a full dependency reinstall when the Electron dependency is already present, so fresh `/tmp` installs avoid avoidable reinstall-driven SIGKILL pressure.
- **Native setup reliability**: restores the 0.3.71-style flow with retryable native setup and keeps `better-sqlite3` installation script-safe, then rebuilds it explicitly against Electron ABI.

## [0.3.80] - 2026-02-14

### Fixed
- **macOS install reliability hardening**: setup now skips optional dependency reinstall during `npm run setup`, avoids propagating child SIGKILL events from native setup back to the shell, and documents a first-install flow that avoids macOS-terminating paths.
- **Release validation hardening**: CI now resolves release metadata before install validation and validates installability from either published npm tarball (if already published) or local `npm pack` fallback, preventing release regressions for first-release tags.

## [0.3.79] - 2026-02-14

### Fixed
- **macOS install reliability carry-forward**: retained the 0.3.71 SIGKILL workaround for first-time users by documenting and reinforcing the `npm install --ignore-scripts` + `npm run --prefix node_modules/cowork-os setup` flow.
- **Release workflow hardening**: ensured the macOS release job always creates or reopens the GitHub release as a draft before packaging so `electron-builder` can attach DMG/zip assets without immutable-release failures.
- **Version alignment**: published metadata now identifies this release as `0.3.79` with the same installability and packaging reliability changes.

## [0.3.78] - 2026-02-14

### Fixed
- **Release build hardening**: restored the missing `src/electron/agent/executor-helpers.ts` source file so builds can resolve `executor.ts` imports after packaging from a fresh clone.
- **TypeScript strictness fixes**: fixed implicit `any` errors in `executor.ts` that could break release builds on CI.
- **TLS fingerprint callback typing fix**: aligned `remote-client.ts` callback signature/type usage with current `ws` client typings to satisfy strict build checks.

## [0.3.77] - 2026-02-14

### Fixed
- **Setup script safety**: `npm run setup` in a fresh install now runs dependency reinstall with `--ignore-scripts` so optional postinstall hooks like `electron-winstaller` cannot SIGKILL the process during first-run recovery on macOS.
- **Install reliability carry-forward**: this patch keeps the documented `/tmp` first-install sequence intact while ensuring setup stays stable across npm install layouts.
- **Version alignment**: published metadata is now aligned on `0.3.77` so the installability fix is included in both npm and GitHub release tracks.

## [0.3.76] - 2026-02-14

### Fixed
- **Installability restoration**: pinned `electron` to `40.2.1` so first-time installs from `npm` pull the known-good Electron patch and avoid `SIGKILL` during `node_modules/electron/install.js` on affected macOS environments.
- **README alignment**: clarified the first-time CLI install path to reflect the exact commands users should run from a fresh temporary folder.

## [0.3.75] - 2026-02-14

### Fixed
- **Installability fix from 0.3.71**: restored Electron lockfile behavior by keeping `electron` at `40.2.1` during publish-time installs, matching the working `0.3.71` state and avoiding default `SIGKILL` during `node_modules/electron/install.js` on affected installs.

## [0.3.74] - 2026-02-14

### Fixed
- **Release pipeline reliability**: updated the GitHub release publish step to find and publish the tag created by `electron-builder` instead of assuming the trigger ref matches exactly.
- **Release docs/notes alignment**: updated release notes and README "What’s new" section for `0.3.74` to reflect install and CI reliability fixes.
- **Release artifact consistency**: ensured workflow publishes desktop artifacts and release notes from the same release tag path used by electron packaging.

## [0.3.73] - 2026-02-14

### Fixed
- **Release pipeline fix**: included daemon TypeScript sources in shared ESLint targets so `npm run lint` runs instead of failing with parse errors before build/publish steps.
- **Workspace/task validation fix**: enforced `PersonalityId` validation for task agent configs to prevent runtime/inference mismatches during task creation.
- **CLI and release install tests alignment**: updated control-plane and skill validation tests to match current runtime behaviors and skill metadata output.
- **Workspace preflight reliability**: stabilized ambiguous temp-task auto-switch behavior when project-signals are present and tests now validate that behavior.

## [0.3.72] - 2026-02-14

### Added
- **Session workspace isolation and cleanup**: temp tasks now get session-scoped workspace IDs, dedicated temp directories, and automatic pruning by age + usage caps.
- **Autonomous task mode** in execution flow and control-plane/web-UI paths, with optional bypass of interactive approval prompts where explicitly enabled.
- **Companion-mode handling for short conversational prompts** to return concise check-in responses without running task pipeline when appropriate.
- **Search execution ordering** now prefers Brave when available and can safely fallback through configured providers automatically.
- **PDF parsing compatibility wrapper** with runtime-safe handling for both legacy and v2 parser module shapes.

### Changed
- **Task completion validation tightened** with final-response contracts (required direct answers, artifact checks, verification evidence).
- **Stricter tool failure handling** for hard/unavailable/disallowed outcomes to prevent false completion without real progress.
- **Temporary workspace handling** now uses explicit session-aware IDs and filters temp workspaces from user-visible lists consistently.
- **Search and file tools** now enforce more bounded scanning behavior and clearer fallback behavior under high-load conditions.

### Fixed
- **Watch/skip recommendation tasks** now block artifact tools and require direct recommendation output.
- **Intermittent approval/partial-task updates** reduced by normalizing auto-approved events in UI and task-stream handling.
- **Temp workspace lifecycle reliability** improved through scheduled pruning and safer restore/create paths.

## [0.3.69] - 2026-02-11

### Fixed
- `npm install -g cowork-os` could fail on macOS with `fsevents` (`binding.gyp not found`) due an npm 11 rebuild edge case triggered by `playwright`.
- Switched runtime browser dependency to `playwright-core` via npm alias (`playwright` package name preserved in code) to avoid the failing `fsevents` install path.
- Added launcher self-heal: on first run, `cowork-os` now verifies direct runtime dependencies and repairs missing packages with a script-free npm install pass before boot.
- Moved `@types/jszip` to `devDependencies` and excluded `@types/*` from runtime dependency checks to avoid unnecessary first-run repair installs.
- Moved `@electron/rebuild` to runtime dependencies so native fallback rebuild works in npm-installed environments.
- Fixed native setup fallback to locate `@electron/rebuild` via package exports (instead of resolving blocked subpaths), so fallback rebuild actually runs when needed.
- `cowork-os` first run now uses the shell retry wrapper for native setup, reducing one-shot startup failures when macOS kills a setup attempt under memory pressure.

## [0.3.68] - 2026-02-11

### Fixed
- `cowork-os` CLI startup could still fail with `better-sqlite3` ABI mismatch on first launch.
- Launcher now validates `better-sqlite3` by opening an in-memory database (not just requiring the module) and runs native setup when needed.
- Native setup script now resolves hoisted dependencies correctly (Electron and `better-sqlite3`) so it works in npm-installed layouts.

## [0.3.67] - 2026-02-11

### Added
- Added npm CLI command support: `cowork-os`, `coworkctl`, `coworkd`, and `coworkd-node`.

### Fixed
- Fixed launcher script to resolve the Electron binary correctly (`require('electron')` instead of `require.resolve`).
- Included `dist/` in published npm files so the `cowork-os` command can start without requiring a local build step.
- Moved `electron` to runtime dependencies so CLI launch works after normal npm install.

## [0.3.66] - 2026-02-11

### Fixed
- `npm ci` could hang indefinitely in CI due an `overrides.undici` resolution loop on npm 11.
- Removed the `undici` override so release and publish jobs can complete.

## [0.3.65] - 2026-02-11

### Fixed
- npm publishing no longer waits for the macOS packaging job in `release.yml`.
- This prevents npm release delays when GitHub macOS runners are stalled while still allowing desktop packaging to run independently.

## [0.3.64] - 2026-02-11

### Fixed
- Release workflow could stall for a long time at `Install dependencies` when git-based dependencies attempted SSH transport on GitHub runners.
- CI now forces GitHub git dependencies to HTTPS before `npm ci` in all release/publish jobs.
- Added explicit workflow timeouts and `npm ci --no-audit --no-fund` to reduce long-running hangs during release.

## [0.3.63] - 2026-02-11

### Fixed
- npm installs could still fail with `SIGKILL` in transitive `protobufjs` postinstall hooks under macOS memory pressure.
- Bundled `@mariozechner/pi-ai` and `@whiskeysockets/baileys` in the published npm tarball so their transitive install scripts are not executed on end-user `npm install`.
- Restricted published package contents via `files` in `package.json` to remove large non-runtime artifacts and reduce install-time memory pressure.

## [0.3.62] - 2026-02-11

### Fixed
- npm installs could still fail when the package `postinstall` script itself was SIGKILL'd by macOS memory pressure.
- Removed `postinstall` from the published npm package so `npm install cowork-os@latest` no longer depends on any CoWork lifecycle hook.

## [0.3.61] - 2026-02-11

### Fixed
- npm installs could fail with `sh: electron-rebuild: command not found` because `postinstall` depended on a tool not available in all install contexts.
- `postinstall` now uses a best-effort native setup driver and never fails the overall npm install.
- `better-sqlite3` is now an optional dependency so transient native build failures no longer abort `npm install`; `npm run setup` now ensures it is installed before rebuild.

## [0.3.60] - 2026-02-11

### Fixed
- npm installs could fail on macOS with `Killed: 9` during dependency lifecycle scripts due to floating dependency upgrades.
- Pinned `@whiskeysockets/baileys` to `6.7.16` and `better-sqlite3` to `12.6.2` to avoid pulling newer variants that increased install-time instability.

## [0.3.59] - 2026-02-10

### Fixed
- Increased default native setup outer retry attempts on macOS so `npm run setup` is more resilient to repeated transient `Killed: 9` SIGKILLs on the first run after install.

## [0.3.58] - 2026-02-10

### Fixed
- macOS `npm run setup` could still fail with `Killed: 9` if the native setup retry wrapper itself was SIGKILL’d immediately after install; setup now performs outer retries (with backoff) around native setup so a transient SIGKILL doesn’t require manual re-runs.

## [0.3.57] - 2026-02-10

### Fixed
- macOS `npm run setup` could still fail with `Killed: 9` if the nested `npm run setup:native` process was SIGKILL’d; setup now runs the native setup retry wrapper directly (no nested npm process) and propagates SIGKILL as exit code 137 so retries reliably trigger.

## [0.3.56] - 2026-02-10

### Fixed
- macOS `npm run setup` could still fail with `Killed: 9` if macOS SIGKILL’d Node before in-process retries could run; native setup now uses a POSIX shell retry wrapper with exponential backoff so users don’t need to re-run commands manually.

## [0.3.55] - 2026-02-10

### Fixed
- macOS `npm run setup` could still fail with `Killed: 9` before the retry driver could start; setup now retries native setup at the shell level (multiple attempts) so users don’t need to re-run commands manually.

## [0.3.54] - 2026-02-10

### Fixed
- macOS `npm run setup` could still fail with `Killed: 9` on the first run under memory pressure; native setup now runs via a retrying driver and `setup` disables npm audit/fund to reduce peak memory usage.

## [0.3.53] - 2026-02-10

### Fixed
- macOS `npm run setup` could still fail with `Killed: 9`; native setup now prefers an Electron-targeted `better-sqlite3` rebuild via `npm rebuild` (often uses prebuilds) and only falls back to `electron-rebuild` when necessary.

## [0.3.52] - 2026-02-10

### Fixed
- macOS `npm run setup` could fail with `Killed: 9` during native module rebuild; native setup now defaults to low parallelism for reliability.

## [0.3.29] - 2025-02-08

### Added
- **Vision Tool** - Analyze workspace images (screenshots, photos, diagrams) via `analyze_image`
  - Supports OpenAI, Anthropic, and Google Gemini vision providers
  - Workspace-safe file resolution with MIME type detection
  - Handles images up to 20 MB
- **Email IMAP Tool** - Direct IMAP mailbox access via `email_imap_unread`
  - Check unread emails without requiring Google Workspace integration
  - Uses existing Email channel IMAP/SMTP configuration
- **Chat Commands** - New slash commands available across all gateway channels
  - `/schedule <prompt>` - Schedule recurring agent tasks with results delivered back to the chat
  - `/digest [lookback]` - Generate on-demand digest of recent chat messages
  - `/followups [lookback]` - Extract follow-ups and commitments from recent chat messages
  - `/brief [today|tomorrow|week]` - Generate brief summaries (DM only)
  - `/brief schedule|list|unschedule` - Manage recurring brief schedules
- **Inbound Attachment Persistence** - Channel messages with attachments are saved to workspace
  - Files persisted under `.cowork/inbox/attachments/<date>/<channel>/<chat>/<message>/`
  - Attachment extraction added to Discord, Slack, Teams, Telegram, Google Chat, and iMessage adapters
  - Saved paths appended to task prompts so agents can inspect files (and images via `analyze_image`)
- **Cron Template Variables** - Dynamic variables in scheduled task prompts
  - Date variables: `{{today}}`, `{{tomorrow}}`, `{{week_end}}`, `{{now}}`
  - Chat context variables: `{{chat_messages}}`, `{{chat_since}}`, `{{chat_until}}`, `{{chat_message_count}}`, `{{chat_truncated}}`
  - Conditional delivery: `deliverOnlyIfResult` skips posting when the task produces no output
- **Chat Transcript Formatter** - New `formatChatTranscriptForPrompt()` utility for injecting chat history into agent prompts
- **Tool Restrictions Tests** - New test suite for agent tool restriction enforcement
- **Image Generation (Multi-Provider)** - Generate images via `generate_image` tool with provider auto-selection
  - Supports **Gemini** (gemini-image-fast, gemini-image-pro), **OpenAI** (gpt-image-1, gpt-image-1.5, DALL-E 3/2), and **Azure OpenAI** (deployment-based)
  - Model alias resolution (e.g. "gpt-1.5" → gpt-image-1.5, "dalle-3" → dall-e-3)
  - Provider auto-selection picks the best configured provider when not specified
  - Azure deployment detection for image-capable deployments
  - 180-second tool timeout for remote image generation
- **Visual Annotation Tools** - Agentic generate → annotate → refine → repeat workflow
  - `visual_open_annotator` - Open Live Canvas with an image for visual annotation
  - `visual_update_annotator` - Update the annotator with a new iteration image
  - Structured feedback via canvas interactions (visual_feedback, visual_regenerate, visual_approve)
- **Agentic Image Loop Skill** - New built-in skill for iterative image refinement
  - Generate an image, open the Visual Annotator, collect user markup, refine prompt, regenerate
  - Loops until user approves the result
- **Inline Image Preview** - Generated images display directly in the task event timeline
  - Auto-expands for `file_created`/`file_modified` events with image files
  - Click to open in the full image viewer
- **Local Embeddings for Memory** - Lightweight local vector embeddings without external API calls
  - Token-based hashing for 256-dimensional vectors
  - `MemoryEmbeddingRepository` for persisting embeddings in `memory_embeddings` table
- **Global Imported Memory Search** - Cross-workspace search for ChatGPT imported memories
  - `searchImportedGlobal` enables sessions in any workspace to retrieve imported history
  - FTS with relaxed fallback and LIKE-based backup query

### Changed
- **Task Export** - Moved from `telemetry/` to `reports/` to better reflect purpose (structured task summaries, not telemetry)
- **Skill Metadata** - Added `requires.bins` and `invocation.disableModelInvocation` to gog and himalaya skills
- **Local Websearch Skill** - Updated branding (moltbot → cowork) and paths to `Application Support/cowork-os`
- **Agent Executor** - Improved email fallback logic: prefers `email_imap_unread` when Google Workspace tools are unavailable
- **Agent Executor** - Fixed missing `tool_result` entries on pause/cancel to keep API message history valid
- **Channel Tools** - Added channel status and warning metadata to `channel_list_chats` and `channel_history` results
- **Cron Delivery** - When a task has a non-empty result, delivery messages now include the result text directly instead of a generic status line
- **Email Client TLS** - Load macOS system keychain CAs for IMAP/SMTP connections (fixes corporate proxy/antivirus TLS inspection)
- **Email Client IMAP** - Improved response buffering and greeting handling reliability
- **Image Generation** - Replaced single-provider "nano-banana" model system with multi-provider architecture; removed deprecated model aliases from pricing
- **Gemini Provider** - Removed `banana` filter from model discovery exclusion list
- **Verification Steps** - Verification steps are now internal; agent responds with "OK" on success instead of verbose summaries
- **Task Timeline UI** - Verification step events (step_started, step_completed, verification_started/passed) are filtered from the timeline
- **Plan Display** - Verification steps hidden from displayed plan step lists (still shown on failure)

### Added (UI)
- **step_failed Event** - New event type rendered with error styling in task timeline, right panel, and task timeline views

### Fixed
- **Gateway Message Logging** - Outgoing message persistence is now best-effort (never fails delivery)
- **Security Docs** - Corrected `userData` paths, documented platform-specific locations
- **Architecture Docs** - Added vision tool, chat commands, attachment handling, and cron template variable documentation

## [0.3.25] - 2025-02-05

### Added
- **Google Workspace Integration** - Unified access to Gmail, Google Calendar, and Google Drive
  - **Shared OAuth Authentication**: Single sign-in for all Google services
  - **Gmail Tools**: `gmail_action` for sending emails, reading messages, creating drafts, searching
  - **Calendar Tools**: `google_calendar_action` for creating, updating, and managing events
  - **Drive Tools**: Enhanced `google_drive_action` with improved error handling
  - **Settings UI**: Google Workspace is accessible as a card in **Settings** > **Integrations**
- **Gateway Channel Enhancements** - Improved channel implementations
  - **Gateway Cleanup**: Proper cleanup on disconnect for all channels
  - **Matrix Direct Rooms**: Support for direct message rooms in Matrix
  - **Slack Group Handling**: Proper `is_group` detection for Slack channels
  - **WhatsApp Config**: Enhanced configuration options for WhatsApp
  - **Security Pending State**: Better handling of pending security approvals
- **Agent Transient Error Retry** - Automatic retry for transient failures
  - **Daemon Retry**: Transient errors in daemon scheduling trigger automatic retry with exponential backoff
  - **Executor Retry**: Step processing failures are retried before failing the task
  - **Graceful Degradation**: Non-critical errors don't abort entire task execution
- **Document Tool Parameter Inference** - Smart parameter handling for document creation
  - **Filename Inference**: Automatically infer filename from path or name parameters
  - **Format Detection**: Detect document format (docx/pdf) from file extension
  - **Content Fallback**: Use assistant output as content when not explicitly provided
  - **Validation Errors**: Return helpful error messages for missing required fields
- **Channel User Repository** - Track user-channel mappings in database
- **Encrypted Settings Storage (SecureSettingsRepository)** - All settings now stored encrypted in database
  - **OS Keychain Integration**: Settings encrypted using native OS keychain (macOS Keychain, Windows DPAPI, Linux libsecret)
  - **Fallback Encryption**: App-level AES-256 encryption when OS keychain unavailable
  - **Stable Machine ID**: Persistent machine identifier survives hostname changes and system updates
  - **Data Integrity**: SHA-256 checksums detect corruption or tampering
  - **Backup & Recovery**: Create encrypted backups of all settings, restore with optional overwrite
  - **Health Checks**: `loadWithStatus()` and `checkHealth()` APIs for debugging encryption issues
  - **Settings Categories**: voice, llm, search, appearance, personality, guardrails, hooks, mcp, controlplane, channels, builtintools, tailscale, claude-auth, queue, tray
  - **Safe Migration**: Legacy JSON settings automatically migrated with backups preserved on failure
- **Mobile Companions** - Connect iOS/Android devices as mobile nodes for device-specific actions
  - **Node Architecture**: Mobile devices connect as "nodes" via WebSocket with role-based authentication
  - **Device Capabilities**: Camera capture, location access, screen recording, SMS (Android only)
  - **Standard Commands**:
    - `camera.snap` - Take a photo with front/back camera
    - `camera.clip` - Record video clip
    - `location.get` - Get current GPS location (coarse or precise)
    - `screen.record` - Record device screen
    - `sms.send` - Send SMS message (Android only)
  - **AI Agent Tools**: 6 new tools for agent interaction with mobile devices
    - `node_list` - List connected mobile companions
    - `node_describe` - Get detailed info about a specific node
    - `node_camera_snap` - Take a photo using a mobile node's camera
    - `node_location` - Get current location from a mobile node
    - `node_screen_record` - Record screen on a mobile node
    - `node_sms_send` - Send SMS via an Android node
  - **Settings UI**: New "Mobile Companions" tab in Settings
    - View connected devices with status and capabilities
    - Test commands directly from the UI
    - Connection instructions and troubleshooting
  - **Foreground Detection**: Commands like camera/screen require the app to be in foreground
  - **Permission Tracking**: Monitor granted permissions per capability
  - **Event Broadcasting**: Operators receive real-time node connect/disconnect events
- **Live Canvas Interactive Mode** - Full browser-like interaction directly in the preview
  - **Interactive mode** (default): Embedded webview for clicking, scrolling, and interacting with canvas content
  - **Snapshot mode**: Static screenshot with auto-refresh for monitoring
  - Toggle between modes with **I** key or pointer button
  - Resizable preview by dragging the bottom edge
  - Export options: Download HTML, open in browser, show in Finder
  - Snapshot history panel to browse previous states
  - Console viewer for canvas logs
- **Scheduled Tasks (Cron Jobs)** - Automate recurring tasks with cron expressions
  - Schedule tasks using standard cron syntax (minute, hour, day, month, weekday)
  - Visual schedule builder for users unfamiliar with cron syntax
  - Workspace binding - each scheduled task runs in a specific workspace
  - Channel delivery - optionally send task results to Telegram, Discord, Slack, WhatsApp, or iMessage
  - Run history - view execution history with status, duration, and error details
  - Enable/disable jobs without deleting them
  - Manual trigger to run any scheduled task on-demand
  - Configurable concurrent run limits (default: 3)
  - Desktop notifications when scheduled tasks complete or fail
- **In-App Notification Center** - Centralized notification management
  - Bell icon in the top-right corner with unread badge count
  - Dropdown notification panel accessible from the title bar
  - Click-to-navigate - click any notification to jump to the related task
  - Mark as read - individual or bulk "mark all as read" actions
  - Delete notifications - remove individual or clear all
  - Real-time updates - new notifications appear instantly without refresh
  - macOS native desktop notifications for scheduled task completions
  - Notification types: task_completed, task_failed, scheduled_task, info, warning, error
  - Persistent storage - notifications survive app restarts
- **WhatsApp Bot Integration** - Run tasks via WhatsApp with the Baileys library
  - QR code pairing for WhatsApp Web connection
  - Self-Chat Mode for users using their personal WhatsApp number
    - Bot only responds in "Message Yourself" chat when enabled
    - Configurable response prefix (e.g., "🤖") to distinguish bot messages
  - Standard security modes: Pairing, Allowlist, Open
  - Full command support: `/start`, `/help`, `/workspaces`, `/workspace`, `/newtask`, `/status`, `/cancel`, `/pair`
  - Markdown to WhatsApp formatting conversion (`**bold**` → `*bold*`, headers, strikethrough, links)
  - Automatic cleanup of expired pairing codes
  - Logout and re-pairing support
- **AppleScript Execution** - New `run_applescript` system tool for macOS automation
  - Execute AppleScript code to control applications and automate system tasks
  - Control apps like Safari, Finder, Mail, and more
  - Manage windows, click UI elements, send keystrokes
  - Get/set system preferences and interact with files
  - 30-second timeout with 1MB output buffer
  - macOS only (graceful error on other platforms)
- **Configurable Guardrails** - User-configurable safety limits in Settings > Guardrails
  - **Token Budget**: Limit total tokens per task (default: 100,000, range: 1K-10M)
  - **Cost Budget**: Limit estimated cost per task (default: $1.00, disabled by default)
  - **Iteration Limit**: Limit LLM calls per task to prevent infinite loops (default: 50)
  - **Dangerous Command Blocking**: Block shell commands matching dangerous patterns (enabled by default)
    - Built-in patterns: `sudo`, `rm -rf /`, `mkfs`, `dd if=`, fork bombs, `curl|bash`, etc.
    - Support for custom regex patterns
  - **File Size Limit**: Limit file write size (default: 50MB)
  - **Domain Allowlist**: Restrict browser automation to approved domains (disabled by default)
- Model pricing table for cost estimation (Anthropic, Bedrock, Gemini, OpenRouter models)
- New IPC handlers and preload APIs for guardrail settings

### Changed
- Task executor now tracks token usage, cost, and iterations across LLM calls
- Shell commands are blocked by guardrails before reaching approval dialog
- File writes check size limits before writing
- Browser navigation checks domain allowlist when enabled

## [0.1.7] - 2025-01-26

### Added
- **Shell Command Execution** - AI can now execute shell commands with user approval
  - `run_command` tool for running terminal commands (npm, git, brew, etc.)
  - Each command requires explicit user approval before execution
  - Configurable timeout (default 60s, max 5 minutes)
  - Output truncation for large command outputs (100KB max)
  - New `shell` permission in workspace settings (disabled by default)
- `/shell` command for Discord/Telegram to enable/disable shell execution
  - `/shell` - Show current status
  - `/shell on` - Enable shell commands for workspace
  - `/shell off` - Disable shell commands
- **Safety & Data Loss Warning** in README
  - Prominent warning section at top of documentation
  - Guidelines for safe usage (separate environment, non-critical folders, backups)
  - Clear disclaimer of maintainer responsibility

### Changed
- Workspace permissions now include `shell: boolean` field
- Updated help text in Discord/Telegram bots to include shell command info
- Permission model documentation updated in README

## [0.1.6] - 2025-01-25

### Added
- **Discord Bot Integration** - Full Discord support with slash commands and DMs
  - `/start` - Start the bot and get help
  - `/help` - Show available commands
  - `/workspaces` - List available workspaces
  - `/workspace` - Select or show current workspace
  - `/addworkspace` - Add a new workspace by path
  - `/newtask` - Start a fresh task/conversation
  - `/provider` - Change or show current LLM provider
  - `/models` - List available AI models
  - `/model` - Change or show current model
  - `/status` - Check bot status
  - `/cancel` - Cancel current task
  - `/task` - Run a task directly
- Direct message support for conversational interactions
- Mention-based task creation in server channels
- Automatic message chunking for Discord's 2000 character limit
- Guild-specific or global slash command registration

### Changed
- Channel gateway now supports both Telegram and Discord adapters
- Added `discord.js` dependency for Discord API integration

## [0.1.5] - 2025-01-25

### Added
- **Browser Automation** - Full browser control using Playwright
  - `browser_navigate` - Navigate to any URL
  - `browser_screenshot` - Capture page or full-page screenshots
  - `browser_get_content` - Extract text, links, and forms from pages
  - `browser_click` - Click on elements using CSS selectors
  - `browser_fill` - Fill form fields
  - `browser_type` - Type text character by character (for autocomplete)
  - `browser_press` - Press keyboard keys (Enter, Tab, etc.)
  - `browser_wait` - Wait for elements to appear
  - `browser_scroll` - Scroll pages up/down/top/bottom
  - `browser_select` - Select dropdown options
  - `browser_get_text` - Get element text content
  - `browser_evaluate` - Execute JavaScript in browser context
  - `browser_back/forward` - Navigate browser history
  - `browser_reload` - Reload current page
  - `browser_save_pdf` - Save pages as PDF
  - `browser_close` - Close the browser
- Automatic browser cleanup when tasks complete or fail
- Headless Chrome browser (Chromium) via Playwright

### Changed
- Tool registry now includes 17 browser automation tools
- Executor now handles resource cleanup in finally block

## [0.1.4] - 2025-01-25

### Added
- **Real Office Format Support** - Documents now create actual Office files instead of text placeholders
  - Excel (.xlsx) files with `exceljs` - multiple sheets, auto-fit columns, header formatting, filters, frozen rows
  - Word (.docx) files with `docx` - headings, paragraphs, lists, tables, code blocks with proper styling
  - PDF files with `pdfkit` - professional document generation with custom fonts and margins
  - PowerPoint (.pptx) files with `pptxgenjs` - multiple slide layouts (title, content, two-column, image), speaker notes, themes
- Spreadsheet read capability for existing Excel files
- Fallback to CSV/Markdown when those extensions are explicitly requested

### Changed
- SpreadsheetBuilder now creates real Excel workbooks with formatting
- DocumentBuilder supports Word, PDF, and Markdown output formats
- PresentationBuilder creates professional PowerPoint presentations with layouts

## [0.1.3] - 2025-01-25

### Added
- CLI/ASCII terminal-style UI throughout the application
- Model selection dropdown (Opus 4.5, Sonnet 4.5, Haiku 4.5)
- AWS Bedrock support as alternative to Anthropic API
- Telegram bot integration with full command support
- Web search integration (Tavily, Brave, SerpAPI, Google)
- Ollama support for local LLM inference

### Changed
- Updated branding to CoWork OS
- Improved workspace selector with terminal aesthetic

## [0.1.0] - 2025-01-24

### Added

#### Core Features
- Task-based workflow with multi-step execution
- Plan-execute-observe loop for agent orchestration
- Real-time task timeline with live activity feed
- Workspace management with folder selection

#### Agent Capabilities
- File operation tools (read, write, list, rename, delete)
- Built-in skills:
  - Spreadsheet creation (Excel format)
  - Document creation (Word/PDF)
  - Presentation creation (PowerPoint)
  - Folder organization

#### Security & Permissions
- Sandboxed file operations within selected workspace
- Permission system for destructive operations
- Approval dialogs for file deletion and bulk operations
- Path traversal protection

#### LLM Integration
- Anthropic Claude API support
- AWS Bedrock support
- Multiple model selection (Opus, Sonnet, Haiku)
- Settings UI for API configuration

#### User Interface
- Electron desktop application for macOS
- React-based UI with dark theme
- CLI/ASCII terminal aesthetic
- Task list with status indicators
- System monitor panel (progress, files, context)

#### Data Management
- SQLite local database
- Task and event persistence
- Workspace history
- Artifact tracking

### Technical
- Electron 40 with React 19
- TypeScript throughout
- Vite for fast development
- electron-builder for packaging

## [0.0.1] - 2025-01-20

### Added
- Initial project setup
- Basic Electron app shell
- Database schema design
- IPC communication layer

---

## Version History Summary

| Version | Date | Highlights |
|---------|------|------------|
| 0.3.90 | 2026-02-23 | Git worktree isolation, collaborative mode, multi-LLM mode, agent comparison, task pinning, wrap-up, git tools, executor refactoring |
| 0.3.84 | 2026-02-14 | Fixes CI installability check module resolution so release validation passes and desktop packaging can continue |
| 0.3.83 | 2026-02-14 | Fixes release workflow shell parsing so installability validation and desktop asset publishing complete successfully |
| 0.3.82 | 2026-02-14 | Removes script-enabled recovery installs that triggered electron-winstaller SIGKILL and hardens runtime repair install flags |
| 0.3.81 | 2026-02-14 | Restored reliable /tmp install flow with retry-safe native setup and CI validation for both registry and npm-pack install paths |
| 0.3.80 | 2026-02-14 | Fixed macOS first-install runtime setup reliability and hardened release validation so new tags can still run installation checks |
| 0.3.79 | 2026-02-14 | Retained the 0.3.71 SIGKILL workaround and hardened draft release preparation so desktop assets upload reliably |
| 0.3.78 | 2026-02-14 | Fixes missing release-time `executor-helpers` source and remaining strict-mode TypeScript blockers |
| 0.3.77 | 2026-02-14 | Skips lifecycle scripts during setup reinstall and prevents setup-time SIGKILL in user-first installs |
| 0.3.76 | 2026-02-14 | Pinned Electron to 40.2.1 for first-run installability and aligned README CLI flow |
| 0.3.75 | 2026-02-14 | Restored 0.3.71-compatible Electron lockfile for installability and release confidence |
| 0.3.73 | 2026-02-14 | Release automation hardening and task/workspace validation fixes |
| 0.3.72 | 2026-02-14 | Session-based temp workspaces, autonomous execution mode, safer completion validation |
| 0.3.29 | 2025-02-08 | Multi-provider image generation, visual annotation, local embeddings, verification UX |
| 0.3.25 | 2025-02-05 | Google Workspace integration, gateway enhancements, agent retry logic |
| 0.1.6 | 2025-01-25 | Discord bot integration with slash commands |
| 0.1.5 | 2025-01-25 | Browser automation with Playwright |
| 0.1.4 | 2025-01-25 | Real Office format support (Excel, Word, PDF, PowerPoint) |
| 0.1.3 | 2025-01-25 | Telegram bot, web search, Ollama support |
| 0.1.0 | 2025-01-24 | First public release with core features |
| 0.0.1 | 2025-01-20 | Initial development setup |

[Unreleased]: https://github.com/CoWork-OS/CoWork-OS/compare/v0.5.41...HEAD
[0.5.41]: https://github.com/CoWork-OS/CoWork-OS/compare/v0.5.40...v0.5.41
[0.5.40]: https://github.com/CoWork-OS/CoWork-OS/compare/v0.5.35...v0.5.40
[0.5.35]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.5.35
[0.5.34]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.5.34
[0.5.23]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.5.23
[0.5.19]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.5.19
[0.5.18]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.5.18
[0.5.17]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.5.17
[0.5.16]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.5.16
[0.5.15]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.5.15
[0.5.14]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.5.14
[0.5.13]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.5.13
[0.5.11]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.5.11
[0.5.1]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.5.1
[0.5.0]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.5.0
[0.4.13]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.4.13
[0.4.12]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.4.12
[0.4.11]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.4.11
[0.4.10]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.4.10
[0.4.9]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.4.9
[0.4.8]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.4.8
[0.4.7]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.4.7
[0.4.6]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.4.6
[0.4.1]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.4.1
[0.3.90]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.3.90
[0.3.84]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.3.84
[0.3.83]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.3.83
[0.3.82]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.3.82
[0.3.81]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.3.81
[0.3.80]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.3.80
[0.3.79]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.3.79
[0.3.78]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.3.78
[0.3.77]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.3.77
[0.3.76]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.3.76
[0.3.75]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.3.75
[0.3.73]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.3.73
[0.3.72]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.3.72
[0.3.71]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.3.71
[0.3.29]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.3.29
[0.3.25]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.3.25
[0.1.6]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.1.6
[0.1.5]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.1.5
[0.1.4]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.1.4
[0.1.3]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.1.3
[0.1.0]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.1.0
[0.0.1]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.0.1
