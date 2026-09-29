# Harness audit evidence — 27 September 2026

This evidence register supports [the execution plan](/Users/mesut/Downloads/app/cowork/docs/harness-leadership-plan-2026-09-27.md). It distinguishes observed implementation, executed local checks, proposed improvements, and unverified competitive outcomes.

**Snapshot:** working checkout at `eff5d1262b8f80fce0de1cfc1b4e2304144c97ec`, package `0.5.54`, Node `v24.14.1`. The tree already contained substantial changes to automation, settings, renderer and related docs. This task adds planning documents only. Inspection of a dirty checkout is not released-client evidence.

## Report findings: current disposition

| Report finding | Current verdict | Evidence and implications |
| --- | --- | --- |
| F1: stale-content edit overwrite | **Confirmed by actual-class reproduction** | `EditTools.editFile()` computes a replacement from a file read, then awaits mutation-baseline capture before checking path/inode and writing. A controlled two-writer test against the actual class reproduced lost independent content with both calls returning success. Preserve its existing path/descriptor safeguards when fixing content integrity. |
| F2: standalone DAG lost update | **Source defect, dormant applicability** | No production caller of `SubAgentOrchestrator` was found. Production uses `orchestration/OrchestrationGraphEngine`. Do not generalize the old class's whole-array update defect to all native delegation. |
| F3: failed dependency/restart nonterminal states in old DAG | **Conditional to the old class** | Current production graph has per-node persistence, blocked states and restart reconciliation. Existing behavior needs adversarial testing before expansion, not replacement based on the dormant class. |
| F4: DAG tests do not establish persistence correctness | **Valid limit on that test suite** | Mock-based tests for the old class cannot establish transactional interleavings or restart correctness. Quarantine/remove unused code, or require real-SQLite tests before adopting it. |
| F5: exact evidence after context reduction | **Confirmed retrieval/retention contract gap; not universal loss** | Raw tool results are emitted before model compaction in inspected paths, but storage and retrieval layers can truncate independently. Transcript/checkpoint/history foundations exist; an immutable full-result handle recoverable by the model was not established across those paths. |
| F6: requirement-specific verification | **Confirmed integration gap over substantial existing foundations** | Contracts, evidence manifests and artifact revisions already exist and are used. Terminal projection currently marks every requirement satisfied from task-level completion. Separate completion gates/reviewer execution validation still apply to some runs; this is not evidence that all success claims bypass verification. |
| F7: JEV general ROI | **Not established; report appropriately qualified** | The validation record covers one paired task and explicitly declines a general efficiency claim. Existing telemetry is useful; prioritize matched repeated ablations by decision family rather than duplicating accounting. |

## Additional findings from this investigation

**A1 — Outcome storage is descriptive where the plan needs enforceable acceptance.**

[`WorkSessionContractRepository`](/Users/mesut/Downloads/app/cowork/src/electron/database/WorkSessionContractRepository.ts:3) already imports/stores `OutcomeContract`, `ConstraintLedger`, `EvidenceManifest`, `ArtifactRevision`, waits and child outcomes. [`ensureForTask()`](/Users/mesut/Downloads/app/cowork/src/electron/sessions/WorkSessionContractService.ts:225) creates a persisted contract. [`buildRequirements()`](/Users/mesut/Downloads/app/cowork/src/electron/sessions/WorkSessionContractService.ts:645) seeds explicit shell-command or file-existence criteria; this is not general extraction/proof of every natural-language requirement.

[`taskOutcome()`](/Users/mesut/Downloads/app/cowork/src/electron/sessions/WorkSessionContractService.ts:119) treats completed tasks as complete except specified partial outcomes. [`recordTaskTerminal()`](/Users/mesut/Downloads/app/cowork/src/electron/sessions/WorkSessionContractService.ts:501) maps requirements to satisfied for that aggregate outcome without independently checking requirement evidence. [`daemon event projection`](/Users/mesut/Downloads/app/cowork/src/electron/agent/daemon.ts:9190) explicitly preserves legacy authority and treats contract projection errors as additive/non-blocking. Recommendation: evolve this existing contract into an acceptance input with migration-safe proof status; do not create another competing state store.

**A2 — Live artifact smoke graders are too weak for a quality claim.**

[`ensureNonEmptyFile()`](/Users/mesut/Downloads/app/cowork/scripts/qa/run_battery.cjs:140) checks existence/type/size. The [PDF/PPTX scenarios](/Users/mesut/Downloads/app/cowork/scripts/qa/run_battery.cjs:225) use it as their verifier. Therefore a wrong-content nonempty file can satisfy the artifact predicate, although the complete battery additionally requires task completion. The [spreadsheet check](/Users/mesut/Downloads/app/cowork/scripts/qa/run_battery.cjs:152) checks one formula's text, not full recalculated values/preserved workbook quality. These are source observations, not an executed corrupt-artifact benchmark.

**A3 — The live battery needs isolated authority and end-to-end deadlines.**

The [default DB path](/Users/mesut/Downloads/app/cowork/scripts/qa/run_battery.cjs:8) points at normal app data. [`waitForTerminalStatus()`](/Users/mesut/Downloads/app/cowork/scripts/qa/run_battery.cjs:106) approves every pending approval for its task. Its [HTTP helper](/Users/mesut/Downloads/app/cowork/scripts/qa/run_battery.cjs:22) does not receive an abort/deadline signal. The nominal polling timeout does not itself bound an in-flight request. The separate eval runner has stronger deadline/explicit-approval tests; extend that discipline to the battery. This audit did **not** run the live battery against the user's profile.

**A4 — Incident specifications and executable regressions are not mechanically linked.**

The [eval-case README](/Users/mesut/Downloads/app/cowork/scripts/qa/eval-cases/README.md:3) explicitly says these JSON files are not automatically executed. [`hasEvalCaseChange()`](/Users/mesut/Downloads/app/cowork/scripts/qa/enforce_eval_regression_policy.cjs:74) checks for a changed JSON path. That policy is useful process enforcement but cannot establish an executed failing-before/passing-after regression. Require explicit incident-to-test/grader linkage and executed coverage in a future PR.

**A5 — Shared-budget admission needs work; existing limits and cancellation must be preserved.**

[`createChildTask()`](/Users/mesut/Downloads/app/cowork/src/electron/agent/daemon.ts:4496) accepts child budget fields, and native task cancellation cascades to children. The inspected live spawn/graph paths omit shared budget reservation; per-executor cumulative usage checks do not prevent simultaneous descendants from jointly exceeding a root budget. This is an implementation gap at admission, not evidence that CoWork has no accounting or cancellation.

**A6 — Work-session dedupe and leases have narrower guarantees than external receipts.**

[`WorkSessionActivityLeaseRepository`](/Users/mesut/Downloads/app/cowork/src/electron/database/WorkSessionActivityLeaseRepository.ts:69) provides persisted liveness/token renewal/reclaim. Canonical event idempotency suppresses duplicate projection writes. Neither alone establishes that a remote mutation was dispatched only once, survived an uncertain response, or was fenced against a stale worker. The plan calls for effect-boundary reconciliation integrated with these stores, with `unknown` retained when the remote result cannot be proven.

**A7 — The active graph has two concrete failure windows to test.**

[`dispatchNode()`](/Users/mesut/Downloads/app/cowork/src/electron/agent/orchestration/OrchestrationGraphEngine.ts:472) awaits child creation before `markNodeRunning()` persists the child link; [remote ACP dispatch](/Users/mesut/Downloads/app/cowork/src/electron/agent/orchestration/OrchestrationGraphEngine.ts:552) likewise invokes before updating `remoteTaskId`. A crash in those windows creates a plausible orphan/duplicate-dispatch risk during reconciliation. No process-kill reproduction of this route was performed in this audit.

The [parent cancellation traversal](/Users/mesut/Downloads/app/cowork/src/electron/agent/daemon.ts:5550) iterates native task-repository children. Remote ACP nodes belong to the graph, whose separate `cancelHandle()` route must be tested from parent cancellation. This is a source-supported coverage concern, not a claim that remote work was observed continuing after a real stop. Both deserve explicit P05 fault tests on the live engine before broader delegation rollout.

A scoped search of test/spec files under `src` and `tests` found no direct references to `OrchestrationGraphEngine`, `dispatchNode`, or `cancelHandle`. Indirect coverage may exist; this search does not establish its absence. The new fault suite must name and exercise the production engine rather than infer its guarantees from tests of the dormant class.

**A8 — Storage truncation and verifier selection are separate evidence bottlenecks.**

The [timeline sanitizer](/Users/mesut/Downloads/app/cowork/src/electron/agent/timeline-payload-sanitizer.ts:3) caps individual strings at 60,000 characters and payloads at 256 KiB; the [oversize replacement](/Users/mesut/Downloads/app/cowork/src/electron/agent/timeline-payload-sanitizer.ts:152) contains a preview and size metadata, not an exact-output retrieval handle. This bounds storage use but cannot preserve arbitrary full output by itself. Existing transcript/checkpoint retention and session search must be reused/qualified rather than described as absent.

Separately, [`VerificationRuntime.buildVerificationPrompt()`](/Users/mesut/Downloads/app/cowork/src/electron/agent/runtime/VerificationRuntime.ts:149) sends `entries.slice(0, 40)` without a full manifest/omitted-count lookup. [`SessionRuntime.recordVerificationEvidence()`](/Users/mesut/Downloads/app/cowork/src/electron/agent/runtime/SessionRuntime.ts:4871) appends entries. A needed later entry can be absent from the prompt. Keep the [existing policy-scoped completion gate](/Users/mesut/Downloads/app/cowork/src/electron/agent/daemon.ts:13300) while making evidence selection and per-requirement freshness reliable.

**A9 — Provider profiles and feedback are existing assets to extend.**

[`model-capability-profile.ts`](/Users/mesut/Downloads/app/cowork/src/electron/agent/llm/model-capability-profile.ts:1) already distinguishes verified/unknown/unsupported and keys evidence by endpoint/model/backend/version/template. The inspected registry is in-memory with narrow observed-provider integration; broad persisted qualification remains work. [`FeedbackService`](/Users/mesut/Downloads/app/cowork/src/electron/agents/FeedbackService.ts:122) already stores user feedback. Extend it with task/artifact acceptance and correction cost rather than create a parallel feedback feature.

The specialist's [full context/verification audit](/private/tmp/cowork-harness-context-audit.md) records additional source references and explicit limits; it was source-only and ran no additional tests.

**A10 — Researcher read-only metadata does not establish a read-only execution boundary.**

The [role definition](/Users/mesut/Downloads/app/cowork/src/electron/agent/runtime/worker-role-registry.ts:106) denies direct file writes/deletion and delegation, and advertises `mutationAllowed: false`. A source search found no enforcement use of that flag. The [stronger boundary](/Users/mesut/Downloads/app/cowork/src/electron/agent/runtime/worker-role-registry.ts:323) applies to verifier or explicit `readOnlyExecution` helpers. The [daemon merge](/Users/mesut/Downloads/app/cowork/src/electron/agent/daemon.ts:4517) can therefore give an ordinary researcher a parent's bypass mode and shell access. The [network group](/Users/mesut/Downloads/app/cowork/src/shared/types.ts:1764) includes browser interactions and connector actions as well as reads. This confirms a role/configuration contract gap; it does **not** establish an executed policy bypass. P08a must test the actual registry path under a full-authority parent and retain useful reads without relying on the role prompt.

**A11 — Compaction and provider failover need a combined privacy regression.**

The [compaction formatter](/Users/mesut/Downloads/app/cowork/src/electron/agent/executor.ts:5801) serializes tool inputs and raw result text. Its [deterministic fallback](/Users/mesut/Downloads/app/cowork/src/electron/agent/executor.ts:5905) reinserts a truncated transcript after [`sanitizeMemoryContent()`](/Users/mesut/Downloads/app/cowork/src/electron/agent/security/input-sanitizer.ts:289), which filters instruction-override patterns rather than credentials. Upstream redaction may apply; its end-to-end sufficiency was not established here. Separately, [configured provider failover](/Users/mesut/Downloads/app/cowork/src/electron/agent/llm/provider-factory.ts:1860) can advance to another configured provider, while an explicitly pinned task provider/model restricts the chain to one selection. The [executor failover path](/Users/mesut/Downloads/app/cowork/src/electron/agent/executor.ts:37664) changes that selection and records routing state. Test canary credentials through fallback plus an outage, and enforce authorization for private-only content before remote export. No secret disclosure or local-to-cloud privacy violation was observed.

**A12 — Preserve existing approval safeguards; qualify the headless exception at its caller.**

[Authorization fingerprints](/Users/mesut/Downloads/app/cowork/src/electron/agent/daemon.ts:6417) bind input, workspace, restrictions and policy; [approval revalidation](/Users/mesut/Downloads/app/cowork/src/electron/agent/daemon.ts:7242) rejects changed authority. The [registry](/Users/mesut/Downloads/app/cowork/src/electron/agent/tools/registry.ts:2129) enables the semantic-review exception only for a headless task with explicit bypass/never-approval authority. The inspected [test](/Users/mesut/Downloads/app/cowork/src/electron/agent/__tests__/tool-policy-pipeline.test.ts:330) directly supplies that pipeline option; add registry-wired acceptance before claiming route parity. This is a coverage obligation, not a demonstrated escalation. Preserve hard-denial precedence and the authorized credential-free bot-read lane.

## Executed local validation

| Command/check | Observed result | Boundary |
| --- | --- | --- |
| `node scripts/qa/check_harness_dependencies.cjs` | Native SQLite and sqlite3 CLI available | Node test prerequisites only; no dependency repair performed |
| `npm run qa:harness` | 58 test files, 956 tests; 953 passed, three failed with `listen EPERM: operation not permitted 127.0.0.1` | The process exited 1; its trailing fixture command did not run because of `&&` |
| `npx vitest run tests/qa-eval-runner.test.ts` with loopback available | Eight passed | Includes the three previously environment-blocked cases and five repeated passes |
| `node scripts/qa/run_eval_suite.cjs --fixtures-only` | Six passed: crash recovery, compaction recovery, approval roundtrip, credential redaction, policy revocation, child join | Explicit `selected coverage: 0/0`; deterministic fixtures, not production or capability coverage |
| `npx vitest run --config /private/tmp/cowork-vitest.config.mts` | Two bug-characterization tests passed, including concurrent actual-class edits reporting success while one change disappeared; root reran successfully | These assertions prove the incorrect behavior exists. They are not passing correctness tests or a fix. Disposable files; not a frequency estimate or full desktop run. |

Together these account for all 956 selected baseline tests passing across the initial run and isolated retry, plus six fixtures. They do not establish live competitor performance, full suite/build health, or a published fix.

Local evidence files: [initial gate log](/private/tmp/cowork-harness-baseline-20260927.log), [loopback retry log](/private/tmp/cowork-harness-loopback-rerun-20260927.log), [source/validation manifest](/private/tmp/cowork-harness-source-manifest-20260927.json). Temporary evidence may be cleaned by the operating system; the findings and commands are retained here. The manifest records the report hash, source hashes and dirty-state inventory without storing credentials or private app data.

The [actual-class edit probe](/private/tmp/cowork-edit-tools-stale.test.ts), [temporary config](/private/tmp/cowork-vitest.config.mts), [root reproduction log](/private/tmp/cowork-edit-race-reproduction-20260927.log), and [runtime audit](/private/tmp/cowork-harness-runtime-audit.md) are available for inspection. The test imports the real `EditTools`, substitutes only the daemon baseline/log hooks and Electron app-path accessor, and asserts the observed lost-update behavior.

## Independent plan review

The [GPT-6 Luna max plan review](/private/tmp/cowork-harness-plan-review.md) identified four material planning weaknesses: unclear comparison denominators/surfaces, insufficient power specification for the coding margin, an underspecified coding improvement program, and pilot spend/large work-item estimates. The plan now defines paired and full-portfolio views, family weights, task-clustered power and comparison rules, development-only coding ablations, a capped smoke stage, and separate provider/orchestration slices. These are design corrections, not executed benchmark results.

The [GPT-6 Luna max authority review](/private/tmp/cowork-harness-authority-review.md) supplied A10–A12. The root agent checked the referenced role, daemon, policy, compaction and failover source before integrating them. Its unexecuted attack hypotheses remain labeled as such; no additional live security tests were run.

The plan reviewer also drafted a development catalog. The root integrated it as [24 black-box pilot tasks](/Users/mesut/Downloads/app/cowork/docs/harness-development-pilot-2026-09-27.md), moving native graph fault injection outside comparator scoring and adding a common mock-service uncertainty task. The catalog is a specification, not an executed or runnable benchmark.

## Primary external evidence

Sources below were retrieved during this investigation. Documentation and moving `main` branches describe the accessed state; they are not pinned installed-product performance tests.

| Source | What it establishes here |
| --- | --- |
| [OpenAI: Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/) | Model-specific instructions, prefix/cache sensitivity and compaction design |
| [Codex tool orchestration source](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/orchestrator.rs), [parallel execution source](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/parallel.rs) | Central approval/sandbox handling and explicit execution admission/cancellation paths in inspected source |
| [Claude Code subagents](https://code.claude.com/docs/en/sub-agents), [checkpointing](https://code.claude.com/docs/en/checkpointing) | Isolated context/tool/permission design and documented boundaries of rewind |
| [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing) | Filesystem/network controls and credential masking/proxy configuration are substantial comparison surfaces; possession of a permission prompt is not equivalent to them |
| [Cursor dynamic context](https://cursor.com/blog/dynamic-context-discovery), [scaling](https://cursor.com/blog/scaling-agents) | Tool/history retrieval and published coordination experiments; vendor-reported results, not an independent CoWork comparison |
| [Hermes delegation](https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation) | Child lifecycle, structured interruption, unknown running attempts after restart, and opt-in isolation boundaries |
| [Harbor pre-integrated agents](https://docs.harborframework.com/core-concepts/agents/pre-integrated-agents), [custom adapter](https://docs.harborframework.com/core-concepts/agents/custom-agents), [separate verifier](https://docs.harborframework.com/core-concepts/tasks/separate-verifier) | Existing comparator integrations and a practical native-CoWork adapter/isolated grader path |
| [Anthropic agent evaluation guidance](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) | Evaluation design distinguishes final environmental outcomes from transcript assertions |

The recommended portfolio, thresholds, backlog, and hypothesized CoWork advantage are engineering proposals. No source establishes that implementing them guarantees leadership.
