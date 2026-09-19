#!/usr/bin/env node
import fs from "fs";
import path from "path";

const repoRoot = process.cwd();
const logPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(repoRoot, "logs", "dev-latest.jsonl");

function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? 0;
}

function summarize(values) {
  if (values.length === 0) return "n=0";
  return `n=${values.length} p50=${percentile(values, 0.5).toFixed(1)}ms p95=${percentile(values, 0.95).toFixed(1)}ms max=${Math.max(...values).toFixed(1)}ms`;
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`Perf log not found: ${filePath}`);
    process.exitCode = 1;
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
  const jsonText = text.slice(index + prefix.length).trim();
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

const rows = readJsonl(logPath);
const startupMarks = new Map();
const perfMarksByTask = new Map();
const ipc = new Map();
const ipcRenderer = new Map();
const startupLanes = new Map();

for (const row of rows) {
  const message = String(row.message ?? row.rawLine ?? "");
  const startupMatch = message.match(
    /\[Startup\]\s+([a-zA-Z0-9_.:-]+)\s+at\s+([\d.]+)ms(?:\s+(\{.*\}))?/,
  );
  if (startupMatch) {
    const name = startupMatch[1];
    const atMs = Number(startupMatch[2]);
    if (Number.isFinite(atMs)) {
      const bucket = startupMarks.get(name) ?? [];
      bucket.push(atMs);
      startupMarks.set(name, bucket);
    }
  }

  const markMatch = message.match(
    /\[Mark\]\s+([a-zA-Z0-9_.:-]+)\s+at\s+([\d.]+)ms(?:\s+(\{.*\}))?/,
  );
  if (markMatch) {
    const name = markMatch[1];
    const atMs = Number(markMatch[2]);
    let details = {};
    if (markMatch[3]) {
      try {
        details = JSON.parse(markMatch[3]);
      } catch {
        details = {};
      }
    }
    const markKey =
      typeof details.switchId === "string"
        ? details.switchId
        : typeof details.taskId === "string"
          ? details.taskId
          : "global";
    const taskMarks = perfMarksByTask.get(markKey) ?? {};
    taskMarks[name] = atMs;
    perfMarksByTask.set(markKey, taskMarks);
  }

  const ipcMetrics = extractTrailingJson(message, "[IpcPerf]");
  if (ipcMetrics?.channel) {
    const bucket = ipc.get(ipcMetrics.channel) ?? {
      dbMs: [],
      jsonMs: [],
      serializedBytes: [],
      rowCount: [],
      payloadBytes: [],
    };
    for (const key of Object.keys(bucket)) {
      const value = Number(ipcMetrics[key]);
      if (Number.isFinite(value)) bucket[key].push(value);
    }
    ipc.set(ipcMetrics.channel, bucket);
  }

  const ipcRendererMetrics = extractTrailingJson(message, "[IpcRendererPerf]");
  if (ipcRendererMetrics?.channel) {
    const bucket = ipcRenderer.get(ipcRendererMetrics.channel) ?? {
      receiveMs: [],
      jsonMs: [],
      serializedBytes: [],
      rowCount: [],
    };
    for (const key of Object.keys(bucket)) {
      const value = Number(ipcRendererMetrics[key]);
      if (Number.isFinite(value)) bucket[key].push(value);
    }
    ipcRenderer.set(ipcRendererMetrics.channel, bucket);
  }

  const lane = extractTrailingJson(message, "[StartupLane]");
  if (lane?.lane) {
    const bucket = startupLanes.get(lane.lane) ?? [];
    if (Number.isFinite(Number(lane.elapsedMs))) bucket.push(Number(lane.elapsedMs));
    startupLanes.set(lane.lane, bucket);
  }
}

const switchHeaderMs = [];
const switchTimelineMs = [];
const switchRowsMs = [];
for (const marks of perfMarksByTask.values()) {
  const startedAt = marks.task_switch_start;
  if (!Number.isFinite(startedAt)) continue;
  if (Number.isFinite(marks.task_header_ready)) {
    switchHeaderMs.push(marks.task_header_ready - startedAt);
  }
  if (Number.isFinite(marks.timeline_data_received)) {
    switchTimelineMs.push(marks.timeline_data_received - startedAt);
  }
  if (Number.isFinite(marks.timeline_first_rows_ready)) {
    switchRowsMs.push(marks.timeline_first_rows_ready - startedAt);
  }
}

console.log(`Perf log: ${logPath}`);
console.log("");
console.log("Startup lanes");
for (const [name, values] of [...startupLanes.entries()].sort()) {
  console.log(`  ${name}: ${summarize(values)}`);
}

console.log("");
console.log("Renderer startup marks");
for (const [name, values] of [...startupMarks.entries()].sort()) {
  console.log(`  ${name}: ${summarize(values)}`);
}

console.log("");
console.log("Task switch");
console.log(`  header ready: ${summarize(switchHeaderMs)}`);
console.log(`  timeline data received: ${summarize(switchTimelineMs)}`);
console.log(`  timeline first rows ready: ${summarize(switchRowsMs)}`);

console.log("");
console.log("IPC");
for (const [channel, bucket] of [...ipc.entries()].sort()) {
  console.log(`  ${channel}`);
  console.log(`    db: ${summarize(bucket.dbMs)}`);
  console.log(`    json/map: ${summarize(bucket.jsonMs)}`);
  if (bucket.rowCount.length > 0) {
    console.log(
      `    rows: n=${bucket.rowCount.length} p50=${percentile(bucket.rowCount, 0.5).toFixed(0)} p95=${percentile(bucket.rowCount, 0.95).toFixed(0)} max=${Math.max(...bucket.rowCount).toFixed(0)}`,
    );
  }
  if (bucket.serializedBytes.length > 0) {
    console.log(
      `    serialized: n=${bucket.serializedBytes.length} p50=${percentile(bucket.serializedBytes, 0.5).toFixed(0)}B p95=${percentile(bucket.serializedBytes, 0.95).toFixed(0)}B max=${Math.max(...bucket.serializedBytes).toFixed(0)}B`,
    );
  }
  if (bucket.payloadBytes.length > 0) {
    console.log(
      `    payload: n=${bucket.payloadBytes.length} p50=${percentile(bucket.payloadBytes, 0.5).toFixed(0)}B p95=${percentile(bucket.payloadBytes, 0.95).toFixed(0)}B max=${Math.max(...bucket.payloadBytes).toFixed(0)}B`,
    );
  }
}

console.log("");
console.log("IPC renderer receive");
for (const [channel, bucket] of [...ipcRenderer.entries()].sort()) {
  console.log(`  ${channel}`);
  console.log(`    receive: ${summarize(bucket.receiveMs)}`);
  console.log(`    json: ${summarize(bucket.jsonMs)}`);
  if (bucket.rowCount.length > 0) {
    console.log(
      `    rows: n=${bucket.rowCount.length} p50=${percentile(bucket.rowCount, 0.5).toFixed(0)} p95=${percentile(bucket.rowCount, 0.95).toFixed(0)} max=${Math.max(...bucket.rowCount).toFixed(0)}`,
    );
  }
  if (bucket.serializedBytes.length > 0) {
    console.log(
      `    serialized: n=${bucket.serializedBytes.length} p50=${percentile(bucket.serializedBytes, 0.5).toFixed(0)}B p95=${percentile(bucket.serializedBytes, 0.95).toFixed(0)}B max=${Math.max(...bucket.serializedBytes).toFixed(0)}B`,
    );
  }
}
