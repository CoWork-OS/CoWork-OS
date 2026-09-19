# Verbose-off activity UX: recording study and implementation plan

Status: planning only. Studied 19 September 2026 against the current working tree. No application code changed or runtime validation performed.

## Intended result

With Verbose off, show one quiet, changing activity line for the current work segment. Clicking it reveals the segment's action history, including completed actions. Each action can independently reveal its details. Preserve assistant commentary, final answers, artifacts, and actionable approval/input requests as readable conversation content.

The current action replaces the previous live label in place; it does not append another visible row in the collapsed view. Previous work remains inspectable. Expansion never requires turning Verbose on.

## Recording evidence

Source: `/Users/mesut/Desktop/Screen Recording 2026-09-19 at 21.52.27.mov` (75.655 seconds, 1552 × 1982, reported 120 fps). Inspected overview frames, selected full-resolution regions, one-second sequences, and a short eight-frame-per-second motion sample. The text and commands visible in the recording were treated as reference content, not instructions to execute.

Times below are approximate offsets into the recording, not the task's displayed elapsed time.

| Clip interval | Observed behavior | Replication implication |
| --- | --- | --- |
| 00:00–00:34 | Two substantial assistant messages remain visible. A prior group is summarized as “Loaded a tool, read files, ran commands.” The newest activity changes between a phase description and a concrete action such as “Reading App.tsx.” | Keep conversation messages separate from action history. Use one live slot within the active segment; retain quiet summaries for earlier segments. |
| Around 00:04 | A pale highlight moves through the current text without changing its position. | A restrained text shimmer signals ongoing work. Completed history does not shimmer. |
| Around 00:36–00:38 | Hovering the activity exposes a right chevron; opening it turns the chevron downward and reveals earlier reads, searches, and commands. | The activity label is the disclosure control. Expansion is inline, not a modal or navigation away. |
| 00:38–00:56 | The history is a compact list with small tool glyphs, muted labels, truncated long search text, and a bounded viewport. Different portions of the list become visible while commentary and composer remain in place. | Retain all actions through scrolling/paging; do not grow the whole conversation for every action. |
| Around 00:45–00:51 | “Ran command” independently expands into a pale Shell panel containing command, output, and Success state. | Group expansion and action-detail expansion are separate states. Output panels are requested detail. |
| Around 00:58–01:04 | The history closes back to “Reading side-chat-panel.test.ts,” with the preceding messages unchanged. | Collapsing restores the same live slot immediately; work continues while collapsed. |
| Around 01:05–01:09 | Stopping changes the turn header to “You stopped after …” and the action group becomes a static aggregate summary. The elapsed label briefly shows 0s before settling. | Stop animation on terminal/interrupted state, retain history, and freeze a correct duration; do not reproduce the transient 0s glitch. |
| Around 01:10–01:15 | A new working interval and Thinking line appear beneath the stopped work, followed by further commentary. | A resumed/new run needs its own lifecycle boundary; earlier stopped work must remain historical. |

The clip does not establish Codex's exact easing, shimmer period, internal event schema, keyboard behavior, persistence after relaunch, error/approval behavior, or successful-completion layout. Values and behavior below are CoWork proposals, not claims about Codex internals.

## Interaction specification

### Three disclosure levels

```text
Collapsed, active
  Assistant commentary remains readable.
  [small optional tool glyph] Reading proposal.pdf  ›

Expanded group
  Reviewing supplier proposals                     ⌄
    Read requirements.docx                         ›
    Searched supplier documentation                ›
    Reading proposal.pdf                           ›

Expanded action inside the group
    Ran command                                    ⌄
      [command and bounded output panel]
      Success

Historical group
  Read files, searched documentation               ›
```

- Default every new group to collapsed in Verbose-off, including an active group. One animated header represents current activity. Completed groups show a static summary.
- Explicit expansion stays open as events arrive and when the segment finishes. Explicit collapse stays closed. Do not reopen content merely because execution is active.
- Group headers describe the phase while expanded when a trustworthy phase label exists. Otherwise use a simple “Activity” label; the current action is visible in the list. Avoid a duplicate animated header and animated copy of the same row.
- Individual details default closed. Opening one action does not open its neighbors, close the group, or change Verbose.
- Keep disclosure intent scoped to task/surface/group/action, using the existing cache. Preserve it across ordinary task switches; do not imply new persistence across app restarts.
- Hover/focus reveals the chevron more strongly. Keep a subdued discoverable affordance at rest and visible keyboard focus; touch cannot depend on hover.
- Scrolling upward pauses following new actions. Show the existing “N new activities” control to return to the latest activity. Preserve scroll position when inspecting a detail panel, collapsing/reopening a group, or prepending older history.
- Prior groups remain inspectable next to their commentary. In long histories, provide an explicit earlier-history control; never silently discard actions because the live projection is bounded.

### Live-label rules

Derive the label from execution state, not simply the last received event:

1. Unresolved user action takes priority: approval, structured input, or a blocking failure. Keep its existing actionable card visible outside collapsed history.
2. Prefer the newest meaningful active tool/action within the current run. Correlate starts and outcomes by stable IDs. A late result for an older parallel tool cannot replace a newer active action.
3. When no tool is active, use the latest public progress/phase label for the current run; otherwise “Thinking” or “Working.” Do not extract private reasoning or fabricate a phase.
4. Tool completion updates that action's history row in place. Do not say “Reading …” indefinitely after its result arrives. A completed label can display statically until a current phase or next action replaces it.
5. Terminal, paused, blocked, or interrupted state stops the running shimmer. A step completing does not mean the whole task completed.
6. Multiple concurrent actions can use the newest active action with a small “+N” indicator. Expand to inspect other active branches. Completed siblings remain static.

Order by canonical sequence when available, with timestamp and stable ingestion order as legacy fallback. Bookkeeping, token updates, resolved approval narration, and empty/sanitized assistant messages must not steal the live slot or create empty groups.

Labels must work for browser use, research, documents, images, connectors, and agents as well as code. Use existing sanitized friendly tool labels; include a safe basename or provider label only when useful. Avoid raw JSON, connector IDs, bundle identifiers, or a long list of internal tool names in the collapsed summary.

### Motion and visual treatment

- One line with stable height, muted readable text, optional 12–14 px tool glyph, and trailing chevron. Use existing theme variables; target approximately 13 px text and 20–24 px line height, tuned against the actual CoWork scale.
- Remove the active group's repeated “Working” prefix, horizontal rule, timeline rail/dot, and duration/token metadata from the minimal header. Keep elapsed time in the existing turn-level location.
- Animate only the current work indicator. Propose a low-contrast text highlight over roughly 1.8–2.4 seconds and a 100–150 ms opacity/2 px translation on label replacement. These are initial tuning values.
- Coalesce very short-lived label changes over roughly 150 ms to avoid flicker, while retaining every action in history. Blocking and terminal state changes bypass this delay.
- Reuse the existing approximately 190–220 ms disclosure animation; cancel interrupted animations cleanly. Verify layout/scroll stability, since animating a clip alone does not guarantee stable layout.
- Historical labels and completed action rows remain still. In an expanded group, animate the current action rather than both its row and the header. Existing task status can remain visible but should not add another decorative spinner in minimal mode.
- Respect reduced motion and replay: static current-state indication, immediate label replacement, no shimmer or automatic smooth scrolling. Use a readable solid-text fallback for forced colors.
- Use semantic buttons, `aria-expanded`, `aria-controls`, focus restoration, and throttled polite announcements for meaningful state changes. Do not announce every output chunk. Closing content must not leave hidden controls keyboard-focusable during the exit animation.

### Completion and status ownership

Keep the final answer and output cards prominent. Retain a collapsed activity summary above the result so the user can inspect work without toggling Verbose. If delivery mode suppresses prior conversation, that summary must expose the entire completed run's work, not just its last segment.

The existing composer `TaskStatusStrip` remains the task/plan/blocking-status control. Its drawer is not the replacement for inline action history. Keep plan and useful outcome information there, but suppress duplicated latest-action text/animation in Verbose-off when the inline activity is present. If the activity is offscreen, the strip can remain a static status/navigation affordance.

Stop, cancellation, failure, and waiting states are distinct. Never summarize cancelled or failed work as completed successfully. Successful-completion layout is a CoWork design extension because the clip shows stopping and resuming rather than final delivery.

## Current CoWork implementation and gaps

The current checkout already contains substantial disclosure work. The older planning notes are not a reliable statement of what is still missing.

| Current seam | Verified current behavior | Planned change |
| --- | --- | --- |
| `src/renderer/utils/disclosure-state.ts` | `auto` resolves to expanded when `isCurrent` is true; explicit collapsed intent already wins. | Add a mode-aware default policy. In summary mode, auto means collapsed. Keep explicit intent authoritative. |
| `src/renderer/hooks/useTaskDisclosureIntents.ts` | Group/action intent is cached through task surface state; toggle computes from the current auto policy. | Make rendering, toggle, and row-height estimation use the same effective default. Otherwise the first click can appear to do nothing. |
| `src/renderer/components/MainContent/MainContent.tsx` | Both feed estimates and actual group rendering pass active state to the disclosure resolver. `ActionBlock` itself respects `expanded`. | Thread minimal-mode policy through every call site, cached row revision, and toggle path. Keep Verbose-on's existing defaults. |
| `src/renderer/components/timeline/ActionBlock.tsx` | Renders “Working,” secondary latest label, glyph, chevron, rule, and metadata. Already animates label replacement for 110 ms. | Introduce a minimal variant with one primary label and a running-only shimmer. Retain the existing detailed variant. Update the stale comment describing unconditional active expansion. |
| `src/renderer/utils/task-status-projection.ts` | `deriveActivityGroups` takes its label from the last block event and uses generic group summaries. | Project a meaningful current action and lifecycle state; reuse successful-outcome aggregation for historical summaries. Avoid marking a whole run failed solely because an earlier recoverable tool failed. |
| `src/renderer/utils/task-event-derived.ts` | Centralizes normalization, visibility, pairing, groups, and status. Live mode bounds the raw window to 160 events. Group ID starts from the first retained event. | Separate compact presentation from inspectable action history; preserve correlation, group identity, and disclosure through window movement and history prepends. |
| `src/renderer/components/MainContent/task-feed-logic.ts` | Live mode reduces visible outer rows; delivery mode primarily selects final messages, outputs, and critical events. | Keep historical groups reachable and retain an expandable run activity entry in delivery mode. Expanding history must not require Verbose-on. |
| `src/renderer/components/timeline/StepFeed.tsx` | Has controlled independent detail expansion and an animated disclosure. | Reuse for compact action rows; current-only animation and quieter completed indicators. Preserve typed output viewers. |
| `src/renderer/components/timeline/VirtualizedActivityList.tsx` | Bounded viewport, virtualization above 60 children, bottom following, and new-activity control already exist. | Preserve them; fix initial/reopen anchoring for historical inspection and use stable action keys for measurements when prepending. Avoid eagerly building expensive hidden detail trees. |
| `src/renderer/components/timeline/AnimatedDisclosure.tsx` | Supports cancellation, reduced motion, and replay. | Verify focus/inert behavior during closing and layout anchoring; reuse rather than add another animation framework. |
| `src/renderer/components/TaskStatusStrip.tsx` | Separate plan/status drawer also displays latest activity. | Retain its role while removing repeated live activity narration in minimal mode. Plan navigation must reveal a hidden target group, then scroll to it. |
| `src/renderer/components/MainContent/main-content.css` | Multiple existing overrides style group headers, rules, activity lists, and reduced motion. | Scope the new appearance to the minimal variant, avoiding another unscoped override that changes Verbose-on. |

No new backend event stream or database migration is expected. Extend renderer-facing models only where existing normalized events do not express the needed state. Prefer canonical turn/group IDs when present; legacy fallback identity must survive paging and truncation through the task surface cache.

Opening a group must reconstruct its user-facing actions from retained/paged normalized history, including actions normally excluded from compact presentation. Continue redacting sensitive payloads and excluding internal diagnostics; “all actions” means the complete user-facing action history, not raw telemetry.

## Delivery sequence

1. **Projection and fixtures.** Define a shared compact header view model: group/run identity, primary label, optional phase label, icon, current action ID, execution state, and historical summary. Add deterministic traces for public progress → read → result → command → result → commentary, plus connector-only and parallel work. Verify legacy/v2 pairing and paging identity.
2. **Disclosure policy.** Add the summary-mode collapsed default across the resolver, toggles, height estimates, and memo signatures. Confirm a first click opens, subsequent events preserve explicit intent, and switching tasks restores the correct state.
3. **Minimal presentation and motion.** Implement the `ActionBlock` variant and current-row indication with scoped CSS. Keep existing output panels behind independent action disclosure. Ensure command/terminal output does not leak outside a collapsed group through separate output-rendering paths.
4. **History, delivery, and shared surfaces.** Wire expansion to inspectable/paged actions. Preserve anchors across prepends, nested detail changes, and outer virtualization. Keep completed-run history reachable. Apply to normal sessions, bot/task surfaces that use the feed, and read-only remote/replay views. Align TaskStatusStrip navigation and duplicated labels.
5. **Validation and visual tuning.** Compare a deterministic running-task fixture with the recording, at narrow and wide widths in light/dark themes. Verify actual Electron behavior before claiming parity. Run focused regression tests and relevant renderer/type/format gates.

Do not change execution, approval policy, event persistence, provider behavior, or task success semantics as part of this presentation change.

## Acceptance and validation

| Scenario | Required result |
| --- | --- |
| 30 sequential actions, default summary view | One current activity label; no accumulating action cards or output panels. |
| Expand while running | Previously completed actions and current action are reachable; each call/result pair is one action. |
| Collapse while new events arrive | Stays collapsed; label continues updating in place. |
| Open a command detail | Command/output/status appear inline; sibling details remain closed. |
| Scroll into older actions while streaming | No jump to bottom; new-activity affordance works; detail selection remains stable. |
| More than 160 events and older-page loading | Earlier actions remain accessible; IDs, expansion, and scroll anchors survive. |
| Parallel tools and delayed outcomes | Older completions do not hijack the current label or close another tool's running state. |
| New commentary/run and task switching | Historical groups remain static; new groups default collapsed; cached state never leaks between tasks. |
| Approval/input/error | Required action is visible without opening history; resolved requests stay resolved. |
| Stop/pause/failure/completion | Shimmer stops immediately; correct outcome and duration remain; history stays inspectable. |
| Final delivery | Final answer/artifacts remain prominent and all run actions are reachable without Verbose-on. |
| Reduced motion, keyboard, replay | Static indicators, working disclosures/focus, no replay autoplay or forced scrolling. |
| Verbose-on | Existing detailed behavior and tooling remain available. |

Extend the existing focused tests:

- `src/renderer/utils/__tests__/disclosure-state.test.ts`
- `src/renderer/utils/__tests__/task-status-projection.test.ts`
- `src/renderer/utils/__tests__/task-event-derived.test.ts`
- `src/renderer/components/__tests__/main-content-working-state.test.ts`
- `src/renderer/components/timeline/__tests__/action-block-header-labels.test.ts`
- `src/renderer/components/timeline/__tests__/action-block-summary.test.ts`
- `src/renderer/components/timeline/__tests__/step-feed-ux-snapshot.test.ts`
- `src/renderer/components/__tests__/task-status-strip.test.ts`

Add interaction coverage for live event arrival during collapse/expand, scroll anchoring with nested output, and lifecycle animation shutdown; static snapshots alone cannot establish those behaviors. Run `npm run qa:renderer-perf`, `npm run build:react`, `npm run type-check`, scoped formatting, and `git diff --check` after implementation. Use Node 24 or newer. Compare unrelated failures with the existing dirty baseline.

This study creates only this plan. Runtime checks, implementation, and visual parity validation remain future work.
