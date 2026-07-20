# Development Guide

## Prerequisites

- Node.js 24+ and npm
- macOS 12 (Monterey)+ or Windows 10/11
- `sqlite3` CLI (required for eval corpus/replay scripts)
- macOS: Xcode Command Line Tools (needed for `better-sqlite3`): `xcode-select --install`
- Windows: Visual Studio Build Tools 2022 (C++) and Python 3 (needed for native module builds)
- macOS location helper: Swift toolchain (included with Xcode CLI tools) for compiling the Core Location helper binary
- Linux location helper: `gdbus` (part of `glib2` / `libglib2.0-bin`) and a running GeoClue2 service for desktop location support
- LLM provider credentials are optional for development, but AI task execution still needs a working route: ChatGPT sign-in, local Ollama, or provider credentials.

## Build from Source

```bash
# Clone the repository
git clone https://github.com/CoWork-OS/CoWork-OS.git
cd CoWork-OS

# Install dependencies
npm install

# Set up native modules for Electron (includes macOS retry and Windows ARM64 fallback handling)
npm run setup

# Build and package the app
npm run build          # compile TypeScript and bundle the UI
npm run build:cli      # compile the standalone cowork CLI
npm run package        # package desktop installers (.dmg on macOS, .exe on Windows)
```

Once complete, the packaged app will be in the `release/` folder:
- **`*.dmg`** — macOS installer image
- **`*.exe`** — Windows NSIS installer
- **`mac-*/CoWork OS.app`** — unpacked macOS app bundle
- **`win-*/`** — unpacked Windows app directory

## Linux Server Release Package

The Linux server artifact is separate from desktop packaging. It is a Linux x64 tarball for VPS/systemd deployments:

```bash
npm run package:linux:server
npm run package:linux:server:smoke
```

This must run on Linux x64 so native runtime modules match the target. The package script builds the daemon and connectors, stages runtime dependencies, installs the Electron binary compatibility dependency, copies the full `resources/` tree, derives the connector list from `build:connectors`, writes `release/cowork-os-server-linux-x64-v<version>.tar.gz`, and writes a matching `.sha256` file.

The smoke test extracts the tarball, verifies required files/resources/dependencies, checks `better-sqlite3`, confirms the Electron binary exists, starts `coworkd-node` on a temporary Control Plane port, and checks `/health`.

Managed deployment hardening is part of this release path: the daemon reports deployment posture through `config.get`, blocks unsafe public Control Plane binds in headless/managed mode, and the Docker/systemd templates default to loopback/private exposure with hardened process settings.

## Development Mode

Run the app with hot reload:

```bash
npm run dev
```

On macOS, development startup enables Node's system certificate store by default with `NODE_OPTIONS=--use-system-ca`. This helps provider calls work on corporate networks where tools such as Zscaler install a company root certificate into the macOS trust store. To opt out for comparison, run:

```bash
COWORK_DEV_USE_SYSTEM_CA=0 npm run dev
```

If a corporate root certificate still is not trusted by Node, export it as PEM and use:

```bash
NODE_EXTRA_CA_CERTS=/path/to/company-root.pem npm run dev
```

`npm run dev` checks **Settings → Appearance → Developer logging** (default: off).
When enabled, each captured run writes a readable text log and a structured JSONL log:

- `logs/dev-YYYYMMDD-HHMMSS.log` — human-readable output with an ISO date/time prefix.
- `logs/dev-YYYYMMDD-HHMMSS.jsonl` — machine-readable events for diagnostics and self-improvement ingestion.
- `logs/dev-latest.log` and `logs/dev-latest.jsonl` — overwritten mirrors for the most recent captured run.
- `logs/dev-runs.json` — retained-run manifest with start/end time, exit status, file paths, byte size, line count, and warning/error counts.

The terminal output is unchanged. Files written under `logs/` are redacted before they are stored:
common bearer/basic auth headers, API keys, tokens, secrets, passwords, and URL credentials are replaced with `[REDACTED]`.
JSONL events include `timestamp`, `runId`, `process`, `stream`, `level`, `component`, `message`,
`rawLine`, and optional `taskId`, `workspaceId`, `error`, and `metadata` fields.

When Developer logging is enabled, renderer performance telemetry is sent through the
`renderer:perfLog` IPC channel and appears in the same dev logs. Startup marks include
`app_shell_ready`, `sidebar_ready`, `main_view_ready`, `composer_ready`, and
`first_task_rows_ready`; task-surface logs also summarize render counts, projection timings,
event append latency, scroll-follow writes, and long-task/frame-gap samples.

Captured dev logs are local-only and cleaned up automatically. Defaults keep logs from the last 14 days,
always retain the newest 20 runs, and cap retained `dev-*.log`/`dev-*.jsonl` files at 100 MB by deleting
oldest run pairs first. Local overrides are available:

```bash
COWORK_DEV_LOG_RETENTION_DAYS=7 COWORK_DEV_LOG_MIN_RUNS=10 COWORK_DEV_LOG_MAX_MB=50 npm run dev:log
```

Force log capture regardless of Settings:

```bash
npm run dev:log
```

## Available Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development mode; log capture follows Settings toggle |
| `npm run dev:log` | Start development mode and force redacted text + JSONL logs to `logs/` |
| `npm run dev:start` | Internal raw dev start command (used by wrappers) |
| `npm run build` | Production build |
| `npm run build:cli` | Compile the `cowork` CLI TypeScript output |
| `npm run package` | Package desktop installers (`.dmg` on macOS, `.exe` on Windows) |
| `npm run package:linux:server` | Build the Linux x64 server tarball and checksum on Linux |
| `npm run package:linux:server:smoke` | Extract and boot-smoke the Linux server tarball on Linux |
| `npm run setup` | Set up native modules for Electron |
| `npm run fmt` | Format code with Oxfmt |
| `npm run fmt:check` | Check formatting without writing |
| `npm run lint` | Run Oxlint (fast, Rust-based linter) |
| `npm run type-check` | TypeScript validation |
| `npm run qa:eval:build` | Build regression eval corpus from failed/partial tasks |
| `npm run qa:eval:run` | Replay eval suite (deterministic or hooks mode) |
| `npm run qa:eval:enforce-regressions` | Enforce production-fix -> eval-case policy |
| `npm run qa:renderer-perf` | Replay renderer task-surface performance fixtures, including noisy failure storms |
| `npm run qa:timeline:backfill` | Recompute timeline completion telemetry for `task_completed` timeline events |
| `npm run qa:timeline:enforce` | Enforce timeline reliability thresholds from completion telemetry |
| `npm run qa:reliability` | Reliability loop (`qa:eval:run` + battery script) |
| `npm run skills:validate-routing` | Validate skill routing metadata |
| `npm run skills:validate-content` | Validate skill prompt content, placeholders, and references |
| `npm run skills:audit` | Generate skill audit scorecards in `tmp/qa/` |
| `npm run skills:check` | Run full skill quality gate (routing + content + audit + eval) |

## macOS Dev Electron Bundle

On macOS, `npm run dev` brands the local `node_modules/electron/dist/Electron.app` display name and icon as CoWork OS by default. The branding script preserves `CFBundleName=Electron` and `CFBundleIdentifier=com.github.Electron` so development safeStorage continues to use the Electron identity.

Use these overrides only when you explicitly need them:

```bash
COWORK_DEV_BRAND_APP=0 npm run dev
COWORK_CODESIGN_ENABLE=1 node scripts/codesign_electron_dev.mjs
COWORK_CODESIGN_IDENTITY="Apple Development: Name (TEAMID)" node scripts/codesign_electron_dev.mjs
```

Development codesigning remains opt-in for a valid app bundle. If local branding or another file mutation leaves `Electron.app` with an invalid signature, `scripts/codesign_electron_dev.mjs` repairs it with an ad-hoc development signature without app entitlements, so macOS can register the app while Electron's run-as-node native-module checks keep working.

## CLI Development

The standalone terminal entrypoint is `cowork`. It is separate from in-app terminal tabs: terminal tabs give users a real PTY inside the desktop workspace, while `cowork` starts CoWork tasks from an external terminal.

Implementation landmarks:

- `bin/cowork-cli.js`: npm binary launcher and source-checkout artifact bootstrap
- `src/cli/main.ts`: argument parsing, interactive terminal UI, slash commands, diagnostics, and remote dispatch
- `src/cli/direct-run.ts`: local one-shot task execution
- `src/electron/main.ts`: hidden `--cowork-cli-direct-run` app-entry mode for local CLI tasks
- `tsconfig.cli.json`: CLI TypeScript build target

Common local commands:

```bash
npm run build:cli
cowork --help
cowork
cowork run "who are you?"
cowork run "who are you?" --json
COWORK_CLI_DEBUG=1 cowork run "diagnose local provider setup"
```

Local `cowork run` should not require `COWORK_CONTROL_PLANE_TOKEN`. It uses the local profile and normally prefers the hidden Electron app-entry runner so desktop-encrypted settings can be read with the same app identity. `cowork run ... --remote` is the explicit Control Plane client path and is the mode that requires Control Plane URL/token configuration.

Focused validation:

```bash
npm run build:cli
npm run build:electron
npx vitest run src/cli/__tests__/main.test.ts src/cli/__tests__/terminal-ui.test.ts src/cli/__tests__/local-control-plane-discovery.test.ts
```

For packaged or npm-release checks, verify the package includes `dist/cli`, `bin/cowork-cli.js`, and `tsconfig.cli.json`, then test both `cowork --help` and one local `cowork run` command from a clean install.

## Renderer Bundle Size

The renderer startup bundle is intentionally kept separate from secondary product surfaces and heavyweight renderers.

Current bundle-splitting rules:

- Keep the app shell and `Sidebar` available on initial load. The selected task surface renders
  `TaskViewSkeleton` immediately while the lazy `MainContent` chunk hydrates; `RightPanel` is also
  lazy-loaded behind its own lightweight fallback.
- Lazy-load secondary views from `App.tsx`: Settings, Browser, Home, Devices, Health, Ideas, Inbox Agent, Agents Hub, and Mission Control.
- Keep the in-app browser workbench renderer-owned. `BrowserWorkbenchView` registers its Electron webview `webContentsId` with the main process, and browser tools route visible actions through `BrowserWorkbenchService` into `BrowserSessionManager`. Browser V2 automation should be CDP-backed through Electron `webContents.debugger` for snapshots, ref-aware actions, dialogs, diagnostics, downloads/uploads, emulation, traces, and screenshots; renderer DOM scripts are compatibility fallback, not the primary control plane. Browser Workbench IPC also carries open requests, status updates, screenshot capture, annotation handoff, diagnostics state, cursor events for visible agent movement, and viewport events so `browser_emulate` can resize the shared webview for responsive QA. Do not replace generated web artifact iframes with this live browser path; artifact previews and live website testing are separate surfaces. See [Browser Workbench](browser-workbench.md) and [Browser V2 Architecture](browser-v2-architecture.md).
- Keep Browser Use Cloud as an explicit backend, not a default fallback. The Browser Use client lives in `src/electron/agent/browser/browser-use-cloud-client.ts`, uses `BROWSER_USE_API_KEY` or encrypted `browser-use` settings, and connects through the existing Playwright CDP path. Preserve the private/local target block, API error redaction, stale-session retry, and pending-stop behavior when changing browser routing. Focused checks: `npx vitest run src/electron/agent/browser/__tests__/browser-use-cloud-client.test.ts src/electron/agent/tools/__tests__/browser-tools.test.ts src/electron/security/__tests__/network-policy.test.ts tests/tools/shell-tools.test.ts`.
- Keep CSS split by surface. `src/renderer/styles/index.css` is for app-wide tokens/layout plus the
  small critical composer startup block needed before lazy chunks hydrate. `src/renderer/components/main-content.css`
  owns the heavier task surface, welcome view, remote file picker, workspace/permission dropdowns, and
  skills menu. Do not move task composer rules into `right-panel.css`; otherwise the center view can
  restart with unstyled native controls before the right panel chunk loads.
- Do not import heavyweight optional renderers at module top level when they are needed only for
  specific content. Markdown rendering, GFM plugins, syntax highlighting, and Mermaid rendering are
  loaded behind visible message/code surfaces instead of being eager `MainContent` dependencies.
- Do not import the `highlight.js` package root in renderer code. Use `highlight.js/lib/core` inside
  the lazy highlighting component and register only the language grammars the UI should support.
- Prefer feature-level dynamic imports before adding Rollup `manualChunks`; manual chunks improve cache boundaries, but they do not remove code from startup if imports remain static.
- Keep terminal tabs lazy-loaded. `TerminalTabsDock` imports xterm.js and its CSS, so it should stay behind the terminal-open path rather than becoming part of the startup bundle.

The initial optimization reduced the renderer entry chunk from about `4,842 kB` minified (`1,267 kB` gzip) to about `1,259 kB` minified (`364 kB` gzip) in `npm run build:react`. Large feature code now appears as separate chunks such as `Settings`, `mermaid.core`, PDF, KaTeX, and chart/diagram chunks.

When changing renderer imports, validate with:

```bash
npm run build:react
npm run qa:renderer-perf
npm run type-check
```

Use `npm run build:react` output as a budget check: the main renderer entry should remain below
`900 kB` minified, the Settings initial chunk below `700 kB` minified, and built global CSS below
`450 kB`. If the entry chunk grows unexpectedly, rebuild with sourcemaps and inspect the generated
`dist/renderer/assets/index-*.js.map` to identify newly eager modules.

## Automation Studio

Automation Studio is the main-sidebar structured-flow surface. It is separate from the prompt-based Routine editor and advanced automation tabs in Settings, while reusing the Routine shell for workspace, approval policy, connector policy, trigger compilation, and product-level run summaries. See [Automation Studio](automation-studio.md) for the full operator, runtime, security, persistence, troubleshooting, and validation contract.

Implementation rules:

- Route `currentView === "automations"` from `src/renderer/App.tsx` to `AutomationStudioPanel`; keep `src/renderer/components/Settings.tsx` free of that panel.
- Keep the workflow exchange contract in `src/shared/routine-workflow.ts` serializable and versioned. Do not import Electron-only code into it.
- Register every `routine:workflow*` channel through `setupRoutineHandlers` before the renderer loads, and expose only the typed preload methods. `npm run dev:react` cannot validate this route because it has no Electron preload or IPC handlers.
- Run `RoutineService.ensureSchema()` before workflow repository indexes that depend on compatibility columns such as `routine_runs.workflow_run_id`. Database upgrades must remain additive and must not require deleting app data.
- Save every structured edit as a new draft version. Runtime starter polling, action account resolution, activation validation, and recovery must resolve the immutable active version rather than the mutable compatibility `routine.workflow` draft.
- Recover queued/running runs before draining new inbox events. Requeue `processing` events at startup and move interrupted running/retrying steps to explicit outcome verification instead of replaying them automatically.
- Thread one `AbortSignal` through the engine, action adapters, Google requests/uploads, signed webhook transport, and backing agent cancellation. Keep external-write/data-export automatic attempts capped at one.
- Enforce connector allowlists and validate custom MCP arguments against the live tool schema immediately before invocation.
- Redact sensitive-key payloads before persistence and keep retention maintenance version-aware.
- Preserve `.automation-studio-main` as the vertical scroll owner. Catalog and Activity panes may scroll internally; fixed viewport heights must not trap the lower test/scope panel. Keep long card text wrapping and responsive builder collapse covered by layout tests.

Focused validation:

```bash
npx vitest run \
  src/electron/routines/workflow/__tests__/validation.test.ts \
  src/electron/routines/workflow/__tests__/repository.test.ts \
  src/electron/routines/workflow/__tests__/engine.test.ts \
  src/electron/routines/workflow/__tests__/action-executor.test.ts \
  src/electron/routines/workflow/__tests__/google-starter-watcher.test.ts \
  src/renderer/components/__tests__/automation-studio-placement.test.ts \
  src/renderer/components/__tests__/automation-studio-layout.test.ts \
  src/renderer/components/__tests__/automation-studio-branching.test.ts
npm run type-check
npm run build:electron
npm run build:react
```

## Task Automation UI

Task view supports `... > Add automation...`, a renderer-side shortcut that creates a task-sourced routine from the current task. Schedule, API, and event triggers then compile to the existing cron, webhook, and event-trigger engines.

Implementation contract:

- The task title/three-dot menu lives in `src/renderer/components/MainContent.tsx`.
- The modal is `TaskAutomationModal` in the same file so task-derived defaults stay local to task view.
- Saving must call `window.electronAPI.createRoutine` with `buildTaskRoutineCreate`; do not create a parallel automation store for this flow.
- Default target mode is `Continue thread`, which stores the selected task as `targetTaskId` and compiles schedule triggers to cron jobs with `runMode: "thread_follow_up"`.
- `New task` compiles schedule triggers to the normal `runMode: "new_task"` cron path.
- API-triggered routines compile same-thread targets to webhook mappings with `action: "task_message"` and an explicit `targetTaskId`.
- Event-triggered routines compile same-thread targets to event triggers with `runMode: "thread_follow_up"`; invalid thread targets must fail instead of silently creating a new task.
- Default run mode is `Chat`, with `shellAccess: false`, `allowUserInput: false`, and no clarifying check-ins. Execute-mode tasks use hard-blocker-only human input by default; Plan/Debug can opt into structured `request_user_input`.
- `Local` sets `shellAccess: true`.
- `Worktree` must not be combined with `Continue thread`; the UI disables that path and lower-level worktree payloads force `New task`.
- Saved prompts should include a source task title, task ID, and `cowork://tasks/<taskId>` deeplink so future runs remain traceable.
- Template selection should fill name, prompt, and schedule only; templates are not managed agents.
- Routine observability belongs in the routines surface. Compiled scheduled-task observability belongs in `src/renderer/components/ScheduledTasksSettings.tsx`: use `listCronJobs`, `getCronRunHistory`, and `clearCronRunHistory` for run health, latest result, delivery status, target-thread/new-task labels, and per-run task links. Do not duplicate scheduler history in the task automation modal.
- Automation-specific agent config must be passed as transient run override for same-thread follow-ups; it must not overwrite the persisted task agent config.

Focused helpers exported from `MainContent.tsx` for tests:

- `TASK_AUTOMATION_TEMPLATES`
- `buildTaskAutomationSchedule`
- `buildTaskAutomationPrompt`
- `buildTaskRoutineCreate`
- `buildTaskAutomationCronJobCreate`

Validate changes with:

```bash
npx vitest run src/renderer/components/__tests__/main-content-working-state.test.ts
npx vitest run src/electron/agent/__tests__/executor-schedule-slash.test.ts src/electron/cron/__tests__/service.test.ts src/electron/routines/__tests__/service.test.ts src/electron/hooks/__tests__/server.test.ts src/electron/triggers/__tests__/EventTriggerService.test.ts
npm run build:react
```

See [Task Automations](task-automations.md) for the product concept and user-facing behavior.

## Terminal Tabs Development

Terminal tabs are real PTY-backed work surfaces, not a custom terminal emulator.

Implementation landmarks:

- `src/renderer/components/TerminalTabsDock.tsx`: xterm.js instances, tab controls, fit/resize, keyboard input forwarding, and output rendering
- `src/renderer/components/terminal-tabs-dock.css`: terminal dock layout and xterm style isolation
- `src/electron/terminal/TerminalPtyManager.ts`: `node-pty` lifecycle, replay buffers, cwd/status tracking, platform shell environment, resize, stop, and close
- `src/electron/ipc/handlers.ts`: terminal tab IPC handlers
- `src/electron/preload.ts`: renderer-safe terminal tab API
- `src/shared/types.ts`: terminal tab channel and event contracts

Design rules:

- Do not reimplement shell editing, Tab completion, Ctrl+C, cursor movement, prompt rendering, or command history in React. Those belong to the shell inside the PTY.
- Renderer input should be forwarded as raw xterm data to the PTY.
- Output replay should happen only on first attach for a renderer listener; replaying on every input duplicates prompts and output.
- Keep app typography out of xterm: reset letter spacing, word spacing, and transforms inside the terminal surface.
- Keep `node-pty` native files unpacked from Electron ASAR.
- On macOS, keep zsh prompt/cwd setup in generated startup files rather than writing setup commands into the visible terminal.
- On Windows, validate through a real Windows build because modern systems use ConPTY and older systems can fall back to winpty.

Focused validation:

```bash
npx oxlint src/electron/terminal/TerminalPtyManager.ts src/renderer/components/TerminalTabsDock.tsx
npm run build:electron
npm run build:react
npm run type-check
```

Product behavior, platform details, and release QA are documented in [Terminal Tabs](terminal-tabs.md).

## Reliability Workflow (Local)

```bash
# Build/refresh local regression corpus
npm run qa:eval:build -- --window-days 30 --limit 300 --suite reliability-regressions

# Deterministic suite replay
npm run qa:eval:run -- --suite reliability-regressions --mode deterministic

# Optional: run against a custom DB path
COWORK_DB_PATH=/tmp/cowork-eval.db npm run qa:eval:run -- --suite reliability-regressions --mode deterministic

# Validate production-fix regression policy (mainly used by PR CI)
npm run qa:eval:enforce-regressions

# Recompute timeline completion telemetry for an existing DB
npm run qa:timeline:backfill -- --db /absolute/path/to.db

# Enforce timeline reliability thresholds on completion telemetry
npm run qa:timeline:enforce -- --db /absolute/path/to.db
```

See also:
- [Reliability Flywheel](reliability-flywheel.md)

## Memory Observation QA

Run focused memory-observation checks when touching structured memory metadata, Memory Hub Inspector actions, prompt recall privacy, or memory backfill:

```bash
npx vitest run src/electron/memory/__tests__/MemoryObservationService.mock.test.ts src/electron/memory/__tests__/MemoryObservationService.test.ts
npm run type-check
```

The native SQLite test file can skip locally when `better-sqlite3` is unavailable. Keep the mock-level suite passing because it covers startup backfill behavior, failed metadata-write accounting, workspace-scoped soft-delete, and prompt-recall suppression without native SQLite.

## Durable Runtime Context QA

Run focused durable-context checks when touching active-task recall, compaction-summary persistence, Memory Hub durable-context settings, `context_grep`, `context_describe`, or memory clearing:

```bash
npx vitest run src/electron/agent/tools/__tests__/system-tools-new.test.ts src/electron/settings/__tests__/memory-features-manager.test.ts src/electron/agent/__tests__/executor-chat-mode.test.ts
npx vitest run src/electron/memory/__tests__/DurableContextService.test.ts
npm run type-check
```

The durable-service suite uses native SQLite and may skip locally when `better-sqlite3` is unavailable. The tool-level suite should still run because it covers disabled behavior, tool exposure, active-task scope enforcement, and the explicit-user-request override without needing native SQLite.

See [Durable Runtime Context](durable-runtime-context.md) for test prompts, expected behavior, and implementation landmarks.

## Skills QA Workflow

Run these checks when editing bundled skills:

```bash
npm run skills:validate-routing
npm run skills:validate-content
npm run skills:audit
npm run skills:check
```

Notes:
- `skills:check` is phase-driven (`SKILLS_CHECK_PHASE=1|2|3`).
- Phase 2+ enables path enforcement for `{baseDir}` references.
- Phase 3 enables strict warning enforcement.

### Testing `manim-video`

The bundled `manim-video` skill has non-Node runtime dependencies, so when editing it you should validate both the content contract and the local helper scripts:

```bash
python3 -m py_compile resources/skills/manim-video/scripts/bootstrap_project.py
bash resources/skills/manim-video/scripts/setup.sh
npm run skills:check
```

`setup.sh` verifies the local Manim toolchain (`python3`, Manim CE, `ffmpeg`, and LaTeX). If Manim is missing, the skill can still scaffold projects, but render execution should be considered unavailable until the dependency is installed.

### Testing `kami`

The bundled `kami` skill also has non-Node runtime dependencies, so validate both the content contract and the local helper scripts:

```bash
python3 -m py_compile \
  resources/skills/kami/scripts/bootstrap_project.py \
  resources/skills/kami/scripts/render_html.py
bash resources/skills/kami/scripts/setup.sh
node resources/skills/kami/scripts/render_slides.mjs --check
npm run skills:check
```

`setup.sh` reports the local Kami render toolchain (`python3`, `node`, `weasyprint`, `pypdf`, `pptxgenjs`, `playwright`, `pdffonts`, and local Chromium-family browser availability). If some render dependencies are missing, the skill can still scaffold and edit source projects, but PDF/PPTX export should be treated as conditional.

PPTX generation and previews use the bundled `@oai/artifact-tool` runtime first. Generation falls back to `pptxgenjs` if that runtime is missing. Preview loading is two-phase: fast mode extracts slide text/notes and cached images immediately, while full mode renders missing slide images through artifact-tool, then local `soffice` (LibreOffice) plus `pdftoppm`, then text-only preview if no renderer succeeds. See [Presentation Artifacts and PPTX Preview](./pptx-generation-and-preview.md).

### Testing `react-best-practices`

The bundled `react-best-practices` skill has no helper scripts or native dependencies. When editing the skill, validate the content contract and routing coverage:

```bash
npm run skills:check:core
npm run skills:eval-routing
npm run skills:check
```

The routing eval includes a React workspace feature prompt so the skill remains discoverable for React/Next.js implementation work without colliding with React Native guidance.

### Testing `unbroker`

The bundled `unbroker` skill has Python helper scripts and a local PII ledger. When editing it, keep test data in a temporary `PDD_DATA_DIR` and validate both the skill contract and the deterministic engine:

```bash
python3 -m py_compile resources/skills/unbroker/scripts/*.py
PDD_DATA_DIR=/tmp/cowork-unbroker-qa python3 resources/skills/unbroker/scripts/pdd.py doctor
PDD_DATA_DIR=/tmp/cowork-unbroker-qa python3 resources/skills/unbroker/scripts/pdd.py setup --auto
PDD_DATA_DIR=/tmp/cowork-unbroker-qa-smoke python3 resources/skills/unbroker/scripts/pdd.py intake \
  --full-name "Test Person" \
  --email test@example.com \
  --city Oakland \
  --state CA \
  --residency US-CA \
  --consent \
  --consent-method self
PDD_DATA_DIR=/tmp/cowork-unbroker-qa-smoke python3 resources/skills/unbroker/scripts/pdd.py next <subject_id>
npm run skills:check
```

The smoke subject should be fake test data only. The skill stores sensitive PII under `PDD_DATA_DIR`, `COWORK_HOME/unbroker`, `COWORK_USER_DATA_DIR/unbroker`, or the legacy upstream `HERMES_HOME/unbroker` fallback, so never point validation at a real operator ledger unless the test is explicitly about migration or recovery.

### Everything Workbench artifact model

The shared positioning and UX contract is documented in [Everything Workbench](./everything-workbench.md). Treat generated documents, spreadsheets, presentations, web pages, PDFs, and previews as one artifact workbench family:

- task outputs should render as compact artifact cards when a dedicated surface exists
- default **Open** should prefer the in-app sidebar for previewable/editable artifacts
- fullscreen mode should keep the functional follow-up composer and latest-turn/working context
- active follow-up work should keep the current preview visible and defer refresh until the relevant output is updated or the task completes
- external app and folder actions should remain available for advanced native workflows

### Spreadsheet artifact workflow

Spreadsheet artifact behavior is documented in [Spreadsheet Artifacts](./spreadsheet-artifacts.md).

Implementation notes:

- `readFileForViewer` builds structured workbook and CSV/TSV preview data through `src/electron/utils/spreadsheet-preview.ts`.
- `FileViewerResult.data.spreadsheetPreview` is optional; keep the tab-separated `content` fallback intact for older callers.
- `SpreadsheetArtifactCard` owns the task-feed card and open dropdown. Default `Open` should route to the in-app sidebar viewer; dropdown options can open external apps or the folder.
- `SpreadsheetArtifactViewer` owns grid selection, range/row/column copy, inline editing, add row/column, zoom, save, sidebar/fullscreen rendering, and the fullscreen follow-up composer.
- `App.tsx` owns sidebar/fullscreen state, persisted sidebar width, and the follow-up turn filter used by the fullscreen task context frame.
- Fullscreen follow-up context should filter to events emitted after the fullscreen prompt is sent. Do not clear that filter timestamp when the follow-up completes; only clear the optimistic working state.

Focused checks:

```bash
npx vitest run \
  src/electron/utils/__tests__/spreadsheet-preview.test.ts \
  src/renderer/components/__tests__/spreadsheet-artifact-card.test.ts \
  src/renderer/components/__tests__/spreadsheet-artifact-viewer.test.ts

npm run build:react
npm run type-check
```

### Document artifact workflow

Document artifact behavior is documented in [Document Artifacts](./document-artifacts.md).

Implementation notes:

- `readFileForViewer` builds structured document preview data through `src/electron/utils/document-preview.ts`.
- `FileViewerResult.data.documentPreview` is optional; keep existing `content` and `htmlContent` fallbacks intact for older callers.
- `DocumentArtifactCard` owns the task-feed card and open dropdown. Default `Open` should route previewable local documents to the in-app sidebar viewer; dropdown options can open external apps or the folder.
- `DocumentArtifactViewer` owns sidebar/fullscreen rendering, DOCX direct editing, toolbar commands, copy, save, external actions, and the fullscreen follow-up composer.
- DOCX save writes editable block data back through `src/electron/utils/document-writer.ts` and `FILE_UPDATE_DOCUMENT`.
- Non-DOCX Word-style formats are recognized as document artifacts, but v1 should keep them preview/external-open only unless a reliable local editor is added.
- `App.tsx` owns shared artifact sidebar/fullscreen state, persisted sidebar width, preview refresh keys, and the follow-up turn filter used by the fullscreen task context frame.
- Fullscreen follow-up context should filter to events emitted after the fullscreen prompt is sent. Do not clear that filter timestamp when the follow-up completes; only clear the optimistic working state and refresh the active document preview from disk.

Focused checks:

```bash
npx vitest run \
  src/electron/utils/__tests__/document-preview.test.ts \
  src/electron/utils/__tests__/document-writer.test.ts \
  src/renderer/components/__tests__/document-artifact-card.test.ts \
  src/renderer/components/__tests__/document-artifact-viewer.test.ts

npm run build:react
npm run build:electron
npm run type-check
```

### Presentation artifact workflow

Presentation artifact behavior is documented in [Presentation Artifacts and PPTX Preview](./pptx-generation-and-preview.md).

Implementation notes:

- `src/shared/presentation-formats.ts` owns PowerPoint-style artifact detection and labels.
- `readFileForViewer` accepts `presentationRenderMode: "fast" | "full"` for `.pptx` files.
- Fast mode extracts slide text and speaker notes and reuses cached slide images without running expensive renderers.
- Full mode uses the shared singleton `PptxPreviewService`, renders missing slide images in the background, dedupes in-flight renders, and returns `imageUrl` media links for cached PNGs.
- `PresentationArtifactCard` owns the compact task-feed card and open dropdown. Default `Open` routes previewable `.pptx` files to the in-app sidebar viewer; legacy PowerPoint formats use external-app/folder actions.
- `PresentationArtifactViewer` owns sidebar/fullscreen rendering, copy/external/folder actions, the fullscreen follow-up composer, and the cached viewer data shared between sidebar and fullscreen.
- `PresentationViewer` owns thumbnails, slide navigation, zoom, the white top-aligned slide canvas, text fallback, and speaker notes.
- `App.tsx` owns shared artifact sidebar/fullscreen state, persisted sidebar width, refresh keys, and the follow-up turn filter. During an active follow-up, artifact previews should keep the current deck visible and defer reloads until the follow-up completes.

Focused checks:

```bash
npx vitest run \
  src/electron/utils/__tests__/PptxPreviewService.test.ts \
  src/renderer/components/__tests__/presentation-artifact-card.test.ts \
  src/renderer/components/__tests__/presentation-artifact-viewer.test.ts

npm run build:react
npm run build:electron
npm run type-check
```

### Web page artifact workflow

Web page artifact behavior is documented in [Web Page Artifacts](./web-page-artifacts.md).

Implementation notes:

- `src/shared/web-page-formats.ts` owns HTML/HTM artifact detection and labels.
- `readFileForViewer` returns `FileViewerResult.data.webPreview` for generated HTML, built React output, and React-style project paths.
- `src/electron/utils/web-preview.ts` resolves HTML files directly, detects React/Vite/Next project roots from `package.json`, and looks for built `dist/index.html`, `build/index.html`, or `out/index.html`.
- `src/electron/utils/html-preview-assets.ts` inlines local assets for sandboxed iframe preview where possible.
- `WebArtifactCard` owns the compact task-feed card and open dropdown. Default `Open` routes previewable web pages to the in-app sidebar viewer.
- `WebArtifactViewer` owns sidebar/fullscreen rendering, the sandboxed iframe, browser/folder/copy actions, unavailable-state rendering, and the fullscreen follow-up composer.
- `App.tsx` owns shared artifact sidebar/fullscreen state, persisted sidebar width, refresh keys, and the follow-up turn filter. During an active follow-up, web previews should keep the current page visible and defer reloads until the follow-up completes or a matching file output is emitted.
- V1 must not auto-start React, Vite, or Next dev servers from the artifact viewer. Missing build output should remain a structured preview-unavailable state.

Focused checks:

```bash
npx vitest run \
  src/electron/utils/__tests__/web-preview.test.ts \
  src/renderer/components/__tests__/web-artifact-card.test.ts \
  src/renderer/components/__tests__/web-artifact-viewer.test.ts

npm run build:react
npm run build:electron
npm run type-check
```

### LaTeX PDF workflow

The native `compile_latex` tool is separate from `generate_document`. It compiles an existing workspace `.tex` file into a PDF by discovering a system engine in this order: `tectonic`, `latexmk`, `xelatex`, `lualatex`, `pdflatex`.

Implementation and QA notes:

- Do not shell-interpolate compiler commands; use bounded `execFile` calls.
- Keep all source/output paths inside the active workspace.
- Preserve the `.tex` source even when no compiler is installed or compilation fails.
- Register successful PDFs as artifacts with `mimeType: "application/pdf"` and `sourcePath` metadata pointing back to the `.tex` file.
- Renderer pairing is driven by `artifact_created.sourcePath` first, with same-folder/same-basename fallback for older events.

## Focused Test Suites

For completion/output UX changes, run the focused suites:

```bash
npx vitest run \
  src/electron/utils/__tests__/latex-compiler.test.ts \
  src/electron/agent/tools/__tests__/document-tools.test.ts \
  src/renderer/utils/__tests__/latex-artifacts.test.ts \
  src/renderer/utils/__tests__/task-outputs.test.ts \
  src/renderer/utils/__tests__/task-completion-ux.test.ts \
  src/renderer/utils/__tests__/task-event-visibility.test.ts \
  src/electron/agent/__tests__/daemon-complete-task.test.ts \
  src/electron/control-plane/__tests__/task-event-bridge-contract.test.ts \
  src/renderer/__tests__/task-event-status-map.test.ts
```

When unit-testing `TaskExecutor` completion paths, mock `daemon.getTaskEvents()` in harnesses.
`finalizeTask()` always reads task events to build output summaries.

For structured input, executor recovery, and timeline-lane changes, run:

```bash
npx vitest run \
  src/daemon/__tests__/control-plane-methods.test.ts \
  src/electron/agent/__tests__/daemon-input-request.test.ts \
  src/electron/agent/tools/__tests__/request-user-input.test.ts \
  src/electron/agent/__tests__/path-alias.test.ts \
  src/electron/agent/__tests__/executor-context-overflow-recovery.test.ts \
  src/electron/agent/__tests__/executor-parallel-batch.test.ts \
  src/electron/agent/__tests__/executor-workspace-preflight-ack.test.ts \
  src/renderer/components/timeline/__tests__/parallel-group-projection.test.ts \
  src/renderer/components/timeline/__tests__/parallel-group-feed.test.ts \
  src/renderer/utils/__tests__/task-event-compat.test.ts
```

For sidebar virtualization and `@chenglou/pretext` measurement work in the `CoWork-OS/CoWork-OS` repo, run:

```bash
npx vitest run \
  src/renderer/__tests__/sidebar-helpers.test.ts \
  src/renderer/hooks/__tests__/useVirtualList.test.ts \
  src/renderer/utils/__tests__/pretext-adapter.test.ts \
  src/renderer/components/timeline/__tests__/semantic-timeline-projection.test.ts
```

## Project Structure

| Directory | Description |
|-----------|-------------|
| `src/electron/` | Main process (Node.js/Electron) |
| `src/renderer/` | React UI components |
| `src/shared/` | Shared types between main and renderer |
| `resources/skills/` | Built-in skill definitions |
| `connectors/` | Enterprise MCP connector implementations |

## Composer Mentions

The main composer supports a grouped `@` autocomplete for **Agents**, **Integrations**, and **Files**. The user-facing behavior is documented in [Composer Mentions](composer-mentions.md); this section captures the developer contract.

Implementation boundaries:

- `src/shared/types.ts` owns `IntegrationMentionOption` and `IntegrationMentionSelection`.
- `src/electron/integrations/integration-mention-options.ts` builds integration mention options from local configured state only. It must stay fast and must not run network checks while the user types.
- `src/electron/ipc/handlers.ts` and `src/electron/preload.ts` expose `listIntegrationMentionOptions()`.
- `src/renderer/components/PromptComposerInput.tsx` owns rich inline mention editing. It keeps clean text serialization such as `@Gmail`, renders icon+label chips, and treats each chip as one removable unit for Backspace/Delete.
- `src/renderer/components/MainContent.tsx` owns grouped menu filtering, section order, task/follow-up submission metadata, user message rendering, and `@Inbox` main-composer routing.
- `src/renderer/components/IntegrationMentionText.tsx` renders integration chips in sent user messages and restored session history.
- `src/electron/agent/executor.ts` turns `agentConfig.integrationMentions` into a soft routing guidance block. Do not convert mentions into `allowedTools`.

Focused checks:

```bash
npx vitest run \
  src/electron/integrations/__tests__/integration-mention-options.test.ts \
  src/renderer/components/__tests__/prompt-composer-input.test.ts \
  src/renderer/components/__tests__/integration-mention-text.test.ts
npm run lint
npm run type-check
```

## Ask Inbox

Ask Inbox is the mailbox-specific agentic question surface inside Inbox Agent. The product and architecture contract is documented in [Ask Inbox Architecture](ask-inbox-architecture.md); this section captures the developer boundaries.

Implementation boundaries:

- `src/renderer/components/InboxAgentPanel.tsx` owns the right-sidebar `Agent Rail` / `Ask Inbox` tabs, the left ask launcher behavior, the Ask Inbox transcript, live step timeline, matched email rows, and pinned Ask composer.
- `src/electron/mailbox/MailboxService.ts` owns `askMailbox()`, action-intent classification, progress emission, provider search adapters, answer generation, and safe draft creation paths.
- `src/electron/mailbox/MailboxAgentSearchService.ts` owns query planning, local FTS retrieval, semantic mailbox retrieval, provider-result normalization, attachment-aware search, shortlist/read/rerank behavior, and no-evidence answers.
- `src/shared/mailbox.ts` owns `MailboxAskInput`, `MailboxAskResult`, and `MailboxAskRunEvent`.
- `src/shared/types.ts`, `src/electron/ipc/handlers.ts`, and `src/electron/preload.ts` own the transient `mailbox:askEvent` channel and `onMailboxAskEvent()` subscription.

Rules:

- Do not stream Ask progress through persisted `MailboxEvent`. Ask progress is transient UI telemetry and must not trigger mailbox automations, Heartbeat, Knowledge Graph, or playbooks.
- Keep provider-native search additive. If Gmail or Outlook/Microsoft Graph search fails, Ask Inbox must fall back to local evidence.
- Keep destructive actions out of Ask Inbox. It may answer questions and create reviewable drafts, but it must not silently send, archive, trash, mark done, or bulk mutate mail.
- Preserve source metadata on results (`local_fts`, `local_vector`, `provider_search`, `attachment_text`) so UI evidence labels remain truthful.

Focused checks:

```bash
npx vitest run src/electron/mailbox/__tests__/MailboxAgentSearchService.test.ts
npx tsc -p tsconfig.electron.json
npm run type-check
```

## Message Box Shortcuts

The main composer supports a grouped `/` autocomplete for deterministic app commands and skill-backed workflow shortcuts. The user-facing behavior is documented in [Message Box Shortcuts](message-box-shortcuts.md); this section captures the developer contract.

Implementation boundaries:

- `src/shared/message-shortcuts.ts` owns the deterministic app command catalog and parser for `/schedule`, `/clear`, `/plan`, `/cost`, `/compact`, `/doctor`, and `/undo`.
- `src/shared/multitask-command.ts` owns `/multitask [N] <task>` parsing because it is a task-creation command that strips its prefix before persistence and adds collaborative multitask task metadata.
- `src/renderer/utils/message-slash-options.ts` owns picker option ordering, filtering, app-vs-skill display, optional/required parameter classification, invalid-token filtering, and keyboard selected-index clamping.
- `src/renderer/components/MainContent.tsx` owns composer detection, selection behavior, slash-token insertion, app command task creation, legal workflow intake cards, and `/schedule` target selection for standalone tasks versus same-thread follow-ups.
- `src/renderer/utils/legal-demand-intake.ts` owns Claude-for-Legal slash detection, demand-intake prefill/serialization, generic legal workflow context serialization, and the allow/deny filter for legal commands that should show matter-context UI.
- `src/electron/agents/MultitaskLanePlanner.ts` plans `/multitask` lanes from explicit list items, LLM JSON output, or deterministic fallback lanes.
- `src/renderer/App.tsx` owns the safe `/clear` task-view reset. `/clear` must not delete task history or switch workspaces.
- `src/electron/agent/skill-slash-aliases.ts` resolves plugin-pack `slashCommands` aliases to target skill IDs. Backend precedence must match picker display; enabled plugin aliases win over direct skill IDs when tokens collide.
- `src/electron/agent/executor.ts` owns generic skill slash execution. The deterministic `/schedule` handler must continue to run before generic skill slash routing.
- `resources/plugin-packs/cowork-shortcuts/cowork.plugin.json` seeds the bundled CoWork Shortcuts workflow pack as normal skills and aliases.

Focused checks:

```bash
npx vitest run \
  src/shared/__tests__/message-shortcuts.test.ts \
  src/shared/__tests__/skill-slash-commands.test.ts \
  src/electron/agent/__tests__/skill-slash-aliases.test.ts \
  src/electron/agent/__tests__/executor-schedule-slash.test.ts \
  src/shared/__tests__/multitask-command.test.ts \
  src/electron/agents/__tests__/MultitaskLanePlanner.test.ts \
  src/electron/agents/__tests__/AgentTeamOrchestrator.test.ts \
  src/renderer/utils/__tests__/legal-demand-intake.test.ts \
  src/renderer/utils/__tests__/message-slash-options.test.ts \
  src/renderer/components/__tests__/main-content-working-state.test.ts
npm run type-check
npm run build:react
```

## Building Custom Connectors

Use the connector template:

```bash
cp -r connectors/templates/mcp-connector connectors/my-connector
cd connectors/my-connector
npm install
# Edit src/index.ts to implement your tools
npm run build
```

See [Enterprise Connectors](enterprise-connectors.md) for the full connector contract.

## System Requirements

| Requirement | Minimum | Recommended |
|-------------|---------|-------------|
| **Desktop OS** | macOS 12 / Windows 10 | macOS 13+ / Windows 11 |
| **RAM** | 4 GB | 8 GB+ |
| **CPU** | 2 cores | 4+ cores |
| **Architecture** | x64 or arm64 | Native architecture of your host |

### Supported Desktop OS Versions

- macOS 12 Monterey, 13 Ventura, 14 Sonoma, 15 Sequoia
- Windows 10 and Windows 11 (x64 and ARM64)

### Resource Usage

- **Base memory**: ~300-500 MB (Electron + React UI)
- **Per bot integration**: ~50-100 MB additional
- **Playwright automation**: ~200-500 MB when active
- **CPU**: Mostly idle; spikes during AI API calls

### Running in a VM

| Host Platform | VM Options |
|----------|------------|
| **Apple Silicon Mac** | UTM, Parallels Desktop, VMware Fusion |
| **Intel Mac** | Parallels Desktop, VMware Fusion, VirtualBox |
| **Windows** | Hyper-V, VMware Workstation, VirtualBox |

Recommended VM specs: 4+ GB RAM, 2+ CPU cores, 40+ GB disk space.

## Troubleshooting

See [Troubleshooting](troubleshooting.md) for common build and setup issues.

## Executor Budget Contracts

Hard executor budget contracts are now opt-in.

- Env var: `COWORK_AGENT_BUDGET_CONTRACTS`
- Default: `false`
- Effect when disabled: strict budget-contract caps (including tool-call caps) are not enforced by default.
- To restore legacy behavior: set `COWORK_AGENT_BUDGET_CONTRACTS=true`

Validation after this change:

- `executor-step-failures` tests pass.
- `npm run type-check` passes.
- `npm run build:electron` passes.
