# Application Execution Architecture

Architecture proposal · 13 October 2026 · Companion to [the strategy](headless-apps-strategy.md).

Status: researched design and staged backend specification. Contracts below are proposals unless explicitly identified as existing. Runtime implementation, cross-runtime benchmarks, and application pilots have not been performed by this review. Source inspection used checkout e09add3d5 with unrelated uncommitted changes.

**1. Architecture decision**

CoWork should own a durable, provider-neutral layer for work across applications. Extend its existing harness; allow native execution, Codex, Claude, and other qualified runtimes to implement agent work behind that layer. Application capabilities may be reached through MCP, direct APIs, CLI/scripts, browser automation, computer use, or delegated agents.

Separate the lifetime of the user request, model turn, application operation, and external job. A model turn can finish while a render is running. A browser session can disappear after an ERP action committed. These cannot collapse into one success/failure flag.

~~~mermaid
flowchart TD
  U[User request] --> W[WorkSession: outcome, constraints and resources]
  W --> P[Plan and prepare]
  P --> D{Meaningful decision needed?}
  D -->|Yes| H[Draft, diff, choice or estimate]
  H -->|Feedback| P
  H -->|Continue| R[Resolve capability and route]
  D -->|No| R
  R --> B[Existing coordinator and permission boundary]
  B --> J[Durable operation attempts and resource leases]
  J --> A[MCP, API, CLI, browser, desktop or delegated adapter]
  A --> E[Local worker, service or isolated environment]
  E --> V[Readback and domain verification]
  V --> O[Artifact, record, analysis or confirmed state]
  V -->|Recover or revise| P
  O --> U
  J -.-> Q[Wait, reconcile, cancel and resume]
  Q -.-> J
~~~

The UI projects compact status, an occasional decision, and the result. Application views and detailed activity are optional. Persist actionable plans and decision rationale, not hidden model reasoning.

**2. External designs examined**

Official sources were checked for mechanisms and limits. Documentation is not proof of CoWork integration or availability under the user's accounts.

| Solution | Verified mechanism | What to adopt or evaluate |
| --- | --- | --- |
| [Codex app-server](https://learn.chatgpt.com/docs/app-server) | Structured threads/turns/items, streaming, resume, interruption, and client-handled approvals. Dynamic tools are experimental; schemas can be generated for the installed version. | Evaluate a version-pinned driver. Normalize events into WorkSession and keep business operations in CoWork. Avoid terminal-output scraping. |
| [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk) and [noninteractive mode](https://learn.chatgpt.com/docs/non-interactive-mode) | Programmatic thread continuation/resume and structured execution for bounded jobs. | Useful for delegated work; compare lifecycle/control requirements before choosing SDK versus app-server. A completed turn does not establish business completion. |
| [OpenAI Agents API](https://developers.openai.com/api/docs/guides/agents-api/overview) and [self-hosted environments](https://developers.openai.com/api/docs/guides/agents-api/environments/self-hosted) | Managed sessions/orchestration/recovery with a separately chosen environment; the self-hosted executor connects outbound to the harness. | Optional managed runtime. Assess locality, cost, access, and operational dependency before adoption. |
| [OpenAI hosted browser](https://developers.openai.com/api/docs/guides/agents-api/tools/computer-use) | The agent can observe the browser while screenshots are excluded from application output, the documented default. | Separate observation from user presentation. This browser surface is not proof of arbitrary native-app hosting. |
| [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview), [custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools), [subagents](https://code.claude.com/docs/en/agent-sdk/subagents) | Reusable Claude Code loop/context management, typed custom tools, MCP, and scoped subagents. | Evaluate another driver. Conversation isolation is not OS/account isolation. Qualify authentication and product access instead of assuming a consumer subscription covers SDK usage. |
| [Claude permissions](https://code.claude.com/docs/en/agent-sdk/permissions), [sessions](https://code.claude.com/docs/en/agent-sdk/sessions), [checkpointing](https://code.claude.com/docs/en/agent-sdk/file-checkpointing) | Permissions control tool execution; sessions preserve conversation; file rewind has a defined local-tool scope. The canUseTool callback can be skipped for already-approved tools. | Enforce CoWork authority at every effectful boundary. Session resume does not reconcile external jobs; file rewind does not undo SAP, Salesforce, or arbitrary shell effects. |
| [MCP tools, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) and [Tasks extension](https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks) | Schemas support interoperability; Tasks is separately negotiated asynchronous execution. Cancellation is cooperative; task completion and tool-result success are distinct. | Pin supported versions and negotiate capabilities. Map external task handles into CoWork operations. Schema validity is not business correctness or authority. |
| [Anthropic computer use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool) | The application executes observation/action calls; restricted dedicated environments are recommended. | Qualify desktop isolation and user takeover. Keep desktop implementation separate from the model's action suggestions. |
| [Temporal activities](https://docs.temporal.io/activity-definition) | Activity execution can repeat after a worker completes an effect but fails to report it. Downstream services must enforce idempotency keys. | Adopt durable journal/reconciliation principles. No need to introduce Temporal for the first local implementation, and no scheduler alone guarantees exactly-once business effects. |
| [Agent Skills](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) | Progressive disclosure of metadata, instructions, and supporting resources. | Reuse focused domain guidance without loading every workflow into every prompt. Instructions cannot replace executable checks or authorization. |

These comparisons support standardizing CoWork's application-work contracts while keeping runtime implementations replaceable. Vendor transcripts and protocol objects stay inside adapters.

Do not conflate similarly named protocols. CoWork's [ACP/acpx guide](acp-acpx-integration.md) distinguishes its custom remote task bridge from A2A and PACT. Preserve separate versioned adapters. MCP's older experimental Tasks shape must not be assumed equivalent to its published 2026-07-28 extension.

**3. Build versus reuse**

| Option | Benefit | Cost or unresolved issue | Recommendation |
| --- | --- | --- | --- |
| Extend CoWork's native harness | Preserves providers, profiles, sessions, tools, deployment modes | CoWork owns loop/recovery engineering | Reversible baseline for the contract |
| Make Codex the only harness | Reuses a documented mature loop/lifecycle | Coupling, migration, and policy equivalence need proof | Evaluate behind a driver first |
| Make Claude SDK the only harness | Reuses loop, tools, context, hooks | Same ownership questions and different access constraints | Evaluate behind the same boundary |
| Use a managed harness | Reduces some hosting/session work | Changes data placement, service dependency, and economics | Optional deployment route |
| Build another generic orchestrator | Complete design freedom | Duplicates existing retries, authority, and completion ownership | Avoid |

Run the available candidates against the same operations, inputs, scoped authority, decisions, verification, and injected failures. Measure correctness, prompts, cancellation, recovery, latency, cost, and engineering effort. Mark unavailable candidates unverified. Documentation alone should not lock the runtime.

There must be one owner for dispatch and retries. A delegated runtime either calls app tools through CoWork's controlled gateway or runs in an environment with demonstrated equivalent enforcement. Hooks and prompts cannot enforce a boundary while unrestricted shell/network routes remain available. Existing AcpxRuntimeRunner rejects bounded execution; retain that restriction until equivalence is proved.

A runtime driver should expose start/continue, events, decision delivery, interruption, resume, and final output with its capability/limit declaration. Its session ID is an implementation reference, not the canonical business operation. CoWork owns final outcome classification.

**4. Minimum shared contracts**

Use versioned envelopes with application-specific schemas. These are extensions, not one universal CAD/document/ERP data model.

| Contract | Minimum responsibility | Existing foundation |
| --- | --- | --- |
| Outcome and constraints | Objective, inputs, required output/state, acceptance criteria, budgets, decisions, incomplete requirements | OutcomeContract, ConstraintLedger, WorkSessionContractService |
| Resource reference | Kind, owning system, tenant/account, stable identity, locator, observed version/time, provenance | Extend evidence/artifact references; retain ArtifactRevision for files |
| Capability and route | Semantic operation, input/output schemas, supported resources, implementation/version, prerequisites, effects, replay properties, preparation/cancellation/verification/environment support | RuntimeToolMetadata, connector catalog, deferred tool search |
| Plan revision | Operations/dependencies, resources, estimates, assumptions, optional decisions, completion criteria | WorkSession items and orchestration graph |
| Prepared change | Proposed changes/preview, base versions, input digest, estimate, expiry, any effects of preparation itself | Contract/constraint records plus adapter-specific payload |
| Decision checkpoint | Question/reason, concrete supporting material, scope, plan/resource versions, responses and durable resolution | WaitState and decision ledger; separate from permission grants |
| Operation/attempt | Logical ID, attempt IDs, inputs, route/environment/account, authority reference, external ID, effects, reconciliation | Coordinator/events, waits, PACT durability patterns |
| Result/evidence | Produced/changed/learned/confirmed outcome, references/checks/freshness, unmet criteria, partial/unknown effects | ToolResultEnvelope, EvidenceManifest, verifier and artifact records |

Resource/result variants cover file revisions, native projects, remote entities, query/analysis, and observed application state. Preserve typed domain payloads. A Salesforce record does not need a fake file path; legal analysis may complete without any write.

Discover a relevant subset, then load detailed schemas and workflow guidance. Reuse deferred tool search rather than injecting every installed app's tools. Unclassified tools may remain available under existing policy, but cannot claim safe retry, automatic preparation, route equivalence, or verified completion they do not implement.

Adapter methods should declare support for inspect/readiness, prepare, execute, observe/reconcile, cancel, and verify. Preparation and cancellation can explicitly be unsupported. Compensate is optional and separate. One operation may invoke multiple low-level tools; journal actual effectful attempts rather than relying solely on the model's summary.

**5. Planning, feedback, and application**

The model can explore and revise a plan; the backend enforces state, permissions, budgets, and decision scope. Information gathering need not wait for a fully static graph.

| Situation | Expected behavior |
| --- | --- |
| Clear request, existing authority, agreed limits | Prepare internally where useful, execute, verify, return |
| Draft requested, material ambiguity, or unresolved expensive commitment | Prepare something concrete and ask a focused question |
| Required resource/side-effect authority missing | Use existing permission handling |
| Accepted draft, next step within its scope | Continue without repeating the question |
| Material change to target version, affected records, scope, or estimate | Revalidate affected decisions and permissions |

Use configured/task-specific cost and time preferences. Report uncertain estimates as ranges or unknowns. A long job needs no extra feedback if the user already requested it within known limits.

Preparation might be a diff, cheap preview, analysis, transaction simulation, or just a proposed change list. Declare which. If preparing creates a remote draft, reserves capacity, uploads data, or spends money, record and authorize those effects too.

Resolve decisions atomically and bind them to applicable versions. Restarts, double-clicks, and late answers must not launch duplicate work. Invalidate only materially affected decisions when a plan changes. Existing stricter adapter rules, including PACT consent, remain independent of optional product feedback.

**6. Durable operations and recovery**

Persist intent before dispatch, acquire a scoped lease, and record the external ID as soon as known. Use transactional local scheduling/outbox records without implying that a local transaction also commits a remote app.

Track three dimensions separately:

- Execution: prepared, submitting, accepted/running, completed, failed, or outcome unknown.
- Verification: pending, verified, contradicted, or unavailable.
- Cancellation: not requested, requested, confirmed, or unsupported.

Separate logical operation identity from transport call/retry identity. Deduplicate events and late responses. Runtime workers should poll external jobs without holding an LLM turn open.

If a response is lost after mutation, reconcile against the original system/account and authoritative state before resubmitting. Where deduplication/readback is unavailable, keep the outcome unknown and resolve it explicitly. Never retry a potentially committed API operation through the browser. Do not promise universal exactly-once behavior.

Cross-app tasks have per-step effects. If ERP succeeds and CRM fails, preserve both facts and resume incomplete work. Compensation is a new operation with authority and concurrency checks. Cancellation prevents future work where possible; it does not reverse completed effects.

Scheduler scope keys and leases coordinate cooperating CoWork workers across files, documents, records, accounts, and desktops. Adapters must declare support for conditional writes, remote fencing, and conflict detection. Local leases cannot prevent external edits or revoke an already-issued remote action. Where atomic version checks are unavailable, report the race limitation and do not claim lost-update protection; recovery must detect conflicts where possible and avoid blindly overwriting later human edits. Bound execution, polling, storage, and compute. Stale workers lose local ownership; late output must not replace newer accepted results.

CoWork already implements persist-before-send, leases, receipts, and unknown-outcome handling in [PACT](../src/electron/pact/conversation-service.ts). Extract shared mechanics only where semantics match; retain PACT-specific identity, consent, and receipt verification.

Closing a result panel must not end the operation. If CoWork exits, resume through an available authorized daemon/worker or recover on restart; do not imply local compute continues while its machine is off.

**7. Route and environment selection**

Select a qualified operation implementation. Filter by identity, authority, resource compatibility, fidelity, readiness, locality, and user constraints; rank remaining routes by measured success, verification strength, latency, and cost. Honor explicitly requested applications.

MCP is not proof of structured, cheap, headless, or reversible execution. An API with good readback may be preferable, but it must not replace a native operation with a lossy approximation.

Fallback requires the same target identity, sufficient authority, preserved state, and a verification path. Denial is not a routing failure to work around. A different logged-in browser account is not an equivalent route. Account selection and credential renewal remain scoped connection operations.

Environment providers should describe local processes, browser contexts, desktop sessions, and qualified remote/isolated workers. Record background-input support, foreground requirements, concurrency, persistence, and takeover. Scope credentials to account/tenant; imported content and delegated replies remain evidence, not instructions or authority.

Source already supports background browser selection and some background desktop capture/accessibility actions. Native computer use still relies on macOS/Windows desktop facilities, uses one global session, and is omitted in headless mode. Foreground-only operations need an allowed visible fallback or qualified isolated desktop. MCP does not remove that dependency.

**8. Verification and results**

Extend requirement-selected domain verifiers:

| Outcome | Appropriate evidence |
| --- | --- |
| Document/workbook | Parseability, required structure/text, formulas and recalculated values, native-feature preservation |
| CAD/project | Dimensions/constraints, recomputation, source/export integrity |
| CRM/ERP | Authoritative exact-record readback, version/fields, receipt, required downstream status |
| Long job | Terminal job state, collected and validated output, outstanding downstream work |
| Research/legal | Attribution, scope/coverage, freshness, contradictions, uncertainty |
| UI-only state | Fresh post-action observation tied to account/resource and claimed state, with stated proof limits |

Distinguish submission, persistence, business completion, and user acceptance. Screenshots prove displayed state within limits; receipts prove issuer claims within verified scope; file existence alone does not prove content.

Return the requested result, concise changes/findings, relevant references, and any unmet requirement or unknown effect. Keep traces and live views available on demand. Preserve editable sources where relevant; a custom rich editor for every app is not a prerequisite for useful execution.

**9. Current backend reuse map**

These are reuse points, not proof that all proposed contracts exist.

| Area | Current code | Scoped extension |
| --- | --- | --- |
| Discovery | [ToolSearchService](../src/electron/agent/runtime/ToolSearchService.ts), [DeferredToolCatalog](../src/electron/agent/runtime/DeferredToolCatalog.ts), [connector capabilities](../src/electron/mcp/connectors/capabilities.ts) | Operation semantics, qualified routes, readiness/effects/verification |
| Execution | [ToolExecutionCoordinator](../src/electron/agent/runtime/ToolExecutionCoordinator.ts), [ToolRegistry](../src/electron/agent/tools/registry.ts) | Operation/attempt identity and canonical adapter outcomes |
| Authority | [PermissionEngine](../src/electron/agent/runtime/PermissionEngine.ts), [ToolPolicyPipeline](../src/electron/agent/runtime/ToolPolicyPipeline.ts) | Account/resource/effect continuity across interfaces |
| Concurrency | [ToolScheduler](../src/electron/agent/runtime/ToolScheduler.ts), [scheduler specs](../src/electron/agent/runtime/runtime-tool-scheduler-spec.ts) | App document, record, account, desktop scopes |
| Contracts/recovery | [shared types](../src/shared/types.ts), [WorkSessionContractService](../src/electron/sessions/WorkSessionContractService.ts), [OrchestrationGraphEngine](../src/electron/agent/orchestration/OrchestrationGraphEngine.ts) | Prepared changes, decisions, operation reconciliation |
| Saved workflows | [workflow engine](../src/electron/routines/workflow/engine.ts), [action executor](../src/electron/routines/workflow/action-executor.ts) | Reuse persistence patterns; align ad hoc and saved execution semantics |
| Browser/desktop | [browser tools](../src/electron/agent/tools/browser-tools.ts), [computer-use tools](../src/electron/agent/tools/computer-use-tools.ts), [desktop sessions](../src/electron/computer-use/session-manager.ts) | Qualified environments and operation evidence |
| External runtimes | [AcpxRuntimeRunner](../src/electron/agent/AcpxRuntimeRunner.ts), [remote invoker](../src/electron/acp/remote-invoker.ts) | Replaceable drivers with explicit enforcement limits |
| External effects | [PACT conversations](../src/electron/pact/conversation-service.ts), [receipt verifier](../src/electron/pact/receipt-verifier.ts) | Reuse journal/lease/reconciliation mechanics |
| Verification/results | [VerificationRuntime](../src/electron/agent/runtime/VerificationRuntime.ts), [WorkSessionContractRepository](../src/electron/database/WorkSessionContractRepository.ts) | Domain checks, typed results, freshness, partial effects |

Some documentation describes visible browser defaults while current source supports background/ask/visible selection. Validate actual behavior and reconcile affected docs during implementation.

**10. Backend work packages**

| Package | Deliverable | Acceptance |
| --- | --- | --- |
| A. Contracts/catalog | Versioned resource, route, operation, decision, result schemas around existing types | Represent files, remote records, analysis, long jobs, UI state without category-specific core fields |
| B. Durable execution | Attempts, persistence, leases, reconciliation, cancellation, budgets in existing coordinator/session | Failure injection before send, after remote commit, during reconnect/cancel and late completion; no blind duplicate mutation |
| C. Feedback/results | Prepared changes and decisions via waits; verifiers and compact result projection | Simple work proceeds without a checkpoint; necessary decisions survive restart with scope intact |
| D. Runtime/environment comparison | Native baseline and bounded Codex/Claude spikes; API/MCP/CLI/browser/desktop fixtures | Prove enforcement ownership, event mapping, resume, limits, latency/cost |
| E. Application pair | Two qualified adapters and domain verifiers | Most new code stays in adapters; real outcome and recovery acceptance |
| F. Refine/expand | Fix shared gaps, version contracts, add categories | No existing tool/provider/routine regressions; migration and rollback verified |

Use native extensions as the reversible baseline, with external drivers capability-gated. A wholesale migration or new distributed scheduler is unnecessary for the first comparison.

Before accepting the architecture, demonstrate: authorized completion without a prompt; useful draft feedback and restart; remote mutation with a lost reply; partial cross-app completion; a non-file result; browser/desktop work without required user observation; and runtime-driver substitution preserving canonical work records. Scope unsupported cases explicitly.

Use additive database migrations and upgrade-path tests. Old tool results retain their meaning until adapters qualify; a new envelope cannot make unverified output verified. Preserve legacy task/event projections and permission behavior. Roll out capabilities independently with disable/recovery paths.

**11. Application pilots after the foundation**

Candidate pair: a local CAD app and Salesforce in a dedicated sandbox. Choose the CAD app after checking installed software, automation support, and entitlement. The [Rhino connector](../connectors/rhino-mcp/README.md) is a starting point, not proof of a ready bridge. Pilot choices test the architecture rather than define it.

- CAD: open a native project, change dimensions, check constraints/recompute, prepare a cheap preview, optionally request feedback before expensive output, return source/export. Interrupt work and introduce a competing edit.
- Salesforce: read exact records, prepare a change summary when needed, perform authorized sandbox changes, reread state, return record links. Lose a response after mutation and introduce a concurrent edit. The [current connector](../connectors/salesforce-mcp/src/index.ts) exposes create/update operations; `create_record` deduplicates retries of the same attempt within the connector process (see [Idempotent Writes](enterprise-connectors.md#idempotent-writes)), which is not remote deduplication: it does not survive a connector restart and does not cover updates.

Exercise controlled browser/desktop fixtures even if pilot APIs work well. Later, read-only legal research tests analysis and evidence without CRUD/file assumptions. Word/Excel and SAP follow as separately qualified capabilities; this proposal does not claim an existing SAP connector.

**12. Architecture lock and measures**

Record correctness, unnecessary prompts, recovery, partial/unknown effects, human effort, latency, all billed attempts, and app-specific implementation effort. Keep fixture, live-app, package, and release evidence separate. Follow current consent/data rules for analytics.

Adopt now: outcome-based execution, meaningful optional feedback, provider-neutral durable ownership, domain results, common authority across interfaces, and evidence-backed completion.

Keep provisional: SDK/driver selection, remote desktop provider, exact schema layout, route ranking, and named pilot apps. Resolve these with the conformance suite and integration spikes. Expand through adapters and workflow guidance while pilot failures refine the shared contracts.
