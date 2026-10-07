import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { createHash } from "node:crypto";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const storePath = path.join(root, "dist/daemon/electron/automation/dispatch-budget-store.js");
const { DISPATCH_BUDGET_SCHEMA } = require(storePath);
const leaseStorePath = path.join(root, "dist/daemon/electron/automation/scheduler-lease-store.js");
const { SCHEDULER_LEASE_SCHEMA } = require(leaseStorePath);
const repositoryPath = path.join(root, "dist/daemon/electron/database/repositories.js");
const { DatabaseManager } = require(path.join(root, "dist/daemon/electron/database/schema.js"));
const { WorkspaceStore } = require(repositoryPath);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-dispatch-race-"));
const filename = path.join(directory, "test.db");
const workers = [];
try {
  const manager = new DatabaseManager({dbPath: filename});
  const db = manager.getDatabase();
  const workspaceIds = {};
  for (const scenario of ["last_ticket", "same_occurrence", "scheduler_owner"]) workspaceIds[scenario] = new WorkspaceStore(db).create(scenario, path.join(directory, scenario), {read:true,write:false,delete:false,shell:false,network:false}).id;
  db.pragma("journal_mode = WAL");
  db.exec(DISPATCH_BUDGET_SCHEMA);
  db.exec(SCHEDULER_LEASE_SCHEMA);
  manager.close();
  const results = [];
  for (const scenario of ["last_ticket", "same_occurrence", "scheduler_owner"]) {
    const barrier = new SharedArrayBuffer(4);
    const pending = [0, 1].map(
      (index) =>
        new Promise((resolve, reject) => {
          const worker = new Worker(
            `
        const { parentPort, workerData } = require('node:worker_threads');
        const Database = require(workerData.databaseModule);
        const { DispatchBudgetStore } = require(workerData.storePath);
        const db = new Database(workerData.filename, {timeout:5000});
        db.pragma("foreign_keys = ON");
        const store = new DispatchBudgetStore(db);
        parentPort.postMessage({ready:true});
        Atomics.wait(new Int32Array(workerData.barrier),0,0);
        const lease = workerData.scenario === 'scheduler_owner' ? new (require(workerData.leaseStorePath).SchedulerLeaseStore)(db).acquire({owner:'worker-'+workerData.index,now:Date.now(),leaseMs:60000}) : undefined;
        const result = workerData.scenario === 'scheduler_owner' && !lease ? {allowed:false,reason:'scheduler_owned'} : store.reserve({workspaceId:workerData.workspaceId,
          source:workerData.index===0?'heartbeat':'autonomy',
          occurrenceKey:workerData.scenario==='same_occurrence'?'revision:1:event:2':workerData.scenario==='scheduler_owner'?'scheduler-event:1':undefined},
          {schedulerFence:lease,now:Date.now(),dayStart:0,maxPerDay:workerData.scenario==='last_ticket'?1:100,cooldownMs:7200000},
          'ticket-'+workerData.scenario+'-'+workerData.index);
        if (workerData.scenario === 'scheduler_owner' && result.allowed) {
          const task = new (require(workerData.repositoryPath).TaskStore)(db).create({workspaceId:workerData.workspaceId,title:'Fenced fixture dispatch',prompt:'Fixture only; no model execution',status:'pending',agentConfig:{backgroundDispatchTicket:result.ticket,backgroundSchedulerFence:lease}});
          result.createdTaskId = task.id;
        }
        db.close(); parentPort.postMessage({result});
      `,
            {
              eval: true,
              workerData: {
                barrier,
                filename,
                storePath,
                leaseStorePath,
                repositoryPath,
                workspaceId: workspaceIds[scenario],
                databaseModule: require.resolve("better-sqlite3"),
                index,
                scenario,
              },
            },
          );
          workers.push(worker);
          worker.on("error", reject);
          worker.on("message", (message) => {
            if (message.ready) {
              results.push({ scenario, ready: index });
              if (
                results.filter((row) => row.scenario === scenario && row.ready !== undefined)
                  .length === 2
              ) {
                Atomics.store(new Int32Array(barrier), 0, 1);
                Atomics.notify(new Int32Array(barrier), 0, 2);
              }
            }
            if (message.result) resolve(message.result);
          });
          worker.on("exit", (code) => {
            if (code !== 0) reject(new Error(`Worker exited ${code}`));
          });
        }),
    );
    const decisions = await Promise.all(pending);
    assert.equal(decisions.filter((decision) => decision.allowed).length, 1);
    assert.equal(
      decisions.find((decision) => !decision.allowed).reason,
      scenario === "last_ticket" ? "workspace_budget_exhausted" : scenario === "scheduler_owner" ? "scheduler_owned" : "duplicate_occurrence",
    );
    const proof = new Database(filename);
    assert.equal(
      proof
        .prepare("SELECT COUNT(*) n FROM background_dispatch_reservations WHERE workspace_id = ?")
        .get(workspaceIds[scenario]).n,
      1,
    );
    if (scenario === "scheduler_owner") {
      assert.equal(proof.prepare("SELECT COUNT(*) n FROM tasks").get().n, 1);
      assert.equal(proof.prepare("SELECT state FROM background_dispatch_reservations WHERE workspace_id = ?").get(workspaceIds[scenario]).state, "committed");
      assert.equal(decisions.filter(decision => decision.createdTaskId).length, 1);
    }
    proof.close();
    results.push({ scenario, decisions });
  }
  console.log(
    JSON.stringify(
      {
        fixture: true,
        leaseStoreSha256: createHash("sha256").update(fs.readFileSync(leaseStorePath)).digest("hex"),
        storeSha256: createHash("sha256").update(fs.readFileSync(storePath)).digest("hex"),
        results: results.filter((row) => row.decisions),
      },
      null,
      2,
    ),
  );
} finally {
  await Promise.all(workers.map((worker) => worker.terminate()));
  fs.rmSync(directory, { recursive: true, force: true });
}
