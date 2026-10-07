#!/usr/bin/env node
/** Disposable Node runtime acceptance: no model tasks or channel messages are sent. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
const require = createRequire(import.meta.url);
const WebSocket = require("ws");
const botNotificationFixture=process.argv.includes("--bot-notifications");
const resultEvidenceFixture=process.argv.includes("--result-evidence") || botNotificationFixture;
const botFutureFixture = process.argv.includes("--bot-future-control");
const graphWorkControlFixture = process.argv.includes("--graph-work-control");
const recoveryFixture = process.argv.includes("--work-control-recovery");
const workControlFixture = graphWorkControlFixture || recoveryFixture || process.argv.includes("--work-control");
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-bot-runtime-smoke-"));
const entrypoint = path.join(root, "dist/daemon/daemon/main.js");
const seedCode = `
 const {DatabaseManager} = require('./dist/daemon/electron/database/schema.js');
 const {AgentRoleStore} = require('./dist/daemon/electron/agents/AgentRoleRepository.js');
 const manager = new DatabaseManager(); const roles = new AgentRoleStore(manager.getDatabase());
 const bot = roles.create({name:'private-fixture-839',displayName:'Private fixture',description:'Disposable',icon:'A',capabilities:[],systemPrompt:'Preserve these private instructions',heartbeatEnabled:false});
 const {WorkspaceStore,TaskStore}=require('./dist/daemon/electron/database/repositories.js');
 const {RoutineService}=require('./dist/daemon/electron/routines/service.js');
 const workspace=new WorkspaceStore(manager.getDatabase()).create('Responsibility fixture',process.env.COWORK_USER_DATA_DIR,{read:true,write:false,delete:false,shell:false,network:false});
 const active=roles.create({name:'private-responsibility-fixture',displayName:'Private responsibility fixture',description:'Disposable',capabilities:[],systemPrompt:'Keep my identity',heartbeatEnabled:false});
 const routines=new RoutineService({db:manager.getDatabase(),getCronService:()=>null,getEventTriggerService:()=>null,loadHooksSettings:()=>({enabled:false,token:'fixture',path:'/hooks',maxBodyBytes:1024,presets:[],mappings:[]}),saveHooksSettings:()=>{},createTask:()=>{throw Error('Fixture must not dispatch');}});
 let resultTaskId;
 if(process.env.COWORK_BOT_RESULT_FIXTURE==='1'){
  const task=new TaskStore(manager.getDatabase()).create({title:'Result fixture',prompt:'Synthetic evidence only',workspaceId:workspace.id,assignedAgentRoleId:active.id,status:'completed',verificationVerdict:'PASS'});resultTaskId=task.id;
  const {WorkSessionProtocolRepository}=require('./dist/daemon/electron/database/WorkSessionProtocolRepository.js');
  const {WorkSessionContractRepository}=require('./dist/daemon/electron/database/WorkSessionContractRepository.js');
  const session=new WorkSessionProtocolRepository(manager.getDatabase()).ensureForTask({workspaceId:workspace.id,taskId:task.id,status:'completed'});
  const contracts=new WorkSessionContractRepository(manager.getDatabase());const contract=contracts.createOutcomeContract({sessionId:session.session.id,taskId:task.id,objective:'Produce fixture report',requirements:[{id:'output',kind:'output',description:'Report exists',required:true,verifier:'file_exists',targetPath:'fixture-report.txt',status:'satisfied'}]});
  require('node:fs').writeFileSync(require('node:path').join(workspace.path,'fixture-report.txt'),'fixture proof');
  const revision=contracts.createArtifactRevision({sessionId:session.session.id,taskId:task.id,path:'fixture-report.txt',mimeType:'text/plain',size:13,sha256:require('node:crypto').createHash('sha256').update('fixture proof').digest('hex'),status:'committed'});
  const evidence=contracts.appendEvidence({sessionId:session.session.id,contractId:contract.id,claim:'Fixture report exists',sourceType:'artifact_revision',sourceRef:'Private source omitted',artifactRevisionId:revision.id,status:'supporting'});
  contracts.updateOutcomeContract(contract.id,{status:'satisfied',requirements:contract.requirements.map(r=>({...r,evidenceIds:[evidence.id]}))});
 }
 if(process.env.COWORK_BOT_STOP_FIXTURE==='1'){
 const tasks=new TaskStore(manager.getDatabase());const root=tasks.create({title:'Paused stop fixture',prompt:'Do not run a model',workspaceId:workspace.id,assignedAgentRoleId:active.id,status:'paused'});
 if(process.env.COWORK_BOT_GRAPH_STOP_FIXTURE==='1'){
  const {OrchestrationGraphStore}=require('./dist/daemon/electron/agent/orchestration/OrchestrationGraphRepository.js');
  const linked=tasks.create({title:'Unparented local graph work',prompt:'Do not run a model',workspaceId:workspace.id,status:'paused'});
  new OrchestrationGraphStore(manager.getDatabase()).createRun({run:{id:'fixture-graph',rootTaskId:root.id,workspaceId:workspace.id,kind:'delegation',status:'running',maxParallel:1},nodes:[{id:'fixture-linked',key:'linked',title:'Linked local work',prompt:'Fixture',kind:'child_task',status:'running',dispatchTarget:'local_role',taskId:linked.id},{id:'fixture-future',key:'future',title:'Future work',prompt:'Fixture',kind:'child_task',status:'pending',dispatchTarget:'local_role'}]});
 }
}
 if(process.env.COWORK_BOT_STOP_RECOVERY==='1'){const {BotWorkControlStore}=require('./dist/daemon/electron/automation/BotWorkControlStore.js'); new BotWorkControlStore(manager.getDatabase()).begin({scope:{workspaceId:workspace.id,agentRoleId:active.id},requestId:'fixture-stop-empty',action:'stop_bot'},Date.now());}
 (async()=>{const ids=[];for(let index=0;index<2;index++)ids.push((await routines.create({name:'Paused fixture '+index,enabled:false,workspaceId:workspace.id,prompt:'Fixture',connectors:[],triggers:[{id:'manual',type:'manual',enabled:true}]})).id); await routines.stopWorkflowRuntime();
 console.log('RESPONSIBILITY_FIXTURE='+JSON.stringify({scope:{workspaceId:workspace.id,agentRoleId:active.id},engines:ids,resultTaskId}));
 roles.update({id:bot.id,isActive:false}); if(roles.findById(bot.id)?.isActive !== false) throw new Error("Fixture was not deactivated"); manager.close(); console.log('FIXTURE_BOT_ID='+bot.id);})().catch(error=>{console.error(error);process.exitCode=1;});
`;
// Only basic process environment is inherited; ambient provider keys are excluded.
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
  COWORK_BOT_RESULT_FIXTURE: resultEvidenceFixture ? "1" : "0",
  COWORK_BOT_GRAPH_STOP_FIXTURE: graphWorkControlFixture ? "1" : "0",
  COWORK_BOT_STOP_FIXTURE: workControlFixture ? "1" : "0",
  COWORK_BOT_STOP_RECOVERY: recoveryFixture ? "1" : "0",
});
let child;
const sockets = new Set();
let requestId = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function rpc(socket, method, params = {}) {
  const id = String(++requestId);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {socket.off("message", onMessage); reject(new Error(`RPC timed out: ${method}`));}, 5000);
    function onMessage(raw) {const frame = JSON.parse(String(raw)); if (frame.type !== "res" || frame.id !== id) return; clearTimeout(timer); socket.off("message", onMessage); resolve(frame);}
    socket.on("message", onMessage); socket.send(JSON.stringify({type:"req", id, method, params}));
  });
}
async function connect(port) {const socket = new WebSocket(`ws://127.0.0.1:${port}`); sockets.add(socket); await new Promise((resolve, reject) => {socket.once("open", resolve); socket.once("error", reject);}); return socket;}
async function stop() {
  for (const socket of sockets) socket.terminate(); sockets.clear();
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  let timer;
  const clean = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), 15000);
    }),
  ]);
  clearTimeout(timer);
  if (!clean) {child.kill("SIGKILL"); await exited; throw new Error("Fixture daemon did not drain before shutdown deadline");}
  assert.equal(child.exitCode, 0, "Fixture shutdown failed");
}
try {
  const seeded = spawnSync(process.execPath, ["-e", seedCode], {
    cwd: root,
    env: environment,
    encoding: "utf8",
  });
  assert.equal(seeded.status, 0, "Build the Node daemon before running this fixture");
  const botId = seeded.stdout.match(/FIXTURE_BOT_ID=(\S+)/)?.[1]; assert(botId);
  const fixture = JSON.parse(seeded.stdout.match(/RESPONSIBILITY_FIXTURE=(.+)/)[1]);
  const definition = (engineId) => ({
    objective: "Inspect evidence",
    engine: { kind: "routine", id: engineId },
    mode: "observe",
    sources: [],
    permittedActions: [],
    expectedOutput: "Internal report",
    reviewBoundary: "all_effects",
    destination: { channel: "internal", id: "results" },
    backend: "node",
    budget: { maxTokens: 1000, maxCost: 1 },
  });
  let savedIds = [],savedNotificationRetry;
  const proofs = [];
  for (let pass = 0; pass < 2; pass++) {
    const port = await freePort();
    let output = "";
    child = spawn(
      process.execPath,
      [
        entrypoint,
        "--headless",
        "--enable-control-plane",
        "--print-control-plane-token",
        "--no-import-env-settings",
        "--control-plane-host",
        "127.0.0.1",
        "--control-plane-port",
        String(port),
      ],
      { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.on("data", (data) => {
      output += String(data);
    });
    child.stderr.on("data", (data) => {
      output += String(data);
    });
    const deadline = Date.now() + 45000;
    let token;
    while (Date.now() < deadline) {token = output.match(/Control Plane token: (\S+)/)?.[1]; if (token && output.includes("Control Plane listening:")) break; if (child.exitCode !== null) throw new Error("Fixture daemon exited during startup"); await sleep(100);}
    // The generated fixture credential is consumed internally and never printed.
    assert(token, "Fixture daemon did not start its authenticated local endpoint");
    const denied = await rpc(await connect(port), "automation.runtime.status");
    assert.equal(denied.ok, false);
    const socket = await connect(port);
    assert.equal(
      (await rpc(socket, "connect", { token, deviceName: "disposable-bot-runtime-fixture" })).ok,
      true,
    );
    if(resultEvidenceFixture){
      const request={...fixture.scope,taskId:fixture.resultTaskId};
      assert.equal((await rpc(await connect(port),"bot.work.result",request)).ok,false);
      const get=async()=>{const reply=await rpc(socket,"bot.work.result",request);assert.equal(reply.ok,true,JSON.stringify(reply.error));return reply.payload;};
      let result=await get();assert.equal(result.recordedVerification,"passed");assert.equal(result.delivery,"unknown");assert.equal(result.outputs[0].check,"matches");assert.equal(result.contract.requirements[0].currentEvidence,"matches");assert(!JSON.stringify(result).includes("Private source omitted"));
      await fs.writeFile(path.join(directory,"fixture-report.txt"),"changed");result=await get();assert.equal(result.outputs[0].check,"changed");assert.equal(result.contract.requirements[0].currentEvidence,"failed");
      await fs.unlink(path.join(directory,"fixture-report.txt"));assert.equal((await get()).outputs[0].check,"missing");
      await fs.writeFile(path.join(directory,"fixture-report.txt"),"fixture proof");
      assert.equal((await rpc(socket,"bot.work.result",{...request,agentRoleId:botId})).ok,false);
    }
    if(botNotificationFixture){
      const current=await rpc(socket,"bot.notification.route.get",fixture.scope);assert.equal(current.ok,true);
      assert.equal((await rpc(await connect(port),"bot.notification.route.get",fixture.scope)).ok,false);
      if(pass===0){
        const update={scope:fixture.scope,requestId:randomUUID(),expectedVersion:current.payload.version,options:{enabled:true,destination:"inbox",quietHours:null,digestMinutes:0}};
        const saved=await rpc(socket,"bot.notification.route.update",update);assert.equal(saved.ok,true);assert.equal((await rpc(socket,"bot.notification.route.update",update)).payload.version,saved.payload.version);
        const FixtureDatabase=require("better-sqlite3");const fixtureDb=new FixtureDatabase(path.join(directory,"cowork-os.db"));
        try{fixtureDb.prepare("UPDATE tasks SET result_summary='Synthetic meaningful result',updated_at=? WHERE id=?").run(Date.now()+1,fixture.resultTaskId);}finally{fixtureDb.close();}
      }else assert.equal(current.payload.enabled,true);
      let receipts=[];const until=Date.now()+15000;
      while(Date.now()<until){const reply=await rpc(socket,"bot.notification.receipts",fixture.scope);assert.equal(reply.ok,true);receipts=reply.payload;if(receipts.some(row=>row.state==='stored_in_inbox'))break;await sleep(100);}
      assert.equal(receipts.length,1);assert.equal(receipts[0].state,'stored_in_inbox');assert.equal(receipts[0].desktop,'not_requested');
      const InboxDatabase=require('better-sqlite3');const inboxDb=new InboxDatabase(path.join(directory,'cowork-os.db'),{readonly:true});
      let entry;try{const row=inboxDb.prepare('SELECT payload_json FROM notification_inbox_items WHERE id=?').get(receipts[0].notificationId);assert(row);entry=JSON.parse(row.payload_json);}finally{inboxDb.close();}assert(entry);assert.equal(entry.desktopAlert,false);assert.equal(entry.agentRoleId,fixture.scope.agentRoleId);
      if(pass===0){const MutableDatabase=require('better-sqlite3');const mutable=new MutableDatabase(path.join(directory,'cowork-os.db'));try{mutable.prepare("UPDATE bot_notification_intents SET state='delivery_unknown' WHERE id=?").run(receipts[0].id);}finally{mutable.close();}
        const retry={scope:fixture.scope,requestId:randomUUID(),intentId:receipts[0].id,expectedRouteVersion:(await rpc(socket,"bot.notification.route.get",fixture.scope)).payload.version};
        savedNotificationRetry=retry;
        assert.equal((await rpc(await connect(port),"bot.notification.retry",retry)).ok,false);
        const saved=await rpc(socket,"bot.notification.retry",retry);assert.equal(saved.ok,true,JSON.stringify(saved.error));assert.equal(saved.payload.state,'stored_in_inbox');assert.deepEqual((await rpc(socket,"bot.notification.retry",retry)).payload,saved.payload);
        assert.equal((await rpc(socket,"bot.notification.retry",{...retry,expectedRouteVersion:retry.expectedRouteVersion+1})).ok,false);
      }else {const replay=await rpc(socket,"bot.notification.retry",savedNotificationRetry);assert.equal(replay.ok,true);assert.equal(replay.payload.state,"stored_in_inbox");}

    }
    const status = await rpc(socket, "automation.runtime.status");
    assert.equal(status.ok, true);
    assert.equal(status.payload.runtime, "node");
    assert.equal(status.payload.scheduler, "owned");
    assert.equal(status.payload.capabilities.desktopInteraction, "waiting_for_desktop");
    assert.equal(status.payload.producers.length, 5);
    assert(status.payload.producers.every((producer) => producer.state === "running"));
    const choices = await rpc(socket, "bot.responsibility.engines", fixture.scope);
    assert.equal(choices.ok, true);
    assert.equal(choices.payload.length, 2);
    const preview = await rpc(socket, "bot.responsibility.preview", {
      scope: fixture.scope,
      definition: definition(fixture.engines[0]),
    });
    assert.equal(preview.ok, true);
    assert.equal(preview.payload.executionState, "paused");
    assert.equal(preview.payload.activationAvailable, true);
    if (pass === 0) {
      for (const engine of fixture.engines) {
        const created = await rpc(socket, "bot.responsibility.create", {
          scope: fixture.scope,
          definition: definition(engine),
        });
        assert.equal(created.ok, true);
        assert.equal(created.payload.state, "paused");
        savedIds.push(created.payload.id);
      }
      const revised = await rpc(socket, "bot.responsibility.revise", {
        scope: fixture.scope,
        id: savedIds[0],
        expectedRevision: 1,
        definition: { ...definition(fixture.engines[0]), objective: "Updated evidence objective" },
      });
      assert.equal(revised.ok, true);
      assert.equal(revised.payload.revision, 2);
      const stale = await rpc(socket, "bot.responsibility.revise", {
        scope: fixture.scope,
        id: savedIds[0],
        expectedRevision: 1,
        definition: definition(fixture.engines[0]),
      });
      assert.equal(stale.ok, false);
    }
    const listed = await rpc(socket, "bot.responsibility.list", fixture.scope);
    assert.equal(listed.ok, true);
    assert.deepEqual(listed.payload.map((item) => item.id).sort(), [...savedIds].sort());
    assert.deepEqual(listed.payload.map((item) => item.revision).sort(), [1, 2]);
    const selected = listed.payload.find((item) => item.id === savedIds[0]);
    const controls = {
      scope: fixture.scope,
      id: selected.id,
      expectedRevision: selected.revision,
      expectedControlVersion: selected.controlVersion,
    };
    const activated = await rpc(socket, "bot.responsibility.activate", controls);
    assert.equal(activated.ok, true);
    assert.equal(activated.payload.state, "active");
    if (pass === 1)
      assert.equal(
        selected.futurePaused,
        true,
        "Future pause must survive restart and schema upgrade",
      );
    const futureRequest = {
      ...controls,
      expectedControlVersion: activated.payload.controlVersion,
      expectedFutureControlVersion: selected.futureControlVersion ?? 0,
      requestId: `fixture-future-${pass}`,
      paused: true,
    };
    const future = await rpc(socket, "bot.responsibility.futureRuns", futureRequest);
    assert.equal(future.ok, true);
    assert.equal(future.payload.futurePaused, true);
    assert.deepEqual(future.payload.stillActiveTaskIds, []);
    const futureReplay = await rpc(socket, "bot.responsibility.futureRuns", futureRequest);
    assert.deepEqual(futureReplay.payload, future.payload);
    const stopRequest = {
      scope: fixture.scope,
      requestId: "fixture-stop-empty",
      action: "stop_bot",
    };
    if (recoveryFixture) {
      const recovered = await rpc(socket, "bot.work.control.get", { scope: fixture.scope, requestId: stopRequest.requestId });
      assert.equal(recovered.ok, true);
      assert.equal(recovered.payload.tasks[0].status, "stopped", "Startup must finish the persisted stop before an API retry");
      assert.deepEqual(recovered.payload.stillActiveTaskIds, []);
    }
    const stopped = await rpc(socket, "bot.work.stop", stopRequest);
    assert.equal(stopped.ok, true);
    assert.equal(stopped.payload.status, "settled");
    if (workControlFixture) {
      assert.equal(stopped.payload.tasks.length, graphWorkControlFixture ? 2 : 1);
      assert.ok(stopped.payload.tasks.every(task => task.status === "stopped"));
      assert.equal(stopped.payload.tasks[0].status, "stopped");
      assert.deepEqual(stopped.payload.stillActiveTaskIds, []);
    } else assert.deepEqual(stopped.payload.tasks, []);
    const stopReplay = await rpc(socket, "bot.work.stop", stopRequest);
    assert.deepEqual(stopReplay.payload, stopped.payload);
    const stopRead = await rpc(socket, "bot.work.control.get", {
      scope: fixture.scope,
      requestId: stopRequest.requestId,
    });
    assert.deepEqual(stopRead.payload, stopped.payload);
    const paused = await rpc(socket, "bot.responsibility.pause", {
      ...controls,
      expectedControlVersion: activated.payload.controlVersion,
    });
    assert.equal(paused.ok, true);
    assert.equal(paused.payload.state, "paused");
    assert.equal(paused.payload.controlVersion, selected.controlVersion + 2);
    if (pass === 1)
      assert(
        selected.controlVersion >= 3,
        "Control epochs must survive the earlier schema upgrade",
      );

    if(botFutureFixture){
      const futureState=await rpc(socket,"bot.work.control.state",{scope:fixture.scope});assert.equal(futureState.ok,true);
      if(pass===1)assert.equal(futureState.payload.futurePaused,true,"Bot pause must survive restart and schema upgrade");
      const botPauseRequest={scope:fixture.scope,requestId:`fixture-bot-pause-${pass}`,action:"pause_bot"};
      const botPause=await rpc(socket,"bot.work.stop",botPauseRequest);assert.equal(botPause.ok,true);assert.equal(botPause.payload.futureControl.futurePaused,true);assert.equal(botPause.payload.futureControl.responsibilityIds.length,2);
      assert.deepEqual((await rpc(socket,"bot.work.stop",botPauseRequest)).payload,botPause.payload);
      const denied=await rpc(socket,"task.create",{title:"Denied fixture",prompt:"Do not run a model",workspaceId:fixture.scope.workspaceId,assignedAgentRoleId:fixture.scope.agentRoleId});assert.equal(denied.ok,false,"A future-paused bot cannot admit a new root");assert.match(JSON.stringify(denied.error??denied),/Bot future runs are paused/);
      const both=await rpc(socket,"bot.work.stop",{scope:fixture.scope,requestId:`fixture-stop-and-pause-${pass}`,action:"stop_and_pause"});assert.equal(both.ok,true);assert.equal(both.payload.futureControl.futurePaused,true);assert.deepEqual(both.payload.stillActiveTaskIds,[]);
      const oldResume=await rpc(socket,"bot.work.stop",{scope:fixture.scope,requestId:`fixture-old-resume-${pass}`,action:"resume_bot",expectedFutureControlVersion:botPause.payload.futureControl.futureControlVersion});assert.equal(oldResume.ok,false);assert.match(JSON.stringify(oldResume.error??oldResume),/future control version changed/);
      const botResume=await rpc(socket,"bot.work.stop",{scope:fixture.scope,requestId:`fixture-bot-resume-${pass}`,action:"resume_bot",expectedFutureControlVersion:both.payload.futureControl.futureControlVersion});assert.equal(botResume.ok,true);assert.equal(botResume.payload.futureControl.futurePaused,false);
      const bindings=await rpc(socket,"bot.responsibility.list",fixture.scope);assert.equal(bindings.ok,true);assert.ok(bindings.payload.some(item=>item.futurePaused),"Bot resume preserves the individual future pause");
      const finalPause=await rpc(socket,"bot.work.stop",{scope:fixture.scope,requestId:`fixture-final-bot-pause-${pass}`,action:"pause_bot"});assert.equal(finalPause.ok,true);
    }
    proofs.push({
      botNotificationRetry:botNotificationFixture,botNotificationReceipt:botNotificationFixture,
      resultEvidenceWorker:resultEvidenceFixture,
      activationAndPauseWithoutTasks: true,
      futurePauseReceiptReplay: true,
      emptyWorkStopReceiptReplay: !workControlFixture,
      seededPausedTaskStopped: workControlFixture,
      localGraphCleanup: graphWorkControlFixture,
      botFutureControls:botFutureFixture,
      startupStopRecovery: recoveryFixture,
      workControlReadParity: true,
      futurePausePersisted: pass === 1,
      controlEpochPreserved: pass === 1,
      pausedOnlySchemaUpgrade: pass === 1,
      responsibilityApi: true,
      independentPausedDefinitions: 2,
      staleRevisionRejected: true,
      pass: pass + 1,
      authenticatedStatus: true,
      unauthenticatedDenied: true,
      producers: status.payload.producers.map((producer) => ({
        id: producer.id,
        state: producer.state,
      })),
    });
    await stop();
    const Database = require("better-sqlite3"); const db = new Database(path.join(directory, "cowork-os.db"), {readonly:true});
    try {
      assert.deepEqual(
        db
          .prepare(
            "SELECT name, system_prompt, is_active, heartbeat_enabled FROM agent_roles WHERE id = ?",
          )
          .get(botId),
        {
          name: "private-fixture-839",
          system_prompt: "Preserve these private instructions",
          is_active: 0,
          heartbeat_enabled: 0,
        },
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM tasks").get().count,
        (graphWorkControlFixture ? 2 : workControlFixture ? 1 : 0)+(resultEvidenceFixture?1:0),
        "Startup must not create work",
      );
      if (workControlFixture)
        assert.equal(db.prepare("SELECT status FROM tasks WHERE title='Paused stop fixture' LIMIT 1").get().status, "cancelled");
      if (graphWorkControlFixture) {
        assert.equal(db.prepare("SELECT status FROM orchestration_graph_runs WHERE id='fixture-graph'").get().status,"cancelled");
        assert.deepEqual(db.prepare("SELECT status FROM orchestration_graph_nodes ORDER BY id").all().map(row=>row.status),["cancelled","cancelled"]);
        assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE status <> 'cancelled' AND title <> 'Result fixture'").get().count,0);
      }
      assert.match(
        db.prepare("SELECT sql FROM sqlite_master WHERE name='bot_responsibilities'").get().sql,
        /state\s+IN\s*\('paused','active'\)/i,
        "Actual startup must upgrade the paused-only constraint",
      );
      assert.deepEqual(
        db.pragma("foreign_key_check"),
        [],
        "Schema upgrade must preserve references",
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM bot_responsibility_revisions").get().count,
        3,
        "Revision history must survive restart",
      );
    } finally {
      db.close();
    }
    if (pass === 0) {
      // Reproduce the earlier paused-only schema in this disposable profile.
      // The next actual daemon startup must migrate it with IDs/revisions preserved.
      const upgradeDb=new Database(path.join(directory,"cowork-os.db"));
      try {
        const parents = upgradeDb.prepare("SELECT * FROM bot_responsibilities").all();
        const revisions = upgradeDb.prepare("SELECT * FROM bot_responsibility_revisions").all();
        const { BOT_RESPONSIBILITY_SCHEMA } = require(
          path.join(root, "dist/daemon/electron/automation/responsibility-store.js"),
        );
        upgradeDb.transaction(() => {
          upgradeDb.exec(
            "DROP TABLE bot_responsibility_revisions; DROP TABLE bot_responsibilities;",
          );
          upgradeDb.exec(
            BOT_RESPONSIBILITY_SCHEMA.replace(
              "CHECK (state IN ('paused','active'))",
              "CHECK (state = 'paused')",
            ),
          );
          for (const row of parents)
            upgradeDb
              .prepare(
                "INSERT INTO bot_responsibilities(id,workspace_id,agent_role_id,engine_kind,engine_id,revision,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
              )
              .run(
                row.id,
                row.workspace_id,
                row.agent_role_id,
                row.engine_kind,
                row.engine_id,
                row.revision,
                row.state,
                row.created_at,
                row.updated_at,
              );
          for (const row of revisions)
            upgradeDb
              .prepare("INSERT INTO bot_responsibility_revisions VALUES(?,?,?,?)")
              .run(row.responsibility_id, row.revision, row.definition_json, row.created_at);
        })();
      } finally {upgradeDb.close();}
    }
  }
  console.log(
    JSON.stringify({
      fixture: true,
      modelExecution: false,
      channelDelivery: false,
      customBotPreserved: true,
      startupCreatedNoTasks: true,
      compiledEntrypointSha256: createHash("sha256")
        .update(await fs.readFile(entrypoint))
        .digest("hex"),
      compiledRuntimeSha256: createHash("sha256")
        .update(
          await fs.readFile(
            path.join(root, "dist/daemon/electron/automation/AutomationRuntime.js"),
          ),
        )
        .digest("hex"),
      compiledBootstrapSha256: createHash("sha256")
        .update(
          await fs.readFile(
            path.join(root, "dist/daemon/electron/automation/headless-bot-services.js"),
          ),
        )
        .digest("hex"),
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
