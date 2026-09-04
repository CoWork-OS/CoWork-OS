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

function parseArgs(argv) {
  const args = {
    suite: "reliability-regressions",
    mode: "deterministic",
    timeoutMs: 6 * 60 * 1000,
    allowEmpty: process.env.COWORK_EVAL_ALLOW_EMPTY === "1",
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === "--suite" || arg === "--suite-id") && argv[i + 1]) {
      args.suite = String(argv[++i] || args.suite);
      continue;
    }
    if (arg === "--mode" && argv[i + 1]) {
      args.mode = String(argv[++i] || args.mode);
      continue;
    }
    if (arg === "--allow-empty") {
      args.allowEmpty = true;
      continue;
    }
    if (arg === "--timeout-ms" && argv[i + 1]) {
      args.timeoutMs = Number(argv[++i]) || args.timeoutMs;
      continue;
    }
  }

  args.timeoutMs = Math.min(Math.max(Math.round(args.timeoutMs), 30_000), 30 * 60 * 1000);
  args.mode = args.mode === "hooks" ? "hooks" : "deterministic";
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

async function postJson(pathname, body) {
  const response = await fetch(`${HOOKS_ORIGIN}${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${HOOKS_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: response.status, json };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTerminalTask(taskId, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const task = sqlJson(
      `SELECT id, status, terminal_status, result_summary, workspace_id FROM tasks WHERE id='${sqlEscape(taskId)}' LIMIT 1`,
    )[0];

    if (!task) return { ok: false, reason: "task_not_found" };

    const approvals = sqlJson(
      `SELECT id FROM approvals WHERE task_id='${sqlEscape(taskId)}' AND status='pending' ORDER BY requested_at ASC`,
    );

    for (const approval of approvals) {
      await postJson("/hooks/approval/respond", { approvalId: approval.id, approved: true });
    }

    if (["completed", "failed", "cancelled", "paused"].includes(task.status)) {
      return { ok: true, task };
    }

    await sleep(1000);
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

function getOrCreateSuiteByName(suiteName) {
  const safeSuiteName = sqlEscape(suiteName);
  const existing = sqlJson(`SELECT * FROM eval_suites WHERE name='${safeSuiteName}' LIMIT 1`)[0];
  if (existing) return existing;

  const id = crypto.randomUUID();
  const now = Date.now();
  sqlExec(
    `INSERT INTO eval_suites (id, name, description, case_ids, created_at, updated_at)
     VALUES ('${sqlEscape(id)}', '${safeSuiteName}', 'Auto-created placeholder suite', '[]', ${now}, ${now})`,
  );
  return sqlJson(`SELECT * FROM eval_suites WHERE id='${sqlEscape(id)}' LIMIT 1`)[0];
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

function loadCases(caseIds) {
  if (!Array.isArray(caseIds) || caseIds.length === 0) return [];
  const idsSql = caseIds.map((id) => `'${sqlEscape(id)}'`).join(",");
  const rows = sqlJson(`SELECT * FROM eval_cases WHERE id IN (${idsSql})`);
  const byId = new Map(rows.map((row) => [row.id, row]));
  return caseIds.map((id) => byId.get(id)).filter(Boolean);
}

async function executeCaseHooksMode(evalCase, timeoutMs, runId) {
  const trigger = await postJson("/hooks/agent", {
    message: evalCase.sanitized_prompt || evalCase.prompt,
    name: `eval-${String(evalCase.id).slice(0, 8)}`,
    wakeMode: "now",
    workspaceId: evalCase.workspace_id || undefined,
    deliver: false,
  });

  if (trigger.status >= 400 || !trigger.json || !trigger.json.taskId) {
    return {
      status: "fail",
      details: `trigger_failed status=${trigger.status}`,
    };
  }

  const replayTaskId = trigger.json.taskId;
  const wait = await waitForTerminalTask(replayTaskId, timeoutMs);
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
    assertions: safeJsonParse(evalCase.assertions, {}),
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
    assertions: safeJsonParse(evalCase.assertions, {}),
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

async function main() {
  const args = parseArgs(process.argv);
  ensureSqliteCli();

  ensureEvalTables();

  const suite = resolveSuite(args.suite) || getOrCreateSuiteByName(args.suite);
  const caseIds = safeJsonParse(suite.case_ids, []);
  const cases = loadCases(caseIds);

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
       '${sqlEscape(JSON.stringify({ mode: args.mode, suiteName: suite.name, caseCount: cases.length }))}'
     )`,
  );

  let passCount = 0;
  let failCount = 0;
  let skippedCount = 0;

  console.log(`[eval-run] suite: ${suite.name} (${suite.id})`);
  console.log(`[eval-run] mode: ${args.mode}`);
  console.log(`[eval-run] cases: ${cases.length}`);

  const fixtureResults = runDeterministicReplayFixtures();
  const fixtureFailures = fixtureResults.filter((result) => !result.passed);
  const fixturePasses = fixtureResults.length - fixtureFailures.length;
  console.log(`[eval-run] isolated fixtures: ${fixtureResults.length}`);
  for (const result of fixtureResults) {
    console.log(`- ${result.passed ? "PASS" : "FAIL"} fixture ${result.fixtureId}`);
    if (!result.passed) console.log(`  ${result.failures.join("; ") || "projection mismatch"}`);
  }
  // Fixtures are first-class replay cases. Count them in the run summary so a
  // clean database still reports meaningful coverage instead of looking like
  // an empty/allowed evaluation run.
  passCount += fixturePasses;
  failCount += fixtureFailures.length;

  for (const evalCase of cases) {
    const caseStartedAt = Date.now();
    let verdict;

    try {
      verdict =
        args.mode === "hooks"
          ? await executeCaseHooksMode(evalCase, args.timeoutMs, runId)
          : executeCaseDeterministicMode(evalCase);
    } catch (error) {
      verdict = {
        status: "fail",
        details: `exception: ${String(error && error.message ? error.message : error)}`,
      };
    }

    if (verdict.status === "pass") passCount += 1;
    if (verdict.status === "fail") failCount += 1;
    if (verdict.status === "skipped") skippedCount += 1;

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

  const executedCount = passCount + failCount;
  const completedAt = Date.now();
  const runStatus =
    failCount > 0 || (executedCount === 0 && !args.allowEmpty) ? "failed" : "completed";

  sqlExec(
    `UPDATE eval_runs
     SET status='${sqlEscape(runStatus)}',
         completed_at=${completedAt},
         pass_count=${passCount},
         fail_count=${failCount},
         skipped_count=${skippedCount}
     WHERE id='${sqlEscape(runId)}'`,
  );

  console.log("[eval-run] summary");
  console.log(`- runId: ${runId}`);
  console.log(`- pass: ${passCount}`);
  console.log(`- fail: ${failCount}`);
  console.log(`- skipped: ${skippedCount}`);
  console.log(`- executed: ${executedCount}`);
  console.log(`- status: ${runStatus}`);
  if (executedCount === 0) {
    console.log(
      args.allowEmpty
        ? "- reason: no eval cases were executed (all skipped or suite empty, allowed by configuration)"
        : "- reason: no eval cases were executed (all skipped or suite empty)",
    );
  }

  if (runStatus === "failed") {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("[eval-run] fatal:", error);
  process.exit(1);
});
