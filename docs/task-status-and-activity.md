# Task status and activity disclosure

CoWork projects task events into one renderer-owned model for the main timeline, right panel,
replay, and the compact status strip above the composer. The model keeps user-facing plan steps,
activity groups, individual tool activities, and outcome metrics separate so tool-call volume is
never presented as plan progress.

## Status strip

`TaskStatusStrip` shows the current step or task state plus at most two trusted metrics. Clicking it
opens a bounded, non-modal overview of the plan, latest activity, impact, outputs, verification, and
blocking state. Plan and output controls route to the existing timeline and artifact surfaces.

The local rollout flag is `task-status-strip-enabled`. It defaults to enabled and can be disabled by
setting its `localStorage` value to `false`. When renderer performance logging is enabled, drawer
open/close telemetry records categorical counters only. It never includes labels, paths, arguments,
filenames, or task content.

## Trusted impact metrics

The renderer formats the additive `TaskImpactMetric` contract in
`src/renderer/utils/task-impact-metrics.ts`. It accepts persisted, attributed snapshots and a small
set of typed timeline evidence. It never parses assistant prose or arbitrary tool-result text.

Current sources are:

- citations and evidence references for collected sources;
- artifact/output events for created artifacts;
- verification events for passed checks;
- agent lifecycle events for active-agent counts;
- explicit `impactMetrics` returned by canonical presentation and spreadsheet tools;
- the task mutation ledger for changed files and attributed text-line impact.

Unsupported metrics remain absent until a producer exposes an explicit typed count. Connector tools
may add `records_updated` through the same canonical outcome contract once their success semantics
and count are reliable.

## Mutation attribution

Before a core file tool mutates a path, the daemon captures its first task-local baseline under the
CoWork user-data directory. Successful file events recompute impact against those baselines and
persist coalesced `task_impact_updated` snapshots. This includes CoWork's uncommitted writes while
excluding changes that predated the task. Binary files contribute to `files_changed` but not line
totals. If any relevant baseline is incomplete, the renderer receives the file count and omits line
addition/removal metrics.

These snapshots are part of normal event persistence, replay, fork/resume, and remote transport;
remote renderers do not inspect a local Git worktree.

## Disclosure behavior

Disclosure state uses `auto`, `expanded`, and `collapsed` intents scoped by task and by group or
activity ID. The current auto group opens; completed auto groups close. Explicit user intent wins,
so a collapsed running group stays collapsed as new events arrive. The cache is bounded across task
switches.

Large groups retain all lightweight summaries in a measured, virtualized viewport. Auto-follow runs
only while the viewport is near the bottom; otherwise a new-activity control reports pending rows.
Replay disables live auto-follow and transition motion.

## Accessibility and motion

Expandable headers are semantic buttons with `aria-expanded` and `aria-controls`. Escape closes the
status drawer and restores focus; collapsing a group or activity restores focus before removing a
focused child. Live-region announcements are throttled and limited to plan-step, blocking, and
completion transitions. Touch targets expand to at least 44 pixels for coarse pointers.

Disclosure and latest-label motion use the Web Animations API and transform/opacity/clip effects.
Reduced-motion mode and replay apply state changes immediately. Forced-colors styles preserve
boundaries and selected state without relying on color alone.

## Validation

Focused coverage lives in the task status projection, impact metric, disclosure, status strip,
mutation ledger, canonical tool outcome, timeline snapshot, and renderer performance tests. The
performance fixture exercises 1,000 and 10,000 activity events, large hidden payloads, repeated
disclosure changes, and bounded live transcript projection.
