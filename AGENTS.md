# AGENTS.md

## Failure Triage

When a user reports a failure, error, or unexpected behavior:

1. Check development logs first, if available.
2. Read `logs/dev-latest.log` for the most recent captured run.
3. If `logs/dev-latest.log` is missing or stale for the current repro, run `npm run dev:log` to capture a fresh run.
4. If needed, inspect the newest timestamped file in `logs/dev-*.log` for full context.
5. Quote relevant error lines with timestamps when summarizing findings.
6. If logs are missing, state that clearly and continue with other diagnostics.

## Dev Log Availability

- Log capture is controlled by **Settings -> Appearance -> Developer logging** (default off).
- A forced capture run can be started with `npm run dev:log`.
- Optional local toggle state may exist at `.cowork/dev-log-settings.json`.

## Dev Startup Commands

- Use `npm run dev` for normal development startup; it routes through the log-aware wrapper.
- Use `npm run dev:start` only when you explicitly need the raw underlying startup command.
- `npm run dev:start` auto-selects an available localhost dev-server port (starting from `COWORK_DEV_SERVER_PORT`, default `5173`) and exports `COWORK_DEV_SERVER_URL` for Electron startup.
- Use `npm run dev:log` to force timestamped capture to `logs/dev-*.log` and `logs/dev-latest.log`.
- Use `npm run dev:electron` (or the wrappers that call it) when starting Electron manually; it clears `ELECTRON_RUN_AS_NODE` to avoid renderer env pollution.
- Avoid using `npm run dev:react` alone for desktop debugging; it skips Electron preload APIs and can produce misleading behavior.

## Build Workflow

- `npm run build` now includes `npm run build:healthkit-bridge` before Electron/daemon/connectors builds.
- Use `npm run build:healthkit-bridge` to isolate HealthKit bridge build failures.
- `npm run build:healthkit-bridge` is a no-op on non-macOS platforms (`[healthkit-bridge] Skipping build on non-macOS platform.`).
- On macOS, `npm run build:healthkit-bridge` attempts an Xcode app build first and falls back to SwiftPM packaging if the app bundle is not produced.
- For macOS signing/provisioning overrides during `build:healthkit-bridge`, use `COWORK_HEALTHKIT_DEVELOPMENT_TEAM` and `COWORK_HEALTHKIT_PROVISIONING_PROFILE` if needed.
- `build:healthkit-bridge` also accepts `DEVELOPMENT_TEAM` and `HEALTHKIT_BRIDGE_PROVISIONING_PROFILE` as fallback environment variable names.

## Packaging Workflow

- Use `npm run package` for standard local installer packaging after a full build.
- On macOS distribution/signing flows, use `npm run package:mac`; it loads optional repo-root `.env.mac` (see `scripts/mac-notarize.env.example`) before running build + `electron-builder --mac --publish never`.

## NPM Release Workflow

- When asked to "publish a new release" or ship a new npm version, do **not** publish from a dirty working tree. Use a clean checkout or `git worktree`.
- Do **not** rely on `prepack`/`npm publish` lifecycle hooks for correctness. This repo's `.npmrc` sets `ignore-scripts=true`, so a naive `npm pack`/`npm publish` can skip the build and ship a broken package.
- Before any npm publish, explicitly run:
  - `npm ci --no-audit --no-fund`
  - `npm run build`
- After building, create the tarball explicitly with `npm pack --ignore-scripts --silent`.
- Verify the tarball contains the built desktop artifacts before publish. At minimum, it must contain:
  - `package/dist/electron/electron/main.js`
  - `package/dist/renderer/index.html`
- Validate the packed tarball in a clean temp project before publish:
  - install the tarball with `npm install --ignore-scripts --omit=optional --no-audit --no-fund <tarball>`
  - run `npm run --prefix node_modules/cowork-os setup`
  - fail if setup falls back into dependency bootstrap unexpectedly
  - verify Electron can load `better-sqlite3`
- For release candidates that touch database schema or migrations, also test an upgrade-path database, not just a fresh install. Specifically verify startup/migration succeeds against an older DB shape representative of the reported issue.
- Publish from the clean built worktree with `npm publish --ignore-scripts` (plus `--otp=<code>` when npm 2FA requires it).
- After publish, verify registry propagation with:
  - `npm view cowork-os@<version> version`
  - `npm view cowork-os@<version> dist.tarball`
- When validating a Windows npm fix, prefer this recovery flow so old global installs do not interfere:
  - `taskkill /F /IM electron.exe /IM node.exe 2>nul`
  - `npm uninstall -g cowork-os`
  - remove `%APPDATA%\\npm\\node_modules\\cowork-os` and related `cowork-*.cmd` launchers if they still exist
  - `npm cache clean --force`
  - `npm install -g cowork-os@<version>`
- Do **not** advise users to delete their CoWork database/app-data directory for install or migration issues unless the user explicitly accepts data loss. Prefer shipping a migration fix.

## QA and Reliability Commands

- Use `npm run kit:lint` to run workspace kit health checks from the CLI (human-readable by default, JSON export supported by the CLI).
- Use `npm run skills:check` before test/merge when touching bundled skills; it runs routing/content/audit/eval quality gates.
- Use `npm run qa:eval:build` to refresh the eval corpus when curating new reliability regressions.
- Use `npm run qa:eval:run` to replay the eval suite, and `npm run qa:reliability` for the combined eval + battery loop.
- Use `npm run qa:eval:enforce-regressions` to enforce production-fix-to-eval coverage policy.
- Use `npm run qa:timeline:backfill -- --db /absolute/path/to.db` then `npm run qa:timeline:enforce -- --db /absolute/path/to.db` when validating timeline completion telemetry changes.

## Setup Commands

- Use `npm run setup` for workstation setup; it chains native rebuild/install safeguards.
- Use `npm run hooks:install` to (re)install local git hooks from `.githooks/` when setup hooks are missing or outdated.
- Use `npm run setup:native` to isolate native module/driver setup issues.
- Use `npm run setup:server` for server-only dependency/bootstrap flows (for example Linux VPS daemon/connectors).
