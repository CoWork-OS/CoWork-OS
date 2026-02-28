/* eslint-disable no-console */
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const crypto = require('crypto');

const DB_PATH =
  process.env.COWORK_DB_PATH ||
  path.join(os.homedir(), 'Library', 'Application Support', 'cowork-os', 'cowork-os.db');
const HOOKS_ORIGIN = process.env.COWORK_HOOKS_ORIGIN || 'http://127.0.0.1:9877';
const HOOKS_TOKEN = process.env.COWORK_HOOKS_TOKEN || 'qa-token';
const SQLITE_BUSY_TIMEOUT_MS = Number(process.env.COWORK_SQLITE_BUSY_TIMEOUT_MS) || 15000;

function parseArgs(argv) {
  const args = {
    suite: 'reliability-regressions',
    mode: 'deterministic',
    timeoutMs: 6 * 60 * 1000,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === '--suite' || arg === '--suite-id') && argv[i + 1]) {
      args.suite = String(argv[++i] || args.suite);
      continue;
    }
    if (arg === '--mode' && argv[i + 1]) {
      args.mode = String(argv[++i] || args.mode);
      continue;
    }
    if (arg === '--timeout-ms' && argv[i + 1]) {
      args.timeoutMs = Number(argv[++i]) || args.timeoutMs;
      continue;
    }
  }

  args.timeoutMs = Math.min(Math.max(Math.round(args.timeoutMs), 30_000), 30 * 60 * 1000);
  args.mode = args.mode === 'hooks' ? 'hooks' : 'deterministic';
  return args;
}

function sqlEscape(value) {
  return String(value).replace(/'/g, "''");
}

function ensureSqliteCli() {
  try {
    execFileSync('sqlite3', ['--version'], { stdio: 'ignore' });
  } catch {
    console.error('[eval-run] sqlite3 CLI not found. Install sqlite3 to run this script.');
    process.exit(1);
  }
}

function sqlExec(sql) {
  execFileSync('sqlite3', ['-cmd', `.timeout ${SQLITE_BUSY_TIMEOUT_MS}`, DB_PATH, sql], {
    encoding: 'utf8',
  });
}

function sqlJson(sql) {
  const out = execFileSync('sqlite3', ['-cmd', `.timeout ${SQLITE_BUSY_TIMEOUT_MS}`, '-json', DB_PATH, sql], {
    encoding: 'utf8',
  }).trim();
  if (!out) return [];
  return JSON.parse(out);
}

function safeJsonParse(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeTerminalStatus(taskRow) {
  const terminal = String(taskRow.terminal_status || '').trim();
  if (terminal === 'ok' || terminal === 'partial_success' || terminal === 'failed') return terminal;
  if (taskRow.status === 'completed') return 'ok';
  return 'failed';
}

function extractChangedPaths(events) {
  const changed = new Set();
  const add = (value) => {
    if (typeof value !== 'string') return;
    const normalized = value.trim().replace(/\\/g, '/');
    if (!normalized) return;
    changed.add(normalized);
  };

  for (const event of events) {
    if (!['file_created', 'file_modified', 'file_deleted', 'artifact_created'].includes(event.type)) {
      continue;
    }
    add(event.payload?.path);
    add(event.payload?.from);
    add(event.payload?.to);
  }

  return changed;
}

function evaluateAssertions({ taskRow, events, assertions }) {
  const failures = [];
  const normalizedAssertions = assertions && typeof assertions === 'object' ? assertions : {};

  if (normalizedAssertions.expectedTerminalStatus) {
    const actual = normalizeTerminalStatus(taskRow);
    if (actual !== normalizedAssertions.expectedTerminalStatus) {
      failures.push(
        `expected terminal_status=${normalizedAssertions.expectedTerminalStatus}, actual=${actual}`,
      );
    }
  }

  const summary = String(taskRow.result_summary || '');
  const mustContainAll = Array.isArray(normalizedAssertions.mustContainAll)
    ? normalizedAssertions.mustContainAll
    : [];
  for (const needle of mustContainAll) {
    if (!needle) continue;
    if (!summary.toLowerCase().includes(String(needle).toLowerCase())) {
      failures.push(`missing required summary text: \"${needle}\"`);
    }
  }

  const mustCreatePaths = Array.isArray(normalizedAssertions.mustCreatePaths)
    ? normalizedAssertions.mustCreatePaths
    : [];
  if (mustCreatePaths.length > 0) {
    const changed = extractChangedPaths(events);
    for (const requiredPath of mustCreatePaths) {
      if (!requiredPath) continue;
      const normalized = String(requiredPath).replace(/\\/g, '/');
      const found = Array.from(changed).some((candidate) => candidate.endsWith(normalized));
      if (!found) {
        failures.push(`missing required changed path: \"${requiredPath}\"`);
      }
    }
  }

  return failures;
}

function eventRowsToEvents(rows) {
  return rows.map((row) => ({
    id: row.id,
    taskId: row.task_id,
    timestamp: row.timestamp,
    type: row.type,
    payload: safeJsonParse(row.payload, {}),
  }));
}

async function postJson(pathname, body) {
  const response = await fetch(`${HOOKS_ORIGIN}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
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

    if (!task) return { ok: false, reason: 'task_not_found' };

    const approvals = sqlJson(
      `SELECT id FROM approvals WHERE task_id='${sqlEscape(taskId)}' AND status='pending' ORDER BY requested_at ASC`,
    );

    for (const approval of approvals) {
      await postJson('/hooks/approval/respond', { approvalId: approval.id, approved: true });
    }

    if (['completed', 'failed', 'cancelled', 'paused'].includes(task.status)) {
      return { ok: true, task };
    }

    await sleep(1000);
  }

  return { ok: false, reason: 'timeout' };
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
  const byId = sqlJson(`SELECT * FROM eval_suites WHERE id='${sqlEscape(suiteSelector)}' LIMIT 1`)[0];
  if (byId) return byId;
  const byName = sqlJson(`SELECT * FROM eval_suites WHERE name='${sqlEscape(suiteSelector)}' LIMIT 1`)[0];
  return byName || null;
}

function loadCases(caseIds) {
  if (!Array.isArray(caseIds) || caseIds.length === 0) return [];
  const idsSql = caseIds.map((id) => `'${sqlEscape(id)}'`).join(',');
  const rows = sqlJson(`SELECT * FROM eval_cases WHERE id IN (${idsSql})`);
  const byId = new Map(rows.map((row) => [row.id, row]));
  return caseIds.map((id) => byId.get(id)).filter(Boolean);
}

async function executeCaseHooksMode(evalCase, timeoutMs, runId) {
  const trigger = await postJson('/hooks/agent', {
    message: evalCase.sanitized_prompt || evalCase.prompt,
    name: `eval-${String(evalCase.id).slice(0, 8)}`,
    wakeMode: 'now',
    workspaceId: evalCase.workspace_id || undefined,
    deliver: false,
  });

  if (trigger.status >= 400 || !trigger.json || !trigger.json.taskId) {
    return {
      status: 'fail',
      details: `trigger_failed status=${trigger.status}`,
    };
  }

  const replayTaskId = trigger.json.taskId;
  const wait = await waitForTerminalTask(replayTaskId, timeoutMs);
  if (!wait.ok) {
    return {
      status: 'fail',
      details: `replay_timeout_or_missing reason=${wait.reason || 'unknown'}`,
    };
  }

  const taskRow = sqlJson(
    `SELECT id, status, terminal_status, result_summary, workspace_id FROM tasks WHERE id='${sqlEscape(replayTaskId)}' LIMIT 1`,
  )[0];
  const eventRows = sqlJson(
    `SELECT id, task_id, timestamp, type, payload FROM task_events WHERE task_id='${sqlEscape(replayTaskId)}' ORDER BY timestamp ASC`,
  );
  const events = eventRowsToEvents(eventRows);

  const failures = evaluateAssertions({
    taskRow,
    events,
    assertions: safeJsonParse(evalCase.assertions, {}),
  });

  sqlExec(
    `UPDATE tasks SET eval_run_id='${sqlEscape(runId)}', updated_at=${Date.now()} WHERE id='${sqlEscape(replayTaskId)}'`,
  );

  if (failures.length > 0) {
    return { status: 'fail', details: failures.join('; ') };
  }

  return { status: 'pass', details: 'hook replay assertions satisfied' };
}

function executeCaseDeterministicMode(evalCase) {
  if (!evalCase.source_task_id) {
    return { status: 'skipped', details: 'no source task linked' };
  }

  const taskRow = sqlJson(
    `SELECT id, status, terminal_status, result_summary, workspace_id FROM tasks WHERE id='${sqlEscape(evalCase.source_task_id)}' LIMIT 1`,
  )[0];
  if (!taskRow) {
    return { status: 'skipped', details: 'source task not found' };
  }

  const eventRows = sqlJson(
    `SELECT id, task_id, timestamp, type, payload FROM task_events WHERE task_id='${sqlEscape(taskRow.id)}' ORDER BY timestamp ASC`,
  );
  const events = eventRowsToEvents(eventRows);

  const failures = evaluateAssertions({
    taskRow,
    events,
    assertions: safeJsonParse(evalCase.assertions, {}),
  });

  if (failures.length > 0) {
    return { status: 'fail', details: failures.join('; ') };
  }

  return { status: 'pass', details: 'deterministic assertions satisfied' };
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

  for (const evalCase of cases) {
    const caseStartedAt = Date.now();
    let verdict;

    try {
      verdict =
        args.mode === 'hooks'
          ? await executeCaseHooksMode(evalCase, args.timeoutMs, runId)
          : executeCaseDeterministicMode(evalCase);
    } catch (error) {
      verdict = {
        status: 'fail',
        details: `exception: ${String(error && error.message ? error.message : error)}`,
      };
    }

    if (verdict.status === 'pass') passCount += 1;
    if (verdict.status === 'fail') failCount += 1;
    if (verdict.status === 'skipped') skippedCount += 1;

    sqlExec(
      `INSERT INTO eval_case_runs (
         id, run_id, case_id, status, details, started_at, completed_at, duration_ms
       ) VALUES (
         '${sqlEscape(crypto.randomUUID())}',
         '${sqlEscape(runId)}',
         '${sqlEscape(evalCase.id)}',
         '${sqlEscape(verdict.status)}',
         '${sqlEscape(verdict.details || '')}',
         ${caseStartedAt},
         ${Date.now()},
         ${Date.now() - caseStartedAt}
       )`,
    );

    const label = verdict.status === 'pass' ? 'PASS' : verdict.status === 'skipped' ? 'SKIP' : 'FAIL';
    console.log(`- ${label} ${evalCase.id} ${evalCase.name}`);
    if (verdict.status !== 'pass') {
      console.log(`  ${verdict.details}`);
    }
  }

  const executedCount = passCount + failCount;
  const completedAt = Date.now();
  const runStatus = failCount > 0 || executedCount === 0 ? 'failed' : 'completed';

  sqlExec(
    `UPDATE eval_runs
     SET status='${sqlEscape(runStatus)}',
         completed_at=${completedAt},
         pass_count=${passCount},
         fail_count=${failCount},
         skipped_count=${skippedCount}
     WHERE id='${sqlEscape(runId)}'`,
  );

  console.log('[eval-run] summary');
  console.log(`- runId: ${runId}`);
  console.log(`- pass: ${passCount}`);
  console.log(`- fail: ${failCount}`);
  console.log(`- skipped: ${skippedCount}`);
  console.log(`- executed: ${executedCount}`);
  console.log(`- status: ${runStatus}`);
  if (executedCount === 0) {
    console.log('- reason: no eval cases were executed (all skipped or suite empty)');
  }

  if (runStatus === 'failed') {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[eval-run] fatal:', error);
  process.exit(1);
});
