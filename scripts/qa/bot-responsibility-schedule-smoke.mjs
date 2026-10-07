/** Real compiled Node scheduler, disposable profile, no model or channel delivery. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-schedule-smoke-"));
const environment = Object.fromEntries(
  ["PATH", "HOME", "TMPDIR", "SystemRoot"]
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]),
);
Object.assign(environment, {
  COWORK_USER_DATA_DIR: directory,
  COWORK_IMPORT_ENV_SETTINGS: "0",
  COWORK_PROFILE: "default",
  COWORK_HEADLESS: "1",
});
const seed = `
const {DatabaseManager}=require('./dist/daemon/electron/database/schema.js');
const {WorkspaceStore}=require('./dist/daemon/electron/database/repositories.js');
const {AgentRoleStore}=require('./dist/daemon/electron/agents/AgentRoleRepository.js');
const {RoutineService}=require('./dist/daemon/electron/routines/service.js');
const {CronService}=require('./dist/daemon/electron/cron/service.js');
const {BotResponsibilityService}=require('./dist/daemon/electron/automation/BotResponsibilityService.js');
const {SchedulerLeaseStore}=require('./dist/daemon/electron/automation/scheduler-lease-store.js');
(async()=>{
 const manager=new DatabaseManager();const db=manager.getDatabase();
 const workspace=new WorkspaceStore(db).create('Scheduled fixture',process.env.COWORK_USER_DATA_DIR,{read:true,write:false,delete:false,shell:false,network:false});
 const bot=new AgentRoleStore(db).create({name:'my-private-scheduled-fixture',displayName:'Private',description:'Fixture',capabilities:[],systemPrompt:'Keep my private instructions',heartbeatEnabled:false});
 const cron=new CronService({storePath:require('node:path').join(process.env.COWORK_USER_DATA_DIR,'cron/jobs.json'),cronEnabled:false,createTask:async()=>{throw new Error('Seed must not dispatch');}});await cron.start();
 const routines=new RoutineService({db,getCronService:()=>cron,getEventTriggerService:()=>null,loadHooksSettings:()=>({enabled:false,token:'fixture',path:'/hooks',maxBodyBytes:1024,presets:[],mappings:[]}),saveHooksSettings:()=>{},createTask:async()=>{throw new Error('Seed must not dispatch');}});
 const engine=await routines.create({name:'Empty-source fixture',enabled:false,workspaceId:workspace.id,prompt:'Inspect selected source',connectors:[],triggers:[{id:'schedule',type:'schedule',enabled:true,schedule:{kind:'every',everyMs:1000}}]});
 const lease=new SchedulerLeaseStore(db);const fence=lease.acquire({owner:'seed-fixture',now:Date.now(),leaseMs:60000});
 const service=new BotResponsibilityService(db,{runtime:()=> 'node',getRoutineService:()=>routines,assertOwnership:async()=>{},getSchedulerFence:()=>fence});
 const binding=await service.create({scope:{workspaceId:workspace.id,agentRoleId:bot.id},definition:{objective:'Inspect selected evidence',engine:{kind:'routine',id:engine.id},mode:'observe',sources:[{connectorId:'workspace_files',method:'read_file',resourceId:'missing-selected-evidence.md'}],permittedActions:[],expectedOutput:'Internal report',reviewBoundary:'all_effects',destination:{channel:'internal',id:'results'},backend:'node',budget:{maxTokens:1000,maxCost:0}}});
 await service.activate({scope:{workspaceId:workspace.id,agentRoleId:bot.id},id:binding.id,expectedRevision:1,expectedControlVersion:0});
 const jobs=await cron.list();lease.release(fence);await routines.stopWorkflowRuntime();await cron.stop();manager.close();
 console.log('SCHEDULE_FIXTURE='+JSON.stringify({botId:bot.id,jobId:jobs[0].id}));
})().catch(error=>{console.error(error);process.exitCode=1;});`;
let child;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function stop() {
  if (!child) return;
  if (child.exitCode !== null) {
    assert.equal(child.exitCode, 0);
    child = undefined;
    return;
  }
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const clean = await Promise.race([exited.then(() => true), sleep(15000).then(() => false)]);
  if (!clean) {
    child.kill("SIGKILL");
    await exited;
    throw new Error("Scheduled fixture did not drain");
  }
  assert.equal(child.exitCode, 0);
  child = undefined;
}
try {
  const seeded = spawnSync(process.execPath, ["-e", seed], {
    cwd: root,
    env: environment,
    encoding: "utf8",
  });
  assert.equal(seeded.status, 0, "Disposable scheduled fixture seeding failed");
  const fixture = JSON.parse(seeded.stdout.match(/SCHEDULE_FIXTURE=(.+)/)?.[1] ?? "null");
  assert(fixture);
  let previousRuns = 0;
  const proofs = [];
  for (let pass = 0; pass < 2; pass++) {
    let output = "";
    child = spawn(
      process.execPath,
      [path.join(root, "dist/daemon/daemon/main.js"), "--headless", "--no-import-env-settings"],
      { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.on("data", (data) => {
      output += String(data);
    });
    child.stderr.on("data", (data) => {
      output += String(data);
    });
    const deadline = Date.now() + 45000;
    let job;
    while (Date.now() < deadline) {
      try {
        job = JSON.parse(
          await fs.readFile(path.join(directory, "cron/jobs.json"), "utf8"),
        ).jobs.find((item) => item.id === fixture.jobId);
      } catch {}
      if (job?.state.lastStatus === "skipped" && job.state.totalRuns > previousRuns) break;
      if (child.exitCode !== null)
        throw new Error("Scheduled fixture exited before its quiet check");
      await sleep(100);
    }
    assert.equal(
      job?.state.lastStatus,
      "skipped",
      "Actual Node schedule must skip an empty selected source",
    );
    assert(job.state.totalRuns > previousRuns);
    previousRuns = job.state.totalRuns;
    assert.equal(job.state.lastTaskId, undefined);
    assert.equal(job.state.lastError, undefined);
    await stop();
    const db = new (require("better-sqlite3"))(path.join(directory, "cowork-os.db"), {
      readonly: true,
    });
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 0);
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM bot_responsibility_signal_heads").get().count,
        0,
      );
      assert.equal(
        db.prepare("SELECT system_prompt FROM agent_roles WHERE id=?").get(fixture.botId)
          .system_prompt,
        "Keep my private instructions",
      );
      assert.equal(db.prepare("SELECT state FROM bot_responsibilities").get().state, "active");
    } finally {
      db.close();
    }
    proofs.push({
      pass: pass + 1,
      realScheduledCheck: true,
      quietNoSignal: true,
      tasksCreated: 0,
      preservedPrivateBot: true,
    });
  }
  console.log(
    JSON.stringify({
      fixture: true,
      compiledNodeScheduler: true,
      modelExecution: false,
      channelDelivery: false,
      proofs,
    }),
  );
} finally {
  try {
    await stop();
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
