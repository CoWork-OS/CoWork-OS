# Bot implementation completion audit

The goal is to finish all nine changes in the 5 October 2026 plan. This file tracks
current evidence; no unchecked item is covered by a narrower passing test.

| Delivery                               | Status (stage 96)                                                                                                                                                                                  | Still requires the user                                         |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1. Generic lifecycle and compatibility | Implemented. Combined acceptance and the previous-release upgrade run preserve arbitrary, renamed, deactivated and legacy-roster bots, teams and revoked membership; startup creates no user bots. | —                                                               |
| 2. Shared work query                   | Implemented. Combined acceptance covers assigned/delegated rows, cross-bot cursor rejection, workspace exclusion and read-only opening.                                                            | —                                                               |
| 3. Work UI                             | Implemented. Rendered browser fixtures and the hidden-window desktop runs pass.                                                                                                                    | Packaged-app multi-window/profile switch check                  |
| 4. Shared automation lifecycle         | Implemented. Node and desktop runtimes report capabilities; reviewed Act effects are blocked before dispatch on headless runtimes.                                                                 | —                                                               |
| 5. Durable dispatch/recovery           | Implemented. SIGKILL after reservation, after task commit, during an approval wait and during a provider response recover without duplicate dispatch or effect.                                    | Live provider/channel crash checks                              |
| 6. Responsibility setup and policy     | Implemented for the supported adapters; other sources/actions are reported as blockers, as the plan requires.                                                                                     | —                                                               |
| 7. Controls, results, and memory       | Implemented. Result cards show the reviewed output revision; delivery history has a 90-day retention policy; outcome metrics baseline exists.                                                    | Real-model memory run                                           |
| 8. Slack decisions                     | Implemented and fixture-tested; legacy chat buttons now also bind the displayed revision.                                                                                                         | Authenticated delivery to an authorized test Slack workspace    |
| 9. Teams decisions                     | Implemented and fixture-tested.                                                                                                                                                                    | Authenticated delivery to an authorized test Teams tenant       |

Stages 91–96 (end of this file) close the remaining code work and run the plan's
final acceptance in one isolated profile. Everything that can be proven locally is
proven. What remains needs things a local run cannot supply: authenticated Slack
and Teams test destinations, a real model provider, remote CI on a pushed branch
and a packaged desktop build. Earlier stages below are kept as the historical record;
their "remaining" notes are superseded by this table.

The next lifecycle increment adds `automation.runtime.status` under existing read
scope and reports uninitialized services separately from running ones. Node and
Electron headless use the existing persistent trigger, heartbeat and routine
engines; connector event conversion is shared with desktop. Routine recovery and
claimed events drain before storage closes; immediate trigger dispatch and its
history/post-fire receipt also participate in shutdown. A failed partial-start
cleanup prevents restart until cleanup succeeds.

Local validation passed 121 tests across 11 suites, Electron and Node builds,
renderer TypeScript checking, and the async-SQLite lint gate. Scoped Oxlint
reported existing warnings and no errors.

The disposable Node acceptance command is `npm run build:daemon` followed by
`node scripts/qa/bot-automation-runtime-smoke.mjs`. It uses a temporary profile,
excludes ambient provider credentials, tests authenticated status and unauthenticated
denial twice, preserves a deactivated arbitrary custom bot, and verifies zero
startup tasks. It does not run a model, deliver a channel message, prove competing
scheduler ownership, or validate every mailbox/webhook/GUI execution capability.

Scheduler ownership now uses a persistent profile lease and monotonic generation.
Only the owner starts registered producers; renewal failure parks them, and clean
shutdown releases ownership. Budget reservations capture their original generation;
atomic task creation rejects stale reservations or admission fences and strips
internal fields from reusable execution configuration. Cron keeps its legacy
budget semantics while new task admission is fenced. Selected follow-up and channel
callbacks recheck ownership, but that preflight is not a delivery receipt or an
atomic remote-effect guarantee.

The reservation race command now also runs two actual worker connections competing
for scheduler ownership, then passes the winning reservation through the real task
store. It requires exactly one persisted task and a committed reservation.
These fixtures do not prove producer-wide canonical event identities, every
scheduler JSON-store mutation boundary, remote delivery reconciliation, or the
final isolated responsibility/approval/artifact acceptance.

The fencing increment passed 122 focused tests across 11 suites, type checking,
Electron/Node builds, and the async-SQLite lint gate. The updated worker race
persisted exactly one real task; the disposable authenticated Node restart
fixture passed again with ownership enabled and the custom bot preserved.
Scoped Oxlint reported existing warnings and no errors. These are local proofs.

Scheduler takeover now reclaims only older-generation, fenced reservations that
remain reserved with no task linkage. The new generation and recovery commit
in one transaction; stale writers cannot redeem those tickets. Committed work
and legacy unfenced reservations retain their budget charges. Live renewal and
refused takeover leave current reservations intact.

The recovery increment passed 23 tests across three suites, including database
reopen after interruption, preserved committed/legacy charges, and stale writer
rejection. Electron/Node builds, type checking, async-SQLite lint, the real worker
race, and authenticated disposable Node restart fixture passed. This proves
reservation recovery, not remote action reconciliation or producer-wide identities.

Responsibility storage now binds a stable bot/workspace ID to one existing paused
routine or event trigger. Definitions capture selected sources, permitted actions,
expected output, review boundary, destination, backend, context, and budget. Creation
and editing never enable an engine or create a task. Revisions remain immutable;
concurrent edits require the current revision, and an engine binding cannot move.
Foreign engines/contexts, inactive bots, enabled engines and undeclared fields are
rejected. The services-domain facade supports the existing async database worker.

The exact connector policy evaluator denies unknown methods/resources, unselected
reads, Observe/Propose effects, changed revisions, paused bindings and revoked
current permissions. Act requires an exact selected action and review outside its
grant. This evaluator is not yet wired into tool execution; this storage increment
does not claim responsibility enforcement or expose an activation API. Editor,
next-run preview, action/approval integration and scoped execution remain pending.

The storage/policy increment passed 34 tests across four suites, including a
representative prior-profile schema upgrade preserving the persisted private bot
row, database reopen, concurrent revisions, and scheduler/reservation regressions.
Electron/Node builds, type checking and lint gates were run locally.

Paused responsibility bindings are now enforced at routine task dispatch,
deterministic workflow start and each delegated workflow action (including
recovery), and before trigger interception/actions. New routine task configuration
carries engine lineage; the task writer checks its binding in the admission
transaction. Removing/deactivating a bot does not make its still-bound engine
become ungoverned legacy work. Existing unbound routines/tasks remain executable.

Cron execution in both production entrypoints checks current ownership and its
routine binding before source resolution or task creation. Direct and queued
channel delivery recheck independently, including after an admitted run. Admission
denial sends no error message; blocked outbox entries remain queued without
spending a transport retry or claiming delivery. Job-to-routine lookup uses the
persisted managed cron reference, including older job payloads without new lineage.

The boundary increment passed 134 tests across eight suites, Electron/Node builds,
type checking and async-SQLite lint. Scoped Oxlint reported existing warnings and
no errors. The actual worker reservation/task race passed. These checks prove the
paused boundary; they do not prove active Observe/Propose/Act execution, immutable
revision capture on runs, backend/source capability coverage, live delivery, or
remote action intent reconciliation. Activation remains unavailable until those
execution policy paths are connected.

Responsibility definitions now have shared list, engine-choice, preview, create and
revision APIs in desktop IPC and both Control Plane entrypoints. Read/write scope
checks precede work. Preview uses persisted engine configuration; bounded workers
compute schedule candidates off the app event loop. The worker is explicitly
included in the Node build. Preview reports backend presence and a hypothetical
next time separately from execution; save creates only a paused definition.

The Scheduled view now includes a scoped responsibility editor. It captures
objective, mode, backend, context, exact selected sources/actions, output, review,
destination and budget. Preview displays the concrete draft. Draft changes and
late preview responses invalidate saving. Saved revisions use compare-and-set;
failed saves preserve the draft and error. Refresh returns to current saved state.
Two definitions retain independent engines and revision histories. No private
bot names are seeded or standardized.

This increment passed 144 focused tests across 11 suites, Electron/Node builds,
type checking, async-SQLite lint and scoped Oxlint. A real compiled schedule worker
returned the expected next interval. The authenticated disposable Node fixture
exercised all five APIs, saved two paused definitions, rejected a stale revision,
and reopened the same definitions across restart while creating zero tasks and
preserving a deactivated private bot. It runs no model and sends no channel message.

The actual editor was inspected in a synthetic browser fixture: create two
responsibilities, revise one, reject a failed save, invalidate changed and delayed
previews, switch bot scope while previewing, restore keyboard focus, and inspect
390-pixel layout without document overflow. This is UI fixture evidence, not
live desktop or provider acceptance. Active execution policy, immutable run
revision capture, inline engine creation/schedule editing, controls/results/memory,
Slack/Teams decisions and the final isolated acceptance remain incomplete.

Task admission now captures a typed responsibility run reference (bot, workspace,
engine and immutable definition revision). A separate durable task receipt retains
that lineage even if mutable task settings are later changed. Delegated tasks
inherit the same reference; replacement or cross-workspace admission fails.
Admission checks binding state and bot availability in the writer transaction,
assigns the owning bot where needed, and caps persisted token/cost budgets. Zero
cost remains zero when stored and read back. Budget enforcement during model
execution still needs final acceptance.

The tool registry checks persisted run/ancestor lineage before both registered
and legacy handlers, and again after its policy/approval pipeline. Runtime flags
cannot bypass this check. Pauses, bot deactivation, mismatched scope and changed
revisions block the next tool. Native workspace file adapters use exact method
and normalized resource identity: selected read_file/list_directory reads and
selected write_file actions. Unknown methods have no adapter and are denied.
File access checks the resolved path; writes recheck after mutation preparation
and before content mutation. Existing workspace permissions still apply.
Observe/Propose writes are denied; Act requires its exact selected grant, while
review-required effects remain blocked pending the approval integration.

The paused-only responsibility schema is upgraded transactionally to support a
future active state, preserving definition IDs and immutable revisions. Editing
returns the binding to paused. At that increment there was no public activation API: legacy
routine/trigger/workflow admission stayed paused until supported execution paths,
connector capabilities and review handling are connected.

This increment passed 108 tests across eight suites, including the production
tool entrypoint, immutable receipt retention, delegated scope, unknown methods,
selected reads, denied Observe/Propose writes, exact Act grants, pause during native
write preparation with the original file intact, and the prior paused-only schema
upgrade. Electron/Node builds, type checking and async-SQLite lint passed. Scoped
Oxlint reported existing warnings and no errors. The actual worker reservation
race passed; the authenticated disposable Node daemon reopened two preserved
responsibilities after upgrading the previous schema and created zero tasks.
Test-only activation is confined to disposable fixtures. No live governed model
run, connected-app effect, channel delivery or full-plan completion is claimed.

The next increment connects Activate, Pause responsibility and Run now through
shared IPC and authenticated Node/Electron Control Plane methods. Activation is
limited to routines with a workspace task target, internal output, a manual
trigger and trusted native file or cached channel-history adapters. Selected
channel history requires an enabled channel and an exact chat ID; the native
handler checks persisted scope again before reading cached messages. Unknown
adapters, deterministic workflows, remote targets, thread follow-ups, external
outputs and review-required effects report blockers. At that increment, signal-aware schedule/event
admission was not connected and scheduled activation remained blocked.

State changes use scoped revision/control compare-and-swap with the scheduler
lease checked inside the writer transaction. Each activation, pause or revision
advances a durable control version. Pausing revokes older task references;
reactivation cannot revive them. This is responsibility pause, not a claim that
a running task has stopped or that separate future-run pause is complete.
Failed engine synchronization rolls activation back to a new paused control
version. Task starts recheck persisted policy before queue/provider execution.

Manual runs reuse the existing TaskAdmissionService and durable receipts with
an operation key incorporating responsibility, revision, control version and
request ID. A repeated request returns the same task rather than creating another.
The owning bot, exact tool allowlist and budget caps are captured at admission;
a trusted objective/mode/source/action brief is added without rewriting private
bot instructions. Explicit zero cost caps are enforced by the guardrail manager.

This increment passed 128 tests across fourteen focused and compatibility suites, including real task
and receipt storage, same-key retry, old-run revocation, failed activation
rollback, expired scheduler ownership, competing service controls, native exact
chat history reads and current channel availability. Electron/Node/renderer
builds, type checking and async-SQLite lint passed. Scoped Oxlint reported existing
warnings and no errors. The authenticated compiled Node daemon activated and
paused a disposable responsibility, created no tasks, and preserved its control
version across restart and the prior paused-only schema upgrade. Shutdown now
drains the outstanding policy lookup before releasing startup dependencies and
returns its queue slot if shutdown arrives during that lookup. The UI fixture
verified active/paused controls, safe retry after a lost reply, focus restoration,
and a narrow dialog with no horizontal overflow. These checks do not prove live
model execution, connected-app effects, channel delivery or full-plan completion.

Scheduled responsibilities now sample selected native file/directory sources and
exact cached chat history before task admission. Missing or initially empty sources
remain quiet; unchanged sources create no task or model run. Current workspace
and access-profile permissions apply before reads, and source size/count limits
fail closed. Unselected chat context and external scheduled delivery are blocked.
Cron updates now persist context and task-policy changes. Event ingestion, remote
outputs and approval-required effects remain incomplete.

A source cursor and immutable signal receipt commit in the same transaction as
the task. Competing admissions roll back duplicates; changed stale proposals must
resample. A sequence permits A-to-B-to-A changes, and deleting a task does not erase
the last consumed source fingerprint. The cursor records admission, not successful
completion; failed-task retry/recovery acceptance is still outstanding. Internal
signal proposals are removed from reusable task configuration.

This increment passed 140 tests across eleven suites, Electron/Node builds, type
checking and async-SQLite lint. A race using two independent SQLite worker
connections admitted exactly one task. The compiled Node scheduler stayed quiet
across two actual restarts with zero tasks and private bot instructions preserved.
The authenticated five-producer runtime/restart/schema-upgrade fixture also passed.
These disposable fixtures do not prove live model execution, external effects,
channel delivery, the full recovery plan or final isolated acceptance.

Selected channel-event routines now admit responsibility work through the same
bounded source sampler and durable cursor as schedules. A gateway event must
match an exact selected channel/history chat, and the current routine mapping,
workspace, task target, channel availability and access profile are checked before
admission. Broadening legacy conditions cannot ingest an unrelated chat, and
removing a managed route cannot downgrade a governed trigger to legacy ingestion.
Unknown event sources and effect/remote targets remain blocked.

Event fields are not substituted into governed task instructions. The saved
routine brief and immutable responsibility reference direct the task to read its
selected sources under existing native scope enforcement. Concurrent event replay
admits one task; unchanged cache after a service restart stays quiet. Pause during
admission rolls back the task and cursor. Admission failure retains the prior
cursor so a later event can retry.

This increment passed 64 tests across eight focused and compatibility suites,
Electron/Node builds, type checking and async-SQLite lint. The compiled Node event
fixture proved an empty-source quiet check, concurrent replay, trigger-service
restart replay and changed-source admission with private bot instructions intact.
This is a disposable cached-source fixture, not a live authenticated gateway
conversation, model run or channel delivery. Other connector/mailbox/webhook event
adapters, approvals, controls, memory and full-plan acceptance remain incomplete.

Future-run pause/resume is now separate from responsibility revocation. It persists
a control version and an exact-request receipt without advancing the execution
control epoch or changing existing run scope. The receipt lists unfinished work
from durable responsibility lineage in the selected workspace. Writer admission
blocks new roots while existing tasks and their scoped delegation may continue.
Cron/event checks skip paused future work without reporting a failure. Resume
does not alter approvals or consumed source cursors. Responsibility revocation
continues to revoke earlier run references.

Shared IPC and write-scoped Node/Electron Control Plane expose the same operation.
The UI offers Pause/Resume future runs, keeps ambiguous retry identity, disables
manual admission while paused, and labels revocation separately. A synthetic UI
fixture verified lost-reply retry, pause/resume, focus restoration and a narrow
layout without horizontal overflow.

This increment passed 74 tests across eight suites, Electron/Node builds, type
checking and async-SQLite lint. The compiled authenticated Node fixture persisted
future pause across two restart cycles and the earlier paused-only schema upgrade,
replayed the same receipt and created no tasks. Existing-task preservation was
verified through real task storage and native scope policy tests, not a live model.
Stopping turns/bot work, bot-level pause fanout, full control crash recovery,
evidence/notifications/memory, channel approvals and final acceptance remain
incomplete.

Scoped work-control APIs now persist a stop intent and immutable task selection
before cleanup. Stop-turn selects local descendants; stop-bot selects unfinished
work and terminal tasks with active runtime work. Foreign-workspace descendants
and unrelated bots are excluded. Native cancellation waits for executor idle and
background cleanup before confirming a stop; unfinished graph work remains
explicitly unresolved. New tools, follow-ups, descendants and graph dispatches
check the persisted intent. Exact-version release permits a later explicit
follow-up after cleanup without starting a task or releasing old children.

Receipts survive restart, retain request identity and expose pending/failed
cleanup separately from confirmed stops. A failed old request cannot cancel a
released or newer turn. A deadline returns pending while cleanup continues;
retries retain the original selection. These APIs are exposed through desktop IPC
and read/write-scoped Node/Electron Control Plane.

This increment passed 54 tests across seven suites, Electron/Node builds, type
checking and async-SQLite lint. Scoped Oxlint reported existing warnings and no
errors. Authenticated disposable Node fixtures proved an actual paused task was
cancelled, receipt read/replay persisted across restart and an earlier schema
upgrade, and custom bot instructions were preserved. Empty-work controls also
passed with no startup tasks. No live provider turn or external delivery was run.
Stop UI, bot-level stop-and-pause fanout, scoped graph cleanup, automatic startup
control draining and the remaining full-plan acceptance are still outstanding.

Pending stop cleanup now has an owned recovery lifecycle in desktop, Electron
headless and Node runtimes. Startup drains saved current stop intents before
producers start; a bounded periodic sweep retries unresolved cleanup without
selecting new tasks. Ownership loss parks recovery and takeover restarts it.
Shutdown drains its work before releasing ownership or closing storage. Receipt
updates remain possible after a bot is removed from active use. Released or
superseded stop versions are excluded from the recovery scan.

The recovery increment passed 32 tests across four suites, Electron/Node builds,
type checking and async-SQLite lint. The compiled authenticated Node fixture
started from a task and saved stop receipt, confirmed cleanup before any stop API
retry, then preserved the receipt across restart and the earlier schema upgrade.
This proves startup recovery of a persisted paused task, not forced process death
during a live provider turn or external-action reconciliation. Full control crash
acceptance, scoped graph cancellation, UI/fanout, approvals, notifications/memory
and final plan acceptance remain outstanding.

Stop-control writers now carry the scheduler generation captured before asynchronous
cleanup. Stop selection, release and receipt updates validate it inside their
SQLite transaction. Scoped native cancellation also validates its saved selection,
workspace, stop version and scheduler generation in the same transaction as the
canonical terminal task write. A stale process cannot downgrade the new owner's
confirmed receipt or persist a late cancellation after takeover. Public request
payloads do not grant or accept this internal authority.

The fencing increment passed 43 tests across five focused suites, including two
independent database connections and delayed native cleanup, plus Electron/Node
builds, type checking and async-SQLite lint. These proofs cover stop-control
persistence; they do not prove all scheduler JSON/store mutation boundaries,
interrupted live-provider behavior, remote reconciliation or full-plan acceptance.

The desktop Work dialog now exposes Stop turn, Stop active bot work, cleanup
checks/retry and exact-version follow-up release. Pending and failed cleanup
remain distinct from confirmed stops. Request identity survives dialog reopen
within the renderer session; a stale reply cannot overwrite a reopened dialog or
another bot's state. Releasing one stopped turn retains other confirmed turns.
Future-run controls remain in Scheduled. Unsupported browser/runtime controls are
disabled rather than assuming a new remote permission grant.

Eight controller/loader tests passed, along with renderer build and type checking.
A rendered synthetic fixture verified lost reply/retry, pending/failed/confirmed
cleanup, release, scope switching and dialog reopen. A 368-pixel-wide dialog had
no horizontal overflow. This is UI evidence, not a live provider cancellation.
Complete browser-host parity,
bot-level stop-and-pause, scoped graph cleanup, active-provider crash acceptance,
approvals, evidence/notifications/memory and full-plan acceptance remain pending.

Renderer stop-control identity now persists before the API call in a versioned,
workspace/bot-scoped local cache. Reload reads that identity and checks the durable
server receipt; cached data is never treated as cleanup confirmation. The cache
contains only IDs and exact stop versions, excludes bot instructions, task text
and error details, validates its shape/scope and bounds its size. A denied/quota
write prevents a new control from being sent. If saving a known response fails,
confirmed cleanup stays truthful and a separate recovery warning is shown.

Fourteen tests across cache/controller/loader suites passed, including controller
module reload after a lost reply, read-only reconciliation without redispatch,
foreign/corrupt/oversized cache rejection and quota failures before/after the API.
A rendered synthetic fixture also retained an unconfirmed stop after a real page
reload and offered the saved retry without claiming cleanup. Renderer build and
type checking also passed. This proves scoped renderer cache
recovery in fixtures, not a packaged app crash with an active provider or every
multi-window/profile transition. Full isolated acceptance and remaining delivery
requirements are still pending.

Local graph work now participates in scoped stop receipts. The stop transaction
selects same-workspace graph-linked tasks (including unparented delegated work),
closes graph admission, and cancels undispatched nodes. After native task cleanup
is confirmed, a fenced writer reconciles the linked nodes. Remote identities,
foreign-workspace tasks and unknown dispatch outcomes remain unresolved; receipts
retain the root as active until graph cleanup is confirmed.

Graph task creation and its node identity now commit in one task-writer transaction.
An admitted task is included in the stop snapshot; a stop that commits first rejects
admission without an orphan task. Late dispatch callbacks preserve confirmed
terminal nodes and do not invoke the legacy broad graph cancellation path for a
managed stop. Terminal roots with unresolved graphs remain discoverable for stop.

The increment passed 72 tests across eight suites, Electron/Node builds, TypeScript
and async-SQLite lint, and scoped Oxlint with no errors. Focused tests cover both real graph-engine dispatch
race orderings, rollback after a failed node link, stale claims/fences, local graph
cleanup and unresolved remote/foreign work. The authenticated disposable Node
fixture (`--graph-work-control --work-control-recovery`) stopped a paused root and
unparented linked task during startup recovery, cancelled undispatched graph work,
and passed restart/schema upgrade with private bot data preserved. These tests do
not prove active-provider cancellation, remote cleanup, multiwindow behavior,
channel delivery or the full isolated-profile acceptance.

Bot-level future pause now persists by immutable bot/workspace identity and applies
as a shared admission veto across current and later responsibility bindings. It
also blocks new assigned task roots in the task writer, including unkeyed Node and
Electron Control Plane creation; assignment is captured before insertion. Existing
admitted work and delegated continuations retain their execution policy. Independent
responsibility pauses survive bot resume. Heartbeat pulse admission rechecks pause
inside its durable writer transaction; paused pulses remain quiet before reflection,
Dreaming or advisory/model work.

`pause_bot`, exact-version `resume_bot` and `stop_and_pause` use the scoped durable
control API. Combined stop-and-pause records both admission pause and selected stop
intents in one fenced transaction, with immutable request replay and affected
responsibility/work identifiers. Resume does not start work or resolve approvals.
The Work dialog exposes all three controls and shows future-run state separately
from cleanup. Ambiguous identities survive reload; a newer stored future-control
version fences out an old resume without allowing it to clear a newer pause.

Local validation passed 130 tests across eleven suites, Electron/Node and renderer
builds, TypeScript, async-SQLite lint and scoped Oxlint with no errors. The tests
include transactional rollback, scoped isolation, a heartbeat preflight/admission
race and independent pause preservation. The authenticated disposable Node command
adds `--bot-future-control` to the graph/recovery fixture and checks denied root
admission, exact receipt replay, stale resume denial and pause persistence through
restart/schema upgrade. A rendered synthetic Work dialog verified pause/resume,
pending and confirmed combined cleanup, another-bot isolation and narrow layout.
Live active-provider, packaged desktop, multiwindow, remote graph and final complete
responsibility/artifact/channel acceptance remain unproved.

## Stage 22: scoped result evidence

The Results view now exposes the exact work item's current saved outcome contract,
requirement checks, bounded provenance entries, and latest artifact revisions.
`bot.work.result` uses the existing read scope in both Node and Electron. It follows
same-workspace visible bot lineage, including local graph-linked delegation, and
rejects archived, side-chat, foreign-bot and foreign-workspace work. Canonical
session binding and exact task IDs prevent unrelated contracts or artifacts from
leaking through a shared session. The read makes no session or evidence repairs.
Private prompts, task policy, evidence source references and snippets are omitted.

Artifact inspection runs in a dedicated worker with a five-second deadline, at
most 24 files and a four-MiB limit per file. It uses the current effective filesystem
read policy, canonical workspace containment, symlink rejection and regular-file
identity checks before and after hashing. It distinguishes matching bytes, changed
files, missing files, unavailable checks and non-current revisions. The API
rechecks task scope, stored metadata and current policy after the worker returns.
Only fresh linked evidence for the exact selected revision can confirm a declared
file-existence requirement. Other saved requirement statuses remain recorded
checks; a matching hash does not establish content quality. Delivery remains
unknown until an exact transport receipt can be joined.

The renderer clears prior proof during refresh, rejects foreign and late replies,
and reloads on task/scope changes. A rendered test caught and fixed a subscription
loss on evidence collapse/reopening. Synthetic UI inspection covered loading,
changed-file refresh, read failure, bot change, narrow hash wrapping and navigation
to the selected work item. It did not run against the user's live bots/profile.

Validation: 33 focused tests across five suites passed in the implementation
worktree; Electron, Node and renderer builds, type checking and async-SQLite lint
passed. The disposable authenticated Node fixture was extended with
`--result-evidence`; across two runtime restarts, actual report-worker storage and
artifact-worker hashing distinguished matching, changed and missing files,
rejected unauthenticated and foreign-bot reads, and retained recorded PASS and
unknown delivery. No model or external channel message was run. This stage does
not finish notification routing/digests, Memory Hub correction provenance,
Slack/Teams decision adapters, remote cleanup or final isolated-profile acceptance.

Primary integration verification: the same 33 focused tests passed after integration,
along with Electron, Node and renderer builds, type checking and async-SQLite lint.
Scoped Oxlint reported warnings and no errors. The authenticated Node fixture with
`--graph-work-control --work-control-recovery --bot-future-control --result-evidence`
passed both restart cycles against the primary build. All 24 integrated source/doc
paths matched the worktree; 4,478 unrelated paths and the Git index were preserved.
Remote CI, packaged Electron, real-provider execution and external delivery remain
unverified. The full goal remains active.

## Stage 23: scoped notification routing and durable inbox receipts

The bot Work view's Scheduled tab now has workspace-scoped notification options:
app inbox or inbox plus a desktop alert, quiet hours with an explicit IANA timezone,
and result/failure digest intervals. Existing global finish/input toggles remain
authoritative. Failures are included; decisions bypass digest batching but respect
quiet hours. New routes default off, retaining the old behavior until the user opts
in. Bot identity, prompts and existing preferences are not rewritten.

Strict scoped APIs read/update routes and list up to 100 durable receipts. Route
updates use an immutable request UUID and expected version; exact retries replay
the saved response, mismatched reuse and stale updates fail. A route change cancels
queued deliveries rather than silently rerouting them. The panel validates timezone
and times, preserves an ambiguous save request for retry, reloads after a known
version conflict and suppresses stale reads. Channel destinations are rejected;
external routing still requires the planned destination/decision authority.

A shared owned recovery service observes durable assigned task state on Node and
Electron, in bounded batches, without relying on a visible renderer. It records
identities for concrete pending approvals/input requests, meaningful results and
failures, excludes archived/side-chat/inactive-bot work, and suppresses nonactionable
known automation outcomes. It does not send progress notices or unchanged heartbeat
updates. Older terminal history is excluded by route activation time. Signature
checks include pending request identities, avoiding lost decisions when only a
request row changes. Digest cohorts keep bot, workspace, route revision and due
window separate; every member's current scope is checked before it is claimed.

Queue discovery, claims and receipts require the current scheduler fencing token.
The observer rechecks current policy/task scope before file persistence and before
publishing a notification event. Quiet scheduling uses the chosen timezone's DST
rules, with bounded/cached clock work. Delivery claims are persisted before effects.
Stable inbox identities survive restart and keep distinct decisions separate.
Failed durable writes publish no event and add no in-memory item. Interrupted claims
are reconciled against a present inbox identity; otherwise they remain delivery
unknown and are not automatically resent. Receipts say stored in inbox separately
from desktop requested/unavailable. Neither is proof that a user saw a popup or
that an external artifact was delivered. Headless Node stores an inbox item and
reports desktop unavailable. Old renderer input and cron completion paths defer to
an opted-in route to avoid duplicate notices.

Worktree verification: 43 tests across seven suites passed, covering scoped CAS,
quiet-hour DST boundaries, concrete decisions, digest member reassignment, policy
rechecks, ownership loss, interrupted effects, stable identities and existing
notification/browser/lifecycle behavior. Electron, Node and renderer builds,
type checking and async-SQLite lint passed during development; scoped Oxlint had
warnings and no errors. A disposable authenticated Node fixture with
`--bot-notifications` saved a route, rejected unauthenticated reads, recorded a
synthetic result, produced exactly one inbox item/receipt and retained it across
two restarts. Synthetic rendered inspection covered quiet/digest editing, lost
save-reply retry, private-bot scope changes and narrow themed controls. No live
user bot/profile, model, desktop popup or external channel was exercised.

Still required: explicit retry/retention handling for unknown notifications,
concurrent profile notification-file mutation acceptance, live desktop acceptance,
reviewed external destinations and transport receipts, Memory Hub provenance and
correction proof, the remaining dispatch/policy adapters and Slack/Teams decisions.
These local checks do not complete the nine-delivery goal.

Primary integration verification: 43 tests across seven suites passed on the
integrated source, along with Electron, Node and renderer builds, type checking,
async-SQLite lint and scoped diff checks. Scoped Oxlint had warnings and no errors.
The authenticated native fixture with all previous controls/result flags plus
`--bot-notifications` passed both restart cycles against the primary build. All
26 integrated paths matched the worktree; 4,483 unrelated paths and the Git index
were preserved. No remote CI, packaged runtime, live desktop notification, model
execution or channel delivery was claimed.

## Stage 24: canonical profile inbox and concurrent delivery recovery

The Node and Electron notification services now share SQLite as their authoritative
inbox. Existing JSON notices are imported once without rewriting the legacy file.
The service keeps its public inbox behavior and refreshes database state before
IPC/browser reads. Mutations operate on current rows instead of writing a cached
whole-file snapshot, so another process's additions, reads and deletions survive.
The async service units run through the existing database worker boundary.

Bot delivery checks scheduler ownership, claim state, bot/workspace identity,
route revision, current task policy and pending decision inside the same writer
transaction as the inbox insert. The stable identity includes an immutable scope
hash; reusing it for another scope is rejected even after deletion. Up to 100
message bodies are retained. Delete/trim removes message contents and dedupe keys
while preserving minimal delivery identity metadata. Restart recovery recognizes
those identities without restoring deleted messages or emitting another alert.
An interrupted post-write publish is reconciled against committed storage.

Desktop receipts use the actual notification callback acknowledgment. Disabled
alerts and Node delivery report unavailable; requested still does not prove the
operating system displayed a popup or that a user saw it. Failed initialization
or writes fail closed and preserve the original legacy source.

Worktree validation: 47 focused tests across six suites passed, plus the lifecycle
suite. Coverage includes competing connections, one-time import, bounded bodies,
deleted-identity recovery, strict scope and fence rejection at insert, committed
write/publish interruption and desktop callback acknowledgment. Electron, Node
and renderer builds, type checking and async-SQLite lint passed. The new
`node scripts/qa/notification-inbox-smoke.mjs` runs two actual processes against a
disposable SQLite profile; all 71 identities survived, 60 current bodies remained
after selective deletes, read flags were correct and the legacy source was unchanged.
The authenticated bot fixture with notification/result/control flags passed both
Node restart cycles using canonical inbox rows. No live profile, model, channel
message or desktop popup was exercised.

Still required: explicit user retry/reconciliation of unknown notifications,
receipt-history retention policy, live desktop/multiwindow acceptance, external
transport receipts, Memory Hub correction provenance and the other pending
items in the nine-delivery audit. This stage does not complete the full goal.

Primary integration verification: 57 focused tests across seven suites passed,
along with Electron, Node and renderer builds, type checking and async-SQLite
lint. Scoped Oxlint reported existing warnings and no errors. The concurrent
process inbox fixture passed on the primary build, as did both authenticated
Node bot-runtime restart cycles with canonical inbox receipts. All 16 integrated
paths match the implementation worktree; 4,498 unrelated paths and the Git index
were preserved. The full goal remains active. Packaged/live desktop, real-provider
execution, remote CI and channel delivery remain unverified.

## Stage 25: explicit unknown-delivery retry

A strict workspace/bot-scoped retry API requires the exact receipt, current saved
route version and a request UUID. The writer transaction checks the unknown state
and canonical inbox identity. A stored or retired identity reconciles the receipt
without restoring its message or requesting a popup. Truly absent delivery is
requeued only under the current saved route and quiet/digest policy. Reassigned,
archived, inactive-bot work, stale results, resolved decisions, disabled routes
and suppressed outcomes cannot be retried. The original concrete source identity
is retained; no automatic resend is added.

The same transaction stores the request and immutable response. Exact retries
replay it even after receipt state changes; mismatched UUID reuse fails. Distinct
requests cannot requeue the same unknown receipt twice. Control Plane requires
write scope, and Electron uses the same service. Browser host permissions are not
expanded. The Scheduled notification panel offers Retry notification and retains
a lost-reply request UUID, freezes route edits while it is uncertain and validates
returned scope. Known policy conflicts reload current state for review.

Local worktree tests covered queueing/replay, stale route versions, changed results,
foreign bot scope, resolved approvals, reassignment, and stored retired identity
reconciliation. Synthetic rendered inspection verified lost reply followed by
exact request replay, frozen edits, a queued receipt, narrow layout and bot changes.
The fixture has no connection to the user's bots or profile. Electron, Node and
renderer builds, type checking and async-SQLite lint passed during development.
The authenticated disposable Node fixture exercised stored-identity reconciliation,
exact API replay, unauthenticated denial and mismatched reuse; the final integration
run also checks replay after daemon restart.

Receipt-history retention, multiwindow/live desktop acceptance, Memory Hub
correction provenance, remote cleanup, remaining producer/backend adapters and
Slack/Teams decisions remain open. This increment does not finish the full plan.

Primary integration verification: 62 focused tests across seven suites passed,
as did Electron, Node and renderer builds, type checking and async-SQLite lint.
Scoped Oxlint reported existing warnings and no errors. The authenticated Node
fixture passed both restart cycles, including saved retry-request replay after
restart, stored-identity reconciliation, denied unauthenticated calls and
mismatched reuse rejection. All 14 integrated paths match the worktree; 4,500
unrelated paths and the Git index were preserved. Synthetic UI checks are not
live desktop or actual-user-bot proof. No model, popup, channel delivery,
packaging, deployment or remote CI was claimed. The full goal remains active.

## Stage 26: context entry point and recorded memory provenance

Bot Work now opens Context and memory in the existing Memory Hub for its exact
workspace. The owner-facing Hub explicitly distinguishes workspace knowledge from
private context visible to the owner. Historical records without recorded bot
provenance are not assigned to whichever bot currently owns a linked task. The
view shows shared workspace context, private context or the recorded bot source,
and its date. Bot names resolve from recorded IDs; a missing/deleted bot retains
the stored ID. The raw source-ref payload remains absent from the public item.

Navigation does not write memory, create a task, enable an automation or grant
browser methods. If the requested workspace is missing, the Hub requires an
explicit selection instead of falling back to another workspace. Existing Hub
correction/forget controls remain backed by MemoryWriter and its indexes/views;
no second memory system was added. Capture-time provenance is shown where stored,
with producer-side attribution work still required where it is missing.

Focused worktree tests and the synthetic rendered Work-to-Hub flow verified
workspace focus, no invented historical ownership, recorded source names/dates,
private labels and read-only browser controls. Electron, Node and renderer builds,
type checking and async-SQLite lint were run during development. The new
`node scripts/qa/bot-memory-context-smoke.mjs` exercises compiled services against
a disposable profile. A corrected fact appears in a fresh context and indexed
recall; the cached context invalidates. Forget excludes both revisions from fresh
context, indexed recall and the derived kit-record view. A private owner fact is
excluded from group context. This is built-service proof, not a real provider run,
generated-file acceptance, or every caller/contact/audience boundary.

Still required for memory: producer capture-time bot provenance, full caller and
subject restrictions, private owner exclusion for third-party channel audiences,
app-level generated-file and fresh-model acceptance. Other nine-delivery items
remain open. The goal is not complete.

Primary integration verification: 84 focused tests across seven suites passed,
as did Electron, Node and renderer builds, type checking and async-SQLite lint.
Scoped Oxlint reported existing warnings and no errors. The compiled memory fixture
passed fresh and cached correction, indexed recall, forgotten-revision exclusion,
derived view removal and private owner exclusion from group context on the primary
build. All 14 integrated paths match the worktree; 4,502 unrelated paths and the
Git index were preserved. Browser entry additionally checks the Hub's required
methods. No live owner profile, model, external source, packaging, remote CI or
channel delivery was exercised. The full goal remains active.

Stage 27 closes the task prompt and consolidated memory-tool caller boundary. The existing
persisted gateway sender authority is reused: non-owner and legacy private channel tasks
receive no owner memory layers, owner kit or external profile. A DM shared-context flag
does not grant owner access. Local and positively identified owner DMs retain access;
existing explicit shared group prompt grants still exclude private items and owner kit.
The consolidated recall and forget tools deny non-owner and group/public callers before
reading any lane, asking for deletion approval or invoking an external service. This does
not change channel identity configuration or grant new permissions.

Focused caller/policy/tool regressions passed 270 tests across three suites in the isolated
implementation checkout. The security regression corpus records this fix and points to
its executable memory-tool tests; the generic security harness registered the case and
reported no candidates, which is not independent live-channel proof. Producer-side
capture-time provenance, low-level surface-contract audience handling, inherited caller
identity, generated files and fresh provider execution remain outstanding.

Primary validation passed 273 focused tests across four suites, Electron and Node daemon
builds, renderer type checking, scoped Oxlint and the async-SQLite lint gate. Both compiled
runtime policy modules passed owner/non-owner/legacy-DM assertions. The existing compiled
memory-services fixture passed again on a disposable profile (correction, hot-cache
invalidation, indexed recall, derived view and forgotten revisions). No provider or
channel delivery was executed. Integration preserved 4,510 unrelated paths and the Git
index; the stage patch is `bots-memory-caller-authority.patch` in the implementation
worktree parent directory.

Stage 28 records bot provenance for new live captures in the central memory-ingest
transaction. The assigned role is read from the actual task in the governing workspace;
caller-supplied attribution is replaced by that evidence. Global captures carry their
origin workspace through the validated worker unit. Existing source revisions retain
recorded provenance after task reassignment or bot deactivation. Historical/migrated
records and corrections remain unattributed when no provenance was captured originally;
no read-time backfill or personal-bot seeding occurs. A higher-trust replacement source
cannot inherit the old primary source's bot attribution. Missing legacy task tables and
foreign task/workspace IDs yield no attributed bot.

The isolated implementation checkout passed 126 tests across eight writer, Hub, privacy,
recall, context, lifecycle, worker-parity and memory-tool suites. Primary validation passed the same 126 tests, Electron/Node daemon builds, renderer
type checking, scoped Oxlint and async-SQLite lint. The expanded compiled native fixture
passed capture-time bot source, bound global origin, reassignment/deactivation/correction
preservation, historical correction without attribution and database reopen assertions.
An additional actual host/database-worker parity workload passed the new attribution
assertions on both backends. No model or channel sends were executed. Low-level surface
contracts, inherited caller identity and fresh-provider/generated-file acceptance remain
open in delivery 7. Integration preserved 4,507 unrelated paths and the Git index;
the stage patch is `bots-memory-capture-provenance.patch` in the implementation worktree
parent directory.

Stage 29 applies sender authority to the surface-based memory contracts. Unidentified or
non-owner private channels are denied by context building, item eligibility and all recall
lanes before search or ID expansion. Positively identified owner DMs retain access; group
recall remains denied. Child tasks preserve the parent gateway origin, owner evidence and
sender reference; child-provided identity cannot replace them, and shared-channel memory
cannot be enabled without a parent grant. Existing task-based shared-group prompt behavior
remains governed by its explicit grant.

The isolated checkout passed 293 tests across five policy, context, recall, child-task and
gateway-capture suites before the final shared-grant inheritance amendment. A baseline
child-task test had an obsolete single-argument expectation for TaskStore.create; the
failure was reproduced in the unchanged primary checkout and its assertion now includes
the existing optional graph-admission argument. The security regression corpus records
the caller-inheritance fix with its executable test. The generic harness registered the
case, which is not live-channel acceptance. Primary validation passed 328 tests across six suites, Electron and Node daemon builds,
renderer type checking and the async-SQLite lint gate. Scoped Oxlint reported existing
daemon warnings and no errors. The expanded compiled-service fixture passed on its
disposable profile: verified owner private-channel context and recall were admitted;
non-owner/legacy private-channel context and all-lane recall (including ID expansion)
and group expansion were denied before memory reads. Prior correction, forgetting,
provenance and database reopen assertions also passed. No live provider or channel
execution was performed. Integration preserved 4,504 unrelated paths and the Git index;
the stage patch is `bots-memory-surface-authority.patch` in the implementation worktree
parent directory. Actual provider, generated-file, final desktop and channel acceptance
remain open.

Stage 30 adds the shared durable channel-decision transport store and validated asynchronous
service facade for Slack and Teams. It binds a pending ApprovalStore request to its actual
task, originating ancestor/session, workspace, bot, exact authorized channel requester,
destination, request-content hash, current task/bot/workspace/channel policy fingerprint
and the existing five-minute approval deadline. No request text, file content, bot prompt
or channel secrets are stored in the transport payload. A publisher must claim delivery
before effects; only its delivery claim can record the sent message ID. Unknown delivery
is not automatically requeued. Callback admission checks exact actor, channel, destination,
message, adapter transport kind, current request/policy/scope, expiry and single use in
one transaction. Claiming does not itself resolve or execute an approval: ApprovalStore
and the daemon remain authoritative, and handled outcomes require persisted resolution.

This is a transport foundation, not enabled Slack/Teams decision support. The gateway,
authenticated adapter ingress, exact draft/file revision checks, atomic execution handoff,
Block Kit/Adaptive Card rendering, text fallback, policy rechecks and live test-channel
acceptance remain outstanding. The isolated SQLite guard suite passed 24 tests. Primary validation passed 79 tests across
transport, daemon approval and decision-concurrency suites, Electron/Node daemon builds,
renderer type checking, scoped Oxlint and the expanded async-SQLite lint gate. The Node
build explicitly includes the new repository facade. The compiled native fixture passed
on a disposable profile with eight actual database-worker unit calls: child-origin scope,
stored deadline, fenced publication, wrong actor and changed request rejection, single-use
claim and database restart preservation. An older database shape without the new transport
table reopened successfully while preserving its pending approval and custom bot. The
transport never resolved or executed that approval. No SDK authentication, channel send,
model run or action execution occurred. Integration preserved 4,511 unrelated paths and
the Git index; the stage patch is `bots-channel-decision-binding.patch` in the implementation
worktree parent directory.

Stage 31 makes central approval resolution conditional on the pending request's exact
persisted task, type, description, details and timestamp. Approval decisions cannot
subsequently be overwritten by a timeout or competing response. The process-local
idempotency key now covers the approval rather than separate approve/deny actions, and
the database transition selects a single winner across connections. Only a winning
transition may persist approval rules, record permission success, issue grants or resume
a task. Expired approval requests cannot win an approve transition. Local waits are
retired before awaited grant writes; a failed write rejects the wait. Authority is
rechecked after winning and task termination is checked around persistence, preventing
resurrection after cancellation. A recorded approval decision remains distinct from
successful action execution; interruption or failure after that record does not justify
replaying an action.

Both checkouts passed 89 tests across daemon approval, conditional-resolution,
storage host/worker parity and channel transport suites. The security regression corpus
records this fix with executable two-connection tests; generic harness registration is
not live execution proof. Primary Electron and daemon builds, TypeScript checks,
asynchronous SQLite checks and scoped lint passed. The compiled disposable database
fixture exercised nine worker calls and proved one winner across host/worker approval
responses, refusal to overwrite that winner and retained transport claims after restart.
No model, channel delivery or approved action was executed. Integration preserved 4,513
outside files and the Git index. Gateway/adapter rendering and authenticated handoff
remain outstanding in deliveries 8 and 9.

Stage 32 adds optional typed decision adapter methods, separate from legacy text and
inline-keyboard callbacks. Slack renders bounded plain-text Block Kit cards and accepts
only a single namespaced action from its authenticated Bolt Socket Mode callback with
matching installation team, channel, container message, actor and opaque route UUID.
A dedicated WebClient disables both SDK retries and rate-limit retries. No handler
means no card publication. Teams renders Adaptive Cards using Action.Submit for this
existing Bot Framework message-activity adapter, includes desktop fallback text, and
accepts decisions only inside CloudAdapter.process's authenticated turn callback.
Submissions must match the configured tenant and an established bot conversation
reference, include the original message ID, and remain outside the task-prompt path
when malformed. Missing reply-to identity or tenant binding fails closed.

Both adapters make one card publication call and require a returned message ID. The
installed Teams connector ignores noRetryPolicy and runs compatibility policies above
its retry pipeline: a local fixture observed four HTTP requests with those options.
A dedicated HTTP client now permits one POST for each decision publication, bounds the
response to 64 KiB and times out after 15 seconds. Installed-SDK tests prove one HTTP
request after a server error or connection reset, plus successful message-ID decoding.
Unknown publication outcomes remain the durable transport service's responsibility.

The implementation follows the [Slack block action payload specification](https://docs.slack.dev/reference/interaction-payloads/block_actions-payload/)
and [SDK retry controls](https://docs.slack.dev/tools/node-slack-sdk/web-api/), while
retaining the existing Bot Framework adapter's [Teams card action path](https://learn.microsoft.com/en-us/microsoftteams/platform/task-modules-and-cards/cards/cards-actions).
This adds adapter capabilities, not activated routes or live-channel proof. Gateway
registration, current actor authorization, exact external draft revision validation,
conversation recovery and authenticated test-channel acceptance remain outstanding.
Stage 32 passed 131 tests across adapter, card, installed connector, Teams compatibility
and durable transport suites in both checkouts. Primary Electron and daemon builds,
TypeScript checks, scoped lint and diff checks passed. Integration preserved 4,518
outside files and the Git index. No live channel or model was contacted.

Stage 33 shares one canonical approval-request revision hash between durable transport
binding and the daemon. A typed handoff can now pass the displayed request hash to
respondToApproval. The daemon refuses a changed persisted request or mismatched local
wait before starting process-local response idempotency, checks the durable snapshot
again after the handoff, and keeps a copied request snapshot through awaited permission
checks and grant persistence. The existing conditional database transition still
selects the sole winner. A stale click therefore cannot consume a subsequent valid
response or authorize newly changed request content. This request-content hash does
not prove an external draft file is unchanged; fresh draft/artifact checks remain a
separate requirement before channel activation.

Both checkouts passed 90 tests across canonical revision, daemon approval and
transport binding suites. Primary Electron and daemon builds, TypeScript and scoped
lint checks passed (existing daemon lint warnings remain). The compiled disposable
host/worker transport fixture passed with nine worker calls, atomic response and restart
checks. Integration preserved 4,523 outside files and the Git index. Gateway actor authorization must also remain current at the atomic
approval transition; adapter callback normalization alone is not authorization.

Stage 34 binds a claimed transport route to ApprovalStore resolution inside one
immediate SQLite writer transaction. Before changing the pending request, the writer
checks the claim ID/state, approval/revision, callback action, stored deadline and all
current route authority fields, including actor admission, channel config/security,
workspace policy/rules, task ancestry and active bot policy. A different action or
revocation after callback claiming leaves the approval pending. The daemon accepts this
guard only alongside the displayed request revision and forwards it to the storage
writer. This does not infer owner authority from actor admission: the gateway still
must positively authorize the configured account before publication and callback.

Both checkouts passed 104 tests across daemon approval, central conditional
resolution, transport binding and storage parity. A compiled disposable host/worker
fixture exercised 16 worker calls, refused a channel-config revocation after claiming,
resolved an unchanged guarded request and retained the separate unresolved route after
restart. Primary Electron and daemon builds, TypeScript, asynchronous SQLite lint,
scoped lint and diff checks passed (existing daemon lint warnings remain). Integration
preserved 4,522 outside files and the Git index. No channel, model or approved action
was executed. Remaining channel work includes the positively authorized gateway
service, exact external draft validation, conversation recovery and live acceptance.

Stage 35 wires the optional typed gateway path to a durable decision service. Publication
and callbacks require an enabled Slack/Teams channel, explicit decisionMessagesEnabled
config and a structurally valid configured ownerUserIds account matching the requester.
Pairing or allowlist admission alone cannot grant owner authority. Routes select the
exact registered channel adapter, stored request content and deadline; replaced adapters
and shutdown callbacks are ignored. The service forwards allow-once/deny-once, owner
account attribution, displayed request hash and claimed route into the daemon and its
atomic approval writer. Typed routes never enter the legacy in-memory approval map or
fall back to legacy commands/buttons. Unsupported typed requests direct review to CoWork.

A publication failure after taking the durable delivery claim remains unknown/fenced,
including failed receipt reads or writes, and never sends a second card or text fallback.
A response failure also retains the claim and does not replay execution. The flag is
default off and currently API/config-only; an explicit settings control remains needed.
No user's channel configuration or live bot profile was changed.

Both checkouts passed 74 tests across service, router, legacy gateway compatibility,
transport guard and adapter suites. The compiled disposable fixture exercised 26 worker
calls and the service's positive owner authorization, one synthetic card, one central
response and duplicate refusal. It did not execute a model, channel delivery or approved
action. Primary Electron and daemon builds, TypeScript, asynchronous SQLite lint,
scoped lint and diff checks passed (an existing router lint warning remains). Integration
preserved 4,525 outside files and the Git index. This wires request-content review;
exact external draft/file revision validation and full live acceptance remain incomplete.

Stage 36 corrects an automatic-review regression introduced by the conditional approval
update. Both automatic branches created status=approved and then called update(), which
now accepts pending rows only. A real ApprovalStore regression suite reproduced false
returns for successful review and permission-success effects before the rejected update.
The branches now share one flow: create pending, recheck current authority, conditionally
resolve that exact request, then recheck authority/task/signal before success or grants.
Session approve-all keeps its existing type and reviewer gates; no new automatic authority
is added. A recorded approved row still does not prove an action ran.

Seven real-SQLite regression cases cover successful normal/session review, a competing
denial, pre/post-transition authority changes, cancellation and abort before an external
grant. The isolated checkout passed 76 tests across this suite, daemon approval and
central resolution. The generic security harness registered an executable regression;
registration is not separate execution proof. Primary passed 102 tests across six suites,
including policy, assistant approval and filesystem entrypoint contracts. Electron and
daemon builds, TypeScript, asynchronous SQLite lint, scoped lint and diff checks passed
(existing daemon lint warnings remain). Integration preserved 4,528 outside files and
the Git index.
Draft capture/validation remains pending; this regression was fixed before changing that path.

Stage 37 binds declared review files and recognized filesystem approval inputs to
actual workspace bytes. ApprovalStore discards supplied revision metadata; only the
trusted daemon's effective read context can produce a binding. Capture stores hashes,
sizes and paths, never file contents. It is bounded to four regular workspace files
of at most 4 MiB each, using the existing evidence inspector and both current stored
workspace and captured task read policy. Missing destinations are bound as absent.
Unreadable, oversized, symlinked, external or unsupported worktree paths require
review in CoWork; channel review does not add filesystem access.

The channel authority rechecks file bindings at publication, callback claim and the
central guarded approval transaction. Changed/deleted files, newly created destinations,
read revocation and workspace moves refuse the transition and leave approval pending.
Reserved capture metadata does not change the tool authorization fingerprint, while
the canonical displayed-request revision includes it. Existing automatic review and
ordinary desktop approval behavior remains governed by its existing authority.

The isolated checkout passed 131 tests across six suites. The compiled disposable
host/worker fixture exercised 33 worker calls, captured an actual file through the
storage writer and refused changes both before callback and after claiming. This
proves validation at approval transition; it does not prove file immutability between
approval and eventual action execution. Generic MCP attachment extraction, draft
preview, fresh action-consumption checks, conversation recovery, settings UI and
full live acceptance remain incomplete. No model, channel delivery or approved action
was executed. Primary also passed all 131 tests; the two draft/channel suites
passed another 49 tests after moving filesystem inspection behind basic authority
checks. Primary Electron and daemon builds, TypeScript, asynchronous SQLite lint,
scoped lint and diff checks passed (existing daemon lint warnings remain). Its
compiled disposable fixture repeated the 33 worker calls successfully. Integration
preserved 4,525 outside files and the Git index.

Stage 38 adds the explicit Decision Cards opt-in to existing Slack and Teams settings.
It defaults off, requires structurally valid saved owner IDs to enable and permits
disabling after owner removal. Updates send only decisionMessagesEnabled, preserving
owner identity and other settings. The control displays pending writes and failed
saves; failed saves do not change its confirmed value. Unmounted or changed-channel
responses cannot update the current control. No existing channel/profile is enabled
by this source change and runtime authorization remains authoritative.

The isolated checkout passed 24 tests across settings, existing owner settings and
channel decision service suites, TypeScript, renderer build and scoped lint. A real
browser fixture rendered the source component, exercised a successful save and a
failed save, and confirmed preservation of owner IDs/progress settings. Its update API
is synthetic: this is interaction evidence, not desktop IPC or live channel acceptance.
The browser also confirmed disabling after owner removal, refusal to re-enable
without an owner and a Teams opt-in save. Its stylesheet uses the product theme
and settings classes. The owner-ID save callbacks in Slack and Teams now merge
only ownerUserIds into current UI configuration, so a concurrent save cannot erase
the newly confirmed decision switch or unrelated settings.

Primary passed 29 tests across four settings/service/router suites, TypeScript,
renderer build and scoped lint. TypeScript and renderer build passed again after
the callback merge correction. A browser screenshot of the settings was captured
locally. Integration preserved 4,530 outside files and the Git index. No real desktop
profile, owner IDs or channel configuration was changed. Teams conversation
recovery, fresh action-consumption validation and full live acceptance remain open.

Stage 39 implements persisted Teams decision conversation references and corrects a
main gateway factory gap: Teams existed in the catalog but was absent from the
factory used to load saved channels. The factory now creates the existing Teams
adapter and installs services-domain persistence under its exact channel/app/tenant.
A stable sealed configuration/security-policy hash binds the reference; plaintext
credentials never cross this repository's worker interface. Only the SDK's
authenticated normal-turn callback captures reference metadata. Decision submissions
cannot bootstrap a missing reference or become task prompts. Recovery rereads
authority, validates tenant, bot recipient, conversation and service URL, and never
falls back to old in-memory metadata when persistence is unavailable. This cache is
used only for decision publication/callbacks, preserving ordinary messaging behavior.

The new SQLite table stores only channel/bot/conversation routing IDs, tenant and
HTTPS service URL, not message text, display names, user profiles or credentials.
It has channel cascade deletion, a 1,000-reference per-channel cap and 90-day logical
expiry; expired records are pruned on subsequent reference saves. Configuration
changes invalidate recovery and require a fresh authenticated conversation.

The isolated checkout passed 103 tests across six Teams/store/gateway suites,
Electron/daemon builds, TypeScript and asynchronous SQLite lint. Scoped lint passed
with existing gateway warnings. The compiled disposable fixture exercised 41 worker
calls and recovered a sent Teams route after DB restart, normalized its synthetic
callback, conditionally resolved the central pending approval once and refused a
duplicate. It also verified changed-config refusal and reference host/worker parity.
This proves source wiring and synthetic recovery, not SDK authentication against
Microsoft, real card delivery, provider resume or execution of the approved action.
No live profile/channel configuration changed.

Microsoft documents storing conversation references for the Bot Framework proactive
flow in its [Teams proactive messaging guidance](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages).
Primary passed 151 tests across eight regression suites, Electron/daemon builds,
TypeScript, asynchronous SQLite lint and scoped lint (existing gateway warnings
remain). The final six gateway wiring/configuration-refresh cases passed in both
checkouts, including security-policy-only changes and reconnecting only an already
connected adapter. Teams configuration/security changes now replace the old adapter
and its invalidated persistence binding; disconnected adapters remain disconnected.

The primary compiled fixture repeated all 41 worker calls and verified an upgrade
from an absent reference table while preserving the original pending approval and
custom bot, followed by one-time Teams decision resolution after restart. Integration
preserved 4,528 outside files and the Git index. Final live channel acceptance,
fresh action-consumption checks and the broader isolated-profile acceptance remain
unproven; the full goal is not complete.

Stage 40 binds queued restart allow-once grants to the canonical approved request
revision. Consumption removes the queue entry before yielding, rereads the approved
row, checks task/operation identity and current authority, and validates captured
file hashes through a storage-domain worker command. Expired, revised, revoked or
unavailable grants cannot replay or produce permission-success effects. The request
path rechecks task cancellation after asynchronous consumption.

The ordinary local approval wait also validates trusted captured file revisions
when it resumes, then rechecks task/signal state. Unsupported desktop/legacy file
dependencies retain their existing permission behavior; channel approvals already
require bound dependencies before publication. These checks add no read grants.

The initial isolated suites passed 90 tests across four daemon/store suites. A
compiled disposable fixture exercised 47 worker calls, including an unchanged
approved file and refusal after its bytes changed before consumption. This closes
daemon resumption boundaries, not the gap between the final check and each actual
filesystem or connector effect. Inline/automatic approval capture, channel-authority
revocation after a winning response, per-operation revision checks and full live
acceptance remain incomplete. No model, channel or approved action ran.
Primary validation passed 111 tests across six focused suites, Electron/daemon
builds, TypeScript, asynchronous SQLite lint and scoped lint (existing daemon
warnings remain). The compiled primary fixture repeated all 47 worker calls.
Integration preserved 4,537 outside files and the Git index; owned source matches
the isolated checkout. The full nine-delivery goal remains incomplete.

Stage 41 extends captured-file revision validation to automatic review, including
session approve-all when it uses the same safe automatic reviewer. A successful
durable transition remains a recorded decision; success events and grants wait
for fresh file validation, a second authority check and task/signal checks after
the worker returns. Validation failures refuse the action without replaying or
overwriting the recorded approval. Unbound legacy requests retain existing behavior.

Four new regression cases failed against the stage-40 baseline: changed bytes,
worker failure, cancellation and abort during validation. The fix adds coverage
for unchanged bytes and authority revocation during worker validation as well.
Primary validation passed 104 tests across five suites, Electron/daemon builds,
TypeScript, asynchronous SQLite lint and scoped lint (existing daemon warnings
remain). The compiled disposable fixture repeated all 47 worker calls. Integration
preserved 4,542 outside files and the Git index; owned source matches the isolated
checkout. Inline assistant approvals,
per-effect consumption and final live acceptance remain incomplete; no provider,
real channel message or approved effect was run.

Stage 42 moves inline permission success behind canonical decision validation.
Interactive input cards now persist the same trusted request and draft capture
used by queued approvals, without emitting a popup approval event. A submitted
Allow once must win the exact pending request transition, pass the current
approved-request/file check and current authority, and retain a live task/signal
before the card handler records success. Denial, dismissal, timeout and input
errors conditionally retire the original pending request; cleanup cannot overwrite
a winner or a newly revised request. Existing unbound read/access requests retain
their permission semantics; this does not grant preview read access.

The direct helper regression failed against stage 41: it returned true despite a
validation refusal. Sixteen real-store/helper cases cover unchanged and changed
files, revised requests, policy revocation, worker failure, task cancellation,
abort, user denial/dismissal, input failure, timeout, opposite decisions and changes
during validation. The existing 61 daemon cases and assistant/automatic/resumption
regressions passed locally. Primary validation passed 118 tests across six suites, Electron/daemon builds,
TypeScript, asynchronous SQLite lint and scoped lint (existing daemon warnings
remain). The compiled disposable fixture passed 55 worker calls, including an
unchanged inline draft and refusal of changed bytes before the synthetic answer.
The scoped security command registered this confirmed regression and its executable
test; it reported no candidates but classified zero files as high risk, so it does
not independently prove the permission boundary. Integration preserved 4,540
outside files and the Git index.
Per-effect revision/authority enforcement, inline input-to-approval restart linkage,
draft preview, channel authority after
response and full isolated-profile/live acceptance remain incomplete. Synthetic
answers and storage fixtures do not prove real desktop input, model resume or an
approved external action.

Stage 43 adds durable, unique input-to-approval links containing task identity and
the captured canonical request hash. Trusted inline input creation validates and
inserts the input/link in one immediate transaction; foreign, stale, expired,
already-resolved and non-approval bindings fail without inserting a card. Linked
submission checks the still-pending original approval in the same input response
transaction. All input responses return a conditional winner result, which the
daemon requires before response events, task status changes or resume.

An approval card without its original live waiter is dismissed, never replayed as
ordinary structured input. Only its matching pending approval can be denied;
approved winners and revised requests remain unchanged. This preserves the
existing explicit-consent restart policy. Ordinary structured-input recovery
continues through its existing path. These records contain IDs/hashes, no file
bytes or new permissions.

Four interrupted-card regression cases failed against stage 42. Seventeen real
store/daemon cases cover atomic binding, rollback, expiry/revision/decision refusal,
one response winner, no-waiter handling and the complete inline allow/deny source
path. The compiled disposable fixture passed 60 worker calls, migrated an absent
link table, raced host/worker input responses and reopened a linked approval card;
a late synthetic Allow once dismissed the card and denied its pending approval
without resuming work. Primary passed 124 tests across six suites, Electron/daemon
builds, TypeScript, asynchronous SQLite lint and scoped lint (existing daemon
warnings remain). The primary fixture repeated all 60 worker calls and preserved
an older pending input, approval and custom bot while recreating the missing link
table. Integration preserved 4,536 outside files and the Git index; owned source
matches the isolated checkout. The scoped
security command registered the executable regression but classified zero files
as high risk; that registration is not independent security execution proof.
Per-effect revision/authority enforcement, card preview, channel authority after
response, all remaining producer/control adapters and full isolated-profile/live
acceptance remain incomplete. No real card, model or approved action ran.

Stage 44 records channel origin only inside the winning guarded approval
transaction, with the exact route, claim and request revision. Origin persistence
failure rolls back the approval transition. A card or callback claim alone cannot
reclassify an independent local winner as a channel decision. Current approved
request validation rechecks the original channel scope, actor admission, bot/task
lineage, policy snapshot, request/file revision and deadline. Claimed winners may
resume before the transport finish receipt; handled winners require a successful
receipt outcome. Missing channel consumption schema or inconsistent persisted bindings fail closed
without erasing
the recorded decision or adding read/owner permissions.

Both live-wait and durable responders now validate the channel winner before
persistence and again before success, grants, queued grant creation or resume.
Worker failures refuse these effects. Source tests cover unchanged decisions,
revocation before and after persistence, failed validation, local/wait and restart
responders, post-approval route/policy/request changes, independent local winners
and origin-write rollback. The previous approved-request implementation accepted
a revoked channel in the targeted baseline regression. Both responder modes also
failed the baseline regression: they reported handled after channel revocation.

The initial combined suites passed 140 cases across five files, and isolated
Electron/daemon builds, TypeScript, asynchronous SQLite lint passed. The compiled
fixture exercised 61 worker calls and refused a Slack winner after channel config
changed; a persisted Teams winner was valid after restart and refused after the
channel was disabled. Real SDK delivery, model/action execution and final
per-effect validation are still unproven. Primary passed 161 tests across seven
suites, Electron/daemon builds, TypeScript, asynchronous SQLite lint and scoped
lint (existing daemon warnings remain). The compiled primary fixture repeated all
61 worker calls. Integration preserved 4,539 outside files and the Git index;
owned source matches the isolated checkout. The scoped security command registers the executable regression and
classified zero files as high risk; it is not an independent security audit.
The full nine-delivery goal remains incomplete, including producer/control
adapters, preview and isolated-profile/live acceptance.

Stage 45 binds Autonomy and Workflow Intelligence task admission to their persisted
decision IDs. Their existing durable reservation and atomic task commit now retain
that occurrence across restart, cooldown expiry and daily-budget rollover. A new
decision remains a new occurrence. Workflow Intelligence records duplicate
admission as skipped without emitting a second review suggestion. Autonomy
retains its existing deferred-decision behavior and does not claim an execution.
No bot roster, profile settings, permissions or manual budget policy changed.

Both producer regressions failed against the pre-change code by admitting a
second task. Tests use actual SQLite reservations and task commits; the Autonomy
case closes and reopens the database and restores the pending decision in a new
engine. Workflow Intelligence replaces the budget authority and replays the saved
decision after a day change, then checks a distinct decision can still dispatch.
The isolated checkout passed 45 tests across four suites, Electron/daemon builds,
TypeScript, asynchronous SQLite lint and scoped lint (existing Workflow
Intelligence warnings remain). This is local source/storage validation, not a
live provider action or a complete producer recovery proof.

Heartbeat and Strategic Planner still require stable scheduled-occurrence
identities; cron, routines, triggers, producer state persistence and direct
adapter effects remain under the broader dispatch/recovery audit. Per-effect
approval validation, previews and isolated-profile/live acceptance are also
incomplete. The full nine-delivery goal remains active and incomplete.

Primary validation repeated all 45 tests across four suites, Electron/daemon
builds, TypeScript, asynchronous SQLite lint and scoped lint. Integration
preserved 4,543 outside files and the Git index, with owned source matching the
isolated checkout. Changes remain unstaged; no real bot/provider/channel action
was executed for this stage.

Stage 46 binds automatic Heartbeat task admission to the persisted last completed
pulse, and automatic Strategic Planner issue admission to the company, issue and
persisted last successful planner run. Startup and scheduled retries share that
identity. Heartbeat uses lastPulseAt, not the earlier lastHeartbeatAt update, so
a crash before completion does not advance the occurrence. Each manual pulse
uses its persisted pulse-run ID; each manual planner invocation passes its run
ID through planning and dispatch. Replaying the same manual planner run remains
a duplicate, while a separate invocation remains admissible. A namespaced SHA-256
key over a structured identity bounds key length and avoids delimiter ambiguity.

Duplicate Heartbeat admission completes the replay pulse without creating a
task or review suggestion; it retains signals and advances the normal pulse
cadence. Planner refuses duplicate admission before issue checkout. Existing
durable reservations and atomic task commits provide storage enforcement; no
new read permissions, default bots, user settings or daily-budget exemptions
were introduced.

Both new regressions failed against the baseline by creating another task. Tests
use real SQLite reservations/task commits and verify the winning ticket is
committed without a second reservation. Heartbeat reopens the database, restores
the prior completion anchor in a new service and changes lastHeartbeatAt/day;
Planner reconstructs the service and tests startup/scheduled replay, an advanced
anchor, replay of one manual run and a distinct manual invocation. The initial
combined run passed 103 cases across six suites; refined reservation assertions
passed in the focused producer tests. Isolated Electron/daemon builds, TypeScript,
asynchronous SQLite lint and scoped lint passed (an existing Heartbeat test warning
remains). These fixtures do not run real models or channel delivery.

The four background-budget producers now supply occurrence identities. This does
not finish the dispatch plan: cron, routines, triggers, producer state mutation
and direct adapter effects, crash reconciliation and isolated/live acceptance
still require completion. Per-effect approval validation and previews remain
incomplete. The full nine-delivery goal remains active.

Primary validation passed all 103 tests across six suites, including the refined
reservation assertions and same-manual-run replay case, plus Electron/daemon
builds, TypeScript, asynchronous SQLite lint and scoped lint. Integration
preserved 4,543 outside files and the Git index; owned source matches the isolated
checkout. Changes remain unstaged. No real model, approved action or channel
delivery was run for this stage.

Stage 47 persists Autonomy decision identity before budget reservation or task
creation, using the encrypted settings repository's asynchronous optimistic
update. Current saved policy must explicitly enable execution. Missing/unreadable
settings, refusal or conflict do not admit work. A matching active fingerprint
reuses the existing saved decision identity and intent; concurrent regenerated
IDs cannot silently become separate occurrences. The checkpoint adopts current
policy and observed state so its later best-effort save preserves other observed
workspace decisions and withdrawn work.

After reservation, the original saved decision and current policy are rechecked
again before the executor is invoked. A changed decision or revoked policy
refuses execution and refunds the unused ticket. An absent executor cannot spend
a ticket or claim success; a callback without a task identity cannot claim an
execution. Normal opt-in semantics, workspace permissions and task-admission
fencing remain in force. No named default bots or new provider permissions are
introduced.

Seven focused regressions failed against the original source, including missing
checkpoint, write failures, saved-policy revocation and phantom execution. Two
further regressions reproduced policy/decision changes after reservation before
the second validation was added. Coverage also includes incomplete policy,
observed unrelated decisions, a saved fingerprint with a regenerated ID, and two
engines competing for one persisted occurrence. Actual SQLite task commits and
encrypted settings are used in the storage suite; the competing engines create
one task and retain one committed reservation. This is not a new independent
two-worker or live-provider proof.

The initial combined pass covered 114 cases across six producer/ownership suites;
the final focused suites passed 30 cases after adding the incomplete-policy
guard. Isolated Electron/daemon builds, TypeScript, asynchronous SQLite lint and
scoped lint passed. No schema changed. The scoped security command registered
the executable policy regression but classified zero files as high risk; it is
not an independent security audit.

Cross-process producer mutation after effect completion, other producer/direct
adapter boundaries, per-effect approval authority, previews and full isolated
provider/channel acceptance remain incomplete. The full nine-delivery goal
remains active. No live model, approved action or channel message was executed.

Primary validation passed all 115 cases across six producer/ownership suites,
Electron/daemon builds, TypeScript, asynchronous SQLite lint and scoped lint.
Integration preserved 4,544 outside files and the Git index, with owned source
matching the isolated checkout. Changes remain unstaged. The full goal remains
incomplete; this is local source and storage validation only.

Stage 48 replaces Autonomy's automatic whole-snapshot save with a current-row
merge through asynchronous encrypted-settings updates. Automatic persistence
keeps current policy, newer world models and other observed records, and merges
immutable action/outcome history within existing retention bounds. A removed
settings category returns to default suggestion-only policy instead of restoring
a cached execution opt-in. Explicit user configuration changes remain supported
through the synchronous API; migration cannot reset a newer already-upgraded
policy. Refused writes retain pending mutation intent for retry.

Explicit decision status edits apply only to the current record in the original
workspace and preserve its newer fields. Each accepted edit increments an
optional statusRevision; older records start at zero. The revision is part of the
saved decision's identity checks and prevents an older automatic result from
replacing a newer human choice even when timestamps tie. A failed or out-of-scope
status edit does not return a successful changed record or append a false outcome.
Automatic saves track in-process mutation versions, so a task outcome completing
after an in-flight save is still dirty and persisted. Finishing an already-created
task records its outcome while preserving a later human withdrawal or policy
revocation; this does not imply the task itself was cancelled.

Five regressions failed against the prior whole-snapshot save: policy revocation,
withdrawal, other-workspace preservation, a late outcome after stop saved a pending
snapshot, and a status edit overwriting newer fields. A sixth regression exposed
the equal-timestamp status race in the initial merge implementation. Tests also
cover resetting the saved category, explicit opt-in after revocation, moved
workspace refusal and existing quiet/migration behavior. The real SQLite fixture
uses an independent connection to revoke policy and alter decisions during task
creation, then checks encrypted-state reopen and an edit of a legacy record with
no statusRevision. One committed dispatch and the real task-creation outcome
remain; no model or channel delivery is executed.

The isolated combined suites passed 125 cases across six producer/ownership
suites; the refined encrypted-reopen case passed separately. Electron/daemon
builds, TypeScript, asynchronous SQLite lint and scoped lint passed. No SQLite
schema changed; the status revision is an optional JSON field. The scoped
security command registered the executable regression but classified zero files
as high risk, which is not an independent security audit.

Other producer and direct-adapter mutation/effect boundaries, crash reconciliation,
per-effect approval authority, previews and full isolated provider/channel
acceptance remain incomplete. The full nine-delivery goal remains active.

Primary validation passed all 125 tests across six producer/ownership suites,
including encrypted-state reopen and legacy revision editing, plus Electron/daemon
builds, TypeScript, asynchronous SQLite lint and scoped lint. Integration
preserved 4,543 outside files and the Git index; owned source matches the isolated
checkout. Changes remain unstaged. This is local source/storage proof, with no
real model, approved external action or channel delivery for this stage.

## Cron occurrence checkpoint recovery (6 October 2026, stage 49)

Cron now tags each new task with the persisted run lease timestamp as well as
its job ID. Both Electron and Node adapters query a unique exact workspace/job/run
match regardless of task status, through the normal synchronous or asynchronous
Task repository. This query is independent of sidebar pagination; ambiguous
matches return no task. The Node adapter also records the cron source. Council
preparation retains the incoming occurrence timestamp. Resolved workspace changes
are checkpointed before task insertion. Starting a new task lease clears the
previous task link, preventing its outcome from being attributed to the new run.

Recovery reconciles terminal outcomes even when process exit occurred after
SQLite task insertion but before cron saved lastTaskId. Active tasks retain their
existing lease; historical interrupted tasks without an exact run lease remain
excluded from live-task adoption. Legacy task IDs remain compatible. This does
not add idempotency to synthetic briefing, Council preparation/binding, thread
follow-up or external effect adapters, nor reconstruct missing legacy tags.

Three completed/failed/interrupted regressions fail against the prior service.
The real SQLite fixture closes and reopens the database, recovers an unlinked
completed task among more than 50 tasks, restarts cron again, and confirms one
history entry and no replacement task. It also checks workspace separation and
ambiguous exact candidates. Host/worker storage parity exercises the new read
method. The isolated six-suite pass contains 96 tests. These are synthetic local
storage/recovery fixtures without model or channel execution. Full live acceptance
and the remaining nine-delivery work remain open.

Primary validation passed the same 96 tests across six suites plus Electron/daemon
builds and TypeScript. Asynchronous SQLite lint and scoped Oxlint passed locally;
Oxlint reported six existing warnings in the owned service/main files. No SQLite
schema migration was added. Integration preserved 4,537 outside files and the Git
index; owned source matches the isolated checkout and remains unstaged. No live
model, external action, channel delivery, deployment or remote CI was exercised.

## Inline paused responsibility routine setup (6 October 2026, stage 50)

The bot responsibility editor can now create its own paused existing routine,
with on-demand, hourly, daily or weekday timing. Daily timings capture the user's
IANA timezone. The payload is scoped to the selected workspace and arbitrary bot,
uses workspace execution, internal task output and strict review, and grants no
connector access. Instructions refer to the current bound responsibility rather
than embedding an objective that could become stale after revision. Creating the
routine does not create or activate a responsibility; the existing preview is
still required before Save paused and activation remains a separate action.

The editor fences creation while its request is outstanding. A lost/invalid reply
does not automatically retry creation; the list refreshes and a retained notice
asks the user to check for the saved routine. Scope switches discard old drafts,
previews and pending feedback. Existing control replies also check the selected
scope generation before changing new-bot UI state. This does not add backend
idempotency to the generic routine-create endpoint or delete unused paused
routines when the editor closes.

Five helper cases cover scoped paused payloads and invalid inputs. A real SQLite
fixture creates two independent manual/scheduled routine bindings, previews and
saves paused responsibility definitions, and verifies a disabled scheduled job,
zero tasks and preserved custom bot instructions. The focused five-suite pass
contains 27 tests. Renderer build, TypeScript and scoped lint passed in isolation.
The native test lives outside renderer/shared compilation roots to avoid pulling
backend services into renderer type checking.

A disposable browser fixture exercised inline daily creation, required preview,
saved paused state, reply loss with one write and a disabled retry button, and a
delayed old-bot reply after switching bots. The initially disappearing reply-loss
notice was reproduced and fixed. The bundled Playwright CLI was unavailable;
verification used the in-app browser through computer-use APIs. This fixture uses
synthetic IPC responses and does not prove live Electron/provider execution or
channel delivery. Advanced event/custom schedule setup still uses Automations.
Full acceptance and the other remaining plan requirements remain incomplete.

Primary validation passed all 27 tests across five setup/activation/schedule
suites, renderer production build, TypeScript and scoped lint with no lint
warnings. Final visual inspection used the app's existing dialog styles and theme.
The temporary browser tab and fixture server were closed. Integration preserved
4,548 outside files and the Git index; owned source matches the isolated checkout.
Changes remain unstaged. This stage has no real model, external action, channel
delivery, deployment or remote CI evidence.

## Shell effect authority revalidation (6 October 2026, stage 51)

Shell admission now captures the effective workspace scope and admin runtime
policy. After approval and again at sandbox/background/direct runner boundaries,
it checks that scope, the current daemon workspace, cancellation, persisted stop
intents and the current responsibility lineage/policy. A changed scope fails
closed and an acquired unused sandbox is cleaned up. A governed task cannot fall
back to execution when responsibility storage is unavailable. This gate does not
grant new shell capability or widen workspace/network permissions.

Persistent agent commands carry the same gate into the session manager, after
state load and after initial shell setup/persistence, before command bytes are
submitted. A refused second gate releases the active-run claim and stops the
unused session; no fallback command is launched. Verification bookkeeping clears
only the refused launch's own running entry, so later fresh admission does not
wait on a command that never started. Existing user-driven terminal calls remain
compatible with the optional callback.

Six approval/setup/persistent regressions failed against the old source. Added
cases cover background setup, a real SQLite stop intent written during sandbox
acquisition, and fresh verification admission after refusal. The native persistent
fixture confirms the refused command wrote no marker file and a later fresh
command can run. The four shell suites pass 84 cases in isolation. Policy fixtures
now provide a stable admin policy across repeated checks instead of a one-read
mock that silently reverted to defaults. No real bot/provider or external action
is exercised; the shell fixtures execute only disposable local commands.

The required security command registered an executable regression. Its scan emitted
15 unproven static candidates across these two high-risk files; every flagged
anchor is also present in the baseline. Regex parsing, process cleanup and ordinary
runner/terminal callsites are not new bypass proof. The command did not run an
independent verifier/debater, and this is not a whole-file security audit. Exact
approved draft consumption, other effect adapters, deeper asynchronous sandbox
implementation boundaries and full isolated provider/channel acceptance remain
incomplete. The full nine-delivery goal remains active.

Primary validation passed 84 tests across four shell suites, Electron/daemon
builds, TypeScript and asynchronous SQLite lint. Scoped Oxlint passed with the
existing explicit-any warnings in the older shell test fixture. Integration
preserved 4,547 outside files and the Git index; owned source matches the isolated
checkout and remains unstaged. No real model, approved external action, channel
delivery, deployment or remote CI was exercised for this stage.

The 6 October integrated Node runtime refresh ran the compiled primary checkout
in disposable profiles. The full graph/recovery variant passed two startup and
shutdown cycles, including authenticated status, unauthenticated denial, all five
producer states, independent paused responsibility definitions, stale revision
rejection, future-control persistence, scoped stopped work, local graph cleanup,
startup stop recovery, notification receipts/retry and current result-file evidence.
The separate seeded-work variant also passed two cycles. These results cover the
existing fixture assertions; false output fields for unselected variants are not
additional passing claims.

The compiled scheduler fixture passed two process starts with actual scheduled
checks: an empty selected source stayed quiet, no tasks were created, and the
private bot prompt was preserved. The compiled event fixture used a disposable
SQLite database and an additional temporary user-data profile. Concurrent copies
of one source event admitted one task; replay after service restart admitted none;
a changed stored source admitted a second task. Untrusted event text did not enter
task prompts. No model or real gateway message was involved.

The tested compiled entrypoint SHA-256 was
`684a88aaf79171862ac0efc84baa6fbebdcbfd1ab90d6a897872bb9e67f75187`;
the automation runtime was
`efe20ce062fe5d4bc67d11346c865ff2e8c1e7ee971b66436fb5cd8c3ec837a6`;
the bot bootstrap was
`d93c6c16be7c22b2bf39f3b3780866721030df51e7888345d03f2f9795517d51`.
The fixtures drained their services and removed their profiles. This is current
Node runtime evidence, separate from desktop, provider, Slack/Teams delivery and
remote CI acceptance. The full goal remains active with the remaining work in the
table above; no private named bot was made a product default.

The separate empty-work variant passed two cycles: a stop receipt for zero work
was replayed without creating tasks, and future pause state survived restart.

Browser tool dispatch now captures workspace identity, path and permissions at
admission and rechecks both the tool workspace and the daemon's effective task
workspace before browser adapter effects. It rechecks persisted task stop and
responsibility policy through the existing service unit, including after async
navigation/setup/path checks and batch delays. A governed task without policy
storage fails closed. No browser capability or responsibility scope adapter is
added; unsupported governed browser actions remain unavailable.

Checks cover visible and local navigation, element mutations, uploads, dialogs,
evaluation, history navigation, screenshots/PDF output, tab changes and individual
batch effects. A browser attachment refused after initialization or old-session
cleanup closes its unused candidate. Existing cleanup remains responsible for
already-open sessions. These checks bound BrowserTools adapter calls; internal
async browser-service/workbench/cloud setup and exact approved action/draft
consumption still need separate coverage. This is not proof that an already
submitted external action can be undone.

Three regressions failed against the original source and pass with the change:
workspace policy changing during asynchronous navigation admission, missing
storage for a governed task, and a SQLite stop intent committed after the first
batch click. The last fixture makes exactly one mocked browser click; the second
is refused. It does not contact a real browser or external site. The browser and
network suites pass 61 cases. Electron/daemon builds, TypeScript, asynchronous
SQLite lint and scoped Oxlint passed in the implementation checkout.

The required security harness registered the executable browser regression and
reported seven static candidates. All seven evidence anchors exist in the
baseline; independent verifier/debater checks were not run. This is not a full
security audit. Remaining effect adapters, exact action consumption, and final
isolated desktop/provider/authenticated channel acceptance remain incomplete.
The nine-delivery goal remains active.

Primary validation also passed all 61 cases, Electron and daemon builds, TypeScript,
asynchronous SQLite lint, scoped Oxlint and formatting checks. Integration
preserved 4,549 outside files and the Git index, and all four owned paths match
the implementation checkout. The changes remain unstaged; no live model, real
browser action, channel delivery, deployment or remote CI was exercised.

File output now captures workspace identity, path and permissions before write
admission, rechecking both the tool workspace and effective task workspace before
parent creation and bound-file effects. Persisted responsibility/stop policy is
rechecked through the existing service unit; governed tasks without policy
storage fail closed. Existing filesystem containment, approved external-path
binding, symlink and file-identity checks remain in place.

The bound writer checks authority after opening and verifying the file handle,
before truncation and again before content writes. Phase cancellation is checked
both before and after an awaited authority check, so an expired phase cannot
continue just because a policy check completed later. File handles close on
refusal. Checks cannot undo effects already submitted: parent directories or a
new empty file may already exist, and interruption after truncation can leave a
partial output. This change does not claim atomic write/stop semantics or exact
approved draft consumption.

Four regressions fail against the original source and pass with the change.
Permission revocation during file open and a native SQLite stop intent during
opened-file identity checks leave the existing content intact and emit no
file-created completion event. A missing policy store refuses a governed write;
cancellation during the final guard also preserves existing content. Fixtures use
disposable local files and SQLite; the open mock is reset between tests.
The two file suites pass 13 cases; Electron/daemon builds, TypeScript, asynchronous
SQLite lint and scoped Oxlint passed in the implementation checkout. Scoped lint
reports the existing CommonJS-require warning and the fixture explicit-any warning.

The security harness registered an executable regression and emitted 13 unproven
static candidates; all evidence anchors also exist in the baseline. Independent
verification/debate was not run, so this is not a whole-file security audit.
Other effect adapters, exact action/draft consumption, and the full isolated
provider/desktop/authenticated channel acceptance remain incomplete. The full
nine-delivery goal remains active.

Primary validation passed all 13 focused cases, Electron and daemon builds,
TypeScript, asynchronous SQLite lint, scoped Oxlint and formatting checks.
Integration preserved 4,549 outside files and the Git index. All four owned
paths match the implementation checkout and remain unstaged. No live model,
channel delivery, deployment or remote CI was exercised.

Tool dispatch now owns and recursively freezes a snapshot of JSON-compatible
arguments before the first awaited policy/review operation, at both ordinary
and runtime handler entrypoints. Caller changes to nested bodies, destinations
or arrays cannot alter the action after admission, and handlers cannot mutate
reviewed nested values in place. The caller's original object remains editable;
optional undefined fields and no-argument calls are supported. Cycles, functions,
non-finite numbers and mutable non-JSON containers are refused before dispatch.
Runtime metadata is separate from tool arguments.

The two dispatch regressions fail against the original source: caller mutation
during policy waiting and during runtime review no longer changes executed
arguments. Snapshot cases cover nested immutability, shared plain values and
invalid inputs. The combined snapshot, catalog, approval-grant revision and
authorization-identity suites pass 75 cases. Electron/daemon builds, TypeScript,
asynchronous SQLite lint, scoped Oxlint and formatting passed in the implementation
checkout. Scoped lint has existing source/fixture warnings.

The required security harness registered the executable dispatch regression and
emitted 46 unproven static candidates; all evidence anchors are in the baseline.
Independent verifier/debater checks were not run. This is operation argument
identity proof, not a whole-file audit or proof of exact approved file-byte
consumption. File dependency checks at actual adapter use, other effect adapters,
full desktop/provider acceptance and authenticated real Slack/Teams delivery
remain incomplete. The full nine-delivery goal remains active.

Primary validation passed all 75 cases, Electron and daemon builds, TypeScript,
asynchronous SQLite lint, scoped Oxlint and formatting. Integration preserved
4,549 outside files and the Git index; all six owned paths match the implementation
checkout and remain unstaged. No live provider, channel delivery, deployment or
remote CI was exercised.

Desktop review now shows the recorded draft file version, byte count and missing
state, and requests a bounded text preview on demand. The local IPC path requires
task approval authority before the worker reads and again before returning bytes.
The worker requires a pending, unexpired request with the exact request revision,
then checks current workspace read policy, containment and the recorded file
hash/size/path. It captures a text prefix from the same stable file-handle read as
the full SHA-256; changes during inspection remain unavailable. Known text formats
have at most 2,000 characters per file and four files per request. Invalid UTF-8,
null-containing binary data and unknown formats have no text preview. UTF-8 and
surrogate boundaries are preserved.

Preview contents are transient: they are not persisted in approval records,
placed in logs, or included in Slack/Teams decision messages. The desktop escapes
text, labels truncation, clears prior previews on a request/status change and
ignores late responses. A preview failure does not add permission or change the
approval outcome. This preserves the existing no-file-content-in-approvals
regression. It does not provide an immutable file snapshot to an effect adapter.

Slack/Teams cards and plain fallback now show the same stored request revision and,
when available, present/missing file counts. Only the opaque route remains in
button data; file paths and draft contents stay out of that payload. Counts and
revision metadata are validated before rendering. Review instructions direct the
user to inspect the exact captured revision in CoWork.

Native/renderer/transport tests cover prefix hashing, binary and UTF-8 boundaries,
stale files/requests, expiry, revoked file reads, pre/post IPC caller authorization,
withholding data after caller revocation, escaped text, legacy/unavailable files,
card/fallback parity and non-disclosure. Two native preview requirements fail on
the original inspector. The browser fixture visually confirmed the existing dark
theme, bounded preview, truncation label, missing-file state and request-switch
fence with a delayed old reply. It used synthetic IPC and no Electron/provider or
channel action; the tab and dev server were closed afterward.

The security harness command registered the native executable regression. It
classified none of the selected files as high-risk and produced no static
candidates; those outputs do not prove an independent security audit. Exact draft
consumption at remaining effects, inline-review surface parity, full isolated
Electron/provider acceptance and authenticated channel delivery remain incomplete.
The full nine-delivery goal remains active.

Primary validation passed 95 tests across seven suites, Electron/daemon/renderer
builds, TypeScript, asynchronous SQLite lint, scoped Oxlint and focused formatting.
The renderer build retains its existing large-chunk warning; broad scoped lint
retains existing IPC/legacy warnings. Integration preserved 4,535 outside files
and the Git index; all 23 owned paths match the implementation checkout and
remain unstaged. No schema migration, real provider, authenticated channel
delivery, deployment or remote CI was exercised.

### Stage 57: inline approval draft review parity

The inline structured input card now uses the same draft review presentation as
the approval dialog. Its local IPC endpoint resolves the stored input-to-approval
link and the canonical pending request. Caller-supplied approval IDs, file paths
and hashes cannot choose the review. Ordinary unlinked questions produce no draft
section or file read. Task approval permission is checked before and after the
worker reads; input status, link identity, approval status, deadline and request
revision are rechecked before returning the transient content. No file contents
are persisted, and no channel payload or decision semantics changed.

Focused tests cover expired/changed/cross-task requests, a forged caller approval,
concurrent input decisions/rebindings/approval changes, audience revocation,
escaped text and file hash/reference matching. The browser fixture verified a
request switch before a delayed old preview, ordinary-question omission, bounded
180px preview scrolling, truncation, collapse and the existing answer controls.
It used synthetic IPC; it did not run a real Electron/provider/channel decision.
The fixture tab and server were closed.

Inline review surface parity is implemented locally. Exact approved draft
consumption at the remaining effect adapters, full isolated Electron/provider
acceptance and authenticated Slack/Teams delivery remain incomplete. The full
nine-delivery goal remains active.

Primary validation passed 81 tests in six suites, Electron/daemon/renderer builds,
TypeScript, async SQLite lint, scoped Oxlint and focused formatting. The existing
renderer large-chunk warning remains. The selected-file security harness reported
zero classified high-risk files and zero candidates; it is not an independent
security audit. Integration preserved 4,549 outside files and the index, and all
11 owned paths match the implementation checkout. Changes remain unstaged.

### Stage 58: required draft capture at approval resumption

Native regressions confirmed an execution-permission bypass for an explicit
`reviewFiles` request whose trusted capture was unavailable. The daemon previously
validated only a `bound` draft, and the store could return a current approved
revision with a missing, invalid or unsupported capture. Seven new regressions
failed against the prior code across local waits, automatic review/session
approve-all and native grant consumption.

Explicit draft review now requires the trusted file-revision validator even when
capture failed. Both local-wait and automatic-review resumption withhold success
and grants if it cannot validate. The storage consumption check also refuses
missing/invalid/version-incompatible explicit bindings and unsupported captured
versions for implicit file dependencies. Legacy file-access approvals without an
explicit draft review keep their existing flow. Recording an approval still does
not prove an action succeeded; the request may remain recorded as approved while
execution permission is withheld. No schema change or persisted file content was
added. The executable native regression is registered in the security harness.

This closes the observed missing-capture bypass. It does not provide immutable
bytes to a path-consuming effect adapter or prove those adapters use the same
file descriptor. Exact draft consumption at remaining effects and final isolated
Electron/provider/authenticated channel acceptance remain incomplete. The full
nine-delivery goal remains active.

Primary validation passed 141 tests across six suites, Electron/daemon builds,
TypeScript and async SQLite lint. Scoped Oxlint passed with existing daemon and
repository warnings. Added test blocks are formatted; whole-file formatting still
reports prior differences in two existing approval fixtures, which were preserved
outside the changed blocks. The formatter check for the grant-resumption suite
passed. The selected-file security harness reported zero high-risk classifications
and zero static candidates; that output is not an independent security audit.
Integration preserved 4,553 outside files and the Git index; all seven owned paths
match the implementation checkout and remain unstaged. No real provider, channel
delivery, deployment or remote CI was exercised.

### Stage 59: MCP queued transport authority

Task MCP calls now carry a trusted `beforeSend` gate through the manager to the
server connection. Stdio invokes it after its per-server call queue drains;
non-stdio transports also preserve the guard and cancellation signal. After the
guard returns, the connection rechecks cancellation, connection status, tool
presence and exact transport identity before sending `tools/call`. Refusal
releases the stdio queue/context and does not submit a request. No gate function
or local authority metadata is sent as MCP arguments.

The task registry compares the admitted workspace/effective scope, connector
configuration, selected server/tool route, approval policy, tool prefix and
endpoint policy with current state. Current execution authority is checked
separately from explicit app consent so Full access remains functional; a denied
or terminal task has no execution authority. Persisted stop/responsibility scope
is checked after the asynchronous authority lookup. Missing policy storage for a
governed task still fails closed. The snapshot is not a grant or a new approval.

Nine connection regressions fail against the original connection in a bounded
fixture. Coverage includes queued revocation, all four transport labels,
post-guard cancellation/disconnect/replacement, non-stdio abort, queue cleanup and
subsequent unchanged calls. Registry tests cover permission/configuration/route/
prefix/authority changes, cancellation and Full access versus explicit consent.
These are native connection and synthetic adapter fixtures, not real provider,
server-side effect cancellation, channel delivery or immutable-file consumption.

The combined suites passed 118 tests across six files. The selected-file security
harness reported one high-risk file and 46 static candidates, whose evidence text
is present in the baseline; they are not an independent security audit. The
executable connection regression is registered. Background source synchronizers
using direct server calls, other delayed effect adapters, exact approved draft
consumption and final isolated desktop/provider/channel acceptance remain
incomplete. The full nine-delivery goal remains active.

Primary validation passed 118 tests across six suites, Electron/daemon builds,
TypeScript, async SQLite lint, scoped Oxlint and focused MCP formatting. Existing
registry/daemon lint warnings remain. Integration preserved 4,552 outside files
and the Git index; all eight owned paths match the implementation checkout and
remain unstaged. No schema change, real provider, authenticated external channel
delivery, deployment or remote CI was exercised.

### Stage 60: HTTP submission guard, cancellation and replay boundaries

The MCP connection now carries its exact connection/tool gate into the transport.
Streamable HTTP invokes it after asynchronous credential setup, immediately before
POST, and rechecks endpoint, cancellation and connection generation. Disconnect
parks admission before cleanup. A stale response from an earlier connection
cannot store a session header. A task signal reaches the actual fetch while its
existing timeout remains in force; aborting a submitted fetch is not proof that
the server did not act.

A `tools/call` 404 is now returned as an unconfirmed outcome and is not automatically
reinitialized/replayed. Metadata session recovery remains compatible and applies
the current gate before each initial/recovery/replayed metadata POST. HTTP redirects
are returned for inspection rather than forwarding request/credential bytes to an
unapproved destination. No model-supplied option can provide a gate or a signal;
they stay in the internal call contract.

Eight regressions fail against the original HTTP transport in a 429ms fixture.
They include post-refresh revocation, cancelled/disconnected/reconnected/changed
endpoints, stale session responses, no tool replay and a real two-server localhost
redirect fixture. The current suite also covers task cancellation reaching fetch,
cleanup, unchanged OAuth refresh and metadata recovery, revocation during metadata
recovery and propagation of the exact connection gate into delayed transport setup.
These fixtures contain synthetic action bytes and do not use a real provider,
authenticated channel or external server effect.

The combined suite passed 121 tests across five files. The executable transport
regression is registered. The selected-file security harness reported zero
high-risk classifications and candidates; it is not an independent security audit.
Equivalent saved credential rotation can still invalidate the exact connector
configuration snapshot and needs separate compatibility handling. Other effect
adapters, exact approved draft consumption and full isolated desktop/provider/
authenticated channel acceptance remain incomplete. The full nine-delivery goal
remains active.

Primary validation passed 121 tests across five suites, Electron/daemon builds,
TypeScript and async SQLite lint. Focused formatting passed on all five touched
source/test files. Scoped Oxlint passed with one existing transport spread warning.
Integration preserved 4,553 outside files and the Git index; all seven owned paths
match the implementation checkout and remain unstaged. No schema change, real
provider, authenticated external channel delivery, deployment or remote CI was
exercised. Temporary baseline modules/tests and the two localhost fixture servers
were cleaned up.

### Stage 61: trusted OAuth rotation and source-bound Box refresh

Queued MCP configuration checks accept only a recorded OAuth token rotation from
the same client, issuer and fixed credential metadata. Endpoint, headers, enabled
state, tool policy and all other server settings remain exact. Internal refresh
adapters record directed credential hashes in a bounded five-minute in-memory
cache; no raw credential, receipt, schema or model-supplied bypass is persisted.
Manual token edits, reverse rotations, expired proof and altered client/issuer
metadata require fresh admission.

Box refresh sharing is bound to the exact credential source. Concurrent callers
with that source share one refresh and receive its rotated token metadata; a
changed client starts a separate refresh. Both native refresh adapters compare
current credentials before saving a late response, preserving manual edits. Box
merges current unrelated settings and refuses redirects on credential requests.
Missing legacy OAuth identity metadata is not inferred from a newly saved token.

Two selected regressions fail against the original registry and Box adapter in
a bounded 12.22-second run: trusted refresh is incorrectly rejected and a manual
token edit is overwritten. Temporary baseline modules/tests were removed. The
current fixtures cover actual mocked refresh adapters, hosted Box MCP propagation,
manual and permission changes, source sharing, changed clients and unrelated
settings preservation. The executable HTTP transport regression is registered.
The selected-file harness classified one high-risk file and reported zero static
candidates; this is not an independent security audit.

Primary validation passed 120 tests across six suites, Electron/daemon builds,
TypeScript, async SQLite lint and focused formatting on ten source/test files.
Scoped Oxlint passed with four existing warnings. Integration preserved 4,553
outside files and the Git index; all twelve owned paths match the implementation
checkout and remain unstaged.
Exact approved draft consumption, remaining effect adapters and full isolated
desktop/provider/authenticated channel acceptance remain incomplete. The full
nine-delivery goal remains active. No real provider, authenticated external
channel, deployment or remote CI was exercised by these synthetic fixtures.

### Stage 62: Box upload draft bytes and final submission authority

The evidence inspector exposes a separate transient snapshot from the same stable
file descriptor and version checks as its hash. Ordinary evidence inspection
retains no bytes; database approval capture and IPC previews use that ordinary
path. The Box adapter seals tool input and captures bounded workspace draft bytes
before review. Its review includes explicit file references and hash/size
constraints; trusted capture computes its own evidence and refuses a different
revision or malformed constraint instead of adopting caller-provided hashes.
The upload consumes the captured bytes rather than reopening the path after
approval. A changed file before trusted capture cannot approve those old bytes.

Box upload seals byte data, filename and parent before asynchronous token setup.
Its internal gate runs immediately before POST, after refresh, checking effective
workspace scope, current task/profile authority, persisted stop/responsibility
policy, integration enablement and exact credentials or a trusted refresh receipt.
The HTTP request refuses automatic redirects. These gates do not prove cancellation
of an already submitted remote action. Other Box mutation methods and direct
background callers do not yet use this upload gate.

Four selected regression cases fail against the original adapter/utility in a
bounded 229ms fixture: missing concrete file review, ignored submission revocation
including after an actual mocked OAuth refresh, and mutable upload destination.
Temporary baseline source/tests were removed. Current tests also cover source
replacement after approval, preserved byte hashes, invalid capture constraints,
workspace/task/credential/integration/responsibility changes, denied review and
authorized canonical workspace aliases. Existing raw-symlink/change-during-read
checks continue to run on the shared inspector.

The draft capture contract currently limits file review to 4 MiB and workspace
files. External-path and larger uploads need a compatible reviewed-file contract;
they are refused by this adapter rather than claimed supported. The existing
responsibility capability evaluator continues to refuse unregistered Box actions.
Persisted rows contain evidence/constraints, never snapshot bytes. This is a
synthetic local proof, not a real Box or authenticated channel delivery. The
selected-file harness classified one high-risk file and reported zero candidates;
it is not an independent security audit. The executable upload regression is
registered. Full isolated desktop/provider/channel acceptance, other path-based
effect adapters and connector policy integration remain incomplete. The full
nine-delivery goal remains active.

Primary validation passed 59 tests across six suites, Electron/daemon builds,
TypeScript, async SQLite lint, scoped Oxlint with no warnings and focused
formatting on all eight source/test files. Integration preserved 4,557 outside
files and the Git index; all ten owned paths match the implementation checkout
and remain unstaged. No deployment, remote CI, real provider or authenticated
external delivery was exercised.

### Stage 63: cached-history choices and awaited-policy submission boundaries

The responsibility editor offers explicit workspace file/folder reads and saved
conversation history for all 19 canonical gateway channel types. Write choices
remain limited to workspace file writes. Changing a channel clears the previous
conversation scope; unsupported saved operations remain visible and retain their
original definition. A synthetic browser fixture exercised the real component
and product CSS, including channel switching and unsupported saved definitions.
Its screenshot is `/tmp/cowork-stage63-responsibility-choices.png`; this does not
prove native desktop or authenticated channel delivery.

The shared channel catalog now drives the editor and backend capability checks.
Governed cached-history sampling, activation and reads reject missing, disabled
or ambiguous configured instances, including disabled duplicate rows. The host
lookup instance is checked again in the same database read unit as persisted
responsibility policy and cached message retrieval. Normalized channel and chat
strings are captured before awaiting lookup. Signal fingerprints include the
configured channel id. Admission still lacks a separately persisted instance
receipt, so a replacement before host lookup is not yet bound to the original
admission. No additional connector actions or external destinations are enabled.

Box and MCP now check task/profile authority after the awaited responsibility
policy, followed by a synchronous local scope/configuration check after the last
authority await. Deferred-policy and final-authority race fixtures verify zero
submission when authority, workspace, credentials or enablement change. These
gates concern pre-submission behavior and do not prove remote cancellation.

The original six-channel capability module failed 13 selected cases in a bounded
2.18 second baseline fixture. The original Box ordering failed the new deferred
policy revocation case in 266ms. Temporary baseline modules/tests were removed.
The selected-file security harness emitted 46 unverified static candidates; its
verifier, debater and proof stages were not run. The executable MCP regression
is registered. Exact displayed-revision responses are the separate stage64 work
in progress. Broader path-based effects, admission instance receipts and full
isolated desktop/provider/channel acceptance remain outstanding. The nine-delivery
goal remains active.

Primary validation passed 151 tests across ten suites, Electron/daemon builds,
async SQLite lint and focused formatting. Scoped Oxlint reported three existing
registry warnings. The MCP deferred-policy test also failed against the old
registry: it resolved successfully instead of rejecting revoked authority
(10ms test, 9.56 seconds suite). Temporary proof files were removed. Integration
preserved 4,553 outside files and the Git index, applying all 19 paths unstaged.
The isolated compiled daemon smoke fixture passed notification retry/receipts,
future controls, stopped-work recovery, independent responsibilities and schema
upgrade checks across two starts. It executed no model and delivered no channel
message; empty-work stop replay was not selected in this combined fixture.

TypeScript and the renderer production build passed after removing an unused
React import from the new editor test; its four tests passed again. The renderer
build retains its existing large-chunk advisory.

### Stage 64: displayed approval revision contract

Main-process approval events and both Node/Electron Control Plane list branches
attach a server-computed hash of the exact task, approval type, description,
details and request time being presented. Modern desktop decisions, scoped
permission choices, session/bulk responses and the Control Plane web UI carry
that displayed hash back to the daemon. They do not fetch a newer hash at click
time and silently adopt changed content. Supplied hash checks still precede
idempotency and durable resolution/grant effects. Missing hashes on explicit
review files or a bound draft fail closed, including restarted pending requests
and mismatched persisted/local review markers.
The historical no-hash compatibility path for non-review clients remains and is
not counted as modern presenter coverage.

Desktop responses remove requests only for handled/duplicate outcomes; stale,
processing and unknown responses remain visible with truthful feedback. The
Control Plane web UI likewise distinguishes confirmed decisions from stale or
unconfirmed outcomes and offers the current list for a fresh review. Preload
reports the real response status. Its browser bridge returns the already-checked
terminal status for type compatibility; that one-line bridge change does not
close browser display-version handling or its host command forwarding gap. CLI,
hooks and legacy gateway decisions also require separate presenter coverage.

Two selected daemon regressions fail against the old code: a restarted concrete
review without a displayed hash returned handled instead of not_found, and the
event carried no revision hash. The baseline fixture ran in 8.63 seconds with
17ms of test execution; temporary files were removed. The selected-file static
harness classified zero high-risk files and emitted zero candidates. This is a
heuristic scope result, not independent security verification; the executable
daemon regression is registered. Full isolated desktop/provider/channel
acceptance, remaining effect adapters and channel admission receipts are still
outstanding. The full nine-delivery goal remains active.

Primary validation passed 111 tests across seven suites, Electron/daemon builds,
TypeScript and async SQLite lint. Additional generated-page checks exposed two
existing JavaScript parse failures: a newline escape inside the HTML template and
a TypeScript variable annotation emitted into browser JavaScript. Both received
minimal fixes. The actual generated script now parses, and five fixtures execute
its approval helper with the displayed hash and handled/duplicate/stale/processing/
unknown statuses, preserving feedback and restoring buttons. All seven tests in
the expanded Control Plane contract suite passed; total unique tests are now 117.
These are VM fixtures rather than an authenticated browser session. Integration
preserved 4,555 outside files and the Git index, applying 21 paths unstaged.
Scoped Oxlint has baseline warnings; unrelated formatting in daemon/IPC and an
earlier approval test was preserved. The plan's progress section now points to
this current audit instead of retaining superseded stage-three progress.

Electron/daemon builds, TypeScript and the renderer production build passed again
after the generated-script fixes. The renderer retains its large-chunk advisory.

### Stage 65: per-run admitted channel instance receipts

An additive, idempotent table records the selected channel types and configured
instance IDs beside each immutable responsibility run. Source sampling carries
those IDs in transient signal metadata. Task admission captures current unique
enabled instances and compares them to the sampled IDs inside the existing
immediate task transaction; replacement rolls back admission and signal commit.
Signal metadata is stripped from stored task configuration. Child admission
requires the current selected instances to match the parent's durable receipt.

Governed cached-history reads require the run's receipt and compare it to both
the host-resolved ID and the unique enabled row in the policy/read snapshot.
Replacement before lookup can no longer adopt a different instance. The selected
conversation remains constrained by the immutable responsibility definition.
Older databases create the table without backfilling historical runs: a missing
receipt refuses governed history and requires a new run. Ordinary reads and
file-only responsibilities retain their prior behavior. This closes the stage63
admission-instance gap without enabling new actions or external destinations.

The implementation checkout passed 43 focused tests across five suites, including
source replacement before real task admission, replacement after admission,
child inheritance, missing legacy receipts, schema reopen and source metadata
stripping. The selected-file static harness classified zero high-risk files and
emitted zero candidates; this is not independent security proof. The executable
history regression is registered. Exact review on remaining presentation routes,
other effect adapters and final isolated desktop/provider/channel acceptance
remain outstanding. The full nine-delivery goal remains active.

Primary validation passed 85 tests across nine suites, focused formatting and
scoped Oxlint with no warnings. The old policy accepted cached messages from a
replacement instance in the selected baseline regression instead of rejecting
(2.77 second test, 3.46 second wrapper); temporary modules/tests were removed.
Integration applied nine changed paths, preserved 4,567 outside files and the Git
index, and kept the changes unstaged. The build caught two sample-list/channel
union typing errors; the sample list now has its common source-evidence type and
channel types are narrowed through the canonical trusted catalog.

Electron/daemon builds, TypeScript and async SQLite lint passed after the typing
fix. The 13 signal/schedule tests passed again. The isolated compiled Node daemon
restart fixture passed with custom bot preservation, zero startup tasks, durable
controls/recovery and schema upgrade checks; it ran no model or channel delivery.

### Stage 68: CLI displayed-revision decisions and truthful outcomes

Local and remote approval lists display the canonical request details and its
server-side revision hash. CLI approve/reject now require `--revision-hash` from
the reviewed list; missing/malformed hashes fail before connection or process
launch. The CLI never fetches a newer revision on the operator's behalf. Remote
responses print success only for handled/duplicate outcomes; stale, processing
and unknown outcomes return a nonzero status with review/reconciliation guidance.
The desktop single-instance bridge parses a concrete decision and forwards the
operator's hash to the daemon. Local output continues to mean sent to the app,
not confirmed execution. The CLI guide and built-in help document the required
flag; older callers must review the list and supply that flag.

Focused tests verify malformed/missing hashes cause no transport request, every
response outcome is reported truthfully, deny also carries the displayed hash,
JSON-escaped command details are shown, and the mocked child-process arguments
reach the desktop parser unchanged. Thirty-eight tests across five initial
suites passed, then 34 tests across four suites passed with the local handoff
fixture added. Two selected baseline cases fail: a malformed hash and a not_found
response both returned success in the old CLI (273ms suite, 6ms tests). Temporary
baseline modules/tests were removed. This is synthetic local proof, not a real
approval, provider run, channel action or desktop-session handoff.

The selected-file static harness does not substitute for independent security
proof; its executable CLI regression is registered. Work on media byte snapshots,
browser revision handling and required native responsibility action review is
still ongoing. Final isolated desktop/provider/channel acceptance remains open.
The full nine-delivery goal remains active. Unknown connector methods are
explicitly unavailable under the original plan and do not require a global
connector expansion to finish the supported workflow.

Primary validation passed 40 tests across six suites, Electron/daemon/direct-CLI
builds, TypeScript and async SQLite lint. Scoped Oxlint exited zero with 12
existing warnings; focused formatting passed. Integration applied 13 paths,
preserved 4,566 outside files and the Git index, and remained unstaged.
The additional disposable compiled CLI metadata fixture returned the exact
canonical revision/details in JSON and text across separate processes, retaining
one pending approval and one task. It excluded ambient provider credentials,
made no decision/model/channel call and removed its temporary profile. The
fixture script is `scripts/qa/bot-cli-approval-revision-smoke.mjs`; its compiled
direct-run SHA-256 was 0edd49cf566489ff674837e7b6886aea56f703376509a3a5d5c9a2a179fdccaa.

## X reviewed media consumption (6 October 2026, stage 66)

X tweet/reply requests freeze tool inputs and capture bounded workspace media
bytes before review. Trusted approval details bind canonical file paths, byte
counts and SHA-256 revisions. Approved media is staged in a private temporary
directory using exclusive files; commands consume these captured bytes and all
success/failure paths remove staging. Missing, external, duplicate, empty and
oversized attachments fail before approval or process execution.

Each write rechecks current workspace/settings, persisted responsibility policy
and task authority after review. A synchronous local authority and staged-byte
check runs after awaited checks and immediately before each native spawn,
including Bird's JSON compatibility fallback. Browser write fallback retains
these authority gates. This does not make a remote effect cancellable after
submission or prove delivery; unsupported governed X actions remain denied.

The isolated focused suite passed 16 tests, including queued revocation before
initial/fallback spawn and cleanup. Formatting, scoped lint and scoped diff checks
passed. A bounded baseline regression failed because old approval details lacked
reviewed-file bindings. The security harness scanned three paths and reported
four static candidates: three in mocked test fixture setup and one on a fixed
temporary-directory prefix. Root inspection found no model-controlled staging
path in that composition; these scanner candidates are not independent security
proof. Regression coverage is registered in the security eval corpus.

Primary validation passed 103 tests across four suites, Electron/daemon builds,
TypeScript and asynchronous SQLite lint. Scoped source formatting and Oxlint
passed without warnings. Integration preserved 4,576 outside files and the Git
index, with owned source matching the isolated checkout. These are local
mocked-process/storage checks; no real Bird, X post, model, channel delivery,
deployment or remote CI was exercised.

## Browser displayed approval revisions (6 October 2026, stage 67)

Browser approval list rows carry the trusted hash of the full stored request
before presentation redaction. Scoped get/respond calls require that exact hash
as well as task/workspace/version; the host adapter forwards it to the daemon.
Operation receipt replay and terminal reconciliation remain bound to the same
request. A stale displayed row cannot silently acquire consent for new details.

The desktop browser bridge retains unresolved outcomes, reloads changed requests
for a fresh explicit review and returns actual daemon response status. Web
governance stores hashes with decision attempts, invalidates changed attempts,
and cannot restore older hashless approval attempts. Input-request behavior
remains separate. QA smoke/battery callers use the displayed hash; the synthetic
Control Plane fixture rejects missing/stale hashes without mutation. Remote API
examples now document the required revision contract.

The isolated four-suite pass contains 29 tests; three QA script syntax checks
and bounded local fixture/caller checks passed. A baseline copied regression
failed on the absent hash, and a separate control demonstrated changed details
with identical requestedAt could reach mutation without a hash in old code. All
temporary baseline modules were removed. Scoped diff checks passed. The static
security harness scanned five source paths with zero classified high-risk paths
or candidates; this is not independent security proof. Executable regression
coverage is registered in the security eval corpus.

Primary validation passed 33 tests across five suites, Electron/daemon builds,
TypeScript, renderer and web production builds, and asynchronous SQLite lint.
One fixture type error was corrected and its ten-test suite passed again.
Scoped source formatting passed; scoped Oxlint reports three existing warnings.
The broad disposable browser smoke is not passing: its first denial assertion
assumed default workspace delete=false even though current defaults allow it.
The fixture now explicitly revokes/read-backs deletion, proves denied records
survive, and restores permissions; product defaults and authority are unchanged.
The next run reached desktop.addUserFact, an intentionally omitted legacy global
mutation (the current browser-memory regression explicitly checks its absence).
The initial broad fixture used stale Memory Hub host methods and did not prove the
approval restart scenario. Stage 87 rebuilt it against the current contracts and
passed the broad synthetic browser/host run. Stage 73 separately passed the
compiled selected-write review and restart path. Both are disposable local
fixtures; neither establishes full live acceptance.

### Final acceptance evidence still required

Stages 72–90 now provide separate local evidence for bot/work projections,
restart and work controls, selected-write review, account-scoped mailbox reads,
Memory Hub corrections, durable decision state, and broad rendered browser/host
flows. The full local test suite, Electron and daemon builds, lint, SQLite audit,
and ratchet also pass. The selected-write fixture used a deterministic localhost
provider stub; channel smokes did not deliver a message. These component results
do not yet prove one combined run through every plan gate.

- Run one isolated profile through arbitrary bot creation/rename/deactivation,
  optional team membership, ordinary and delegated work projections, two
  independently revised responsibilities, and the desktop/Node capability
  boundary. Confirm standalone reopening creates no team and revoked membership
  stays revoked across repeated runtime startups.
- Execute a scheduled Node-compatible responsibility with Electron unavailable,
  then exercise the quiet no-signal and desktop-only waiting cases. Combine budget
  reservation, dispatch, stop/pause, exact approval, restart, and result evidence
  in the same profile while confirming unrelated work continues.
- Complete the remaining interruption matrix around reservation, task creation,
  approval wait, action intent, and provider response. Recovery must preserve
  receipts and uncertain outcomes without replaying an external effect.
- Correct and forget a Memory Hub fact, then prove a fresh real runtime run uses
  the correction with caller, subject, and third-party audience restrictions.
- Verify authenticated Slack and Teams delivery to an explicitly authorized test
  destination, including outstanding-decision recovery, fallback clients, and
  duplicate, stale, forged, wrong-actor, expired, and revoked callbacks.
- Establish a baseline for verified outcomes, unresolved waits, duplicate
  dispatches/effects, recovery and delivery failures, budget denials, idle model
  usage, and work-view latency. Keep synthetic fixture activity separate from
  genuine user activity and production adoption metrics.

No live model/provider, authenticated channel destination, remote CI, package,
deployment, or production adoption result was used for these local checks.

The compiled primary restart command
`node scripts/qa/bot-browser-approval-revision-smoke.mjs` passed using a disposable
profile and two loopback Node daemon lifetimes. The unchanged displayed request
hash survived restart. A persisted detail change with identical requestedAt
invalidated the old read/decision, retained the pending review and blocked task,
and allowed a newly reviewed denial. Exact receipt replay returned the original
result; the old hash could not override it. One task remained. Cleanup completed.

This fixture explicitly opts into the legacy approval queue only in its temporary
profile; default no-popup inline decision recovery is separate required work in
stage 69. It grants no execution approval and configures no provider environment.
It does not prove a concrete write, model execution, channel delivery or the
combined final acceptance. Stage 67 source/local proof is integrated across 17
paths; all owned files match the isolated checkout. Integration preserved 4,566
outside files and the Git index. The failed broad Memory Hub smoke remains open.

### Stage 71: current Memory Hub browser acceptance fixture

The broad host smoke's legacy global profile fact mutations have been replaced by
the current workspace-scoped Memory Hub APIs. The fixture now verifies explicit
legacy mutation denial, workspace/source attribution, listing, pinning, reading,
correction and deletion. A denied deletion preserves the active item; allowed
deletion removes it from active results. Permission changes are confined to the
disposable profile and restored in a finally block. Production permissions and
method exposure are unchanged.

`node scripts/qa/smoke-browser-preview.mjs` passed on the compiled primary Node
daemon with a disposable profile and localhost synthetic provider (five completion
requests). This closes the previously failed broad host fixture, including its
approval revision/restart, dropped-response replay and cancellation assertions.
It does not prove rendered UI, stage 69's pending implementation, real providers,
authenticated Slack/Teams, installed packages or the full combined bot workflow.
The initial fixture integration preserved 4,582 outside paths and the Git index.

### Stage 72: compiled private-profile and work projection acceptance

`node scripts/qa/bot-profile-work-projection-smoke.mjs` passed against the compiled
primary Node stores and query service. A disposable empty profile contains no
roles. Arbitrary standalone custom bots create no team or membership. Explicit
team membership deduplicates and remains removed after SQLite close/reopen.
Display-name rename, deactivation, stable role IDs and custom prompts survive;
the unrelated bot remains active. Historical task and pending approval rows are
unchanged across reopen and subsequent read projections. The internal handle is
preserved through the supported display-name rename API.

The actual shared work query includes assigned and delegated records once, rejects
a cursor from another bot, excludes unrelated and foreign-workspace tasks, keeps
an inactive bot's history readable, and shows the existing human wait once with
a disabled scheduler. Reads create no tasks or decisions. Initial integration
preserved 4,583 outside paths and the Git index.

A small synthetic query baseline measured 20 reads over five metadata-only task
records: median approximately 1.00 ms and p95 approximately 1.07 ms in this local
run. These figures describe the host query only, not rendered UI latency or a
production workload. No numeric product targets were introduced. This fixture
executes no model, task or channel action and cannot measure outcome quality,
duplicate effects, provider recovery, budget denials or delivery failures.
It proves SQLite reopen behavior, not a daemon process interruption, an older
release upgrade, or the full combined responsibility-and-artifact acceptance.

### Stage 70: durable trigger occurrence journal and recovery

Normal and backpressured matching events enter the same durable occurrence journal
before dispatch. Stable ingress identities deduplicate completed events within a
90-day retention window. Trigger definitions and responsibility revision/control
snapshots are checked again in the final SQLite action-intent transaction; queued
work cannot adopt a later definition. History and acceptance receipts commit
together. Interrupted intents remain outcome_unknown and are not automatically
replayed. Older legacy processing queue rows without receipts are quarantined,
including rows whose cooldown checkpoint is already populated.

The scoped source integration preserved 4,574 outside paths and the Git index.
Primary validation passed 39 trigger tests across three suites, Electron and daemon
no-emit TypeScript checks, asynchronous SQLite lint, scoped formatting and diff
checks. Scoped Oxlint passed with existing warnings. Its legacy wake path now
awaits the asynchronous acceptance result. Real SQLite regression fixtures verify
recovery, revision drift, admission failure and durable fake-channel receipts.
These are component/service restart checks, not process-kill acceptance or
authenticated Slack/Teams proof. Stage 69 inline write approval and the combined
rendered workflow remain separate required work.

### Stage 75: current bot and future-run controls at trigger intent

The final occurrence-intent transaction now checks that the bound responsibility
and bot are active and both responsibility-level and bot-level future pauses are
clear. These mutable flags are checked alongside the captured revision/control
identity. A bot deactivation or future pause in the preparation window cannot
reach an interceptor or task/channel effect. The tests include a future pause
whose binding controlVersion did not change, so version comparison alone cannot
satisfy this gate.

The two-path incremental integration preserved 4,582 outside paths and the Git
index. Primary validation passed 42 tests across three trigger suites, Electron
no-emit TypeScript checking and async-SQLite lint. This is transactional source and
service regression proof; the process-interruption fixture and combined rendered
responsibility/approval/artifact acceptance remain open.

### Stage 69: integrated native reviewed-write and inline decision source

The selected native workspace_files.write_file action now enters the existing
default inline approval path with full UTF-8 content, hash/byte count, canonical
path, current responsibility lineage and a separate trusted base-file revision.
Only the exact one-time decision can authorize a claimed host execution. A valid
pending linked input survives restart; its durable decision and exact unclaimed
operation can be recovered, while claimed, committed or uncertain operations
cannot be automatically replayed. Scheduled selected targets retain their intended
path. Final content/base checks run after asynchronous checks, immediately before
rename/link; staged bytes remain private during those asynchronous waits.

The combined 38-path baseline produced 28 changed paths. Integration preserved
4,559 outside paths and the Git index. Primary validation passed 235 tests across
17 owned suites, renderer/Electron/Node no-emit TypeScript gates, async-SQLite lint,
scoped Oxlint (warnings, no errors), and renderer/web/Electron/Node builds. Scoped
format checks passed; the large daemon/IPC handler files already fail whole-file
format checks in the captured baseline, so unrelated formatting was preserved.

These tests include real SQLite migration and file-write regression fixtures.
They do not yet prove the combined rendered original-review restart path; that
remains the stage 73 acceptance requirement. Node filesystem checks and the SQLite
receipt cannot form one portable atomic transaction. Uncertain outcomes are retained
and cannot be treated as safe retries. No real provider/channel, package or CI
verification is established by these local checks.

### Stage 74: compiled process interruption and services-worker proof

`node scripts/qa/bot-trigger-occurrence-recovery-smoke.mjs` passed on the freshly
compiled primary Node services with a disposable profile. It asserts the actual
services-domain SQLite worker is in use. Two concurrent stable-ID ingress calls
in one runtime produce one accepted fake-task effect; replay in a new process
produces no second effect. This is not a separate two-runtime scheduler race.

Actual SIGKILL before action intent recovers the claimed occurrence and executes
once. SIGKILL after a local fake-channel callback accepts delivery but before the
receipt commit preserves outcome_unknown and never redelivers after restart. A
completed fake-channel receipt also survives process restart without replay.
Legacy processing rows with populated last_fired_at remain quarantined, while
queued trigger-definition and responsibility-revision drift fail closed.

Callbacks write local synthetic JSONL effects; they do not create actual model
tasks or send through Slack/Teams. The fixture starts no provider, Control Plane
or browser, and supplies no production adoption or personal-activity evidence.
Its source integration preserved 4,587 outside paths and the Git index.

### Stage 80: browser memory-candidate availability

The rendered broad UI fixture discovered an unsupported Everyday memory-candidate
read. Everyday now checks the host's reviewed method inventory before reading and
displays the unavailable browser state. Native preload behavior is preserved;
no memory permission or browser method exposure was broadened. Primary validation
passed the eight existing Everyday tests, renderer type checking and web build.
The one-path integration preserved 4,583 outside paths and the Git index.

The broad rendered fixture has also been aligned with current sidebar/project/
notification labels and the workspace-scoped Memory Hub. Its Git action uses a
separate disposable repository instead of modifying task-workspace private-path
restrictions. The full rendered browser and host run passed after these fixture updates;
its bounded acceptance is recorded below.

### Stage 84: broad rendered browser and host acceptance

`COWORK_WEB_UI_SMOKE=1 node scripts/qa/smoke-browser-preview.mjs` passed against
fresh primary daemon and web builds in a disposable profile. This includes actual
Memory Hub correction and deletion, stale workspace replies, current Settings
routes, projects, notifications, managed agent controls, Git actions in a separate
fixture repository, queue and scheduled-task interactions, paired sessions,
cancellation and same-profile restart recovery. The local deterministic provider
stub received five completion requests. This establishes the broad browser flow,
not real-provider execution, native installed-artifact parity or Slack/Teams delivery.

The separate selected-write fixture has not passed: two attempts timed out before
an inline review appeared. Inspection of the disposable task showed planning
retries with provider_outage and fetch failed. The fixture's Control Plane
configuration stores openai-compatible settings under a different key from the
provider factory's openaiCompatible configuration. Fixture setup repair and the
original-pending-review restart/artifact acceptance remain in progress.

### Stage 86: Control Plane built-in provider configuration

The selected-write fixture exposed a real configuration mismatch: llm.configure
saved OpenAI-compatible base URL and credentials in customProviders while the
active built-in provider reads openaiCompatible. Configuration now updates that
existing built-in node, preserving its model and unrelated options. The regression
test starts with an already configured built-in provider, so a legacy migration
cannot mask the ignored update. Three focused tests, Node daemon and Electron builds, scoped formatting and
Oxlint passed. The two-path integration preserved 4,587 outside paths and the Git index.
This fixes configuration; the original pending write approval and exact artifact
acceptance are still unverified.

The next actual selected-write run reached the local provider and native write
tool, confirming the configuration repair. It did not reach an inline review: the
write was refused for lack of exact approval, then the deterministic stub repeated
completion text until the task budget failed. The fixture's plan response is being
corrected, and the inherited routine/profile review capability is under audit.
This remains a failed acceptance run, not a verified approved artifact.

### Stage 73: rendered selected-write approval and restart acceptance

`node scripts/qa/bot-selected-write-approval-smoke.mjs` passed against fresh
Electron and Node daemon builds using a disposable profile and a deterministic
localhost OpenAI-compatible provider. The original linked review and pending
input survive graceful daemon shutdown; startup rehydrates the task as awaiting
approval and issues no additional provider request or write before the user
decides. The browser acceptance verifies that missing, altered and stale review
data disable Allow once while leaving Deny once available, then approves the
current exact revision after restart.

The 105-byte UTF-8 proposal was committed once with SHA-256
`01ce4951d2d0f1b7fa2bc9e95b754279b63069e31301e80e447c68c07684ad8f`. The durable
claim is `committed`; the target's captured base revision stayed unchanged until
the decision; duplicate write count and unknown effects are both zero. The
acceptance also checks that replaying a committed claim with a new execution ID
does not claim or execute it again. The temporary profile was deleted on exit.

Shutdown now preserves only a canonical, linked responsibility write review
when the daemon itself is closing. Its approval and input rows remain pending for
startup reconciliation; other cancellations still retire their approval/input
through the existing denial path. The claim check permits the same in-flight
execution to pass its repeated pre-commit authority check while rejecting a new
execution after commitment.

Final local gates passed: 57 focused tests across the file-review and browser
bridge suites, `npm run type-check`, `npm run lint` (existing Oxlint warnings,
zero errors), Electron and daemon builds, renderer and web builds, plus the
compiled process acceptance. The acceptance received no provider credentials
and sent no Slack/Teams message. It proves the default inline browser route and
this native write path only; remaining connector/effect adapters, authenticated
channel delivery, full crash matrix and broader plan acceptance are still open.

### Stage 74: gateway source-instance identity across admission and execution

Electron and headless gateway ingress now preserve the configured channel
instance ID in each trigger event. The ID participates in occurrence identity and
is checked against the selected responsibility source before durable admission.
The accepted responsibility snapshot pins its selected channel instances, and
the worker rechecks that snapshot before preparation and inside the SQLite action-
intent transaction. A message with a missing or mismatched instance is not admitted;
replacing the selected instance while an event waits or races the action-intent
boundary prevents task creation or effect handoff.

Focused validation passed 44 tests across the governed event, headless automation,
and trigger suites. Reusing one provider event ID with a different channel instance
also retains distinct occurrence identity. Type-check, lint, Electron and daemon
builds, targeted formatting and scoped diff checks passed. The change covers
gateway-backed channel history events; connector/webhook ingestion and other effect
adapters remain separate open work. It does not establish authenticated live-channel
or provider acceptance.

### Stage 75: selected-account mailbox responsibility events

Routine mailbox triggers now persist an explicit account filter, and the routine
settings editor offers existing mailbox accounts. Activation requires a selected
account that is connected or degraded, plus at least one selected observable
responsibility source. The event adapter checks the persisted mailbox receipt,
workspace, account and provider before admission, during preparation, and again in
the SQLite action-intent transaction. Current account status and identity are
included in the responsibility snapshot, so replacement or revocation while queued
or during preparation fails closed. The event only wakes a task over already
selected sources; subject and summary do not become task instructions.

Focused validation passed 62 tests across five suites, including persisted receipt
rejection, activation eligibility, routine account-condition generation, task
creation from a selected source, and account revocation during preparation. Full
TypeScript checking, Electron and daemon builds, renderer build, full Oxlint plus
async-SQLite lint, targeted formatting and scoped `git diff --check` passed. The
renderer build emitted its existing large-chunk advisory and lint reported existing
warnings. This is local fixture evidence only; no mailbox provider was connected or
tested live. Remaining event sources, mailbox read-tool scoping, other connector and
effect adapters, authenticated delivery, live audience proof, and recovery acceptance
remain open.

### Stage 76: private audience binding for typed channel approvals

The durable channel decision authority now requires the originating session task
to carry an explicit `gatewayContext: "private"` and its persisted
`taskRequesterUserId` to match the authorized decision actor. Group/public tasks,
missing legacy context, and a different requester fail closed before route creation
or card publication. This check runs in the SQLite authority snapshot, so it also
protects callback claims after publication; owner configuration and authenticated
transport checks remain independently required.

Focused validation passed 101 tests across the channel decision store, decision
service, approval draft revision, and approval resumption suites. `npm run type-check`,
`npm run lint` (existing warnings, zero errors), targeted formatting, and scoped
`git diff --check` passed. The tests prove private owner routing succeeds and group
context/requester mismatches do not create decision routes. This remains local test
evidence; authenticated Slack/Teams delivery and live audience behavior remain open.

### Stage 77: exact requester checks for legacy approval buttons

Legacy inline approval callbacks now require the callback identity to match the
persisted task requester in every context, including direct messages. A missing
requester fails closed, matching the typed decision route's identity boundary.
The original requester can still resolve a pending direct-message approval.

The security harness now classifies the gateway directory as a high-risk boundary,
with a focused classifier regression. Validation passed 91 tests across the harness,
legacy router, and typed decision suites; the Electron build, full TypeScript check,
targeted formatting, targeted Oxlint, and scoped diff check passed. The focused
harness run scanned both gateway files and reported 24 heuristic candidates across
shell, browser, export, and path rules. They remain unconfirmed static candidates;
the harness did not identify a confirmed finding. This does not prove authenticated
Slack/Teams delivery or live channel audience behavior.

### Stage 78: reviewed cloud-file upload revisions and send-boundary authority

Google Drive, Dropbox, SharePoint, and OneDrive upload approvals now bind a
canonical source path, SHA-256, and byte count to the reviewed file revision. A
captured byte snapshot is the only payload sent. The adapters re-read and compare
the source, current workspace, integration settings and credentials, responsibility
policy, and task effect authority immediately before each HTTP send. Google Drive
checks both metadata creation and content upload. Outside-workspace inputs retain
their separate `external_file_access` approval and bind the subsequent service
approval to a stable snapshot. Reviewed cloud uploads use the approval subsystem's
existing 4 MiB revision limit; larger resumable uploads remain open.

Focused validation passed 63 tests across the four upload adapters, existing Box
upload and integration-approval coverage, HTTP send-boundary utilities, and OAuth
refresh proof. `npm run type-check`, `npm run build:electron`, `npm run lint`
(warnings, zero errors), scoped formatting, and scoped diff checks passed. The
workspace-wide `npm run fmt:check` still reports 143 formatting issues outside
this scoped slice; every changed file in this stage passes the targeted check.
This is local evidence only: no cloud provider credentials or live upload were
used, and the stage does not prove authenticated channel delivery or complete the
remaining bot acceptance gates.

### Stage 79: cloud-storage mutation submission checks

The remaining native Box, Google Drive, Dropbox, SharePoint, and OneDrive folder
creation and deletion paths now run the shared effect guard immediately before
their HTTP request. Approval details include the tool, captured parameters, action
and destination. After the approval wait, the guard rechecks effective and local
workspace identity, integration enablement and configuration, credentials (allowing
only a trusted OAuth rotation), persisted responsibility policy, and the same task
effect authority. The Box and Dropbox request adapters now carry the internal gate
through to fetch; Google Drive, SharePoint, and OneDrive already expose that boundary
for their reviewed uploads.

Focused validation passed 69 tests across the upload and mutation approval suites,
Box upload adapter, and provider HTTP send-boundary utilities. `npm run type-check`,
`npm run build:electron`, and full `npm run lint` passed (existing warnings, zero
errors); scoped formatting passed. The workspace-wide formatter still reports
143 issues in other files. This is local fixture evidence only; it does not prove
live cloud writes, authenticated Slack/Teams delivery, or the remaining combined
bot acceptance gates.

### Stage 81: Gmail and Calendar reviewed effects

Gmail send-message, reply, forward, and send-draft paths now bind approval to a
canonical digest of the actual HTTP request and show recipients, subject, body,
thread, and attachments when available in the approval dialog. Forwarding asks for
approval separately for each completed message. A send-draft approval also records
the exact Gmail raw-message revision and rereads it before sending; a changed draft
fails closed. Google Calendar create and update approvals show the complete proposed
event payload. Delete approval shows the existing event and rereads it before
submission. Gmail and Calendar APIs await their internal `beforeSend` authority
checks immediately before every fetch attempt, including authenticated retries.
The shared guard confirms workspace identity, connector configuration and scope,
trusted OAuth rotation, responsibility policy, and current task effect authority.

Focused validation passed 26 tests across the integration-approval, HTTP send
callback, and approval-dialog suites. `npm run type-check`, `npm run build:electron`,
full `npm run lint` (existing warnings, zero errors), scoped formatting, and scoped
diff checks passed. These are local fixtures only. No live Gmail or Calendar calls
were made. A remote revision can still race in the interval after its final read
and before the provider accepts the write; this stage does not establish atomic
remote compare-and-send behavior or complete the remaining bot acceptance gates.


### Stage 83: remaining Gmail mutation boundaries

Gmail draft creation and updates now require the existing external-service
approval path, display the complete proposed message, and bind the exact API
request digest. Draft updates snapshot the saved raw revision, verify that the
preview reads are consistent, and reread it before PUT; edits made while approval
is pending stop the write. Creating a missing label now has its own approval and
send-boundary check before Gmail receives the create request. Label changes,
archive, and trash actions now bind their target and request content to approval
and recheck workspace, settings/scope, credentials, responsibility policy, and
task authority immediately before submission. Bulk label matching now searches
first, then asks approval for the resolved count and selected-set digest; each
bounded batch has its own final authority check.

Focused validation passed 44 tests across integration approval, Google Workspace
error handling, HTTP send callbacks, and rendered approval reviews. `npm run
type-check`, `npm run build:electron`, full `npm run lint` (existing warnings,
zero errors), scoped formatting, and scoped diff checks passed. No live Gmail
requests were made. Draft revision reads reduce stale-write risk but cannot make
the final provider-side check atomic with Gmail's write endpoint; broader bot
acceptance and live delivery remain open.

### Stage 82: Notion mutation review and send-boundary checks

Notion block, page, and data-source create/update/append/delete paths now include
the exact API method, path, and canonical request digest in their approval details.
The approval dialog displays the target and complete proposed request body. Block
deletion also captures the existing resource and rereads it immediately before
DELETE; if it changed after approval, the operation stops. The Notion API adapter
awaits its internal `beforeSend` callback directly before fetch, where the shared
guard rechecks workspace scope, integration enablement/configuration and API key,
responsibility policy, and task effect authority.

Focused validation passed 30 tests across integration approvals, send-boundary
callbacks, and rendered approval reviews. `npm run type-check`,
`npm run build:electron`, full `npm run lint` (existing warnings, zero errors),
scoped formatting, and scoped diff checks passed. No live Notion requests were
made. As with Gmail and Calendar, a remote resource can still change between its
final read and the provider's write; atomic remote compare-and-write is not proven.

### Mailbox delivery ambiguity and recovery (6 October 2026)

Scheduled Gmail forwarding persists its send intent and records an ambiguous
provider response as `outcome_unknown`; it does not automatically resend the
message or advance past the uncertain source item. Legacy in-flight/error records
are conservatively moved to the same state. Queued compose sends now persist and
reuse Gmail or Graph draft IDs before their send call. A lost response, a local
commit failure after provider acceptance, or a send interrupted by process restart
also becomes `outcome_unknown`. Other sends are serialized through one in-process
outbox drain.

The inbox exposes two explicit reconciliation choices after the user checks the
provider: confirm that the message was sent, or confirm it was not sent and submit
it again. Unresolved sends remain locked and have no blind Retry button. Focused
tests cover lost provider responses, restart recovery, confirmed delivery, and a
user-confirmed retry that reuses the same provider draft. The combined mailbox and
routine regression run passed 76 tests; type checking, Electron and renderer
builds, lint, scoped formatting, and scoped diff checks passed. The renderer build
reported the existing large-chunk warning.

These results use mocked providers and local SQLite. They do not prove live Gmail,
Graph, or SMTP delivery, a provider-side idempotency guarantee, external delivery
receipts, or authenticated channel acceptance. An ambiguous provider state still
requires a person to inspect the provider before choosing a resolution.

### Stage 87: fresh web artifact acceptance rerun

A repeated selected-write run initially timed out before the browser held the inline
review response. The test consumes the separately built `dist/web` app; that output
was older than the current renderer source. After `npm run build:web`, the same
`node scripts/qa/bot-selected-write-approval-smoke.mjs` acceptance passed. It
verified held-review controls, fail-closed missing/tampered/stale review states,
restart recovery, and one exact committed file effect with no duplicate file event
or uncertain claim. The disposable run used five deterministic localhost provider
requests, committed the 105-byte UTF-8 proposal with SHA-256
`01ce4951d2d0f1b7fa2bc9e95b754279b63069e31301e80e447c68c07684ad8f`, and deleted
its profile on exit.

`COWORK_WEB_UI_SMOKE=1 node scripts/qa/smoke-browser-preview.mjs` also passed against
the freshly built web app, covering the broader rendered host, settings, task,
notification, memory, queue, Git, artifact, and restart flows with a deterministic
local provider. These runs establish local browser and daemon behavior only. They
do not prove authenticated channel delivery, real-provider execution, installed
artifact parity, or the remaining effect and crash matrix. A fresh `npm run dev:log`
capture was attempted for failure triage but exited before startup because another
CoWork development instance was active; that instance was left untouched.

### Stage 88: account-scoped mailbox responsibility reads

Bot responsibilities can now select read-only mailbox/list_threads and
mailbox/get_thread sources for one configured mailbox account. The editor loads
account IDs, addresses, providers, and connection states into an account selector.
The trusted task policy requires the requested action and exact account ID to match
the saved source. Lists force the selected account into the mailbox query; thread
reads confirm the thread's owning account before loading messages and return only
thread content, without contact-memory or cross-account relationship research.
Other mailbox actions and all mailbox writes remain unavailable to this adapter.

The focused policy, mailbox-tool, MailboxService, and editor suites passed 99 tests.
npm run type-check, npm run build:react (existing large-chunk advisory), npm run
build:electron, full npm run lint (existing warnings, zero errors), and scoped
formatting passed. The MailboxService regression uses temporary local SQLite
records; no mailbox provider was contacted. This establishes local policy and UI
behavior only, not live account acceptance or the remaining bot delivery and
recovery gates.

### Stage 89: integrated local regression and worker-routed source admission

Act responsibilities now classify actions outside their exact permitted-action
set as `review_required`; an ungranted native file write enters the existing
exact-byte inline review instead of being treated as an unselected no-op. Event
responsibility source-instance and account checks now run through services-domain
database units rather than synchronously during trigger evaluation. The SQLite
ratchet supports key-scoped handle exemptions while continuing to reject new
host-side SQL, and the dependency audit now checks newly discovered tracked files
before they are added to the baseline. The task-title revision helper retains its
task-row cache invalidation on every successful update.

The full `npm run test` run passed 1,245 test files (1 skipped): 13,979 tests
passed, 5 skipped, and 2 todo. `npm run type-check`, `npm run build:electron`,
`npm run build:daemon`, `npm run lint` (warnings, zero errors), the SQLite audit
and ratchet, targeted formatting, and scoped diff checks passed. The phase-1
skills check also printed a 55.35% forbidden-misfire rate; it did not fail this
test command and remains a separate routing-quality signal.

Fresh disposable local acceptance also passed for the durable channel-decision
fixture (61 worker calls, no action execution or delivery), two automation
runtime restart passes, CLI and browser approval-revision recovery, and the
rendered selected-write path. The latter committed exactly 105 UTF-8 bytes with
SHA-256 `01ce4951d2d0f1b7fa2bc9e95b754279b63069e31301e80e447c68c07684ad8f`,
with zero duplicate writes, using a deterministic localhost provider stub. The
broad browser/host smoke passed with five synthetic completion requests. These
runs do not prove a real model/provider call, live mailbox access, authenticated
Slack/Teams delivery, the complete crash matrix, installed-artifact parity,
remote CI, or deployment. The combined acceptance gates above remain open.

### Stage 90: compiled Node acceptance refresh

Fresh compiled acceptance passed for the disposable-profile bot work projection,
two scheduled quiet/no-signal checks, durable trigger occurrence recovery,
dispatch reservation races, concurrent responsibility-signal admission, event
replay/source-change handling, and Memory Hub correction, forget, provenance, and
audience checks. The recovery fixture proved stable-occurrence deduplication,
recovery before action intent, and no redelivery after a fake channel accepted a
message but the process stopped before recording its receipt. The projection
fixture confirmed private bots and historical work survive reopen without an
implicit team; opening the work projection caused no execution. Every fixture
reported model execution and channel delivery disabled. The work projection's
20 synthetic measurements over five task records reported a 1.11 ms median and
1.45 ms p95; this is a fixture datapoint, not a production latency baseline.

`npm run qa:security:harness` also passed with zero candidates and zero high-risk
files in its changed-file scope. This static pass does not replace the test suite
or prove external channel authorization. These are separate component fixtures;
they do not constitute the combined all-delivery profile, a live model/provider
run, authenticated Slack/Teams delivery, installed-artifact parity, remote CI, or
deployment. The final acceptance gates above remain open.

### Stage 91: Node-only responsibility execution fixture repaired

`scripts/qa/bot-node-responsibility-execution-smoke.mjs` (left in progress at stage 90)
ran its Observe responsibility through the compiled Node daemon and local provider,
then failed in its own final query: it read `definition_json` from
`bot_responsibilities`, which lives in `bot_responsibility_revisions`. The query now
joins the current revision. The fixture passes: the selected file is read, no write
tool is offered, the independently revised responsibility stays paused at revision 2,
and one routine receipt is recorded. `npm run qa:bots:node-execution` runs it.

### Stage 92: headless runtimes report reviewed Act effects before dispatch

The first combined run found a real gap. On the headless Node daemon an activated
Act responsibility with the `all_effects` review boundary reached `write_file`, but
`canAnswerInlineApproval` denies inline reviews on headless runtimes, so every write
was refused and the task retried until its budget failed. `responsibilityActivationIssues`
now takes an `interactiveReview` input (the store passes `!isHeadlessMode()`; anything
but `true` blocks), so preview, activation, `assertRunnable` (manual, cron and trigger
dispatch) and task-start policy all report "Reviewed effects need the desktop app ..."
on headless runtimes. The same policy treats scheduled and event-started tasks as
automated, so an all-effects Act responsibility whose routine has a non-manual trigger
is now also blocked with its own reason. In-grant actions (`outside_granted_scope`)
and Observe/Propose are unaffected. Worker threads do not inherit argv, so both
entrypoints now set `COWORK_HEADLESS=1` whenever the process is headless, including
when `--headless` is combined with a different env value. Approval policy itself is
unchanged.

### Stage 93: reviewed outputs on result cards

The approved write committed exactly once but `bot.work.result` listed no outputs, so
the result card could not recheck the artifact. After a reviewed responsibility write
commits, `write_file` records a WorkSession artifact revision from the approved
revision itself (SHA-256, byte count and approval ID via `recordReviewedOutput`). It
does not re-read the path, and it adds no row to the artifacts table that gateway task
completion uploads from, so no new chat egress is created. The combined run shows the
output with the approved SHA-256 and `check: "matches"`; delivery stays `unknown`.
Ordinary writes are unchanged.

### Stage 94: outcome metrics baseline and dispatch denial ledger

`bot.metrics.summary` (read scope, Node and desktop Control Plane) returns recorded
counters for a workspace, optionally scoped to one bot's visible lineage, over 1–90
days: completed/verified/failed/cancelled outcomes, unresolved approvals and inputs
with the oldest wait, committed and uncertain reviewed effects, interrupted tasks and
uncertain trigger outcomes, inbox delivery states, dispatch reservations, duplicate
committed occurrences and denials by reason, model calls on owned tasks versus calls
not attached to any task, and recent work-view latency in this process. Dispatch
denials were not persisted before; `reserve()` now increments a daily
`background_dispatch_denials` aggregate (no request content) in the same transaction.
SQL runs as a storage-domain unit (`botOutcomeMetrics_summary`). No targets are set.

### Stage 95: delivery-history retention and remaining approval routes

The high-volume delivery history is now bounded. Every 6 hours the owned notification
runtime runs `botReceipts_prune` under the scheduler fence. After 90 days (the
occurrence journal's window) it removes stored or cancelled notification intents for
tasks that have finished with no pending approval or input, and handled or sent channel
decision routes that no approval consumption record references. Idempotency receipts
for user requests (work control, future runs, notification route and retry), unresolved
deliveries, stop intents, approvals, tasks and lineage are never pruned. A process
without current ownership cannot prune.

Legacy chat approval buttons and `/approve` commands (non-typed channels) resolved
approvals without a revision. The router now keeps the displayed `revisionHash` (or
recomputes it from the shown content) and passes it to `respondToApproval`, so a
changed request is refused. Exact reviews (review files, bound drafts, responsibility
writes) deliberately get no hash: a chat prompt never shows their bytes, so the daemon
keeps refusing those legacy decisions as before.

An independent security review of stages 92–95 found no authorization bypass, SQL
injection or cross-scope leak. It found one regression introduced during this work:
an earlier draft passed the hash for every legacy and webhook decision, which would
have let a chat button or webhook token approve an exact review it never displayed.
That was corrected as described above, and the webhook change was withdrawn. The
review's Low findings were also addressed: the fail-closed `interactiveReview` default,
the headless env alignment, the scheduled-trigger gap, recording the reviewed bytes
instead of re-reading the path, and narrowing retention so request replays and
long-pending decisions cannot be re-applied or re-notified.

### Stage 96: combined final acceptance and previous-release upgrade

`node scripts/qa/bot-final-acceptance.mjs` (`npm run qa:bots:final`) runs the plan's
final acceptance in one disposable profile across four Node daemon lifetimes and two
Electron desktop lifetimes (hidden window), with a deterministic loopback provider.
In order it proves: an empty profile installs no bots; arbitrary bots, an explicit
team, rename, deactivation and revoked membership survive every restart; the work
projection is read-only, deduplicates assigned and delegated rows and rejects foreign
cursors; a scheduled Node responsibility stays quiet with no model call while its
source is missing, admits one task when it changes and stays quiet afterwards; two
responsibilities revise independently and a stale revision is rejected; the desktop
backend and headless reviewed effects are blocked before dispatch; on desktop, a
SIGKILL during the exact-write review leaves the review pending with no provider
replay, forged/stale/foreign-scope decisions claim nothing, the approved bytes commit
once, a second decision is `duplicate`, and the result card shows the output as
`matches`; bot pause blocks responsibility runs and new assigned roots while an
unrelated bot's task completes; stop-turn settles with the turn cancelled; a SIGKILL
during a provider response leaves one run receipt and no write replay; a Memory Hub
correction reaches the next fresh run and the old fact does not, the owner's private
fact is present locally and absent from a group-context run, and a forgotten fact
reaches no later run; SIGKILL after a reservation is refunded on takeover, SIGKILL
after task commit keeps the committed charge, and replaying the occurrence is
`duplicate_occurrence`; the metrics baseline reports one committed effect, zero
uncertain effects, zero duplicate admissions and work-view latency. The desktop adds
the pre-existing system role catalog (21 `is_system` roles) that the plan keeps
distinct from user bots; it creates no user bots, joins no teams and receives no work.

`scripts/qa/bot-release-upgrade-smoke.mjs` (`npm run qa:bots:upgrade`, with
`COWORK_UPGRADE_BASELINE` pointing at a built checkout of the previous release) builds
a profile with the previous release
(`596d8ed5f`): its stores seed user bots (custom prompt, renamed, deactivated), an
explicit team, assigned/delegated history, a paused task with a historical decision
and a paused routine, then its desktop app runs once and seeds the legacy named roster
and default team. The current Node daemon (twice) and the current desktop app then
open that profile. All pre-existing roles (including Atlas, Forge and Scribe and the
"CoWork Bot Team"), teams, membership, tasks, decisions and routines are unchanged,
no role is added, the new tables are created, and work, responsibility and metrics
reads succeed.

Final local gates on the integrated tree: `npm run test` passed 1,247 files (1
skipped), 13,991 tests (5 skipped, 2 todo); `build:electron`, `build:daemon`,
`build:cli`, `build:react`, `build:web`, `type-check` and `lint` passed (existing
warnings, zero errors; none introduced in changed hunks); `qa:db:audit` and
`qa:db:ratchet` passed after the two new worker-unit stores were added to the reviewed
shared-SQL rule. All 15 compiled bot fixtures passed, then the combined acceptance,
selected-write, Node execution, full runtime/restart (`--graph-work-control
--work-control-recovery --bot-future-control --result-evidence --bot-notifications`),
channel-decision and previous-release upgrade runs passed again on the build that
includes the security-review fixes. The combined runs recorded work-view medians of
13–18 ms over four local reads; that is a fixture datapoint, not a production
baseline.

None of these runs used a real model, provider credentials, an authenticated Slack or
Teams destination, remote CI or a packaged build.

### Stage 97: in-app testing on a demo profile

The desktop app was run on a separate demo profile (two arbitrary bots, an explicit team,
seeded history, an active weekday Observe responsibility and a paused reviewed-write Act
responsibility) and driven through its real window with Playwright's Electron automation,
with the user's own configured OpenRouter model (`nvidia/nemotron-3.5-lightning:free`).

Working as planned: workspace-scoped work views (Needs you, Working, Scheduled, Results);
the result card with outcome contract, requirement check, output revision checked against
the current file (an external edit shows "File changed since this revision") and
provenance, with delivery left unknown; Context and memory opening the Memory Hub on the
bot's workspace with "Shared workspace context" labels; the inline editor (sources,
actions, budget, review boundary, Preview run, Save paused as revision 2, Activate, Run
now) with runs bound to the exact revision; bot-level pause blocking Run now with a
durable receipt; a model-proposed write to an unselected file (`explore.txt`) held for the
exact review (target, SHA-256, size, content) and denied without creating the file; the
budget cap stopping a run as partial; and a run that never wrote its granted file failing
as "mutation-required contract unmet" rather than claiming success.

Defects found and fixed:

- The tool registry passed the model's raw `write_file` path to the review-context check,
  which accepts only the canonical workspace-relative path. An absolute path to the
  granted file was therefore rejected ("not a canonical workspace path") and the
  legitimate write could never be reviewed. The registry now normalizes through
  `responsibilityWriteReviewTarget`, the same normalization as the policy. The combined
  acceptance run's provider now proposes its write by absolute path and passes.
- The Scheduled tab ignored responsibility schedules: routine-managed cron jobs carry no
  bot assignment. The work query now also lists enabled jobs owned by the bot's
  responsibility routines (with next run time).
- The responsibility list did not reload after bot-level pause/resume or Refresh, so it kept
  showing "Bot future runs paused" and a disabled Run now after resume. It now reloads
  on both.
- "Context and memory" sat outside the dialog padding; it now aligns with the controls.

Observed but not changed (product decisions or outside this plan's code):

- Bot conversations cannot ask for approvals (`canAnswerInlineApproval` denies
  `botConversation` tasks), so a chat request needing `web_search` under the default
  access profile is refused, and a typed "approved" reply has no effect.
- A bot conversation started from the temporary workspace scopes the work view there; the
  dialog offers no workspace switch, and seeded work in another workspace is invisible
  until that workspace is selected elsewhere.
- The review card does not say when a proposed file is outside the responsibility's
  permitted actions; the "Require review for every external action" label also covers
  local workspace writes.
- While a bot's future runs are paused, its Scheduled entry still shows the next run time
  without a paused label (the run would be skipped).
- The free model emitted Python-style `<tool_code>` text and kept probing unselected paths;
  the executor's cross-step "failed 6 times" block then refused even selected reads.
  These are model-quality and generic executor behaviors, not responsibility policy.

### Stage 98: decisions in bot chats and a simpler work view

The four product gaps from stage 97 were resolved the way ChatGPT Dots and Grok Bot
present them: decisions are asked inside the conversation and also listed as waiting;
stop and pause controls sit on the items they affect, with one bot-level Pause/Resume;
scheduled jobs show their timing and whether they will run.

- **Decisions in local bot chats.** `canAnswerInlineApproval` no longer excludes
  `botConversation` tasks; only channel-linked chats (`gatewayContext`) and the
  existing headless, CLI, sub-agent, automated and no-human-input cases are excluded.
  A local bot chat now pauses on the inline "Deny / Allow once" card, the roster says
  "Waiting for your decision", and the request appears in Needs you. Read-only web
  access (`web_search`, `web_fetch`) in such a chat uses one chat-scoped consent,
  "Allow for this chat", held by the tool registry and bound to the task's current
  authority fingerprint (`getTaskConsentAuthority`, now per approval type); a policy or
  access-profile change, a denial or the end of the task requires asking again. The
  user's access profile is unchanged. In the demo profile, one consent let the bot
  search and open six pages and answer; before this change every request was refused.
- **Work view redesign.** The header carries the bot's status, Pause bot / Resume bot,
  a menu for Stop all running work, Stop all and pause, and What this bot knows, plus
  refresh and close. Explanatory paragraphs and the receipt box were replaced by one
  plain status line with Details, Try again and Dismiss; settled results from earlier
  sessions are not replayed on open. Items have their own Respond, Open and Stop
  actions. Responsibilities, notifications and memory moved to a Setup tab with
  consistent cards; responsibility controls read On/Off/Paused with Run now, Pause,
  Resume, Turn on and Turn off. Notification copy was rewritten in plain language,
  with recent deliveries collapsed.
- **Workspace switch.** The dialog lists saved workspaces with the bot's item count and
  starts on the busiest one when opened from an empty temporary workspace.
- **Paused schedules.** Scheduled items owned by a paused responsibility, or listed
  while the bot is paused, are labeled Paused and show no next run.
- **Review grant flag.** A responsibility write review now carries `targetGrant`
  (permitted, granted files), computed by a read-only unit and covered by the
  approval revision hash. The card says when the file is one the responsibility may
  write and warns when it is not. The review-boundary checkbox now reads "Ask before
  every action, even permitted ones".

Validation: `npm run test` passed 1,248 files (13,998 tests); type-check, lint,
Electron, daemon and renderer builds, SQLite audit and ratchet passed. New and updated
tests cover the inline-approval policy for bot chats, the chat consent card, the
registry's chat consent caching and invalidation, paused schedule labels and the
grant flag in the combined acceptance run. The behavior was exercised in the desktop
app on the demo profile with the user's configured model.
