#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--db" && i + 1 < argv.length) {
      out.db = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--help" || token === "-h") {
      out.help = true;
    }
  }
  return out;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage: node scripts/qa/enforce_timeline_reliability.cjs [--db /absolute/path/to.db]",
      "",
      "Reads V2 task-completion telemetry from task_events and enforces:",
      "- timeline_event_drop_rate < 0.001",
      "- timeline_order_violation_rate = 0",
      "- step_state_mismatch_rate = 0",
      "",
      "Env overrides:",
      "- COWORK_DB_PATH",
      "- TIMELINE_DROP_RATE_MAX (default: 0.001)",
      "- TIMELINE_ORDER_VIOLATION_RATE_MAX (default: 0)",
      "- TIMELINE_STEP_STATE_MISMATCH_RATE_MAX (default: 0)",
    ].join("\n") + "\n",
  );
}

function toNumber(value, fallback = Number.NaN) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isTruthyEnv(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function runSqlite(dbPath, sql) {
  return spawnSync("sqlite3", ["-readonly", "-separator", "\t", dbPath, sql], {
    encoding: "utf8",
    maxBuffer: 5 * 1024 * 1024,
  });
}

function fail(message) {
  process.stderr.write(`timeline-reliability-gate: ${message}\n`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

const resolvedDbPathRaw = args.db || process.env.COWORK_DB_PATH || "";
if (!resolvedDbPathRaw) {
  fail("missing DB path; pass --db or set COWORK_DB_PATH");
}
const resolvedDbPath = path.resolve(resolvedDbPathRaw);
if (!fs.existsSync(resolvedDbPath)) {
  fail(`database does not exist at ${resolvedDbPath}`);
}

const sqliteCheck = spawnSync("sqlite3", ["-version"], { encoding: "utf8" });
if (sqliteCheck.status !== 0) {
  fail("sqlite3 CLI is required but was not found in PATH");
}

const thresholds = {
  dropRateMax: toNumber(process.env.TIMELINE_DROP_RATE_MAX, 0.001),
  orderRateMax: toNumber(process.env.TIMELINE_ORDER_VIOLATION_RATE_MAX, 0),
  mismatchRateMax: toNumber(process.env.TIMELINE_STEP_STATE_MISMATCH_RATE_MAX, 0),
};

const query = `
SELECT
  task_id,
  COALESCE(json_extract(payload, '$.telemetry.timeline_event_drop_rate'), '') AS drop_rate,
  COALESCE(json_extract(payload, '$.telemetry.timeline_order_violation_rate'), '') AS order_rate,
  COALESCE(json_extract(payload, '$.telemetry.step_state_mismatch_rate'), '') AS mismatch_rate,
  COALESCE(json_extract(payload, '$.telemetry.completion_gate_block_count'), '0') AS completion_blocks,
  COALESCE(json_extract(payload, '$.telemetry.evidence_gate_fail_count'), '0') AS evidence_fails,
  COALESCE(json_extract(payload, '$.telemetry.telemetry_source'), '') AS telemetry_source
FROM task_events
WHERE type = 'timeline_step_finished'
  AND (
    legacy_type = 'task_completed'
    OR json_extract(payload, '$.legacyType') = 'task_completed'
  )
ORDER BY COALESCE(seq, timestamp) ASC, timestamp ASC;
`;

const result = runSqlite(resolvedDbPath, query);
if (result.status !== 0) {
  const sqliteError = String(result.stderr || result.stdout || "").trim();
  if (isTruthyEnv(process.env.COWORK_EVAL_ALLOW_EMPTY) && /no such table:\s*task_events/i.test(sqliteError)) {
    process.stdout.write(
      [
        "timeline-reliability-gate: summary",
        "- completions_checked: 0",
        "- completions_enforced: 0",
        "- note: empty eval database has no task_events table; allowed by COWORK_EVAL_ALLOW_EMPTY",
        "timeline-reliability-gate: PASS",
      ].join("\n") + "\n",
    );
    process.exit(0);
  }
  fail(`sqlite query failed: ${String(result.stderr || result.stdout || "").trim()}`);
}

const lines = (result.stdout || "")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

if (lines.length === 0) {
  if (isTruthyEnv(process.env.COWORK_EVAL_ALLOW_EMPTY)) {
    process.stdout.write(
      [
        "timeline-reliability-gate: summary",
        "- completions_checked: 0",
        "- completions_enforced: 0",
        "- note: empty eval database allowed by COWORK_EVAL_ALLOW_EMPTY",
        "timeline-reliability-gate: PASS",
      ].join("\n") + "\n",
    );
    process.exit(0);
  }
  fail("no task_completed timeline records found; cannot enforce reliability thresholds");
}

const rows = lines.map((line) => {
  const [
    taskId,
    dropRateRaw,
    orderRateRaw,
    mismatchRateRaw,
    completionBlocksRaw,
    evidenceFailsRaw,
    telemetrySourceRaw,
  ] =
    line.split("\t");
  return {
    taskId: taskId || "unknown-task",
    dropRate: toNumber(dropRateRaw),
    orderRate: toNumber(orderRateRaw),
    mismatchRate: toNumber(mismatchRateRaw),
    completionBlocks: toNumber(completionBlocksRaw, 0),
    evidenceFails: toNumber(evidenceFailsRaw, 0),
    telemetrySource: String(telemetrySourceRaw || "").trim(),
  };
});

const backfilledRows = rows.filter((row) => row.telemetrySource === "backfill_v2");
const rowsToEnforce = rows.filter((row) => row.telemetrySource !== "backfill_v2");

if (rowsToEnforce.length === 0) {
  process.stdout.write(
    [
      "timeline-reliability-gate: summary",
      `- completions_checked: ${rows.length}`,
      `- completions_backfilled: ${backfilledRows.length}`,
      "- completions_enforced: 0",
      "- note: dataset contains only backfilled completion telemetry; runtime thresholds not enforced",
      "timeline-reliability-gate: PASS",
    ].join("\n") + "\n",
  );
  process.exit(0);
}

const missingTelemetryRows = rowsToEnforce.filter(
  (row) =>
    Number.isNaN(row.dropRate) || Number.isNaN(row.orderRate) || Number.isNaN(row.mismatchRate),
);
if (missingTelemetryRows.length > 0) {
  fail(
    `missing required telemetry in ${missingTelemetryRows.length} completion event(s): ${missingTelemetryRows
      .slice(0, 10)
      .map((row) => row.taskId)
      .join(", ")}`,
  );
}

const maxDropRate = Math.max(...rowsToEnforce.map((row) => row.dropRate));
const maxOrderRate = Math.max(...rowsToEnforce.map((row) => row.orderRate));
const maxMismatchRate = Math.max(...rowsToEnforce.map((row) => row.mismatchRate));
const completionGateBlocksTotal = rowsToEnforce.reduce(
  (acc, row) => acc + Math.max(0, row.completionBlocks),
  0,
);
const evidenceGateFailsTotal = rowsToEnforce.reduce((acc, row) => acc + Math.max(0, row.evidenceFails), 0);

const violations = [];
if (maxDropRate >= thresholds.dropRateMax) {
  violations.push(
    `timeline_event_drop_rate max=${maxDropRate} exceeded threshold < ${thresholds.dropRateMax}`,
  );
}
if (maxOrderRate > thresholds.orderRateMax) {
  violations.push(
    `timeline_order_violation_rate max=${maxOrderRate} exceeded threshold <= ${thresholds.orderRateMax}`,
  );
}
if (maxMismatchRate > thresholds.mismatchRateMax) {
  violations.push(
    `step_state_mismatch_rate max=${maxMismatchRate} exceeded threshold <= ${thresholds.mismatchRateMax}`,
  );
}

process.stdout.write(
  [
    "timeline-reliability-gate: summary",
    `- completions_checked: ${rows.length}`,
    `- completions_backfilled: ${backfilledRows.length}`,
    `- completions_enforced: ${rowsToEnforce.length}`,
    `- max_timeline_event_drop_rate: ${maxDropRate}`,
    `- max_timeline_order_violation_rate: ${maxOrderRate}`,
    `- max_step_state_mismatch_rate: ${maxMismatchRate}`,
    `- completion_gate_block_count_total: ${completionGateBlocksTotal}`,
    `- evidence_gate_fail_count_total: ${evidenceGateFailsTotal}`,
  ].join("\n") + "\n",
);

if (violations.length > 0) {
  fail(violations.join("; "));
}

process.stdout.write("timeline-reliability-gate: PASS\n");
