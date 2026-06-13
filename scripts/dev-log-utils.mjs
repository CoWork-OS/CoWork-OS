import fs from "node:fs";
import path from "node:path";

export const DEFAULT_DEV_LOG_RETENTION_DAYS = 14;
export const DEFAULT_DEV_LOG_MIN_RUNS = 20;
export const DEFAULT_DEV_LOG_MAX_MB = 100;

const KNOWN_PROCESS_LABELS = new Set(["react", "electron"]);
const SECRET_VALUE = "[REDACTED]";
const IGNORABLE_DEV_LOG_PATTERNS = [
  /\brepresentedObject is not a WeakPtrToElectronMenuModelAsNSObject\b/,
];

function pad(value) {
  return String(value).padStart(2, "0");
}

export function timestampForFilename(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseRetentionConfig(env = process.env) {
  return {
    retentionDays: parsePositiveInteger(
      env.COWORK_DEV_LOG_RETENTION_DAYS,
      DEFAULT_DEV_LOG_RETENTION_DAYS,
    ),
    minRuns: parsePositiveInteger(env.COWORK_DEV_LOG_MIN_RUNS, DEFAULT_DEV_LOG_MIN_RUNS),
    maxBytes:
      parsePositiveInteger(env.COWORK_DEV_LOG_MAX_MB, DEFAULT_DEV_LOG_MAX_MB) * 1024 * 1024,
  };
}

export function redactDevLogLine(line) {
  let redacted = String(line);
  redacted = redacted.replace(
    /\b(Authorization\s*:\s*(?:Bearer|Basic)\s+)[^\s,;]+/gi,
    `$1${SECRET_VALUE}`,
  );
  redacted = redacted.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, `$1${SECRET_VALUE}`);
  redacted = redacted.replace(
    /\b((?:[A-Z0-9_]*(?:API_?KEY|TOKEN|SECRET|PASSWORD|CLIENT_SECRET|ACCESS_TOKEN|REFRESH_TOKEN)[A-Z0-9_]*)\s*[:=]\s*)(["']?)[^"',;\s]+(["']?)/gi,
    (_match, prefix, openQuote, closeQuote) => `${prefix}${openQuote}${SECRET_VALUE}${closeQuote}`,
  );
  redacted = redacted.replace(
    /\b((?:sk|pk|rk|sess|org|proj)-[A-Za-z0-9_-]{16,})\b/g,
    SECRET_VALUE,
  );
  redacted = redacted.replace(
    /\b(xox(?:b|p|a|r|s)-[A-Za-z0-9-]{16,})\b/g,
    SECRET_VALUE,
  );
  redacted = redacted.replace(/(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, `$1${SECRET_VALUE}@`);
  return redacted;
}

export function isIgnorableDevLogLine(line) {
  const text = String(line || "");
  return IGNORABLE_DEV_LOG_PATTERNS.some((pattern) => pattern.test(text));
}

export function inferDevLogLevel(line, stream = "stdout") {
  const text = String(line).toLowerCase();
  if (/\btool #\d+\s+"run_command"\s+start\b/.test(text)) {
    return stream === "stderr" ? "warn" : "info";
  }
  if (/\bfailed\s*=\s*0\b/.test(text) && !/\bfailed\s*=\s*[1-9]\d*\b/.test(text)) {
    return "info";
  }
  if (/^note: /.test(text) || text.includes("code generator has deoptimised")) {
    return "warn";
  }
  if (/error fetching email \d+: error: imap command timeout/.test(text)) {
    return "warn";
  }
  if (/\b(error|exception|failed|failure|uncaught|fatal|crash)\b/.test(text)) return "error";
  if (/\b(warn|warning|deprecated)\b/.test(text)) return "warn";
  if (/\b(debug|trace|verbose)\b/.test(text)) return "debug";
  return stream === "stderr" ? "warn" : "info";
}

export function parseDevLogLine(line) {
  let remaining = String(line).trimEnd();
  let processName = "dev-wrapper";
  let component;

  const firstLabel = remaining.match(/^\[([^\]]+)\]\s*(.*)$/);
  if (firstLabel) {
    const label = firstLabel[1].trim();
    remaining = firstLabel[2] ?? "";
    const normalizedLabel = label.toLowerCase();
    if (KNOWN_PROCESS_LABELS.has(normalizedLabel)) {
      processName = normalizedLabel;
    } else if (normalizedLabel === "dev-start") {
      component = label;
    } else {
      component = label;
    }
  }

  const secondLabel = remaining.match(/^\[([^\]]+)\]\s*(.*)$/);
  if (secondLabel) {
    component = secondLabel[1].trim();
    remaining = secondLabel[2] ?? "";
  }

  return {
    process: processName,
    component,
    message: remaining,
  };
}

export function extractDevLogIds(line) {
  const text = String(line);
  const taskMatch = text.match(/\btask(?:Id|_id| id)?\s*[:=]\s*([A-Za-z0-9_-]+)/i);
  const workspaceMatch = text.match(/\bworkspace(?:Id|_id| id)?\s*[:=]\s*([A-Za-z0-9_-]+)/i);
  return {
    taskId: taskMatch?.[1],
    workspaceId: workspaceMatch?.[1],
  };
}

export function createDevLogEvent({ timestamp, runId, line, stream = "stdout", overrides = {} }) {
  const rawLine = redactDevLogLine(line);
  const parsed = parseDevLogLine(rawLine);
  const ids = extractDevLogIds(rawLine);
  const level = overrides.level || inferDevLogLevel(rawLine, stream);
  const event = {
    timestamp,
    runId,
    process: overrides.process || parsed.process,
    stream,
    level,
    message: overrides.message || parsed.message,
    rawLine,
  };

  if (overrides.component || parsed.component) event.component = overrides.component || parsed.component;
  if (ids.taskId) event.taskId = ids.taskId;
  if (ids.workspaceId) event.workspaceId = ids.workspaceId;
  if (level === "error") event.error = { message: event.message || rawLine };
  if (overrides.metadata) event.metadata = overrides.metadata;
  if (rawLine !== String(line)) {
    event.metadata = { ...(event.metadata || {}), redacted: true };
  }
  return event;
}

export function serializeDevLogEvent(event) {
  return `${JSON.stringify(event)}\n`;
}

export function formatDevLogTextLine(timestamp, line) {
  return `[${timestamp}] ${redactDevLogLine(line)}\n`;
}

export function createInitialRunManifestEntry({ runId, startedAt, textPath, jsonlPath }) {
  return {
    runId,
    startedAt,
    endedAt: undefined,
    exitCode: undefined,
    signal: undefined,
    textPath,
    jsonlPath,
    byteSize: 0,
    lineCount: 0,
    errorCount: 0,
    warnCount: 0,
  };
}

function readManifest(logsDir) {
  const manifestPath = path.join(logsDir, "dev-runs.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (Array.isArray(parsed)) return { version: 1, runs: parsed };
    if (Array.isArray(parsed?.runs)) return { version: parsed.version || 1, runs: parsed.runs };
  } catch {
    // Missing or invalid manifests are repaired on next write.
  }
  return { version: 1, runs: [] };
}

export function upsertDevRunManifest(logsDir, entry) {
  const manifestPath = path.join(logsDir, "dev-runs.json");
  const manifest = readManifest(logsDir);
  const existingIndex = manifest.runs.findIndex((run) => run.runId === entry.runId);
  if (existingIndex >= 0) {
    manifest.runs[existingIndex] = { ...manifest.runs[existingIndex], ...entry };
  } else {
    manifest.runs.push(entry);
  }
  manifest.runs.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

function statSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

export function summarizeDevLogRunFiles(textPath, jsonlPath, stats) {
  return {
    byteSize: statSize(textPath) + statSize(jsonlPath),
    lineCount: stats.lineCount,
    errorCount: stats.errorCount,
    warnCount: stats.warnCount,
  };
}

function manifestPathFor(logsDir, fileName) {
  return path.join(path.basename(logsDir), fileName);
}

function collectDevLogRuns(logsDir) {
  let files = [];
  try {
    files = fs.readdirSync(logsDir);
  } catch {
    return [];
  }

  const runs = new Map();
  for (const file of files) {
    const match = file.match(/^dev-(\d{8}-\d{6})\.(log|jsonl)$/);
    if (!match) continue;
    const runId = match[1];
    const entry = runs.get(runId) || {
      runId,
      startedAt: runId,
      textPath: path.join(logsDir, `dev-${runId}.log`),
      jsonlPath: path.join(logsDir, `dev-${runId}.jsonl`),
      byteSize: 0,
    };
    entry.byteSize += statSize(path.join(logsDir, file));
    runs.set(runId, entry);
  }
  return [...runs.values()].sort((a, b) => String(b.runId).localeCompare(String(a.runId)));
}

export function applyDevLogRetention(logsDir, config = parseRetentionConfig()) {
  const runs = collectDevLogRuns(logsDir);
  if (runs.length === 0) return { deletedRunIds: [], retainedRunIds: [] };

  const cutoff = Date.now() - config.retentionDays * 24 * 60 * 60 * 1000;
  let retained = [];
  let deleted = [];

  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index];
    const textMtime = fs.existsSync(run.textPath) ? fs.statSync(run.textPath).mtimeMs : 0;
    const jsonMtime = fs.existsSync(run.jsonlPath) ? fs.statSync(run.jsonlPath).mtimeMs : 0;
    const newestMtime = Math.max(textMtime, jsonMtime);
    if (index < config.minRuns || newestMtime >= cutoff) {
      retained.push(run);
    } else {
      deleted.push(run);
    }
  }

  let totalBytes = retained.reduce((sum, run) => sum + run.byteSize, 0);
  for (let index = retained.length - 1; index >= config.minRuns && totalBytes > config.maxBytes; index -= 1) {
    const [run] = retained.splice(index, 1);
    deleted.push(run);
    totalBytes -= run.byteSize;
  }

  for (const run of deleted) {
    for (const target of [run.textPath, run.jsonlPath]) {
      try {
        fs.rmSync(target, { force: true });
      } catch {
        // Best-effort cleanup; a stale file should not block dev startup.
      }
    }
  }

  const manifest = readManifest(logsDir);
  const remainingRuns = collectDevLogRuns(logsDir);
  const retainedIds = new Set(remainingRuns.map((run) => run.runId));
  const existingById = new Map(manifest.runs.map((run) => [run.runId, run]));
  const nextRuns = remainingRuns.map((run) => {
    const existing = existingById.get(run.runId);
    return {
      runId: run.runId,
      startedAt: run.runId,
      textPath: manifestPathFor(logsDir, `dev-${run.runId}.log`),
      jsonlPath: manifestPathFor(logsDir, `dev-${run.runId}.jsonl`),
      lineCount: 0,
      errorCount: 0,
      warnCount: 0,
      ...existing,
      byteSize: run.byteSize,
    };
  });
  fs.writeFileSync(
    path.join(logsDir, "dev-runs.json"),
    `${JSON.stringify({ ...manifest, runs: nextRuns }, null, 2)}\n`,
    "utf8",
  );

  return {
    deletedRunIds: deleted.map((run) => run.runId),
    retainedRunIds: [...retainedIds],
  };
}
