#!/usr/bin/env node
// Control-plane workload for the async SQLite migration (DB6 control-plane domain in
// docs/async-sqlite-migration-plan-2026-09-27.md). Seeds a disposable profile with a
// company, projects, issues and a usage history, then runs cost summaries and issue
// checkout, task attachment and completion cycles twice: with control-plane units on the
// host connection, and routed to the database worker. A mission-control-style poll lists
// issues and runs throughout; the report compares host event-loop stalls and poll latency.
//
// Usage:
//   npm run qa:db:control-plane
//   node scripts/qa/control-plane-workload.mjs --tasks=200 --events=100
//
// Options (defaults in brackets):
//   --tasks=<n>        tasks with usage history [400]
//   --events=<n>       usage events per task [100]
//   --cycles=<n>       checkout/attach/complete cycles [60]
//   --poll-ms=<n>      poll interval [50]
//   --dist=<path>      CLI build output [dist/cli]
//   --out=<path>       results JSON [logs/sqlite-workload/control-plane-workload-<stamp>.json]

import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
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
  tasks: 400,
  events: 100,
  cycles: 60,
  pollMs: 50,
  dist: "dist/cli",
  out: null,
};

export function parseArgs(argv) {
  const options = { ...DEFAULTS };
  const numbers = {
    "--tasks": "tasks",
    "--events": "events",
    "--cycles": "cycles",
    "--poll-ms": "pollMs",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const separator = argv[i].indexOf("=");
    const flag = separator < 0 ? argv[i] : argv[i].slice(0, separator);
    const inline = separator < 0 ? undefined : argv[i].slice(separator + 1);
    const value = () => inline ?? argv[++i];
    if (flag in numbers) {
      const parsed = Number(value());
      if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`Invalid value for ${flag}`);
      options[numbers[flag]] = Math.floor(parsed);
    } else if (flag === "--dist") options.dist = value();
    else if (flag === "--out") options.out = value();
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return options;
}

function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

const round = (value) => Math.round(value * 10) / 10;

// ---------------------------------------------------------------------------
// Child: one backend.
// ---------------------------------------------------------------------------

async function runChild(config) {
  const tempRoot = realpathSync(os.tmpdir());
  const profileDir = realpathSync(mkdtempSync(join(tempRoot, "cowork-cp-workload-")));
  if (!profileDir.startsWith(tempRoot)) throw new Error("Refusing to run outside the temp dir");
  process.env.COWORK_USER_DATA_DIR = profileDir;
  delete process.env.COWORK_PROFILE;
  delete process.env.COWORK_PROFILE_ID;
  process.env.COWORK_LOG_LEVEL = process.env.COWORK_LOG_LEVEL || "error";

  const { options, mode } = config;
  const dist = resolve(REPO_ROOT, options.dist);
  const load = (path) => require(join(dist, path));
  const { DatabaseManager } = load("electron/database/schema.js");
  const runtime = load("electron/database/async/runtime.js");
  const repos = load("electron/database/repositories.js");
  const { ControlPlaneCoreService } = load("electron/control-plane/ControlPlaneCoreService.js");

  const manager = new DatabaseManager();
  const db = manager.getDatabase();
  try {
    if (mode === "worker") {
      const client = await runtime.startDatabaseWorker({
        dbPath: manager.getDatabasePath(),
        runtime: "cli",
      });
      if (!client) throw new Error("Database worker did not start");
      // Cost summaries are report units: they run on the reporting reader.
      const reader = await runtime.startReportingReader({
        dbPath: manager.getDatabasePath(),
        runtime: "cli",
      });
      if (!reader) throw new Error("Reporting reader did not start");
    }
    const workspaceDir = join(profileDir, "workspace");
    mkdirSync(workspaceDir, { recursive: true });
    const workspace = new repos.WorkspaceStore(db).create("Workload", workspaceDir, {
      read: true,
      write: true,
      delete: false,
      network: false,
      shell: false,
    });
    const taskRepo = new repos.TaskStore(db);
    const core = new ControlPlaneCoreService(db);
    const company = await core.getDefaultCompany();
    const projects = [];
    for (let p = 0; p < 4; p += 1) {
      projects.push(await core.createProject({ companyId: company.id, name: `Project ${p}` }));
    }
    // Usage history: tasks tied to projects, each with llm_usage events.
    const now = Date.now();
    const insertEvent = db.prepare(
      "INSERT INTO task_events (id, task_id, timestamp, type, payload, schema_version) VALUES (?, ?, ?, 'llm_usage', ?, 2)",
    );
    db.transaction(() => {
      for (let t = 0; t < options.tasks; t += 1) {
        const task = taskRepo.create({
          title: `History ${t}`,
          prompt: "history",
          status: "completed",
          workspaceId: workspace.id,
        });
        db.prepare("UPDATE tasks SET project_id = ?, company_id = ? WHERE id = ?").run(
          projects[t % projects.length].id,
          company.id,
          task.id,
        );
        for (let e = 0; e < options.events; e += 1) {
          insertEvent.run(
            `${task.id}-e${e}`,
            task.id,
            now - e * 1000,
            JSON.stringify({ delta: { cost: 0.001, inputTokens: 100, outputTokens: 50 } }),
          );
        }
      }
    })();

    const polls = [];
    let polling = true;
    const poll = (async () => {
      while (polling) {
        const started = performance.now();
        await core.listIssues({ companyId: company.id, limit: 50 });
        await core.listRuns({ companyId: company.id, limit: 50 });
        polls.push(performance.now() - started);
        await new Promise((resolveWait) => setTimeout(resolveWait, options.pollMs));
      }
    })();

    const loop = monitorEventLoopDelay({ resolution: 10 });
    loop.enable();
    const runStarted = performance.now();
    let costTotal = 0;
    for (let c = 0; c < options.cycles; c += 1) {
      const project = projects[c % projects.length];
      const issue = await core.createIssue({
        companyId: company.id,
        projectId: project.id,
        workspaceId: workspace.id,
        title: `Cycle ${c}`,
      });
      const checkout = await core.checkoutIssue({ issueId: issue.id, workspaceId: workspace.id });
      const task = taskRepo.create({
        title: `Cycle task ${c}`,
        prompt: "cycle",
        status: "planning",
        workspaceId: workspace.id,
      });
      await core.attachTaskToRun(checkout.run.id, task.id);
      taskRepo.update(task.id, { status: "completed", terminalStatus: "ok", resultSummary: "ok" });
      await core.syncTaskLifecycle(task.id);
      if (c % 10 === 0) {
        const summary = await core.summarizeCosts({ scopeType: "project", scopeId: project.id });
        costTotal += summary.taskCount;
      }
      // A cycle ends at a real I/O boundary, as a heartbeat would.
      await new Promise((resolveWait) => setImmediate(resolveWait));
    }
    const runMs = performance.now() - runStarted;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    loop.disable();
    polling = false;
    await poll;

    const count = (query) => db.prepare(query).get().count;
    const result = {
      mode,
      syncMs: Math.round(runMs),
      cyclesPerSecond: round((options.cycles / runMs) * 1000),
      loop: {
        p50Ms: round(loop.percentile(50) / 1e6),
        p99Ms: round(loop.percentile(99) / 1e6),
        maxMs: round(loop.max / 1e6),
      },
      poll: {
        count: polls.length,
        p50Ms: round(percentile(polls, 0.5)),
        p95Ms: round(percentile(polls, 0.95)),
        maxMs: round(Math.max(0, ...polls)),
      },
      rows: {
        issues: count("SELECT COUNT(*) AS count FROM issues"),
        runs: count("SELECT COUNT(*) AS count FROM heartbeat_runs WHERE status = 'completed'"),
        events: count("SELECT COUNT(*) AS count FROM heartbeat_run_events"),
        costTasks: costTotal,
      },
    };
    writeFileSync(config.resultPath, JSON.stringify(result));
  } finally {
    await runtime.stopDatabaseWorker(5_000);
    manager.close();
    rmSync(profileDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Parent: run both backends, report.
// ---------------------------------------------------------------------------

function git(args) {
  try {
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function runMode(options, mode, scratch) {
  const resultPath = join(scratch, `${mode}.json`);
  const env = { ...process.env };
  delete env.COWORK_DB_WORKER;
  delete env.COWORK_DB_WORKER_CONTROL_PLANE;
  delete env.COWORK_DB_WORKER_REPORTS;
  if (mode === "worker") {
    env.COWORK_DB_WORKER = "1";
    env.COWORK_DB_WORKER_CONTROL_PLANE = "1";
    env.COWORK_DB_WORKER_REPORTS = "1";
  }
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      process.execPath,
      [SCRIPT_PATH, "--child", JSON.stringify({ options, mode, resultPath })],
      { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
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
        ? resolveRun(JSON.parse(readFileSync(resultPath, "utf8")))
        : rejectRun(
            new Error(
              `${mode} run failed (exit ${code}):\n${output.split("\n").slice(-40).join("\n")}`,
            ),
          ),
    );
  });
}

async function runParent(argv) {
  const options = parseArgs(argv);
  if (
    !existsSync(
      resolve(REPO_ROOT, options.dist, "electron/control-plane/ControlPlaneCoreService.js"),
    )
  ) {
    throw new Error(
      `Missing ${options.dist}. Run "npm run build:cli" first (qa:db:control-plane does this).`,
    );
  }
  const scratch = mkdtempSync(join(realpathSync(os.tmpdir()), "cowork-cp-results-"));
  try {
    const host = await runMode(options, "host", scratch);
    const worker = await runMode(options, "worker", scratch);
    const parity = JSON.stringify(host.rows) === JSON.stringify(worker.rows);
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
      parity,
      host,
      worker,
    };
    const stamp = report.metadata.generatedAt.replace(/[:.]/g, "-");
    const outPath = resolve(
      REPO_ROOT,
      options.out ?? join("logs", "sqlite-workload", `control-plane-workload-${stamp}.json`),
    );
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
    const header = [
      "backend",
      "run",
      "cycles/s",
      "loop p99",
      "loop max",
      "poll p50",
      "poll p95",
      "poll max",
      "polls",
    ];
    const rows = [host, worker].map((entry) => [
      entry.mode,
      `${entry.syncMs}ms`,
      String(entry.cyclesPerSecond),
      `${entry.loop.p99Ms}ms`,
      `${entry.loop.maxMs}ms`,
      `${entry.poll.p50Ms}ms`,
      `${entry.poll.p95Ms}ms`,
      `${entry.poll.maxMs}ms`,
      String(entry.poll.count),
    ]);
    const widths = header.map((cell, index) =>
      Math.max(cell.length, ...rows.map((row) => row[index].length)),
    );
    const format = (row) => row.map((cell, index) => cell.padEnd(widths[index])).join("  ");
    process.stdout.write(
      `Control plane: ${options.tasks} tasks x ${options.events} usage events, ${options.cycles} checkout cycles; rows ${JSON.stringify(host.rows)}; parity ${parity}\n\n`,
    );
    process.stdout.write(
      `${[format(header), ...rows.map(format)].join("\n")}\n\nResults: ${outPath}\n`,
    );
    if (!parity) process.exitCode = 1;
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
