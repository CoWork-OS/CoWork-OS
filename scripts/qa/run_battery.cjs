/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const os = require('os');

const { execFileSync } = require('child_process');

const HOOKS_ORIGIN = process.env.COWORK_HOOKS_ORIGIN || 'http://127.0.0.1:9877';
const HOOKS_TOKEN = process.env.COWORK_HOOKS_TOKEN || 'qa-token';
const DB_PATH =
  process.env.COWORK_DB_PATH ||
  path.join(os.homedir(), 'Library', 'Application Support', 'cowork-os', 'cowork-os.db');
const SQLITE_BUSY_TIMEOUT_MS = Number(process.env.COWORK_SQLITE_BUSY_TIMEOUT_MS) || 15000;

const QA_WORKSPACE_ID = process.env.COWORK_QA_WORKSPACE_ID || 'f0e94e20-1c54-4d8b-93fe-700c77ad3258';
const REPO_WORKSPACE_ID = process.env.COWORK_REPO_WORKSPACE_ID || '07d63869-c23a-4418-8b25-b0ced9c76b12';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postJson(pathname, body) {
  const res = await fetch(`${HOOKS_ORIGIN}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${HOOKS_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

function openDb() {
  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`DB not found at ${DB_PATH}`);
  }
  return { path: DB_PATH };
}

function sqlEscape(value) {
  return String(value).replace(/'/g, "''");
}

function sqlJson(db, query) {
  const out = execFileSync(
    'sqlite3',
    ['-cmd', `.timeout ${SQLITE_BUSY_TIMEOUT_MS}`, '-json', db.path, query],
    { encoding: 'utf8' },
  ).trim();
  if (!out) return [];
  return JSON.parse(out);
}

function sqlFirst(db, query) {
  const rows = sqlJson(db, query);
  return rows.length > 0 ? rows[0] : null;
}

function getTask(db, taskId) {
  const id = sqlEscape(taskId);
  return sqlFirst(
    db,
    `select id,title,status,error,workspace_id,created_at,updated_at,completed_at from tasks where id='${id}'`,
  );
}

function getWorkspace(db, workspaceId) {
  const id = sqlEscape(workspaceId);
  return sqlFirst(db, `select id,name,path from workspaces where id='${id}'`);
}

function listPendingApprovals(db, taskId) {
  const id = sqlEscape(taskId);
  return sqlJson(
    db,
    `select id,type,description,status,requested_at from approvals where task_id='${id}' and status='pending' order by requested_at asc`,
  );
}

function getLatestEvent(db, taskId) {
  const id = sqlEscape(taskId);
  return sqlFirst(
    db,
    `select id,timestamp,type,payload from task_events where task_id='${id}' order by timestamp desc limit 1`,
  );
}

function getLatestEventOfTypeSince(db, taskId, type, sinceTs) {
  const id = sqlEscape(taskId);
  const t = sqlEscape(type);
  const since = Number(sinceTs) || 0;
  return sqlFirst(
    db,
    `select id,timestamp,type,payload from task_events where task_id='${id}' and type='${t}' and timestamp>=${since} order by timestamp desc limit 1`,
  );
}

async function waitForTerminalStatus(db, taskId, opts) {
  const timeoutMs = opts?.timeoutMs ?? 4 * 60 * 1000;
  const pollMs = opts?.pollMs ?? 1000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const task = getTask(db, taskId);
    if (!task) {
      return { ok: false, reason: 'task_not_found' };
    }

    // Auto-approve any pending approvals for this task.
    const approvals = listPendingApprovals(db, taskId);
    for (const approval of approvals) {
      console.log(`[battery] approving ${approval.id} (${approval.type}) for task ${taskId}`);
      const resp = await postJson('/hooks/approval/respond', { approvalId: approval.id, approved: true });
      if (resp.status >= 400) {
        console.log(`[battery] approval respond failed:`, resp.status, resp.json);
      }
    }

    if (['completed', 'failed', 'cancelled', 'paused'].includes(task.status)) {
      return { ok: true, task };
    }

    await sleep(pollMs);
  }

  return { ok: false, reason: 'timeout' };
}

function ensureNonEmptyFile(absPath) {
  if (!fs.existsSync(absPath)) return { ok: false, error: 'missing' };
  const st = fs.statSync(absPath);
  if (!st.isFile()) return { ok: false, error: 'not_file' };
  if (st.size <= 0) return { ok: false, error: 'empty' };
  return { ok: true, size: st.size };
}

function readTextFile(absPath) {
  return fs.readFileSync(absPath, 'utf8');
}

function verifySpreadsheetFormula(absPath) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  return wb.xlsx.readFile(absPath).then(() => {
    const ws = wb.getWorksheet(1);
    const c2 = ws.getCell('C2').value;
    // ExcelJS formulas are objects like { formula: 'A2+B2', result?: any }.
    if (!c2 || typeof c2 !== 'object' || !('formula' in c2)) {
      return { ok: false, cell: c2 };
    }
    if (c2.formula !== 'A2+B2') {
      return { ok: false, cell: c2 };
    }
    return { ok: true };
  });
}

async function main() {
  const runId = new Date().toISOString().replace(/[:.]/g, '-');

  const scenarios = [
    {
      name: `qa-battery-${runId}-hello`,
      workspaceId: QA_WORKSPACE_ID,
      outRel: `battery_${runId}_hello.txt`,
      message: `Create a text file named battery_${runId}_hello.txt in the current workspace containing exactly: hello from battery ${runId}`,
      verify: (abs) => {
        const ok = ensureNonEmptyFile(abs);
        if (!ok.ok) return ok;
        const content = readTextFile(abs).trim();
        return content === `hello from battery ${runId}` ? { ok: true } : { ok: false, error: 'content_mismatch', content };
      },
    },
    {
      name: `qa-battery-${runId}-browser`,
      workspaceId: QA_WORKSPACE_ID,
      outRel: `battery_${runId}_example_title.txt`,
      message: `Use the browser tool to open https://example.com and write ONLY the page title into battery_${runId}_example_title.txt.`,
      verify: (abs) => {
        const ok = ensureNonEmptyFile(abs);
        if (!ok.ok) return ok;
        const content = readTextFile(abs).trim();
        return /example domain/i.test(content) ? { ok: true } : { ok: false, error: 'unexpected_title', content };
      },
    },
    {
      name: `qa-battery-${runId}-web-search`,
      workspaceId: QA_WORKSPACE_ID,
      outRel: `battery_${runId}_ts57_web_search.md`,
      message: `Use web_search for: \"TypeScript 5.7 new features\". Write a short 5-bullet summary to battery_${runId}_ts57_web_search.md.`,
      verify: (abs) => ensureNonEmptyFile(abs),
    },
    {
      name: `qa-battery-${runId}-spreadsheet`,
      workspaceId: QA_WORKSPACE_ID,
      outRel: `battery_${runId}_formula.xlsx`,
      message:
        `Create an xlsx named battery_${runId}_formula.xlsx in the current workspace.\n` +
        `Sheet1:\n` +
        `A1 = \"A\", B1 = \"B\", C1 = \"Sum\"\n` +
        `A2 = 2, B2 = 3\n` +
        `C2 must be a real Excel formula: =A2+B2 (not a plain string).\n` +
        `Save the file.`,
      verify: async (abs) => {
        const ok = ensureNonEmptyFile(abs);
        if (!ok.ok) return ok;
        return verifySpreadsheetFormula(abs);
      },
    },
    {
      name: `qa-battery-${runId}-pdf`,
      workspaceId: QA_WORKSPACE_ID,
      outRel: `battery_${runId}_report.pdf`,
      message:
        `Create a PDF named battery_${runId}_report.pdf with:\n` +
        `- Title: QA Battery Report\n` +
        `- A paragraph containing this run id: ${runId}\n` +
        `Keep it to 1 page.`,
      verify: (abs) => ensureNonEmptyFile(abs),
    },
    {
      name: `qa-battery-${runId}-pptx`,
      workspaceId: QA_WORKSPACE_ID,
      outRel: `battery_${runId}_deck.pptx`,
      message:
        `Create a PPTX named battery_${runId}_deck.pptx with 2 slides:\n` +
        `1) Title slide: \"QA Battery\" and run id ${runId}\n` +
        `2) Bullets slide with 3 bullets: One, Two, Three`,
      verify: (abs) => ensureNonEmptyFile(abs),
    },
    {
      name: `qa-battery-${runId}-run-command`,
      workspaceId: REPO_WORKSPACE_ID,
      outRel: `.tmp/qa-workspace/battery_${runId}_node_version.txt`,
      message:
        `Run the shell command: node -v\n` +
        `Write the output into .tmp/qa-workspace/battery_${runId}_node_version.txt and then stop.`,
      verify: (abs) => {
        const ok = ensureNonEmptyFile(abs);
        if (!ok.ok) return ok;
        const content = readTextFile(abs).trim();
        return /^v\d+\./.test(content) ? { ok: true } : { ok: false, error: 'unexpected_node_version', content };
      },
    },
    {
      name: `qa-battery-${runId}-followup`,
      workspaceId: QA_WORKSPACE_ID,
      outRel: `battery_${runId}_followup.txt`,
      message: `Create battery_${runId}_followup.txt with exactly one line: line1`,
      followUp: `Append a second line \"line2\" to battery_${runId}_followup.txt`,
      verify: (abs) => {
        const ok = ensureNonEmptyFile(abs);
        if (!ok.ok) return ok;
        const content = readTextFile(abs).trim().split(/\r?\n/);
        if (content.length < 2) return { ok: false, error: 'missing_line2', content: content.join('\\n') };
        return content[0].trim() === 'line1' && content[1].trim() === 'line2'
          ? { ok: true }
          : { ok: false, error: 'content_mismatch', content: content.join('\\n') };
      },
    },
  ];

  console.log(`[battery] hooks: ${HOOKS_ORIGIN}  db: ${DB_PATH}`);
  console.log(`[battery] run id: ${runId}`);

  const db = openDb();
  const results = [];

  for (const scenario of scenarios) {
    console.log(`\n[battery] triggering: ${scenario.name}`);

    const trigger = await postJson('/hooks/agent', {
      message: scenario.message,
      name: scenario.name,
      wakeMode: 'now',
      workspaceId: scenario.workspaceId,
      deliver: false,
    });

    if (trigger.status >= 400 || !trigger.json || !trigger.json.taskId) {
      results.push({
        name: scenario.name,
        ok: false,
        phase: 'trigger',
        httpStatus: trigger.status,
        response: trigger.json,
      });
      console.log(`[battery] trigger failed:`, trigger.status, trigger.json);
      continue;
    }

    const taskId = trigger.json.taskId;
    console.log(`[battery] task id: ${taskId}`);

    const wait = await waitForTerminalStatus(db, taskId, { timeoutMs: 6 * 60 * 1000 });
    if (!wait.ok) {
      const latest = getLatestEvent(db, taskId);
      results.push({ name: scenario.name, ok: false, phase: 'wait', taskId, reason: wait.reason, latest });
      console.log(`[battery] wait failed:`, wait.reason);
      continue;
    }

    const task = wait.task;
    const workspace = getWorkspace(db, scenario.workspaceId);
    const workspacePath = workspace && typeof workspace.path === 'string' ? workspace.path : process.cwd();
    const outAbs = path.isAbsolute(scenario.outRel) ? scenario.outRel : path.join(workspacePath, scenario.outRel);

    let verifyResult;
    if (typeof scenario.verify === 'function') {
      verifyResult = await scenario.verify(outAbs);
    } else {
      verifyResult = { ok: true };
    }

    // Follow-up flow (send a second message and wait for follow_up_completed)
    if (scenario.followUp) {
      const sentAt = Date.now();
      const msgResp = await postJson('/hooks/task/message', { taskId, message: scenario.followUp });
      if (msgResp.status >= 400) {
        results.push({
          name: scenario.name,
          ok: false,
          phase: 'followup_send',
          taskId,
          httpStatus: msgResp.status,
          response: msgResp.json,
        });
        console.log(`[battery] follow-up send failed:`, msgResp.status, msgResp.json);
        continue;
      }

      // Wait up to 4 minutes for the follow-up completion marker.
      let followUpOk = false;
      for (let i = 0; i < 240; i++) {
        const evt = getLatestEventOfTypeSince(db, taskId, 'follow_up_completed', sentAt - 50);
        if (evt) {
          followUpOk = true;
          break;
        }
        await sleep(1000);
      }
      if (!followUpOk) {
        results.push({
          name: scenario.name,
          ok: false,
          phase: 'followup_wait',
          taskId,
          reason: 'timeout',
          latest: getLatestEvent(db, taskId),
        });
        console.log(`[battery] follow-up wait failed: timeout`);
        continue;
      }

      // Re-verify after follow-up.
      verifyResult = await scenario.verify(outAbs);
    }

    results.push({
      name: scenario.name,
      ok: task.status === 'completed' && !task.error && verifyResult && verifyResult.ok === true,
      taskId,
      status: task.status,
      error: task.error,
      output: scenario.outRel,
      verify: verifyResult,
    });

    console.log(`[battery] done: status=${task.status} verify=${verifyResult && verifyResult.ok ? 'ok' : 'fail'}`);
  }

  console.log('\n[battery] summary');
  for (const r of results) {
    const label = r.ok ? 'PASS' : 'FAIL';
    console.log(`- ${label} ${r.name}${r.taskId ? ` (${r.taskId})` : ''}`);
    if (!r.ok) {
      if (r.phase) console.log(`  phase: ${r.phase}`);
      if (r.status) console.log(`  status: ${r.status}`);
      if (r.error) console.log(`  error: ${r.error}`);
      if (r.reason) console.log(`  reason: ${r.reason}`);
      if (r.httpStatus) console.log(`  httpStatus: ${r.httpStatus}`);
      if (r.response) console.log(`  response: ${JSON.stringify(r.response).slice(0, 500)}`);
      if (r.verify && r.verify.error) console.log(`  verify: ${JSON.stringify(r.verify).slice(0, 500)}`);
      if (r.latest) console.log(`  latestEvent: ${r.latest.type} @ ${r.latest.timestamp}`);
    }
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[battery] fatal:', err);
  process.exit(1);
});
