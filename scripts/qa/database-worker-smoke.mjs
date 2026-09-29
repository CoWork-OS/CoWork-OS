#!/usr/bin/env node
// Loads the database worker and the FTS worker from each build output (dist/electron,
// dist/daemon, dist/cli) against a disposable profile (async SQLite migration plan, DB2).
// Proves the worker files are emitted where each runtime looks for them and that they
// start, answer, and shut down. Run after the builds: `npm run qa:db:worker-smoke`.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);

function electronBinary() {
  try {
    const binary = require("electron");
    return typeof binary === "string" && existsSync(binary) ? binary : null;
  } catch {
    return null;
  }
}

// The desktop build is also run inside Electron's own Node, with the native module it loads.
const electron = electronBinary();
const RUNS = [
  { target: "electron", runtime: process.execPath, label: "electron (node)" },
  { target: "daemon", runtime: process.execPath, label: "daemon (node)" },
  { target: "cli", runtime: process.execPath, label: "cli (node)" },
  ...(electron ? [{ target: "electron", runtime: electron, label: "electron (electron)" }] : []),
];

// Runs in a fresh process per target so module state and userData resolution are isolated.
const CHILD_SOURCE = `
const path = require("path");
const dist = process.argv[1];
const runtimeName = process.argv[2];
const load = (file) => require(path.join(dist, file));
(async () => {
  const { DatabaseManager } = load("electron/database/schema.js");
  const { DatabaseClient } = load("electron/database/async/DatabaseClient.js");
  const { DATABASE_COMMANDS, requiredTablesFor } = load("electron/database/async/commands.js");
  const { pruneTaskEventsWithWorker, readStorageStats } = load("electron/database/async/maintenance.js");
  const { FtsWorkerClient } = load("electron/database/FtsWorkerClient.js");
  const manager = new DatabaseManager();
  const client = await DatabaseClient.start({
    dbPath: manager.getDatabasePath(),
    requiredTables: requiredTablesFor(DATABASE_COMMANDS),
  });
  const pruned = await pruneTaskEventsWithWorker(client, 90);
  const stats = await readStorageStats(client);
  const { drained } = await client.close();
  const fts = new FtsWorkerClient(manager.getDatabasePath());
  const hits = await fts.searchByContentMarker("workspace", "[smoke-marker]", 1);
  fts.destroy();
  // DB7 rollout defaults: with no flags set this runtime routes every domain to the worker;
  // COWORK_DB_WORKER=0 keeps the whole run on the host.
  const runtime = load("electron/database/async/runtime.js");
  const { statementClientFor } = load("electron/database/statements/statement-route.js");
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("COWORK_DB_WORKER")) delete process.env[key];
  }
  const byDefault = await runtime.startDatabaseWorker({
    dbPath: manager.getDatabasePath(),
    runtime: runtimeName,
  });
  const routed = ["storage", "services", "memory", "mailbox", "controlPlane", "reports"].filter(
    (domain) => statementClientFor(domain, manager.getDatabase()) !== null,
  ).length;
  const defaultDrained = (await runtime.stopDatabaseWorker(5_000)).drained;
  process.env.COWORK_DB_WORKER = "0";
  const switchedOff = await runtime.startDatabaseWorker({
    dbPath: manager.getDatabasePath(),
    runtime: runtimeName,
  });
  await runtime.stopDatabaseWorker(5_000);
  if (!byDefault || routed !== 6 || !defaultDrained || switchedOff) {
    throw new Error(
      "rollout defaults: started=" + Boolean(byDefault) + " routed=" + routed +
        " drained=" + defaultDrained + " killSwitchStarted=" + Boolean(switchedOff),
    );
  }
  manager.close();
  process.stdout.write(
    JSON.stringify({ pruned, pageSize: stats.pageSize, drained, ftsHits: hits.length, defaultDomains: routed, killSwitch: true }),
  );
})().catch((error) => {
  process.stderr.write(String(error && error.stack || error));
  process.exit(1);
});
`;

let failed = false;
if (!electron)
  process.stdout.write("electron binary not found; skipping the Electron runtime run\n");
for (const { target, runtime, label } of RUNS) {
  const dist = join(REPO_ROOT, "dist", target);
  const workerFile = join(dist, "electron/database/async/database-worker.js");
  const ftsFile = join(dist, "electron/database/fts-worker.js");
  const missing = [workerFile, ftsFile].filter((file) => !existsSync(file));
  if (missing.length > 0) {
    process.stderr.write(`${label}: missing ${missing.join(", ")} (run npm run build:${target})\n`);
    failed = true;
    continue;
  }
  const profile = realpathSync(
    mkdtempSync(join(realpathSync(os.tmpdir()), "cowork-worker-smoke-")),
  );
  try {
    const runtimeName = target === "electron" ? "desktop" : target;
    const result = spawnSync(runtime, ["-e", CHILD_SOURCE, dist, runtimeName], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        COWORK_USER_DATA_DIR: profile,
        COWORK_LOG_LEVEL: "error",
      },
    });
    const summary = result.stdout.trim().split("\n").pop() ?? "";
    if (result.status === 0 && summary.startsWith("{")) {
      process.stdout.write(`${label}: ok ${summary}\n`);
    } else {
      failed = true;
      process.stderr.write(
        `${label}: failed (exit ${result.status})\n${result.stderr.slice(-2000)}\n`,
      );
    }
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}
if (failed) process.exitCode = 1;
