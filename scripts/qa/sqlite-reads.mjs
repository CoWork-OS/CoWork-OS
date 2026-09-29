#!/usr/bin/env node
// Heavy-read benchmark for the async SQLite migration (DB4 in
// docs/async-sqlite-migration-plan-2026-09-27.md). Seeds a large disposable profile
// (a heavy user's history) under the OS temp directory, then times candidate read and
// maintenance paths as they run on the host today, so DB4 moves the ones that matter.
//
// Usage:
//   npm run qa:db:reads
//   node scripts/qa/sqlite-reads.mjs --tasks=500 --events=50 --long-events=5000
//
// Options (defaults in brackets):
//   --tasks=<n>          completed historical tasks [2000]
//   --events=<n>         events per historical task [100]
//   --long-events=<n>    events in one long session [15000]
//   --llm-calls=<n>      usage rows [50000]
//   --memories=<n>       memories with embeddings [20000]
//   --runs=<n>           timed repetitions per read [5]
//   --worker             run DB4 paths: reports in the reporting reader, rollups and
//                        maintenance in the database worker, memory search in the FTS worker
//   --keep               keep the seeded profile and print its path (for query analysis)
//   --dist=<path>        CLI build output [dist/cli]
//   --out=<path>         results JSON [logs/sqlite-reads/sqlite-reads-<stamp>.json]
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
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), "..", "..");

const DEFAULTS = {
  tasks: 2000,
  events: 100,
  longEvents: 15000,
  llmCalls: 50000,
  memories: 20000,
  runs: 5,
  worker: false,
  keep: false,
  dist: "dist/cli",
  out: null,
};

export function parseArgs(argv) {
  const options = { ...DEFAULTS };
  const numbers = {
    "--tasks": "tasks",
    "--events": "events",
    "--long-events": "longEvents",
    "--llm-calls": "llmCalls",
    "--memories": "memories",
    "--runs": "runs",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const separator = argv[i].indexOf("=");
    const flag = separator < 0 ? argv[i] : argv[i].slice(0, separator);
    const inline = separator < 0 ? undefined : argv[i].slice(separator + 1);
    const value = () => inline ?? argv[++i];
    if (flag in numbers) {
      const parsed = Number(value());
      if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Invalid value for ${flag}`);
      options[numbers[flag]] = Math.floor(parsed);
    } else if (flag === "--worker") options.worker = true;
    else if (flag === "--keep") options.keep = true;
    else if (flag === "--dist") options.dist = value();
    else if (flag === "--out") options.out = value();
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return options;
}

/** Deterministic PRNG (mulberry32). */
function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

const round = (value) => Math.round(value * 10) / 10;

function fileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Child: seed and measure.
// ---------------------------------------------------------------------------

async function runChild(config) {
  const tempRoot = realpathSync(os.tmpdir());
  const profileDir = realpathSync(mkdtempSync(join(tempRoot, "cowork-sqlite-reads-")));
  if (!profileDir.startsWith(tempRoot)) throw new Error("Refusing to run outside the temp dir");
  process.env.COWORK_USER_DATA_DIR = profileDir;
  delete process.env.COWORK_PROFILE;
  delete process.env.COWORK_PROFILE_ID;
  process.env.COWORK_LOG_LEVEL = process.env.COWORK_LOG_LEVEL || "error";

  const { options } = config;
  const dist = resolve(REPO_ROOT, options.dist);
  const load = (path) => require(join(dist, path));
  const { DatabaseManager } = load("electron/database/schema.js");
  const { SecureSettingsRepository } = load("electron/database/SecureSettingsRepository.js");
  const repos = load("electron/database/repositories.js");
  const { ActivityRepository } = load("electron/activity/ActivityRepository.js");
  // The database worker's commands pull the report modules into dist/cli (DB4).
  const { UsageInsightsService } = load("electron/reports/UsageInsightsService.js");
  const { UsageInsightsProjector } = load("electron/reports/UsageInsightsProjector.js");
  const runtime = load("electron/database/async/runtime.js");
  const { FtsWorkerClient } = load("electron/database/FtsWorkerClient.js");
  const { configureSqliteInstrumentation } = load("electron/database/sqlite-instrumentation.js");
  const { prepareLlmCallSuccess } = load("electron/agent/llm/usage-telemetry.js");
  const { insertLlmCallRow } = load("electron/database/llm-call-events.js");
  const { createLocalEmbedding } = load("electron/memory/local-embedding.js");
  const { MemoryService } = load("electron/memory/MemoryService.js");
  const { MemoryFeaturesManager } = load("electron/settings/memory-features-manager.js");
  const { AgentDaemon } = load("electron/agent/daemon.js");

  const random = createRandom(7);
  const words =
    "release notes deploy database worker latency timeline approval session memory search report cost usage budget planner verify patch build failure retry".split(
      " ",
    );
  const sentence = (count) =>
    Array.from({ length: count }, () => words[Math.floor(random() * words.length)]).join(" ");
  const text = "lorem ipsum dolor sit amet consectetur adipiscing elit ";
  const corpus = text.repeat(200);
  const payload = (bytes) =>
    corpus.slice(0, Math.max(1, Math.min(corpus.length, Math.round(bytes))));

  let dbManager = new DatabaseManager();
  let db = dbManager.getDatabase();
  new SecureSettingsRepository(db);
  const workspaceRepo = new repos.WorkspaceStore(db);
  const taskRepo = new repos.TaskStore(db);
  const eventRepo = new repos.TaskEventRepository(db);
  const activityRepo = new ActivityRepository(db);
  const memoryRepo = new repos.MemoryStore(db);
  const embeddingRepo = new repos.MemoryEmbeddingStore(db);
  const workspacePath = join(profileDir, "workspace");
  mkdirSync(workspacePath, { recursive: true });
  const workspace = workspaceRepo.create("Reads", workspacePath, {
    read: true,
    write: true,
    delete: false,
    network: false,
    shell: false,
  });

  const seedStartedAt = performance.now();
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const eventTypes = [
    "assistant_message",
    "tool_call",
    "tool_result",
    "step_completed",
    "llm_usage",
  ];
  const taskIds = [];
  const seedTask = (title, createdAt, eventCount) => {
    const task = taskRepo.create({
      title,
      prompt: sentence(12),
      status: "completed",
      workspaceId: workspace.id,
    });
    db.prepare(
      "UPDATE tasks SET created_at = ?, updated_at = ?, completed_at = ? WHERE id = ?",
    ).run(createdAt, createdAt, createdAt + eventCount * 1000, task.id);
    for (let index = 0; index < eventCount; index += 1) {
      const type = eventTypes[index % eventTypes.length];
      eventRepo.create({
        taskId: task.id,
        timestamp: createdAt + index * 1000,
        type,
        seq: index + 1,
        payload:
          type === "tool_result"
            ? { tool: "read_file", result: payload(2000 * (0.5 + random())) }
            : type === "llm_usage"
              ? {
                  providerType: "openai",
                  modelId: "gpt-5.4",
                  delta: { inputTokens: 1200, outputTokens: 300 },
                }
              : { message: sentence(40) },
      });
    }
    taskIds.push(task.id);
    return task.id;
  };
  db.transaction(() => {
    for (let t = 0; t < options.tasks; t += 1) {
      seedTask(`Task ${t}`, now - Math.floor(random() * 90) * dayMs, options.events);
    }
  })();
  const longTaskId = db.transaction(() =>
    seedTask("Long session", now - dayMs, options.longEvents),
  )();
  db.transaction(() => {
    for (let i = 0; i < options.llmCalls; i += 1) {
      insertLlmCallRow(
        db,
        prepareLlmCallSuccess(
          {
            workspaceId: workspace.id,
            taskId: taskIds[i % taskIds.length],
            sourceKind: "task_event",
            providerType: "openai",
            modelId: "gpt-5.4",
            timestamp: now - Math.floor(random() * 90 * dayMs),
          },
          {
            inputTokens: 1000 + Math.floor(random() * 5000),
            outputTokens: 200 + Math.floor(random() * 800),
          },
        ),
      );
    }
    for (let i = 0; i < 10000; i += 1) {
      activityRepo.create({
        workspaceId: workspace.id,
        taskId: taskIds[i % taskIds.length],
        actorType: "agent",
        activityType: "tool_used",
        title: sentence(6),
      });
    }
    for (let i = 0; i < options.memories; i += 1) {
      const content = sentence(60);
      const memory = memoryRepo.create({
        workspaceId: workspace.id,
        taskId: taskIds[i % taskIds.length],
        type: "observation",
        content,
        summary: sentence(12),
        tokens: 80,
        isCompressed: true,
        isPrivate: false,
      });
      embeddingRepo.upsert(workspace.id, memory.id, createLocalEmbedding(content));
    }
  })();
  const seedMs = performance.now() - seedStartedAt;
  const dbPath = join(profileDir, "cowork-os.db");

  // Measurement helpers: wall time plus the longest event-loop stall around each call.
  const results = [];
  // Host statements of 50 ms or more, tagged with the phase they ran in.
  let phase = "setup";
  const slowHostStatements = [];
  configureSqliteInstrumentation({
    slowOperationMs: 50,
    onSlowOperation: (operation) =>
      slowHostStatements.push({
        phase,
        ms: round(operation.durationMs),
        label: operation.label.slice(0, 140),
        callSite: operation.callSite.slice(0, 2),
      }),
  });
  let peakRssBytes = 0;
  let peakWalBytes = 0;
  const resourceSampler = setInterval(() => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    peakWalBytes = Math.max(peakWalBytes, fileSize(`${dbPath}-wal`));
  }, 50);
  const measure = async (name, runs, fn) => {
    phase = name;
    const durations = [];
    let size = null;
    const loop = monitorEventLoopDelay({ resolution: 5 });
    loop.enable();
    for (let run = 0; run < runs; run += 1) {
      const startedAt = performance.now();
      const value = await fn(run);
      durations.push(performance.now() - startedAt);
      if (size === null) {
        size = Array.isArray(value)
          ? value.length
          : value && typeof value === "object"
            ? Object.keys(value).length
            : null;
      }
      await new Promise((resolveTick) => setTimeout(resolveTick, 5));
    }
    loop.disable();
    results.push({
      name,
      runs,
      p50Ms: round(percentile(durations, 0.5)),
      maxMs: round(Math.max(...durations)),
      loopMaxMs: round(loop.max / 1e6),
      size,
    });
  };

  // Startup: reopening a large profile runs schema initialization on the host.
  dbManager.close();
  await measure("startup: DatabaseManager open (schema init)", 1, () => {
    dbManager = new DatabaseManager();
    db = dbManager.getDatabase();
    new SecureSettingsRepository(db);
    return null;
  });
  let writer = null;
  let reader = null;
  let ftsWorker = null;
  if (options.worker) {
    process.env.COWORK_DB_WORKER = "1";
    process.env.COWORK_DB_WORKER_REPORTS = "1";
    writer = await runtime.startDatabaseWorker({ dbPath, runtime: "cli" });
    reader = await runtime.startReportingReader({ dbPath, runtime: "cli" });
    if (!writer || !reader) throw new Error("Database worker or reporting reader did not start");
  }
  const mode = options.worker ? "worker" : "host";
  await measure(`startup: runPostStartupMaintenance (${mode})`, 1, () =>
    dbManager.runPostStartupMaintenance({ client: writer }),
  );

  const events = new repos.TaskEventRepository(db);
  await measure("timeline: latest page (200) of long session", options.runs, () =>
    events.findTimelinePage({ taskId: longTaskId, limit: 200 }),
  );
  await measure("timeline: 5 pages back of long session", options.runs, () => {
    let page = events.findTimelinePage({ taskId: longTaskId, limit: 200 });
    for (let i = 0; i < 4 && page.nextCursor; i += 1) {
      page = events.findTimelinePage({ taskId: longTaskId, limit: 200, cursor: page.nextCursor });
    }
    return page.events;
  });
  await measure("timeline: recent 600 of long session", options.runs, () =>
    events.findRecentByTaskId(longTaskId, 600),
  );
  await measure("timeline: full history of long session (resume/replay)", options.runs, () =>
    events.findByTaskId(longTaskId),
  );

  const usage = new UsageInsightsService(db);
  const report = (workspaceId, days) =>
    reader ? usage.generateInReader(reader, workspaceId, days) : usage.generate(workspaceId, days);
  await measure(`usage insights: raw window 7 days, no projector (${mode})`, options.runs, () =>
    report(null, 7),
  );
  await measure(`usage insights: raw window 30 days, no projector (${mode})`, options.runs, () =>
    report(null, 30),
  );
  await measure(`usage insights: raw window 365 days, no projector (${mode})`, 2, () =>
    report(null, 365),
  );

  // Responsiveness under a deliberately slow query: a 365-day raw report runs while
  // the host serves 5 ms timer ticks, standing in for IPC.
  {
    let last = performance.now();
    let maxGap = 0;
    const ticker = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 5);
    const startedAt = performance.now();
    await report(null, 365);
    clearInterval(ticker);
    // A synchronous report blocks the ticker until it returns; count that last gap too.
    maxGap = Math.max(maxGap, performance.now() - last);
    results.push({
      name: `responsiveness: 5 ms ticks during a 365-day raw report (${mode})`,
      runs: 1,
      p50Ms: round(performance.now() - startedAt),
      maxMs: round(performance.now() - startedAt),
      loopMaxMs: round(maxGap),
      size: null,
    });
  }

  // Cancellation: abort a report queued behind a slow one; the reader drops it unrun.
  if (reader) {
    const controller = new AbortController();
    const slow = report(null, 365);
    const queued = usage.generateInReader(reader, null, 30, { signal: controller.signal });
    controller.abort();
    const outcome = await queued.then(
      () => "completed",
      (error) => error?.code ?? "failed",
    );
    await slow;
    results.push({
      name: "cancellation: queued report aborted behind a slow one",
      runs: 1,
      p50Ms: 0,
      maxMs: 0,
      loopMaxMs: 0,
      size: outcome,
    });
  }

  const projector = UsageInsightsProjector.initialize(db);
  if (writer && reader) projector.attachDatabaseWorkers(Promise.resolve({ writer, reader }));
  const backfillLoop = monitorEventLoopDelay({ resolution: 5 });
  backfillLoop.enable();
  phase = "usage insights: projector backfill";
  const backfillStartedAt = performance.now();
  projector.warm();
  while (!projector.isBackfillComplete() && performance.now() - backfillStartedAt < 120_000) {
    await new Promise((resolveTick) => setTimeout(resolveTick, 20));
  }
  backfillLoop.disable();
  results.push({
    name: `usage insights: projector backfill (${mode})`,
    runs: 1,
    p50Ms: round(performance.now() - backfillStartedAt),
    maxMs: round(performance.now() - backfillStartedAt),
    loopMaxMs: round(backfillLoop.max / 1e6),
    size: projector.isBackfillComplete() ? "complete" : "incomplete",
  });
  await measure(
    `usage insights: 30 days with projector, first then cached (${mode})`,
    options.runs,
    () => report(null, 30),
  );
  await measure(`usage insights: 365 days with projector (${mode})`, 2, () => report(null, 365));

  // Parity: the same plan computed on the host connection and where this mode runs it.
  const parity = {};
  {
    const strip = ({ generatedAt: _g, periodStart: _s, periodEnd: _e, ...rest }) =>
      JSON.stringify(rest);
    const plan = projector.isBackfillComplete() ? { kind: "fast" } : null;
    if (plan && reader) {
      // One pinned instant: the fixture's events are a second apart on day boundaries.
      const nowMs = Date.now();
      const host = usage.generateWithPlan(null, 30, plan, nowMs);
      const worker = await reader.execute("usage.generateReport", {
        workspaceId: null,
        periodDays: 30,
        plan,
        nowMs,
      });
      parity.usageReport30d = strip(host) === strip(worker);
      if (!parity.usageReport30d) {
        const a = JSON.parse(strip(host));
        const b = JSON.parse(strip(worker));
        parity.usageReport30dDiffKeys = Object.keys(a).filter(
          (key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]),
        );
        parity.usageReport30dDiffSample = Object.fromEntries(
          parity.usageReport30dDiffKeys.map((key) => [
            key,
            {
              host: JSON.stringify(a[key]).slice(0, 300),
              worker: JSON.stringify(b[key]).slice(0, 300),
            },
          ]),
        );
      }
    }
  }

  MemoryFeaturesManager.initialize();
  MemoryService.initialize(dbManager);
  if (options.worker) {
    ftsWorker = new FtsWorkerClient(dbPath);
    MemoryService.initFtsWorker(ftsWorker);
  }
  const memoryQuery = (run) =>
    `${words[run % words.length]} ${words[(run + 3) % words.length]} latency`;
  await measure(
    `memory: hybrid search (${options.worker ? "FTS worker" : "sync, host"})`,
    options.runs,
    (run) =>
      options.worker
        ? MemoryService.searchAsync(workspace.id, memoryQuery(run), 20)
        : MemoryService.search(workspace.id, memoryQuery(run), 20),
  );
  if (ftsWorker) {
    let same = 0;
    for (let run = 0; run < options.runs; run += 1) {
      const host = MemoryService.search(workspace.id, memoryQuery(run), 20).map((r) => r.id);
      const worker = (await MemoryService.searchAsync(workspace.id, memoryQuery(run), 20)).map(
        (r) => r.id,
      );
      if (JSON.stringify(host) === JSON.stringify(worker)) same += 1;
    }
    parity.memorySearchIdenticalRuns = `${same}/${options.runs}`;
  }

  const daemon = new AgentDaemon(dbManager, { startupRecovery: false });
  await measure("history: queryTaskEvents last 30 days", options.runs, () =>
    daemon.queryTaskEvents({ period: "last_30_days", limit: 200 }),
  );

  clearInterval(resourceSampler);
  const result = {
    mode,
    parity,
    slowHostStatements,
    resources: {
      peakRssMb: Math.round(peakRssBytes / 1048576),
      peakWalMb: round(peakWalBytes / 1048576),
    },
    fixture: {
      tasks: options.tasks,
      eventsPerTask: options.events,
      longSessionEvents: options.longEvents,
      llmCalls: options.llmCalls,
      memories: options.memories,
      seedMs: Math.round(seedMs),
      dbBytes: fileSize(dbPath),
      keptProfile: options.keep ? profileDir : null,
      walBytes: fileSize(`${dbPath}-wal`),
    },
    results,
  };
  await Promise.race([
    daemon.shutdown().catch(() => undefined),
    new Promise((r) => setTimeout(r, 5000)),
  ]);
  await UsageInsightsProjector.shutdown().catch(() => undefined);
  ftsWorker?.destroy();
  await runtime.stopDatabaseWorker(5_000).catch(() => undefined);
  dbManager.close();
  if (!options.keep) rmSync(profileDir, { recursive: true, force: true });
  writeFileSync(config.resultPath, JSON.stringify(result));
}

// ---------------------------------------------------------------------------
// Parent.
// ---------------------------------------------------------------------------

function git(args) {
  try {
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

async function runParent(argv) {
  const options = parseArgs(argv);
  if (!existsSync(resolve(REPO_ROOT, options.dist, "electron/agent/daemon.js"))) {
    throw new Error(
      `Missing ${options.dist}. Run "npm run build:cli" first (qa:db:reads does this).`,
    );
  }
  const scratch = mkdtempSync(join(realpathSync(os.tmpdir()), "cowork-sqlite-reads-results-"));
  const resultPath = join(scratch, "result.json");
  try {
    await new Promise((resolveRun, rejectRun) => {
      const child = spawn(
        process.execPath,
        [SCRIPT_PATH, "--child", JSON.stringify({ options, resultPath })],
        {
          cwd: REPO_ROOT,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      const collect = (chunk) => {
        output = (output + chunk).slice(-20_000);
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      child.on("error", rejectRun);
      child.on("exit", (code) =>
        code === 0 && existsSync(resultPath)
          ? resolveRun()
          : rejectRun(
              new Error(
                `Benchmark failed (exit ${code}):\n${output.split("\n").slice(-40).join("\n")}`,
              ),
            ),
      );
    });
    const result = JSON.parse(readFileSync(resultPath, "utf8"));
    const status = git(["status", "--porcelain"]);
    const report = {
      metadata: {
        generatedAt: new Date().toISOString(),
        revision: {
          sha: git(["rev-parse", "HEAD"]),
          dirty: status === null ? null : status.length > 0,
        },
        node: process.version,
        cpu: os.cpus()[0]?.model ?? "unknown",
        options,
      },
      ...result,
    };
    const stamp = report.metadata.generatedAt.replace(/[:.]/g, "-");
    const outPath = resolve(
      REPO_ROOT,
      options.out ?? join("logs", "sqlite-reads", `sqlite-reads-${stamp}.json`),
    );
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
    const f = result.fixture;
    process.stdout.write(
      `Fixture: ${f.tasks} tasks x ${f.eventsPerTask} events, ${f.longSessionEvents}-event session, ${f.llmCalls} usage rows, ${f.memories} memories; ${Math.round(f.dbBytes / 1048576)} MB, seeded in ${Math.round(f.seedMs / 1000)} s\n\n`,
    );
    const rows = result.results.map((entry) => [
      entry.name,
      String(entry.runs),
      `${entry.p50Ms}ms`,
      `${entry.maxMs}ms`,
      `${entry.loopMaxMs}ms`,
      entry.size === null ? "" : String(entry.size),
    ]);
    const header = ["read", "runs", "p50", "max", "loop max", "size"];
    const widths = header.map((cell, index) =>
      Math.max(cell.length, ...rows.map((row) => row[index].length)),
    );
    const format = (row) => row.map((cell, index) => cell.padEnd(widths[index])).join("  ");
    process.stdout.write(
      `Mode: ${result.mode}; peak RSS ${result.resources.peakRssMb} MB, peak WAL ${result.resources.peakWalMb} MB; parity ${JSON.stringify(result.parity)}\n\n`,
    );
    process.stdout.write(
      `${[format(header), ...rows.map(format)].join("\n")}\n\nResults: ${outPath}\n`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const childIndex = process.argv.indexOf("--child");
  const run =
    childIndex >= 0
      ? runChild(JSON.parse(process.argv[childIndex + 1])).then(() => process.exit(0))
      : runParent(process.argv.slice(2));
  run.catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
