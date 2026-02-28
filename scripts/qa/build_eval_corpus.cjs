/* eslint-disable no-console */
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DB_PATH =
  process.env.COWORK_DB_PATH ||
  path.join(os.homedir(), 'Library', 'Application Support', 'cowork-os', 'cowork-os.db');
const SQLITE_BUSY_TIMEOUT_MS = Number(process.env.COWORK_SQLITE_BUSY_TIMEOUT_MS) || 15000;

function parseArgs(argv) {
  const args = {
    windowDays: 30,
    limit: 200,
    suiteName: 'reliability-regressions',
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === '--window-days' || arg === '--days') && argv[i + 1]) {
      args.windowDays = Number(argv[++i]) || args.windowDays;
      continue;
    }
    if (arg === '--limit' && argv[i + 1]) {
      args.limit = Number(argv[++i]) || args.limit;
      continue;
    }
    if (arg === '--suite' && argv[i + 1]) {
      args.suiteName = String(argv[++i] || args.suiteName);
      continue;
    }
  }

  args.windowDays = Math.min(Math.max(Math.round(args.windowDays), 1), 365);
  args.limit = Math.min(Math.max(Math.round(args.limit), 1), 1000);
  return args;
}

function sqlEscape(value) {
  return String(value).replace(/'/g, "''");
}

function ensureSqliteCli() {
  try {
    execFileSync('sqlite3', ['--version'], { stdio: 'ignore' });
  } catch {
    console.error('[eval-corpus] sqlite3 CLI not found. Install sqlite3 to run this script.');
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

function nowMs() {
  return Date.now();
}

function randomUuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  const { randomUUID } = require('crypto');
  return randomUUID();
}

function sanitizeText(raw) {
  if (!raw) return '';
  const patterns = [
    [/sk-[A-Za-z0-9_-]{12,}/g, '[REDACTED_API_KEY]'],
    [/ghp_[A-Za-z0-9]{20,}/g, '[REDACTED_GITHUB_TOKEN]'],
    [/xox[baprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED_SLACK_TOKEN]'],
    [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]'],
    [/\b\d{3}[-.\s]?\d{2,3}[-.\s]?\d{4}\b/g, '[REDACTED_PHONE]'],
  ];

  let output = String(raw);
  for (const [pattern, replacement] of patterns) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

function normalizeTerminalStatus(taskRow) {
  const terminal = String(taskRow.terminal_status || '').trim();
  if (terminal === 'ok' || terminal === 'partial_success' || terminal === 'failed') {
    return terminal;
  }
  if (taskRow.status === 'completed') return 'ok';
  return 'failed';
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

    CREATE INDEX IF NOT EXISTS idx_eval_cases_source_task ON eval_cases(source_task_id);
  `);
}

function hasTasksTable() {
  const rows = sqlJson("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tasks' LIMIT 1");
  return rows.length > 0;
}

function getOrCreateSuite(suiteName) {
  const safeSuiteName = sqlEscape(suiteName);
  const existing = sqlJson(
    `SELECT id, case_ids FROM eval_suites WHERE name='${safeSuiteName}' LIMIT 1`,
  )[0];

  if (existing && existing.id) {
    let caseIds = [];
    try {
      caseIds = JSON.parse(existing.case_ids || '[]');
    } catch {
      caseIds = [];
    }
    return {
      id: existing.id,
      caseIds: Array.isArray(caseIds) ? caseIds : [],
    };
  }

  const id = randomUuid();
  const now = nowMs();
  sqlExec(
    `INSERT INTO eval_suites (id, name, description, case_ids, created_at, updated_at)
     VALUES ('${sqlEscape(id)}', '${safeSuiteName}', 'Auto-generated regression corpus from failed/partial tasks', '[]', ${now}, ${now})`,
  );

  return { id, caseIds: [] };
}

function main() {
  const args = parseArgs(process.argv);
  ensureSqliteCli();

  ensureEvalTables();

  if (!hasTasksTable()) {
    console.log(`[eval-corpus] db: ${DB_PATH}`);
    console.log('[eval-corpus] tasks table not found. Nothing to extract.');
    return;
  }

  const start = nowMs() - args.windowDays * 24 * 60 * 60 * 1000;
  const candidates = sqlJson(`
    SELECT id, title, prompt, raw_prompt, user_prompt, status, workspace_id, terminal_status, failure_class
    FROM tasks
    WHERE created_at >= ${start}
      AND (
        status = 'failed'
        OR terminal_status = 'partial_success'
        OR (status = 'completed' AND COALESCE(failure_class, '') <> '')
      )
    ORDER BY created_at DESC
    LIMIT ${args.limit}
  `);

  const existingRows = sqlJson(
    "SELECT id, source_task_id FROM eval_cases WHERE source_task_id IS NOT NULL",
  );
  const existingByTask = new Map(existingRows.map((row) => [row.source_task_id, row.id]));

  const suite = getOrCreateSuite(args.suiteName);
  const suiteCaseIds = new Set(Array.isArray(suite.caseIds) ? suite.caseIds : []);

  let created = 0;
  let skipped = 0;
  for (const task of candidates) {
    const existingCaseId = existingByTask.get(task.id);
    if (existingCaseId) {
      suiteCaseIds.add(existingCaseId);
      skipped += 1;
      continue;
    }

    const caseId = randomUuid();
    const now = nowMs();
    const sourcePrompt = String(task.raw_prompt || task.user_prompt || task.prompt || '');
    const sanitizedPrompt = sanitizeText(sourcePrompt);
    const terminalStatus = normalizeTerminalStatus(task);
    const assertions = JSON.stringify({ expectedTerminalStatus: 'ok' });
    const metadata = JSON.stringify({
      extractedFromTaskStatus: task.status,
      extractedFromTerminalStatus: terminalStatus,
      extractedFailureClass: task.failure_class || null,
      extractedAt: new Date(now).toISOString(),
    });

    sqlExec(
      `INSERT INTO eval_cases (
         id, name, workspace_id, source_task_id, prompt, sanitized_prompt, assertions, metadata, created_at, updated_at
       ) VALUES (
         '${sqlEscape(caseId)}',
         '${sqlEscape(`${String(task.title || 'task').slice(0, 100)} [${String(task.id).slice(0, 8)}]`)}',
         ${task.workspace_id ? `'${sqlEscape(task.workspace_id)}'` : 'NULL'},
         '${sqlEscape(task.id)}',
         '${sqlEscape(sourcePrompt)}',
         '${sqlEscape(sanitizedPrompt)}',
         '${sqlEscape(assertions)}',
         '${sqlEscape(metadata)}',
         ${now},
         ${now}
       )`,
    );

    sqlExec(
      `UPDATE tasks SET eval_case_id='${sqlEscape(caseId)}', updated_at=${now} WHERE id='${sqlEscape(task.id)}'`,
    );

    suiteCaseIds.add(caseId);
    created += 1;
  }

  sqlExec(
    `UPDATE eval_suites
     SET case_ids='${sqlEscape(JSON.stringify(Array.from(suiteCaseIds)))}', updated_at=${nowMs()}
     WHERE id='${sqlEscape(suite.id)}'`,
  );

  console.log(`[eval-corpus] db: ${DB_PATH}`);
  console.log(`[eval-corpus] suite: ${args.suiteName} (${suite.id})`);
  console.log(`[eval-corpus] scanned tasks: ${candidates.length}`);
  console.log(`[eval-corpus] created: ${created}`);
  console.log(`[eval-corpus] skipped(existing): ${skipped}`);
  console.log(`[eval-corpus] suite case count: ${suiteCaseIds.size}`);
}

main();
