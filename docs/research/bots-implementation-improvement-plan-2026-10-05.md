# Bots implementation improvement plan

Date: 5 October 2026. Source baseline: working tree on top of
`596d8ed5fb4e7d16378452dfffa345795bd5b85e`, including existing local changes.

Improve the shared bot implementation so any user-created bot can own ongoing
work, expose its progress and evidence, recover after interruption, and ask for
decisions through the user's chosen channel. Bot names, personalities, models,
and team membership remain user configuration. No named personal bot is a
product default or a dependency of this plan.

This is an implementation plan, not an implementation or runtime validation
report. The findings below were checked in source. No bot execution, channel
approval, unattended run, or migration was tested for this plan. The supporting
[Dots research](/Users/mesut/Downloads/app/cowork/docs/research/chatgpt-dots-bots-roadmap-2026-10-05.md)
documents the external product patterns; the scope here is CoWork's own runtime.

## Implementation progress

All nine deliveries are implemented. The plan's final acceptance passes locally in one
isolated profile (`npm run qa:bots:final`), across four Node daemon and two desktop
lifetimes with a deterministic local provider: bot lifecycle, work projection,
scheduled and manual responsibilities, the desktop/headless boundary, an exact write
approval that survives a crash, stop and pause controls, crash recovery around
reservation, task creation, approval wait and provider response, Memory Hub
correction and forgetting, and the outcome metrics baseline. An upgrade from the
previous release (`596d8ed5f`) preserves user bots, the legacy named roster, teams,
history and decisions. Current evidence and per-stage detail are in the
[completion audit](/Users/mesut/Downloads/app/cowork/docs/research/bots-implementation-completion-audit.md).

What a local run cannot prove is still open: authenticated delivery to authorized
Slack and Teams test destinations, a run against a real model provider, remote CI on
a pushed branch, and a packaged desktop build. Atlas, Forge and Scribe remain private
user configuration with no product-default assumptions. The findings below are the
original source baseline, not current defects.

## Current findings and intended changes

| Source finding                                                                                                                                                                                                                                                                                                                                              | Implementation consequence                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [bot-team.ts](/Users/mesut/Downloads/app/cowork/src/electron/agents/bot-team.ts:10) seeds a named roster and can append collaboration text to matching custom roles. [Startup](/Users/mesut/Downloads/app/cowork/src/electron/main.ts:554) and [conversation recovery](/Users/mesut/Downloads/app/cowork/src/electron/agent/daemon.ts:4585) call this path. | Separate user identity from bootstrap, recovery, and collaboration policy. Preserve existing records instead of interpreting their names as product roles.                         |
| [BotDetailsRail](/Users/mesut/Downloads/app/cowork/src/renderer/components/BotDetailsRail.tsx:99) is centered on a conversation, profile, and notifications.                                                                                                                                                                                                | Add a work projection that includes ordinary tasks assigned to the bot, responsibilities, waits, and outcomes.                                                                     |
| Heartbeat, event triggers, and routines are initialized in Electron; the inspected [Node startup](/Users/mesut/Downloads/app/cowork/src/daemon/main.ts:459) initializes cron but does not initialize those services.                                                                                                                                        | Establish an explicit capability matrix and shared service lifecycle before enabling the same responsibilities in both runtimes. This source gap still needs runtime reproduction. |
| [BackgroundDispatchBudget](/Users/mesut/Downloads/app/cowork/src/electron/agents/BackgroundDispatchBudget.ts:12) resets its shared ledger on restart.                                                                                                                                                                                                       | Persist atomic reservations, cooldowns, and dispatch identities across background producers.                                                                                       |
| The heartbeat [runbook branch](/Users/mesut/Downloads/app/cowork/src/electron/agents/HeartbeatDispatchEngine.ts:164) records that work is due without executing it.                                                                                                                                                                                         | Bind responsibilities to supported executable routines; show unsupported runbooks honestly until an executor exists.                                                               |
| Slack and Teams currently send text; the gateway's [pending approval routing](/Users/mesut/Downloads/app/cowork/src/electron/gateway/router.ts:7748) uses an in-memory map, while [ApprovalStore](/Users/mesut/Downloads/app/cowork/src/electron/database/repositories.ts:4324) already persists approvals.                                                 | Add native decision messages and durable transport mappings around the existing approval authority.                                                                                |

## Architecture and compatibility rules

Keep the existing authoritative records:

| Concern                   | Existing authority                                             | Planned addition                                                                          |
| ------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Bot identity              | `agent_roles` / `AgentRole`                                    | Generic lifecycle rules; no second identity store.                                        |
| Conversation              | `tasks` + `task_events`, explicitly `botConversation === true` | Continue using existing conversation and lifecycle projections.                           |
| Work                      | Assigned tasks, child links, WorkSessions, WorkContexts        | A bounded bot work query and derived summary.                                             |
| Collaboration             | Workspace-scoped teams and explicit membership                 | Optional team association independent of identity or display name.                        |
| Responsibility            | Routines, triggers, role mandates, context bindings            | A typed bot-to-responsibility binding only where existing fields cannot express it.       |
| Permissions and decisions | Access profiles, workspace policies, approvals                 | Responsibility scope and exact action revision; existing enforcement stays authoritative. |
| Memory and evidence       | Memory Hub, WorkSession contracts and artifact revisions       | Scoped entry points and provenance in bot results.                                        |

Role records currently live in the app profile database. That storage scope does
not make a user's custom identity a bundled product bot. Keep bot configuration
separate from workspace-scoped work and team authorization. Do not introduce
multi-user ownership or new administrative privileges as part of this plan.

Use stable IDs for references. Display names and handles may change; they must
never determine permission, migration eligibility, routing fallback, or leadership.
Opening a bot, listing its work, and viewing its memory must remain read-only and
must not call a model or create a team.

## 1. Make bot lifecycle independent of names

**Deliverable:** a bot can be created, opened, edited, reopened, deactivated, and
used without a seeded roster or a team.

- Remove custom-roster seeding from normal startup, peer listing, and recovery.
  Keep the separate system-role/template catalog distinct from custom bot data.
  Optional templates require an explicit user selection and create new identities.
- Replace default-team attachment with an optional, explicitly chosen team ID.
  Reopening a standalone conversation must work without creating a team. Peer
  discovery returns only verified members of the selected team and has no fallback
  to a global named roster.
- Preserve workspace, active-team, membership, and sender checks for peer messaging.
  A stale team reference or revoked membership must not be silently repaired.
  A standalone bot can execute assigned work; peer messaging is unavailable until
  the user explicitly configures collaboration.
- Generate generic collaboration guidance from verified runtime membership and
  handoff metadata. Route replies to the actual requester by ID and durable receipt.
  Do not rewrite custom prompts during startup or recovery.
- Replace name-based temporary-workspace exceptions with an explicit branching
  action that creates a fresh conversation in the target workspace. It must not
  copy foreign transcripts or grant foreign team membership.

**Migration:** keep existing role IDs, prompts, models, active states, team IDs,
membership, histories, and links. Stop seeding and rewriting on future runs; do
not rename, delete, reclassify, or strip user text based on a name or old marker.
An explicit existing team remains usable. Deactivated bots stay deactivated after
restart. Update the bots guide's default-roster language when this code change ships.

**Acceptance:** use generated-ID fixtures with arbitrary names, zero bots, one bot
without a team, and a user-configured team. Renaming a bot preserves its work and
routing. Repeated startup and recovery create no roles, teams, or prompt changes.
Revoked membership cannot be restored through a normal reopen or a peer-list query.

## 2. Add one bot work projection and a useful work view

**Deliverable:** a bot exposes **Needs you**, **Working**, **Scheduled**, and
**Results**, with conversation history available separately.

Implement a shared query service over existing repositories, exposed through
desktop IPC and the authenticated Control Plane using their current permissions.
A proposed request contains `workspaceId`, `agentRoleId`, view, cursor, and a
capped page size. Enforce the workspace scope in the query service, not only the UI.

Include ordinary assigned tasks, the bot conversation, linked responsibility runs,
and authorized descendants. Keep direct assignment and delegated work visibly
distinct; do not include every task executed by another bot or every task sharing
a team. Deduplicate a run visible through more than one relationship.

Derive waits, execution state, last verified result, next wake, and runtime
availability from existing WorkSession and bot lifecycle projections. A finished
turn does not make a durable conversation unavailable; a completed task does not
prove delivery. A wait for a child or external dependency belongs in work status,
while a required human decision belongs in **Needs you**.

Extend the existing bot pane/details components using the product's theme. Keep
basic profile editing compact; expose responsibilities, context, and permissions
through separate details. Use bounded summary payloads and incremental updates
rather than loading full transcripts or rescanning all tasks on every event.

**Acceptance:** a bot with no conversation can still show assigned work. A
non-conversation task and its child appear once with correct ownership. Another
workspace's tasks stay excluded. Switching bots or workspaces cancels stale loads.
Opening the view causes no execution. Use the existing renderer performance
fixtures if the changes affect task loading or event streaming.

## 3. Make automation durable and explicit about availability

**Deliverable:** supported responsibilities survive restart and do not multiply
because two background producers or runtimes observe the same event.

- Extract shared automation startup/shutdown with injected dependencies for
  HeartbeatService, EventTriggerService, RoutineService, and cron. Report which
  capabilities are ready in each runtime. Start workers after database migration,
  policy initialization, and recovery prerequisites.
- Persist workspace dispatch reservations and entity cooldowns. Preserve existing
  limits and manual-run semantics; task-count limits are separate from model cost
  budgets. Reserve atomically, associate the ticket with the resulting task, and
  refund confirmed task-creation failures.
- Persist trigger occurrence identity, responsibility revision, next wake, and
  dispatch linkage. Deduplicate across producers using a canonical occurrence key.
  Define schedule timezone, daylight-saving behavior, and missed-run policy; avoid
  an unbounded catch-up burst after downtime.
- Use one scheduler owner per profile database/automation scope with a durable
  lease and fencing checks. Reuse existing lease mechanisms where their scope fits;
  do not assume session activity leases already coordinate the scheduler. A remote
  backend uses an explicit assignment/handoff, not SQLite synchronization across hosts.
- Recover queued work and persisted waits without recreating external actions.
  Record action intent and delivery receipts. Use provider idempotency when
  available; an ambiguous remote outcome requires reconciliation before retry.
- Distinguish running, offline, disconnected, unsupported, and waiting for desktop.
  Node availability covers supported server tools; it does not supply a persistent
  GUI computer. Show the selected execution backend in work details.

**Acceptance:** race two producers for one event and one remaining budget ticket;
only the allowed dispatch is created. Restart after reservation, task creation,
approval wait, and attempted delivery. Cooldowns and budgets persist, expired
leases recover safely, and uncertain delivery remains uncertain. Test actual
Node-compatible work with Electron offline and a GUI request that waits correctly.

## 4. Turn responsibilities into governed executable work

**Deliverable:** “Give this bot a responsibility” creates an inspectable, editable
definition with a preview of its next run.

Capture objective, selected sources, trigger/schedule, expected output, permitted
actions, review boundary, notification destination, execution backend, and budget.
Keep trigger and execution in existing routine/automation services. Add a typed
binding containing bot ID, workspace ID, routine/trigger references, context
reference, and policy revision only where needed. A definition revision must be
visible on each run; editing it cannot retroactively authorize a pending action.

Provide **Observe**, **Propose**, and **Act within granted scope** behaviors enforced
by the runtime. Observe reads only selected permitted sources and produces an
internal result. Propose prepares an inspectable draft. Act performs only actions
already authorized by the responsibility and current workspace policy; other
actions use the existing approval path.

The current [read-only access profile](/Users/mesut/Downloads/app/cowork/src/electron/security/access-profile-resolver.ts:273)
restricts network, shell, and computer effects. Do not loosen it to enable connected
source monitoring. Use existing scoped ingestion, or declare and validate an
allowlist of connector read methods with source-specific scope. Unknown methods
remain unavailable. Child scope must never exceed parent or workspace scope.

Account-scoped mailbox reads are now an explicit supported adapter: responsibility
sources can select only mailbox/list_threads or mailbox/get_thread for one configured
account. Runtime list queries force that account; thread retrieval checks account
ownership before loading messages and omits relationship research. This adapter
does not grant mailbox writes.

Use WorkContexts for a concise brief and selected references rather than copying
every conversation. Preserve source and sender provenance. Untrusted source text
cannot change the responsibility, enable tools, grant sharing rights, or approve an
action. Preview the first run; creation alone must not unexpectedly start it.

Existing runbooks that only record due work should display that limitation or be
translated into a supported routine. Do not report them as executed outcomes.

**Acceptance:** configure two independent responsibilities on an arbitrary bot,
preview them, run one, revise the other, and inspect their separate lineage.
Observe cannot write to a connected app. An unapproved destination or policy
change blocks execution. Replayed events produce one run. No-signal cycles stay
quiet and do not continuously call a model.

## 5. Add controls, trustworthy results, and scoped memory access

**Deliverable:** the user can understand what the bot did, correct its context,
and control current and future work separately.

Expose **Stop this turn**, **Stop this bot's active work**, **Pause future runs**,
and **Stop and pause**. Persist pause/control state and return a receipt listing
affected runs and any work that remains active. Limit controls to the selected
workspace and verified task lineage. Recheck pause/deactivation before dispatch
and before effects; handle the race with a due trigger. Resume does not resolve a
pending approval or replay a completed action. Bot deletion deactivates its bound
automation and prevents channels from silently rerouting to another bot.

Keep the existing finish/input notification policy. Add destination, quiet hours,
and digest options around it, with notification identities and delivery receipts.
Notify on required decisions, meaningful results, and failures. Avoid repeated
“still working” messages or unchanged heartbeat updates.

Build result cards from WorkSession contracts: objective, output links, requirement
checks, evidence revision, and delivery status. Distinguish draft created, locally
validated, remotely checked, and delivered. A model's completion claim is not proof.

Add a **Context and memory** entry point using the existing Memory Hub. Apply
workspace, caller, subject, and audience restrictions. Show source and date, plus
task/bot attribution where stored. Label unattributed historical knowledge as
shared workspace context; do not invent bot ownership. If provenance is missing,
add it to the existing memory records rather than create a second memory engine.
Correction/forget actions must update applicable retrieval indexes and derived
context. Explain disconnecting a source separately from forgetting retained data.

**Acceptance:** stop/pause during dispatch and restart; no new run slips through.
Other bots' unrelated work continues. A missing artifact or failed delivery cannot
produce a verified result. Correct a remembered fact, start a fresh run, and confirm
retrieval uses the correction. Private owner context remains unavailable to group
or third-party channel audiences.

## 6. Add channel continuity and durable decision messages

**Deliverable:** Slack first, then Teams, can show progress and resolve a concrete
decision for the same bot and work item.

Expose explicit channel-to-bot binding over existing gateway routing. Preserve
verified sender identity, thread provenance, and audience scope. A paired or
allowlisted sender is not automatically the owner. Cross-channel continuity shares
authorized work references and summaries; it does not merge private transcripts.

Extend the outgoing message contract with typed result/decision payloads and
adapter capability flags. Render Slack Block Kit and Teams Adaptive Cards using
the current adapters, with text fallback for unsupported clients and channels.
Offer approve, request changes, open result, and stop only when supported by the
underlying runtime operation.

Keep ApprovalStore as the authority. Persist channel routing and message identifiers
needed to recover pending decisions. Bind actionable messages to the approval ID,
task, workspace, bot, authorized actor, exact draft revision/hash, destination,
expiry, and single-use action identity. Typed approval delivery requires the
originating task to carry an explicit private gateway context and binds the decision
actor to the persisted task requester; group/public contexts, missing legacy context,
and a different requester fail closed. Transport authenticity and actor authorization
are separate checks. Validate both, then atomically resolve the pending request and
recheck current permissions before execution. Derive displayed expiry from the
stored deadline. Recover a decision route after restart without widening authority.

**Acceptance:** valid approval succeeds once; a duplicate click, stale draft, wrong
actor, revoked permission, expired request, or forged callback cannot execute.
Group/public context, missing origin context, or a different session requester cannot
publish a decision. Restart with an approval outstanding and retain the route. A child
request reaches the actual originating requester. Test fallback clients and verify
real delivery through authenticated test channels before claiming channel support.

## Delivery sequence and release gates

Use small, reviewable changes. No new default bots, coordinator hierarchy, model
provider migration, remote-computer provisioning, or voice stack is required.

| Change                                        | Depends on | Reviewable outcome                                                |
| --------------------------------------------- | ---------- | ----------------------------------------------------------------- |
| 1. Generic lifecycle and compatibility        | None       | Name-independent standalone bots; existing records preserved.     |
| 2. Shared work query                          | 1          | Scoped, paginated work projection and API contracts.              |
| 3. Work UI                                    | 2          | Work tabs, waits, runtime availability, and output navigation.    |
| 4. Shared automation lifecycle                | 1          | Capability matrix and desktop/Node initialization parity.         |
| 5. Durable dispatch/recovery                  | 4          | Reservations, deduplication, scheduler ownership, and recovery.   |
| 6. Responsibility setup and policy            | 2, 5       | Previewable definitions bound to existing execution services.     |
| 7. Controls, results, and memory entry points | 3, 6       | Pause/stop receipts, proof-based results, and scoped context.     |
| 8. Slack decision support                     | 5, 7       | Authenticated durable decisions and verified delivery.            |
| 9. Teams decision support                     | 8          | Equivalent behavior with adapter-specific rendering and fallback. |

The first core release requires changes 1–7. Existing channel behavior remains
compatible while changes 8–9 are introduced. Voice coordination and persistent
remote computers are later options, evaluated only after the core workflow passes.

During implementation, use the existing bot lifecycle, bot-team, role repository,
conversation query, daemon recovery, and renderer bot tests for changes 1–3.
Use heartbeat, dispatch-budget, trigger, routine, and WorkSession tests for 4–7.
Use access-profile, memory privacy/isolation, gateway sender-identity, gateway
persistence, and security tests wherever those boundaries change. Add focused
regressions for the acceptance cases above, using temporary arbitrary bot fixtures.

For affected TypeScript/runtime code, run appropriate type, formatting, lint,
renderer, Electron, and Node daemon build gates. Check scoped diffs. Any schema
change must pass both fresh-profile and representative older-profile migrations,
including custom prompts, renamed/deactivated bots, and pending work.

Roll out read projections first. Enable new dispatch and decision behavior behind
explicit rollout controls after migration and recovery tests pass. A disabled
feature must leave historical records readable and block its new dispatches;
do not rely on removing a pause or policy boundary to roll back. Preserve all
unrelated working-tree changes throughout delivery.

Final acceptance uses an isolated test profile: create an arbitrary bot, assign a
scheduled responsibility, inspect normal and delegated work if an explicit team
was configured, interrupt/restart, approve a concrete revision, and verify the
artifact and delivery. Record local tests, remote CI, and live runtime proof
separately. Do not attribute synthetic test work to the user's personal activity.

Track useful verified outcomes, unresolved human waits, duplicate dispatches and
effects, recovery failures, delivery failures, budget denials, idle model usage,
and work-view latency. Establish a baseline before setting numeric targets. Core
release gates are zero authorization bypasses, zero duplicate effects in replay
tests, preserved user data, and successful recovery in the defined scenarios.
