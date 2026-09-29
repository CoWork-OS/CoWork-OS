#!/usr/bin/env node
// Disposable SQLite workload for the async SQLite migration baseline
// (DB0 in docs/async-sqlite-migration-plan-2026-09-27.md).
//
// Each scenario runs in its own child process against a fresh profile under the
// OS temp directory; nothing touches the user's profile. Sessions drive the real
// `AgentDaemon.logEvent` persistence path from the CLI build (`dist/cli`), with a
// deterministic provider stub standing in for model latency. The run records
// host event-loop delay, a setImmediate responsiveness probe, SQLite time and
// hot statements from the DB0 instrumentation, and event commit latency.
//
// Usage:
//   npm run qa:db:workload
//   node scripts/qa/sqlite-workload.mjs --tasks=1,8 --submitted=0 --lock-ms=0
//
// Options (defaults in brackets):
//   --tasks=<list>           active-task scenarios [1,8,20,40]
//   --submitted=<n>          admission scenario: tasks submitted at once, 0 to skip [50]
//   --max-concurrent=<n>     concurrency for the admission scenario [8]
//   --lock-ms=<n>            cross-process write-lock hold time, 0 to skip [2000]
//   --lock-tasks=<n>         active tasks during the lock scenario [8]
//   --steps=<n>              simulated agent steps per task [20]
//   --think-ms=<n>           mean stub model latency per step [40]
//   --tool-ms=<n>            mean stub tool latency per step [10]
//   --payload-kb=<n>         mean tool-result size [4]
//   --heavy-every=<n>        every Nth tool result is heavy, 0 to disable [25]
//   --heavy-kb=<n>           heavy tool-result size [64]
//   --seed-tasks=<n>         completed tasks in the historical fixture [200]
//   --seed-events=<n>        events per historical task [100]
//   --poll-ms=<n>            renderer-style reconciliation read interval [1000]
//   --seed=<n>               PRNG seed [1]
//   --dist=<path>            CLI build output [dist/cli]
//   --out=<path>             results JSON [logs/sqlite-workload/sqlite-workload-<stamp>.json]
//   --keep-profiles          keep the disposable profiles for inspection
//   --worker-timeline        run timeline projections in the database worker (DB3); throughput
//                            then counts events persisted, and the table also reports how long
//                            the worker needed afterwards to finish projecting
//   --all-domains            route every migrated domain to the database worker, with the
//                            reporting reader, as a default-on rollout would (DB7)
//   --trace-label=<text>     count call sites of statements whose fingerprint contains <text>
//                            (captures a stack per statement; slows the run, so compare
//                            timings only from untraced runs)
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHistogram, monitorEventLoopDelay, performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), "..", "..");

const DEFAULTS = {
  tasks: [1, 8, 20, 40],
  submitted: 50,
  maxConcurrent: 8,
  lockMs: 2000,
  lockTasks: 8,
  lockAtMs: 500,
  steps: 20,
  thinkMs: 40,
  toolMs: 10,
  payloadKb: 4,
  heavyEvery: 25,
  heavyKb: 64,
  seedTasks: 200,
  seedEvents: 100,
  pollMs: 1000,
  seed: 1,
  dist: "dist/cli",
  out: null,
  keepProfiles: false,
  traceLabel: null,
  workerTimeline: false,
  allDomains: false,
};

export function parseArgs(argv) {
  const options = { ...DEFAULTS, tasks: [...DEFAULTS.tasks] };
  const numberFlags = {
    "--submitted": "submitted",
    "--max-concurrent": "maxConcurrent",
    "--lock-ms": "lockMs",
    "--lock-tasks": "lockTasks",
    "--steps": "steps",
    "--think-ms": "thinkMs",
    "--tool-ms": "toolMs",
    "--payload-kb": "payloadKb",
    "--heavy-every": "heavyEvery",
    "--heavy-kb": "heavyKb",
    "--seed-tasks": "seedTasks",
    "--seed-events": "seedEvents",
    "--poll-ms": "pollMs",
    "--seed": "seed",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const separator = argv[i].indexOf("=");
    const flag = separator < 0 ? argv[i] : argv[i].slice(0, separator);
    const inline = separator < 0 ? undefined : argv[i].slice(separator + 1);
    const value = () => inline ?? argv[++i];
    if (flag === "--tasks") {
      options.tasks = value()
        .split(",")
        .map((entry) => Number(entry.trim()))
        .filter((entry) => Number.isInteger(entry) && entry > 0);
    } else if (flag in numberFlags) {
      const parsed = Number(value());
      if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Invalid value for ${flag}`);
      options[numberFlags[flag]] = parsed;
    } else if (flag === "--dist") options.dist = value();
    else if (flag === "--out") options.out = value();
    else if (flag === "--keep-profiles") options.keepProfiles = true;
    else if (flag === "--trace-label") options.traceLabel = value();
    else if (flag === "--worker-timeline") options.workerTimeline = true;
    else if (flag === "--all-domains") options.allDomains = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return options;
}

export function buildScenarios(options) {
  const scenarios = options.tasks.map((count) => ({
    name: `active-${count}`,
    kind: "active",
    activeTasks: count,
    submittedTasks: count,
    maxConcurrent: count,
    lockMs: 0,
  }));
  if (options.submitted > 0) {
    scenarios.push({
      name: `admission-${options.submitted}x${options.maxConcurrent}`,
      kind: "admission",
      activeTasks: Math.min(options.submitted, options.maxConcurrent),
      submittedTasks: options.submitted,
      maxConcurrent: options.maxConcurrent,
      lockMs: 0,
    });
  }
  if (options.lockMs > 0) {
    scenarios.push({
      name: `lock-${options.lockMs}ms-${options.lockTasks}`,
      kind: "lock",
      activeTasks: options.lockTasks,
      submittedTasks: options.lockTasks,
      maxConcurrent: options.lockTasks,
      lockMs: options.lockMs,
    });
  }
  return scenarios;
}

/** Deterministic PRNG (mulberry32). */
export function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Value around `mean` with ±50% uniform jitter. */
function jitter(random, mean) {
  return mean <= 0 ? 0 : Math.max(0, mean * (0.5 + random()));
}

function summarizeHistogram(histogram, scale) {
  if (histogram.count === 0) return { count: 0, p50Ms: 0, p90Ms: 0, p99Ms: 0, maxMs: 0, meanMs: 0 };
  const toMs = (value) => Math.round((value / scale) * 1000) / 1000;
  return {
    count: histogram.count,
    p50Ms: toMs(histogram.percentile(50)),
    p90Ms: toMs(histogram.percentile(90)),
    p99Ms: toMs(histogram.percentile(99)),
    maxMs: toMs(histogram.max),
    meanMs: toMs(histogram.mean),
  };
}

function fileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

// ---------------------------------------------------------------------------
// Child: one scenario on one disposable profile.
// ---------------------------------------------------------------------------

function holdWriteLock(dbPath, holdMs) {
  const holderSource = `
    const Database = require(${JSON.stringify(require.resolve("better-sqlite3"))});
    const db = new Database(${JSON.stringify(dbPath)});
    db.pragma("busy_timeout = 5000");
    db.exec("BEGIN IMMEDIATE");
    process.stdout.write("locked\\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${Number(holdMs)});
    db.exec("COMMIT");
    db.close();
    process.stdout.write("released\\n");
  `;
  return new Promise((resolveLock, rejectLock) => {
    const startedAt = performance.now();
    const events = {};
    const child = spawn(process.execPath, ["-e", holderSource], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      for (const line of String(chunk).split("\n")) {
        if (line === "locked") events.acquiredAt = performance.now();
        if (line === "released") events.releasedAt = performance.now();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectLock);
    child.on("exit", (code) => {
      if (code !== 0) rejectLock(new Error(`Lock holder exited ${code}: ${stderr.trim()}`));
      else resolveLock({ startedAt, ...events });
    });
  });
}

async function runChild(config) {
  const tempRoot = realpathSync(os.tmpdir());
  const profileDir = realpathSync(mkdtempSync(join(tempRoot, "cowork-sqlite-workload-")));
  if (!profileDir.startsWith(tempRoot)) throw new Error("Refusing to run outside the temp dir");
  // Isolation: the disposable profile is the only data directory this process can resolve.
  process.env.COWORK_USER_DATA_DIR = profileDir;
  delete process.env.COWORK_PROFILE;
  delete process.env.COWORK_PROFILE_ID;
  process.env.COWORK_LOG_LEVEL = process.env.COWORK_LOG_LEVEL || "error";
  process.env.COWORK_DB_INSTRUMENTATION = "1";
  if (config.options.workerTimeline || config.options.allDomains) {
    process.env.COWORK_DB_WORKER = "1";
    process.env.COWORK_DB_WORKER_TIMELINE = "1";
  }
  if (config.options.allDomains) {
    for (const flag of [
      "COWORK_DB_WORKER_STORAGE",
      "COWORK_DB_WORKER_SERVICES",
      "COWORK_DB_WORKER_MEMORY",
      "COWORK_DB_WORKER_MAILBOX",
      "COWORK_DB_WORKER_CONTROL_PLANE",
      "COWORK_DB_WORKER_REPORTS",
      "COWORK_DB_WORKER_SETTINGS",
    ]) {
      process.env[flag] = "1";
    }
  }

  const dist = resolve(REPO_ROOT, config.options.dist);
  const load = (path) => require(join(dist, path));
  const { DatabaseManager } = load("electron/database/schema.js");
  const { SecureSettingsRepository } = load("electron/database/SecureSettingsRepository.js");
  const {
    WorkspaceStore: WorkspaceRepository,
    TaskStore: TaskRepository,
    TaskEventRepository,
  } = load(
    "electron/database/repositories.js",
  );
  const instrumentation = load("electron/database/sqlite-instrumentation.js");
  const { AgentDaemon } = load("electron/agent/daemon.js");
  const databaseWorker = load("electron/database/async/runtime.js");
  const { MemoryService } = load("electron/memory/MemoryService.js");
  const { GuardrailManager } = load("electron/guardrails/guardrail-manager.js");
  const { AppearanceManager } = load("electron/settings/appearance-manager.js");
  const { PersonalityManager } = load("electron/settings/personality-manager.js");
  const { MemoryFeaturesManager } = load("electron/settings/memory-features-manager.js");

  const { options, scenario } = config;
  const random = createRandom(options.seed);
  const text = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ";
  const corpus = text.repeat(
    Math.ceil((Math.max(options.heavyKb, options.payloadKb) * 2048) / text.length),
  );
  const payload = (bytes) => {
    const length = Math.max(1, Math.min(corpus.length, Math.round(bytes)));
    const offset = Math.floor(random() * (corpus.length - length));
    return corpus.slice(offset, offset + length);
  };

  const dbManager = new DatabaseManager();
  const db = dbManager.getDatabase();
  new SecureSettingsRepository(db);
  const workspaceRepo = new WorkspaceRepository(db);
  const taskRepo = new TaskRepository(db);
  const eventRepo = new TaskEventRepository(db);
  const workspacePath = join(profileDir, "workspace");
  mkdirSync(workspacePath, { recursive: true });
  const workspace = workspaceRepo.create("SQLite workload", workspacePath, {
    read: true,
    write: true,
    delete: false,
    network: false,
    shell: false,
  });

  // Historical fixture: completed tasks with sized events, so reads and inserts
  // run against a profile that has been used.
  const seedStartedAt = performance.now();
  const seedTypes = ["assistant_message", "tool_call", "tool_result", "step_completed"];
  db.transaction(() => {
    for (let t = 0; t < options.seedTasks; t += 1) {
      const task = taskRepo.create({
        title: `Historical task ${t}`,
        prompt: "Historical workload fixture",
        status: "completed",
        workspaceId: workspace.id,
      });
      const baseTime = Date.now() - (options.seedTasks - t) * 60_000;
      for (let e = 0; e < options.seedEvents; e += 1) {
        const type = seedTypes[e % seedTypes.length];
        eventRepo.create({
          taskId: task.id,
          timestamp: baseTime + e,
          type,
          seq: e + 1,
          payload:
            type === "tool_result"
              ? { tool: "read_file", result: payload(jitter(random, options.payloadKb * 1024)) }
              : { message: payload(jitter(random, 300)) },
        });
      }
    }
  })();
  const seedMs = performance.now() - seedStartedAt;

  const tasks = [];
  for (let t = 0; t < scenario.submittedTasks; t += 1) {
    tasks.push(
      taskRepo.create({
        title: `Workload task ${t}`,
        prompt: "Simulated agent session",
        status: scenario.kind === "admission" ? "queued" : "executing",
        workspaceId: workspace.id,
      }),
    );
  }

  // Same initialization order as the direct CLI, so memory capture runs as in production.
  GuardrailManager.initialize();
  AppearanceManager.initialize();
  PersonalityManager.initialize();
  MemoryFeaturesManager.initialize();
  MemoryService.initialize(dbManager);
  let workerClient = null;
  if (options.workerTimeline || options.allDomains) {
    const client = await databaseWorker.startDatabaseWorker({
      dbPath: dbManager.getDatabasePath(),
      runtime: "cli",
    });
    if (!client) throw new Error("Database worker did not start");
    workerClient = client;
    if (options.allDomains) {
      const reader = await databaseWorker.startReportingReader({
        dbPath: dbManager.getDatabasePath(),
        runtime: "cli",
      });
      if (!reader) throw new Error("Reporting reader did not start");
    }
  }
  const daemon = new AgentDaemon(dbManager, { startupRecovery: false });
  // Selects the timeline projection backend for this run, as the runtimes do.
  await daemon.initialize();
  const slowOperations = [];
  const traces = new Map();
  instrumentation.configureSqliteInstrumentation({
    // Tracing reports every operation as "slow" so each one carries a call site.
    ...(options.traceLabel ? { slowOperationMs: 0 } : {}),
    onSlowOperation: (operation) => {
      if (options.traceLabel) {
        if (!operation.label.includes(options.traceLabel)) return;
        const site = operation.callSite.slice(0, 3).join(" < ");
        traces.set(site, (traces.get(site) ?? 0) + 1);
        return;
      }
      if (slowOperations.length < 50) slowOperations.push(operation);
    },
  });

  let eventsLogged = 0;
  let logErrors = 0;
  let firstLogError = null;
  const logEvent = (taskId, type, eventPayload) => {
    try {
      daemon.logEvent(taskId, type, eventPayload);
      if (type !== "llm_streaming") eventsLogged += 1;
    } catch (error) {
      logErrors += 1;
      firstLogError ??= error instanceof Error ? error.message : String(error);
    }
  };

  let toolResults = 0;
  const runSession = async (task, sessionIndex) => {
    const sessionRandom = createRandom(options.seed * 1000 + sessionIndex);
    for (let step = 0; step < options.steps; step += 1) {
      const stepInfo = { id: `step-${step}`, description: `Simulated step ${step}` };
      logEvent(task.id, "step_started", { step: stepInfo });
      for (let chunk = 0; chunk < 3; chunk += 1) {
        await sleep(jitter(sessionRandom, options.thinkMs / 4));
        logEvent(task.id, "llm_streaming", { message: "Thinking..." });
      }
      await sleep(jitter(sessionRandom, options.thinkMs));
      logEvent(task.id, "llm_usage", {
        providerType: "workload-stub",
        modelKey: "workload-stub",
        modelId: "workload-stub-model",
        delta: {
          inputTokens: 1000 + Math.floor(sessionRandom() * 4000),
          outputTokens: 100 + Math.floor(sessionRandom() * 900),
          cachedTokens: 0,
        },
      });
      logEvent(task.id, "assistant_message", { message: payload(jitter(sessionRandom, 400)) });
      const toolCallId = `${task.id}-tool-${step}`;
      logEvent(task.id, "tool_call", {
        tool: "read_file",
        toolCallId,
        input: { path: `src/file-${step}.ts` },
      });
      await sleep(jitter(sessionRandom, options.toolMs));
      toolResults += 1;
      const heavy = options.heavyEvery > 0 && toolResults % options.heavyEvery === 0;
      const resultBytes =
        (heavy ? options.heavyKb : jitter(sessionRandom, options.payloadKb)) * 1024;
      logEvent(task.id, "tool_result", {
        tool: "read_file",
        toolCallId,
        result: payload(resultBytes),
      });
      logEvent(task.id, "step_completed", { step: stepInfo });
    }
    logEvent(task.id, "task_completed", { message: "Simulated session finished" });
  };

  // Measurement window.
  instrumentation.resetSqliteInstrumentation();
  if (workerClient) await workerClient.execute("diagnostics.sqliteSnapshot", { reset: true });
  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  eventLoop.enable();
  const utilizationStart = performance.eventLoopUtilization();
  const probe = createHistogram();
  let probing = true;
  const scheduleProbe = () => {
    if (!probing) return;
    const scheduledAt = performance.now();
    setImmediate(() => {
      probe.record(Math.max(1, Math.round((performance.now() - scheduledAt) * 1000)));
      setTimeout(scheduleProbe, 20);
    });
  };
  scheduleProbe();

  // Renderer-style reconciliation read for a selected task.
  let pollReads = 0;
  const poller =
    options.pollMs > 0
      ? setInterval(() => {
          const selected = tasks[pollReads % tasks.length];
          taskRepo.findById(selected.id);
          eventRepo.findRecentByTaskId(selected.id, 600);
          pollReads += 1;
        }, options.pollMs)
      : null;

  const lockPromise =
    scenario.lockMs > 0
      ? sleep(options.lockAtMs).then(() =>
          holdWriteLock(join(profileDir, "cowork-os.db"), scenario.lockMs),
        )
      : null;

  const startedAt = performance.now();
  let nextTask = 0;
  const worker = async () => {
    while (nextTask < tasks.length) {
      const index = nextTask;
      nextTask += 1;
      if (scenario.kind === "admission") taskRepo.update(tasks[index].id, { status: "executing" });
      await runSession(tasks[index], index);
    }
  };
  await Promise.all(Array.from({ length: scenario.maxConcurrent }, () => worker()));
  const lock = lockPromise ? await lockPromise : null;
  const wallMs = performance.now() - startedAt;
  // With worker projections, measure how long derived state trails the last insert.
  const projectionStartedAt = performance.now();
  await daemon.flushTimelineProjections();
  const projectionLagMs = performance.now() - projectionStartedAt;

  probing = false;
  if (poller) clearInterval(poller);
  eventLoop.disable();
  const utilization = performance.eventLoopUtilization(utilizationStart);
  const sqlite = instrumentation.getSqliteInstrumentationSnapshot({ topLabels: 15 });
  const workerSqlite = workerClient
    ? await workerClient.execute("diagnostics.sqliteSnapshot", { topLabels: 15 })
    : null;

  const placeholders = tasks.map(() => "?").join(", ");
  const eventsPersisted = db
    .prepare(`SELECT COUNT(*) AS total FROM task_events WHERE task_id IN (${placeholders})`)
    .get(...tasks.map((task) => task.id)).total;
  const eventRowsTotal = db.prepare("SELECT COUNT(*) AS total FROM task_events").get().total;
  const sqliteVersion = db.prepare("SELECT sqlite_version() AS version").get().version;
  const dbPath = join(profileDir, "cowork-os.db");
  const memory = process.memoryUsage();

  const result = {
    name: scenario.name,
    kind: scenario.kind,
    activeTasks: scenario.activeTasks,
    submittedTasks: scenario.submittedTasks,
    maxConcurrent: scenario.maxConcurrent,
    steps: options.steps,
    wallMs: Math.round(wallMs),
    projectionLagMs: Math.round(projectionLagMs),
    workerTimeline: options.workerTimeline,
    allDomains: options.allDomains,
    eventsLogged,
    eventsPersisted,
    eventsPerSecond: Math.round((eventsPersisted / (wallMs / 1000)) * 10) / 10,
    logErrors,
    firstLogError,
    pollReads,
    eventLoop: {
      ...summarizeHistogram(eventLoop, 1e6),
      utilization: Math.round(utilization.utilization * 1000) / 1000,
    },
    probe: summarizeHistogram(probe, 1000),
    timeline: {
      insert: sqlite.hostOperations["timeline.insert"] ?? null,
      persist: sqlite.hostOperations["timeline.persist"] ?? null,
    },
    sqlite: {
      hostMs: sqlite.hostMs,
      hostShare: Math.round((sqlite.hostMs / wallMs) * 1000) / 1000,
      topLevelOperations: sqlite.topLevelOperations,
      slowOperations: sqlite.slowOperations,
      errors: sqlite.errors,
      busyErrors: sqlite.busyErrors,
      byKind: sqlite.byKind,
      top: sqlite.labels,
    },
    slowOperations,
    worker: workerSqlite
      ? {
          sqliteMs: workerSqlite.hostMs,
          topLevelOperations: workerSqlite.topLevelOperations,
          top: workerSqlite.labels,
        }
      : null,
    traces: Array.from(traces, ([site, count]) => ({ site, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 25),
    lock: lock
      ? {
          holdMs: scenario.lockMs,
          acquiredAtMs: lock.acquiredAt ? Math.round(lock.acquiredAt - startedAt) : null,
          releasedAtMs: lock.releasedAt ? Math.round(lock.releasedAt - startedAt) : null,
        }
      : null,
    fixture: {
      seedTasks: options.seedTasks,
      seedEventsPerTask: options.seedEvents,
      seedMs: Math.round(seedMs),
      eventRowsTotal,
      dbBytes: fileSize(dbPath),
      walBytes: fileSize(`${dbPath}-wal`),
    },
    sqliteVersion,
    rssMb: Math.round(memory.rss / 1048576),
    heapUsedMb: Math.round(memory.heapUsed / 1048576),
    profileDir: options.keepProfiles ? profileDir : null,
  };

  await Promise.race([daemon.shutdown().catch(() => undefined), sleep(5000)]);
  await databaseWorker.stopDatabaseWorker().catch(() => undefined);
  dbManager.close();
  if (!options.keepProfiles) rmSync(profileDir, { recursive: true, force: true });
  writeFileSync(config.resultPath, JSON.stringify(result));
}

// ---------------------------------------------------------------------------
// Parent: metadata, scenario orchestration, and reporting.
// ---------------------------------------------------------------------------

function git(args) {
  try {
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function collectMetadata(options) {
  const cpus = os.cpus();
  const betterSqlite3 = JSON.parse(
    readFileSync(join(REPO_ROOT, "node_modules", "better-sqlite3", "package.json"), "utf8"),
  );
  const status = git(["status", "--porcelain"]);
  return {
    generatedAt: new Date().toISOString(),
    revision: {
      sha: git(["rev-parse", "HEAD"]),
      dirty: status === null ? null : status.length > 0,
    },
    node: process.version,
    nodeAbi: process.versions.modules,
    betterSqlite3: betterSqlite3.version,
    platform: `${process.platform}-${process.arch}`,
    osRelease: os.release(),
    cpu: { model: cpus[0]?.model ?? "unknown", count: cpus.length },
    memoryGb: Math.round((os.totalmem() / 1073741824) * 10) / 10,
    options,
  };
}

function runScenarioProcess(options, scenario, resultPath) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      process.execPath,
      [SCRIPT_PATH, "--child", JSON.stringify({ options, scenario, resultPath })],
      { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } },
    );
    // Application logs stay out of the report unless the scenario fails.
    let output = "";
    const collect = (chunk) => {
      output = (output + chunk).slice(-20_000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", rejectRun);
    child.on("exit", (code) => {
      if (code === 0 && existsSync(resultPath)) {
        resolveRun(JSON.parse(readFileSync(resultPath, "utf8")));
      } else {
        const tail = output.split("\n").slice(-40).join("\n");
        rejectRun(new Error(`Scenario ${scenario.name} failed (exit ${code}):\n${tail}`));
      }
    });
  });
}

function formatSummary(results) {
  const header = [
    "scenario",
    "events",
    "ev/s",
    "loop p99",
    "loop max",
    "probe p99",
    "insert p95",
    "persist p95",
    "persist p99",
    "SQLite ms (share)",
    "proj. lag",
    "slow",
    "busy",
  ];
  const rows = results.map((result) => [
    result.name,
    String(result.eventsPersisted),
    String(result.eventsPerSecond),
    `${result.eventLoop.p99Ms}ms`,
    `${result.eventLoop.maxMs}ms`,
    `${result.probe.p99Ms}ms`,
    `${result.timeline.insert?.p95Ms ?? 0}ms`,
    `${result.timeline.persist?.p95Ms ?? 0}ms`,
    `${result.timeline.persist?.p99Ms ?? 0}ms`,
    `${Math.round(result.sqlite.hostMs)} (${Math.round(result.sqlite.hostShare * 100)}%)`,
    `${result.projectionLagMs ?? 0}ms`,
    String(result.sqlite.slowOperations),
    String(result.sqlite.busyErrors),
  ]);
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map((row) => row[index].length)),
  );
  const format = (row) => row.map((cell, index) => cell.padEnd(widths[index])).join("  ");
  return [
    format(header),
    format(widths.map((width) => "-".repeat(width))),
    ...rows.map(format),
  ].join("\n");
}

async function runParent(argv) {
  const options = parseArgs(argv);
  const daemonPath = resolve(REPO_ROOT, options.dist, "electron/agent/daemon.js");
  if (!existsSync(daemonPath)) {
    throw new Error(
      `Missing ${daemonPath}. Run "npm run build:cli" first (qa:db:workload does this).`,
    );
  }
  const metadata = collectMetadata(options);
  const scratch = mkdtempSync(join(realpathSync(os.tmpdir()), "cowork-sqlite-workload-results-"));
  const results = [];
  try {
    for (const scenario of buildScenarios(options)) {
      process.stdout.write(`Running ${scenario.name}...\n`);
      results.push(
        await runScenarioProcess(options, scenario, join(scratch, `${scenario.name}.json`)),
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const stamp = metadata.generatedAt.replace(/[:.]/g, "-");
  const outPath = resolve(
    REPO_ROOT,
    options.out ?? join("logs", "sqlite-workload", `sqlite-workload-${stamp}.json`),
  );
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    `${JSON.stringify({ metadata: { ...metadata, sqliteVersion: results[0]?.sqliteVersion ?? null }, results }, null, 2)}\n`,
  );
  process.stdout.write(
    `\n${metadata.revision.sha ?? "unknown"}${metadata.revision.dirty ? " (dirty)" : ""} · node ${metadata.node} (ABI ${metadata.nodeAbi}) · better-sqlite3 ${metadata.betterSqlite3} · ${metadata.cpu.model} x${metadata.cpu.count}\n\n`,
  );
  process.stdout.write(`${formatSummary(results)}\n\nResults: ${outPath}\n`);
  if (options.traceLabel) {
    for (const result of results) {
      process.stdout.write(`\nCall sites for "${options.traceLabel}" in ${result.name}:\n`);
      for (const trace of result.traces)
        process.stdout.write(`  ${String(trace.count).padStart(7)}  ${trace.site}\n`);
    }
  }
  const failures = results.filter((result) => result.logErrors > 0);
  if (failures.length > 0) {
    for (const failure of failures) {
      process.stderr.write(
        `${failure.name}: ${failure.logErrors} logEvent errors (${failure.firstLogError})\n`,
      );
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const childIndex = process.argv.indexOf("--child");
  const run =
    childIndex >= 0
      ? // Daemon services leave timers behind; the child exits once its result is written.
        runChild(JSON.parse(process.argv[childIndex + 1])).then(() => process.exit(0))
      : runParent(process.argv.slice(2));
  run.catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
