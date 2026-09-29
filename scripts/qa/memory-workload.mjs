#!/usr/bin/env node
// Memory indexing workload for the async SQLite migration (DB6 memory domain in
// docs/async-sqlite-migration-plan-2026-09-27.md). Indexes a generated workspace of
// markdown notes on a disposable profile twice: with memory units on the host connection,
// and routed to the database worker. While the index is built (chunking, redaction,
// local embeddings and the FTS index), a recall-style poll searches the markdown index,
// the knowledge graph and memory observations; the report compares host event-loop
// stalls and poll latency between the two backends.
//
// Usage:
//   npm run qa:db:memory
//   node scripts/qa/memory-workload.mjs --files=200 --kb=4
//
// Options (defaults in brackets):
//   --files=<n>        markdown files in the workspace [400]
//   --kb=<n>           size of each file [8]
//   --entities=<n>     knowledge graph entities seeded before indexing [300]
//   --poll-ms=<n>      recall poll interval [100]
//   --dist=<path>      CLI build output [dist/cli]
//   --out=<path>       results JSON [logs/sqlite-workload/memory-workload-<stamp>.json]

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
  files: 400,
  kb: 8,
  entities: 300,
  pollMs: 100,
  dist: "dist/cli",
  out: null,
};

export function parseArgs(argv) {
  const options = { ...DEFAULTS };
  const numbers = {
    "--files": "files",
    "--kb": "kb",
    "--entities": "entities",
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
  const profileDir = realpathSync(mkdtempSync(join(tempRoot, "cowork-memory-workload-")));
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
  const { createMemoryStatementPort } = load("electron/memory/memory-statement-port.js");
  const { MarkdownMemoryIndexService } = load("electron/memory/MarkdownMemoryIndexService.js");
  const { KnowledgeGraphRepository } = load("electron/knowledge-graph/KnowledgeGraphRepository.js");
  const { MemoryObservationService } = load("electron/memory/MemoryObservationService.js");

  const manager = new DatabaseManager();
  const db = manager.getDatabase();
  try {
    if (mode === "worker") {
      const client = await runtime.startDatabaseWorker({
        dbPath: manager.getDatabasePath(),
        runtime: "cli",
      });
      if (!client) throw new Error("Database worker did not start");
    }
    const sql = createMemoryStatementPort(db);
    if (sql.usesWorker() !== (mode === "worker")) {
      throw new Error(`Memory routing is ${sql.usesWorker()} in ${mode}`);
    }

    const workspaceDir = join(profileDir, "workspace");
    const words =
      "release database worker latency timeline approval session memory search report budget planner verify patch build invoice ledger".split(
        " ",
      );
    const paragraph = (seed) =>
      Array.from({ length: 60 }, (_, i) => words[(seed * 7 + i * 3) % words.length]).join(" ");
    for (let f = 0; f < options.files; f += 1) {
      const folder = join(workspaceDir, `area-${f % 20}`);
      mkdirSync(folder, { recursive: true });
      const sections = [];
      let bytes = 0;
      for (let s = 0; bytes < options.kb * 1024; s += 1) {
        const section = `## Section ${s} of note ${f}\n\n${paragraph(f + s)}\n\n`;
        sections.push(section);
        bytes += section.length;
      }
      writeFileSync(join(folder, `note-${f}.md`), `# Note ${f}\n\n${sections.join("")}`);
    }
    const now = Date.now();
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, permissions) VALUES ('ws', 'Workload', ?, ?, '{}')",
    ).run(workspaceDir, now);
    const insertMemory = db.prepare(
      `INSERT INTO memories (id, workspace_id, type, content, tokens, created_at, updated_at)
       VALUES (?, 'ws', 'insight', ?, 20, ?, ?)`,
    );
    for (let m = 0; m < 500; m += 1) insertMemory.run(`mem-${m}`, paragraph(m), now, now);
    MemoryObservationService.initialize(db);
    await MemoryObservationService.startBackfill(true);
    const kg = new KnowledgeGraphRepository(sql);
    for (let e = 0; e < options.entities; e += 1) {
      await kg.upsertEntity(
        "ws",
        { entityType: "topic", name: `${words[e % words.length]} ${e}` },
        "auto",
      );
    }

    const markdown = new MarkdownMemoryIndexService(db);
    const polls = [];
    let polling = true;
    const poll = (async () => {
      let round = 0;
      while (polling) {
        const query = `${words[round % words.length]} ${words[(round + 5) % words.length]}`;
        round += 1;
        const started = performance.now();
        await markdown.search("ws", workspaceDir, query, 8, () => true);
        await kg.contextEntities("ws", query, 5);
        await MemoryObservationService.search({ workspaceId: "ws", query, limit: 10 });
        polls.push(performance.now() - started);
        await new Promise((resolveWait) => setTimeout(resolveWait, options.pollMs));
      }
    })();

    const loop = monitorEventLoopDelay({ resolution: 10 });
    loop.enable();
    const syncStarted = performance.now();
    await markdown.syncWorkspace("ws", workspaceDir, true);
    const syncMs = performance.now() - syncStarted;
    // Let the monitor sample the delay of the last blocking stretch before stopping it.
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    loop.disable();
    polling = false;
    await poll;
    markdown.shutdown();

    const count = (query) => db.prepare(query).get().count;
    const result = {
      mode,
      syncMs: Math.round(syncMs),
      filesPerSecond: round((options.files / syncMs) * 1000),
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
        files: count("SELECT COUNT(*) AS count FROM memory_markdown_files"),
        chunks: count("SELECT COUNT(*) AS count FROM memory_markdown_chunks"),
        entities: count("SELECT COUNT(*) AS count FROM kg_entities"),
        observations: count("SELECT COUNT(*) AS count FROM memory_observation_metadata"),
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
  delete env.COWORK_DB_WORKER_MEMORY;
  if (mode === "worker") {
    env.COWORK_DB_WORKER = "1";
    env.COWORK_DB_WORKER_MEMORY = "1";
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
    !existsSync(resolve(REPO_ROOT, options.dist, "electron/memory/MarkdownMemoryIndexService.js"))
  ) {
    throw new Error(
      `Missing ${options.dist}. Run "npm run build:cli" first (qa:db:memory does this).`,
    );
  }
  const scratch = mkdtempSync(join(realpathSync(os.tmpdir()), "cowork-memory-results-"));
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
      options.out ?? join("logs", "sqlite-workload", `memory-workload-${stamp}.json`),
    );
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
    const header = [
      "backend",
      "index",
      "files/s",
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
      String(entry.filesPerSecond),
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
      `Index: ${options.files} files x ${options.kb} KB, ${options.entities} graph entities, 500 memories; rows ${JSON.stringify(host.rows)}; parity ${parity}\n\n`,
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
