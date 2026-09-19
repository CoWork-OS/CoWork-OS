# Release Notes 0.5.47

Release `0.5.47` is a reliability-focused release for longer-running CoWork OS sessions. It reduces main-thread memory search pressure, improves multi-agent and multi-task renderer stability, tightens permission/privacy behavior, and keeps the macOS desktop artifact on the unsigned fallback distribution path.

## Highlights

- **Multi-agent and multi-task stability**: task-event appends now replace high-frequency transient progress events in batches, cap noisy renderer event growth, and reduce stale-task reconciliation churn. The sidebar is memoized around stable task-list signatures so large task sets and spawned-agent activity do not force unnecessary rerenders.
- **Off-main-thread memory recall**: memory FTS search can run through a worker thread, covering prompt recall, marker lookup, and general memory search while preserving DB/hybrid fallbacks when the worker is unavailable or returns no useful rows.
- **Memory pressure and leak fixes**: workspace memory-pressure scans now use async file reads, Teams message deduplication timers and tray status timers are cleared on teardown, WhatsApp preload listeners return unsubscribe callbacks, managed briefing runs expire after 24 hours, subconscious evidence maps are pruned, and cross-signal mention maps are capped and aged out.
- **Location and maps workflow**: desktop location support now includes native macOS, Windows, Linux, and IP fallback helpers, plus maps MCP tools for current location, geocoding, reverse geocoding, route estimates, and nearby-place search.
- **Permission and privacy hardening**: location approvals cannot be auto-approved or persisted, memory content-marker lookup excludes private memories, and timeline evidence links no longer fetch remote favicons.
- **Unsigned macOS release path**: macOS packaging remains on the unsigned fallback path for this release. Validate the artifact with `node scripts/smoke-desktop-artifacts.mjs --platform=mac --allow-unsigned --expected-version=0.5.47`.

## User-Facing Improvements

- **More responsive active tasks**: noisy progress/log/streaming events are bounded more aggressively while structural task events remain visible.
- **More stable sidebar behavior**: large task histories, updates, completion attention, and mission-control navigation avoid avoidable sidebar rerenders.
- **Better memory recall under load**: memory search work is less likely to block active agent execution, while fallback paths preserve recall if the worker is restarting.
- **Safer location prompts**: requests for location remain explicit and session-scoped.
- **Maps-aware tasks**: agents can answer location, route, and nearby-place questions through the bundled maps MCP surface when approved.

## Reliability and Security

- **FTS worker resilience**: worker requests time out, reject pending calls on crashes, restart with exponential backoff, stop after repeated crashes, and are destroyed on app quit.
- **Fallback-safe recall**: async memory recall falls back to the existing synchronous DB/hybrid implementation instead of silently returning empty results.
- **Prompt-recall filtering preserved**: worker prompt-recall results include content so ignored imported-memory markers and prompt-suppression rules still apply.
- **Bounded cross-agent signals**: startup rebuilds process fewer task events, stale mentions are pruned after the active window, and per-workspace mention maps are capped.
- **Subconscious loop cleanup**: stale evidence and notification maps are pruned during target refreshes.
- **Timer cleanup**: Teams deduplication, tray status updates, and managed briefing cleanup timers no longer live past their owner lifecycle.
- **Private-memory guard**: content-marker memory lookup keeps private memories out of marker search results.
- **Remote favicon privacy**: evidence links use local compact icons instead of fetching third-party favicons.

## Developer and Packaging Notes

- **Version bump**: package metadata is prepared for `0.5.47`.
- **macOS artifact expectation**: this release is intentionally unsigned/ad hoc signed. Use the unsigned smoke path and document Gatekeeper first-launch behavior as needed.
- **Formatter status**: `npm run fmt:check` still needs a formatter-config decision before it can be used as a release gate; adding a bare Oxfmt config exposes broad historical formatting drift.
- **Suggested validation before publish**:
  - `npm ci --no-audit --no-fund`
  - `npm run build`
  - `npm run release:smoke`
  - `npm run test`
  - `npm run package:mac:unsigned`
  - `node scripts/smoke-desktop-artifacts.mjs --platform=mac --allow-unsigned --expected-version=0.5.47`
