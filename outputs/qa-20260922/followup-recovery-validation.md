# CoWork OS follow-up recovery QA — 22 September 2026

This third desktop pass used the existing scratch task `7bab2bf9-d391-4796-bc14-b9f798f6c659` after its delayed command was cancelled. Earlier findings are recorded in `live-validation.md` and `continuation-validation.md`. Changes remain uncommitted.

## Reproduction

Submitted through the native composer:

> New request, independent of the cancelled command: reply exactly "Recovery acknowledged." No tools are needed. Leave the cancelled command and its checklist untouched.

Before the fixes, the app repeatedly displayed the requested answer and remained running. `logs/dev-20260922-172544.log` records iteration 6 ending at `2026-09-22T16:44:08.094Z`, 399.1 seconds into the follow-up, then starting iteration 7. The native Stop action ended the reproduction after about seven minutes.

The persisted session was classified as writing. This exposed three related defects:

1. **Exact short replies were rejected by the writing/research length gate.** Completion now accepts a response that exactly matches a literal explicitly requested by the user. Other short or mismatched writing/research outputs still fail their content checks.
2. **New requests inherited old verification obligations.** A terminal task's next follow-up now has a scope boundary. Pre-finalization reminders and pinned checklist nudges only enforce checklist work created or updated during that new run. Original task execution/test/visual requirements do not become mandatory for unrelated new requests. Nonterminal continuations retain their requirements, current-run verification remains enforced, and checklist history is preserved. The boundary survives turn-limit recovery.
3. **Successful text-only recovery could restore Cancelled.** Both chat and tool-capable follow-up paths now share successful finalization. A successful reply after failed/cancelled/completed work publishes a fresh completion and clears terminal failure metadata. Paused informational follow-ups retain Paused, and active cancellation still prevents completion.

## Live acceptance on rebuilt app

`logs/dev-20260922-174833.log`:

- `2026-09-22T16:50:04.645Z`: exactly one assistant message, `Recovery acknowledged.`
- `2026-09-22T16:50:06.977Z`: `Follow-up finished | iterations=1/32 | toolCalls=0 | hadToolCalls=false | hasTextResponse=true | previousStatus=cancelled | elapsed=9.3s`.
- `2026-09-22T16:50:06.979Z`: task completion persisted with the fresh result summary.
- `2026-09-22T16:50:07.099Z`: DELIVER stage closed completed.

Native UI showed Completed and Worked for 11s. Read-only database inspection confirmed `status=completed`, `result_summary=Recovery acknowledged.`, and no error or terminal failure status. The old checklist items were byte-for-byte equal in the before/after snapshots; the cancelled marker `qa-cancel-marker-3.txt` remained absent. No tools ran during the acceptance follow-up.

## Automated checks

- Six focused suites, **177 tests passed**: executor entrypoints, chat mode, follow-up acceptance, command requirement, completion checks, and SessionRuntime. Includes ten added cases for terminal recovery, cancellation, paused state, old/current checklist scope, and exact writing/research replies.
- `npm run type-check` passed on final source.
- Electron TypeScript compilation passed during the successful development launch. An intermediate compile caught and led to correction of a chat status parameter typed too broadly as string.
- Scoped Oxfmt checks and `git diff --check` passed.
- Prior runtime quit cleanly: `2026-09-22T16:47:11.630Z`, Electron exit code 0.

## Scope

This is live desktop acceptance of follow-up recovery, not exhaustive product coverage. Existing encrypted-settings/OAuth failures and provider latency remain separate limitations from earlier passes. No credentials or account configuration were changed.
