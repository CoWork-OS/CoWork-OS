# Live CoWork mutation-tool QA — 23 September 2026

## Reproduced issue

Task `5d324fef-7901-404a-a8b9-8e115fa78c5d` ran in the native app using the disposable workspace `/tmp/cowork-qa-single-write.awmmg3`. Its first request read `qa-invoice.csv`, calculated the exact-cent totals, created `invoice-summary.md` with one `write_file`, and verified the 139-byte result with `read_file`.

A later user follow-up explicitly requested a second file with `write_file` exactly once. The executor treated the completed session's earlier successful `write_file` as if it had exhausted the new request's allowance, so the follow-up could only read the source and replied that `write_file` was unavailable. No `qa-check.md` was created. This reproduced a cross-turn tool-budget leak in the native app.

## Fix and acceptance

The executor now identifies a single-use tool from the latest user request and counts successful calls within that request. Session-wide successful-tool evidence remains available for completion checks, while the active-turn counts are saved and restored with `SessionRuntime` snapshots.

After rebuilding and restarting the app, a fresh follow-up created `qa-check.md` with one `write_file`, read it back, and completed. The UI showed `Completed`; independent disk inspection confirmed the invoice rows and `$9.80` subtotal. The original `qa-invoice.csv` remained unchanged at 42 bytes.

A second native follow-up explicitly requested one `run_command`. It ran `printf %s 'shell-once-ok' > qa-shell-once.txt` once, verified the file with `read_file`, and completed. The UI reported one command for that turn; independent inspection confirmed exactly 13 bytes with no trailing newline.

Live evidence is in `logs/dev-20260923-084809.log` and `logs/dev-20260923-090710.log`. The selected task finished with durable status `completed` and result summary matching the shell-file readback.

## Validation

- Focused executor and session-runtime tests: 141 passed.
- `npm run type-check`, `npm run build:electron`, and scoped Oxfmt checks passed.
- `npm run lint` passed with 0 errors and 393 existing workspace warnings.
- Scoped `git diff --check` passed.

## Follow-up executor acceptance

Additional native-app task runs exposed two completion-harness defects after the file operations themselves succeeded:

- A failed `artifact_presence_required` plan step stayed unresolved when a later successful write created that same target. The UI marked the task “Completed · partial success” despite the exact artifact being written and read back. Reconciliation now resolves only a same-target missing-presence failure when a later successful write proves it, and resolved failures no longer trigger the partial-success waiver.
- The final-answer guard rejected evidence-backed completion responses as operational status. It could keep an earlier “Created …” placeholder over a later verified answer, and a final read-back step that produced no answer could leave the completed task with no direct response. The executor now recognizes concrete verified results and explicit match/mismatch outcomes, prefers a later evidence-backed answer over an operational placeholder, and synthesizes a bounded final response from recorded task evidence when needed.

The latest acceptance task was `3bcf2c82-60eb-4b12-a0a9-0989351d34e0`, started from the native CoWork OS window at `2026-09-23T11:10:42.425Z` in `/private/tmp/cowork-qa-single-write.awmmg3`. It read `attendees-summary.md`, calculated 3 unique attendees and 10 tickets (Lisbon 3, Porto 3, Porto, Norte 4), wrote `attendees-summary-final-pass.md` once, and read the report back. The UI showed `Completed` and the final answer began “Yes”; its tool summary showed `read_file: 2`, `write_file: 1`, and `glob: 1`. The log recorded task completion at `2026-09-23T11:13:30.653Z`. The new report SHA-256 is `f3b0996444c156222fe8f1dd7859bf2d48fcc74bf56a0b646b98974653e8d13c`; the source retained its original SHA-256 `2c02c8d513aef6aaa5e6c6ba83743eadec11a67fb4dbdf49014e74d158b97bd1`.

Focused executor suites passed (348 tests), as did `npm run type-check`, scoped Oxfmt, `git diff --check`, and `npm run build:electron`. The live app log also showed unrelated saved-account refresh failures: at `2026-09-23T11:08:46.541Z`, Microsoft OAuth returned `AADSTS70000: Member name or the login key not found`; at `2026-09-23T11:08:46.542Z`, Google Workspace token refresh returned `Bad Request`, after which mailbox autosync paused. These are account-authentication/environment findings; no account settings were changed.

## Startup failure-state reconciliation follow-up

Packaged-app task `8af6da7e-5a3c-4877-9c5e-2141ca6df799` was created at `2026-09-23T11:59:57.818Z` and failed at `2026-09-23T11:59:57.839Z` because the selected Claude provider had no API key or subscription token. The persisted task event says: `[2026-09-23T11:59:57.840Z] task_status failed: Claude API key or subscription token is required. Configure it in Settings or get one from https://console.anthropic.com/`. On its first run, the native UI still showed “Working” with a Stop task button; reopening the task showed the saved failure. The timing indicates the terminal event can arrive before the renderer registers the task and the optimistic pending snapshot can then hide the already-persisted failure.

Task creation now re-reads the saved snapshot after registering the optimistic row and applies a newer terminal status, including a changed status at the same millisecond timestamp. A later current snapshot still wins. In the source app, an isolated profile with no provider credentials showed “Set up AI first” for a harmless arithmetic prompt and persisted zero tasks, so no task was started without configuration. This verifies the setup gate but does not exercise authenticated task execution of the reconciliation path.

Focused reconciliation tests passed (6), along with `npm run type-check`, `npm run build:react`, scoped Oxfmt, and scoped `git diff --check`. The fresh source run is captured in `logs/dev-20260923-131532.log`; renderer HMR loaded the changed app, and the log contains no runtime exception. Existing large-chunk build warnings remain.

## Direct CLI provider-gate smoke

The installed profile still selects Anthropic but has no configured provider credentials; the local Ollama URL at `http://127.0.0.1:11434` refused the connection, and `cowork providers list` reported no local providers configured. A harmless arithmetic task was run through `cowork-cli` with a separate temporary user-data profile. Task `e46b46a8-4889-4a67-985a-c7894b2481bb` exited with status 1 and the explicit missing-Claude-credential message. Read-only inspection of the temporary database confirmed task status `failed`, terminal status `failed`, and a final `timeline_error`; the command did not leave a pending or running task.

The app task list also contained an old pending “Product Engineer” task created with only a bot-conversation shell event and no user turn. It is an idle bot conversation, not a queued user request, so it was left untouched. `cowork tasks stale` found no stale attached CLI tasks. Reading provider status opportunistically re-encrypted the legacy `llm` secure-settings record into the current format, as implemented by `SecureSettingsRepository`; no credential values were exposed. The Mac locked during settings inspection, so the UI remained on the Ollama settings page. No provider configuration was changed; the secure-storage migration rewrote only its stored representation.
