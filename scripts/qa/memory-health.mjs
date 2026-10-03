#!/usr/bin/env node
// Memory health check: Appendix A of docs/memory-system-audit-2026-10-03.md as a
// CI-safe script (audit §8.5). Reads a profile database strictly read-only and reports
// aggregate counts only; no memory content is printed.
//
// Usage:
//   npm run -s qa:memory-health
//   node scripts/qa/memory-health.mjs --db <path> [--json] [--ci] [thresholds...]
//
// Run with --help for every option. Exit codes: 0 ok, 1 threshold breached, 2 usage or
// open error.
//
// Read-only guarantees: the database is opened with `readonly: true` and
// `PRAGMA query_only = ON`; temporary b-trees stay in memory (`temp_store = MEMORY`); no
// migration, checkpoint or temp table is ever run. A WAL-format database whose `-wal` file
// is absent (the app is not running) would make SQLite create empty `-wal`/`-shm` files
// even for a read-only connection, so such a database is read into memory and opened from
// that snapshot instead (up to --snapshot-limit-mb). Above that limit it is opened
// directly; SQLite may then leave empty `-wal`/`-shm` files, which are harmless and are never
// deleted here (deleting them could race with the app opening the database).
import { createRequire } from "node:module";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

const DAY_MS = 24 * 60 * 60 * 1000;
const DATABASE_FILE_NAME = "cowork-os.db";

/** Audit §9 success-metric targets, applied by --ci unless a flag overrides them. */
export const CI_THRESHOLDS = {
  maxTelemetryRatio: 0.05,
  maxDuplicateRate: 0.01,
  maxStuckHeartbeat: 0,
};

/** `maintenance_state` keys written by the memory migrations (values are never printed). */
export const MEMORY_MAINTENANCE_KEYS = [
  "memory_items_lane_migration_v1",
  "memory_cleanup_migration_v1",
  "memory_payload_tables_migration_v1",
];
const KIT_RENDER_STATE_PREFIX = "kit_render_state:";

const THRESHOLD_FLAGS = {
  "--max-telemetry-ratio": { key: "maxTelemetryRatio", kind: "ratio" },
  "--max-duplicate-rate": { key: "maxDuplicateRate", kind: "ratio" },
  "--max-stuck-heartbeat": { key: "maxStuckHeartbeat", kind: "count" },
  "--max-stuck-dreaming": { key: "maxStuckDreaming", kind: "count" },
  "--max-orphan-embeddings": { key: "maxOrphanEmbeddings", kind: "count" },
  "--max-pending-writes": { key: "maxPendingWrites", kind: "count" },
  "--min-memory-items": { key: "minMemoryItems", kind: "count" },
  "--max-db-mb": { key: "maxDbMb", kind: "number" },
};

export const HELP = `Usage: node scripts/qa/memory-health.mjs [options]

Read-only memory health check of a CoWork OS profile database (aggregate counts only).

Database selection (first match wins):
  --db <path>                 Database file.
  COWORK_DB_PATH              Database file (env).
  --user-data-dir <dir>       Profile root; also COWORK_USER_DATA_DIR (env).
  --profile <id>              Named profile under <root>/profiles/<id>; also COWORK_PROFILE.
  default                     The desktop profile: <appData>/cowork-os/cowork-os.db
                              (macOS ~/Library/Application Support, Linux $XDG_CONFIG_HOME
                              or ~/.config, Windows %APPDATA%).

Output:
  --json                      Machine-readable JSON on stdout.
  --top <n>                   Rows in the per-store size list (default 15).
  --no-dbstat                 Skip the page scan for per-store sizes (faster on large DBs).
  --stuck-after <duration>    Age after which a 'running' heartbeat/Dreaming run counts as
                              stuck: 90s, 30m, 1h, 2d; a bare number is minutes (default 1h).
  --snapshot-limit-mb <n>     Largest WAL database read into memory when its -wal file is
                              absent (default 1024; 0 always opens the file directly).

Thresholds (none apply unless passed; a breach exits 1):
  --ci                        Audit §9 targets: --max-telemetry-ratio 0.05
                              --max-duplicate-rate 0.01 --max-stuck-heartbeat 0.
                              Explicit flags override the preset.
  --max-telemetry-ratio <r>   Archive (memories) share of raw_event + core_trace rows.
  --max-duplicate-rate <r>    Duplicate share, checked for memories (same normalized content
                              per workspace + type) and active memory_items (same content_hash
                              per workspace/scope/scope_ref/kind).
  --max-stuck-heartbeat <n>   heartbeat_runs still 'running' after --stuck-after.
  --max-stuck-dreaming <n>    dreaming_runs still 'running' after --stuck-after.
  --max-orphan-embeddings <n> memory_embeddings rows whose memory no longer exists.
  --max-pending-writes <n>    pending_memory_writes with status 'pending'.
  --min-memory-items <n>      Active memory_items rows.
  --max-db-mb <n>             Database file size in MiB (main file only).

A check whose table is missing is reported as 'skip' and does not fail.

Exit codes: 0 ok, 1 threshold breached, 2 usage or open error.
  --help                      Show this help.
`;

export class UsageError extends Error {}

function parseDurationMs(raw) {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(String(raw).trim());
  if (!match) throw new UsageError(`invalid duration: ${raw}`);
  const value = Number(match[1]);
  const unit = match[2] ?? "m";
  const factor = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: DAY_MS }[unit];
  return Math.round(value * factor);
}

function parseNumber(flag, raw, kind) {
  const value = Number(raw);
  if (raw === undefined || raw === "" || !Number.isFinite(value) || value < 0) {
    throw new UsageError(`${flag} expects a non-negative number`);
  }
  if (kind === "ratio" && value > 1) throw new UsageError(`${flag} expects a ratio in 0..1`);
  if (kind === "count" && !Number.isInteger(value)) {
    throw new UsageError(`${flag} expects an integer`);
  }
  return value;
}

/** Parse CLI arguments. Throws UsageError on bad input. */
export function parseArgs(argv) {
  const options = {
    help: false,
    json: false,
    ci: false,
    db: undefined,
    userDataDir: undefined,
    profile: undefined,
    top: 15,
    dbstat: true,
    stuckAfterMs: 60 * 60 * 1000,
    snapshotLimitMb: 1024,
    thresholds: {},
  };
  const explicit = {};
  for (let i = 0; i < argv.length; i += 1) {
    let arg = argv[i];
    let inline;
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq > 0) {
      inline = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    const value = () => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new UsageError(`${arg} needs a value`);
      i += 1;
      return next;
    };
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--ci") options.ci = true;
    else if (arg === "--no-dbstat") options.dbstat = false;
    else if (arg === "--db") options.db = value();
    else if (arg === "--user-data-dir") options.userDataDir = value();
    else if (arg === "--profile") options.profile = value();
    else if (arg === "--top") options.top = parseNumber(arg, value(), "count");
    else if (arg === "--stuck-after") options.stuckAfterMs = parseDurationMs(value());
    else if (arg === "--snapshot-limit-mb")
      options.snapshotLimitMb = parseNumber(arg, value(), "number");
    else if (THRESHOLD_FLAGS[arg]) {
      const { key, kind } = THRESHOLD_FLAGS[arg];
      explicit[key] = parseNumber(arg, value(), kind);
    } else throw new UsageError(`unknown option: ${argv[i]}`);
  }
  options.thresholds = { ...(options.ci ? CI_THRESHOLDS : {}), ...explicit };
  return options;
}

function expandHome(input) {
  const trimmed = input.trim();
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
  return path.resolve(trimmed);
}

/** Electron's `app.getPath("appData")` for this platform. */
function electronAppDataDir(env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support");
  if (process.platform === "win32") return env.APPDATA || path.join(home, "AppData", "Roaming");
  return env.XDG_CONFIG_HOME || path.join(home, ".config");
}

function normalizeProfileId(input) {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-");
  return normalized.replace(/^[-_.]+|[-_.]+$/g, "").slice(0, 64) || "default";
}

/**
 * Resolve the database path the way the desktop app does (src/electron/utils/user-data-dir.ts):
 * --db / COWORK_DB_PATH, else COWORK_USER_DATA_DIR / --user-data-dir, else the Electron
 * userData root; a non-default profile lives under profiles/<id>.
 */
export function resolveDbPath(options, env = process.env) {
  if (options.db) return path.resolve(expandHome(options.db));
  if (env.COWORK_DB_PATH && env.COWORK_DB_PATH.trim())
    return path.resolve(expandHome(env.COWORK_DB_PATH));
  const rootOverride = env.COWORK_USER_DATA_DIR?.trim() || options.userDataDir?.trim();
  const root = rootOverride
    ? expandHome(rootOverride)
    : path.join(electronAppDataDir(env), "cowork-os");
  const profileId = normalizeProfileId(
    options.profile ?? env.COWORK_PROFILE ?? env.COWORK_PROFILE_ID ?? "default",
  );
  const dir = profileId === "default" ? root : path.join(root, "profiles", profileId);
  return path.join(dir, DATABASE_FILE_NAME);
}

function readHeader(dbPath) {
  const fd = openSync(dbPath, "r");
  try {
    const header = Buffer.alloc(100);
    const read = readSync(fd, header, 0, 100, 0);
    return read === 100 ? header : null;
  } finally {
    closeSync(fd);
  }
}

/**
 * Open `dbPath` without ever writing it. Returns { db, mode, close() }; close() reports the
 * empty -wal/-shm files that only exist because this connection opened the file (they are
 * left in place: removing them could race with the app opening the database).
 */
export function openReadOnly(dbPath, { snapshotLimitMb = 1024 } = {}) {
  const Database = require("better-sqlite3");
  const stat = statSync(dbPath);
  const header = readHeader(dbPath);
  if (!header || header.toString("latin1", 0, 15) !== "SQLite format 3") {
    throw new Error(`not a SQLite database: ${dbPath}`);
  }
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  const walFormat = header[18] === 2 || header[19] === 2;
  const walExisted = existsSync(walPath);
  const shmExisted = existsSync(shmPath);

  let db;
  let mode;
  if (walFormat && !walExisted && stat.size <= snapshotLimitMb * 1024 * 1024) {
    // Every committed page is in the main file; read it once and open the copy in memory.
    // The header's WAL version bytes are reset on the copy only (an in-memory database
    // cannot use WAL); the file on disk is never touched.
    const buffer = readFileSync(dbPath);
    buffer[18] = 1;
    buffer[19] = 1;
    db = new Database(buffer, { readonly: true });
    mode = "snapshot";
  } else {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    mode = "readonly";
  }
  try {
    db.pragma("temp_store = MEMORY");
    db.pragma("query_only = ON");
    db.pragma("trusted_schema = OFF");
  } catch (error) {
    db.close();
    throw error;
  }

  const close = () => {
    db.close();
    const created = [];
    if (mode === "readonly" && walFormat) {
      if (!walExisted && existsSync(walPath)) created.push(path.basename(walPath));
      if (!shmExisted && existsSync(shmPath)) created.push(path.basename(shmPath));
    }
    return created;
  };
  return { db, mode, walFormat, walExisted, close };
}

// ---------------------------------------------------------------------------------------
// Queries. Every table and column is optional; a missing one is reported, never fatal.

function makeSchema(db) {
  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
      .all()
      .map((row) => row.name),
  );
  const columnCache = new Map();
  const columns = (table) => {
    if (!columnCache.has(table)) {
      const names = tables.has(table)
        ? db
            .prepare("SELECT name FROM pragma_table_info(?)")
            .all(table)
            .map((row) => row.name)
        : [];
      columnCache.set(table, new Set(names));
    }
    return columnCache.get(table);
  };
  return {
    has: (table) => tables.has(table),
    hasColumns: (table, ...names) => tables.has(table) && names.every((n) => columns(table).has(n)),
    missing: (table, ...names) => {
      if (!tables.has(table)) return { status: "missing", table };
      const absent = names.filter((n) => !columns(table).has(n));
      return absent.length ? { status: "missing", table, columns: absent } : null;
    },
  };
}

function section(fn) {
  try {
    return fn();
  } catch (error) {
    return { status: "error", error: error instanceof Error ? error.message : String(error) };
  }
}

const ratio = (part, whole) => (whole > 0 ? part / whole : 0);

function countBy(db, sql, ...params) {
  return db.prepare(sql).all(...params);
}

function storeSizes(db, schema, options) {
  const pageSize = db.pragma("page_size", { simple: true });
  const pageCount = db.pragma("page_count", { simple: true });
  const freelist = db.pragma("freelist_count", { simple: true });
  const result = {
    status: "ok",
    pageSize,
    pageCount,
    freelistPages: freelist,
    totalBytes: pageSize * pageCount,
    dbstat: "unavailable",
    top: [],
    families: [],
  };
  if (!options.dbstat) {
    result.dbstat = "skipped";
    return result;
  }
  let rows;
  try {
    rows = db.prepare("SELECT name, pgsize AS bytes FROM dbstat WHERE aggregate = TRUE").all();
  } catch {
    try {
      rows = db.prepare("SELECT name, sum(pgsize) AS bytes FROM dbstat GROUP BY name").all();
    } catch {
      rows = null;
    }
  }
  if (!rows) return result;
  result.dbstat = "ok";
  rows.sort((a, b) => b.bytes - a.bytes);
  result.top = rows.slice(0, options.top).map((row) => ({ name: row.name, bytes: row.bytes }));
  // Families group a table with its indexes and FTS shadow tables.
  const indexOwner = new Map(
    db
      .prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map((row) => [row.name, row.tbl_name]),
  );
  const family = (name) => {
    const owner = indexOwner.get(name) ?? name;
    if (owner === "memories" || owner.startsWith("memories_")) return "memories";
    if (owner.startsWith("memory_")) return "memory_*";
    if (owner.startsWith("transcript_")) return "transcript_*";
    if (owner.startsWith("durable_context_")) return "durable_context_*";
    return "other";
  };
  const families = new Map();
  for (const row of rows) {
    const key = family(row.name);
    families.set(key, (families.get(key) ?? 0) + row.bytes);
  }
  result.families = [...families.entries()]
    .map(([name, bytes]) => ({ name, bytes }))
    .sort((a, b) => b.bytes - a.bytes);
  return result;
}

const TELEMETRY_KIND_SQL = `CASE
  WHEN content LIKE 'Tool called:%' OR content LIKE 'Tool result for%'
    OR content LIKE 'Step completed:%' OR content LIKE '{"stepId"%'
    OR content LIKE '{"taskId"%' OR content LIKE '{"groupId"%' THEN 'raw_event'
  WHEN content LIKE '[core-trace:%' THEN 'core_trace'
  WHEN content LIKE '[SUGGESTION]%' THEN 'suggestion'
  WHEN content LIKE '[PLAYBOOK]%' THEN 'playbook'
  ELSE 'other' END`;

function archive(db, schema, now) {
  const missing = schema.missing("memories", "content", "created_at");
  if (missing) return missing;
  const cutoff = now - 7 * DAY_MS;
  const total = db.prepare("SELECT count(*) AS n FROM memories").get().n;
  const age = db
    .prepare(`SELECT sum(created_at < ?) AS older, sum(created_at >= ?) AS recent FROM memories`)
    .get(cutoff, cutoff);
  const byTierAge = schema.hasColumns("memories", "tier")
    ? countBy(
        db,
        `SELECT tier, CASE WHEN created_at < ? THEN 'older_7d' ELSE 'last_7d' END AS age, count(*) AS n
         FROM memories GROUP BY 1, 2 ORDER BY 1, 2`,
        cutoff,
      )
    : "missing";
  const kindRows = countBy(
    db,
    `SELECT ${TELEMETRY_KIND_SQL} AS kind, count(*) AS n FROM memories GROUP BY 1 ORDER BY 2 DESC`,
  );
  const kinds = { raw_event: 0, core_trace: 0, suggestion: 0, playbook: 0, other: 0 };
  for (const row of kindRows) kinds[row.kind] = row.n;
  const telemetry = kinds.raw_event + kinds.core_trace;

  // Duplicates: rows beyond the first per (workspace, type, normalized content).
  const hasType = schema.hasColumns("memories", "type");
  const hasWorkspace = schema.hasColumns("memories", "workspace_id");
  const key = [
    hasWorkspace ? "COALESCE(workspace_id, '')" : "''",
    hasType ? "type" : "''",
    "lower(trim(content))",
  ].join(", ");
  const groups = db
    .prepare(`SELECT count(*) AS n FROM (SELECT 1 FROM memories GROUP BY ${key})`)
    .get().n;
  const duplicateRows = total - groups;

  let perTask = "missing";
  if (schema.hasColumns("memories", "task_id")) {
    perTask = db
      .prepare(
        `SELECT count(*) AS tasks, COALESCE(round(avg(n), 1), 0) AS avg, COALESCE(max(n), 0) AS max
         FROM (SELECT count(*) AS n FROM memories WHERE task_id IS NOT NULL AND created_at >= ?
               GROUP BY task_id)`,
      )
      .get(cutoff);
  }
  return {
    status: "ok",
    total,
    olderThan7d: age.older ?? 0,
    last7d: age.recent ?? 0,
    byTierAge,
    kinds,
    telemetryRows: telemetry,
    telemetryRatio: ratio(telemetry, total),
    duplicateRows,
    duplicateRate: ratio(duplicateRows, total),
    perTaskLast7d: perTask,
  };
}

function memoryItems(db, schema) {
  const missing = schema.missing("memory_items", "status");
  if (missing) return missing;
  const total = db.prepare("SELECT count(*) AS n FROM memory_items").get().n;
  const by = (column) =>
    schema.hasColumns("memory_items", column)
      ? countBy(
          db,
          `SELECT ${column} AS value, count(*) AS n FROM memory_items GROUP BY 1 ORDER BY 2 DESC`,
        )
      : "missing";
  const byStatus = by("status");
  const active = db
    .prepare("SELECT count(*) AS n FROM memory_items WHERE status = 'active'")
    .get().n;
  const activeBy = (column) =>
    schema.hasColumns("memory_items", column)
      ? countBy(
          db,
          `SELECT ${column} AS value, count(*) AS n FROM memory_items WHERE status = 'active'
           GROUP BY 1 ORDER BY 2 DESC`,
        )
      : "missing";
  const pinned = schema.hasColumns("memory_items", "pinned")
    ? db
        .prepare("SELECT count(*) AS n FROM memory_items WHERE status = 'active' AND pinned = 1")
        .get().n
    : "missing";
  const privateItems = schema.hasColumns("memory_items", "privacy")
    ? db
        .prepare(
          "SELECT count(*) AS n FROM memory_items WHERE status = 'active' AND privacy = 'private'",
        )
        .get().n
    : "missing";
  let duplicateRows = "missing";
  let duplicateRate = "missing";
  if (
    schema.hasColumns("memory_items", "workspace_id", "scope", "scope_ref", "kind", "content_hash")
  ) {
    const groups = db
      .prepare(
        `SELECT count(*) AS n FROM (SELECT 1 FROM memory_items WHERE status = 'active'
         GROUP BY COALESCE(workspace_id, ''), scope, COALESCE(scope_ref, ''), kind, content_hash)`,
      )
      .get().n;
    duplicateRows = active - groups;
    duplicateRate = ratio(duplicateRows, active);
  }
  return {
    status: "ok",
    total,
    active,
    pinned,
    private: privateItems,
    byStatus,
    activeBySource: activeBy("source"),
    activeByScope: activeBy("scope"),
    activeByKind: activeBy("kind"),
    duplicateRows,
    duplicateRate,
  };
}

function curated(db, schema) {
  const missing = schema.missing("curated_memory_entries");
  if (missing) return missing;
  const total = db.prepare("SELECT count(*) AS n FROM curated_memory_entries").get().n;
  const active = schema.hasColumns("curated_memory_entries", "status")
    ? db.prepare("SELECT count(*) AS n FROM curated_memory_entries WHERE status = 'active'").get().n
    : total;
  return { status: "ok", total, active };
}

function pendingWrites(db, schema) {
  const missing = schema.missing("pending_memory_writes", "status");
  if (missing) return missing;
  const byStatus = countBy(
    db,
    "SELECT status AS value, count(*) AS n FROM pending_memory_writes GROUP BY 1 ORDER BY 2 DESC",
  );
  const total = byStatus.reduce((sum, row) => sum + row.n, 0);
  const pending = byStatus.find((row) => row.value === "pending")?.n ?? 0;
  return { status: "ok", total, pending, byStatus };
}

function coreCandidates(db, schema) {
  const missing = schema.missing("core_memory_candidates", "candidate_type", "status", "summary");
  if (missing) return missing;
  const rows = countBy(
    db,
    `SELECT candidate_type AS type, status, count(*) AS n, count(DISTINCT summary) AS distinctSummaries
     FROM core_memory_candidates GROUP BY 1, 2 ORDER BY n DESC`,
  );
  const total = rows.reduce((sum, row) => sum + row.n, 0);
  return { status: "ok", total, byTypeStatus: rows };
}

function dreaming(db, schema, now, stuckAfterMs) {
  const missing = schema.missing("dreaming_runs", "status");
  if (missing) return missing;
  const byStatus = countBy(
    db,
    "SELECT status AS value, count(*) AS n FROM dreaming_runs GROUP BY 1 ORDER BY 2 DESC",
  );
  const total = byStatus.reduce((sum, row) => sum + row.n, 0);
  const timeColumn = schema.hasColumns("dreaming_runs", "started_at")
    ? "started_at"
    : schema.hasColumns("dreaming_runs", "created_at")
      ? "created_at"
      : null;
  const lastRunAt = timeColumn
    ? db.prepare(`SELECT max(${timeColumn}) AS t FROM dreaming_runs`).get().t
    : "missing";
  const stuck = timeColumn
    ? db
        .prepare(
          `SELECT count(*) AS n FROM dreaming_runs WHERE status = 'running' AND ${timeColumn} < ?`,
        )
        .get(now - stuckAfterMs).n
    : "missing";
  const candidates = schema.hasColumns("dreaming_candidates", "status")
    ? countBy(
        db,
        "SELECT status AS value, count(*) AS n FROM dreaming_candidates GROUP BY 1 ORDER BY 2 DESC",
      )
    : "missing";
  return {
    status: "ok",
    total,
    byStatus,
    lastRunAt: typeof lastRunAt === "number" ? new Date(lastRunAt).toISOString() : lastRunAt,
    stuck,
    candidates,
  };
}

function heartbeat(db, schema, now, stuckAfterMs) {
  const missing = schema.missing("heartbeat_runs", "status", "created_at");
  if (missing) return missing;
  const typeColumn = schema.hasColumns("heartbeat_runs", "run_type") ? "run_type" : "'unknown'";
  const byTypeStatus = countBy(
    db,
    `SELECT ${typeColumn} AS runType, status, count(*) AS n FROM heartbeat_runs GROUP BY 1, 2 ORDER BY n DESC`,
  );
  const startColumn = schema.hasColumns("heartbeat_runs", "started_at")
    ? "COALESCE(started_at, created_at)"
    : "created_at";
  const stuckRows = countBy(
    db,
    `SELECT ${typeColumn} AS runType, count(*) AS n, min(${startColumn}) AS oldest
     FROM heartbeat_runs WHERE status = 'running' AND ${startColumn} < ? GROUP BY 1`,
    now - stuckAfterMs,
  );
  const stuck = stuckRows.reduce((sum, row) => sum + row.n, 0);
  const oldest = stuckRows.reduce(
    (min, row) => (min === null || row.oldest < min ? row.oldest : min),
    null,
  );
  return {
    status: "ok",
    total: byTypeStatus.reduce((sum, row) => sum + row.n, 0),
    byTypeStatus,
    stuck,
    stuckByType: stuckRows.map((row) => ({ runType: row.runType, n: row.n })),
    oldestStuckAt: oldest === null ? null : new Date(oldest).toISOString(),
  };
}

const CONVERSATION_TABLES = [
  "transcript_spans",
  "durable_context_conversations",
  "durable_context_messages",
  "durable_context_summaries",
  "durable_context_large_payloads",
  "durable_context_events",
];

function conversation(db, schema) {
  const tables = CONVERSATION_TABLES.map((table) =>
    schema.has(table)
      ? { table, rows: db.prepare(`SELECT count(*) AS n FROM "${table}"`).get().n }
      : { table, rows: "missing" },
  );
  let snapshotSpans = "missing";
  if (schema.hasColumns("transcript_spans", "type")) {
    snapshotSpans = db
      .prepare("SELECT count(*) AS n FROM transcript_spans WHERE type = 'conversation_snapshot'")
      .get().n;
  }
  return { status: "ok", tables, conversationSnapshotSpans: snapshotSpans };
}

function markdownFiles(db, schema, top) {
  const missing = schema.missing("memory_markdown_files", "path");
  if (missing) return missing;
  const total = db.prepare("SELECT count(*) AS n FROM memory_markdown_files").get().n;
  // Top directory; under .cowork/ the second one too (.history, subconscious, memory).
  // Files outside any directory are counted together so no file name is printed.
  const rows = countBy(
    db,
    `WITH p AS (
       SELECT CASE
         WHEN path LIKE '.cowork/%/%'
           THEN '.cowork/' || substr(substr(path, 9), 1, instr(substr(path, 9), '/'))
         WHEN path LIKE '.cowork/%' THEN '.cowork/(files)'
         WHEN instr(path, '/') > 0 THEN substr(path, 1, instr(path, '/'))
         ELSE '(files)' END AS segment
       FROM memory_markdown_files)
     SELECT segment, count(*) AS n FROM p GROUP BY 1 ORDER BY 2 DESC LIMIT ?`,
    top,
  );
  return { status: "ok", total, byTopSegment: rows };
}

function embeddings(db, schema) {
  const missing = schema.missing("memory_embeddings", "memory_id");
  if (missing) return missing;
  const total = db.prepare("SELECT count(*) AS n FROM memory_embeddings").get().n;
  const orphans = schema.has("memories")
    ? db
        .prepare(
          `SELECT count(*) AS n FROM memory_embeddings e
           WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = e.memory_id)`,
        )
        .get().n
    : total;
  return { status: "ok", total, orphans, orphanRate: ratio(orphans, total) };
}

function maintenance(db, schema) {
  const missing = schema.missing("maintenance_state", "key");
  if (missing) return missing;
  const hasUpdated = schema.hasColumns("maintenance_state", "updated_at");
  const markers = MEMORY_MAINTENANCE_KEYS.map((key) => {
    const row = db
      .prepare(
        `SELECT ${hasUpdated ? "updated_at" : "NULL"} AS updatedAt FROM maintenance_state WHERE key = ?`,
      )
      .get(key);
    return {
      key,
      present: Boolean(row),
      updatedAt: row?.updatedAt ? new Date(row.updatedAt).toISOString() : null,
    };
  });
  const kitRenderStates = db
    .prepare("SELECT count(*) AS n FROM maintenance_state WHERE substr(key, 1, ?) = ?")
    .get(KIT_RENDER_STATE_PREFIX.length, KIT_RENDER_STATE_PREFIX).n;
  return { status: "ok", markers, kitRenderStates };
}

/** Collect the whole report from an open connection. */
export function collectReport(db, options, now = Date.now()) {
  const schema = makeSchema(db);
  return {
    stores: section(() => storeSizes(db, schema, options)),
    archive: section(() => archive(db, schema, now)),
    memoryItems: section(() => memoryItems(db, schema)),
    curated: section(() => curated(db, schema)),
    pendingWrites: section(() => pendingWrites(db, schema)),
    coreCandidates: section(() => coreCandidates(db, schema)),
    dreaming: section(() => dreaming(db, schema, now, options.stuckAfterMs)),
    heartbeat: section(() => heartbeat(db, schema, now, options.stuckAfterMs)),
    conversation: section(() => conversation(db, schema)),
    markdownFiles: section(() => markdownFiles(db, schema, options.top)),
    embeddings: section(() => embeddings(db, schema)),
    maintenance: section(() => maintenance(db, schema)),
  };
}

/** Evaluate thresholds. A metric that is unavailable yields status 'skip'. */
export function evaluateChecks(report, thresholds, fileBytes) {
  const checks = [];
  const add = (name, threshold, op, read) => {
    if (threshold === undefined) return;
    let value;
    try {
      value = read();
    } catch {
      value = undefined;
    }
    if (typeof value !== "number") {
      checks.push({ name, op, threshold, value: null, status: "skip" });
      return;
    }
    const ok = op === "<=" ? value <= threshold : value >= threshold;
    checks.push({ name, op, threshold, value, status: ok ? "pass" : "fail" });
  };
  const t = thresholds;
  add("archive telemetry ratio", t.maxTelemetryRatio, "<=", () => report.archive.telemetryRatio);
  add("archive duplicate rate", t.maxDuplicateRate, "<=", () => report.archive.duplicateRate);
  add(
    "memory_items duplicate rate",
    t.maxDuplicateRate,
    "<=",
    () => report.memoryItems.duplicateRate,
  );
  add("stuck heartbeat runs", t.maxStuckHeartbeat, "<=", () => report.heartbeat.stuck);
  add("stuck dreaming runs", t.maxStuckDreaming, "<=", () => report.dreaming.stuck);
  add("orphan embeddings", t.maxOrphanEmbeddings, "<=", () => report.embeddings.orphans);
  add("pending memory writes", t.maxPendingWrites, "<=", () => report.pendingWrites.pending);
  add("active memory_items", t.minMemoryItems, ">=", () => report.memoryItems.active);
  add("database size (MiB)", t.maxDbMb, "<=", () => Math.round((fileBytes / 1048576) * 10) / 10);
  return checks;
}

// ---------------------------------------------------------------------------------------
// Human output.

const mb = (bytes) =>
  bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
const pct = (value) => (typeof value === "number" ? `${(value * 100).toFixed(1)}%` : String(value));

function table(rows, columns) {
  if (!rows.length) return "  (none)";
  const cells = rows.map((row) =>
    columns.map(([key, fmt]) => String(fmt ? fmt(row[key]) : (row[key] ?? ""))),
  );
  const headers = columns.map(([key, , label]) => label ?? key);
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const line = (values) =>
    "  " +
    values
      .map((v, i) => v.padEnd(widths[i]))
      .join("  ")
      .trimEnd();
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...cells.map(line)].join("\n");
}

function valueRows(rows) {
  return typeof rows === "string" ? `  ${rows}` : table(rows, [["value"], ["n"]]);
}

function sectionText(title, data, body) {
  const head = `\n== ${title} ==`;
  if (data.status === "missing") {
    const what = data.columns ? `${data.table} (columns: ${data.columns.join(", ")})` : data.table;
    return `${head}\n  missing: ${what}`;
  }
  if (data.status === "error") return `${head}\n  error: ${data.error}`;
  return `${head}\n${body(data)}`;
}

export function formatHuman(result) {
  const { db, report, checks } = result;
  const out = [];
  out.push(`Memory health — ${db.path}`);
  out.push(
    `  file ${mb(db.fileBytes)}${db.walBytes !== null ? ` · wal ${mb(db.walBytes)}` : ""} · opened ${db.mode} · ${result.generatedAt}`,
  );
  out.push(
    sectionText("Store sizes", report.stores, (s) => {
      const lines = [
        `  total ${mb(s.totalBytes)} (${s.pageCount} pages × ${s.pageSize} B, ${s.freelistPages} free) · dbstat ${s.dbstat}`,
      ];
      if (s.dbstat === "ok") {
        lines.push(
          table(s.families, [
            ["name", null, "family"],
            ["bytes", mb, "size"],
          ]),
        );
        lines.push(table(s.top, [["name"], ["bytes", mb, "size"]]));
      }
      return lines.join("\n");
    }),
  );
  out.push(
    sectionText("Archive (memories)", report.archive, (a) =>
      [
        `  rows ${a.total} · older than 7d ${a.olderThan7d} · last 7d ${a.last7d}`,
        `  telemetry ratio ${pct(a.telemetryRatio)} (raw_event ${a.kinds.raw_event}, core_trace ${a.kinds.core_trace}, suggestion ${a.kinds.suggestion}, playbook ${a.kinds.playbook}, other ${a.kinds.other})`,
        `  duplicate rate ${pct(a.duplicateRate)} (${a.duplicateRows} rows)`,
        typeof a.perTaskLast7d === "object"
          ? `  per task, last 7d: ${a.perTaskLast7d.tasks} tasks, avg ${a.perTaskLast7d.avg}, max ${a.perTaskLast7d.max}`
          : `  per task: ${a.perTaskLast7d}`,
        typeof a.byTierAge === "string"
          ? `  tier: ${a.byTierAge}`
          : table(a.byTierAge, [["tier"], ["age"], ["n"]]),
      ].join("\n"),
    ),
  );
  out.push(
    sectionText("memory_items", report.memoryItems, (m) =>
      [
        `  rows ${m.total} · active ${m.active} · pinned ${m.pinned} · private ${m.private} · duplicate rate ${pct(m.duplicateRate)} (${m.duplicateRows} rows)`,
        "  by status:",
        valueRows(m.byStatus),
        "  active by source:",
        valueRows(m.activeBySource),
        "  active by scope:",
        valueRows(m.activeByScope),
        "  active by kind:",
        valueRows(m.activeByKind),
      ].join("\n"),
    ),
  );
  out.push(
    sectionText(
      "curated_memory_entries",
      report.curated,
      (c) => `  active ${c.active} of ${c.total}`,
    ),
  );
  out.push(
    sectionText(
      "pending_memory_writes",
      report.pendingWrites,
      (p) => `  total ${p.total} · pending ${p.pending}\n${valueRows(p.byStatus)}`,
    ),
  );
  out.push(
    sectionText(
      "core_memory_candidates",
      report.coreCandidates,
      (c) =>
        `  total ${c.total}\n${table(c.byTypeStatus, [["type"], ["status"], ["n"], ["distinctSummaries", null, "distinct"]])}`,
    ),
  );
  out.push(
    sectionText("Dreaming", report.dreaming, (d) =>
      [
        `  runs ${d.total} · last run ${d.lastRunAt ?? "never"} · stuck ${d.stuck}`,
        valueRows(d.byStatus),
        "  candidates:",
        valueRows(d.candidates),
      ].join("\n"),
    ),
  );
  out.push(
    sectionText("heartbeat_runs", report.heartbeat, (h) =>
      [
        `  runs ${h.total} · stuck running ${h.stuck}${h.oldestStuckAt ? ` (oldest ${h.oldestStuckAt})` : ""}`,
        table(h.byTypeStatus, [["runType", null, "run_type"], ["status"], ["n"]]),
      ].join("\n"),
    ),
  );
  out.push(
    sectionText("Conversation index", report.conversation, (c) =>
      [
        table(c.tables, [["table"], ["rows"]]),
        `  conversation_snapshot spans ${c.conversationSnapshotSpans}`,
      ].join("\n"),
    ),
  );
  out.push(
    sectionText(
      "memory_markdown_files",
      report.markdownFiles,
      (m) => `  files ${m.total}\n${table(m.byTopSegment, [["segment"], ["n"]])}`,
    ),
  );
  out.push(
    sectionText(
      "memory_embeddings",
      report.embeddings,
      (e) => `  rows ${e.total} · orphans ${e.orphans} (${pct(e.orphanRate)})`,
    ),
  );
  out.push(
    sectionText("maintenance_state markers", report.maintenance, (m) =>
      [
        table(m.markers, [
          ["key"],
          ["present", (v) => (v ? "yes" : "no")],
          ["updatedAt", (v) => v ?? "-", "updated"],
        ]),
        `  kit render states ${m.kitRenderStates}`,
      ].join("\n"),
    ),
  );
  out.push("\n== Checks ==");
  if (!checks.length) out.push("  none (report only; pass --ci or a threshold flag)");
  else {
    out.push(
      table(checks, [
        ["status", (v) => v.toUpperCase()],
        ["name", null, "check"],
        ["value", (v) => (v === null ? "-" : String(Math.round(v * 10000) / 10000))],
        ["op"],
        ["threshold"],
      ]),
    );
    const failed = checks.filter((c) => c.status === "fail");
    out.push(
      failed.length ? `\nFAILED: ${failed.map((c) => c.name).join(", ")}` : "\nAll checks passed.",
    );
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------------------

export function run(
  argv,
  { env = process.env, stdout = process.stdout, stderr = process.stderr } = {},
) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr.write(`memory-health: ${error.message}\n\n${HELP}`);
    return 2;
  }
  if (options.help) {
    stdout.write(HELP);
    return 0;
  }
  const dbPath = resolveDbPath(options, env);
  let stat;
  try {
    stat = statSync(dbPath);
    if (!stat.isFile()) throw new Error("not a file");
  } catch {
    stderr.write(`memory-health: database not found: ${dbPath}\n`);
    return 2;
  }
  let handle;
  try {
    handle = openReadOnly(dbPath, { snapshotLimitMb: options.snapshotLimitMb });
  } catch (error) {
    stderr.write(`memory-health: cannot open ${dbPath} read-only: ${error.message}\n`);
    return 2;
  }
  let report;
  let sideFilesCreated = [];
  try {
    report = collectReport(handle.db, options);
  } finally {
    sideFilesCreated = handle.close();
  }
  const walPath = `${dbPath}-wal`;
  const result = {
    generatedAt: new Date().toISOString(),
    db: {
      path: dbPath,
      mode: handle.mode,
      fileBytes: stat.size,
      walBytes: handle.walExisted && existsSync(walPath) ? statSync(walPath).size : null,
      sideFilesCreated,
    },
    thresholds: options.thresholds,
    stuckAfterMs: options.stuckAfterMs,
    report,
    checks: [],
    ok: true,
  };
  result.checks = evaluateChecks(report, options.thresholds, stat.size);
  result.ok = result.checks.every((check) => check.status !== "fail");
  stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : `${formatHuman(result)}\n`);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = run(process.argv.slice(2));
}
