# Shared application execution backend

The Android `phone.android.v1` route adds selected-device phone-harness input, explicit approvals, screenshots, durable receipts, and fresh package/text readback. See [Android phone control](android-phone-control.md) for setup and its verification limits.

The backend carries application operations from a task's existing WorkSession through preparation, optional feedback, dispatch, observation, cancellation, and verification. It uses CoWork's existing tool coordinator and permissions. No model, vendor SDK, or application category owns the durable business state.

This is the shared foundation for the application pilots. It does not declare every legacy tool a qualified integration. The Excel/Photoshop pilots add bounded named adapters and native app commands. Browser and desktop conformance tests exercise controlled adapter states; they do not prove live GUI automation or isolation.

## Entry points

Agents discover `application_operation` through existing deferred tool search. Its actions are `capabilities`, `create`, `prepare`, `execute`, `get`, `list`, `reconcile`, `cancel`, and `review`. Task, session, and workspace ownership are supplied by the host. The agent cannot resolve its own feedback checkpoint or manually clear an unknown effect through this tool.

Both desktop and Node daemon expose the same Control Plane methods:

| Method | Scope | Purpose |
| --- | --- | --- |
| `application.capabilities` | read | Registered route descriptions and input schemas |
| `application.operation.create` | operator | Admit a request for an existing task |
| `application.operation.get` | read | Full operation, result projection, attempts, and events |
| `application.operation.list` | read | Task result projections |
| `application.operation.prepare` | operator | Prepare a concrete proposal or an explicitly unexecuted summary |
| `application.operation.execute` | operator | Request dispatch; continue only within decisions and limits |
| `application.operation.reconcile` | operator | Observe the original application's operation |
| `application.operation.cancel` | operator | Request cancellation without claiming rollback |
| `application.decision.resolve` | operator | Resolve the exact persisted decision binding |
| `application.operation.resolveUnknown` | operator | Record an explicit human observation of an unknown effect |

Read scope grants no lifecycle mutation. Underlying tool permissions still apply to operator-triggered execution. Adapter registration is an in-process host capability, never a model-provided JSON declaration.

## Request and adapter contracts

The versioned [shared schemas](../src/shared/application-execution.ts) contain:

- Operation identity, objective, input, plan revision, dependencies, optional decision, and constraints.
- Resources representing files, native projects, remote entities, queries, or application state, with system/account/tenant identity and optional versions.
- Routes separating protocol, control mechanism, and environment, with explicit readiness, preparation, observation, cancellation, and verification support.
- Prepared material, result variants, fresh evidence, execution status, verification status, and cancellation status.

For example, a host-qualified adapter can receive:

```json
{
  "idempotencyKey": "requested-change-1",
  "capability": "example.record.update",
  "routeId": "example.api.v1",
  "objective": "Apply the requested field change",
  "input": { "recordId": "record-42", "value": 7 },
  "resources": [
    { "kind": "remote_entity", "system": "example", "identity": "record-42", "accountId": "account-a", "version": "9" }
  ],
  "constraints": { "backgroundRequired": true, "maxAttempts": 1, "maxPolls": 120 }
}
```

This example is a contract, not a shipped example-app connector. A real adapter must validate that its input and resource references identify the same actual targets and account. It must implement authoritative readback and the application's concurrency rules. Local locks cannot prevent outside edits or revoke an already-issued request.

Register an `ApplicationAdapter` on [the catalog](../src/electron/applications/ApplicationAdapterCatalog.ts). Implement pure `validateInput`, `readiness`, and `execute`; implement and declare optional `prepare`, `observe`, `cancel`, and `verify` methods. Use `context.tools.call` for existing tools so the current task's restrictions, account context, permissions, and policy remain active. Preparing remote drafts and cancelling jobs are effects too.

A trusted adapter may also implement `authorize(context)` for approval only. It must not send application input or external effects. The operation holds its lease and resource locks while awaiting review, but the adapter execution deadline begins only after authorization succeeds. Cancellation or failure before this boundary is definitively not dispatched and releases the locks; after dispatch begins, interrupted effects retain the usual unknown/reconciliation rules.

Adapters return `running` with a stable external ID, `completed` with a typed result, `failed`, or `unknown`. Observation can additionally recover `prepared`, confirm `cancelled`, or report authoritative `not_applied`. A missing record is not sufficient proof of `not_applied`: the adapter must establish that the original request cannot still commit later. A preparation/cancellation lookup cannot make the final business action replayable.

The built-in `cowork.tool` bridge journals an existing tool call using `{ "name": "read_file", "arguments": { "path": "notes.txt" } }`. It is deliberately unqualified: no safe replay, background guarantee, external job observation, cancellation, or domain verifier is invented. Its returned tool result remains unverified. App pilots add qualified semantic adapters around the appropriate MCP/API/script/browser/computer capabilities.

Runtime-driver and controlled-tool interfaces remain provider neutral. The native runtime is wired today. Other runtime drivers are not part of this baseline.

## Durable execution and recovery

[ApplicationExecutionService](../src/electron/applications/ApplicationExecutionService.ts) coordinates operations. [The store](../src/electron/applications/application-operation-store.ts) journals requests, attempts, resource locks, and ordered events in one transaction before invoking an adapter. Repository units use the existing services-domain database port on both the host and database worker.

An idempotency key can only repeat the same request and route. The original adapter/version/environment remains pinned. Leases and generations prevent an expired worker from replacing current results. They do not provide remote fencing unless the adapter/application supports it.

Interrupted dispatch becomes unknown, retains its resource ownership, and is never blindly repeated through another route. Unknown effects also block direct mutations through the same task's normal tools; readback and current host-owned effectful attempts remain available. Observation/verifier attempts cannot issue mutating tools through that gateway. Shared resource locks and conservative workspace locks coordinate cooperating application operations.

Only original-route authoritative observation plus a declared replay guarantee can make an absent action eligible to retry. The logical operation ID remains the downstream idempotency key. Execution attempts, observation polls, deadlines, and adapter calls are bounded. Poll exhaustion preserves an unknown outcome rather than releasing potentially active work.

Long jobs return their external ID promptly. A timer polls through the adapter without holding an LLM turn open. Requested operations waiting for resources can dispatch when eligible. Startup recovers expired leases and resumes supported observations; shutdown aborts and drains local phase waiters. Local computation requires a running host; unavailable adapters remain unresolved rather than being substituted.

Cancellation is cooperative. A lost cancellation reply is reconciled rather than resent. Completed effects remain in the result; cancellation is never described as undo.

Task cancellation propagates to its application operations: queued proposals stop locally, in-flight phase waiters are interrupted, and cancellable jobs receive durable cancellation requests. Observation can continue to resolve already-issued effects. A terminal task cannot start new application work; an explicit follow-up run opens a new task turn without resurrecting its cancelled operations.

For an unsupported observation path, an operator may submit `operationId`, the displayed `expectedRevision`, a unique `resolutionKey`, `status` (`applied`, `not_applied`, or `stopped`), and a concrete `summary` to `resolveUnknown`. This is explicit human attestation, retains unavailable domain verification, fences late replies, and does not automatically retry or grant application permissions.

## Feedback and completion

Simple authorized work needs no decision. A request can specify `decision: { reason, question }`; preparation persists the material and binds feedback to the exact request, route, plan/resource versions, and prepared output. `review` uses the existing input UI. A late or duplicate response cannot authorize a different proposal. Feedback changes no permission grants.

`planRevision` and `supersedes` support revising an unsubmitted proposal. Supersession is allowed only when no final action was dispatched and preparation has no effects; old decisions and proposal history remain inspectable. Completed, running, unknown, or effectful preparation cannot be erased by replanning. Compensation or another applied change is a separate authorized operation.

`maxCost` requires a known execution estimate and matching currency before dispatch. It bounds declared estimates across execution attempts; actual billed usage still belongs to the existing tools and the app adapter. Effectful preparation under a cost budget is refused until its costs can be bounded separately. This is not a universal vendor billing guarantee.

Domain verification must supply fresh evidence and a typed result. Tool acceptance, successful transport, and file existence alone do not satisfy the user's goal. Expired, contradictory, partial, and unavailable proof stay distinct. Result projections retain prepared material and references; richer previews can use the existing artifact surfaces.

Explicit reconciliation of an already-completed operation now refreshes its read-only domain verification. A verifier can return a refined typed `result`; valid fresh evidence is required before replacing the prior result. This can resolve a partial outcome after an app finishes exporting without replaying execution. Routine worker polling still only verifies pending completion.

Host adapters can declare `callTimeoutMs` for synchronous API work, bounded to 1–120 seconds. This does not turn a desktop app into a background service; app hosting and OS/session readiness remain separate capabilities.

The local `local.photoshop.v1` route uses installed Photoshop through bounded background scripting. It launches Photoshop without activation when needed, retains the shared durable operation/reconciliation/domain-verification contracts, and publishes independently checked PSD/PNG artifacts. It requires workspace file authority but no task shell or network permission, SSH tunnel, or connection setup. Its read-only inspector never launches an app. The bounded `local.photoshop.edit.v1` route adds existing-PSD named-layer edits, source-hash binding, private snapshots, fresh PSD/PNG outputs and independent saved-model readback. `local_photoshop_read` supplies exact layer paths and editable text metadata without task shell authority. See [local Photoshop editing](photoshop-local-editing.md) for supported edits; this is not unrestricted Photoshop automation. Local locked-host operation is not advertised.

Application execution is local only: there is no SSH or remote worker route. Generic UI control of other apps uses [`native_app`](local-background-app-control.md).

Operations project into WorkSession waits/evidence and the task timeline. Task completion waits for running work, decisions, and unknown effects. Settled background work can resume a task waiting on these operations. Unverified or partial results downgrade task completion; a superseded unsubmitted draft does not block its verified replacement.

## Validation and pilot gate

Run:

```sh
npm run qa:application-execution
npm run qa:application-execution:smoke
npm run qa:application-execution:smoke:daemon
npm run qa:harness
npm run type-check
npm run lint:async-sqlite
```

The conformance suite requires real SQLite and includes a real database worker, an older-profile upgrade/reopen, file/non-file outcomes, competing dispatch, decisions and revisions, unknown effects, cooperative/lost cancellation, shutdown, limits, scope checks, and stale evidence. Its loopback HTTP server commits a change then destroys the response; recovery must read back the original account/operation and show one write. It binds explicitly to `127.0.0.1`.

[The compiled-runtime smoke](../scripts/qa/application-execution-smoke.cjs) uses a real AgentDaemon, ToolRegistry, coordinator, permission boundary, SQLite profile, and file tools without a model. It checks qualified verification, legacy uncertainty, blocked direct retries, and original-route recovery. Both builds run on Node; this does not establish live Electron UI behavior or packaged release proof. All smoke state is temporary.

For each pilot, qualify installation/account readiness, input/resource identity, native fidelity, conditional writes/conflict detection, observation after a lost reply, cancellation, domain verifiers, and the actual browser/desktop environment when needed. Add the pilot's failures to this conformance suite before expanding categories.

### Measuring progress

Judge each route and pilot by the work it completes, not by tool success:

- **Verified outcomes:** requests finished with fresh domain evidence, with partial and unknown outcomes counted separately.
- **Human effort:** interventions, takeovers and corrections the user had to make.
- **Unnecessary interruptions:** decisions asked for when the request, its limits and earlier answers already settled them.
- **Recovery correctness:** lost replies, interruptions and cancellations resolved without a duplicate or blind retry.
- **Latency and cost:** time to a verified result, and every billed attempt.
- **Adapter effort:** code a new application needs. A new application should mostly need an adapter and domain verifiers; repeated changes to the shared lifecycle point to a missing abstraction.

Tool success, an accepted job and a hidden window are not proof that work is complete.
