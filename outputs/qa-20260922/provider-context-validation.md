# CoWork OS provider context and CSV QA — 22 September 2026

## New provider defect

Fresh native-app CSV task `5e86ea63-171c-4af3-b433-62d14dc1f31c` exposed repeated ChatGPT cache-option fallback during planning. In `logs/dev-20260922-174833.log`, `2026-09-22T16:56:35.813Z` records `ChatGPT prompt cache controls rejected; retrying without cache controls`.

Source inspection and failing regression tests showed that the OAuth fallback removed `promptCache`, then retained only the stable system blocks. Current-turn system blocks were no longer added to the messages either, so that context was silently lost. The same loss occurred with explicit cache disablement or absent cache configuration.

The provider now retains all normalized system blocks in original order when prefix splitting is inactive. Active splitting sends the stable prefix as system context and the changing context once, including the case where no stable prefix exists. Authentication and permission configuration are unchanged.

Before the fix: three new regression cases failed, with only `Stable instructions` reaching the provider instead of the stable plus current-turn instructions. After the fix: all passed. A fourth case verifies turn-only context is not duplicated with active cache splitting.

## Native UI checks

- Created a CSV task using only supplied fictional budget data.
- Switched to an older completed task during planning. The fresh task continued running, and the unsent CSV amendment did not leak into the other task.
- Switched back and verified the exact unsent draft was restored.
- Stopped planning after 3m45s of retries. At `2026-09-22T17:00:20.705Z`, logs confirmed cancellation during planning and no error-based failure. UI showed Cancelled.
- Restarted normally and verified both Cancelled status and the unsent draft survived.
- Submitted an identical fresh CSV task on the rebuilt app: `a47d418d-e9c6-4272-9854-8411d368a6e2`, workspace `ui-session-AmfeQc`.
- Its plan completed on the first attempt at `2026-09-22T17:02:44.159Z` in 21.299 seconds. This timing is a single observation, not proof that the provider fix caused the latency difference.

## Checks

- 112 distinct provider/model/settings tests passed across five suites (111 combined, then the provider suite rerun with its additional fourth regression: 31 passing).
- `npm run build:electron` and `npm run type-check` passed.
- Scoped Oxfmt and `git diff --check` passed.
- Source changes are uncommitted. CSV completion, amendment and in-app preview acceptance are still being checked.

## Further issues found during the CSV run

The first post-provider-fix run wrote and read the correct CSV (grand total 131.5), then stalled on its second plan step. Logs show `open_application` at `17:03:36.219Z`, `screenshot` at `17:03:52.844Z`, and a `file://` HTTP PUT attempt at `17:04:17.650Z`; policy blocked all three. The task was stopped through the UI.

Two additional regression tests reproduced the causes:

- Generic “no network or messages” text was treated as native Messages app intent. App recognition now requires an explicit Messages application phrase; ordinary message references no longer activate that GUI path.
- A later “Add a TOTAL row” step omitted the filename and was classified as analysis, hiding write/edit tools. Tabular mutation steps now retain mutation tools when the task context identifies a CSV, TSV, workbook or spreadsheet. Verification/read-only steps retain their prior classification and all execution permission checks remain in place.

The two reproductions failed before the changes and passed afterward. Six suites covering step contracts, tool policy, shell tools, browser tools and network policy passed: 262 distinct tests after adding negative imperative cases. Combined with the provider/settings checks above, this stage has 374 distinct passing tests across eleven suites. Final TypeScript checking passed.

## Rebuilt acceptance and arithmetic failure

Task `93d3c9f6-ecc1-41bb-9c94-a5d6f85b8261` created the correct initial budget and completed at `2026-09-22T17:12:53.465Z`. The saved total was 131.50. Its second plan step successfully used `edit_file` at `17:12:06.065Z`, confirming mutation tools remained available for the tabular step. The native file-link preview displayed the CSV correctly.

The quantity-six follow-up failed numerical acceptance. At `17:14:12.068Z`, the model changed the TOTAL to 135.50, although the three detail rows sum to 135.00. It read the file at `17:14:20.782Z`, marked verification complete at `17:14:27.294Z`, and completed at `17:15:17.599Z`. The final visible reply incorrectly claimed 117.00, a third value. This was a completed task with an incorrect artifact and answer, not a passing check.

The subsequent arithmetic verifier and file-count correction, including rebuilt native-app results, are documented in `arithmetic-and-file-count-validation.md`.
