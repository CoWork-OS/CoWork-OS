# Async SQLite migration: DB0 baseline, DB1 to DB6 results

Date: 2026-09-27. Status: DB0 and DB1 landed; DB2 foundation and pilot, DB3, DB4, and DB5's worker route landed as opt-in; DB5's revision checks apply on every backend. Plan: [async-sqlite-migration-plan-2026-09-27.md](async-sqlite-migration-plan-2026-09-27.md).

This records the first DB0 deliverables and the baseline they produced. It is a synthetic, database-focused workload on one machine, not a release audit or field measurement.

## What DB0 added

| Piece | Where | Notes |
| --- | --- | --- |
| SQLite instrumentation | `src/electron/database/sqlite-instrumentation.ts` | Wraps the main `DatabaseManager` connection: every statement, `exec`, `pragma`, and transaction is timed and grouped by a SQL fingerprint with literals removed. Bound parameters are never recorded. Nested statements inside a transaction are not double-counted in host time. Busy-timeout waits are included in the waiting statement's duration. Disable with `COWORK_DB_INSTRUMENTATION=0`. |
| Slow-operation warnings | same module | Operations at or above `COWORK_DB_SLOW_MS` (default 100 ms) log `[DbSlow] {json}` with the nearest application frames, at most once per fingerprint per minute. |
| Event commit timing | `AgentDaemon.persistTimelineEvent` | `timeline.insert` times the authoritative TaskEvent insert; `timeline.persist` times insert plus projections and activity logging. |
| Host monitor | `src/electron/utils/host-perf-monitor.ts` | Started in desktop, daemon, and direct CLI. Each window (default 60 s, `COWORK_HOST_PERF_INTERVAL_MS`) produces `[HostPerf] {json}`: event-loop delay percentiles and utilization, SQLite host time and share, per-kind latency, and the top fingerprints. Logged at info when dev log capture or `COWORK_HOST_PERF=1` is on, and at warn whenever event-loop p99 reaches `COWORK_HOST_PERF_WARN_P99_MS` (default 250 ms). `npm run qa:perf:summary` summarizes these lines. |
| Static inventory | `npm run qa:db:inventory` | Per-file and per-area counts of `prepare`, `exec`, `pragma`, transactions, IMMEDIATE, `getDatabase()`, repository constructions, and `better-sqlite3` imports, plus every transaction site with its enclosing member. `--json <path>` writes the machine-readable form for the DB1 ratchet. |
| Disposable workload | `npm run qa:db:workload` | Builds `dist/cli`, then runs each scenario in its own process on a fresh profile under the OS temp directory. Sessions drive the real `AgentDaemon.logEvent` path with memory capture enabled; a seeded stub replaces model and tool latency. A renderer-style read (`findRecentByTaskId`, 600 events) runs every second. The lock scenario holds `BEGIN IMMEDIATE` from a second process. Results go to `logs/sqlite-workload/`. |

## Baseline run

| Field | Value |
| --- | --- |
| Revision | `eff5d1262` with uncommitted changes (the DB0 work and pre-existing edits) |
| Runtime | Node v24.14.1 (ABI 137), `better-sqlite3` 13.0.3, SQLite 3.53.4, darwin-arm64 (Darwin 25.6.0) |
| Hardware | Apple M3 Max, 16 cores, 128 GB |
| Fixture | 200 completed tasks x 100 events (20,000 historical events); tool results average 4 KB, every 25th is 64 KB |
| Session | 20 steps per task; stub latency about 70 ms per step plus 10 ms per tool call; 6 logged events per step, plus the stage-transition events the daemon adds |
| Scenarios | 1, 8, 20, and 40 active tasks; 50 submitted with 8 running at a time (emulated admission, not `TaskQueueManager`); 8 tasks with a 2-second cross-process write lock |

| Scenario | Events | Events/s | Loop p99 | Loop max | Probe p99 | Insert p95 | Persist p95 / p99 | Host SQLite (share) | Loop utilization |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| active-1 | 125 | 49.1 | 47 ms | 51 ms | 11 ms | 0.4 ms | 3.4 / 7.7 ms | 0.3 s (11%) | 0.32 |
| active-8 | 1,007 | 171.4 | 144 ms | 230 ms | 102 ms | 0.2 ms | 6.2 / 8.4 ms | 2.7 s (46%) | 0.87 |
| active-20 | 2,519 | 184.9 | 346 ms | 574 ms | 262 ms | 0.2 ms | 6.9 / 9.0 ms | 7.6 s (56%) | 0.96 |
| active-40 | 5,039 | 177.6 | 726 ms | 1,023 ms | 615 ms | 0.2 ms | 7.8 / 9.5 ms | 16.6 s (59%) | 0.98 |
| admission-50x8 | 6,299 | 148.7 | 176 ms | 406 ms | 131 ms | 0.2 ms | 8.6 / 10.4 ms | 22.4 s (53%) | 0.86 |
| lock-2000ms-8 | 1,007 | 123.3 | 204 ms | 2,225 ms | 113 ms | 0.2 ms | 6.5 / 9.3 ms | 4.9 s (60%) | 0.90 |

"Probe" is the delay before a `setImmediate` callback scheduled every 20 ms, a stand-in for a lightweight IPC or health request. Host SQLite share is top-level SQLite time divided by wall time.

## Findings

1. **The host thread saturates at about 180 persisted events per second.** Throughput stops rising after 8 active tasks while event-loop utilization reaches 0.96 to 0.98. At 40 tasks, 59% of wall time is spent inside SQLite calls on the host thread, event-loop p99 is 726 ms, and the setImmediate probe waits 615 ms at p99. The 40 sessions took 28 s; one session alone takes 2.5 s.
2. **A cross-process write lock stalls the host for its full duration.** One `INSERT INTO task_events` waited 2,098 ms while another process held the lock for 2,000 ms, and event-loop max reached 2,225 ms. This is the case the plan's host-responsiveness criterion targets.
3. **The authoritative insert is cheap; the work around it is not.** `timeline.insert` p95 is about 0.2 ms, while `timeline.persist` p95 is 6 to 9 ms. Each persisted event runs about 52 top-level SQL statements.
4. **Operational-metric retention is the largest single cost.** `WorkSessionOperationalMetricsRepository.record` calls `prune` after every insert, and the workspace-scoped `DELETE ... WHERE workspace_id = ? AND id NOT IN (SELECT ... ORDER BY recorded_at DESC LIMIT ?)` ran 10,158 times for 8.1 s at 40 tasks: 49% of all host SQLite time. Two metric rows are recorded per event.
5. **The task row is re-read about nine times per event.** `SELECT * FROM tasks WHERE id = ?` ran 44,492 times for 5,039 events at 40 tasks (0.8 s).
6. **Memory capture adds a quota scan and several writes per captured event.** The per-workspace size query (`SUM(length(content) ...) FROM memories`, `repositories.ts`) took 1.4 s at 40 tasks, and the memory and observation inserts and updates about 1.7 s.
7. **The fixture dominates the WAL and memory figures.** WAL was about 55 MB and RSS 0.7 to 1.0 GB at the end of every scenario, including the single-task one, so these reflect seeding and loaded services more than the workload.

DB1 addressed findings 4 and 6; finding 5 is deferred (see below).

## DB1 results

Same machine, fixture, and workload, run on the same working tree plus the DB1 changes.

| Scenario | Events/s | Loop p99 | Loop max | Host SQLite |
| --- | --- | --- | --- | --- |
| active-1 | 49.1 → 52.6 | 47 → 26 ms | 51 → 58 ms | 0.27 → 0.19 s |
| active-8 | 171.4 → 220.8 | 144 → 88 ms | 230 → 124 ms | 2.7 → 1.5 s |
| active-20 | 184.9 → 248.4 | 346 → 242 ms | 574 → 377 ms | 7.6 → 4.1 s |
| active-40 | 177.6 → 256.6 | 726 → 551 ms | 1,023 → 1,007 ms | 16.6 → 8.6 s |
| admission-50x8 | 148.7 → 206.3 | 176 → 110 ms | 406 → 229 ms | 22.4 → 11.1 s |
| lock-2000ms-8 | 123.3 → 149.2 | 204 → 139 ms | 2,225 → 2,137 ms | 4.9 → 3.6 s |

What changed:

- **Explicit durability.** The main connection sets `synchronous = NORMAL`, the level existing profiles already used.
- **FTS worker.** An exit with code zero is treated as a crash, and events from a replaced worker are ignored. `searchByContentMarkerAsync` treats an empty worker result as final. `searchAsync` takes local and imported lexical matches from the worker and ranks them on the host with the semantic stage only; if the worker fails it returns semantic-only results instead of rerunning FTS on the host. The worker's imported-memory query filtered on a column that does not exist and always returned nothing; it now shares the host's filter.
- **Maintenance.** `pruneOldEvents` deletes in 500-row batches and yields between them. Full `VACUUM` runs only while this runtime has no running or queued tasks, otherwise it is retried every 30 minutes.
- **Operational-metric retention.** The per-insert prune walks the scope index past the retained rows (`LIMIT -1 OFFSET n`) instead of anti-joining them. Retention is unchanged, and each prune is about six times cheaper.
- **Memory quota.** A capture trusts the last measurement plus the bytes added since while the estimate stays under 80% of the cap and is under five minutes old. Bulk imports and cleanup always measure.
- **Enforcement.** `npm run qa:db:ratchet` checks the exception register (`scripts/qa/sqlite-ratchet-baseline.json`: 1,818 `prepare`, 141 `getDatabase()`, 97 runtime imports across 143 files) and runs in `npm run test`. `npm run lint` now includes a type-aware `no-floating-promises` and `no-misused-promises` pass over the files in `eslint.async-sqlite.config.mjs`.

Measured and rejected: one transaction per timeline event with a savepoint per projection cost 15 to 20% throughput, and a plain wrapping transaction gained nothing. See the plan's DB1 subsection.

Instrumentation overhead: about 2% throughput at 20 tasks (248 events/s with it, 252 to 254 without).

Closed after the first DB1 run:

- **Task lookups.** `AgentDaemon.logEvent` runs inside `withTaskRowReadScope` (`repositories.ts`): raw `tasks` rows are cached for that synchronous call and mapped into a fresh object per read, so callers never share state. Every statement that writes `tasks` invalidates the cache; `tests/task-row-read-scope.test.ts` fails if a member writes `tasks` without invalidating. Reads dropped from 8.8 to 1.0 per event, and throughput rose to 244, 269, and 288 events/s at 8, 20, and 40 tasks (from 221, 248, and 257).
- **Promise lint coverage.** The four daemon and memory findings and the eight in `main.ts` are fixed. The queue-advance and transient-retry promises now log failures with context instead of becoming unhandled rejections, which would terminate the direct CLI; the `main.ts` sites keep their behaviour and are marked explicitly, since its process-level handler already logs them. The lint pass now covers 15 files, including `daemon.ts`, `main.ts`, and `MemoryService.ts`.

Still open: the cross-process lock stall, which needs the DB2 worker.

## DB2 results

The worker foundation is in `src/electron/database/async/` and is opt-in: with `COWORK_DB_WORKER=1`, desktop, daemon, and direct CLI start one write-capable worker after `DatabaseManager` has created and migrated the schema. Without the flag, or if startup fails, the run uses the host backend throughout.

| Piece | Behaviour |
| --- | --- |
| `database-worker.ts` | Owns one connection (opened with `fileMustExist`, shared pragmas from `connection.ts`, 50 ms busy wait). Checks the tables its commands need before reporting ready. Runs requests in order; writes run in an IMMEDIATE transaction and reply after COMMIT. A write that meets another process's write lock is parked and retried by one probe with backoff (10 to 250 ms) until its deadline, while reads without a shared ordering key keep running. Queued requests past their deadline are rejected as not committed. Shutdown drains the queue, closes the connection, and reports `drained`. |
| `DatabaseClient.ts` | Host side. Typed `execute` for registered commands; every failure is a `DatabaseRequestError` with a code and an outcome (`not_committed` or `unknown`). Pending work is capped at 256 requests and 8 MB of arguments. Any unexpected exit, including code 0, fails in-flight writes as `unknown` and restarts the worker with a new generation (up to 3 times, backoff from 500 ms); stale-generation replies are ignored. `close()` reports whether the drain finished. |
| `commands.ts` | The command registry. Pilot commands: `maintenance.pruneTaskEventsBatch` (bounded write, idempotent) and `maintenance.storageStats` (read). |
| Daemon maintenance | With the worker, event pruning runs as repeated worker batches and the run logs storage stats from the worker. A worker failure fails that maintenance run; it does not fall back to host pruning. |
| FTS worker | Now started in the daemon and direct CLI as well as desktop, so prompt recall works there; `tsconfig.daemon.json` and `tsconfig.cli.json` emit both workers. |

Evidence:

- `src/electron/database/async/__tests__/DatabaseClient.test.ts` bundles the current worker source with esbuild and runs it against real SQLite, with no native-module skip guard. It covers commit, rollback, order, invalid commands, a 300 ms statement without a host stall (under 100 ms), a parked write behind another connection's lock while a read completes and the host stays responsive, busy and queue deadlines, the pending cap, commit-then-exit reported as `unknown` and reconciled after restart, exhausted restarts, startup failures that never create a database, a full drain on close, and an incomplete drain.
- `npm run qa:db:worker-smoke` builds all three targets and starts both workers from `dist/electron`, `dist/daemon`, and `dist/cli` under Node, and from `dist/electron` inside Electron 44.4.3 (ABI 149).
- `src/electron/agent/__tests__/daemon-maintenance-worker.test.ts` checks that maintenance picks the backend once per run and never falls back after a worker failure.

Not yet covered in DB2:

- **Timeline and other domains** still write on the host; DB3 moves timeline persistence to the worker.
- **Operation receipts** (`logical operation ID` plus stored results) are not needed by the idempotent pilot and arrive with DB3's non-idempotent mutations.
- **Packaged builds.** Worker loading from the packaged ASAR is qualified in DB7.
- **The lock test holds the lock for about 300 ms**, not the plan's two seconds, to keep the suite fast; the parking path is the same.

## DB3 results (first slice)

With `COWORK_DB_WORKER=1 COWORK_DB_WORKER_TIMELINE=1`, the WorkSession projections of each timeline event (protocol items, contracts and evidence, session progress, reliability metrics and leases) run in the database worker. The choice is made in `AgentDaemon.initialize()` and holds for the run.

| Piece | Behaviour |
| --- | --- |
| Outbox | `timeline_projection_outbox` (new, additive table). The host commits the TaskEvent and its outbox row in one IMMEDIATE transaction. |
| Worker commands | `timeline.drainProjectionOutbox` projects the oldest entries and deletes them in the same transaction, stopping after about 5 ms of work so the host's inserts are not held off the write lock for long. `timeline.skipProjectionOutboxHead` drops an entry that aborts its transaction repeatedly. `timeline.maintainLeases` runs lease upkeep where the lease tokens now live. |
| Host queue | `TimelineProjectionQueue` requests drains after each insert, retries failed drains with backoff, triggers lease upkeep, and warns when more than 1,000 events wait. `flush(taskId)` is the read barrier; it fails explicitly after 10 s if the worker is unavailable. |
| Barriers | `sendMessage` and managed-session steering wait before the stale-turn check; replay evaluation waits before reading session items. |
| Repair | A run with the worker drains entries left by the previous run first. A run on the host backend drains any leftover entries inline in `initialize()`, so switching back is safe. |
| Consistency fixes | The protocol backfill only projects events up to the one being recorded (it saw later events when projections trailed inserts). WorkSession protocol and contract transactions begin IMMEDIATE, since the host and the worker now both write those tables. |

Evidence:

- `src/electron/database/async/__tests__/timeline-projection.test.ts` runs a ten-event script (user message, tool call, approval, completion) through the bundled worker against the real schema and services. Derived state (row counts in nine WorkSession tables, item kinds, sequences and source events, wait states, and progress contents) matches inline host projection exactly. It also covers repair after a run that never projected, a worker exit before COMMIT (entry kept, nothing projected), an exit after COMMIT but before the reply (no double projection), an explicit barrier failure while the worker is down, and lease upkeep.
- `src/electron/agent/__tests__/daemon-timeline-projection.test.ts` checks backend selection, the outbox write without inline projections, and host-side repair.
- The parity test found the backfill ordering bug before the fix; it failed on wait-item order and one extra metric.

Workload, same machine, host backend against worker projections (`--worker-timeline`):

| Scenario | Events/s | Loop p99 | Host insert p95 | Projection lag after the burst |
| --- | --- | --- | --- | --- |
| active-8 | 229 → 280 | 78 → 60 ms | 0.25 → 10.3 ms | 134 ms |
| active-20 | 257 → 395 | 223 → 126 ms | 0.22 → 1.5 ms | 2.1 s |
| active-40 | 270 → 449 | 445 → 237 ms | 0.23 → 0.23 ms | 5.8 s |
| admission-50x8 | 215 → 252 | 120 → 73 ms | 0.22 → 10.7 ms | 31 ms |
| lock-2000ms-8 | 161 → 177 | 81 → 62 ms | 0.20 → 5.6 ms | 92 ms |

Reading the numbers:

- **The host is freer, derived state trails.** The worker projects about 300 events per second, the same rate the host managed, so under a sustained burst above that the backlog grows (5.8 s at 40 tasks) while the host keeps accepting events. At normal agent pace the lag is tens of milliseconds.
- **Batch length is a trade-off.** Longer worker transactions project faster but make the host's own inserts wait on the write lock; the table shows the 5 ms budget. A sweep from 1 event per batch to 64 moved 40-task throughput from 476 to 328 events/s and lag from 7.1 s to 0.4 s.
- **Host insert p95 rose at low concurrency** (about 10 ms) because the insert now occasionally waits for a worker transaction; loop delay still improved.
- **The cross-process lock still stalls the host for its full duration**, because the insert runs on the host.

### DB3 follow-up: writes in the worker

The open points from the first slice, closed:

| Point | What changed |
| --- | --- |
| Insert off the host | `TimelineWriter` (`src/electron/database/async/TimelineWriter.ts`) sends events, activity rows, and usage rows to the worker in ordered batches (`timeline.applyWrites`). Repository reads and writes of a task's events and of the activity feed commit that task's pending rows on the host first (`timeline-write-registry.ts` hooks in `TaskEventRepository`, `TaskRepository.delete`, `ActivityRepository`, and `queryTaskEvents`). Inserts are idempotent by id, and the outbox row is written only by the insert that took effect. When the worker is not ready, or the backlog passes 2,000 rows or 32 MB, the host commits the backlog itself. Shutdown commits anything left. |
| Approval and input admission, follow-ups, snapshots, Control Plane | Lifecycle, approval, input-request, user-message, follow-up, and snapshot events are committed before `logEvent` returns (until DB6 slice C2, below). Control Plane and managed-session callers read through the repositories, so they see pending rows. The progress IPC waits up to 500 ms for projections. |
| Faster projections | The worker connection is instrumented (`diagnostics.sqliteSnapshot`). Operational-metric retention now runs every `retention / 20` inserts per scope instead of after every insert (a scope may exceed its retention by that much), and progress rebuilds are coalesced to once per task per drain batch. Worker cost fell from 1.66 to 1.28 ms per event. Runtime checkpoints wait for the worker instead of forcing a host commit; host-committed events fell from 73% to 5 to 7%. |
| Backpressure | Executors await `waitForTimelineCapacity()` before each model call: when more than 1,000 events wait for projection they pause until 500 remain, or 30 s pass. |

Workload, same build, host backend against worker writes (`--worker-timeline`):

| Scenario | Events/s | Loop p99 | Probe p99 | Host persist p99 | Lag after burst |
| --- | --- | --- | --- | --- | --- |
| active-8 (three runs) | 262 to 267 → 293 to 305 | 63 to 70 → 52 to 64 ms | 46 to 58 → 31 to 35 ms | 6.9 → 0.3 ms | 64 ms |
| active-20 | 311 → 393 | 196 → 153 ms | 167 → 93 ms | 7.4 → 0.2 ms | 1.3 s |
| active-40 | 316 → 475 | 441 → 214 ms | 314 → 158 ms | 8.0 → 0.2 ms | 4.4 s |
| admission-50x8 | 240 → 276 | 99 → 68 ms | 68 → 40 ms | 8.9 → 0.2 ms | 11 ms |
| lock-2000ms-8 | 172 → 178 | 75 → 109 ms | 57 → 48 ms | 6.6 → 0.3 ms | 56 ms |

Evidence added: real-worker tests for writer parity with inline projections, a host read racing an in-flight batch (no duplicates), activity and usage rows written once, and a full commit at stop (`timeline-projection.test.ts`, 10 tests); daemon tests for pending rows, flush-through on read, durable milestones, and the not-ready fallback; backpressure tests (`TimelineProjectionQueue.test.ts`); and a bounded-overshoot test for metric retention.

Remaining after DB3:

- **Foreign write locks still stall the host** (2.1 s for a 2 s lock). The remaining per-event host writer is memory capture (`MemoryService`), which moves with the memory domain in DB6; host reads of a task with uncommitted rows also wait while they commit them.
- **Crash window.** Accepted non-milestone rows that neither side committed yet (at most one batch, a few milliseconds) are lost if the process dies. Milestones are not affected.
- **Reporting reads are eventually consistent.** Raw SQL over `task_events`, `activity_feed`, and `llm_call_events` in reports, eval, and insights can miss rows by milliseconds.
- **Projection throughput.** The worker spends about 1.3 ms per event, and under the 40-task burst derived state still trails by 4.4 s; sustained bursts are paced by the backpressure gate rather than removed.

## DB4 results

DB4 needed its own fixture, because the DB0 workload has no history: `npm run qa:db:reads` seeds a heavy profile (2,000 completed tasks of 100 events, a 15,000-event session, 50,000 usage rows, 20,000 memories with embeddings; 485 MB) and times each candidate read with the longest host event-loop stall around it. `--worker` runs the DB4 paths (`COWORK_DB_WORKER=1`, `COWORK_DB_WORKER_REPORTS=1`, and the FTS worker). The first pass picked what to move: usage insights (12 to 18 s per raw report, and a 14 s rollup backfill that only yielded to microtasks), the memory hybrid search (30 to 190 ms), and post-startup maintenance (0.5 s). Timeline pages and `queryTaskEvents` stay under 3 ms and were left alone.

Same build, host backend against DB4 paths; wall time and the longest host stall:

| Read | Host: wall | Host: stall | DB4: wall | DB4: stall |
| --- | --- | --- | --- | --- |
| Usage insights, raw window, 7 / 30 / 365 days | 15.7 / 17.3 / 17.6 s | 15.8 / 17.3 / 17.7 s | 16.1 / 17.4 / 18.7 s | 8 / 31 / 9 ms |
| Usage insights with rollups, first call | 192 to 338 ms | 192 to 338 ms | 210 to 351 ms | 6 ms |
| Rollup backfill | 68 s (was 14 s blocking) | 0.38 s (was 14 s) | 20.7 s | 11 ms |
| Post-startup maintenance | 470 ms | 71 ms | 482 ms | 6 ms |
| Memory hybrid search p50 / max | 35 / 187 ms | 69 ms | 56 / 467 ms | 6 ms |

- **Parity.** The 30-day report from the reader equals the host computation of the same plan, and memory search returned identical ids on 5 of 5 queries. Tests cover raw and rollup plans for all workspaces and one, worker rollups against host rollups row for row, refreshes applied before a reader report, hybrid ranking with the worker's embedding cache against the host caches, the missing-embedding scans, and maintenance results against the host path (`heavy-reads.test.ts`, `memory-embedding-cache.test.ts`).
- **Responsive under a slow query.** During an 18 s report the host's 5 ms timer ticks never slipped more than 8 ms; on the host backend the same report stalls the event loop for its full length.
- **Cancellation.** A report queued behind a slow one and aborted is dropped unrun (`cancelled`), and the reader keeps serving.
- **No fallback, no empty success.** A closed or failed reader rejects the report; a failed FTS worker rejects the memory search. Neither reruns on the host or returns an empty result. With the DB4 paths on, the only host statement over 50 ms in the whole run was the existing legacy row migration on the first full read of the long session.
- **Memory and WAL.** Peak WAL was 30 MB in both modes. Peak RSS was 4.3 GB on the host backend and 4.5 GB with the workers, most of it the benchmark's own seeding and result sets. The reader and FTS worker each hold a connection; the FTS worker also caches the embeddings it ranks with, bounded by the imported-memory cap of 200,000.
- **Where latency moved.** Reports take as long as before (the scans are the same). Memory search is slower in the worker (56 ms p50, from 35 ms) because it now also runs the lexical stages there and competes with the rollup worker. The host-backend backfill takes longer in total (68 s, from 14 s) because it now runs in 50-row passes with real yields.

Found while measuring: a legacy telemetry chunk took 13 s even at 250 rows, because SQLite sorted through the type index and ran the per-row routing lookups for every matching row before the limit. Chunks now pick their rowids with a forward scan first.

### DB4 follow-up: the open points

| Point | What changed |
| --- | --- |
| Reports as slow as before | The per-row lookups of a usage row's latest routing change and `provider=` log matched `type = X OR legacy_type = X`; with the `LIKE` filter SQLite planned them on the plain `task_id` index and pattern-matched every event payload of the task, per usage row. One branch per column (`src/electron/reports/usage-sql.ts`) keeps each on its typed index. On a copy of the heavy profile with routing and log events added, old and new lookups return identical values for all 43,000 usage rows, in 170 ms instead of 14.9 s. All five sites use it. The legacy backfill also parked an exhausted type's cursor at its start, so every chunk rescanned the table for the type that had no rows left; it now parks past the end. |
| Synchronous memory search callers | The daily briefing (both hosts) and Box Brain prompt fragments now use the async search: the executor and the layer-preview IPC prefetch Box Brain hits and pass them to the synthesizer. The synchronous search remains only as the synthesizer's fallback when a caller does not prefetch. |
| Legacy row migration inside the read | Reads still return converted events at once, but the write-back is deferred (`deferred-event-migrations.ts`): one transaction per task, in the database worker when it runs (`timeline.persistMigratedEvents`), otherwise on the host one task per event-loop turn. Reads before the write convert again, with the same result; `getLatestSeq` and explicit migration write the task's rows first. |
| Register growth | The chunked maintenance and backfill code reuses statements instead of adding them (one legacy-chunk query for both types, a shared maintenance-state writer, `DELETE … RETURNING` for orphans, no `MAX(rowid)` probe). The register is back to 1,823 `prepare` sites, its pre-DB4 total. |

Same build, host backend against DB4 paths, after the follow-up:

| Read | Host: wall | Host: stall | DB4: wall | DB4: stall |
| --- | --- | --- | --- | --- |
| Usage insights, raw window, 7 / 30 / 365 days | 0.15 / 0.50 / 0.88 s (was 15.7 to 17.6 s) | 0.16 / 0.54 / 0.89 s | 0.16 / 0.49 / 0.85 s | 6 ms |
| Rollup backfill | 2.9 s (was 68 s) | 140 ms | 3.0 s | 22 ms |
| Full history of a legacy 15,000-event session, first read | 60 ms (was 302 ms) | 32 ms, plus a 243 ms deferred write | 64 ms | 81 ms |
| Memory hybrid search p50 | 31 ms | 60 ms | 52 ms | 6 ms |
| Post-startup maintenance | 517 ms | 75 ms | 515 ms | 6 ms |

With the DB4 paths on, no host statement took 50 ms or more in the whole run; the 30-day report from the reader equals the host computation at the same instant, and memory search returned identical ids on 5 of 5 queries. Peak WAL was 29 MB on the host backend and 8 MB with the worker.

### DB4 follow-up: paging and embedding backfill

| Point | What changed |
| --- | --- |
| Paging across a migration | An id-carrying timeline cursor now re-resolves its position from its anchor row inside the page statement (`COALESCE(seq, timestamp)` and `timestamp` of that row, falling back to the cursor's own values when the row is gone or belongs to another task). A legacy task's order switching from raw timestamps to `seq` 1..N between two page requests no longer makes the next page match every row. A test pages a 50-event legacy task while its deferred conversion lands after the second page and gets every event exactly once; v2 pages are unchanged. |
| Embedding backfill writes | `runEmbeddingBackfill` and `runImportedEmbeddingBackfill` write one batch per loop iteration: in the database worker (`memory.upsertEmbeddings`, at most 500 rows) when it runs, otherwise in one host transaction. Both paths share `memory-embedding-sql.ts` and skip a row whose memory is gone or was updated past the row's `updatedAt`, and never replace an embedding computed from a newer version. Worker writes bypass the repository's change notification, so the service reports the written ids to the FTS worker's cache itself. Real-worker tests cover a backfill landing and reaching the FTS cache, a stale batch leaving a newer embedding alone, and host and worker writing identical rows. Capture-path writes stay on the host (DB6). |

Neither change adds a register site (the anchor lookup is folded into the page statement; the upsert moved from the repository to the shared helper): 1,823 `prepare` sites. On the heavy benchmark, worker mode again had no host statement at or above 50 ms; the fixture seeds its embeddings, so it does not exercise the backfill itself.

Remaining after DB4:

- **Host backend limits.** Without the worker, a raw report still blocks for its length (under a second on the heavy profile), and a legacy session's deferred write blocks for one transaction (245 ms for 15,000 events).
- **Capture-path embedding writes** stay on the host; they move with memory capture in DB6.

## DB5 results

DB5 is about correctness rather than host time: settings and policy writes are small. What it changed is listed in the plan's DB5 section. The evidence is tests, all against real SQLite:

| Exit criterion | Evidence |
| --- | --- |
| Existing encrypted profiles remain readable | A profile written before revisions existed reads at revision 0 and is revised on its next write; the keychain identity and legacy-format suites pass unchanged. |
| Refused writes remain refused | Under a changed keychain key, `save()` returns false, `update` throws, the row and its revision are unchanged, and a credential revocation throws instead of returning true; Pulse decisions fail with `settings_write_refused`. |
| Concurrent edits do not overwrite decisions | Two connections: an update re-applies on top of a concurrent write; a stale permission edit keeps a rule remembered in between; a credential request is fulfilled once; a worker commit re-applies after a host write in the middle. A writer that keeps losing gives up with `SecureSettingsConflictError`. |
| Revocations apply before subsequent protected actions | A permission edit by another connection applies at the next check without a cache clear; a revocation that lands during a credential resolve is kept and blocks it; a late write of an approval decided before a revocation does not revive the rule. |
| Late Pulse responses cannot reverse consent | The existing lifecycle suite (enrolment, delivery, deletion, cross-process lease and fencing cases) passes on the new commit path; a real-worker test disables Pulse during an in-flight send and nothing is recorded. |
| No transaction spans a host callback | A Pulse test fails if the settings store reads or encrypts, or a package is built, while a transaction is open, across enable, send, reset, disable and deletion. |

The register fell from 1,823 to 1,818 `prepare` sites, because Pulse's and the repository's SQL moved into the shared commit modules.

### DB5 follow-up: the open points

| Point | What changed |
| --- | --- |
| Headless processes replacing keychain rows | A process without the OS keychain (the daemon, the CLI) refuses to replace a row encrypted with it, instead of backing it up and overwriting it; rows it can read are still written. Pulse in such a process reports no consent and refuses decisions and sends. Tests: a daemon-like repository leaves a keychain row and the backup table untouched (plain save and `update` with `replaceUnreadable`); a daemon-like Pulse service changes nothing and sends nothing. |
| Unconditional plain saves | `save()` commits against the revision this process last read or wrote, and merges with a concurrent change field by field (the writer's own changes win; conflicts are logged). Tests: across two connections, a save from an older copy keeps the other writer's field change; where both changed the same field, the later save's value is kept and the other fields merge; unit tests cover nested objects, arrays, deletions and additions. |

What remains is by design: a save of a category the process never read has no baseline and stays unconditional, and arrays merge as one value.

## DB6 results (first slice)

| Item | Evidence |
| --- | --- |
| Simultaneous runtime startup | Four processes open one fresh profile at once; all succeed, the schema version is stamped once, and no lock file is left. Before the fix, the second process failed with `SQLITE_BUSY` while switching the journal mode. |
| Existing-profile upgrade and unsupported versions | A pre-versioning profile is stamped on open. A profile marked with a newer version is refused with a clear error and left untouched, with no lock left behind. |
| Migration lock recovery | A lock held by a dead process, or older than the stale limit, is broken; a live holder makes the next process wait, then time out with a clear error. |
| Worker readiness | A worker refuses to start on a schema version other than the host's. |
| Incomplete shutdowns | A run whose worker did not drain, or whose process died, is reported once by the next start; a clean run leaves nothing behind. Shutdown steps now see whether earlier steps failed. |
| Memory capture | Host and worker captures write identical memory, embedding and observation rows, and the FTS cache hears about the new embedding. |

Workload, `lock-2000ms-8` with worker timeline writes: 246 events/s. The longest host stall is still 1.78 s. The slow operation is `TimelineWriter.commitOnHost` from a read-triggered flush-through, not memory capture. DB3 had attributed the stall to memory capture; that was one cause, and the flush-through is the one that remains.

The register grew by 2 `prepare` sites (1,818 to 1,820), for the run-record bookkeeping; the capture writes moved without adding any.

### DB6 follow-up: the open points

| Point | What changed | Evidence |
| --- | --- | --- |
| Host stall under a foreign lock | Reads merge pending timeline and activity rows instead of committing them on the host. | `lock-2000ms-8`: longest host stall 1.78 s → 0.66 s, 246 → 328 events/s; the one slow operation left is a durable milestone commit (by design). Tests: every converted read returns pending rows without a host write, the latest page includes them and later pages continue from the database, a row committed while still queued appears once, and activity lists and unread counts include pending rows. |
| Schema startup in the worker | `DatabaseManager.open()` initializes in a bootstrap worker. | Tests: the host runs no schema initialization, an unsupported version comes back as its own error type, a missing worker falls back in-thread. Smoke: the compiled CLI build opens a fresh profile through the worker. |
| Unexplained synchronous access | `qa:db:audit` over the register. | All 152 files explained; the audit fails on a new unexplained file. |

The audit by domain (from `npm run qa:db:audit -- --markdown`):

| Domain | Files | `prepare` | `getDatabase` | Plan |
| --- | --- | --- | --- | --- |
| background and domain services | 78 | 621 | 14 | DB6 backlog: one domain at a time |
| storage layer | 10 | 411 | 0 | DB6 backlog: repositories become worker-backed per domain |
| mailbox | 6 | 281 | 0 | DB6 backlog; DB6 backlog: background sync to the worker first |
| memory | 13 | 131 | 16 | DB6 backlog |
| control plane | 5 | 103 | 16 | DB6 backlog |
| reports | 5 | 91 | 0 | DB6 backlog: remaining reports to the reader |
| shared SQL | 7 | 38 | 0 | DB7: host fallback removed when the worker is the only backend; DB7 |
| lifecycle | 2 | 37 | 1 | stays: runs before and after the worker exists; DB7: in-thread path kept for tests only |
| agent runtime | 13 | 34 | 38 | DB6 backlog |
| security | 4 | 30 | 0 | DB6 backlog |
| IPC | 2 | 17 | 8 | DB6 backlog: handlers await worker-backed repositories |
| settings | 1 | 10 | 0 | DB6 backlog: plain saves to async callers |
| telemetry | 1 | 9 | 0 | DB6 backlog: reporting reader |
| runtime wiring | 4 | 6 | 50 | DB6 backlog: services receive worker-backed repositories; stays: one read-only query per CLI invocation |
| renderer | 1 | 1 | 0 | stays |

Still open, and the reason DB6 is not complete: the domain moves themselves (about 1,800 sites) and removing host SQLite constructors and raw handles.

### DB6 domain: mailbox

The first domain moved. `MailboxService`, its search, forwarding and automation services, and the AgentMail admin and realtime services run every statement by name through one mailbox statement port. The port uses the database worker when `COWORK_DB_WORKER=1` and `COWORK_DB_WORKER_MAILBOX=1`, and the host connection otherwise. None of these services holds a raw database handle now; a connection is used only to create their tables at construction.

| Item | Evidence |
| --- | --- |
| Register | Mailbox 6 files and 281 `prepare` sites → 0; it is gone from the audit, and its audit rules were removed so new synchronous access fails. The register holds 1,540 sites in 147 files. The shared statement executor adds 1 site, under shared SQL. |
| Catalog | 238 statements, plus 8 builders whose shape (filters, sort, visibility options) is validated before SQL is built. The worker runs only catalogued names; the caller never sends SQL. Dynamic `IN (...)` lists became `json_each(?)` parameters. |
| Backend parity | One workload through the host and through a real worker: sync upserts, a re-sync of the same thread, inbox and unread lists, sync status, and forwarding-automation create, update, list and delete. It returns identical results and leaves identical thread, message, search and audit rows; more than 20 statements ran in the worker. |
| Async callers | Every sync caller of a method that became async now awaits it, or explicitly voids it with a logged failure (the trigger-fire record, realtime socket events). AgentMail realtime runs one connection attempt at a time and does not open a socket after `stop()`; forwarding timers are set only by the latest arming. A type-aware scan found no floating calls. The mailbox files joined the promise lint. |
| Suites | Mailbox, AgentMail and mailbox-tool tests (87) plus the full suite: 9,081 passed. The one failure is the cron start/stop test that was already failing. The worker smoke passes in all four runtimes with mailbox routed. |

The mailbox workload is new: `npm run qa:db:mailbox`. It syncs 1,500 threads × 3 messages, 2 KB bodies, in pages of 25, while a UI-style poll lists the inbox and reads the sync status:

Before the search-index fix below:

| Backend | Sync | Loop p99 | Loop max | Poll p50 | Poll max |
| --- | --- | --- | --- | --- | --- |
| host | 8.3 s | 487 ms | 492 ms | 3.4 ms | 65 ms |
| worker | 10.2 s | 11 ms | 12 ms | 26 ms | 100 ms |

On the host, each 25-thread page blocked the event loop for about half a second, and polls starved (40 in 8.3 s against 74). In the worker the loop stayed under 12 ms, but sync was 23% slower because each statement is a round trip, and polls queued behind sync writes on the single write connection.

The workload also exposed three costs that were there before the migration. All three are fixed:

- **Cipher key:** the app-level mailbox cipher (used when `safeStorage` is unavailable, as in the daemon and CLI) derived a 100k-round PBKDF2 key for every field. It is now derived once per process (40 threads: 2.6 s → 0.12 s).
- **Identity reconciliation:** each message was reconciled by scanning `mailbox_messages`. A `provider_message_id` index removes the scan (11.1 s of 24.5 s at 4,500 messages). It is additive, and older builds ignore it.
- **Search index:** each re-index deleted the old FTS row by `record_type`/`record_id`. Those are `UNINDEXED` FTS5 columns, so every delete scanned the index (6.1 s of 8 s at 4,500 messages, growing with the mailbox).
  - The rows now live in `mailbox_search_records`, keyed by `(record_type, record_id)`. An external-content FTS5 index, `mailbox_search_records_fts`, sits on top, and triggers keep it in sync.
  - Writes are keyed upserts. `INSERT OR REPLACE` is avoided because its implicit delete does not fire triggers.
  - Existence checks and attachment lookups go through the table's indexes.
  - Both tables are new names, so no schema-version bump is needed. An older build creates and writes its own `mailbox_search_fts`. The next start imports those rows, with later rows winning for a key, drops rows whose message or attachment is gone, and drops the legacy table.
  - The one-time import takes 0.73 s for 50,000 rows, in the bootstrap worker. Keyed deletes take 0.07 ms at that size.
  - Without FTS5, the records table is still written, and the index is rebuilt from it once FTS5 is available.
  - Tests: trigger sync through insert, upsert and delete (FTS `integrity-check` passes); an indexed key lookup in the query plan; legacy import, deduplication and orphan removal, twice (idempotent); rebuild after a missing index; and a downgrade round trip through `DatabaseManager`.

After the fixes:

| Backend | Threads | Sync | Threads/s | Loop p99 | Loop max | Poll p50 | Poll max |
| --- | --- | --- | --- | --- | --- | --- | --- |
| host | 1,500 | 1.8 s | 850 | 32 ms | 34 ms | 1.9 ms | 72 ms |
| worker | 1,500 | 2.7 s | 560 | 11 ms | 11 ms | 7.1 ms | 25 ms |
| host | 6,000 | 7.4 s | 810 | 50 ms | 59 ms | 8.7 ms | 74 ms |
| worker | 6,000 | 11.9 s | 505 | 11 ms | 12 ms | 13.9 ms | 31 ms |

Throughput now holds as the mailbox grows. In the worker the host loop stays near 11 ms and polls stay under 31 ms. The worker's remaining cost is round trips: SQL is now cheap, so at about 20 statements per thread they dominate sync time.

Next for mailbox: batch a thread's upsert into one worker command to cut the round trips, and route its reads to a read connection so polls never queue behind sync writes.

### DB6 domain: memory

The second domain moved: memory tiers, observations, durable context, transcripts, the markdown index, Playbook evidence, dreaming, the Box brain and the knowledge graph. Memory needed one more primitive. Its transactions read, decide and write, which a list of named statements cannot express, so domains can now register **transaction units**: named, pure `(db, args)` functions, each with an argument validator. The port runs a unit in one IMMEDIATE transaction, in the worker or on the host. A unit marked read-only runs as a read, in a deferred transaction (one snapshot). The worker runs only registered units. For store classes, one unit per method keeps the method's logic unchanged, and the service becomes an async facade (`store-units.ts`).

| Item | Evidence |
| --- | --- |
| Register | Memory: 131 `prepare` sites (plus 27 in the knowledge graph) → 0. The SQL now lives in shared-SQL stores run by units (166 sites under shared SQL, worker-backed when `COWORK_DB_WORKER_MEMORY=1`). The 9 remaining `getDatabase` calls only build the port or storage-layer repositories; the transcript checkpoint lock file stays by design. The register holds 1,536 sites in 148 files. |
| Atomic operations | The multi-step writes are now single units, so concurrent callers can no longer interleave between a check and its write: the knowledge graph's entity upsert and merge, its deduplicated edge creation with the overlap check, observations on existing entities, edge invalidation; Playbook listing with source verification (which invalidates rows) and the reinforcement links; the tier promotion pass; dreaming candidate batches; a durable-history record, and a compaction summary with its links. Several of these used to be separate writes with no transaction. |
| Fewer round trips | Task-context building fetches entities with their neighbors in one read unit; prompt-recall filters check suppression for all candidates in one query instead of one per memory. |
| Host-only work | Anything that needs the settings manager, the token estimator or the file system stays on the host and passes its results in: message preparation for durable context, file discovery and reads for the markdown index, read guards, final ranking. |
| Best-effort writes | Durable history and compaction records are fire-and-forget with ignored failures, as before, so conversation rebuilds and message queueing did not become async. On the host backend the write still happens during the call. |
| Backend parity | One workload through every converted store on the host and in a real worker returns identical results once random ids and wall-clock times are masked; more than 25 unit calls ran in the worker. |
| Suites | Memory and knowledge-graph suites, plus the executor, runtime and tool tests that touch them; full suite 9,089 passed. The one failure is the cron start/stop test that was already failing. The worker smoke passes in all four runtimes with mailbox and memory routed. The memory, knowledge-graph and affected caller files joined the promise lint (two violations that predate this work were fixed). |

The memory workload is new: `npm run qa:db:memory`. It indexes 400 markdown files × 8 KB (14,400 chunks), with 300 graph entities and 500 memories, while a recall poll searches the markdown index, the knowledge graph and observations:

| Backend | Index | Loop max | Poll p50 | Poll max |
| --- | --- | --- | --- | --- |
| host, one transaction (as before) | 1.2 s | 1.1 s | 1.5 ms | 2.7 ms (2 polls) |
| host, batched | 2.7 s | 180 ms | 58 ms | 146 ms |
| worker, batched | 2.8 s | 13 ms | 3.4 ms | 229 ms |

A sync now commits eight files per transaction and yields between batches (a file's rows are always in one batch). The first run showed a single 1.2 s transaction holding recall reads in the worker. Indexing takes longer because recall runs between batches and each batch invalidates the vector cache; in exchange, the host never stalls for more than 180 ms, or 13 ms with the worker.

The workload also showed that `monitorEventLoopDelay` misses a final block if the monitor is disabled right after it. Both workload scripts now let it sample first. The mailbox numbers were unaffected.

**Correction to the mailbox migration, and its fix.** Mailbox moved statement by statement, before units existed. Its multi-step sequences used to run without a break: 25 formerly synchronous methods and 50 stretches inside async methods write several rows with no `await` in between. On the worker backend each statement became a round trip, so another operation could run between a read and its write.

- **Where the gap was.** On the host backend nothing changed: a statement runs during the call, so an operation's statements still ran back to back unless it awaited real I/O. The gap was on the worker backend only.
- **The fix.** Many of those stretches interleave host-only work (message encryption), so they cannot become units. Instead, mailbox ports serialize bursts (`statement-burst.ts`). An operation's statements form one uninterrupted burst for as long as it keeps issuing them without waiting on anything else. Other operations' statements wait until the burst ends: a turn of the event loop passes after the owner's last statement without the owner issuing another. That is exactly what the synchronous code guaranteed, and other operations can still run while one waits on real I/O, as before.
- **How operations are told apart.** Each operation has an `AsyncLocalStorage` context, opened per public call of the mailbox and AgentMail services; nested calls share it. Scheduled work (autosync and outbox ticks, background runs, forwarding timers, realtime socket events) opens a context of its own.
- **Evidence.**
  - **Race test:** two concurrent `updateMailboxDraft` patches to one draft, through a real worker, keep both fields. With the gate off, the test fails: one patch is lost.
  - **Gate tests:** bursts stay uninterrupted; operations interleave at real I/O; concurrent statements of one operation are admitted together; a failure releases the gate; statements outside an operation don't deadlock; bound and detached contexts behave as described.
  - **Workload (worker):** sync goes from 570 to 535 threads/s; host loop max stays at 11 ms; poll max is 30 ms, because each thread upsert is its own operation.
  - **Suites:** the full suite passes (9,097 tests) apart from the cron test that was already failing, and the worker smoke passes.
- **Still to do for mailbox:** batch a thread's upsert into one round trip.

### DB6 domain: control plane

The third domain moved. It covers companies, goals, projects, workspace links, issues, comments, heartbeat runs and cost summaries (`ControlPlaneCoreService`), the strategic planner, and the control-plane API handlers of the desktop and the daemon.

- **Units.** The existing synchronous class became `ControlPlaneStore`. Its pure methods are units, and the service is an async facade over them (flag `COWORK_DB_WORKER_CONTROL_PLANE`).
- **The run state machine.** It now has one unit per step: checkout (refuse an active run, insert the run, claim the issue), a task's run and issue rows, release, and syncing a run to its task's lifecycle. Lifecycle syncs for queued and executing tasks used to be separate writes.
- **Task rows.** They stay with the storage layer's `TaskRepository` on the host, so its read-cache invalidation and usage-projector hooks keep running there.
- **Host-only operations.** Company creation and updates provision workspace folders and rows, and template import, export and budget enforcement need the storage layer's repositories. These run on the host through the same store, as before.
- **Planner and API handlers.** They run catalogued statements through the burst-gated port, because their sequences interleave storage-layer checks. The desktop and daemon handlers share 14 statements. A dynamic channel update became one fixed statement that keeps unset fields.
- **Report units.** A read-only unit can be marked as a report. It then runs on the reporting reader when that is running (`COWORK_DB_WORKER_REPORTS`), so a long scan never queues ahead of the domain's other statements. Cost summaries are report units.

| Item | Evidence |
| --- | --- |
| Register | Control plane: 103 `prepare` sites → 0. The store's SQL is shared SQL; the 16 remaining `getDatabase` calls build storage-layer repositories. The register holds 1504 sites, 1267 of them outside shared SQL. |
| Atomicity | Five concurrent checkouts of one issue through a real worker: exactly one succeeds, and one run exists. |
| Backend parity | One workload (projects, issues, comments, checkout, a second checkout, task attachment, lifecycle syncs, cost summary, planner configs) returns identical results on the host and in a worker. |
| Cache hooks | The task-row read-scope audit now follows catalogued task writes to the members that run them, and fails if one does not invalidate. A mutation check confirmed it. |
| Suites | Control-plane, daemon, IPC and mailbox suites; full suite 9,100 passed; the one failure is the cron test that was already failing. The worker smoke passes with mailbox, memory and control plane routed. |

The control-plane workload is new: `npm run qa:db:control-plane`. It runs 60 checkout, attach and complete cycles, with a cost summary every 10 cycles over 2,000 tasks × 100 usage events, while a mission-control poll lists issues and runs:

| Backend | Run | Loop max | Poll p50 | Poll max | Polls |
| --- | --- | --- | --- | --- | --- |
| host | 0.89 s | 130 ms | 0.3 ms | 1.8 ms | 8 |
| worker, summaries on the writer | 0.97 s | 12.6 ms | 101 ms | 108 ms | 8 |
| worker, summaries on the reader | 0.92 s | 12.5 ms | 0.6 ms | 13.8 ms | 19 |

### DB6 domain: reports

The fourth domain moved: the reports that DB4 left on the host.

- **Stores and units.** Standup reports, agent performance reviews and the daily briefing's task counts became synchronous stores run by a `reports` domain's units (routed with `COWORK_DB_WORKER_REPORTS`, the same flag as DB4's reader).
- **Reads.** All reads are report units, which run on the reporting reader.
- **Writes.** Generating a standup (finding the day's report, reading the tasks, saving it) and generating an agent review (reading the period, inserting the review) are single write units, so a second call for the same day no longer races the first.
- **The first-activity lookup.** The usage page's earliest-activity query is now a report unit too.
- **Usage insights.** Reports and rollups already ran in the reader and the worker through DB4's usage commands. Their two files are now classified as shared SQL, with the host-only single-row projector state reads named.
- **Standup list limit.** The list's interpolated `LIMIT` is now coerced to a positive integer inside the store.

| Item | Evidence |
| --- | --- |
| Register | The reports domain is gone from the audit: 91 `prepare` sites moved to shared SQL (stores and usage insights). The register holds 1,504 sites in 147 files, 1,176 of them outside shared SQL. |
| Backend parity | One workload (standup generation twice for one day, latest, list, cleanup, reviews, earliest activity) returns identical results on the host and with a worker and reader; the reads ran on the reader and the writes on the worker. |
| Heavy reads | `qa:db:reads` (500 tasks × 50 events, a 5,000-event session, 10,000 usage rows, 5,000 memories) matches DB4: with the worker, the host loop stays at 5.7 to 9.6 ms during every report, against 25 to 105 ms on the host for raw 7- to 365-day windows. |
| Suites | Full suite 9,101 passed; the one failure is the cron test that was already failing. The worker smoke passes with mailbox, memory, control plane and reports routed. |

### DB6 storage layer, slice A: leaf repositories

The storage layer goes in slices, ordered by how far a repository's callers reach:
- **Slice A (done):** 25 leaf repositories. They cover approvals, artifacts, annotations, input requests, workspace permission rules, skills, LLM models, channel specializations and messages, the message queue, scheduled messages, delivery tracking, rate limits, the audit log, curated memory, memory summaries, settings and pending writes, worktrees, comparisons, composer drafts, task labels, device profiles, task session metadata and bot notification preferences.
- **Slice B (done):** channels, channel users and sessions, memories and embeddings. The work-session repositories stay stores (below).
- **Slice C1 (done):** tasks and workspaces outside the daemon hot path.
- **Slice C2 (done):** asynchronous milestone commits. The measurements below replaced the planned daemon conversion.

How slice A moved:
- **Stores and facades.** Each class was renamed `XStore`; a generator made one storage-domain unit per public method (a method is a write if it, or a method it calls, writes or opens a transaction) and an async `XRepository` facade with the old name and constructor (`COWORK_DB_WORKER_STORAGE`). Worker-side code (the session services, other stores) keeps the stores; everything else uses the facades. `TaskTraceRepository` stays until slice C because it wraps the task repositories.
- **Kept synchronous.** Clearing a task's pending approvals is still synchronous, so approvals are denied before a task's terminal update, as before. The approval row write is issued there without waiting: it completes during the call on the host backend. In worker mode it is queued in order, but a host-side task update can land first until tasks move in slice C.
- **Callbacks.** `failTask`, `cancelTaskRecord` and startup-resume skipping stayed synchronous. The async facades were rippled through their callers with a compiler-driven tool; callbacks were fixed by hand:
  - IPC handlers that tested a returned value became async;
  - the CLI's security audit and rule listing collect every workspace's rules with `Promise.all`;
  - the MCP host server awaits its resource list;
  - event listeners stay synchronous and fire the async work.
- **Permission path.** Evaluating a tool permission now awaits the workspace's permission rules; every caller awaits it, and no promise reaches a condition (type-checked, the promise lint, and a floating-call scan).

| Item | Evidence |
| --- | --- |
| Backend parity | Approvals (create, pending list, approve), artifacts, annotations, permission rules, input requests, task labels and memory settings through the facades return identical results on the host and in a worker; all 17 calls ran in the worker. |
| Agent workload | `qa:db:workload` with 1 and 8 active tasks, host against every domain routed to the worker (with timeline writes): 8 tasks reach 436 events/s against 255, and the host loop max is 58 ms against 121 ms. |
| Suites | Full suite 9,102 passed; the one failure is the cron test that was already failing. Daemon approval, input-request and completion tests wait for the storage read that now precedes an approval row. The worker smoke passes with all five domains routed. |

The register count does not move with this slice: the stores' SQL stays in `repositories.ts`, where the worker-side session services also use it.

### DB6 storage layer, slice B: channels, memories, work sessions

Slice B moved the same way as slice A (stores, generated units and facades, the compiler-driven ripple), with these differences:
- **Sealed channel config.** Channel config is encrypted with OS secure storage, which the worker cannot reach. `ChannelStore` takes a config codec: the default encrypts with secure storage, and the units use a sealed codec that stores and returns the ciphertext as is. The host `ChannelRepository` facade seals config before a write and decrypts after a read, so plaintext credentials never cross into the worker. The parity test runs the worker without secure storage.
- **Check-then-write as units.** Three sequences that were atomic while synchronous became store methods, each one unit:
  - `findOrCreateByChat` for a chat's session;
  - `findOrCreateByChannelUser` for a sender's user record;
  - `createIfTypeAbsent` for adding a channel of a type that must be unique.
  Session context merges already happen inside `update`'s unit. Generating a pairing code now takes the per-channel lock that verification already used.
- **Kept synchronous on the stores.** Some host reads stay on the host connection through the store:
  - the tool catalog's email-channel availability check and the mailbox availability check, which feed the synchronous, cached `getTools`;
  - tool descriptions;
  - managed-agent Slack target sync, an encrypted-config read-modify-write that stays atomic.
- **Callbacks.**
  - Transcript formatting prefetches the users a transcript names, so `lookupUser` stays synchronous.
  - The delivery service and the X mention bridge accept promise-returning dependencies.
  - Adapter status listeners stay synchronous and record status without waiting.
  - The tray menu refresh is async; a superseded refresh drops its result.
- **Memory search.** Hybrid ranking is split into a plan and a rank phase: the FTS worker keeps the synchronous wrapper, and `MemoryService` loads the candidate rows between the two phases. Embedding cache loads are shared while in flight and merge into entries cached meanwhile. A load that an invalidation overtakes drops its rows and does not mark the cache loaded.
- **Work sessions stay stores.** The session services use the work-session repositories synchronously on the host (the daemon's event pipeline) and in the worker (timeline projection), so the repositories stay synchronous stores. The control-plane replay handler reads through `WorkSessionProtocolReader` units. `EvalService` also runs its own host SQL, so it moves with the background services.

| Item | Evidence |
| --- | --- |
| Backend parity | Covers channels (create, duplicate refused, config update, list, delete), channel users and chat sessions. These return identical results on the host and in a worker, and the stored config stays encrypted. Three concurrent first contacts create one user and five concurrent messages create one session. Clearing a session's task survives the worker boundary. |
| Agent workload | `qa:db:workload` with 1 and 8 active tasks, host against every domain routed to the worker (with timeline writes): 8 tasks reach 423 events/s against 212, and the host loop max is 50 ms against 165 ms. |
| Memory workload | `qa:db:memory`: parity holds; the worker run's loop max is 12 ms against 188 ms. |
| Suites | Full suite 9,102 passed; the one failure is the cron test that was already failing. The worker smoke passes with all five domains routed. |

As with slice A, the register count does not move: the stores' SQL stays in `repositories.ts`.

### DB6 storage layer, slice C1: tasks and workspaces

Slice C is split so the executor stays untouched. C1 moved `TaskRepository` and `WorkspaceRepository` to stores, units and facades, like the earlier slices. Its callers are IPC, the gateway, the control plane, the daemon's control-plane methods, the CLI, and the managed, improvement, memory, mailbox and workspace services. C2 moves the daemon hot path with task events.

- **Kept on the stores.** These keep the synchronous stores until their own domain moves:
  - the daemon itself (`daemon.ts`, C2);
  - runtime wiring in `main.ts`, whose service callbacks are synchronous;
  - the subconscious loop's workspace-path resolver;
  - host transactions that create a task together with other rows;
  - the timeline transports that pair tasks with the host task-event repository;
  - `TaskTraceRepository`;
  - the session services, which share code with the worker.
- **Host state.** Deleting a task first commits the host timeline writer's pending rows for it. The facade does that on the host before the unit runs, because the worker has no writer registered. The per-event task-row cache is synchronous-only and stays with the daemon.
- **Authorization audit.** Several guards became async:
  - `SessionMembershipService.authorizeTaskAction`;
  - the capability middleware;
  - the IPC `authorizeTaskForEvent` and `requireRealWorkTask`;
  - the mailbox attachment path check.

  A guard that is called without awaiting it resolves instead of throwing, so it would fail open. Three such sites were found and fixed: two filters (`filterTasks` and the local-preview list) that ran the check inside a synchronous `try`, and the draft-attachment reader. An AST pass over the electron, daemon and CLI programs confirms that every call to these guards is awaited, returned from an async function, or chained. The typed promise lint (`no-floating-promises`, `no-misused-promises`) passes on every changed file except five, whose remaining violations predate this slice.
- **Callbacks.** Briefing, ACP and delivery dependencies accept promises. List enrichment (approvals, input requests, campaigns, mission control, exports) awaits `Promise.all`, and a few event listeners stay synchronous and run their async work in the background. Test doubles of the connection may return a plain function from `transaction`, and the unit runner then calls it directly.
- **QA scripts.** The QA scripts that load `dist` repositories now use the store classes: `sqlite-workload`, `sqlite-reads`, `control-plane-workload`, `approval-boundary-smoke` and `profile_electron_task_switch`. `sqlite-reads` had been broken since slice B and the approval smoke since slice A.

| Item | Evidence |
| --- | --- |
| Backend parity | Workspace create, last-used update, lookup by path and list, plus task create, update, pin, board move, per-workspace list, board and delete through the facades, return identical results on the host and in a worker. |
| Agent workload | `qa:db:workload` with 1 and 8 active tasks, host against every domain routed to the worker (with timeline writes): 8 tasks reach 432 events/s against 225, and the host loop max is 75 ms against 114 ms. The daemon path this workload drives is unchanged until C2. |
| Control-plane workload | `qa:db:control-plane`: the worker run's loop max is 12 ms against 31 ms. |
| Suites | Full suite 9,102 passed; the one failure is the cron test that was already failing. The worker smoke passes with all five domains routed, and so does the approval-boundary smoke with approval prompts on (see slice C2). |

### DB6 storage layer, slice C2: asynchronous milestone commits

C2 was planned as moving the daemon's task, event and workspace calls (about 225 sites, rippling into the executor). Measuring first changed the scope. With every domain routed, SQLite is 3–7% of host time at 8, 20 and 40 tasks. The daemon's task SQL is task-row reads, about one per event, which don't wait on another process's write lock under WAL. At 40 tasks the loop delay isn't database-bound.

The one stall left was the lock scenario. Instrumenting the built writer showed every host commit there came from milestone events: lifecycle, approval, input, user message, follow-up and snapshot. Each committed its task's queued rows on the host inside `logEvent` and waited out the lock (772 rows in 9 commits).

- **Milestones go to the worker.** `TimelineWriter.enqueueTaskEvent` no longer commits milestones on the host, so the daemon's durable-type list is gone. Rows still commit on the host when the worker is not ready or the backlog passes the high-water mark.
- **Waiting for durability.** `committed(taskId)` resolves once the rows accepted before the call are committed; later rows for the same task don't hold it up. On timeout it keeps waiting while the worker is ready, because committing on the host would block this thread on the same lock, and commits on the host only when the worker is no longer ready. `completeTask` awaits it before resolving.
- **Where the authority is.** Task status is in the task row, which the daemon writes synchronously. Approvals and input requests are in their own rows, written through awaited facades before the user is prompted. So approval and input admission don't wait for their timeline events, and waiting there would delay registering the pending request.
- **Trade-off.** A crash can lose an accepted milestone row that neither side committed yet (at most one batch). Before this change that applied only to non-milestone rows.
- **Approval-boundary smoke.** The smoke expected the approval row to exist synchronously after `authorizeToolAction` returned. That has not held since the permission path awaits storage reads (slice A), and the script's exit status had been hidden by a pipe in the C1 check. It now waits for the pending rows. Its exception scenarios also need `COWORK_APPROVAL_PROMPTS=on`: with the default policy (prompts off outside tests), exceptions go to structured input rather than approval rows. That is independent of this migration.

| Item | Evidence |
| --- | --- |
| Host stall under a foreign lock | `lock-2000ms-8`, all domains routed: host loop max 627 → 51 ms, SQLite share 26% → 2%, 339 → 391 events/s. Projection lag during the lock is 3.2 s, because rows commit when the lock is released. |
| Active tasks | 8, 20 and 40 tasks: 435, 584 and 642 events/s; loop max 41, 124 and 284 ms. |
| Tests | A daemon test shows a milestone is not committed on the host and that `timelineRowsCommitted` resolves after the worker commits. With a ready but blocked worker, the host waits past the timeout without committing, and takes the rows once the worker is no longer ready. A writer test shows a commit wait resolves for the rows accepted before it while later rows keep arriving. Full suite 9,104 passed; the one failure is the cron test that was already failing. |

### DB6 services domain, area 1: agents

The background and domain services backlog (78 files, 621 register sites) moves one area at a time into a single new domain, `services` (`COWORK_DB_WORKER_SERVICES`). Each area adds a unit module, and `service-units.ts` merges them. The port and the facade factory live in `service-statements.ts`, kept apart from the units so the catalog registry loads without an import cycle.

- **Agents (12 repositories).** Covers roles, automation profiles, heartbeat policies and runs, teams, members, runs, items, thoughts, mentions, task subscriptions and working state. Each became an `XStore` with 113 generated units and an async `XRepository` facade in `agent-repository-facades.ts`. Three `AgentRole` heartbeat methods delegate to the automation-profile store, so they are marked as writes by hand. With no connection, `HeartbeatRunRepository` falls back to its in-memory store, as before.
- **Kept on the stores.** The daemon hot path and the `bot-team` helpers it calls during task creation keep the stores; team-thought emission on the timeline path writes through the store as well. Worker-side SQL (`control-plane-sql`) keeps them too.
- **Callbacks.**
  - The team orchestrator's synthesis watchdog runs its async work from a synchronous timer.
  - Heartbeat wake callbacks fire in the background, and the manual-override replay has a catch.
  - Research routing resolves the known roles before its synchronous check.
  - ACP role listing accepts promises; mention and signal formatting await their role lookups.
- **Unawaited returns in `try`.** An async `return repo.call()` inside `try` skips its `catch`. A scan (`@typescript-eslint/return-await`, correctness cases only) found 19 such returns across `src/electron`. 15 came from this migration, where a synchronous repository call became async:
  - the managed mirror-role race recovery;
  - `MemoryWriteGate`;
  - 13 memory IPC handlers.

  All 15 are fixed. The four that predate the migration are unchanged. The rule is now part of the async-SQLite lint pass.
- **Test change.** The managed mirror-role race test had injected its conflicting row inside the failing `create`. Role writes are transactional units now, so that row rolled back with the failure. The test now commits the other writer's row through the store before the insert fails, which is how the race happens in practice.

| Item | Evidence |
| --- | --- |
| Backend parity | Roles (create, update, heartbeat config), automation profiles, teams, members, mentions (create, acknowledge, pending count) and task subscriptions through the facades return identical results on the host and in a worker. |
| Agent workload | All six domains routed: 8 tasks reach 457 events/s with a 41 ms loop max. Under a 2 s foreign lock: 387 events/s, 28 ms loop max. |
| Register | Background and domain services 78 → 66 files and 621 → 500 sites; the agent stores are shared SQL now. |
| Suites | Full suite 9,105 passed; the one failure is the cron test that was already failing. The worker smoke passes with all six domains routed. |

### DB6 services domain, area 2: routines; slice A's approval ordering gap

- **Approval ordering (slice A gap, closed).** Slice A recorded that in worker mode a task's terminal update could land before its pending approvals were denied. Tasks stayed on the daemon's store in C2, so the gap was still open. The daemon now writes denials at task end through `ApprovalStore` on the host, so they commit before the terminal update, as before the migration. The completion test asserts that order.
- **Routine stores.** `RoutineWorkflowRepository` became `RoutineWorkflowStore`, and the service's inline SQL moved to `RoutineStore` (`routine-sql.ts`). `RoutineService` maps the raw rows; 21 of its 22 `prepare` sites moved out, and schema setup stays.
- **Clocked units.** The workflow store reads an injected clock, and tests inject theirs. `clockedStoreUnit` passes the caller's clock reading as the first argument, and the unit builds the store with it. The store skips its schema setup in units; the facade ensures the schema once on the host.
- **One unit per check-then-write.** A run upsert matches an existing run by dedupe key, run key or id and writes it, in one unit. The dedupe key is computed on the host first, because it needs the routine's mapped definition. Deleting a routine removes its runs and workflow data in the same unit.
- **Reconciliation stays at schema setup.** The one-time dedupe-key reconciliation runs during schema setup on the host, before the unique index. It now builds a plan (deletions, clears, sets) and applies it in one transaction. Duplicates are deleted first, so setting a key can never hit the unique index mid-way.
- **No callbacks into units.** Workflow retention pruning took a per-version callback. The store now resolves each version's retention itself. Store-unit argument validation rejects functions: JSON would have dropped them silently.
- **Callbacks.** Trigger-fire and API-dispatch observers stay synchronous and record their routine run in the background. The engine's nullable-run assertions await before asserting, and returns inside `try` await their store calls.

| Item | Evidence |
| --- | --- |
| Backend parity | These return identical results on the host and in a worker: routine rows; run upserts (two upserts of one run give one row); workflow versions, runs, the event inbox (enqueue, claim) and retention pruning; deleting a routine with its runs and workflow data. |
| Register | Background and domain services 66 → 65 files, 500 → 456 sites. |
| Suites | Full suite 9,106 passed; the one failure is the cron test that was already failing. The worker smoke passes with all six domains routed. |

### DB6 services domain, area 3: core learning

- **Stores.** The 10 core learning repositories became stores with 54 generated units and async facades (`core-repository-facades.ts`): traces and events, failure records and clusters, eval cases, harness experiments and runs, regression gates, memory candidates, distill runs, scope state and learnings. They have plain constructors, no in-memory state and no callback parameters, so the leaf-repository pattern applies unchanged.
- **Non-null assertions.** After the ripple, `await repo.update(…)!` asserted non-null on the promise, not on its result. It is rewritten to `(await repo.update(…))!`, and a `return repo.update(…)!` inside `try` now awaits. Failure mining creates its records with `Promise.all`.
- **Callers.** The subconscious loop and the heartbeat service await their trace recording in order. Mission control and main's wiring read through the facades.

| Item | Evidence |
| --- | --- |
| Backend parity | Traces (create, append event, update), failure records, clusters (create, add member, lookup by fingerprint), learnings and scope state return identical results on the host and in a worker. |
| Register | Background and domain services 65 → 55 files, 456 → 388 sites. |
| Suites | Full suite 9,107 passed; the one failure is the cron test that was already failing. The worker smoke passes with all six domains routed. |

### DB6 services domain, area 4: subconscious

- **Stores.** The seven subconscious repositories became stores with 25 generated units behind async facades: targets, runs, hypotheses, critiques, decisions, backlog and dispatch records.
- **The loop's own SQL.** `SubconsciousLoopService` kept 12 inline statements; they moved to `SubconsciousStore` (`subconscious-sql.ts`):
  - the eight cross-domain evidence reads (tasks, memory files, mailbox events, automation profiles, heartbeat runs, triggers, briefing config, improvement runs), as one reporting unit that returns every source's rows;
  - the target rekey, which moves a target's records, deletes the old key and merges the summary in one unit. It had been a host transaction mixing repository calls.
  - the stale-target and history clears, and the legacy vocabulary cleanup.
- **Nested transactions.** The stale-target clear opened its own `BEGIN`/`COMMIT`, which fails inside a unit's transaction. It now uses `db.transaction`, a savepoint when nested.
- **Order preserved.** Backlog items from a decision are created one at a time, in order, because each create dedupes against the open items before it.
- **Kept on the stores.** The one-time legacy migration runs synchronously at service construction, so it uses the host stores.

| Item | Evidence |
| --- | --- |
| Backend parity | Two refreshes of a real `SubconsciousLoopService` return the same target keys, kinds and evidence counts on the host and in a worker. They cover the evidence reporting unit, the target upserts and the stale-target clear. |
| Register | Background and domain services 55 → 54 files, 388 → 355 sites. |
| Suites | Full suite 9,108 passed. Failing: the cron test that was already failing, and once a 1 ms timing race in the permission-settings test (`migratedAt` differs across a millisecond tick), which passes on reruns and does not touch the database. The worker smoke passes with all six domains routed. |

### DB6 services domain, area 5: managed agents

- **Stores.** The five managed repositories became stores with 21 generated units behind async facades: agents, versions, environments, sessions and session events.
- **The service's own SQL.** `ManagedSessionService` had 15 inline statements. They moved to `ManagedStore` (`managed-sql.ts`) as single units:
  - **Workspace role:** first-member seeding and the role read share one unit.
  - **Membership upsert:** the lookup that keeps the membership's id and creation time and the write are one unit.
  - **Audit:** reading and writing the audit trail.
  - **Routines:** the routine rows for managed agents, and routine enablement, a read-modify-write, as one unit.
  - **Routine runs:** the joined routine-run read.

  Governance schema setup stays on the host at construction.
- **Authorization.** `assertWorkspacePermission` and `getMyWorkspacePermissions` throw or deny on a missing role and now read the role through a unit, so they became async. An AST audit over the electron, daemon and CLI programs confirms every call to them, and to the role read and the audit write, is awaited, returned or chained. The service test confirms an arbitrary principal still gets no membership and the snapshot resolves to the local owner.
- **Audit durability.** The audit write is awaited, so callers do not report an action before its row exists. One IPC handler called it through an `as Any` cast; that call now awaits too.
- **Callers.** Routine drafts await their definitions before `Promise.all` creates them; types derived with `ReturnType<…>` use `Awaited`.

| Item | Evidence |
| --- | --- |
| Backend parity | Role seeding (owner becomes admin, outsiders get no role), membership upserts that keep the id, audit rows and routine rows return identical results on the host and in a worker; all 9 units ran in the worker. |
| Register | Background and domain services 54 → 53 files, 355 → 319 sites. |
| Suites | Full suite 9,110 passed; the one failure is the cron test that was already failing. The worker smoke passes with all six domains routed. |

### DB6 services domain, area 6: contact identity

- **Store.** `ContactIdentityService` held its SQL inline and depended only on its connection, so the class became `ContactIdentityStore`: 14 units behind an async `ContactIdentityService` facade with the old name (`identity-repository-facades.ts`). Its only caller is the mailbox service.
- **Host-only lookup.** Resolving a mailbox contact searched the host's knowledge graph for a matching person partway through. That search now runs on the host first (`findMailboxContactPersonEntityId`), through a facade hook. The resolution then runs as one unit, so the identity, handle and candidate writes, previously a long check-then-write sequence, share one transaction.

| Item | Evidence |
| --- | --- |
| Backend parity | Resolving the same contact twice (case-insensitive email) reuses one identity. A manual handle link, identity listing and coverage stats return identical results on the host and in a worker; all 6 calls ran in the worker. |
| Register | Background and domain services 53 → 52 files, 319 → 267 sites. |
| Suites | Full suite 9,110 passed; the one failure is the cron test that was already failing. The worker smoke passes with all six domains routed. |

### DB6 services domain, area 7: work contexts and session membership

- **Stores.** `WorkContextService` and `SessionMembershipService` became the synchronous `WorkContextStore` and `SessionMembershipStore`, run as 24 services-domain units behind async facades with the old names (`workspaces-repository-facades.ts`). Every membership method is a write unit, because reads can create a context's owner. Each authorization check shares its unit with the write it guards, so a revoked member cannot act between the check and the write.
- **Host state.** Which principal each renderer client acts as stays in the facade, so `principalForClient` and `registerClientPrincipal` stay synchronous. The one-row local principal is read once on the host connection and cached.
- **Middleware.** `PrincipalCapabilityMiddleware.authorizeContext` and `authorizeManagedSession` are async. The managed-session lookup and its check are now one unit (`authorizeManagedSessionAction`), and the middleware no longer opens its own work-context repository. An AST audit confirms every authorization and membership call in the electron, daemon and CLI programs is awaited, returned or chained, and no call goes through an `as Any` cast.

| Item | Evidence |
| --- | --- |
| Backend parity | Tested on the host and in a worker, with identical results: a context, its owner, and an invite that is accepted once. A second accept, a reviewer revoking a member, and an outsider's snapshot are all rejected with the same messages. The snapshot members, accessible contexts and audit also match. All 10 calls ran in the worker. |
| Register | Background and domain services 52 → 49 files, 267 → 232 sites. The workspace-existence check moved into the store as unit SQL (ratchet +1 `prepare` in `WorkContextService.ts`). |
| Suites | Full suite 9,112 passed; the one failure is the cron test that was already failing. The worker smoke passes with all six domains routed. |

### DB6 services domain, area 8: evals

- **Store.** `EvalService` held its SQL inline and depended only on its connection, so the class became `EvalStore`: 6 units behind an async `EvalService` facade with the old name (`eval-repository-facades.ts`). Its callers are the eval IPC handlers and `ExperimentEvaluationService`, whose `snapshot` is now async; the improvement loop awaits it, and a campaign's baseline is read once before its variants are evaluated rather than once per variant.
- **One unit per operation.** Creating a case reads the task and its events, inserts the case, links it on the task and adds it to the default suite in one transaction. A suite run grades every case against its task's replay (canonical work-session items, else the legacy events) and records the case runs and totals in one transaction. Grading stays read-only on the replay stream.
- **Host cache.** Creating a case writes `tasks.eval_case_id` in the worker, so the facade drops the host's cached task rows afterwards.

| Item | Evidence |
| --- | --- |
| Backend parity | A case created from a completed task with a canonical replay is linked on the task and added to the default suite. The suite run passes the case, and the reloaded run and baseline metrics are identical on the host and in a worker. All 5 calls ran in the worker. |
| Register | Background and domain services 49 → 48 files, 232 → 207 sites. |
| Suites | Full suite 9,113 passed; the one failure is the cron test that was already failing. The worker smoke passes with all six domains routed. |

### DB6 services domain, area 9: Everyday Agent

- **Store.** `EverydayAgentService` became `EverydayAgentStore`, run as 10 services-domain units behind an async `EverydayAgentService` facade with the old name (`everyday-agent-repository-facades.ts`). Callers: the Everyday Agent IPC handlers and the control-plane methods. Schema setup runs on the host when the facade is constructed.
- **Host context.** Admin policies are read from a file on the host, with a last-valid cache, so the store cannot load them in a worker. The facade reads them and passes them as each unit's first argument (`contextStoreUnit`, new in `store-units.ts`). `null` means they failed to load, and the store still fails closed. Risk classification is pure text matching, so it stays synchronous on the facade.
- **Consent.** Enabling consent first prepares the default managed agent, its version and its environment through the managed repositories, which are units of their own. The profile update, consent history and receipt are then recorded in one unit, which checks the admin block again.
- **Refusals that write.** Approving an expired preview, or one whose capability is now blocked, marks the preview and then refuses. Thrown inside a unit, the refusal would roll back the mark, so the store now returns it and the facade throws after the unit commits. An AST scan of all 88 store files run as units (every shared-SQL rule plus the storage-layer stores) found no other throw after a write that relies on the write persisting. The remaining hits either rethrow inside a transaction or fail an invariant, where rolling back is the intended outcome.

| Item | Evidence |
| --- | --- |
| Backend parity | Consent creates the managed agent and environment and enables the profile. A preview is approved. A second preview is expired on disk; approving it is refused, and its `expired` mark is committed. Receipts and clearing previews then match. Results are identical on the host and in a worker, and all 13 calls ran in the worker. |
| Register | Background and domain services 48 → 47 files, 207 → 186 sites. |
| Suites | Full suite 9,114 passed; the one failure is the cron test that was already failing. The worker smoke passes with all six domains routed. |

### DB6 close-out

The remaining services areas, the smaller domains and the known gaps. Each area follows the pattern of the areas above: a synchronous store, one services-domain unit per method, and an async facade under the old name.

- **Moved:**
  - mission control, the activity feed, automation outcomes, councils, event triggers and supervisor exchanges;
  - the improvement loop, hook sessions, first-task, the daily briefing and YouTube transcripts;
  - context policies, ACP, the file hub, temp workspace pruning and orchestration graphs;
  - Numbat security records, recurring approvals, usage telemetry, Pulse's reads and the channel tools' reads.
  
  Along the way, the temp-workspace upsert (four copies) became one storage unit, and the templated-role repair became one unit instead of a manual `BEGIN`/`COMMIT`.
- **Units that write before refusing:**
  - **Activities:** writes take the timeline writer's accepted rows as unit arguments and insert them first, so no activity write commits them on the host.
  - **Numbat:** a record file's findings, decisions and diagnostics are one unit, and the ingestor advances its file cursor only after that unit commits. Before, the cursor moved before the rows were written, so a failed write lost the records.
  - **Candidates and first-task:** merging a duplicate improvement candidate is one unit, as is creating the sample task together with its attempt row.
- **Host context and state:**
  - Context policies create a context's default policy on first read, so each tool check is a write unit. A corrupted restriction list still denies every tool.
  - Triggers, ACP and the file hub keep their in-memory state and persist through units. Triggers await each write; ACP method handlers wait for the startup load.
  - The daily summary tool's task-event range scan waits for the timeline writer's accepted rows to commit (`allCommitted`) instead of committing them on the host.
- **Audits:**
  - An AST audit confirms every context-policy check and recurring-approval lookup is awaited before the action it guards.
  - A scan of `require()` destructurings found one that broke in an earlier rename: `manage_heartbeat` loaded a class that no longer existed. It now uses the typed facade.
  - A scan of this phase's 28 new or extended unit stores for throws after writes found none (the earlier 88 were scanned with the Everyday Agent).
- **Mailbox:**
  - A thread sync is two units: one snapshot of every row it consults, then every write in one transaction, with search and embedding writes best-effort in savepoints. Before, it made several round trips per message. A 12-message thread now takes the same number of round trips as a 1-message thread.
  - Mailbox read statements run on the reporting reader when one is running. They still take their turn in the mailbox's bursts, so read-then-write sequences stay uninterrupted.
- **C2 crash loss:** accepted and bounded; see the plan's DB6 status.
- **Promise lint:**
  - The four pre-existing unawaited returns inside `try` are fixed, plus the Pulse returns this change made async.
  - Floating `completeTask` calls in the executor and the IPC team orchestrator now await or report their failures, as do the router's outgoing-message log and the queue manager's timers.

| Item | Evidence |
| --- | --- |
| Backend parity | On the host and in a worker, with identical results: <br>• **Services parity:** 9 workloads, including the activity feed with an uncommitted pending row and Mission Control. <br>• **Close-out parity:** councils, triggers, improvement merge and reset, hook sessions and locks, first-task, context policies, recurring approval revocation, Numbat ingest, orchestration runs, YouTube transcripts and temp workspace pruning. <br>• **Mailbox parity:** a batched thread sync. |
| Register | Every file has a rule; no rule is a backlog. <br>• **Units:** 82 shared-SQL files. <br>• **Documented stays:** storage layer 10, lifecycle 6, memory handles 6, renderer 1. <br>• **Wiring:** 17 files. <br>• **Reviewed exceptions:** the daemon hot path (4 files) and settings (3 files). <br>Background and domain services: 47 files / 186 sites at the start of the close-out, 0 now. |
| Security | Approval-boundary smoke passes on the host and with storage and services in the worker. The await audits for authorization, policy and approval calls are clean. |
| Suites | Four builds, type-check, lint (including the async-SQLite lint) and the audit pass. Full suite 9,117 passed; the one failure is the cron test that was already failing. The worker smoke passes with all six domains routed. |

### DB7 rollout

The worker is the default backend in all three runtimes. `DATABASE_WORKER_ROLLOUT` in `runtime.ts` turns on every domain flag when the environment leaves it unset. An explicit `0`, `false` or `off` turns one domain off, and `COWORK_DB_WORKER=0` turns off the worker. The desktop app now awaits worker startup before services start, so each run picks one backend.

`npm run qa:db:workload -- --all-domains` runs every domain in the worker, with the reporting reader:

| Scenario | Loop p99, host → worker | Notes |
| --- | --- | --- |
| 1 task | 36 → 19 ms | |
| 8 tasks | 141 → 30 ms | |
| 20 tasks | 306 → 86 ms | Above the 50 ms gate, above the supported cap |
| 40 tasks | 631 → 165 ms | Above the 50 ms gate, above the supported cap |
| 50 submitted, 8 at a time | 152 → 33 ms | |
| 2 s foreign lock | 116 → 27 ms | Max stall 2,162 → 41 ms |

- **Throughput and host share:**
  - Throughput rose 13–160%.
  - With the worker on, the host writes nothing except the 50 task creates in the admission scenario.
  - The host's SQLite share of event-loop time fell from 42–60% to 1–5%.
- **Memory and WAL:** WAL holds at 55 MB on both backends. RSS is 50–140 MB higher with the worker.
- **Results files:** `logs/sqlite-workload/db7-host.json` and `logs/sqlite-workload/db7-worker.json`.
- **Supported levels:** the default concurrency cap is 5–8 tasks, and both gates pass there.
- **Overload fix:** the first 40-task run filled the worker queue (256 requests), and the orchestration graph's reconcile timer turned the `overloaded` rejection into a crash of the direct CLI. The timer now skips a tick while a reconcile runs and logs failures. The rerun had no overload errors.

| Item | Evidence |
| --- | --- |
| Recovery matrix | `recovery-matrix.test.ts` uses a real worker and real SQLite. <br>• A write that fills the disk rolls back and reports `not_committed`, and the worker keeps serving. <br>• 60 read-then-write updates from two runtimes on one profile lose nothing. <br>• A deferred read-then-write on a stale snapshot gets `SQLITE_BUSY` instead of overwriting a commit. <br>• Two runtimes grant one hook lock once. <br>• A worker that exits right after a commit reports `unknown`, and the commit is durable. Integrity and foreign-key checks pass. <br>These add to the DB2–DB6 suites (termination points, locks, invalid payloads, timeouts, saturation, restarts during repair). |
| Rollback | `backend-rollback.test.ts` runs one profile worker → host → worker. Each run sees every earlier commit (tasks, hook sessions, councils), the worker drains before the next run, and the schema version stays the same. |
| Runtime defaults | `rollout.test.ts` covers defaults per runtime, explicit off per domain, the kill switch, and no defaults before a runtime is configured. <br>`qa:db:worker-smoke` checks the default start in all four runtimes (Node, Electron, daemon, CLI). With no flags set, six statement domains route and drain; with `COWORK_DB_WORKER=0`, nothing starts. |
| Packaged artifacts | `smoke-desktop-artifacts.mjs` checks that the ASAR holds the three worker entrypoints and that the native module ships for the target. It launches with a disposable `COWORK_USER_DATA_DIR`. An unsigned arm64 macOS build passed the check and logged `Database worker ready (desktop)`. |
| Dependency gate | Every audit rule has an owner. A file matched only by the backstop rules fails `qa:db:audit`, as does a rule without an owner. The ratchet no longer counts increases in unit stores (files matched by a shared-SQL rule): their SQL runs in the worker. Increases anywhere else still fail. |
| Security | `ipc/handlers.ts` checked a protected-credential request only when the request carried a task id. A request without one skipped the check. The check now lives in `authorizeProtectedCredentialResolution`: a request with a task authorizes against that task, and one without must come from the local owner. The gap predates this migration. |

## Not yet covered

- **Acknowledgement and transaction boundaries.** The inventory lists all 65 transaction sites with enclosing members; mapping which endpoints acknowledge after which commit is still manual DB0 work.
- **Attribution outside SQLite.** The workload has no filesystem or child-process work, so it cannot attribute host delay to those sources. The `[HostPerf]` lines from real desktop use are the input for the DB0 scope decision.
- **Electron ABI and packaged runs.** The workload runs under Node against `dist/cli`; the desktop app's instrumentation is exercised only through its own logs.
- **Real admission.** The 50-task scenario emulates admission with a fixed-size worker pool rather than `TaskQueueManager`, and does not claim production support above the configured cap.
- **Repeatability.** One run on one machine. Repeat the matrix and compare medians before using these numbers as gates.
- **DB7 rollout.** The worker is the default backend in all three runtimes. The host backend stays as the rollback path: set `COWORK_DB_WORKER=0`, or one domain flag to `0`, and restart. The reviewed exceptions stay on the host by design: the daemon hot path, synchronous settings saves, the vault commit, per-service schema DDL, and two startup migrations.
