# Approval boundary validation

Implementation date: 2026-09-18. Local validation, not a release or deployment record.

## No-popup follow-up (2026-09-19)

The default local runtime no longer opens the legacy approval modal. Allowed operations execute
silently. A policy result that remains `ask` is represented by an `assistant_message` followed by
the durable inline `request_user_input` card `approval_decision`, with **Deny** first and an
explicit **Allow once** option. The path covers network/on-request access, credential use, data
export, MCP and other external side effects, eligible outside-workspace paths, and explicit
`allowAutoApprove: false` requests. Hard denials, `approval: "never"`, automated tasks without a
human-input channel, and protected/administrator-restricted paths fail closed. Set
`COWORK_APPROVAL_PROMPTS=on` only to exercise the legacy queue diagnostically.

Startup recovery now reads the complete pending approval and input-request queues. It fails
pending approval rows and assistant approval cards closed instead of reviving them after restart;
the next attempt must create a fresh decision. The one-time memory migration backed up the live
database at `~/Library/Application Support/cowork-os/backups/cowork-os.pre-no-prompt-memory-cleanup-20260919-0129.db`
and rejected 12,679 stale `pending_memory_writes` rows without replaying them. New durable memory
writes auto-commit in the default no-prompt mode; explicit `COWORK_MEMORY_WRITE_APPROVAL_MODE`
values remain available for controlled review runs.

Focused approval, input-request, policy, timeout, registry, and memory tests passed after this
follow-up. The development instance was restarted after the patch so the running main process
now loads the no-popup policy.

Named profiles now authorize routine work from their actual filesystem, shell, network, rule and
consent boundaries. Ordinary allowed work does not create an approval lifecycle. `never` denies
missing authority without prompting; it does not widen sandbox access. Legacy tasks keep their
compatibility policy. New root task creators share the same default-profile normalizer.

Settings migration is versioned and stores the previous representation. Explicit profiles and
legacy restrictions are retained. Pending approvals are bound to operation arguments and effective
authority; policy changes invalidate them. Late responses cannot revive completed tasks, and
concurrent requests resolve independently. Persistent shell grants clear when scope changes.

The macOS sandbox's localhost exception was narrowed to outbound loopback destinations. Native
testing found the previous local-address rule admitted external traffic. The corrected rule permits
workspace writes and denies both a write outside the allowed roots and external TCP access.

## Reproduction and executable coverage

`npm run qa:approval-boundaries` runs the focused policy, migration, path, broker, registered-tool,
and approval-dialog suites. `npm run qa:approval-boundaries:smoke` builds the Electron artifact and
runs isolated, real SQLite-backed daemon/tool scenarios without calling a model provider.

The same smoke can be run against both shipped execution artifacts:

```bash
npm run build:daemon
COWORK_SMOKE_DIST=daemon node scripts/qa/approval-boundary-smoke.cjs
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron scripts/qa/approval-boundary-smoke.cjs
```

The Electron command uses its embedded runtime, not a renderer-driven provider conversation.
The script uses a new temporary database and workspace and removes its own fixtures afterward.
Bounded command scenarios require an available OS sandbox and deliberately fail without one.

| Scenario | Evidence |
| --- | --- |
| Fresh temporary-session note create/update/read/edit/mkdir | Registered tools and real daemon, all three built-in profiles; zero approval calls, rows, events or blocked status |
| Routine bounded shell command | Real registered `run_command`, Ask for approval and Approve for me; OS sandbox active, zero requests |
| Sibling temporary session escape | Bounded shell write using `../` is rejected and leaves the sibling session untouched |
| Eligible external file exception | Exactly one pending row; one-shot response resolves it |
| Bounded `never` | External write denied without an approval request |
| Pending policy narrowing | Changed profile invalidates an outstanding approval |
| Completed task | Late response denied without changing completed status |
| Concurrent requests | Independent decisions; duplicate response inert; task stays blocked while another request remains |
| Cancellation | Aborted execution clears the pending approval |
| Path and capability constraints | Focused canonical-path, protected-path, symlink, profile inheritance, read-only, missing-backend and network suites |
| Migration and creators | Settings v1/v2, bounded `dont_ask`, explicit profile/legacy fields and Control Plane tests |

## Checks completed during implementation

- Harness: 804 tests across 56 files, plus six deterministic replay fixtures.
- Additional surface run: 199 tests across mailbox, improvement automation, cron, Control Plane,
  browser/network policy, and sandbox suites.
- Focused boundary run: 291 tests across policy, migration, path, broker, registered tools,
  approval presentation, file mutation races, sandbox, ACP authority, and Council cron profile
  propagation.
- Execution/network/browser run: 136 tests covering shell, browser, network policy, executor
  cancellation, and follow-up lifecycle.
- Type check, Electron build, Node daemon build, CLI build, and renderer build passed. Renderer reports the
  existing large-chunk warning.
- Real SQLite-backed smoke passed under Node, the Node daemon artifact, and Electron's embedded
  runtime on macOS. Each run covers routine create/update/read/edit/mkdir and bounded shell work
  with zero approval calls, rejects a sibling-session `../` escape, and covers exception, `never`,
  stale-authority, completed-task, concurrent, and cancellation cases.

These runs overlap; their counts must not be added into a unique-test total. The scoped security
harness reports 128 static candidates across 13 high-risk files when run with an explicit file list
and `--fail-on-findings`; it is not a clean gate because its verifier/proof stages are intentionally
not run and its text scanner flags sandboxed `spawn` calls, validated process-management helpers,
and unrelated dirty-file candidates. The candidate report is retained at
`/tmp/cowork-approval-complete-security-report.json`; no candidate was silently suppressed.

The production-fix scenario is recorded in
`scripts/qa/eval-cases/approval-boundary-regression.json` with executable coverage pointers.
The JSON is a regression specification, not an executed model evaluation. The PR regression-policy
command skips outside a pull-request event; no PR/CI or release result is claimed here.

Live OS enforcement is verified on macOS. Linux/Docker and Windows behavior has unit coverage only
in this run. External ACP runtimes cannot enforce the bounded policy and now reject bounded
tasks before spawning. They require explicit unrestricted authority and retain
their separate consent configuration; a native CoWork profile never silently
promotes them to `approve-all`.
