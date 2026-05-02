# Development Guide

## Prerequisites

- Node.js 24+ and npm
- macOS 12 (Monterey)+ or Windows 10/11
- `sqlite3` CLI (required for eval corpus/replay scripts)
- macOS: Xcode Command Line Tools (needed for `better-sqlite3`): `xcode-select --install`
- Windows: Visual Studio Build Tools 2022 (C++) and Python 3 (needed for native module builds)
- LLM provider credentials are optional — the app defaults to OpenRouter's free model router

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

## Development Mode

Run the app with hot reload:

```bash
npm run dev
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
| `npm run qa:timeline:backfill` | Recompute timeline completion telemetry for `task_completed` timeline events |
| `npm run qa:timeline:enforce` | Enforce timeline reliability thresholds from completion telemetry |
| `npm run qa:reliability` | Reliability loop (`qa:eval:run` + battery script) |
| `npm run skills:validate-routing` | Validate skill routing metadata |
| `npm run skills:validate-content` | Validate skill prompt content, placeholders, and references |
| `npm run skills:audit` | Generate skill audit scorecards in `tmp/qa/` |
| `npm run skills:check` | Run full skill quality gate (routing + content + audit + eval) |

## Renderer Bundle Size

The renderer startup bundle is intentionally kept separate from secondary product surfaces and heavyweight renderers.

Current bundle-splitting rules:

- Keep the primary task workspace (`App`, `Sidebar`, `MainContent`, `RightPanel`) available on initial load.
- Lazy-load secondary views from `App.tsx`: Settings, Browser, Home, Devices, Health, Ideas, Inbox Agent, Agents Hub, and Mission Control.
- Keep the in-app browser workbench renderer-owned. `BrowserWorkbenchView` registers its Electron webview `webContentsId` with the main process, and browser tools route actions to that visible session through `BrowserWorkbenchService`. Browser Workbench IPC also carries open requests, status updates, screenshot capture, annotation handoff, and cursor events for visible agent movement. Do not replace generated web artifact iframes with this live browser path; artifact previews and live website testing are separate surfaces. See [Browser Workbench](browser-workbench.md).
- Do not import heavyweight optional renderers at module top level when they are needed only for specific content. Mermaid is loaded from `MainContent.tsx` only when a Mermaid code block is rendered.
- Do not import the `highlight.js` package root in renderer code. Use `highlight.js/lib/core` and register only the language grammars the UI should support eagerly.
- Prefer feature-level dynamic imports before adding Rollup `manualChunks`; manual chunks improve cache boundaries, but they do not remove code from startup if imports remain static.

The initial optimization reduced the renderer entry chunk from about `4,842 kB` minified (`1,267 kB` gzip) to about `1,259 kB` minified (`364 kB` gzip) in `npm run build:react`. Large feature code now appears as separate chunks such as `Settings`, `mermaid.core`, PDF, KaTeX, and chart/diagram chunks.

When changing renderer imports, validate with:

```bash
npm run build:react
npm run type-check
```

If the entry chunk grows unexpectedly, rebuild with sourcemaps and inspect the generated `dist/renderer/assets/index-*.js.map` to identify newly eager modules.

## Task Automation UI

Task view supports `... > Add automation...`, a renderer-side shortcut that creates a real cron scheduled task from the current task.

Implementation contract:

- The task title/three-dot menu lives in `src/renderer/components/MainContent.tsx`.
- The modal is `TaskAutomationModal` in the same file so task-derived defaults stay local to task view.
- Saving must call `window.electronAPI.addCronJob`; do not create a parallel automation store for this flow.
- Default run mode is `Chat`, with `shellAccess: false` and `allowUserInput: false`.
- `Local` sets `shellAccess: true`.
- `Worktree` should remain disabled until the cron creation payload can preserve a task worktree execution context.
- Saved prompts should include a source task title, task ID, and `cowork://tasks/<taskId>` deeplink so future runs remain traceable.
- Template selection should fill name, prompt, and schedule only; templates are not routines or managed agents.

Focused helpers exported from `MainContent.tsx` for tests:

- `TASK_AUTOMATION_TEMPLATES`
- `buildTaskAutomationSchedule`
- `buildTaskAutomationPrompt`
- `buildTaskAutomationCronJobCreate`

Validate changes with:

```bash
npx vitest run src/renderer/components/__tests__/main-content-working-state.test.ts
npm run build:react
```

See [Task Automations](task-automations.md) for the product concept and user-facing behavior.

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
- `src/renderer/utils/message-slash-options.ts` owns picker option ordering, filtering, app-vs-skill display, optional/required parameter classification, invalid-token filtering, and keyboard selected-index clamping.
- `src/renderer/components/MainContent.tsx` owns composer detection, selection behavior, skill parameter modal launch, optional-parameter insertion, app command task creation, and `/schedule` fresh-task precedence.
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
