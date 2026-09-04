# CoWork OS Work Session Model

**Status:** current product and architecture concept
**Last updated:** 2026-09-02

CoWork OS is a local-first, contract-driven work-session runtime. A task is not
only a prompt and a final answer: it is a governed session that carries its
objective, constraints, progress, evidence, artifacts, approvals, waits,
operator actions, and terminal outcome across the desktop UI, CLI, agents,
automations, channels, and managed-agent surfaces.

This document is the canonical record of the latest work-session roadmap and
its deliberate boundaries. It complements the implementation guides for
[Session Runtime](session-runtime.md), [Managed Agents](managed-agents.md),
[Task Automations](task-automations.md), [Web Page Artifacts](web-page-artifacts.md),
and [Access Profiles](access-profiles.md).

## Product promise

For every meaningful run, CoWork should make four things true:

1. **Continuity:** the system can reconstruct what the operator asked for,
   what the agent learned, what constraints changed, what is waiting, and what
   remains to be done.
2. **Truthful completion:** a task does not claim success when required work,
   verification, delivery, or user input is still outstanding.
3. **Evidence and artifacts:** important outputs retain their source,
   revision, checksum, and relationship to the work that produced them.
4. **Governed agency:** permissions, approvals, external side effects,
   unattended behavior, and operator handoffs are explicit and auditable.

The model is intentionally additive. CoWork keeps its multi-provider routing,
browser and device control, connectors, visual workbenches, channels, memory,
automation, orchestration, and local/private-workspace ownership. The work
session model gives those capabilities a shared lifecycle and evidence
contract; it does not replace them with one provider-specific runtime.

## Canonical ownership model

The runtime has three related levels:

```text
ManagedSession / Task
        |
        +-- Turn: one active or completed reasoning/execution cycle
        |       |
        |       +-- Item: message, tool call/result, approval, artifact,
        |                   checkpoint, evidence, wait, or status event
        |
        +-- SessionRuntime: mutable execution state, recovery, snapshots,
        |                   checklists, prompt cache, and task projection
        |
        +-- Durable stores: task events, transcript spans/checkpoints,
                            artifacts, approvals, outcomes, and audit records
```

`ManagedSession` is the stable control-plane resource for a reusable managed
run. `Task` remains the execution worker and `SessionRuntime` remains the owner
of mutable task-session state. A managed session normally points to one
backing task and, for team mode, may also point to a backing team run. Ordinary
tasks continue to work without becoming managed resources.

The renderer, CLI, Control Plane, channels, and Agents Hub are projections and
entry points. They must not invent a second lifecycle or silently mutate a
completed task. Terminal state is derived from persisted state before resume,
follow-up, or completion events are accepted.

## Harness roadmap Phase 3: canonical protocol rollout

The repository now contains an additive v1 `WorkSession -> Turn -> Item`
protocol. `Task` and `TaskEvent` remain compatibility projections while the
protocol is populated from persisted task events. Session creation, root-turn
creation, and the first session item are transactional; item sequences are
SQLite-serialized and monotonic per session; source-event and idempotency keys
make retries safe; payloads and policy snapshots are bounded and redacted;
replay exposes a deterministic checksum. Follow-up transports may include an
`expectedTurnId` so stale steering is rejected before task state is mutated.

The current boundary is dual-write and legacy-read compatible. Provider-specific
event shapes are mapped to typed item kinds, but the renderer and external
clients will continue reading the existing task timeline until the protocol
projection is proven equivalent across the supported transports.

## Harness roadmap Phase 4: contracts, evidence, waits, and child sessions

The canonical stream now has a durable contract layer. Each session can carry
an `OutcomeContract` with required outputs and verification criteria, a
`ConstraintLedger` for policy/decision/assumption changes, and an
`EvidenceManifest` whose entries retain source, freshness, confidence, and
contradiction status. Metadata is redacted before persistence and each
collection exposes a deterministic checksum for replay and audit consumers.

Artifact output is append-only by path: `ArtifactRevision` records the
content hash, size, parent revision, creator, and committed/superseded state.
Approval, input, pause, reconnect, child, and external dependencies are
represented as restartable `WaitState` records with request/idempotency keys,
expiry, and explicit resolution. Runtime interruption, continuation, safety,
mode-gate, reconnect, and child-wait events are projected into the corresponding
pause/external/reconnect/child wait kinds. A generic resume clears lifecycle
blockers but deliberately leaves approval and structured-input waits pending
until their explicit response. A terminal task resolves outstanding waits and
updates its outcome contract before the compatibility timeline is treated as
complete.

Child tasks retain their legacy grouping/session fields, but each child gets a
distinct canonical protocol session. The child link persists inherited policy,
owner, isolation key, and `complete | partial | failed` outcome; a parent can
therefore aggregate children without treating a partial or failed branch as a
successful run. The compatibility projection remains in place while these
records become the durable source for recovery and inspection.

## Harness roadmap Phase 5: incremental projections, observability, and replay

Phase 5 keeps the canonical item stream append-only and moves hot-path
bookkeeping into separate, rebuildable records:

- `WorkSessionProjectionRepository` persists a reducer state and cursor per
  session/projection. Each update queries only items with a sequence greater
  than the cursor (`O(delta)`), while a configurable item/time cadence computes
  a full-rebuild checksum and records whether the incremental and full states
  match. A cursor that is ahead of the stream is reset safely and rebuilt from
  sequence zero.
- `WorkSessionActivityLeaseRepository` stores short-lived, token-hashed
  liveness leases for LLM work, tools, retries, waits, joins, and reconnects.
  Only known activity/wait events create leases; ordinary `log` and step
  telemetry remains metrics-only. End events close an existing operation by its
  durable identity without creating a new lease. Leases can be renewed without
  knowing which provider is active, expire after a missed heartbeat, and are
  released on resolution or terminal cleanup.
- `WorkSessionOperationalMetricsRepository` stores bounded counters/samples
  outside the user timeline. Names, dimensions, values, and retention are
  capped; credential-like dimension keys and values are dropped before SQLite.
- `WorkSessionReplayEvaluationService` replays cloned canonical items in an
  isolated reducer, then compares chunked/incremental and full-rebuild
  checksums. The deterministic fixture suite covers crash recovery, compaction,
  approval, credential redaction, policy revocation, and child-session joins,
  including false-success, duplicate-side-effect, credential-leak, and
  authorization-bypass findings. User-action terminal statuses and blocker
  events replay as `waiting`, so an eval assertion cannot silently skip a
  `needs_user_action` outcome.
- `WorkSessionRolloutService` assigns a stable workspace/session cohort and
  exposes a single read-mode switch. `legacyReadRollback` is checked before
  cohort assignment, so operators can immediately return reads to the legacy
  Task/TaskEvent projection without changing writes or deleting data.

The existing `scripts/qa/run_eval_suite.cjs` deterministic mode now uses the
isolated replay evaluator rather than grading only the source task snapshot;
the fixture suite runs on every deterministic evaluation invocation. This keeps
the legacy compatibility read path available while vNext projections can be
canaried and compared in production.

## Lifecycle contract

A work session may move through these states:

```text
pending -> executing -> completed
                    \-> partial_success
                    \-> failed
                    \-> cancelled
                    \-> paused / needs_user_action -> executing
```

The exact task status vocabulary remains defined by the shared task contract.
The important behavioral rules are:

- a pause for approval, structured input, or unattended input is durable and
  visible as a wait, not an unexplained failure;
- a process restart rebuilds state from the database, transcript/checkpoint,
  and event history rather than renderer memory;
- compaction preserves a structured summary and the evidence needed for a
  later continuation;
- a follow-up after completion creates a valid continuation path without
  reopening a terminal task accidentally;
- cancellation and timeout are distinct from provider failure;
- verification can downgrade an apparent result to partial success or needs
  user action when the required contract was not met;
- every externally visible terminal outcome has a persisted reason and the
  relevant evidence or missing-evidence explanation.

## Roadmap status

The roadmap below records the implemented scope and the deliberate decisions
made during review. “Implemented” means the current repository contains the
runtime/UI contract and regression coverage; it does not mean every possible
provider or deployment mode is supported.

| Phase | Capability | Status and acceptance boundary |
|---|---|---|
| 1 | Runtime and lifecycle foundation | Implemented. Acceptance is contract- and regression-test based; a real first task is **not** required as a Phase 1 acceptance condition. |
| 2 | Durable continuity, recovery, and truthful runtime visibility | Implemented across task/session runtime, checkpoints, compaction, waits, projections, and recovery paths. |
| 3 | Controlled multi-person/session collaboration | Implemented with session membership, owner/reviewer/contributor roles, one-use invites, revocation, presence/audit, and approval attribution. Session membership is separate from workspace membership. |
| 4 | Safe autonomy and protected credentials | Implemented with exact-operation recurring approvals, expiry/revocation, replay resistance, protected credential entry, destination controls, and value-free audit records. |
| 5 | Cloud-mode/Sites parity | Intentionally skipped. Cloud runtime and Sites are outside the current CoWork product boundary. |
| 6 | Portable continuity | Implemented as an explicit durable handoff package. Live process transfer is not required for acceptance and is not claimed. |
| 7 | Local preview/dev-server lifecycle | Implemented as opt-in local preview. It is workspace-bound, command-template based, loopback-only, health-checked, logged, cleanable, and registered in the exact browser preview allowlist. |
| 8 | Automation and security polish | Implemented for stable outcome hashing, per-job deduplication, explicit delivery retry, unattended-run escalation, missed-run policy, timezone visibility, job health, retry/backoff/audit visibility, and export risk-chain summaries. |

## Phase 6: durable handoff packages

Handoff is a file-based continuity boundary between local CoWork sessions or
installations. It is designed to preserve useful context without pretending
that a live process, browser profile, credential, or cloud runtime can be
moved safely.

### Export

An operator explicitly exports a managed session. CoWork writes a versioned
package under:

```text
<workspace>/.cowork/handoffs/<package-id>/
  manifest.json
  artifacts/<verified-copies>
```

The manifest contains:

- package kind and schema version;
- package and source-session identifiers;
- source task, workspace, agent, environment, branch, and status metadata;
- bounded recent transcript/event data;
- the latest available checkpoint;
- bounded artifact metadata and copied artifact references;
- export timestamp and warnings.

Export sanitizes credential-like values and sensitive fields, ignores unsafe
filenames and symlink escapes, limits transcript/artifact/package sizes, and
computes checksums from the copied source. The package is provenance, not a
secret backup.

### Import and resume

An operator explicitly selects a manifest or package directory. Import:

1. validates the package kind, schema, identifiers, size, and shape;
2. creates a new managed session in a selected local environment;
3. passes bounded package context to the new run as untrusted data;
4. verifies and copies safe artifacts into the target workspace;
5. records `resumedFromSessionId` and session lineage;
6. reports skipped files or warnings instead of silently claiming a full copy.

Normal access profiles, approvals, connector policy, and provider settings
apply to the resumed run. Import never transfers credentials, browser cookies,
live processes, remote runtime state, or hidden approval grants.

See [Managed Agents — Durable Session Handoffs](managed-agents.md#durable-session-handoffs)
for the operator-facing workflow and
`src/electron/managed/ManagedSessionService.ts` for the implementation.

## Phase 7: local preview

CoWork previews static HTML and built outputs by default. A user may explicitly
start a local preview server when a project has no built entrypoint.

The preview service provides:

- start, stop, and restart operations;
- a working directory contained by the selected workspace;
- a small approved command-template set;
- loopback-only `HOST`/`HOSTNAME` binding;
- collision-safe port allocation;
- readiness health checks;
- bounded, redacted log streaming;
- process-tree cleanup on stop, crash, or startup timeout;
- exact URL registration and revocation through the Browser Workbench
  local-preview allowlist.

The service does not infer consent from a project file. It does not install
dependencies, run arbitrary package scripts, or launch a server merely because
it detects React, Vite, Next, or another web framework. See
[Web Page Artifacts — Optional Local Preview Server](web-page-artifacts.md#optional-local-preview-server).

## Phase 8: automation semantics

### Stable output identity

Automation results use a canonical representation before hashing: object keys
are ordered deterministically and evidence references are normalized and
sorted. The resulting hash covers the meaningful result and artifact/evidence
set, not incidental object ordering.

Notification identity is scoped to the owning automation source and its most
specific stable owner. In particular, scheduled-task deduplication is **per
job**, not global across jobs that happen to produce the same text.

### Identical output and delivery

An unchanged scheduled output is recorded but its automatic channel delivery is
suppressed. It is marked as skipped with an operator-visible reason. The only
way to send that identical output again is an explicit **Retry delivery**
action from run history or the corresponding IPC/API call.

Manual retry behavior is deliberately separate from scheduling:

- it does not create another scheduled run;
- it uses a fresh delivery idempotency key;
- it records the manual attempt and result in run history/audit data;
- a failed direct retry can enter the normal outbox retry path;
- automatic scheduling still uses the per-job stable-output rule.

### Unattended and restarted runs

Each scheduled job declares how required human input is handled: notify and
pause, or fail and notify. Each job also declares its missed-run policy after
restart: run once, skip silently, or skip and notify. The UI exposes timezone
preview/confirmation, job health, retry/backoff state, next attempt, and
delivery audit results.

See [Task Automations](task-automations.md) for configuration and
`src/electron/cron/service.ts` for delivery/run-history behavior.

## Security concept

The Electron renderer is a trusted local application component by design. It
receives the typed preload API and is allowed to render and operate the local
product surface. This decision avoids adding a fictional second security model
inside the desktop UI.

Renderer trust does not make external content trustworthy. The following remain
untrusted and must be handled as data:

- web pages and browser content;
- imported files, PDFs, channel attachments, and handoff packages;
- connector responses and MCP payloads;
- generated artifacts before verification;
- model-provided instructions embedded in any of the above.

The security boundary therefore remains in access-profile resolution, main-
process tool enforcement, filesystem/domain containment, approval policy,
artifact validation, output/export classification, and audit records. A
sandboxed artifact iframe protects the preview surface, but it is not a new
authorization mode. The renderer cannot grant a task broader filesystem,
network, command, connector, or export access.

Before a sensitive export or external side effect, the operator should be able
to see the risk chain:

```text
untrusted source
  -> private/local data
  -> external side effect
  -> destination
```

This explains why an action needs approval without exposing credential values
or relying on opaque “safe/unsafe” labels.

## Non-goals and intentional boundaries

- No cloud-mode or Sites implementation (the separate product roadmap Phase 5 remains intentionally skipped).
- No live runtime migration between machines; use a durable handoff package.
- No implicit browser-cookie or profile transfer.
- No automatic dependency installation or arbitrary project command execution
  for local previews.
- No global deduplication of unrelated automation jobs.
- No automatic resend of identical scheduled output.
- No claim that a handoff package is a complete database/profile backup.
- No requirement that Phase 1 execute a real first task as acceptance proof.

## Implementation map

| Concern | Primary implementation | Operator documentation |
|---|---|---|
| Managed sessions and handoff | `src/electron/managed/ManagedSessionService.ts`, `src/shared/types.ts` | [Managed Agents](managed-agents.md) |
| Session runtime and recovery | `src/electron/agent/runtime/SessionRuntime.ts`, `src/electron/agent/runtime/turn-kernel.ts` | [Session Runtime](session-runtime.md), [Execution Runtime Model](execution-runtime-model.md) |
| Membership and collaboration | `src/electron/workspaces/SessionMembershipService.ts` | [Managed Agents](managed-agents.md), [Mission Control](mission-control.md) |
| Recurring approvals and credentials | `src/electron/security/recurring-approval-service.ts`, `src/electron/security/protected-credential-service.ts` | [Access Profiles](access-profiles.md), [Security Guide](security-guide.md) |
| Scheduled delivery and dedupe | `src/electron/cron/service.ts`, `src/renderer/components/ScheduledTasksSettings.tsx` | [Task Automations](task-automations.md) |
| Automation outcome hashes | `src/electron/automation/AutomationOutcomeService.ts` | [Core Automation](core-automation.md), [Task Automations](task-automations.md) |
| Local preview lifecycle | `src/electron/preview/LocalPreviewProcessService.ts`, `src/shared/local-preview.ts` | [Web Page Artifacts](web-page-artifacts.md), [Browser Workbench](browser-workbench.md) |
| Risk-chain explanation | `src/shared/export-risk-chain.ts`, approval/export UI | [Security Model](security/security-model.md), [Trust Boundaries](security/trust-boundaries.md) |
| Incremental projections, leases, metrics, replay, rollout | `src/electron/database/WorkSessionProjectionRepository.ts`, `src/electron/database/WorkSessionActivityLeaseRepository.ts`, `src/electron/database/WorkSessionOperationalMetricsRepository.ts`, `src/electron/sessions/WorkSessionReliabilityService.ts`, `src/electron/sessions/WorkSessionReplayEvaluationService.ts`, `src/electron/sessions/WorkSessionRolloutService.ts` | This section |
| Renderer/preload contract | `src/electron/preload.ts`, `src/electron/ipc/handlers.ts`, `src/shared/types.ts` | [Architecture](architecture.md) |

## Verification expectations

Feature changes should include focused regression coverage and then the normal
repository checks. The current implementation has coverage for:

- session membership authorization, invite replay resistance, revocation, and
  approval attribution;
- protected credential masking, destination restrictions, and recurring
  approval expiry/revocation;
- canonical automation hashes and per-job scheduled-output delivery;
- explicit identical-output delivery retry and outbox reconciliation;
- local-preview health, log redaction, restart, timeout cleanup, and URL
  revocation;
- handoff export sanitization, artifact checksum verification, import lineage,
  and restored artifact registration.

Useful commands:

```bash
npm run type-check
npm run build:electron
npm run build:react
npx vitest run src/electron/cron/__tests__/service.test.ts \
  src/electron/managed/__tests__/ManagedSessionService.test.ts \
  src/electron/preview/__tests__/LocalPreviewProcessService.test.ts \
  src/electron/automation/__tests__/AutomationOutcomeService.test.ts
npm test -- --run
```
