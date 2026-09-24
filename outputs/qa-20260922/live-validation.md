# CoWork OS live QA — 22 September 2026

Tested the development app against the existing local profile, using isolated scratch tasks and fictional event data. Source edits were initially clean; the pre-existing untracked `outputs/` folder was preserved. Changes remain uncommitted.

## Real tasks

| Task | Evidence | Result |
| --- | --- | --- |
| Create and read back a community book-swap brief | `3c4810f1-189b-4fc1-b85f-a93e1d7d78dd` | Completed. File has goals, exactly three milestones, and €120 + €35 + €45 = €200. Opened the returned link and verified the in-app Markdown preview. |
| Compare fictional event budgets, before fixes | `089ecf6c-539d-4315-aec5-999f367b34f5` | Correct answer (€200, €160, €40 savings) incorrectly marked failed. Answer bullets became three extra execution steps; the last step failed the research wording heuristic. |
| Identical budget comparison, after fixes | `9f869430-9fa5-48ac-8c45-c6be18b989cf` | Completed in 46 seconds; correct totals, savings, and recommendation. Four actual plan steps, no answer bullets promoted to steps. |
| Contextual follow-up to increase Plan B refreshments by €15 | Same task | Initially completed in 12 seconds: revised total €175, savings €25 against €200. Restart exposed a stale executor-cache bug: quit marked this completed follow-up interrupted, and startup reran it and downgraded its outcome. Fixed and verified with the next follow-up below. |
| Follow-up raising refreshments another €5, to €80 | Same task | Completed in 15 seconds at `2026-09-22T15:36:27.319Z`: total €180, saving €20. Quit immediately while its executor was cached, then reopened. UI and read-only database checks confirmed the result stayed completed, with no error, partial-success downgrade, interruption, or resume event. |

## Fixes

- **Bot/Sessions navigation:** the selected bot forced a render-time Bots override, making Sessions unclickable. Navigation into a bot now selects Bots once, while subsequent manual tab selection is respected. Verified in the live UI while the bot conversation remained open.
- **Partial-result status:** persisted `partial_success` was ignored and shown with a green Finished badge. The projection and header now show an amber Partial result with a review prompt. Verified against the existing Forge conversation.
- **Plan recovery:** standalone answer bullets appended to a numbered plan no longer become executable steps. Bullet-only plans and attached verification checks remain supported.
- **False completion failure:** substantive, explicitly requested direct answers need not include research boilerplate such as “findings” or “according to.” The minimum content requirement and rejection of status-only answers remain intact.
- **Heartbeat shutdown:** stop timers, suppress queued manual wakes, and await active pulse bookkeeping before database cleanup. The desktop shutdown sequence now invokes it.
- **Mailbox shutdown:** stop and drain every service instance that owns background loops. Task-local service instances can replace the active accessor, so relying on that accessor misses the actual timer owner.
- **Completed follow-ups on restart:** terminal task updates now retire the executor's active-cache status. Shutdown also checks durable task status before marking a retained executor interrupted, preventing completed work from being rerun on startup.
- **Native Quit exit:** after asynchronous cleanup, native window closure could fall back to `window-all-closed` and leave the macOS app alive with closed storage. The shutdown helper now reissues an explicit quit after cleanup when this happens. Normal window closing does not initiate cleanup or force an exit. Verified with native menu Quit twice, including once after removing all temporary diagnostics.

## Captured failure evidence

- Earlier captured run, `2026-09-22T12:55:41.873Z`: `unhandledRejection: TypeError: The database connection is not open`, originating from a `HeartbeatService` timer through `AgentRoleRepository.findById`.
- `logs/dev-20260922-160112.log`, `2026-09-22T15:13:40.320Z`: the same error from mailbox autosync; at `.358Z` it also occurred in `processMailboxQueue`.
- `logs/dev-20260922-161526.log`, `2026-09-22T15:18:50.200Z`: mailbox polling still reached a closed database after stopping only the active accessor. This exposed the multiple-instance lifecycle issue, now covered by regression tests.
- With the mailbox ownership fix loaded, shutdown at `2026-09-22T15:27:26.888Z` produced no subsequent closed-database timer errors during the 64-second observation window. This exposed the separate process-exit bug, subsequently fixed.
- `logs/dev-20260922-164042.log`, `2026-09-22T15:41:26.176Z`–`15:41:27.177Z`: cleanup completed, the window closed, and `window-all-closed` fired with zero remaining windows; `will-quit` never fired. An isolated Electron app using the same cleanup helper exited normally, narrowing the issue to CoWork's live lifecycle path.
- `logs/dev-20260922-164244.log`, `2026-09-22T15:43:28.269Z`: the fix reached `will-quit` and `quit`; process exit code 0 followed at `.345Z`.
- Final code without diagnostic hooks: `logs/dev-20260922-164405.log`, `2026-09-22T15:45:15.287Z`: `Electron exited with code 0.` Process inspection confirmed PID 99184 no longer existed, with no forced termination.

## Automated validation

- Fourteen focused test files: 295 tests passed, covering heartbeat/mailbox shutdown, daemon completion/resume/shutdown, follow-up acceptance, plan parsing, completion checks, and the affected renderer projections/components.
- `npm run type-check`, `npm run build:electron`, and `npm run build:react` passed.
- Scoped Oxfmt and `git diff --check` passed. Vite emits existing configuration and chunk-size warnings.

## Limits

- The brief task took 7m31s because planning timed out repeatedly before recovering. This run does not prove those provider delays are resolved.
- Existing Gmail/Microsoft authentication failures and unreadable encrypted settings appeared during startup. Credentials and encrypted user data were not changed.
- This is a bounded desktop QA pass, not full coverage of every connector, platform, or bot handoff.
