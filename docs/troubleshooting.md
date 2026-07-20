# Troubleshooting

## macOS app won't launch with "Apple could not verify"

CoWork OS macOS DMGs are currently unsigned. On first launch, macOS may show **"Apple could not verify CoWork OS is free of malware"** or **`"CoWork OS" was blocked to protect your Mac`**.

Use the macOS Gatekeeper override:

1. Drag **CoWork OS** from the DMG into **Applications**.
2. Open **CoWork OS** once. If macOS blocks it, click **Done**.
3. Open **System Settings > Privacy & Security**.
4. Scroll to **Security**.
5. Next to **`"CoWork OS" was blocked to protect your Mac`**, click **Open Anyway**.
6. In the confirmation dialog, click **Open Anyway** again.

Release maintainers can create unsigned macOS DMG/ZIP artifacts with:

```bash
npm run package:mac:unsigned
```

Terminal fallback:

```bash
xattr -dr com.apple.quarantine "/Applications/CoWork OS.app"
```

If the app closes immediately with a `dyld` signature error:

```bash
codesign --force --deep --sign - "/Applications/CoWork OS.app"
```

> `spctl --add` / `spctl --enable` are deprecated on newer macOS and may show "This operation is no longer supported".

## npm install fails with SIGKILL

If install fails with `SIGKILL` during `node_modules/electron/install.js`, use a two-step install:

```bash
npm install --ignore-scripts cowork-os@latest --no-audit --no-fund
npm run setup
```

For local package testing, use the same `--ignore-scripts` flow with the tarball:

```bash
npm init -y
npm install --ignore-scripts /path/to/cowork-os-<version>.tgz
```

## CoWork CLI issues

The `cowork` command has a local mode and an explicit remote mode. Normal local use should not require a Control Plane token.

### `cowork run` says `Missing token`

This error belongs to the remote Control Plane path. Check whether the command includes `--remote` or a remote alias. For local one-shot execution, run without `--remote`:

```bash
cowork run "who are you?"
```

For remote execution, configure the Control Plane connection:

```bash
export COWORK_CONTROL_PLANE_URL=http://127.0.0.1:3333
export COWORK_CONTROL_PLANE_TOKEN=<token>
cowork run "check remote status" --remote
```

### CLI build artifacts are missing

In a source checkout, compile the CLI:

```bash
npm run build:cli
```

If the hidden app-entry runner is missing after a clean checkout or package test, also build Electron:

```bash
npm run build:electron
npm run build:cli
```

### CLI cannot see providers configured in the desktop app

Local one-shot CLI runs prefer a hidden Electron app-entry mode so OS-encrypted settings can be read with the same desktop app identity. If providers are missing:

1. Confirm the CLI and desktop app are from the same install/profile.
2. Open the desktop app and verify **Settings > AI & Models** has a working provider route.
3. Run the CLI with diagnostics:

   ```bash
   COWORK_CLI_DEBUG=1 cowork run "diagnose provider setup"
   ```

4. If running from source, rebuild both Electron and CLI artifacts.

See [CoWork OS CLI](cli.md) for the full local-vs-remote model.

## OpenAI or MoA fails on a corporate Mac with Zscaler

Corporate TLS inspection tools such as Zscaler can install a company root certificate that macOS trusts, while Electron/Node provider calls still fail with errors such as `fetch failed`. This can show up most clearly when OpenAI is used inside a Mixture of Agents preset, because MoA performs multiple provider calls in one task.

For source development on macOS, `npm run dev` enables Node's system certificate store by default:

```bash
NODE_OPTIONS=--use-system-ca
```

To confirm whether this behavior matters, compare with:

```bash
COWORK_DEV_USE_SYSTEM_CA=0 npm run dev
```

If requests still fail, export your Zscaler or company root CA certificate as a PEM file and run:

```bash
NODE_EXTRA_CA_CERTS=/path/to/zscaler-root.pem npm run dev
```

Then test the OpenAI provider directly before testing a [Mixture of Agents](mixture-of-agents.md) preset. In developer logs, a healthy MoA task should show advisor calls with `toolsOffered: 0` and the aggregator call with the original tool count.

## macOS "Killed: 9" during setup

If you see `Killed: 9` during `npm run setup`, macOS terminated a native build due to memory pressure.

`npm run setup` already retries native setup automatically with backoff. Let it continue until it exits. If it still exits non-zero, close heavy apps and run the same command again:

```bash
npm run setup
```

## Computer use issues

If **screenshots fail or time out** on macOS, grant **Screen Recording** for the helper path shown in **Settings → Tools → Computer use**, then **quit and restart** the app. If **clicks or typing do nothing**, enable **Accessibility** for that helper path the same way.

On Windows, keep the target window visible and non-minimized. If the target app is running as administrator, run CoWork with comparable privileges; protected apps may block capture or input.

If the agent **never uses** the computer-use tools, confirm **Settings → Tools → Built-in tools** includes the **computer use** category, and phrase tasks as **native app / window / dialog** work (not pure browser or CLI tasks).

See the full guide: [Computer use](computer-use.md).

## Inbox Agent issues

Inbox Agent uses a local cache plus provider-backed actions. When debugging mailbox behavior, first capture a current development log:

```bash
npm run dev:log
```

Then inspect:

```bash
logs/dev-latest.log
```

For tooling or repeated-failure analysis, inspect `logs/dev-latest.jsonl`. It contains the same
captured run as structured, redacted events with process, stream, level, component, and message fields.

### New mail does not appear immediately

Inbox Agent autosyncs in the background, but it is not a push-only mail client yet. It loads cached mail immediately, then periodically refreshes a bounded recent batch. If a new message is missing:

1. Wait for the next autosync interval.
2. Use the refresh button in Inbox Agent to force a sync.
3. Check `logs/dev-latest.log` for `Mailbox autosync starting` and `Mailbox autosync complete`.
4. Confirm the account still shows connected sync health.

### Unread count or unread styling looks wrong

Unread is provider-backed. Opening a thread may mark it read when provider permissions allow it. For Gmail, read/unread mutation requires the Gmail modify scope. If the app cannot mutate provider state, reconnect Google Workspace with the requested Gmail scopes or use the provider mailbox directly.

### Mark read / unread / archive / trash says "Not connected"

The visible action is enabled only when the app has enough local context, but the provider mutation can still fail if the account token or channel connection expired. Reconnect the mailbox integration, then retry. Gmail server actions require Google Workspace to be enabled; IMAP/SMTP accounts have more limited server action support.

### Ask Inbox does not find an email I can see

Ask Inbox searches local synced evidence first, then adds semantic mailbox matches, provider-native search where available, and attachment text when relevant. If a visible email is missing from Ask results:

1. Confirm the thread exists in the Inbox Agent `All` view, not only in the external mail client.
2. Use the Inbox Agent refresh button to sync the latest recent batch.
3. If the answer is inside an attachment, open the thread and extract the attachment text, then retry the question.
4. Check the Ask Inbox step feed to see which sources ran: local FTS, semantic index, provider search, attachment text, shortlist/read evidence, and answer generation.
5. Inspect `logs/dev-latest.log` for mailbox ask/search errors if a step stops or reports an error.

Provider-native search is additive. If Gmail or Outlook/Microsoft Graph search fails, Ask Inbox should still fall back to local mailbox evidence and report related results when it has them.

See [Ask Inbox Architecture](ask-inbox-architecture.md).

### `@Gmail`, `@Google Tasks`, `@Google Slides`, or `@Inbox` says Google Workspace authorization failed

The composer `@` menu uses local configured state, so a stale Google token can still appear until the next provider call proves it is invalid. If a Google Workspace request reports a token refresh bad request, CoWork clears the stale access/refresh tokens and requires a reconnect. If the token is valid but was granted before newer services existed, CoWork reports missing scopes and also requires reconnect.

Fix:

1. Open **Settings > Integrations > Google Workspace**.
2. Confirm the client id and client secret match the OAuth client you want to use.
3. Leave the default Google Workspace scopes enabled, or make sure any custom scope list includes Drive, Gmail read/send/modify, Calendar, Spreadsheets, Documents, Tasks, Presentations, Chat messages, and Chat spaces readonly.
4. Click **Connect** again and finish the Google OAuth flow.
5. Retry the `@Gmail`, `@Google Tasks`, `@Google Slides`, or `@inbox` prompt.

If you recently changed the Google OAuth client id, client secret, or scopes, reconnect even if the integration previously worked. Changed OAuth configuration invalidates the old token set.

### Integration reconnect notifications

When a background integration request fails because authorization is stale, revoked, missing scopes, or blocked by a sign-in challenge, CoWork now creates a warning notification instead of silently retrying forever. The notification points you back to Settings so you can reconnect or update the provider credentials.

This applies to the shared Google Workspace path used by Gmail, Calendar, and Drive; X (Twitter) login/challenge failures; and MCP connector tool calls or connection status errors that look like auth failures. To avoid notification spam, repeated auth failures for the same integration are de-duped for a short window.

Fix:

1. Open the settings path named in the notification, usually **Settings > Integrations** or the provider-specific settings page.
2. Reconnect the provider or update the missing API key/OAuth credentials.
3. If the provider asks for new scopes, approve the updated scope set.
4. Retry the task or automation after the integration shows connected.

For maintainers, auth-like MCP disconnects are left in an error state instead of entering the normal reconnect loop. This keeps token expiration and sign-in challenges visible to the user rather than hiding them behind repeated background retries.

### The `@` menu does not show an integration

The composer only shows configured integrations that are locally usable. It does not run live health checks while typing.

Check that the integration is enabled and has local credentials. For Google Workspace, the menu should show service-specific entries instead of a single Google Workspace item: Gmail, Google Drive, Google Calendar, Google Docs, Google Sheets, Google Slides, Google Tasks, and Google Chat when native or MCP-backed tools are available. Google Calendar is still one mention chip when both native `calendar_action` and MCP `google-workspace.calendar_*` tools are connected. For gateway channels such as Slack, the channel must be connected and enabled. For MCP connectors, the connector must be connected/configured.

See [Composer Mentions](composer-mentions.md).

### Microphone next to Search threads fails after permission is allowed

The desktop app does not rely on Chromium's Web Speech service because it can request microphone permission but still fail when the speech-recognition backend is unavailable. Configure OpenAI or Azure speech-to-text in **Settings > Voice**. After that, Inbox Agent voice search and `Speak reply` use provider transcription.

### AI draft does not disappear after send

Generated drafts are removed after a successful provider send. If the draft remains, check the visible error banner and the log for the provider send failure. The edited draft subject/body are saved before send, so a failed send should preserve your edits for retry.

### Startup fails with a missing mailbox column

Mailbox schema migrations should add classification, Today/domain, attachment, and replacement-client columns automatically. If startup reports a missing column such as `today_bucket`, do not delete the app database. Capture `logs/dev-latest.log` and verify the schema migration path before trying destructive recovery.

## PPTX previews only show text or speaker notes

CoWork can always extract slide text and presenter notes from `.pptx` files. The presentation viewer loads that fast text preview first, then renders slide images in the background. Rendered slide thumbnails are best-effort and use this order:

1. Codex bundled `@oai/artifact-tool` presentation renderer.
2. `soffice` from LibreOffice to convert the deck to PDF.
3. `pdftoppm` to render PDF pages to PNG thumbnails.
4. Text/notes preview if image rendering fails.

If artifact-tool is unavailable and either local binary is missing or fails on a deck, the presentation viewer stays in text/notes mode. Install LibreOffice and Poppler, restart CoWork, then reopen the artifact to regenerate the cached preview. The `.pptx` file itself is still available through **Open file** or **Show in Finder**.

## Everything Workbench artifacts do not appear as cards

Generated documents, spreadsheets, presentations, web pages, PDFs, and previews should appear as first-class artifact cards when CoWork recognizes the output type. The shared flow is: output card, main **Open** action, sidebar workbench, fullscreen artifact workspace, follow-up composer, and refresh after completed edits.

If an output only appears as a plain file link:

1. Confirm the file extension is one of the recognized artifact formats documented in [Everything Workbench](everything-workbench.md).
2. Confirm the task emitted the file through `file_created`, `file_modified`, `artifact_created`, or primary completion output metadata.
3. Reopen the task and use the artifact card's main **Open** action rather than an external-app dropdown action.
4. Capture a fresh dev log if the card still does not appear.

## Spreadsheet artifacts do not open in the sidebar

Local spreadsheet outputs should render as spreadsheet artifact cards. The main **Open** action opens `.xlsx`, `.xls`, `.xlsm`, `.csv`, and `.tsv` files in the in-app sidebar viewer. Native/app-owned spreadsheet formats such as `.numbers`, `.gsheet`, `.ods`, and `.xlsb` are recognized as spreadsheet artifacts, but open externally or through the folder action.

If a generated spreadsheet only appears as a plain file link or opens in the generic viewer:

1. Confirm the output file extension is a recognized spreadsheet format such as `.xlsx`, `.xls`, `.xlsm`, `.csv`, `.tsv`, `.numbers`, `.gsheet`, `.ods`, or `.xlsb`.
2. Confirm the file was emitted through `file_created`, `artifact_created`, or as the primary completion output.
3. Reopen the task and click the main **Open** button, not an external-app dropdown item.
4. If the viewer loads but grid data is missing, capture a dev log and check for spreadsheet parsing errors from `readFileForViewer`.

For a fresh repro log:

```bash
npm run dev:log
```

Then inspect:

```bash
logs/dev-latest.log
```

See [Spreadsheet Artifacts](spreadsheet-artifacts.md) for the expected sidebar/fullscreen behavior and the focused tests for this surface.

## Document artifacts do not open or refresh correctly

Local Word-style outputs should render as document artifact cards. The main **Open** action opens `.docx` files in the in-app sidebar editor. `.doc`, `.rtf`, `.odt`, `.ott`, `.pages`, and related formats are recognized as document artifacts, but may use best-effort preview or external app actions depending on parser support.

If a generated document only appears as a plain file link, stays collapsed behind `Output ready`, or opens in the generic viewer:

1. Confirm the output file extension is a recognized document format such as `.docx`, `.docm`, `.dotx`, `.dotm`, `.doc`, `.rtf`, `.odt`, `.ott`, or `.pages`.
2. Confirm the file was emitted through `file_created`, `file_modified`, `artifact_created`, or as the primary completion output.
3. Reopen the task and click the main **Open** button, not an external-app dropdown item.
4. For DOCX editing, make sure the file is a real `.docx` document and not a renamed plain-text file.
5. If a fullscreen follow-up completes but the document content does not update, capture a dev log and check for document preview or `FILE_UPDATE_DOCUMENT` errors.

For a fresh repro log:

```bash
npm run dev:log
```

Then inspect:

```bash
logs/dev-latest.log
```

See [Document Artifacts](document-artifacts.md) for the expected sidebar/fullscreen behavior and the focused tests for this surface.

## Web page artifacts do not open in the sidebar

Local web outputs should render as web page artifact cards. The main **Open** action opens generated `.html` and `.htm` files in the in-app sidebar viewer. Built React/Vite/Next output entrypoints such as `dist/index.html`, `build/index.html`, and `out/index.html` use the same sandboxed iframe preview.

If a generated web page only appears as a plain file link or opens in the generic viewer:

1. Confirm the output file extension is `.html` or `.htm`, or that the output path points to a built `index.html` under `dist`, `build`, or `out`.
2. Confirm the file was emitted through `file_created`, `file_modified`, `artifact_created`, or as the primary completion output.
3. Reopen the task and click the main **Open** button, not an external-app dropdown item.
4. If the project is React/Vite/Next source only, build it first so one of `dist/index.html`, `build/index.html`, or `out/index.html` exists. The artifact viewer intentionally does not auto-start dev servers.
5. If the iframe opens but local assets are missing, capture a dev log and check for HTML asset inlining errors from `readFileForViewer`.

For a fresh repro log:

```bash
npm run dev:log
```

Then inspect:

```bash
logs/dev-latest.log
```

See [Web Page Artifacts](web-page-artifacts.md) for the expected sidebar/fullscreen behavior and the focused tests for this surface.

## Browser workbench does not open for website testing

Interactive browser-use prompts should open a visible browser workbench in the right sidebar. This is different from web page artifacts: generated `.html` files use the artifact iframe viewer, while live URLs use the Browser V2 workbench. See [Browser Workbench](browser-workbench.md) for the expected controls, cursor overlay, responsive viewport controls, screenshots, diagnostics, snapshot refs, and annotation behavior.

If a task like "go to example.com and test the application as a normal user" does not open the sidebar browser:

1. Confirm the task used a `browser_*` tool such as `browser_navigate`, not only `web_fetch`. `web_fetch` is still correct for static page reading.
2. Confirm the task is selected in the main task view. The visible workbench is tied to the selected task and opens on demand through the renderer.
3. If the task explicitly requested `force_headless`, `profile`, `browser_channel`, or `debugger_url`, the tool will use the Playwright/external-CDP fallback path instead of the embedded workbench. The legacy `headless` flag alone should not bypass the visible workbench for normal site testing.
4. If the site requires an existing signed-in Chrome or Edge session, use `browser_attach` explicitly and confirm real-browser control. The embedded browser uses a persistent workspace profile and does not silently reuse system Chrome cookies.
5. Capture a fresh dev log and check for `browserWorkbench:openRequest`, `browserWorkbench:register`, `BrowserSessionManager`, or browser tool errors if the sidebar never appears.

If the sidebar opens but browser actions are hard to follow:

1. Confirm the task is using visible `browser_*` tools rather than external Chrome attach or forced headless mode. Cursor movement is only rendered for the visible in-app webview.
2. Confirm the Browser Workbench is still open for the selected task. Cursor events are scoped to `{ taskId, sessionId }`.
3. If snapshot refs fail as stale or unknown, call `browser_snapshot` again and retry with the new ref. Refs are valid only for the latest snapshot after page updates and navigation.
4. If diagnostics look empty, confirm the task is using the visible Browser V2 workbench rather than forced Playwright or external CDP. Console/network/download/storage buffers are session-scoped.
5. If screenshots or annotation fail, check that the task has an active workspace folder; captures are saved into the workspace before they can be attached back to the agent.
6. If responsive screenshots do not match the expected breakpoint, confirm the task called `browser_emulate` against the visible workbench and that the toolbar shows the active viewport size before `browser_screenshot` runs.

For a fresh repro log:

```bash
npm run dev:log
```

Then inspect:

```bash
logs/dev-latest.log
```

## Browser Use Cloud stealth browser issues

Browser Use Cloud is an explicit remote backend for Browser V2. It is used only when a browser tool requests `browser_provider: "browser-use-cloud"`.

If Browser Use Cloud does not start:

1. Confirm `BROWSER_USE_API_KEY` is set for the app process, or that encrypted secure settings category `browser-use` contains an `apiKey`.
2. If using encrypted settings, confirm `enabled` is not `false`. The `BROWSER_USE_API_KEY` environment variable is allowed to override disabled stored settings for development/runtime use.
3. Confirm the target is a public `http:` or `https:` URL. Cloud mode intentionally blocks `localhost`, private IP ranges, IPv6 private/link-local ranges, `.local`, `.internal`, single-label intranet hostnames, `file:` URLs, and other non-HTTP(S) targets.
4. Use the visible Browser Workbench for local Vite/Next/dev-server URLs, generated HTML artifacts, and private network targets.

If a Browser Use Cloud run fails after creating a session:

1. Check the tool result for `browserUseSession.id`. CoWork keeps this id when cleanup fails so `browser_close` can retry stopping the remote browser.
2. If the error says the Browser Use Cloud session is pending stop, call `browser_close` again after network/API connectivity recovers.
3. Stale or expired Browser Use CDP sessions are cleaned up and retried once. If the retry also fails, inspect Browser Use account/session status and the redacted API error in the task timeline or dev logs.
4. API errors and Browser Use live/CDP URLs are redacted; do not expect raw API keys or full tokenized URLs in logs.

For a fresh repro log:

```bash
npm run dev:log
```

Then inspect:

```bash
logs/dev-latest.log
```

## Automation Studio issues

Open structured flows from **Automations** in the main sidebar. Automation Studio is not under Settings; **Settings > Automations** contains the advanced prompt-based Routine, queue, schedule, hook, trigger, briefing, and Workflow Intelligence controls.

If Studio reports `No handler registered for 'routine:workflowCapabilities'`, the renderer is not connected to the matching Electron runtime. Do not use `npm run dev:react` for this check. Start the desktop application with `npm run dev`. If the error persists, follow the required runtime triage order:

1. Inspect `logs/dev-latest.log`.
2. Inspect `logs/dev-latest.jsonl` when structured process/IPC fields help.
3. If the capture is missing or stale, run `npm run dev:log` and reproduce once.
4. Look for handler registration, preload, `did_finish_load`, `app_shell_ready`, renderer-process, and GPU-process failures.

If the Studio content is misaligned, clipped, or cannot scroll, confirm that `App.tsx` renders `<main className="main-content automation-studio-main">` and that `automation-studio.css` leaves that main element with `overflow-y: auto`. The Studio must not inherit the normal task-content width cap or a fixed-height/hidden-overflow parent. Run the `automation-studio-placement` and `automation-studio-layout` tests after shell or CSS changes.

If `npm run dev` reports an existing development instance, or reaches the OpenAI OAuth startup message and then exits without `did_finish_load` or `app_shell_ready`, quit the existing CoWork OS app from its menu or Dock and retry. CoWork intentionally permits only one Electron process per user-data directory so two runtimes cannot contend on SQLite or mark each other's work as orphaned. The dev launcher detects an existing process before rebranding the Electron bundle because macOS can abort inside application registration if that same bundle is modified and relaunched while active. Removing `dist` does not stop an already running Electron process.

If **Turn on** fails, read the inline validation message and check required fields, graph cycles, preview operations, workflow limits, the selected Google account and scopes, and signed-webhook secret references. Saving a draft is intentionally more permissive than activation.

If a Google starter does not fire, confirm the flow is on, inspect the active version rather than a newer draft, reconnect Google Workspace when scopes are missing, and allow the first poll to establish a non-replay baseline cursor. Gmail and Drive page tokens continue across bounded poll windows, so large backlogs may require later polls.

If Activity shows a step waiting for approval after restart, verify whether the remote action already happened before selecting **Approve once**. The runtime intentionally does not repeat an interrupted action whose external outcome is unknown.

If startup reports a missing `workflow_run_id` column, do not delete the app database. Current `RoutineService.ensureSchema()` adds compatibility columns before creating their indexes. Confirm the current Electron build is running and inspect the migration failure in the dev log.

See [Automation Studio](automation-studio.md#troubleshooting) for connector-policy, secret-removal, signed-webhook, pagination, cancellation, recovery, and developer validation details.

## Task automation creation issues

If `... > Add automation...` is missing from task view:

1. Confirm you are viewing a local task, not a remote-session shadow task.
2. Confirm the task belongs to a workspace. The save path requires a `workspaceId`.
3. Reopen the task; the task title and three-dot menu are part of the selected task header.

If the modal opens but **Save** is disabled:

1. Confirm the automation name is not empty.
2. Confirm the prompt is not empty.
3. Confirm the schedule is valid. `Custom` requires a non-empty cron expression.
4. Use `Chat` or `Local` for `Continue thread`; worktree-style automation must use `New task`.

If **Save** returns an inline error, the modal is showing the routine creation or compiled-backend failure. Check `Settings > Automations > Routines` after a successful save; schedule-triggered routines also appear in `Settings > Automations > Scheduled Tasks` as compiled cron jobs.

## Chronicle desktop screen context issues

If Chronicle never seems to help with prompts like `what is this on the right side` or `why is this failing`, check these in order:

1. **Enable Chronicle** in **Settings > Memory Hub > Chronicle** and accept the consent prompt.
2. Confirm **Settings > Tools > Built-in tools** still has the **Chronicle** category enabled.
3. Make sure the per-task **Chronicle ON** toggle was not turned off in the task composer or Devices panel.
4. Confirm **Screen Recording** is granted for CoWork OS.
5. If Chronicle is enabled but paused, resume it from the Chronicle settings card or the tray menu.
6. Restart the app if Screen Recording was just changed.
7. Leave the target window visible for **15-30 seconds** so Chronicle has recent frames.
8. Start a **fresh task** after enabling Chronicle.

For the first smoke test, use a deterministic prompt instead of a vague one:

```text
Use screen_context_resolve now. Tell me what app and window are on screen and what text is visible on the right side.
```

What to look for:

- the task trace should show a `screen_context_resolve` tool call
- Mission Control task detail should later show `screen_context` evidence or recall hits
- the Chronicle settings card should show a non-zero recent-screen frame count
- the Chronicle settings card should show whether OCR is available and whether Screen Recording is actually granted
- **Settings > Memory Hub > Memory** should show promoted entries under **Chronicle observations**

If the agent still asks you for a screenshot:

- the task may have re-planned before invoking `screen_context_resolve`
- the visible UI may not have had enough distinctive app/title/OCR text
- the current run may not have had fresh passive frames yet
- OCR-backed matches may be weaker if local `tesseract` is not installed

If you need a fresh repro log, run:

```bash
npm run dev:log
```

Then inspect:

```bash
logs/dev-latest.log
```

Use `logs/dev-latest.jsonl` when you need structured fields such as `process`, `level`, or `component`.

Look for lines such as:

- `Chronicle initialized (enabled=true, mode=hybrid)`
- `screen_context_resolve`

If those never appear, see [Chronicle](chronicle.md) and [Computer use](computer-use.md).

## Windows native setup fails (`better-sqlite3`)

If first launch exits after:

```text
[cowork] $ npm.cmd rebuild --ignore-scripts=false better-sqlite3
[cowork] Native setup failed.
```

install native build prerequisites, then retry:

1. Install [Visual Studio Build Tools 2022](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with:
   - Desktop development with C++
   - MSVC v143 build tools
   - Windows 10/11 SDK
2. Install Python 3 and verify:

```powershell
py -3 --version
```

3. Set node-gyp MSVC env vars, then retry from a new terminal:

```powershell
setx GYP_MSVS_VERSION 2022
setx npm_config_msvs_version 2022
cowork-os
```

Windows ARM64 note:
- Setup now auto-tries x64 Electron emulation if ARM64 native rebuild fails.
- To disable that fallback and force native ARM64 only, set `COWORK_SETUP_SKIP_X64_FALLBACK=1`.

## App shows "vUnknown" or remote method error

If the app opens but shows `vUnknown` or `Error invoking remote method 'app:getVersion'`, you likely connected to an older already-running instance.

```bash
pkill -f '/cowork-os' || true
cowork-os
```

## Windows opens to a black screen (`ERR_FILE_NOT_FOUND dist/renderer/index.html`)

If terminal logs include:

```text
Failed to load URL .../dist/renderer/index.html with error: ERR_FILE_NOT_FOUND
```

the published package is missing renderer build assets.

For users:

```powershell
npm uninstall -g cowork-os
npm cache clean --force
npm install -g cowork-os@latest --no-audit --no-fund
```

For maintainers (before publish), verify tarball contains renderer assets:

```bash
npm run build
npm pack --json --dry-run | jq -r '.[0].files[].path' | grep '^dist/renderer/index.html$'
```

## VPS: "tsc: not found"

If you see `sh: 1: tsc: not found` right after `npx coworkd-node`, you are on an older broken npm publish. Upgrade and retry:

```bash
npm install cowork-os@latest --no-audit --no-fund
```

For production VPS installs, prefer the packaged Linux server release from GitHub Releases instead of the npm quick-start path. The package is named `cowork-os-server-linux-x64-v<version>.tar.gz`, includes built daemon assets, resources, connectors, and runtime dependencies, and runs with:

```bash
node bin/coworkd-node.js --print-control-plane-token
```

See [Linux VPS](vps-linux.md) for the full tarball + checksum + systemd flow.

## "Tool-call budget exhausted: 42/42"

If you see:

```text
Tool-call budget exhausted: 42/42
```

that means hard executor budget contracts are enabled.

Current default behavior:

- `COWORK_AGENT_BUDGET_CONTRACTS=false` (opt-in only)

If your environment still enforces this cap, check for an explicit override and unset it:

```bash
unset COWORK_AGENT_BUDGET_CONTRACTS
```

Or explicitly disable it:

```bash
export COWORK_AGENT_BUDGET_CONTRACTS=false
```

To restore legacy strict budget-contract behavior, set:

```bash
export COWORK_AGENT_BUDGET_CONTRACTS=true
```

## "web_search budget exhausted: X/Y"

If a research step logs:

```text
web_search budget exhausted: 12/12
```

the task now uses a soft landing path for web-search-specific budget limits:

- The `web_search` tool call returns a structured error (`failureClass=budget_exhausted`) instead of throwing a hard executor exception.
- Execution can continue using already-collected evidence.
- Terminal completion can resolve as `partial_success` (instead of being hard blocked), and budget-constrained failed steps are auto-waived in the completion gate when appropriate.

To tune behavior, use Guardrails > Web Search Policy:

- `Mode`: `disabled | cached | live`
- `Max uses per task`
- `Max uses per step`
- `Allowed domains` / `Blocked domains`

Notes:

- `cached` is the default mode.
- If strict cached provider behavior is unavailable, runtime falls back to `live` and emits `web_search_mode_fallback_live`.
- Domain filtering emits `web_search_domain_filtered_result_count`. If all results are filtered, `web_search` returns a structured policy error.

## LaTeX PDF compile fails or only creates `.tex`

The `compile_latex` tool uses a system TeX engine. CoWork OS does not bundle TeX Live, MacTeX, MikTeX, or Tectonic.

If a LaTeX/TikZ paper task leaves the `.tex` source but does not produce a PDF, check the task timeline for a `compile_latex` diagnostic. The most common message is:

```text
No LaTeX engine found. Install tectonic, latexmk, xelatex, lualatex, or pdflatex and retry.
```

Fix:

1. Install one supported engine on the machine running CoWork OS.
2. Confirm the binary is on `PATH` with one of:

```bash
which tectonic
which latexmk
which xelatex
which lualatex
which pdflatex
```

3. Retry the task or ask CoWork to compile the existing `.tex` file.

Notes:

- Engine priority is `tectonic`, then `latexmk`, `xelatex`, `lualatex`, and `pdflatex`.
- Paths are restricted to the active workspace.
- A failed compile should still keep the editable `.tex` source as the durable artifact.
- Successful compiles show a paired artifact workbench with Summary, `.tex source`, and PDF tabs.

## Workflow Intelligence startup warnings in development

If `npm run dev` or `npm run dev:log` shows warnings like:

```text
[AgentDaemon] Task requires git worktree isolation, but worktrees are unavailable for this workspace.
[Main] Failed to initialize SubconsciousLoopService: SqliteError: no such column: workspace_id
[Main] Failed to initialize SubconsciousLoopService: SqliteError: FOREIGN KEY constraint failed
```

those messages come from the Workflow Intelligence reflection service, not from the main Electron boot path itself. The log may still mention `SubconsciousLoopService` because that is the legacy internal service name.

### What the warnings mean

`Task requires git worktree isolation, but worktrees are unavailable for this workspace.`

- A `code_change_task` dispatch was considered for a target that requires isolated git execution.
- The target workspace was not eligible for worktree use.
- Common reasons: the workspace is not a real git repo, it is temporary, or worktree support is disabled/unavailable.

`SqliteError: no such column: workspace_id`

- An earlier build queried legacy rows with an outdated column assumption during workflow-intelligence target collection.
- Startup could continue, but `SubconsciousLoopService` would fail to initialize.

`SqliteError: FOREIGN KEY constraint failed`

- An earlier migration path could fail while rekeying legacy improvement records into workflow-intelligence target history.
- This was a migration bug, not a sign that the feature requires manual owner enrollment or a separate approval step.

### Current fix

Current builds harden the startup path in several places:

1. `SubconsciousLoopService` starts after memory services are initialized. This is the internal service behind Workflow Intelligence.
2. Code dispatch only targets real git-backed repositories, and canonical code targets resolve from the repository remote instead of from transient workspace noise.
3. Legacy improvement rows are migrated into workflow-intelligence target state without breaking foreign keys.
4. Worktree settings persist in secure settings so code dispatch can still require isolation after restart.
5. Recommendation-only runs still complete successfully when a target has no valid executor mapping.

### How to verify

Use the timestamped dev logger:

```bash
npm run dev:log
```

Then inspect:

```bash
logs/dev-latest.log
```

If the readable log is noisy, use `logs/dev-latest.jsonl` to filter by structured `level` and `component`.

Healthy startup should include:

- `SubconsciousLoopService initialized`
- no `Failed to initialize SubconsciousLoopService` line
- no early worktree failure for a non-git temporary workspace unless a real code target was incorrectly selected

### If you still see the worktree warning

Check:

1. the workspace path is inside a real git repository
2. the repo remote resolves to the intended repository
3. git worktree support is enabled
4. the repository is usable from the app runtime environment

If you use non-git workspaces, Workflow Intelligence can still run on task, mailbox, schedule, trigger, and briefing targets. Only code-change auto-create requires the git/worktree path.

### If you still see SQLite initialization errors

Capture a fresh log and compare the relative timestamps for:

- `MemoryService` initialization
- `SubconsciousLoopService initialized`
- the first workflow-intelligence target refresh or run line

If initialization still fails on a current build, inspect the local database migration path before looking at renderer or approval code.

See also:

- [Development Guide](development.md)
- [Workflow Intelligence](workflow-intelligence.md)
