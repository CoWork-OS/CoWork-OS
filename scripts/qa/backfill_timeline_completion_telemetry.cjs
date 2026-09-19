#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const TIMELINE_TYPES = new Set([
  "timeline_group_started",
  "timeline_group_finished",
  "timeline_step_started",
  "timeline_step_updated",
  "timeline_step_finished",
  "timeline_evidence_attached",
  "timeline_artifact_emitted",
  "timeline_command_output",
  "timeline_error",
]);

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
      "Usage: node scripts/qa/backfill_timeline_completion_telemetry.cjs [--db /absolute/path/to.db]",
      "",
      "Recomputes telemetry on timeline task completion events:",
      "- timeline_event_drop_rate",
      "- timeline_order_violation_rate",
      "- step_state_mismatch_rate",
      "- completion_gate_block_count",
      "- evidence_gate_fail_count",
    ].join("\n") + "\n",
  );
}

function fail(message) {
  process.stderr.write(`timeline-telemetry-backfill: ${message}\n`);
  process.exit(1);
}

function sqliteExec(dbPath, sql) {
  return execFileSync("sqlite3", [dbPath, sql], {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
}

function sqliteJson(dbPath, sql) {
  const out = execFileSync("sqlite3", ["-json", dbPath, sql], {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  }).trim();
  if (!out) return [];
  return JSON.parse(out);
}

function sqlEscape(value) {
  return String(value).replace(/'/g, "''");
}

function safeJsonParse(value, fallback) {
  if (typeof value !== "string" || value.trim().length === 0) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function coerceNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function compareEvents(a, b) {
  const aSeq =
    Number.isFinite(Number(a.seq)) && Number(a.seq) > 0 ? Math.floor(Number(a.seq)) : null;
  const bSeq =
    Number.isFinite(Number(b.seq)) && Number(b.seq) > 0 ? Math.floor(Number(b.seq)) : null;
  if (aSeq !== null && bSeq !== null && aSeq !== bSeq) return aSeq - bSeq;
  const aTs = Number.isFinite(Number(a.ts)) ? Number(a.ts) : Number(a.timestamp) || 0;
  const bTs = Number.isFinite(Number(b.ts)) ? Number(b.ts) : Number(b.timestamp) || 0;
  if (aTs !== bTs) return aTs - bTs;
  return (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0);
}

function getLegacyType(event) {
  if (typeof event.legacy_type === "string" && event.legacy_type.length > 0) {
    return event.legacy_type;
  }
  if (typeof event.payload_legacy_type === "string" && event.payload_legacy_type.length > 0) {
    return event.payload_legacy_type;
  }
  if (event.payload && typeof event.payload.legacyType === "string") {
    return event.payload.legacyType;
  }
  return event.type || "";
}

function isTaskCompletedTimelineEvent(event) {
  if (event.type !== "timeline_step_finished") return false;
  return getLegacyType(event) === "task_completed";
}

function computeTelemetry(events) {
  const sorted = [...events].sort(compareEvents);
  const activeSteps = new Set();
  let totalEvents = 0;
  let droppedEvents = 0;
  let orderViolations = 0;
  let stepStateMismatches = 0;
  let completionGateBlocks = 0;
  let evidenceGateFails = 0;

  for (const event of sorted) {
    if (!TIMELINE_TYPES.has(event.type)) continue;
    totalEvents += 1;
    const legacyType = getLegacyType(event);
    const gate = typeof event.payload_gate === "string" ? event.payload_gate : "";

    if (
      event.type === "timeline_error" &&
      (Number.isFinite(Number(event.payload_rejected_seq)) ||
        String(event.payload_message || "")
          .toLowerCase()
          .includes("out-of-order"))
    ) {
      orderViolations += 1;
      droppedEvents += 1;
    }
    if (gate === "completion_failed_step_gate") {
      completionGateBlocks += 1;
    }
    if (
      gate === "key_claim_evidence_gate" &&
      event.type === "timeline_step_updated" &&
      event.status === "blocked"
    ) {
      evidenceGateFails += 1;
    }

    const stepId = typeof event.step_id === "string" ? event.step_id : "";
    if (!stepId) continue;

    if (event.type === "timeline_step_started") {
      activeSteps.add(stepId);
      continue;
    }
    if (event.type === "timeline_step_finished") {
      const ignoreMismatch =
        legacyType === "task_completed" ||
        legacyType === "task_cancelled" ||
        legacyType === "step_skipped";
      if (!activeSteps.has(stepId) && event.status !== "failed" && !ignoreMismatch) {
        stepStateMismatches += 1;
      }
      activeSteps.delete(stepId);
      continue;
    }
    if (
      event.status === "completed" ||
      event.status === "skipped" ||
      event.status === "cancelled"
    ) {
      activeSteps.delete(stepId);
    }
  }

  return {
    timeline_event_drop_rate: totalEvents > 0 ? droppedEvents / totalEvents : 0,
    timeline_order_violation_rate: totalEvents > 0 ? orderViolations / totalEvents : 0,
    step_state_mismatch_rate: totalEvents > 0 ? stepStateMismatches / totalEvents : 0,
    completion_gate_block_count: completionGateBlocks,
    evidence_gate_fail_count: evidenceGateFails,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const dbPathRaw = args.db || process.env.COWORK_DB_PATH || "";
  if (!dbPathRaw) {
    fail("missing DB path; pass --db or set COWORK_DB_PATH");
  }
  const dbPath = path.resolve(dbPathRaw);
  if (!fs.existsSync(dbPath)) {
    fail(`database does not exist at ${dbPath}`);
  }

  try {
    execFileSync("sqlite3", ["-version"], { stdio: "ignore" });
  } catch {
    fail("sqlite3 CLI is required but not found in PATH");
  }

  const completionRows = sqliteJson(
    dbPath,
    `
SELECT id, task_id, timestamp, type, payload, seq, ts, status, step_id, legacy_type
FROM task_events
WHERE type = 'timeline_step_finished'
  AND (legacy_type = 'task_completed' OR json_extract(payload, '$.legacyType') = 'task_completed')
ORDER BY task_id ASC, COALESCE(seq, timestamp) ASC, timestamp ASC;
`,
  ).map((row) => ({
    ...row,
    payload: safeJsonParse(row.payload, {}),
  }));

  if (completionRows.length === 0) {
    process.stdout.write("timeline-telemetry-backfill: no completion timeline events found\n");
    return;
  }

  const completionByTask = new Map();
  for (const row of completionRows) {
    const taskId = typeof row.task_id === "string" ? row.task_id : "";
    if (!taskId) continue;
    const list = completionByTask.get(taskId) || [];
    list.push(row);
    completionByTask.set(taskId, list);
  }

  let updatedEvents = 0;
  for (const [taskId, completionEvents] of completionByTask.entries()) {
    if (completionEvents.length === 0) continue;
    const taskEvents = sqliteJson(
      dbPath,
      `
SELECT
  id,
  task_id,
  timestamp,
  type,
  seq,
  ts,
  status,
  step_id,
  legacy_type,
  json_extract(payload, '$.legacyType') AS payload_legacy_type,
  json_extract(payload, '$.gate') AS payload_gate,
  json_extract(payload, '$.message') AS payload_message,
  json_extract(payload, '$.rejectedSeq') AS payload_rejected_seq
FROM task_events
WHERE task_id = '${sqlEscape(taskId)}'
ORDER BY COALESCE(seq, timestamp) ASC, timestamp ASC;
`,
    );

    for (const completionEvent of completionEvents) {
      const boundarySeq = Number.isFinite(Number(completionEvent.seq))
        ? Number(completionEvent.seq)
        : null;
      const boundaryTs = coerceNumber(
        completionEvent.ts,
        coerceNumber(completionEvent.timestamp, 0),
      );
      const snapshot = taskEvents.filter((event) => {
        const eventSeq = Number.isFinite(Number(event.seq)) ? Number(event.seq) : null;
        const eventTs = coerceNumber(event.ts, coerceNumber(event.timestamp, 0));
        if (boundarySeq !== null && eventSeq !== null) {
          return eventSeq <= boundarySeq;
        }
        return eventTs <= boundaryTs;
      });

      const telemetry = computeTelemetry(snapshot);
      const payload =
        completionEvent.payload && typeof completionEvent.payload === "object"
          ? { ...completionEvent.payload }
          : {};
      const existingTelemetry =
        payload.telemetry &&
        typeof payload.telemetry === "object" &&
        !Array.isArray(payload.telemetry)
          ? payload.telemetry
          : null;

      const changed =
        !existingTelemetry ||
        Number(existingTelemetry.timeline_event_drop_rate) !== telemetry.timeline_event_drop_rate ||
        Number(existingTelemetry.timeline_order_violation_rate) !==
          telemetry.timeline_order_violation_rate ||
        Number(existingTelemetry.step_state_mismatch_rate) !== telemetry.step_state_mismatch_rate ||
        Number(existingTelemetry.completion_gate_block_count) !==
          telemetry.completion_gate_block_count ||
        Number(existingTelemetry.evidence_gate_fail_count) !== telemetry.evidence_gate_fail_count ||
        String(existingTelemetry.telemetry_source || "") !== "backfill_v2";
      if (!changed) continue;

      payload.telemetry = {
        ...telemetry,
        telemetry_source: "backfill_v2",
      };
      sqliteExec(
        dbPath,
        `UPDATE task_events SET payload='${sqlEscape(JSON.stringify(payload))}' WHERE id='${sqlEscape(completionEvent.id)}';`,
      );
      updatedEvents += 1;
    }
  }

  process.stdout.write(
    `timeline-telemetry-backfill: updated ${updatedEvents} completion event(s) across ${completionByTask.size} task(s)\n`,
  );
}

main();
