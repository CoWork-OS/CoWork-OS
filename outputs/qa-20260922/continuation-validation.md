# CoWork OS continued live QA — 22 September 2026

Continuation of `live-validation.md`. Tested the development desktop against the existing profile using the same isolated scratch tasks. All source changes remain uncommitted, with pre-existing output files preserved.

## Findings and fixes

1. **Terminal timeline stages remained running.** Editing the book-swap brief completed successfully, but its DELIVER stage was never closed because follow-up completion bypassed `completeTask`. Cancellation also cleared in-memory timeline state before closing its active stage. Terminal event handling now closes the current stage with completed/failed/cancelled status; cancellation clears state afterward. Late tool events do not reopen a terminal stage.
2. **Context counted one shell command twice.** Both the correlated executor call and shell detail event were counted. The shared renderer derivation now pairs those receipts, deduplicates call IDs, and keeps separate executions distinct. The RightPanel fallback uses the same derivation.
3. **Generated sandbox file links were inert.** The recovery response produced a real local file but used `sandbox:/private/.../qa-resumed.txt`. React Markdown stripped the href. Local sandbox anchor paths now pass through the existing file preview component; other protocols retain the default filter. Tests cover script/data URLs, remote pseudo-protocol forms and image sources. Clicking the repaired link opened a Text preview showing `resumed`.
4. **Repeat cancellation used a stale tool registry and could become Completed.** After recovery, the next follow-up refreshed the executor's registry but retained a coordinator bound to the old registry. Stop targeted the new registry, leaving the old shell process alive. Registry replacement now updates the coordinator. A cancelled follow-up loop exits without success/artifact publication, and final completion refuses cancelled work.

5. **Negated shell instructions forced execution.** A follow-up asking to read a file and explicitly saying “Do not run shell commands” repeatedly returned the requested text because the harness interpreted the prohibition as a positive shell requirement. Blanket command prohibitions now suppress that requirement; exclusions of a specific command still allow a separate positive command request. Focused tests cover both.

## Live cases and evidence

- **File editing:** task `3c4810f1-189b-4fc1-b85f-a93e1d7d78dd`, `qa-project-brief.md`. Added Transport €25, total €225. Readback and in-app preview retained all three goals and three milestones. Completed in 38 seconds at `2026-09-22T15:58:53.857Z`. Before the fix, DELIVER opened at `.876Z` without a closing group.
- **Initial cancellation:** task `7bab2bf9-d391-4796-bc14-b9f798f6c659`. `sleep 45 && printf 'finished' > qa-cancel-marker.txt` started at `16:02:17.489Z`; stopped at `16:02:33.895Z`. The marker was absent beyond its scheduled write time. Context originally showed two calls; with the renderer fix it showed one.
- **Recovery after cancellation:** same task. Wrote and read `qa-resumed.txt` containing exactly `resumed`, without creating the original marker. Completed in 50 seconds at `16:14:09.794Z`; DELIVER closed at `16:14:09.843Z`. The repaired response link opened the file preview.
- **Repeat cancellation failure:** same task, new `qa-cancel-marker-2.txt`. `logs/dev-20260922-171156.log` at `16:15:37.499Z`: run_command started. Cancelled at `16:15:49.463Z`, stage FIX closed cancelled at `.476Z`, but at `16:16:22.855Z` the command reported success and the marker existed. At `16:16:22.963Z`: `sendMessage loop terminated: cancelled=true`. At `16:16:23.466Z`: `Follow-up finished ... previousStatus=completed`; persisted status was incorrectly completed. These observations drove fix 4.

- **Readback retry loop:** `logs/dev-20260922-172035.log`, `16:22:35.898Z` through `16:24:30Z`: the model repeatedly answered `resumed`; the harness continued issuing provider/quality-refinement calls. Stopped the task after two minutes. Fix 5 addresses the command-intent misclassification.

## Validation status

- 22 focused test suites: **392 distinct tests passed** (375 in the combined run, followed by 43 passing command-intent/entrypoint tests, including 17 additional command-intent cases), including refreshed-registry dispatch, cancelled finalization, terminal timeline stages, shell count deduplication, Markdown link handling and the first-pass regressions.
- `npm run type-check`, Electron TypeScript compilation through `npm run dev:log`, and `npm run build:react` passed.
- Scoped Oxfmt checks and `git diff --check` passed.
- The no-shell recovery completed in 71.7 seconds at `2026-09-22T16:28:56.416Z`, with write/read/checklist operations and **no shell calls**. The recovered file contains exactly `recovered`, and DELIVER closed at `.518Z`.
- **Repeated cancellation passed on the rebuilt app and reused executor.** In `logs/dev-20260922-172544.log`, the new `qa-cancel-marker-3.txt` command started at `16:32:37.791Z`. Native UI Stop cancelled the task at `16:32:54Z`; the shell returned `success=false` after 17.0 seconds at `.798Z`. The active FIX stage closed cancelled at `16:32:54.538Z`. At `16:34:08.821Z`, beyond the original 45-second write deadline, the marker was absent, durable status remained cancelled, and there were zero completion events after cancellation. The live UI still showed Cancelled. The temporary desktop-lock interruption was resolved.

## Limits

Existing provider planning delays, email OAuth errors and unreadable encrypted settings remain outside these fixes. No credentials were changed. Old timeline records were not rewritten. This is bounded desktop acceptance, not full connector/platform coverage.
