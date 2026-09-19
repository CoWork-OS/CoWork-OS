# Agent harness audit — September 14, 2026

This audit tests concrete failure modes in CoWork's execution and evaluation
harness. It does not establish a ranking against every competing product. All
results refer to this local working checkout; publishing and live provider
benchmarks require separate evidence.

Latest validation: **7,761 full-suite tests**, **777 harness tests**, and **six
replay fixtures** passed. Electron, daemon, and CLI builds passed; isolated
shutdown processes passed. See the final validation section for scope and limits.

## Evaluation standard

The audit prioritizes durable progress, correct cancellation, one result per
tool call, verification before success, and tests that cannot pass by skipping
the behavior they claim to cover. CoWork's multi-provider support and existing
session protocol remain the foundation.

The distinction between a transcript claim and an actual outcome follows
[Anthropic's agent evaluation guidance](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents).
The emphasis on inspectable environments and enforceable constraints is also
consistent with [OpenAI's harness engineering account](https://openai.com/index/harness-engineering/).
These sources inform the audit criteria; they do not validate CoWork's code.

## Findings and approach comparisons

| Area | Reproduced problem | Alternatives considered | Selected approach |
| --- | --- | --- | --- |
| Verification | Failed, cancelled, missing, or timed-out reviewers can return stale PASS text that is accepted. | Stronger prompt alone; validate execution status before parsing. | Require completed execution before accepting a verdict. |
| Verdict parsing | A quoted PASS, PASSING, or PASS beneath a FAIL header can become success. | Any substring; first/last marker; explicit leading verdict contract. | Require a standalone leading verdict and reject contradictory standalone verdicts. Align the worker prompt with this contract. |
| Required review | The daemon drops risk and output metadata; the depth guard can also silently skip required review. | Duplicate risk scoring; forward the original gate decision and reject unavailable review. | Carry the explicit decision, high-risk flag, and output summary into verification; fail the depth-limited review and reject missing gated results. |
| Verifier authority | Parent bypass settings, named profiles, and saved allow rules can grant a nominally read-only verifier mutating authority. | Deny known tools only; enforce an effective read-only role boundary. | Deny destructive tools and restrict effective shell, write, delete, and network capabilities while preserving narrower filesystem scope. Verifiers inspect supplied evidence and must report missing fresh execution evidence. |
| Tool-batch completion | Cancellation/stop-after can drop sibling results; dispatch-hook failures can abort a whole batch without results. | Prepare every tail call; reserve entire batches; synthesize nonexecuted results and preserve the fatal stop. | Complete the tool-result contract without preparing cancelled calls, finalize dispatch failures, and propagate the stop to the executor. |
| Tool-result ordering | Deferred local-model results can precede earlier executed calls. | Add public result-index fields; order at the transcript boundary by original tool IDs. | Restore original model order at the shared append boundary. |
| Turn budgets | Missing usage can bypass turn accounting; document, canvas, and report helpers also skipped usage-bearing accounting. | Treat absent usage as zero cost; separate turn accounting from token telemetry. | Count completed model turns independently of optional token/cost reports. |
| Recovery | A stale checkpoint can override a more recent event snapshot; feedback can disappear across restart. | Always prefer checkpoint; always prefer snapshot; compare freshness and replay durable feedback. | Select the freshest valid state and preserve unresolved feedback and consumption events. |
| Security scan evidence | Regex matches were labelled confirmed, with fabricated verifier/debater outcomes, despite no proof running. | Treat static matches as proven findings; distinguish warnings from executed proof. | Keep actionable candidates and optional blocking behavior, report all proof stages as not run, and keep explicit confirmed-fix registration separate. |
| Suite coverage | Built-in fixture passes hide missing suites and skipped source cases. | Count all passes together; distinguish fixture checks from selected-case execution. | An explicit fixture-only path and separate selected-case coverage. |
| Assertion contracts | Unsupported assertion names, malformed JSON, and wrong value shapes can be discarded and graded as success. | Silently ignore unknown fields; reject unimplemented or malformed graders. | Both replay graders reject invalid contracts; selected app-eval coverage also fails when definitions are missing or cases skip. |
| Live evaluation deadlines | Each approval HTTP request can reset the timeout and exceed the case budget. | Per-request timeouts only; one deadline shared across trigger, approvals, and polling. | Bound each HTTP request and poll sleep by the remaining case budget, with abort cleanup tests. |
| CI coverage | A missing live-battery configuration exits successfully, and log piping can hide a failed command. | Require secrets everywhere; make optional coverage explicit and enforce configured runs. | Separate optional live coverage from required deterministic tests, fail partial configuration, and preserve pipeline failure exit codes. |
| Test environment | Database suites silently skip when native SQLite is unavailable. | Accept skips; repair implicitly; fail prerequisite checks with an explicit setup command. | Fail the harness gate before tests; prepare native SQLite explicitly in CI. |

## Repeatable checks

Run `npm run qa:harness` with Node 24+, native `better-sqlite3` for that Node ABI,
and the `sqlite3` CLI installed. This runs runtime, verification, compaction,
checkpoint, session, replay, timeline, risk, and evaluation-runner regressions,
then the built-in deterministic replay fixtures. Temporary databases and local
fake HTTP services isolate tests from the user's application data. Verifier/helper
capability tests and security-scanner evidence-status regressions are included.

PR, release, and nightly workflows use this same deterministic harness gate.
The optional live battery reports `not_configured` when all prerequisites are
absent; partial configuration or a failing configured run fails the gate. No
production corpus is built or implied on a fresh nightly runner. Executable
workflow-shell tests cover those states and failed commands behind log piping.
The PR path filter includes runtime, session, database, shared protocol, eval,
and QA changes. A clean CI checkout has no production task corpus: it must not
claim production replay coverage from an empty database. Real timeline metric
enforcement remains available through `qa:timeline:enforce` against a populated
database; the empty-database CI step is replaced by executable timeline tests.

Hook evaluation now aborts unresponsive HTTP requests and leaves pending approvals
blocked by default. Only an explicit `--mode hooks --auto-approve` enables
automatic approval responses; use that option only for isolated, intended test
workspaces. `--allow-empty` can explicitly permit an empty run, but its recorded
status is `skipped`, with zero executed coverage. Invalid modes, flags, and
contradictory fixture selectors fail instead of silently selecting another mode.

## Evidence and limits

The initial Electron TypeScript build and 126 focused tests passed. Adding
adversarial verification tests exposed 13 failures before the fix. After the
verification changes, the expanded baseline passed 222 tests in 25 files.
The first integrated gate passed 295 tests in 29 files plus six replay fixtures.
Seven additional malformed/unsupported assertion probes failed before validation
was added and passed afterward. A full-suite run exposed five stale messaging
expectations; those tests were updated to assert the current receipt and context
contract, with no change to the corresponding production entrypoints.
Original audit validation (before the continuation below):

| Check | Result |
| --- | --- |
| Full suite (`npm test -- --maxWorkers=4`, including bundled-skill checks) | **7,629 passed**, 743 files, two existing TODOs |
| `npm run qa:harness` | **520 passed**, 38 files, plus **6/6** deterministic replay fixtures |
| Root TypeScript check | Passed |
| Electron, daemon, and CLI TypeScript builds | All passed |
| Formatting of modified runtime/QA source and `git diff --check` | Passed |
| Oxlint | Zero errors; 374 warnings across the checkout |
| Security scan and confirmed-fix registration | Completed; static warnings remain candidates, not proof |

The Electron build caught a usage-optional narrowing error that the root type
check missed; all three backend builds passed after correction. Independent
cross-review also found untracked document/canvas/report helper responses; six
response-shape tests now exercise those actual helper paths.

The read-only helper boundary covers verifier and researcher roles, including
entropy sweeps. It disables shell, writes, deletion, and external actions even
under broad custom profiles and saved allow rules. External ACP runtimes are
removed from these workers because they cannot enforce this process's policy
boundary. These workers inspect supplied/local evidence and must return partial
or failure when fresh command/build evidence is missing.

Detailed local logs, original-file snapshots, the ranking experiment, and a
session-only patch are retained at `/tmp/cowork-harness-audit-20260914/`. A
validation manifest records source fingerprints over the preexisting dirty
checkout. No publish, live-provider benchmark, or released-client validation
was performed.

The tracked JSON files under `scripts/qa/eval-cases/` currently include scenario
specifications with assertions that are not executable by the replay grader.
They are not counted as measured coverage. A follow-up capability benchmark
should provide isolated environments and outcome graders for coding, research,
documents, browser work, and multi-agent handoffs; repeat trials per provider
and report success rate, cost, latency, and confidence intervals. Runtime unit
and replay tests do not substitute for those measurements.

## Routing experiment

A fixed-candidate experiment compared the production ranker with two lexical
alternatives on the 27 prompts in `resources/skills/_evals/routing-cases.jsonl`.
All 152 bundled definitions were supplied as candidates; installed-tool
eligibility, model choice, and end-to-end task success were not measured.

| Ranker | Expected skill in top 3 | Forbidden skill at top 1 |
| --- | ---: | ---: |
| Existing production scoring | 21/27 | 0/27 |
| BM25 over identity, description, and use-when text | 23/27 | 0/27 |
| BM25 plus existing intent score | 25/27 | 0/27 |

The hybrid improves aggregate retrieval but regresses a previously passing
scope-control/bug-fix prompt. It is not enabled by this patch. Promoting a
ranking change needs a larger separate test set, eligibility-aware checks, and
preservation of the existing invocation/security boundaries. The old advisory
`skills:check` score is also not a runtime benchmark: its standalone overlap
scorer includes negative examples as positive matching text and differs from
production ranking. Its observed 86.20% hit / 55.50% forbidden-misfire figures
must not be interpreted as production task rates.

## Continuation: remaining audit candidates

The follow-up audit reproduced an additional persistence gap in the fatal tool
dispatch path: ordered tool results were appended to the local turn, but a fatal
error bypassed the normal copy into conversation history. Both the main and
follow-up loops now save that history before propagating the fatal error.

The executor regression checks the actual emitted snapshot, writes it through
the filesystem checkpoint store in a subprocess, kills the writer after commit,
and loads the checkpoint in a fresh process. A fresh executor restores both
tool results without redispatching either call. All 138 executor failure tests
passed in this continuation. This proves committed snapshot recovery, not a
live daemon restart or recovery of external side effects.

Continuation evidence is retained at
`/tmp/cowork-harness-candidates-20260914/`.

### Provider arguments

OpenAI, generic compatible, Azure, OpenRouter, xAI, Ollama, and standalone Pi
converters now preserve malformed calls as structured rejections. Explicit
`{}` and native argument objects are valid; missing, blank, malformed, scalar,
array, and null arguments are rejected. The scheduler rejects them before
preparation, policy, approval, schema repair, or tool execution and preserves
their call IDs and valid siblings.

The alternatives were conversion failure (which loses valid siblings), silent
empty-object defaults (which can execute unintended operations), or an explicit
rejection marker. The marker survives snapshot serialization and restore. A real
executor test confirms that a malformed write never reaches preparation while
its valid read sibling executes and both protocol results are retained.
Six additional provider-specific tests exercise Azure chat/Responses streams,
Azure and xAI Responses conversion, OpenRouter, and native Pi objects. They also
exposed and fixed Azure's streamed fallback labelling tool calls as `end_turn`.
Ollama's local batch limiter also keeps malformed mutations in the rejection
path instead of reporting them as successfully deferred; valid calls retain
their normal execution and deferral limits.

### Independent checkpoint writers

The filesystem store now holds a per-task SQLite transaction across checkpoint
replacement. Its zero busy timeout and asynchronous retry leave the event loop
free. The OS releases the lock when a writer dies. Custom PID/stale-file lock
reclamation was rejected after review exposed ownership and deletion races.

Locks live in the app-owned `~/.cowork/checkpoint-locks` directory, keyed by
canonical workspace path and task ID. Workspace-preseeded symlinks cannot
redirect SQLite writes. `COWORK_CHECKPOINT_LOCK_ROOT` can select an isolated
root; all processes sharing checkpoints must use the same root. Locks cover
processes under the same user, including different profiles and Node/Electron
entrypoints; these tests do not establish cross-host filesystem locking.
Lock databases are retained to avoid replacing a lock inode while another
process still holds it.

The store preserves the freshest valid generation, refuses a late older
snapshot, fsyncs the recovery copy before replacement, and preserves a valid
previous checkpoint when current is corrupt. Eighteen checkpoint/recall tests
pass, including four simultaneous subprocess writers and a real writer killed
after temporary-file sync but before current-file replacement.

### Follow-up acceptance

Queue-only delivery now means that the native worker has durably incorporated
the input into its transcript. It does not mean that the requested work has
completed. The initial acceptance snapshot retains the full pending payload
alongside a consumed message ID. Only then is the receipt acknowledged and the
pending item removed. If acknowledgement fails, restart can retry only the
receipt, without redispatching the provider turn. Keeping both in the first
snapshot avoids depending on a second successful write after a receipt failure.

Acknowledging before `sendMessage()` was unsafe because incorporation could
still fail; acknowledging only after the whole turn was unsafe because a late
failure could cause duplicate execution. The explicit incorporation boundary
separates those outcomes. Failed acceptance persistence rolls back the attempted
input before saving a retry, preserving earlier user turns and the full image
and quoted-message context. Pending queue-only items remain present during
handoff, busy-worker races retain their original payload, and duplicate receipt
retries are serialized under the executor's lifecycle mutex.

The boundary covers native regular and chat follow-ups, queued injection,
pending skill input, and handled goal commands. External ACP runtimes do not
expose durable prompt acceptance; new queue-only requests to those runtimes
are rejected with an instruction to use a normal follow-up. Existing normal
follow-ups retain their behavior. Target receipt persistence is authoritative;
parent timeline projection failures do not undo accepted delivery.

Regression tests exercise snapshot failure, callback failure, ACK-only retry,
receipt replay, preserved payloads, busy-worker handoff, chat incorporation,
and ACP rejection. These checks use isolated state and fake providers. They
do not establish exactly-once external side effects or a live daemon restart.

The three remaining audit candidates are addressed by these changes. The routing
experiment still needs a separate holdout benchmark, and no local test suite can
establish a universal best-in-class ranking.

### Final continuation validation

| Check | Result |
| --- | --- |
| Full suite (`npm test -- --maxWorkers=4`, including bundled-skill checks) | **7,688 passed**, 748 files, two existing TODOs |
| `npm run qa:harness` | **702 passed**, 49 files, plus **6/6** deterministic replay fixtures |
| Root TypeScript check | Passed |
| Electron, daemon, and CLI TypeScript builds | All passed |
| Formatting of 28 changed TypeScript files and `git diff --check` | Passed |
| Oxlint | Zero errors; 373 warnings across the checkout |

Luna Max agents implemented and cross-reviewed the provider, acceptance, and
checkpoint changes. Final validation includes the last acknowledgement-ordering
fix. The expanded `qa:harness` command retains these regressions for future runs.

Logs, source fingerprints, and `continuation-changes.patch` are retained in the
continuation evidence directory above. The patch compares against preserved
before-files in this already dirty checkout. The missing continuation-start
copy of `SessionRuntime.ts` was reconstructed from the prior audit patch and
verified against its recorded SHA-256; `baseline-provenance.json` identifies
that exception. No commit, publication, live-provider benchmark, or released
client validation was performed.

## Final audit: graceful desktop shutdown

A fresh baseline on the existing working checkout passed 702 harness tests in
49 files and six deterministic replay fixtures. The development log was stale
(September 6), but it exposed a shutdown failure still present in current source:
`2026-09-06T13:55:19.795Z` reported `The database connection is not open` while
`AgentDaemon.shutdown()` attempted to persist interrupted task state.

The desktop entrypoint closed the database before calling the async daemon
shutdown, and its async `before-quit` listener did not defer Electron's quit.
Simply swapping those calls would repair database ordering but would still let
Electron exit before asynchronous cleanup. The selected fix explicitly prevents
quit, serializes cleanup, and retries quit only when cleanup settles. Repeated
quit requests join the existing shutdown. Each service failure is reported
without skipping subsequent task persistence and storage cleanup. Agent shutdown
runs before lifecycle listeners, MCP, memory, and the database are torn down.

Coordinator regressions cover delayed task writes, repeated quit requests,
synchronous/asynchronous/hung services, and a failing error reporter. Daemon
regressions verify interruption persistence after monitor stop failures,
concurrent shutdown, and work still awaiting admission.
Three isolated real Electron processes checked normal, failed, and timed-out
shutdown while issuing repeated quit requests. Normal shutdown observed
`snapshot -> interrupted -> database close -> will-quit -> quit`. A failed stop
still attempted task persistence, but kept shared dependencies alive until exit.
A timed-out worker likewise reached quit with the database still open. All
processes exited with code zero. This validates the Electron quit boundary;
it is not a full application restart with live provider work.

Shutdown cancellation now waits for the executor lifecycle mutex to drain.
The daemon fences new execution and follow-ups, tracks task starters that are
still awaiting setup, and prevents late completion callbacks from replacing
interrupted state. Failure to reach quiescence within a bounded wait is explicit;
MCP, memory, and database teardown is skipped until process exit. Ordinary
user/system/tool cancellation stays responsive and does not wait on a mutex
that a self-cancelling tool could already hold.

Evidence and before-file snapshots are retained in
`/tmp/cowork-harness-final-audit-20260914/`. The initial smoke fixture incorrectly
loaded Electron through its npm file path; that fixture-only import was corrected
to Electron's built-in module before the successful run.

### Current comparison criteria

Official product documentation was checked for
[Codex sandboxing](https://developers.openai.com/codex/sandboxing),
[Codex approval boundaries](https://developers.openai.com/codex/agent-approvals-security),
[Claude Code security](https://code.claude.com/docs/en/security), and
[Cursor run modes](https://cursor.com/docs/agent/security/run-modes).
These support comparing enforceable permissions, execution environments, and
human intervention. They do not establish comparative task success rates.
For CoWork, the acceptance criteria are cancellation without new dispatch,
independent sandbox and approval enforcement, bounded child concurrency,
durable steering and attachment recovery, causally complete compaction, and
success tied to current execution evidence. Each environment needs its own
validation: mocked provider, local process, live app, remote daemon, and release.

### Further reproduced boundary failures

| Boundary | Reproduction and selected repair |
| --- | --- |
| Provider call metadata | Missing IDs/names and duplicate IDs could reach dispatch or corrupt tool/result correlation. The common provider factory now normalizes metadata on both normal and token-cap retry responses. Invalid calls receive explicit rejection markers and unique correlation IDs; valid siblings remain unchanged. Synthetic IDs never turn a malformed call into executable work. A factory-to-scheduler test verifies zero preparation for the malformed write and successful execution of its valid read sibling. |
| Azure streamed calls | Responses streams can use `item.id`, `call_id`, and `item_id` for the same function call. Without a final completed-response envelope, arguments were lost. Namespaced aliases now merge deltas/done events into their original calls while retaining distinct siblings. Retrying the whole model request or requiring a completed envelope would discard usable streamed evidence. |
| Structured tool-result bounds | Large metadata and JSON escaping could keep a truncated result over budget. The full serialized object and array omission notice now count toward the limit; oversized structured data falls back to the existing explicitly truncated text excerpt. |
| Hard context exhaustion | Keeping the first task and pinned requirements can make compaction unable to fit the model budget. The runtime now reports exhaustion before dispatch rather than silently dropping user requirements. Recovery cannot report success when the result still exceeds its hard budget. |
| Shutdown failures | Each cleanup step has a bounded wait; a hung producer cannot block every later cleanup step. Orchestration/reliability stop failures are isolated so snapshots and cancellation still run. Failed/timed-out shutdown keeps shared dependencies alive until process exit; timeout is not treated as proof that a worker stopped. |

Scheduler review also found that cancellation could prepare untouched sibling
calls, and thrown preparation/finalization/summary hooks could discard protocol
results. Cancellation now fences preparation. Hook failures retain a fatal error
separately from one correlated tool result per call; already executed siblings
keep their results and unstarted later batches are skipped. Fourteen scheduler
tests cover this boundary, including later mutations after a fatal hook error.


### Durable queued attachments and headless shutdown

Queued follow-ups now persist attachment bytes before acknowledging acceptance.
Private files and manifests use opaque references bound to the task and message,
atomic writes, checksums, validated byte counts, and MIME-compatible extensions.
Recovery validates both receipt-only and snapshot-backed queues. Missing or
corrupt media produces an explicit recovery error and omits the incomplete
message, so text is not silently dispatched without its attachment. A corrected
resend can proceed. Tests exercise the real executor image-loading path as well
as receipt recovery, avoiding a metadata-only success assertion.

The store uses a 2.5 GiB bound with explicit backpressure; it never evicts
undelivered attachments to accept new work. Synchronous persistence preserves
queue acknowledgement ordering, at the cost of blocking during the bounded file
copy. Delivered receipts release files. Task deletion and session pruning capture
validated references before deleting the database record and release only after
successful deletion. Conservative maintenance handles crash-left files after a
24-hour grace period, retaining authoritative receipt references and failing
closed on uncertain ownership. This does not introduce a new restriction on
legitimate user-selected upload source paths; broader upload provenance remains
an existing application boundary, outside this store's opaque-reference checks.

The Node-only daemon also drains agent execution before releasing its control
plane, channels, MCP servers, memory, or database. Repeated termination signals
share one shutdown; failed or timed-out cleanup exits nonzero and skips dependent
releases. Uncaught exceptions retain a nonzero exit status. An isolated SIGTERM
subprocess exercises the shared coordinator's timeout path; this is helper-level
process evidence, not a full daemon restart under live provider load.


### Final local validation for this pass

| Check | Result |
| --- | --- |
| Full suite, including bundled-skill quality gates | **7,761 passed**, 753 files, two existing TODOs |
| Expanded `qa:harness` gate | **777 passed**, 56 files, **6/6** deterministic replay fixtures |
| Root TypeScript check | Passed |
| Electron, Node daemon, and CLI TypeScript builds | All passed |
| Formatting | All 32 source/test TypeScript files checked passed |
| Diff whitespace check | Passed |
| Oxlint | Zero errors; 373 warnings across the checkout |
| Real Electron shutdown fixtures | Normal, failed-stop, and worker-timeout processes passed |
| Headless SIGTERM fixture | Current-source coordinator child exits nonzero after timeout and keeps the database dependency open |
| Security static scan | Completed; all 27 candidates occur on unchanged baseline lines, not newly introduced code |

The full suite was repeated after attachment cleanup and headless shutdown
integration. The initial pass had 7,756 passing tests; the final 7,761 includes
the last cleanup and shutdown regressions. Formatting-only changes were applied
before the final harness pass. These counts measure deterministic local tests;
fixture coverage is not production-corpus or live-provider coverage.

Evidence is in `/tmp/cowork-harness-final-audit-20260914/`, including logs,
`source-manifest.json`, and `session-changes.patch`. Most original files were
snapshotted before edits. Two test baselines were reconstructed from the previous
pass and verified against its recorded hashes; three clean-file baselines were
verified against HEAD. The already-dirty context-overflow test lacked a safe
original snapshot: its final hash is recorded, and it is explicitly excluded
from the session-only patch. This limitation does not affect its executed tests,
but the patch must not be treated as a complete isolated commit. No unrelated
working-tree changes were reset or staged.


The independent final security review found no remaining material regression in
this pass. Its last finding concerned attachment cleanup using separate offset
queries: task reordering could omit an owner. The final implementation reads the
owner set in one SQLite query. A regression with more than 500 tasks exercises
that omission scenario and confirms referenced bytes survive cleanup. The final
full-suite and harness results above include this test.
