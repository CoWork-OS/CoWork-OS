/* eslint-disable no-console */
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const crypto = require("crypto");
const {
  evaluateIsolatedEvents,
  runDeterministicReplayFixtures,
} = require("./isolated-replay-evaluation.cjs");

const DB_PATH =
  process.env.COWORK_DB_PATH ||
  path.join(os.homedir(), "Library", "Application Support", "cowork-os", "cowork-os.db");
const HOOKS_ORIGIN = process.env.COWORK_HOOKS_ORIGIN || "http://127.0.0.1:9877";
const HOOKS_TOKEN = process.env.COWORK_HOOKS_TOKEN || "qa-token";
const SQLITE_BUSY_TIMEOUT_MS = Number(process.env.COWORK_SQLITE_BUSY_TIMEOUT_MS) || 15000;
const HOOKS_HTTP_TIMEOUT_MS = (() => {
  const configured = Number(process.env.COWORK_EVAL_HTTP_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) return 15_000;
  return Math.min(Math.max(Math.round(configured), 100), 60_000);
})();

function parseArgs(argv) {
  const args = {
    suite: "reliability-regressions",
    mode: "deterministic",
    timeoutMs: 6 * 60 * 1000,
    allowEmpty: process.env.COWORK_EVAL_ALLOW_EMPTY === "1",
    autoApprove: false,
    fixturesOnly: false,
    suiteExplicit: false,
    modeExplicit: false,
    timeoutExplicit: false,
    allowEmptyExplicit: false,
    error: null,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--suite" || arg === "--suite-id") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        args.error = args.error || `missing value for ${arg}`;
      } else {
        args.suite = String(argv[++i]);
        args.suiteExplicit = true;
      }
      continue;
    }
    if (arg === "--mode") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        args.error = args.error || `missing value for ${arg}`;
      } else {
        args.mode = String(argv[++i]);
        args.modeExplicit = true;
        if (!["deterministic", "hooks"].includes(args.mode)) {
          args.error = args.error || `unsupported mode: ${args.mode}`;
        }
      }
      continue;
    }
    if (arg === "--allow-empty") {
      args.allowEmpty = true;
      args.allowEmptyExplicit = true;
      continue;
    }
    if (arg === "--auto-approve") {
      args.autoApprove = true;
      continue;
    }
    if (arg === "--fixtures-only") {
      args.fixturesOnly = true;
      continue;
    }
    if (arg === "--timeout-ms") {
      const value = argv[i + 1];
      const configured = Number(value);
      args.timeoutExplicit = true;
      if (!value || value.startsWith("--") || !Number.isFinite(configured) || configured <= 0) {
        args.error = args.error || "--timeout-ms must be a positive number";
      } else {
        i += 1;
        args.timeoutMs = configured;
      }
      continue;
    }
    args.error =
      args.error ||
      (arg.startsWith("-") ? `unknown option: ${arg}` : `unexpected argument: ${arg}`);
  }

  args.timeoutMs = Math.min(Math.max(Math.round(args.timeoutMs), 30_000), 30 * 60 * 1000);
  if (
    args.fixturesOnly &&
    (args.suiteExplicit ||
      args.modeExplicit ||
      args.timeoutExplicit ||
      args.allowEmptyExplicit ||
      args.autoApprove)
  ) {
    args.error =
      args.error ||
      "--fixtures-only cannot be combined with --suite, --mode, --timeout-ms, --allow-empty, or --auto-approve";
  }
  if (args.autoApprove && args.mode !== "hooks") {
    args.error = args.error || "--auto-approve requires --mode hooks";
  }
  return args;
}

function sqlEscape(value) {
  return String(value).replace(/'/g, "''");
}

function ensureSqliteCli() {
  try {
    execFileSync("sqlite3", ["--version"], { stdio: "ignore" });
  } catch {
    console.error("[eval-run] sqlite3 CLI not found. Install sqlite3 to run this script.");
    process.exit(1);
  }
}

function sqlExec(sql) {
  execFileSync("sqlite3", ["-cmd", `.timeout ${SQLITE_BUSY_TIMEOUT_MS}`, DB_PATH, sql], {
    encoding: "utf8",
  });
}

function sqlJson(sql) {
  const out = execFileSync(
    "sqlite3",
    ["-cmd", `.timeout ${SQLITE_BUSY_TIMEOUT_MS}`, "-json", DB_PATH, sql],
    {
      encoding: "utf8",
    },
  ).trim();
  if (!out) return [];
  return JSON.parse(out);
}

function safeJsonParse(value, fallback) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function eventRowsToEvents(rows) {
  return rows.map((row, index) => ({
    id: row.id,
    taskId: row.task_id,
    timestamp: row.timestamp,
    type: row.type,
    legacyType: row.legacy_type,
    eventId: row.event_id,
    // Older TaskEvent rows may not have a sequence.  Assign a deterministic
    // replay sequence in query order instead of letting every missing value
    // sort as zero and fall back to UUID order.
    seq:
      typeof row.seq === "number" && Number.isFinite(row.seq) && row.seq > 0
        ? Math.floor(row.seq)
        : index + 1,
    actor: row.actor,
    payload: safeJsonParse(row.payload, {}),
  }));
}

function canonicalRowsToEvents(rows, taskId) {
  return rows.map((row) => {
    const payload = safeJsonParse(row.payload_json, {});
    const timestamp =
      payload && typeof payload.timestamp === "number" && Number.isFinite(payload.timestamp)
        ? payload.timestamp
        : Number(row.created_at || 0);
    return {
      id: row.id,
      taskId,
      timestamp,
      type: row.kind || "legacy_event",
      eventId: row.source_event_id || (payload && payload.eventId),
      seq: Number(row.sequence || 0),
      sequence: Number(row.sequence || 0),
      actor: row.actor,
      kind: row.kind,
      payload,
    };
  });
}

function isSyntheticCanonicalRow(row) {
  if (row.source_event_id) return false;
  const payload = safeJsonParse(row.payload_json, {});
  const event = payload && typeof payload.event === "string" ? payload.event : "";
  return event === "session.created" || event.startsWith("turn.");
}

function loadReplayEvents(taskRow) {
  const taskId = String(taskRow.id);
  const legacyRows = sqlJson(
    `SELECT id, task_id, timestamp, type, legacy_type, event_id, seq, actor, payload
     FROM task_events
     WHERE task_id='${sqlEscape(taskId)}' AND type <> 'llm_streaming'
     ORDER BY COALESCE(seq, timestamp) ASC, timestamp ASC, id ASC`,
  );

  // Prefer the canonical append-only stream when it represents every
  // persisted legacy event.  A newly-created session can temporarily contain
  // only its synthetic root item; in that window grade the complete legacy
  // source rather than declaring a false missing-item failure.
  let canonicalRows = [];
  try {
    const sessionRow = sqlJson(
      `SELECT ws.id
       FROM work_sessions ws
       LEFT JOIN tasks t ON t.session_id = ws.id
       WHERE ws.task_id='${sqlEscape(taskId)}'
          OR t.id='${sqlEscape(taskId)}'
       ORDER BY ws.updated_at DESC LIMIT 1`,
    )[0];
    if (sessionRow && sessionRow.id) {
      canonicalRows = sqlJson(
        `SELECT id, session_id, turn_id, sequence, kind, actor, payload_json,
                redaction_class, status, created_at, source_event_id
         FROM work_session_items
         WHERE session_id='${sqlEscape(sessionRow.id)}'
         ORDER BY sequence ASC`,
      );
      if (canonicalRows.length > 0) {
        const replayCanonicalRows = canonicalRows.filter((row) => !isSyntheticCanonicalRow(row));
        const canonicalIds = new Set();
        for (const row of canonicalRows) {
          if (row.source_event_id) canonicalIds.add(String(row.source_event_id));
          const payload = safeJsonParse(row.payload_json, {});
          if (payload && typeof payload.eventId === "string" && payload.eventId.trim()) {
            canonicalIds.add(payload.eventId.trim());
          }
        }
        const complete = legacyRows.every((row) => {
          const id = row.event_id || row.id;
          return !id || canonicalIds.has(String(id));
        });
        // Synthetic session/turn roots are bookkeeping, not replay evidence.
        // A task with no persisted events must not pass solely because its
        // canonical aggregate has been created.
        if (complete && replayCanonicalRows.length > 0) {
          return {
            events: canonicalRowsToEvents(canonicalRows, taskId),
            source: "canonical",
          };
        }
      }
    }
  } catch (error) {
    // The script is also used against pre-Phase-5 databases.  Missing
    // canonical tables should select the compatibility source, not abort the
    // evaluation run.
    if (!String(error && error.message ? error.message : error).includes("no such table")) {
      throw error;
    }
  }

  return { events: eventRowsToEvents(legacyRows), source: "legacy" };
}

async function postJson(pathname, body, deadlineAt = Number.POSITIVE_INFINITY) {
  const requestTimeoutMs = Math.min(HOOKS_HTTP_TIMEOUT_MS, deadlineAt - Date.now());
  if (requestTimeoutMs <= 0) {
    return { status: 408, json: { error: "case_deadline_exceeded" } };
  }
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(`${HOOKS_ORIGIN}${pathname}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${HOOKS_TOKEN}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    return { status: response.status, json };
  } catch (error) {
    if (controller.signal.aborted) {
      return {
        status: 408,
        json: { error: `request_timeout_after_${requestTimeoutMs}ms` },
      };
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTerminalTask(taskId, timeoutMs, { autoApprove = false } = {}) {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    const task = sqlJson(
      `SELECT id, status, terminal_status, result_summary, workspace_id FROM tasks WHERE id='${sqlEscape(taskId)}' LIMIT 1`,
    )[0];

    if (!task) return { ok: false, reason: "task_not_found" };

    const approvals = sqlJson(
      `SELECT id FROM approvals WHERE task_id='${sqlEscape(taskId)}' AND status='pending' ORDER BY requested_at ASC`,
    );

    if (approvals.length > 0 && !autoApprove) {
      return {
        ok: false,
        reason: "pending_approval",
        approvalIds: approvals.map((approval) => approval.id),
      };
    }

    for (const approval of approvals) {
      const response = await postJson(
        "/hooks/approval/respond",
        {
          approvalId: approval.id,
          approved: true,
        },
        deadlineAt,
      );
      if (response.status >= 400) {
        return {
          ok: false,
          reason: "approval_response_failed",
          approvalId: approval.id,
          httpStatus: response.status,
          response: response.json,
        };
      }
    }

    if (["completed", "failed", "cancelled", "paused"].includes(task.status)) {
      return { ok: true, task };
    }

    await sleep(Math.max(0, Math.min(1000, deadlineAt - Date.now())));
  }

  return { ok: false, reason: "timeout" };
}

function ensureEvalTables() {
  sqlExec(`
    CREATE TABLE IF NOT EXISTS eval_cases (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      workspace_id TEXT,
      source_task_id TEXT,
      prompt TEXT NOT NULL,
      sanitized_prompt TEXT NOT NULL,
      assertions TEXT,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS eval_suites (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      case_ids TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS eval_runs (
      id TEXT PRIMARY KEY,
      suite_id TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      pass_count INTEGER NOT NULL DEFAULT 0,
      fail_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      metadata TEXT
    );

    CREATE TABLE IF NOT EXISTS eval_case_runs (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      case_id TEXT NOT NULL,
      status TEXT NOT NULL,
      details TEXT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      duration_ms INTEGER
    );
  `);
}

function resolveSuite(suiteSelector) {
  const byId = sqlJson(
    `SELECT * FROM eval_suites WHERE id='${sqlEscape(suiteSelector)}' LIMIT 1`,
  )[0];
  if (byId) return byId;
  const byName = sqlJson(
    `SELECT * FROM eval_suites WHERE name='${sqlEscape(suiteSelector)}' LIMIT 1`,
  )[0];
  return byName || null;
}

function parseSuiteCaseIds(value) {
  if (typeof value !== "string" || !value.trim()) return { caseIds: [] };

  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { error: "suite case_ids is not valid JSON" };
  }

  if (!Array.isArray(parsed)) return { error: "suite case_ids must be an array" };

  const caseIds = [];
  for (const value of parsed) {
    if (typeof value !== "string" || !value.trim()) {
      return { error: "suite case_ids must contain non-empty string IDs" };
    }
    caseIds.push(value.trim());
  }

  const duplicates = caseIds.filter((id, index) => caseIds.indexOf(id) !== index);
  if (duplicates.length > 0) {
    return { error: `suite case_ids contains duplicate ID: ${duplicates[0]}` };
  }

  return { caseIds };
}

function loadCases(caseIds) {
  if (!Array.isArray(caseIds) || caseIds.length === 0) return { cases: [], missingCaseIds: [] };
  const idsSql = caseIds.map((id) => `'${sqlEscape(id)}'`).join(",");
  const rows = sqlJson(`SELECT * FROM eval_cases WHERE id IN (${idsSql})`);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const missingCaseIds = caseIds.filter((id) => !byId.has(id));
  return {
    cases: caseIds.map((id) => byId.get(id)).filter(Boolean),
    missingCaseIds,
  };
}

async function executeCaseHooksMode(evalCase, timeoutMs, runId, { autoApprove = false } = {}) {
  const deadlineAt = Date.now() + timeoutMs;
  const trigger = await postJson(
    "/hooks/agent",
    {
      message: evalCase.sanitized_prompt || evalCase.prompt,
      name: `eval-${String(evalCase.id).slice(0, 8)}`,
      wakeMode: "now",
      workspaceId: evalCase.workspace_id || undefined,
      deliver: false,
    },
    deadlineAt,
  );

  if (trigger.status >= 400 || !trigger.json || !trigger.json.taskId) {
    return {
      status: "fail",
      details: `trigger_failed status=${trigger.status}`,
    };
  }

  const replayTaskId = trigger.json.taskId;
  const wait = await waitForTerminalTask(replayTaskId, Math.max(0, deadlineAt - Date.now()), {
    autoApprove,
  });
  if (!wait.ok) {
    return {
      status: "fail",
      details: `replay_timeout_or_missing reason=${wait.reason || "unknown"}`,
    };
  }

  const taskRow = sqlJson(
    `SELECT id, status, terminal_status, result_summary, workspace_id FROM tasks WHERE id='${sqlEscape(replayTaskId)}' LIMIT 1`,
  )[0];
  const replaySource = loadReplayEvents(taskRow);

  const replay = evaluateIsolatedEvents(replaySource.events, {
    taskRow,
    assertions: evalCase.assertions ? JSON.parse(evalCase.assertions) : {},
  });

  sqlExec(
    `UPDATE tasks SET eval_run_id='${sqlEscape(runId)}', updated_at=${Date.now()} WHERE id='${sqlEscape(replayTaskId)}'`,
  );

  if (!replay.passed) {
    return {
      status: "fail",
      details: replay.failures.join("; ") || "isolated replay projection mismatch",
    };
  }

  return {
    status: "pass",
    details: `isolated hook replay passed (${replay.replay.itemCount} items; source=${replaySource.source}; checksum=${replay.fullRebuildChecksum})`,
  };
}

function executeCaseDeterministicMode(evalCase) {
  if (!evalCase.source_task_id) {
    return { status: "skipped", details: "no source task linked" };
  }

  const taskRow = sqlJson(
    `SELECT id, status, terminal_status, result_summary, workspace_id FROM tasks WHERE id='${sqlEscape(evalCase.source_task_id)}' LIMIT 1`,
  )[0];
  if (!taskRow) {
    return { status: "skipped", details: "source task not found" };
  }

  const replaySource = loadReplayEvents(taskRow);

  // Replay into a fresh in-memory state machine.  The source task/snapshot is
  // input evidence only; terminal status, waits, side effects, and security
  // invariants are derived from the isolated replay.
  const replay = evaluateIsolatedEvents(replaySource.events, {
    taskRow,
    assertions: evalCase.assertions ? JSON.parse(evalCase.assertions) : {},
  });

  if (!replay.passed) {
    return {
      status: "fail",
      details: replay.failures.join("; ") || "isolated replay projection mismatch",
    };
  }

  return {
    status: "pass",
    details: `isolated replay passed (${replay.replay.itemCount} items; source=${replaySource.source}; checksum=${replay.fullRebuildChecksum})`,
  };
}

function printFixtureResults(fixtureResults) {
  const fixtureFailures = fixtureResults.filter((result) => !result.passed);
  const fixturePasses = fixtureResults.length - fixtureFailures.length;
  console.log(`[eval-run] fixtures: ${fixtureResults.length}`);
  for (const result of fixtureResults) {
    console.log(`- ${result.passed ? "PASS" : "FAIL"} fixture ${result.fixtureId}`);
    if (!result.passed) console.log(`  ${result.failures.join("; ") || "projection mismatch"}`);
  }
  return { fixturePasses, fixtureFailures };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.error) {
    console.error(`[eval-run] ${args.error}`);
    process.exitCode = 1;
    return;
  }

  // Fixture mode is deliberately independent of the application database.
  // It is a deterministic projection check, not selected-corpus coverage.
  if (args.fixturesOnly) {
    const fixtureResults = runDeterministicReplayFixtures();
    const { fixturePasses, fixtureFailures } = printFixtureResults(fixtureResults);
    const runStatus = fixtureFailures.length > 0 ? "failed" : "completed";
    console.log("[eval-run] summary");
    console.log("- scope: fixtures-only");
    console.log("- selected cases: 0");
    console.log(`- fixture pass: ${fixturePasses}`);
    console.log(`- fixture fail: ${fixtureFailures.length}`);
    console.log("- selected pass: 0");
    console.log("- selected fail: 0");
    console.log("- selected skipped: 0");
    console.log("- selected executed: 0");
    console.log("- selected coverage: 0/0 (fixtures-only)");
    console.log(`- status: ${runStatus}`);
    if (runStatus === "failed") process.exitCode = 1;
    return;
  }

  ensureSqliteCli();

  ensureEvalTables();

  const suite = resolveSuite(args.suite);
  if (!suite) {
    console.error(`[eval-run] suite not found: ${args.suite}`);
    process.exitCode = 1;
    return;
  }

  const parsedCaseIds = parseSuiteCaseIds(suite.case_ids);
  if (parsedCaseIds.error) {
    console.error(`[eval-run] invalid suite ${suite.name}: ${parsedCaseIds.error}`);
    process.exitCode = 1;
    return;
  }

  const loadedCases = loadCases(parsedCaseIds.caseIds);
  if (loadedCases.missingCaseIds.length > 0) {
    console.error(
      `[eval-run] suite ${suite.name} references missing eval case(s): ${loadedCases.missingCaseIds.join(", ")}`,
    );
    process.exitCode = 1;
    return;
  }
  const cases = loadedCases.cases;

  const runId = crypto.randomUUID();
  const startedAt = Date.now();

  sqlExec(
    `INSERT INTO eval_runs (id, suite_id, status, started_at, pass_count, fail_count, skipped_count, metadata)
     VALUES (
       '${sqlEscape(runId)}',
       '${sqlEscape(suite.id)}',
       'running',
       ${startedAt},
       0,
       0,
       0,
       '${sqlEscape(
         JSON.stringify({
           mode: args.mode,
           suiteName: suite.name,
           selectedCaseCount: cases.length,
           autoApprove: args.autoApprove,
         }),
       )}'
     )`,
  );

  let selectedPassCount = 0;
  let selectedFailCount = 0;
  let selectedSkippedCount = 0;

  console.log(`[eval-run] suite: ${suite.name} (${suite.id})`);
  console.log(`[eval-run] mode: ${args.mode}`);
  console.log(`[eval-run] selected cases: ${cases.length}`);
  if (args.mode === "hooks") {
    console.log(`[eval-run] auto-approve: ${args.autoApprove ? "enabled" : "disabled"}`);
  }

  for (const evalCase of cases) {
    const caseStartedAt = Date.now();
    let verdict;

    try {
      verdict =
        args.mode === "hooks"
          ? await executeCaseHooksMode(evalCase, args.timeoutMs, runId, {
              autoApprove: args.autoApprove,
            })
          : executeCaseDeterministicMode(evalCase);
    } catch (error) {
      verdict = {
        status: "fail",
        details: `exception: ${String(error && error.message ? error.message : error)}`,
      };
    }

    if (verdict.status === "pass") selectedPassCount += 1;
    if (verdict.status === "fail") selectedFailCount += 1;
    if (verdict.status === "skipped") selectedSkippedCount += 1;

    sqlExec(
      `INSERT INTO eval_case_runs (
         id, run_id, case_id, status, details, started_at, completed_at, duration_ms
       ) VALUES (
         '${sqlEscape(crypto.randomUUID())}',
         '${sqlEscape(runId)}',
         '${sqlEscape(evalCase.id)}',
         '${sqlEscape(verdict.status)}',
         '${sqlEscape(verdict.details || "")}',
         ${caseStartedAt},
         ${Date.now()},
         ${Date.now() - caseStartedAt}
       )`,
    );

    const label =
      verdict.status === "pass" ? "PASS" : verdict.status === "skipped" ? "SKIP" : "FAIL";
    console.log(`- ${label} ${evalCase.id} ${evalCase.name}`);
    if (verdict.status !== "pass") {
      console.log(`  ${verdict.details}`);
    }
  }

  const selectedExecutedCount = selectedPassCount + selectedFailCount;
  const completedAt = Date.now();
  const runStatus =
    selectedFailCount > 0 || (selectedSkippedCount > 0 && selectedExecutedCount > 0)
      ? "failed"
      : selectedExecutedCount === 0
        ? args.allowEmpty
          ? "skipped"
          : "failed"
        : "completed";

  sqlExec(
    `UPDATE eval_runs
     SET status='${sqlEscape(runStatus)}',
         completed_at=${completedAt},
         pass_count=${selectedPassCount},
         fail_count=${selectedFailCount},
         skipped_count=${selectedSkippedCount}
     WHERE id='${sqlEscape(runId)}'`,
  );

  console.log("[eval-run] summary");
  console.log(`- runId: ${runId}`);
  console.log(`- selected cases: ${cases.length}`);
  console.log(`- selected pass: ${selectedPassCount}`);
  console.log(`- selected fail: ${selectedFailCount}`);
  console.log(`- selected skipped: ${selectedSkippedCount}`);
  console.log(`- selected executed: ${selectedExecutedCount}`);
  console.log(`- selected coverage: ${selectedExecutedCount}/${cases.length}`);
  console.log("- fixtures: 0 (use --fixtures-only)");
  console.log(`- status: ${runStatus}`);
  if (selectedExecutedCount === 0) {
    console.log(
      args.allowEmpty
        ? "- reason: no selected eval cases were executed (explicitly allowed; no evaluated coverage)"
        : "- reason: no selected eval cases were executed (all skipped or suite empty)",
    );
  }

  if (runStatus === "failed") {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("[eval-run] fatal:", error);
    process.exit(1);
  });
}

module.exports = { postJson };
