/* eslint-disable no-console */
/**
 * Human Prompt QA Battery
 *
 * Runs a set of "non-technical user" prompts against the local Cowork OS hooks server,
 * then inspects the SQLite DB and cron store to verify outcomes.
 *
 * Usage:
 *   node scripts/qa/run_human_battery.cjs
 *
 * Env overrides:
 *   COWORK_HOOKS_ORIGIN, COWORK_HOOKS_TOKEN, COWORK_DB_PATH, COWORK_CRON_STORE_PATH
 *   COWORK_QA_WORKSPACE_ID
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const HOOKS_ORIGIN = process.env.COWORK_HOOKS_ORIGIN || "http://127.0.0.1:9877";
const HOOKS_TOKEN = process.env.COWORK_HOOKS_TOKEN || "qa-token";
const DB_PATH =
  process.env.COWORK_DB_PATH ||
  path.join(os.homedir(), "Library", "Application Support", "cowork-os", "cowork-os.db");
const CRON_STORE_PATH =
  process.env.COWORK_CRON_STORE_PATH ||
  path.join(os.homedir(), "Library", "Application Support", "cowork-os", "cron", "jobs.json");

const SQLITE_BUSY_TIMEOUT_MS = Number(process.env.COWORK_SQLITE_BUSY_TIMEOUT_MS) || 15000;

const QA_WORKSPACE_ID =
  process.env.COWORK_QA_WORKSPACE_ID || "f0e94e20-1c54-4d8b-93fe-700c77ad3258";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sqlEscape(value) {
  return String(value).replace(/'/g, "''");
}

function sqlJson(dbPath, query) {
  const out = execFileSync(
    "sqlite3",
    ["-cmd", `.timeout ${SQLITE_BUSY_TIMEOUT_MS}`, "-json", dbPath, query],
    { encoding: "utf8" },
  ).trim();
  if (!out) return [];
  return JSON.parse(out);
}

function sqlFirst(dbPath, query) {
  const rows = sqlJson(dbPath, query);
  return rows.length > 0 ? rows[0] : null;
}

function parseEventPayload(payload) {
  if (!payload) return null;
  if (typeof payload === "object") return payload;
  if (typeof payload !== "string") return null;
  try {
    return JSON.parse(payload);
  } catch {
    return { raw: payload };
  }
}

async function postJson(pathname, body) {
  const res = await fetch(`${HOOKS_ORIGIN}${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
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

function getTask(taskId) {
  const id = sqlEscape(taskId);
  return sqlFirst(
    DB_PATH,
    `select id,title,status,error,workspace_id,created_at,updated_at,completed_at from tasks where id='${id}'`,
  );
}

function listPendingApprovals(taskId) {
  const id = sqlEscape(taskId);
  return sqlJson(
    DB_PATH,
    `select id,type,description,status,requested_at from approvals where task_id='${id}' and status='pending' order by requested_at asc`,
  );
}

function getLatestEvent(taskId) {
  const id = sqlEscape(taskId);
  return sqlFirst(
    DB_PATH,
    `select id,timestamp,type,payload from task_events where task_id='${id}' order by timestamp desc limit 1`,
  );
}

function getLatestAssistantMessage(taskId) {
  const id = sqlEscape(taskId);
  return sqlFirst(
    DB_PATH,
    `select id,timestamp,type,payload from task_events where task_id='${id}' and type='assistant_message' order by timestamp desc limit 1`,
  );
}

function listToolCalls(taskId, limit = 200) {
  const id = sqlEscape(taskId);
  const lim = Number(limit) || 200;
  return sqlJson(
    DB_PATH,
    `select timestamp,type,payload from task_events where task_id='${id}' and type='tool_call' order by timestamp asc limit ${lim}`,
  );
}

function listToolErrors(taskId, limit = 50) {
  const id = sqlEscape(taskId);
  const lim = Number(limit) || 50;
  return sqlJson(
    DB_PATH,
    `select timestamp,type,payload from task_events where task_id='${id}' and type='tool_error' order by timestamp desc limit ${lim}`,
  );
}

function listMemoriesByTask(taskId, limit = 20) {
  const id = sqlEscape(taskId);
  const lim = Number(limit) || 20;
  return sqlJson(
    DB_PATH,
    `select id,workspace_id,task_id,type,content,created_at from memories where task_id='${id}' order by created_at desc limit ${lim}`,
  );
}

function loadJsonFileWithRetry(absPath, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    try {
      if (!fs.existsSync(absPath)) return null;
      const raw = fs.readFileSync(absPath, "utf8");
      return JSON.parse(raw);
    } catch (e) {
      // Potentially mid-write; small delay then retry.
      if (i === attempts - 1) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  return null;
}

function loadCronStore() {
  const parsed = loadJsonFileWithRetry(CRON_STORE_PATH, 8);
  const jobs = parsed && Array.isArray(parsed.jobs) ? parsed.jobs : [];
  return { version: 1, jobs };
}

function diffJobs(before, after) {
  const beforeIds = new Set((before.jobs || []).map((j) => j && j.id).filter(Boolean));
  const added = (after.jobs || []).filter((j) => j && j.id && !beforeIds.has(j.id));
  return { added };
}

async function waitForTerminalStatus(taskId, opts) {
  const timeoutMs = opts?.timeoutMs ?? 4 * 60 * 1000;
  const pollMs = opts?.pollMs ?? 1000;
  const startedAt = Date.now();

  let lastStatus = null;
  let lastEventId = null;

  while (Date.now() - startedAt < timeoutMs) {
    const task = getTask(taskId);
    if (!task) return { ok: false, reason: "task_not_found" };

    if (task.status !== lastStatus) {
      console.log(
        `[human-battery] task ${taskId} status: ${lastStatus || "(none)"} -> ${task.status}`,
      );
      lastStatus = task.status;
    }

    const latest = getLatestEvent(taskId);
    if (latest && latest.id !== lastEventId) {
      console.log(`[human-battery] latest event: ${latest.type}`);
      lastEventId = latest.id;
    }

    // Auto-approve pending approvals.
    const approvals = listPendingApprovals(taskId);
    for (const approval of approvals) {
      console.log(`[human-battery] approving ${approval.id} (${approval.type}) for task ${taskId}`);
      const resp = await postJson("/hooks/approval/respond", {
        approvalId: approval.id,
        approved: true,
      });
      if (resp.status >= 400) {
        console.log(`[human-battery] approval respond failed:`, resp.status, resp.json);
      }
    }

    if (["completed", "failed", "cancelled", "paused"].includes(task.status)) {
      return { ok: true, task };
    }

    await sleep(pollMs);
  }

  return { ok: false, reason: "timeout" };
}

async function waitForMemoryMatch(taskId, needleRegex, opts) {
  const timeoutMs = opts?.timeoutMs ?? 15_000;
  const pollMs = opts?.pollMs ?? 500;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const memories = listMemoriesByTask(taskId, 50);
    for (const m of memories) {
      const content = typeof m.content === "string" ? m.content : "";
      if (needleRegex.test(content)) {
        return { ok: true, memoryId: m.id };
      }
    }
    await sleep(pollMs);
  }

  return { ok: false, error: "timeout" };
}

function extractAssistantText(evtRow) {
  if (!evtRow) return "";
  const payload = parseEventPayload(evtRow.payload);
  if (!payload) return "";
  const msg = payload.message || payload.content;
  return typeof msg === "string" ? msg : "";
}

function extractToolNames(toolCallRows) {
  const names = [];
  for (const row of toolCallRows || []) {
    const payload = parseEventPayload(row.payload);
    const tool = payload && (payload.tool || payload.name);
    if (typeof tool === "string") names.push(tool);
  }
  return names;
}

function ensureHasAssistantMessage(taskId) {
  const latest = getLatestAssistantMessage(taskId);
  const text = extractAssistantText(latest);
  if (!text || !text.trim()) {
    return { ok: false, error: "missing_assistant_message" };
  }
  return { ok: true, text };
}

function ensureToolWasCalled(taskId, toolName) {
  const calls = listToolCalls(taskId, 500);
  const names = extractToolNames(calls);
  const ok = names.includes(toolName);
  return ok ? { ok: true, names } : { ok: false, error: "tool_not_called", toolName, names };
}

function verifyReminderScheduled(beforeCron, afterCron, matcher) {
  const { added } = diffJobs(beforeCron, afterCron);
  const matching = added.filter((j) => matcher(j));
  if (matching.length === 0) {
    return { ok: false, error: "no_matching_job_added", addedCount: added.length };
  }
  if (matching.length > 1) {
    return { ok: false, error: "multiple_matching_jobs_added", matchingCount: matching.length };
  }
  const job = matching[0];

  // Heuristic: tomorrow reminders should generally be one-shot ("at") with deleteAfterRun=true.
  const scheduleKind = job && job.schedule && job.schedule.kind;
  const isOneShot = scheduleKind === "at";
  const deleteAfterRun = job && job.deleteAfterRun === true;

  return {
    ok: true,
    jobId: job.id,
    scheduleKind,
    deleteAfterRun,
    warnings: isOneShot && deleteAfterRun ? [] : ["unexpected_schedule_shape"],
  };
}

async function main() {
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  console.log(`[human-battery] hooks: ${HOOKS_ORIGIN}  db: ${DB_PATH}  cron: ${CRON_STORE_PATH}`);
  console.log(`[human-battery] run id: ${runId}`);

  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`DB not found at ${DB_PATH}`);
  }

  const scenarios = [
    {
      name: `human-${runId}-hi`,
      workspaceId: QA_WORKSPACE_ID,
      message: `Hi`,
      expect: { terminal: ["completed"] },
      verify: (ctx) => ensureHasAssistantMessage(ctx.taskId),
    },
    {
      name: `human-${runId}-status`,
      workspaceId: QA_WORKSPACE_ID,
      message: `What's my status?`,
      expect: { terminal: ["completed"] },
      verify: (ctx) => ensureHasAssistantMessage(ctx.taskId),
    },
    {
      name: `human-${runId}-reminder-meds`,
      workspaceId: QA_WORKSPACE_ID,
      message: `Remind me to take meds tomorrow at 8am`,
      expect: { terminal: ["completed", "paused"] },
      before: () => ({ cron: loadCronStore() }),
      verify: async (ctx) => {
        const assistant = ensureHasAssistantMessage(ctx.taskId);
        if (!assistant.ok) return assistant;

        const toolCheck = ensureToolWasCalled(ctx.taskId, "schedule_task");
        if (!toolCheck.ok) return toolCheck;

        const afterCron = loadCronStore();
        const cronCheck = verifyReminderScheduled(ctx.before.cron, afterCron, (job) => {
          const prompt = typeof job.taskPrompt === "string" ? job.taskPrompt.toLowerCase() : "";
          const name = typeof job.name === "string" ? job.name.toLowerCase() : "";
          return prompt.includes("take meds") || name.includes("med");
        });
        if (!cronCheck.ok) return cronCheck;

        return { ok: true, assistantText: assistant.text, cron: cronCheck };
      },
    },
    {
      name: `human-${runId}-remember-pref`,
      workspaceId: QA_WORKSPACE_ID,
      message: `Remember I prefer dark mode`,
      expect: { terminal: ["completed"] },
      verify: async (ctx) => {
        const assistant = ensureHasAssistantMessage(ctx.taskId);
        if (!assistant.ok) return assistant;
        const mem = await waitForMemoryMatch(ctx.taskId, /\bdark\s+mode\b/i, { timeoutMs: 20_000 });
        if (!mem.ok) return { ok: false, error: "memory_not_captured" };
        return { ok: true, assistantText: assistant.text, memoryId: mem.memoryId };
      },
    },
    {
      name: `human-${runId}-yesterday`,
      workspaceId: QA_WORKSPACE_ID,
      message: `What did we talk about yesterday?`,
      expect: { terminal: ["completed"] },
      verify: (ctx) => {
        const assistant = ensureHasAssistantMessage(ctx.taskId);
        if (!assistant.ok) return assistant;
        const toolCheck = ensureToolWasCalled(ctx.taskId, "task_history");
        if (!toolCheck.ok) return toolCheck;
        return { ok: true, assistantText: assistant.text };
      },
    },
    {
      name: `human-${runId}-unread-gmail`,
      workspaceId: QA_WORKSPACE_ID,
      message: `Summarize any unread emails from my Gmail`,
      // If Gmail isn't configured, a helpful completion is fine; failures are not.
      expect: { terminal: ["completed", "paused"] },
      verify: (ctx) => {
        const assistant = ensureHasAssistantMessage(ctx.taskId);
        if (!assistant.ok) return assistant;
        // Allow either a summary (tool available) or a request to connect integration.
        const lower = assistant.text.toLowerCase();
        const looksHelpful =
          lower.includes("gmail") ||
          lower.includes("google") ||
          lower.includes("connect") ||
          lower.includes("enable") ||
          lower.includes("integration") ||
          lower.includes("unread");
        return looksHelpful
          ? { ok: true, assistantText: assistant.text }
          : { ok: false, error: "unhelpful_response" };
      },
    },
    {
      name: `human-${runId}-watch-tonight`,
      workspaceId: QA_WORKSPACE_ID,
      message: `Find me something good to watch tonight`,
      expect: { terminal: ["completed"] },
      verify: (ctx) => {
        const assistant = ensureHasAssistantMessage(ctx.taskId);
        if (!assistant.ok) return assistant;
        const toolCheck = ensureToolWasCalled(ctx.taskId, "web_search");
        if (!toolCheck.ok) return toolCheck;
        return { ok: true, assistantText: assistant.text };
      },
    },
    {
      name: `human-${runId}-board-meeting`,
      workspaceId: QA_WORKSPACE_ID,
      message: `Schedule a board meeting, 2 hours, all 5 members, sometime in the next 2 weeks`,
      expect: { terminal: ["completed", "paused"] },
      verify: (ctx) => {
        const assistant = ensureHasAssistantMessage(ctx.taskId);
        if (!assistant.ok) return assistant;
        // We accept either:
        // - scheduling via calendar tool, or
        // - requesting missing details / asking to connect calendar integration.
        const lower = assistant.text.toLowerCase();
        const looksHelpful =
          lower.includes("calendar") ||
          lower.includes("invite") ||
          lower.includes("participants") ||
          lower.includes("availability") ||
          lower.includes("connect") ||
          lower.includes("enable") ||
          lower.includes("integration") ||
          lower.includes("time zone") ||
          lower.includes("timezone");
        return looksHelpful
          ? { ok: true, assistantText: assistant.text }
          : { ok: false, error: "unhelpful_response" };
      },
    },
  ];

  const results = [];

  for (const scenario of scenarios) {
    console.log(`\n[human-battery] triggering: ${scenario.name}`);

    const before = typeof scenario.before === "function" ? scenario.before() : {};

    const trigger = await postJson("/hooks/agent", {
      message: scenario.message,
      name: scenario.name,
      wakeMode: "now",
      workspaceId: scenario.workspaceId,
      deliver: false,
    });

    if (trigger.status >= 400 || !trigger.json || !trigger.json.taskId) {
      results.push({
        name: scenario.name,
        ok: false,
        phase: "trigger",
        httpStatus: trigger.status,
        response: trigger.json,
      });
      console.log(`[human-battery] trigger failed:`, trigger.status, trigger.json);
      continue;
    }

    const taskId = trigger.json.taskId;
    console.log(`[human-battery] task id: ${taskId}`);

    const wait = await waitForTerminalStatus(taskId, { timeoutMs: 6 * 60 * 1000 });
    if (!wait.ok) {
      results.push({
        name: scenario.name,
        ok: false,
        phase: "wait",
        taskId,
        reason: wait.reason,
        latest: getLatestEvent(taskId),
      });
      console.log(`[human-battery] wait failed:`, wait.reason);
      continue;
    }

    const task = wait.task;
    const allowedTerminal =
      scenario.expect && Array.isArray(scenario.expect.terminal)
        ? scenario.expect.terminal
        : ["completed"];
    if (!allowedTerminal.includes(task.status)) {
      results.push({
        name: scenario.name,
        ok: false,
        phase: "terminal_status",
        taskId,
        status: task.status,
        error: task.error,
      });
      console.log(`[human-battery] unexpected terminal status: ${task.status}`);
      continue;
    }

    let verifyResult = { ok: true };
    if (typeof scenario.verify === "function") {
      verifyResult = await scenario.verify({ taskId, before });
    }

    const ok = task.status !== "failed" && !task.error && verifyResult && verifyResult.ok === true;

    results.push({
      name: scenario.name,
      ok,
      taskId,
      status: task.status,
      error: task.error,
      verify: verifyResult,
    });

    console.log(
      `[human-battery] done: status=${task.status} verify=${verifyResult && verifyResult.ok ? "ok" : "fail"}`,
    );
  }

  console.log("\n[human-battery] summary");
  for (const r of results) {
    const label = r.ok ? "PASS" : "FAIL";
    console.log(`- ${label} ${r.name}${r.taskId ? ` (${r.taskId})` : ""}`);
    if (!r.ok) {
      if (r.phase) console.log(`  phase: ${r.phase}`);
      if (r.status) console.log(`  status: ${r.status}`);
      if (r.error) console.log(`  error: ${r.error}`);
      if (r.reason) console.log(`  reason: ${r.reason}`);
      if (r.httpStatus) console.log(`  httpStatus: ${r.httpStatus}`);
      if (r.response) console.log(`  response: ${JSON.stringify(r.response).slice(0, 500)}`);
      if (r.verify && r.verify.error)
        console.log(`  verify: ${JSON.stringify(r.verify).slice(0, 800)}`);
      if (r.latest) console.log(`  latestEvent: ${r.latest.type} @ ${r.latest.timestamp}`);

      // Extra diagnostics for failures
      if (r.taskId) {
        const assistant = extractAssistantText(getLatestAssistantMessage(r.taskId));
        if (assistant) console.log(`  lastAssistant: ${assistant.slice(0, 300)}`);
        const toolNames = extractToolNames(listToolCalls(r.taskId, 200));
        if (toolNames.length > 0)
          console.log(
            `  tools: ${toolNames.slice(0, 25).join(", ")}${toolNames.length > 25 ? "…" : ""}`,
          );
        const toolErrors = listToolErrors(r.taskId, 5).map((e) => parseEventPayload(e.payload));
        if (toolErrors.length > 0)
          console.log(`  toolErrors: ${JSON.stringify(toolErrors).slice(0, 800)}`);
      }
    }
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[human-battery] fatal:", err);
  process.exit(1);
});
