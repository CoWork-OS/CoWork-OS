# Troubleshooting

## macOS app won't launch (unsigned build)

CoWork OS is currently distributed as an unsigned build. On first launch, use **System Settings > Privacy & Security > Open Anyway** once.

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

## Self-improvement startup warnings in development

If `npm run dev` or `npm run dev:log` shows warnings like:

```text
[AgentDaemon] Task requires git worktree isolation, but worktrees are unavailable for this workspace.
[AgentDaemon] Memory capture failed: Error: [MemoryService] Not initialized. Call MemoryService.initialize() first.
[AgentDaemon] Error emitting legacy alias event error: Error [ERR_UNHANDLED_ERROR]: Unhandled error.
```

these messages come from the autonomous self-improvement loop, not from the main Electron boot path itself.

### What the warnings mean

`Task requires git worktree isolation, but worktrees are unavailable for this workspace.`

- An autonomous improvement task was created with `requireWorktree: true`.
- Its target workspace was not eligible for worktree use.
- Common reasons: the workspace is not a git repo, it is temporary, or worktree support is disabled/unavailable.

`Memory capture failed: Error: [MemoryService] Not initialized. Call MemoryService.initialize() first.`

- The improvement loop started early enough that task-event persistence attempted `MemoryService.capture(...)` before `MemoryService.initialize(...)` finished.
- This was a startup-order race and usually did not stop the rest of the app from starting.

`ERR_UNHANDLED_ERROR`

- This was secondary log noise.
- The daemon emitted a legacy event alias literally named `"error"`.
- In Node's `EventEmitter`, `"error"` is special and throws if there is no listener.
- The underlying problem was still the worktree requirement failure; this log line just made it look scarier.

### Current fix

Current builds address the issue in three places:

1. `ImprovementLoopService` now starts after `MemoryService` has been initialized.
2. When autonomous improvement requires worktrees, candidate selection skips workspaces that cannot use worktrees.
3. The daemon no longer emits the legacy `"error"` alias when no `error` listener is registered.

### How to verify

Use the timestamped dev logger:

```bash
npm run dev:log
```

Then inspect:

```bash
logs/dev-latest.log
```

You should no longer see the self-improvement task start before memory initialization, and you should no longer see the legacy `ERR_UNHANDLED_ERROR` line for this case.

### If you still see the worktree warning

The autonomous loop is still finding a candidate in a workspace that cannot support isolated git execution. Check:

1. The workspace path is inside a real git repository.
2. The workspace is not temporary.
3. Git worktree support is enabled.
4. The repository is usable from the app's runtime environment.

If you intentionally use non-git workspaces, either:

- leave self-improvement enabled and let it operate only on git-backed workspaces
- or disable/self-limit the improvement loop for that environment

### If you still see memory initialization warnings

That indicates a different startup-order regression. Capture the latest log and compare the relative timestamps for:

- `MemoryService` initialization
- `ImprovementLoopService initialized`
- the first `Improve:` task startup line

If the task starts before memory initialization, treat it as a bug and inspect the startup sequence in `src/electron/main.ts`.

See also:

- [Development Guide](development.md)
- [Self-Improving Agent Architecture](self-improving-agent.md)
