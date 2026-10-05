# Disposable evaluation battery

The battery defaults to synthetic fixtures in a fresh temporary profile and workspace. A fixture pass verifies runner control flow and artifact graders. It does not establish native agent capability or competitive performance.

```sh
node scripts/qa/run_battery.cjs --fixtures-only --json
node scripts/qa/run_battery.cjs --help
```

The artifact checks parse PDF, PPTX and XLSX content and structure. XLSX grading checks ZIP entry counts and declared expansion, then inflates every entry within bounded per-entry and total limits and validates CRCs before ExcelJS reads the workbook. The graders reject corrupt files, missing required content, broken presentation relationships and incorrect spreadsheet results. Semantic checks do not establish visual layout quality. The report identifies available rendering prerequisites and whether they were invoked.

## Native runtime acceptance without paid calls

Build the Node daemon, then run the saved integration fixture. It starts a real daemon with fresh user data, uses a scripted local Ollama-compatible endpoint, dispatches native file tools through a restricted task, and independently reads the resulting file. The negative mode makes completion claims without performing the required tool work and expects rejection. A successful negative fixture therefore reports a failed candidate task.

```sh
npm run build:daemon
node scripts/qa/smoke_native_battery.cjs
node scripts/qa/smoke_native_battery.cjs --false-completion
```

This optional smoke fixture currently requires POSIX process groups. It writes a redacted runtime log and evidence receipt in its own temporary directory and stops its owned daemon. It proves native Control Plane and tool integration with the battery adapter; the scripted model is not a model-quality benchmark or the full live battery.

## Explicit live runs

Live mode uses the compiled Node daemon in an owned temporary profile. It does not attach to an existing desktop profile or trust an unrelated hook endpoint. Use Node 24 or later and a working Node SQLite binding. The runner reports missing prerequisites instead of silently substituting fixtures.

Configure the provider deliberately using `COWORK_QA_LLM_PROVIDER`, optionally `COWORK_QA_MODEL`, and the corresponding `COWORK_QA_*` credential or local endpoint. Supported credential names are `COWORK_QA_OPENAI_API_KEY`, `COWORK_QA_ANTHROPIC_API_KEY`, `COWORK_QA_OPENROUTER_API_KEY` and `COWORK_QA_GEMINI_API_KEY`. Local endpoints use `COWORK_QA_OLLAMA_BASE_URL` or `COWORK_QA_LMSTUDIO_BASE_URL`. The full battery also needs a configured search provider, using a dedicated `COWORK_QA_TAVILY_API_KEY`, `COWORK_QA_BRAVE_API_KEY` or `COWORK_QA_SERPAPI_API_KEY`.

```sh
node scripts/qa/run_battery.cjs --live --allow-provider-calls --allow-network --json
```

That command explicitly permits provider and network use. Before creating a live profile or daemon, the runner requires an inherited finite Linux cgroup v2 `memory.max` limit of 512 MiB or less for the PDF grader child. Full live mode is unavailable on macOS and Windows unless run inside a bounded Linux container; fixture PDF parsing remains available on those platforms. This memory prerequisite is a fail-closed parser bound, not an OS sandbox claim.

Live browser, search and shell scenarios also require a matching task-event tool call and successful result correlated by `toolUseId`; browser-title and shell-version files must match their paired successful tool output. This is route evidence, not a model-quality score. Default approval behavior stops at a pending approval. Consult `--help` for the explicit allow-list interface; never approve unrelated tasks or broader resources merely to make a run pass. Retain the result's mode, configuration, deadline, approval, cleanup and grader details with any acceptance claim.

Windows cleanup is confirmed only when `taskkill /T /F` succeeds and the owned daemon leader exits. If either signal is missing or fails, the runner reports unresolved cleanup and retains the profile. Profile deletion is attempted before the final report; a deletion error marks the run failed and returns the retained path.

A fresh application profile is not an operating-system sandbox. Run untrusted candidates in an appropriately isolated environment. Live provider quality, desktop/browser acceptance, rendered document quality, and head-to-head comparisons require separate evidence.

## Memory evals

`npm run qa:memory-evals` runs four deterministic, offline suites over the memory engine (audit §8.5 of [memory-system-audit-2026-10-03.md](memory-system-audit-2026-10-03.md)). `npm run qa:harness` runs them as its last step, so CI runs them too.

Each suite creates a fresh profile database with the real schema in a temporary directory. It runs the real services over that database: `MemoryService` archive capture and search, the conversation index, the knowledge graph, `MemoryWriter`, `MemoryRecall` with its production lanes, `MemoryInjectionPolicy`, `MemoryContextBuilder`, the `memory_recall` tool and the briefing search. Nothing uses the network or a model, and the desktop app is not needed.

The fixtures are JSON files in `src/electron/memory/__tests__/evals/fixtures/`. Each suite is its own test file (`*.eval.test.ts`), so the services' process-wide state never carries over from one suite to the next. `COWORK_MEMORY_EVALS_STRICT=1`, which the npm script sets, makes a missing native SQLite binding fail the run instead of skipping it.

| Suite | Fixture | Measures | Gate |
|---|---|---|---|
| Golden recall | `golden-recall.json` | recall@5, recall@1, MRR and recall@5 per language. The set is 27 queries in English, Turkish and German plus file names, over saved facts, archive rows, earlier conversations and knowledge-graph entities (names, descriptions and observations), with distractors in a second workspace. Current results (2026-10-03): recall@5 1.0, recall@1 0.889, MRR 0.944. | recall@5 ≥ 0.90, MRR ≥ 0.75, no hits from another workspace, no lane errors |
| Write hygiene | `write-hygiene.json` | A task event stream, replayed 3 times, goes through the capture salience gate and `MemoryService.capture` the way the daemon does. A fact stream goes through `MemoryWriter`. The fact stream includes repeats, contradicting subjects, secrets, raw telemetry, third-party text and `<no-memory>`. | No telemetry rows. Archive and memory-item duplicate rate ≤ 1%. Each named subject has exactly one active row, holding the newest value the trust rules allow. No secret anywhere text is stored (archive content and summary, observation metadata, memory items, archive FTS). Expected skip reasons. Expected archive rows per task. |
| Injection | `injection.json` | L0/L1 blocks per context: private, sub-agent (default and with memory retained), group, trusted group, public, verifier, `<no-memory>`, memory off. 60 filler facts push the blocks past their budgets. | No private, third-party, other-workspace, other-task or forgotten item in any block. A single-valued subject and a repeated fact appear once. Every block fits its token budget. The pinned rule survives budget pressure. Contexts that must get no memory get none. |
| Privacy leak | `privacy-leak.json` | 8 probes: `memory_recall` (index, full, listing, expanding forbidden ids), unified recall (index, full, ids) and the briefing search. Each probe looks for suppressed, redacted, private, forgotten, superseded, expired, third-party and foreign-workspace records. | 0 leaks, checked by ref and by a marker in the output. Every visible record is found, so an empty result cannot pass. |

`COWORK_MEMORY_EVAL_REPORT_DIR=<dir>` writes one JSON report per suite (`<suite>.json`): metrics, thresholds, failures, and details such as the golden-set misses and the per-context token counts. Every suite also prints a one-line summary to stderr.

Two limits apply. The archive lane runs its host search here; the FTS worker's hybrid ranking is covered by its own tests. The private archive rows of the user's own workspace are readable on the owner's tool surface by design ("private" means not shared externally), so the privacy suite forbids them only on surfaces that can reach a channel (the briefing).

## Memory health check

`npm run qa:memory-health` (`scripts/qa/memory-health.mjs`) is Appendix A of the memory audit as a script. It opens a profile database read-only and prints aggregate counts only, never memory content:

- per-store sizes
- the archive's age split, telemetry ratio and duplicate rate
- `memory_items` by status, source, scope and kind
- curated entries (until the legacy data retirement drops the table)
- pending writes
- core memory candidates
- Dreaming runs (including stuck runs)
- heartbeat runs (including stuck runs)
- conversation index sizes
- markdown index paths
- orphan embeddings
- the one-time migration markers

The script reads the desktop profile by default. Choose another database with `--db <path>`, `COWORK_DB_PATH`, `--user-data-dir` or `--profile`. Use `--json` for machine output.

The script never writes the database:

- It opens it with `readonly: true` and `PRAGMA query_only = ON`.
- A WAL database whose `-wal` file is absent (the app is closed) is read into memory instead. Otherwise SQLite would create side files.
- Above `--snapshot-limit-mb`, SQLite may leave empty `-wal`/`-shm` files. The script reports them in `db.sideFilesCreated` and never deletes them.

No threshold applies unless one is passed. `--ci` applies the audit §9 targets: telemetry ratio ≤ 0.05, duplicate rate ≤ 0.01, no stuck heartbeat runs. The `--max-*` and `--min-memory-items` flags set individual checks.

| Exit code | Meaning |
|---|---|
| 0 | All checks passed |
| 1 | A threshold was breached; the failed checks are named |
| 2 | The database is missing, cannot be opened, or a flag is invalid |

`tests/qa-memory-health.test.ts` builds fixture databases with the real schema and checks the numbers and the exit codes. It also checks that every run leaves the database byte-for-byte unchanged.

## CI and legacy configuration

The former `COWORK_HOOKS_ORIGIN`, `COWORK_HOOKS_TOKEN` and `COWORK_DB_PATH` battery arrangement could connect task submission to an unrelated local database. It is no longer used by this runner.

Release and nightly workflows run explicit disposable fixture checks. They report live coverage as `not_configured`; fixture success never changes that field to `completed`. If legacy hook/database secrets are supplied, the workflow fails with migration guidance instead of silently relabeling fixtures as live coverage. Migrate any intended live automation to an explicitly configured owned-runtime invocation before removing its old configuration. Native comparative automation and complete run manifests belong to the subsequent evaluation-adapter work.

Keep the positive and negative fixture checks, the native integration smoke, actual provider trials, and independent user acceptance as separate validation records.
