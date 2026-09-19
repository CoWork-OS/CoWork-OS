#!/usr/bin/env node
import fs from "fs";
import path from "path";

const repoRoot = process.cwd();
const cliArgs = process.argv.slice(2);
const logArg = cliArgs.find((arg) => !arg.startsWith("--"));
const logPath = logArg ? path.resolve(logArg) : path.join(repoRoot, "logs", "dev-latest.jsonl");
const allowEmpty = cliArgs.includes("--allow-empty") || process.env.COWORK_PERF_ALLOW_EMPTY === "1";
const minSamples = readBudget("COWORK_PERF_MIN_SAMPLES", 1);
const maxAgeMs =
  readOptionalNumberArg("--max-age-ms") ?? readOptionalBudget("COWORK_PERF_LOG_MAX_AGE_MS");

const budget = {
  sidebarReceiveP95Ms: readBudget("COWORK_PERF_SIDEBAR_RECEIVE_P95_MS", 250),
  taskHeaderReadyP95Ms: readBudget("COWORK_PERF_TASK_HEADER_READY_P95_MS", 120),
  timelineDataReceivedP95Ms: readBudget("COWORK_PERF_TIMELINE_DATA_RECEIVED_P95_MS", 900),
  timelineFirstRowsP95Ms: readBudget("COWORK_PERF_TIMELINE_FIRST_ROWS_P95_MS", 1200),
  timelinePageDbP95Ms: readBudget("COWORK_PERF_TIMELINE_PAGE_DB_P95_MS", 150),
  timelinePageSerializedP95Bytes: readBudget(
    "COWORK_PERF_TIMELINE_PAGE_SERIALIZED_P95_BYTES",
    768 * 1024,
  ),
  timelinePageSerializedMaxBytes: readBudget(
    "COWORK_PERF_TIMELINE_PAGE_SERIALIZED_MAX_BYTES",
    1024 * 1024,
  ),
};

function readBudget(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readOptionalBudget(name) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function readOptionalNumberArg(name) {
  const prefix = `${name}=`;
  const raw = cliArgs.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function readNewestLogTimestampMs(filePath) {
  let newest = 0;
  try {
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        const timestampMs = Date.parse(String(row.timestamp ?? ""));
        if (Number.isFinite(timestampMs)) newest = Math.max(newest, timestampMs);
      } catch {
        // Ignore malformed lines; mtime fallback below still protects missing structured timestamps.
      }
    }
  } catch {
    return 0;
  }
  return newest;
}

function enforceFreshLog(filePath) {
  if (!maxAgeMs) return;
  if (!fs.existsSync(filePath)) {
    if (allowEmpty) return;
    console.error(`[perf-budget] log not found: ${filePath}`);
    process.exit(1);
  }
  const freshnessMs = readNewestLogTimestampMs(filePath) || fs.statSync(filePath).mtimeMs;
  const ageMs = Date.now() - freshnessMs;
  if (ageMs <= maxAgeMs) return;
  if (allowEmpty) {
    console.warn(
      `[perf-budget] log is stale (${Math.round(ageMs)}ms old, max ${maxAgeMs}ms); allowing empty/stale log`,
    );
    return;
  }
  console.error(
    `[perf-budget] log is stale: ${filePath} is ${Math.round(ageMs)}ms old, max ${maxAgeMs}ms`,
  );
  process.exit(1);
}

function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? 0;
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) {
    console.warn(`[perf-budget] log not found, skipping: ${filePath}`);
    return [];
  }
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { message: line };
      }
    });
}

function extractTrailingJson(text, prefix) {
  const index = text.indexOf(prefix);
  if (index < 0) return null;
  try {
    return JSON.parse(text.slice(index + prefix.length).trim());
  } catch {
    return null;
  }
}

function pushMetric(bucket, key, value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return;
  const values = bucket.get(key) ?? [];
  values.push(numeric);
  bucket.set(key, values);
}

function addFailure(failures, label, values, limit, mode = "p95") {
  if (values.length === 0) return;
  const actual = mode === "max" ? Math.max(...values) : percentile(values, 0.95);
  if (actual <= limit) return;
  failures.push(`${label}: ${mode}=${actual.toFixed(1)} over budget ${limit}`);
}

function requireSamples(failures, label, values) {
  if (allowEmpty) return;
  if (values.length >= minSamples) return;
  failures.push(`${label}: only ${values.length} sample(s), requires at least ${minSamples}`);
}

enforceFreshLog(logPath);
const rows = readJsonl(logPath);
const marksBySwitch = new Map();
const ipcByChannel = new Map();
const rendererIpcByChannel = new Map();

for (const row of rows) {
  const message = String(row.message ?? row.rawLine ?? "");

  const markMatch = message.match(
    /\[Mark\]\s+([a-zA-Z0-9_.:-]+)\s+at\s+([\d.]+)ms(?:\s+(\{.*\}))?/,
  );
  if (markMatch) {
    let details = {};
    if (markMatch[3]) {
      try {
        details = JSON.parse(markMatch[3]);
      } catch {
        details = {};
      }
    }
    const switchKey =
      typeof details.switchId === "string"
        ? details.switchId
        : typeof details.taskId === "string"
          ? details.taskId
          : "global";
    const marks = marksBySwitch.get(switchKey) ?? {};
    marks[markMatch[1]] = Number(markMatch[2]);
    marksBySwitch.set(switchKey, marks);
  }

  const ipc = extractTrailingJson(message, "[IpcPerf]");
  if (ipc?.channel) {
    const bucket = ipcByChannel.get(ipc.channel) ?? new Map();
    for (const key of ["dbMs", "jsonMs", "serializedBytes", "payloadBytes", "rowCount"]) {
      pushMetric(bucket, key, ipc[key]);
    }
    ipcByChannel.set(ipc.channel, bucket);
  }

  const rendererIpc = extractTrailingJson(message, "[IpcRendererPerf]");
  if (rendererIpc?.channel) {
    const bucket = rendererIpcByChannel.get(rendererIpc.channel) ?? new Map();
    for (const key of ["receiveMs", "jsonMs", "serializedBytes", "rowCount"]) {
      pushMetric(bucket, key, rendererIpc[key]);
    }
    rendererIpcByChannel.set(rendererIpc.channel, bucket);
  }
}

const sidebarReceiveMs = rendererIpcByChannel.get("task:listSidebar")?.get("receiveMs") ?? [];
const switchHeaderMs = [];
const switchTimelineMs = [];
const switchRowsMs = [];
for (const marks of marksBySwitch.values()) {
  const startedAt = marks.task_switch_start;
  if (!Number.isFinite(startedAt)) continue;
  if (Number.isFinite(marks.task_header_ready))
    switchHeaderMs.push(marks.task_header_ready - startedAt);
  if (Number.isFinite(marks.timeline_data_received)) {
    switchTimelineMs.push(marks.timeline_data_received - startedAt);
  }
  if (Number.isFinite(marks.timeline_first_rows_ready)) {
    switchRowsMs.push(marks.timeline_first_rows_ready - startedAt);
  }
}

const timelinePageMetrics = ipcByChannel.get("task:timelinePage") ?? new Map();
const failures = [];

requireSamples(failures, "sidebar receive", sidebarReceiveMs);
requireSamples(failures, "task header ready", switchHeaderMs);
requireSamples(failures, "timeline data received", switchTimelineMs);
requireSamples(failures, "timeline first rows ready", switchRowsMs);
requireSamples(failures, "timeline page db", timelinePageMetrics.get("dbMs") ?? []);
requireSamples(
  failures,
  "timeline page serialized",
  timelinePageMetrics.get("serializedBytes") ?? [],
);

addFailure(failures, "sidebar receive", sidebarReceiveMs, budget.sidebarReceiveP95Ms);
addFailure(failures, "task header ready", switchHeaderMs, budget.taskHeaderReadyP95Ms);
addFailure(failures, "timeline data received", switchTimelineMs, budget.timelineDataReceivedP95Ms);
addFailure(failures, "timeline first rows ready", switchRowsMs, budget.timelineFirstRowsP95Ms);
addFailure(
  failures,
  "timeline page db",
  timelinePageMetrics.get("dbMs") ?? [],
  budget.timelinePageDbP95Ms,
);
addFailure(
  failures,
  "timeline page serialized",
  timelinePageMetrics.get("serializedBytes") ?? [],
  budget.timelinePageSerializedP95Bytes,
);
addFailure(
  failures,
  "timeline page serialized",
  timelinePageMetrics.get("serializedBytes") ?? [],
  budget.timelinePageSerializedMaxBytes,
  "max",
);

const observed = [
  sidebarReceiveMs.length,
  switchHeaderMs.length,
  switchTimelineMs.length,
  switchRowsMs.length,
  timelinePageMetrics.get("dbMs")?.length ?? 0,
].reduce((sum, count) => sum + count, 0);

if (observed === 0) {
  if (!allowEmpty) {
    console.error(`[perf-budget] no enforceable perf samples in ${logPath}`);
    process.exit(1);
  }
  console.log(`[perf-budget] no enforceable perf samples in ${logPath}; skipping budgets`);
  process.exit(0);
}

if (failures.length > 0) {
  console.error(`[perf-budget] ${failures.length} budget failure(s) in ${logPath}`);
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log(`[perf-budget] budgets passed for ${logPath}`);
