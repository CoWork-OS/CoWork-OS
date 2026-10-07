import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const compiled = (name) => path.join(root, "dist/daemon/electron", name);
const { DatabaseManager } = require(compiled("database/schema.js"));
const { WorkspaceStore } = require(compiled("database/repositories.js"));
const { AgentRoleStore } = require(compiled("agents/AgentRoleRepository.js"));
const { RoutineService } = require(compiled("routines/service.js"));
const { BotResponsibilityStore } = require(compiled("automation/responsibility-store.js"));
const Database = require("better-sqlite3");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-signal-race-"));
const filename = path.join(directory, "fixture.db");
const workers = [];
let manager;
try {
  manager = new DatabaseManager({ dbPath: filename });
  const db = manager.getDatabase();
  db.pragma("journal_mode = WAL");
  const workspace = new WorkspaceStore(db).create("Fixture", directory, {
    read: true,
    write: false,
    delete: false,
    shell: false,
    network: false,
  });
  const bot = new AgentRoleStore(db).create({
    name: "private-signal-fixture",
    displayName: "Private",
    description: "Fixture",
    systemPrompt: "Preserve private instructions",
    capabilities: [],
  });
  const routines = new RoutineService({
    db,
    getCronService: () => null,
    getEventTriggerService: () => null,
    loadHooksSettings: () => ({
      enabled: false,
      token: "fixture",
      path: "/hooks",
      maxBodyBytes: 1024,
      presets: [],
      mappings: [],
    }),
    saveHooksSettings: () => {},
    createTask: async () => {
      throw new Error("Models must not run in this fixture");
    },
  });
  const engine = await routines.create({
    name: "Fixture",
    enabled: false,
    workspaceId: workspace.id,
    prompt: "Fixture",
    connectors: [],
    triggers: [{ id: "manual", type: "manual", enabled: true }],
  });
  const store = new BotResponsibilityStore(db);
  const scope = { workspaceId: workspace.id, agentRoleId: bot.id };
  const binding = store.create(
    scope,
    {
      objective: "Inspect",
      engine: { kind: "routine", id: engine.id },
      mode: "observe",
      sources: [{ connectorId: "workspace_files", method: "read_file", resourceId: "evidence.md" }],
      permittedActions: [],
      expectedOutput: "Report",
      reviewBoundary: "all_effects",
      destination: { channel: "internal", id: "results" },
      backend: "node",
      budget: { maxTokens: 1000, maxCost: 0 },
    },
    Date.now(),
  );
  store.setState(scope, binding.id, 1, 0, "active", Date.now());
  await routines.stopWorkflowRuntime();
  manager.close();
  manager = null;
  const barrier = new SharedArrayBuffer(4);
  let ready = 0;
  const results = await Promise.all(
    [0, 1].map(
      (index) =>
        new Promise((resolve, reject) => {
          const worker = new Worker(
            `
      const {parentPort,workerData}=require('node:worker_threads');
      const Database=require(workerData.databaseModule);
      const {TaskStore}=require(workerData.repositoryPath);
      const db=new Database(workerData.filename,{timeout:5000});db.pragma('foreign_keys=ON');
      parentPort.postMessage({ready:true});Atomics.wait(new Int32Array(workerData.barrier),0,0);
      try { const task=new TaskStore(db).create({workspaceId:workerData.workspaceId,title:'Signal fixture',prompt:'No model execution',status:'pending',agentConfig:{automationRoutineId:workerData.engineId,responsibilitySignal:{fingerprint:'a'.repeat(64),expectedSequence:0}}});parentPort.postMessage({result:{created:true,taskId:task.id}}); }
      catch(error){parentPort.postMessage({result:{created:false,error:error.message}});}
      finally{db.close();}
    `,
            {
              eval: true,
              workerData: {
                filename,
                barrier,
                workspaceId: workspace.id,
                engineId: engine.id,
                repositoryPath: compiled("database/repositories.js"),
                databaseModule: require.resolve("better-sqlite3"),
                index,
              },
            },
          );
          workers.push(worker);
          const timeout = setTimeout(
            () => reject(new Error("Signal worker did not finish")),
            15000,
          );
          worker.on("message", (message) => {
            if (message.ready && ++ready === 2) {
              Atomics.store(new Int32Array(barrier), 0, 1);
              Atomics.notify(new Int32Array(barrier), 0, 2);
            }
            if (message.result) {
              clearTimeout(timeout);
              resolve(message.result);
            }
          });
          worker.on("error", (error) => {
            clearTimeout(timeout);
            reject(error);
          });
          worker.on("exit", (code) => {
            if (code !== 0) {
              clearTimeout(timeout);
              reject(new Error(`Signal worker exited ${code}`));
            }
          });
        }),
    ),
  );
  assert.equal(results.filter((result) => result.created).length, 1);
  assert.equal(
    results.filter(
      (result) =>
        !result.created &&
        result.error === "Responsibility signal is unchanged or already admitted",
    ).length,
    1,
  );
  const check = new Database(filename, { readonly: true });
  try {
    assert.equal(check.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 1);
    assert.equal(
      check.prepare("SELECT COUNT(*) AS count FROM bot_responsibility_runs").get().count,
      1,
    );
    assert.equal(
      check.prepare("SELECT COUNT(*) AS count FROM bot_responsibility_signal_runs").get().count,
      1,
    );
    assert.equal(
      check.prepare("SELECT sequence FROM bot_responsibility_signal_heads").get().sequence,
      1,
    );
    assert.equal(
      JSON.parse(check.prepare("SELECT agent_config FROM tasks").get().agent_config)
        .responsibilitySignal,
      undefined,
    );
    assert.equal(
      check.prepare("SELECT system_prompt FROM agent_roles WHERE id=?").get(bot.id).system_prompt,
      "Preserve private instructions",
    );
  } finally {
    check.close();
  }
  console.log(
    JSON.stringify({
      fixture: true,
      independentSQLiteWriters: 2,
      admittedTasks: 1,
      duplicateRollback: true,
      signalSequence: 1,
      privateBotPreserved: true,
      modelExecution: false,
      channelDelivery: false,
    }),
  );
} finally {
  manager?.close();
  await Promise.all(workers.map((worker) => worker.terminate()));
  fs.rmSync(directory, { recursive: true, force: true });
}
