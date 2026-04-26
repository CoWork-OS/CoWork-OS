# Troubleshooting

## macOS app won't launch (unsigned build)

CoWork OS is currently distributed as an unsigned build. On first launch, use **System Settings > Privacy & Security > Open Anyway** once.

Release maintainers can create the unsigned macOS DMG/ZIP with:

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

## macOS "Killed: 9" during setup

If you see `Killed: 9` during `npm run setup`, macOS terminated a native build due to memory pressure.

`npm run setup` already retries native setup automatically with backoff. Let it continue until it exits. If it still exits non-zero, close heavy apps and run the same command again:

```bash
npm run setup
```

## Computer use (macOS) issues

If **screenshots fail or time out**, grant **Screen Recording** for the helper path shown in **Settings → Tools → Computer use**, then **quit and restart** the app. If **clicks or typing do nothing**, enable **Accessibility** for that helper path the same way.

If the agent **never uses** the computer-use tools, confirm **Settings → Tools → Built-in tools** includes the **computer use** category, and phrase tasks as **native app / window / dialog** work (not pure browser or CLI tasks).

See the full guide: [Computer use (macOS)](computer-use.md).

## Inbox Agent issues

Inbox Agent uses a local cache plus provider-backed actions. When debugging mailbox behavior, first capture a current development log:

```bash
npm run dev:log
```

Then inspect:

```bash
logs/dev-latest.log
```

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

### Microphone next to Search threads fails after permission is allowed

The desktop app does not rely on Chromium's Web Speech service because it can request microphone permission but still fail when the speech-recognition backend is unavailable. Configure OpenAI or Azure speech-to-text in **Settings > Voice**. After that, Inbox Agent voice search and `Speak reply` use provider transcription.

### AI draft does not disappear after send

Generated drafts are removed after a successful provider send. If the draft remains, check the visible error banner and the log for the provider send failure. The edited draft subject/body are saved before send, so a failed send should preserve your edits for retry.

### Startup fails with a missing mailbox column

Mailbox schema migrations should add classification, Today/domain, attachment, and replacement-client columns automatically. If startup reports a missing column such as `today_bucket`, do not delete the app database. Capture `logs/dev-latest.log` and verify the schema migration path before trying destructive recovery.

## PPTX previews only show text or speaker notes

CoWork can always extract slide text and presenter notes from `.pptx` files. Rendered slide thumbnails are best-effort and depend on local conversion tools:

- `soffice` from LibreOffice converts the deck to PDF
- `pdftoppm` renders PDF pages to PNG thumbnails

If either binary is missing or fails on a deck, the presentation viewer falls back to text/notes mode. Install LibreOffice and Poppler, restart CoWork, then reopen the artifact to regenerate the cached preview. The `.pptx` file itself is still available through **Open file** or **Show in Finder**.

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

Look for lines such as:

- `Chronicle initialized (enabled=true, mode=hybrid)`
- `screen_context_resolve`

If those never appear, see [Chronicle](chronicle.md) and [Computer use (macOS)](computer-use.md).

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
