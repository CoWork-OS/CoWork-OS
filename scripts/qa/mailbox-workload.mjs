#!/usr/bin/env node
// Mailbox background-sync workload for the async SQLite migration (DB6 mailbox domain in
// docs/async-sqlite-migration-plan-2026-09-27.md). Runs the same simulated sync on a
// disposable profile twice: with mailbox statements on the host connection, and routed to
// the database worker. While the sync writes threads, messages and the search index, a
// UI-style poll lists the inbox and reads the sync status; the report compares host
// event-loop stalls and poll latency between the two backends.
//
// The sync is the write path of a provider sync (MailboxService.upsertThread), fed pages
// of generated threads; each page boundary yields once, as a provider fetch would.
//
// Usage:
//   npm run qa:db:mailbox
//   node scripts/qa/mailbox-workload.mjs --threads=500 --messages=2
//
// Options (defaults in brackets):
//   --threads=<n>      threads synced [1500]
//   --messages=<n>     messages per thread [3]
//   --body-kb=<n>      message body size [2]
//   --page=<n>         threads per provider page [25]
//   --poll-ms=<n>      UI poll interval [100]
//   --dist=<path>      CLI build output [dist/cli]
//   --out=<path>       results JSON [logs/sqlite-workload/mailbox-workload-<stamp>.json]

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
  threads: 1500,
  messages: 3,
  bodyKb: 2,
  page: 25,
  pollMs: 100,
  dist: "dist/cli",
  out: null,
};

export function parseArgs(argv) {
  const options = { ...DEFAULTS };
  const numbers = {
    "--threads": "threads",
    "--messages": "messages",
    "--body-kb": "bodyKb",
    "--page": "page",
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
  const profileDir = realpathSync(mkdtempSync(join(tempRoot, "cowork-mailbox-workload-")));
  if (!profileDir.startsWith(tempRoot)) throw new Error("Refusing to run outside the temp dir");
  process.env.COWORK_USER_DATA_DIR = profileDir;
  delete process.env.COWORK_PROFILE;
  delete process.env.COWORK_PROFILE_ID;
  process.env.COWORK_LOG_LEVEL = process.env.COWORK_LOG_LEVEL || "error";

  const { options, mode } = config;
  const dist = resolve(REPO_ROOT, options.dist);
  const load = (path) => require(join(dist, path));
  const { DatabaseManager } = load("electron/database/schema.js");
  const { MailboxService } = load("electron/mailbox/MailboxService.js");
  const runtime = load("electron/database/async/runtime.js");

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
    const accountId = "gmail:workload@example.com";
    const now = Date.now();
    db.prepare(
      `INSERT INTO mailbox_accounts
        (id, provider, address, display_name, status, capabilities_json, sync_cursor, last_synced_at, created_at, updated_at)
       VALUES (?, 'gmail', 'workload@example.com', 'Workload', 'connected', '["threads"]', NULL, ?, ?, ?)`,
    ).run(accountId, now, now, now);
    const service = new MailboxService(db);
    const routed = service.sql.usesWorker();
    if (routed !== (mode === "worker")) throw new Error(`Mailbox routing is ${routed} in ${mode}`);

    const words =
      "invoice meeting review launch plan budget contract renewal travel receipt statement update".split(
        " ",
      );
    const body = "Please review the attached notes before the meeting. ".repeat(
      Math.ceil((options.bodyKb * 1024) / 52),
    );
    const thread = (index) => {
      const at = now - index * 60_000;
      const subject = `${words[index % words.length]} ${words[(index * 7) % words.length]} #${index}`;
      const id = `gmail-thread:w${index}`;
      return {
        id,
        accountId,
        provider: "gmail",
        providerThreadId: `w${index}`,
        subject,
        snippet: subject,
        participants: [{ email: `sender${index % 40}@vendor.com`, name: "Sender" }],
        labels: ["INBOX"],
        category: index % 3 === 0 ? "priority" : "updates",
        priorityScore: 30,
        urgencyScore: 10,
        needsReply: index % 4 === 0,
        staleFollowup: false,
        cleanupCandidate: false,
        handled: false,
        unreadCount: index % 2,
        lastMessageAt: at,
        messages: Array.from({ length: options.messages }, (_, m) => ({
          id: `${id}:m${m}`,
          providerMessageId: `${id}:m${m}`,
          direction: "incoming",
          from: { email: `sender${index % 40}@vendor.com`, name: "Sender" },
          to: [{ email: "workload@example.com", name: "Workload" }],
          cc: [],
          bcc: [],
          subject,
          snippet: subject,
          body: `${subject}\n${body}`,
          receivedAt: at - (options.messages - m) * 1000,
          unread: m === options.messages - 1 && index % 2 === 1,
        })),
      };
    };

    const polls = [];
    let polling = true;
    const poll = (async () => {
      while (polling) {
        const started = performance.now();
        await service.listThreads({ mailboxView: "inbox", limit: 50 });
        await service.getSyncStatus();
        polls.push(performance.now() - started);
        await new Promise((resolveWait) => setTimeout(resolveWait, options.pollMs));
      }
    })();

    const loop = monitorEventLoopDelay({ resolution: 10 });
    loop.enable();
    const syncStarted = performance.now();
    for (let index = 0; index < options.threads; index += 1) {
      await service.upsertThread(thread(index));
      if ((index + 1) % options.page === 0) {
        // Provider page boundary: the next page arrives from the network.
        await new Promise((resolveWait) => setImmediate(resolveWait));
      }
    }
    const syncMs = performance.now() - syncStarted;
    // Let the monitor sample the delay of the last blocking stretch before stopping it.
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    loop.disable();
    polling = false;
    await poll;

    const count = (sql) => db.prepare(sql).get().count;
    const result = {
      mode,
      syncMs: Math.round(syncMs),
      threadsPerSecond: round((options.threads / syncMs) * 1000),
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
        threads: count("SELECT COUNT(*) AS count FROM mailbox_threads"),
        messages: count("SELECT COUNT(*) AS count FROM mailbox_messages"),
        embeddings: count("SELECT COUNT(*) AS count FROM mailbox_search_embeddings"),
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
  delete env.COWORK_DB_WORKER_MAILBOX;
  if (mode === "worker") {
    env.COWORK_DB_WORKER = "1";
    env.COWORK_DB_WORKER_MAILBOX = "1";
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
  if (!existsSync(resolve(REPO_ROOT, options.dist, "electron/mailbox/MailboxService.js"))) {
    throw new Error(
      `Missing ${options.dist}. Run "npm run build:cli" first (qa:db:mailbox does this).`,
    );
  }
  const scratch = mkdtempSync(join(realpathSync(os.tmpdir()), "cowork-mailbox-results-"));
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
      options.out ?? join("logs", "sqlite-workload", `mailbox-workload-${stamp}.json`),
    );
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
    const header = [
      "backend",
      "sync",
      "threads/s",
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
      String(entry.threadsPerSecond),
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
      `Sync: ${options.threads} threads x ${options.messages} messages (${options.bodyKb} KB bodies), pages of ${options.page}; rows ${JSON.stringify(host.rows)}; parity ${parity}\n\n`,
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
