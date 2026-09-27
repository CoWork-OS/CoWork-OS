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

## CI and legacy configuration

The former `COWORK_HOOKS_ORIGIN`, `COWORK_HOOKS_TOKEN` and `COWORK_DB_PATH` battery arrangement could connect task submission to an unrelated local database. It is no longer used by this runner.

Release and nightly workflows run explicit disposable fixture checks. They report live coverage as `not_configured`; fixture success never changes that field to `completed`. If legacy hook/database secrets are supplied, the workflow fails with migration guidance instead of silently relabeling fixtures as live coverage. Migrate any intended live automation to an explicitly configured owned-runtime invocation before removing its old configuration. Native comparative automation and complete run manifests belong to the subsequent evaluation-adapter work.

Keep the positive and negative fixture checks, the native integration smoke, actual provider trials, and independent user acceptance as separate validation records.
