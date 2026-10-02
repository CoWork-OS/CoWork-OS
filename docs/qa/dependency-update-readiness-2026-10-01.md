# Dependency update readiness — 2026-10-01

PR #274 updates the compatible dependency batch. pi-ai stays pinned at 0.74.2: 0.87.1 removes the model helpers from the root entrypoint and the runtime OAuth helpers from `/oauth`. Its migration needs separate runtime and authenticated acceptance tests. Dependabot excludes it from the minor/patch group so a 0.x API migration cannot enter a routine batch.

The xmldom 0.9 grader uses `onError` while preserving strict rejection of warnings, malformed XML and DTD/entity declarations. The Electron platform test enforces the pinned Electron 44 major and macOS 13 floor while accepting maintenance patch updates. Host performance types derive from the installed Node API.

Existing main test fixtures now return the repository's successful-save boolean and assert the queued follow-up delivery metadata.

## SQLite exception register reconciliation

The browser preview merged after the last ratchet register update. This change records its existing source sites explicitly; it does not establish worker coverage or performance acceptance. All other per-file limits remain unchanged.

| File | Recorded increase | Existing purpose |
| --- | --- | --- |
| `src/daemon/main.ts` | `getDatabase` 9 → 10 | Browser host connection hand-off at startup |
| `src/electron/main.ts` | `getDatabase` 36 → 37 | Recent-workspace fallback discovery |
| `src/electron/database/repositories.ts` | `prepare` 283 → 300 | Browser task admission/cancellation/Git receipts and scoped task/session queries |
| `src/host/services/browser-navigation-methods.ts` | `prepare` 0 → 1 | Preview profile/workspace permission readback before approval |

These are existing browser-runtime exceptions, not permission to add further host SQL. The browser approval readback has an explicit owner and migration plan in `sqlite-audit-rules.json`. Future increases still fail the ratchet. Moving the remaining host reads and fallback queries behind worker units remains database migration work.

## Validation

Local validation passed: 9,826 tests across 975 files (2 existing TODOs), 70 focused compatibility tests, 20 strict artifact-grader tests, the deterministic CI harness, the SQLite ratchet/audit, type checking, lint, full build, scoped formatting and diff checks. GitHub CI provides platform build validation; authenticated provider and browser acceptance are separate checks.
