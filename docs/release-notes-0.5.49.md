# Release Notes 0.5.49

Release `0.5.49` expands CoWork OS with a local CLI runner, Browser Use Cloud browser automation, bundled Codex Security workflows, automation outcome reporting, richer usage insights, and a broad security/reliability hardening pass.

## Highlights

- **CLI local runner**: CoWork now ships a `cowork` npm binary alongside the existing desktop, control-plane, and daemon entrypoints. The CLI includes local Control Plane discovery, direct task execution, terminal formatting, config storage, and source build coverage through `npm run build:cli`.
- **Browser Use Cloud backend**: Browser V2 can explicitly route `browser_navigate` through Browser Use Cloud with `browser_provider: "browser-use-cloud"`. The backend supports `BROWSER_USE_API_KEY` or encrypted settings, API v3 session creation, CDP attach, stale-session retry, remote session stop handling, and optional proxy/profile/timeout/recording/screen controls.
- **Codex Security workflows**: bundled Codex Security scan skills now cover repository-wide scans, scoped scans, diff scans, deep multi-pass scans, threat modeling, attack-path analysis, finding discovery, validation, and fix workflows. The release also includes scan artifact orchestration, report validation, and HTML report rendering assets.
- **Automation outcomes in Mission Control**: automation runs can record whether results were actionable, informational, low value, or failed. Mission Control now includes an Automation ops view with summary counts and recent outcome rows that link back to task detail when available.
- **Usage Insights token activity**: the Usage Insights overview now focuses on total tokens, peak tokens, average task duration, streaks, and a 12-month token heatmap with daily, weekly, and cumulative modes.
- **Prompt composer link chips**: pasted standalone web URLs are normalized into compact Markdown links and rendered as non-editable favicon chips while preserving copy, paste, cursor, and mention-token behavior.
- **Public adoption stats**: public GitHub/npm adoption data can be collected and rendered into the README and docs, with history snapshots for trend tracking.

## Security and Safety

- Hardened webhook and MCP host authentication.
- Authenticated CoWork host tunnel forwarding.
- Blocked cross-host Scrapling redirects.
- Restricted `open_url` to HTTP(S) web schemes.
- Tightened web fetch and scraping guardrails, including safer redirect/error handling.
- Defaulted automated task permission behavior to `dont_ask`.
- Hardened Electron development codesigning checks and native setup behavior.

## Reliability and UX Improvements

- Reduced sluggish desktop startup paths and tuned deferred startup work.
- Added an opt-in desktop Control Plane auto-enable path for local development and managed desktop setups.
- Improved executor completion guardrails, command requirements, file mutation verification, and frontend browser-preview guidance.
- Repaired pinned activity schema migration behavior.
- Improved timeline event projection, browser action taxonomy, parallel group rendering, and duplicate failure filtering.
- Reduced repeated static Control Plane settings polling.
- Isolated Settings sidebar search into a memoized component to reduce avoidable renderer work.
- Added a visible loading state and manual load-more affordance for task-list pagination.

## Provider and Integration Fixes

- Fixed retired Anthropic model handling.
- Fixed OpenCode Go Qwen 3.7 Max routing.
- Fixed x402 payment approval enforcement.
- Fixed the Everyday Agent read-only toggle.
- Improved Browser V2 documentation and runtime safety model around Browser Use Cloud opt-in behavior, private/local target blocking, redacted errors, and pending-stop retries.

## Documentation

- Added and refreshed docs for CLI usage, Browser Use Cloud, Codex Security scans, plugin packs, setup, troubleshooting, security, development, Linux/VPS notes, project status, and public adoption reporting.
- Refreshed README positioning to describe CoWork OS as GUI-first and CLI-capable.
- Updated adoption stats reports and README rendering to use Markdown output.

## Release Readiness

- **Version bump**: package metadata is prepared for `0.5.49`.
- **Release baseline**: compare from `v0.5.48` to `v0.5.49`.
- **Packaging attention**: this release adds a new npm binary (`cowork`), a CLI TypeScript build, bundled plugin-pack resources, and new Codex Security assets. Verify the packed tarball contains the CLI entrypoint, built desktop artifacts, and plugin-pack resources.
- **Database upgrade attention**: validate upgrade-path databases for pinned activity migration and automation outcome persistence, not only fresh installs.
- **Security attention**: run the security harness because this release changes webhook/MCP auth, tunnel auth, URL scheme policy, scraping redirects, and browser/web-fetch guardrails.
- **Platform smoke attention**: macOS, Windows, and Linux smoke tests are host-specific. Run each smoke on the matching platform or CI runner after package artifacts are built.

## Suggested Validation

Run the focused checks before tagging or publishing:

```bash
npm run build
npm run release:smoke
npm run qa:security:harness
npm run package:desktop:smoke -- --expected-version=0.5.49 --allow-unsigned
npm run package:win:smoke -- --expected-version=0.5.49
npm run package:linux:server:smoke
```

For npm publication, follow the repository release workflow: use a clean checkout, run `npm ci --no-audit --no-fund`, run `npm run build`, create the tarball with `npm pack --ignore-scripts --silent`, validate the clean install/setup path, then publish with `npm publish --ignore-scripts`.

## Pull Requests

- #149 Fix x402 payment approval enforcement
- #150 Fix OpenCode Go Qwen 3.7 Max routing
- #152 Fix Everyday Agent read-only toggle
- #154 Fix retired Anthropic model handling
- #155 Add Codex Security scan workflows
- #156 Fix sluggish desktop startup
- #158 Add cowork local runner
- #159 Harden webhook and MCP auth
- #160 Add Browser Use Cloud backend
- #161 Migrate scan helpers to Codex Security pack
- #162 Harden Electron dev codesign helper
- #163 Restrict open_url to web schemes
- #164 Harden web fetch and scraping handling
- #165 Support namespaced skill slash commands
- #166 Harden executor completion guardrails
- #168 Record automation run outcomes
- #169 Repair pinned activity schema migration
- #170 Authenticate CoWork host forwarding
- #171 Improve timeline event projection
- #172 Prioritize contextual prompt guidance
- #173 Block cross-host Scrapling redirects
- #174 Default automated tasks to dont_ask
- #175 Classify browser timeline tool actions
- #176 Tune desktop startup Control Plane behavior
- #177 Render pasted web links as composer chips
- #178 Add usage insights token heatmap
- #179 Polish renderer shell settings behavior
- #180 Show automation outcomes in Mission Control
- #181 Refresh docs and adoption summary
