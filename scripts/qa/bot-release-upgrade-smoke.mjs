#!/usr/bin/env node
/**
 * Upgrade-path acceptance from the previous release. A disposable profile is created
 * by the PREVIOUS build (its compiled stores, then one run of its desktop app, which
 * seeds the legacy named bot roster and default team), and is then opened by the
 * current Node daemon (twice) and the current desktop app. User bots, prompts, teams,
 * membership, history, pending decisions, routines and memory must be preserved, and
 * the new schema must be added in place. No provider is configured and no channel or
 * model is contacted.
 *
 *   git worktree add --detach /tmp/cowork-baseline <previous-release-ref>
 *   (cd /tmp/cowork-baseline && ln -s "$PWD/node_modules" node_modules \
 *     && npm run build:daemon && npm run build:electron)
 *   COWORK_UPGRADE_BASELINE=/tmp/cowork-baseline node scripts/qa/bot-release-upgrade-smoke.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const WebSocket = require("ws");
const Database = require("better-sqlite3");
const electronExecutable = require("electron");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const baseline = process.env.COWORK_UPGRADE_BASELINE;
assert(baseline, "Set COWORK_UPGRADE_BASELINE to a built checkout of the previous release");
for (const entry of ["dist/daemon/daemon/main.js", "dist/electron/electron/main.js"])
  await fs.access(path.join(baseline, entry)).catch(() => {
    throw new Error(`The baseline checkout is missing ${entry}; build it first`);
  });
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-release-upgrade-"));
const workspacePath = path.join(profile, "workspace");
const dbPath = path.join(profile, "cowork-os.db");
const environment = Object.fromEntries(
  ["PATH", "HOME", "TMPDIR", "SystemRoot", "LANG", "LC_ALL"]
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]),
);
Object.assign(environment, {
  COWORK_USER_DATA_DIR: profile,
  COWORK_IMPORT_ENV_SETTINGS: "0",
  COWORK_PROFILE: "default",
  COWORK_DISABLE_OS_KEYCHAIN: "1",
});
assert.equal(
  Object.keys(environment).some((key) => /(?:OPENAI|ANTHROPIC|GEMINI|AZURE).*KEY/i.test(key)),
  false,
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(read, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function seedWithBaseline() {
  const source = String.raw`
    const {DatabaseManager}=require('./dist/daemon/electron/database/schema.js');
    const repos=require('./dist/daemon/electron/database/repositories.js');
    // 0.5.54 names the synchronous stores *Repository; later builds name them *Store.
    const WorkspaceStore=repos.WorkspaceStore||repos.WorkspaceRepository, TaskStore=repos.TaskStore||repos.TaskRepository, ApprovalStore=repos.ApprovalStore||repos.ApprovalRepository;
    const roleMod=require('./dist/daemon/electron/agents/AgentRoleRepository.js'); const AgentRoleStore=roleMod.AgentRoleStore||roleMod.AgentRoleRepository;
    const teamMod=require('./dist/daemon/electron/agents/AgentTeamRepository.js'); const AgentTeamStore=teamMod.AgentTeamStore||teamMod.AgentTeamRepository;
    const memberMod=require('./dist/daemon/electron/agents/AgentTeamMemberRepository.js'); const AgentTeamMemberStore=memberMod.AgentTeamMemberStore||memberMod.AgentTeamMemberRepository;
    const fs=require('fs'); const {RoutineService}=require(fs.existsSync('./dist/daemon/electron/routines/service.js')?'./dist/daemon/electron/routines/service.js':'./dist/electron/electron/routines/service.js');
    const manager=new DatabaseManager(); const db=manager.getDatabase();
    (async()=>{
      const ws=new WorkspaceStore(db).create('Upgrade workspace',process.env.UP_WS,{read:true,write:true,delete:false,shell:false,network:false});
      const roles=new AgentRoleStore(db);
      const mine=roles.create({name:'my-private-researcher',displayName:'My researcher',description:'User bot',capabilities:[],systemPrompt:'My private instructions. Keep them exactly.',heartbeatEnabled:false});
      const renamed=roles.create({name:'my-renamed-bot',displayName:'Before rename',capabilities:[],systemPrompt:'Renamed bot instructions.',heartbeatEnabled:false});
      roles.update({id:renamed.id,displayName:'After rename'});
      const retired=roles.create({name:'my-retired-bot',displayName:'Retired',capabilities:[],systemPrompt:'Retired instructions.',heartbeatEnabled:false});
      roles.update({id:retired.id,isActive:false});
      const team=new AgentTeamStore(db).create({workspaceId:ws.id,name:'My explicit team',leadAgentRoleId:mine.id});
      new AgentTeamMemberStore(db).add({teamId:team.id,agentRoleId:renamed.id});
      const tasks=new TaskStore(db);
      const done=tasks.create({workspaceId:ws.id,assignedAgentRoleId:mine.id,title:'Finished research',prompt:'Metadata only',status:'completed',resultSummary:'Done'});
      tasks.create({workspaceId:ws.id,parentTaskId:done.id,assignedAgentRoleId:renamed.id,title:'Delegated part',prompt:'Metadata only',status:'completed',resultSummary:'Done'});
      const waiting=tasks.create({workspaceId:ws.id,assignedAgentRoleId:mine.id,title:'Waiting for me',prompt:'Metadata only',status:'paused'});
      new ApprovalStore(db).create({taskId:waiting.id,type:'run_command',description:'Historical decision',details:{command:'never-run'},status:'denied',requestedAt:Date.now()-60000});
      const routines=new RoutineService({db,getCronService:()=>null,getEventTriggerService:()=>null,loadHooksSettings:()=>({enabled:false,token:'x',path:'/hooks',maxBodyBytes:1024,presets:[],mappings:[]}),saveHooksSettings:()=>{},createTask:async()=>{throw new Error('no dispatch');}});
      const routine=await routines.create({name:'My paused routine',enabled:false,workspaceId:ws.id,prompt:'Paused',connectors:[],triggers:[{id:'manual',type:'manual',enabled:true}]});
      await routines.stopWorkflowRuntime();
      manager.close();
      process.stdout.write('SEED='+JSON.stringify({workspaceId:ws.id,mine:mine.id,renamed:renamed.id,retired:retired.id,team:team.id,waiting:waiting.id,routine:routine.id})+'\n');
    })().catch(e=>{console.error(e);manager.close();process.exitCode=1;});
  `;
  const result = spawnSync(process.execPath, ["-e", source], {
    cwd: baseline,
    env: { ...environment, UP_WS: workspacePath },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, `Baseline seed failed: ${result.stderr}`);
  return JSON.parse(result.stdout.match(/SEED=(.+)/)[1]);
}

/**
 * The desktop app applies --control-plane-port only in headless mode; otherwise it binds the
 * port stored in the profile (default 18789, often taken by a running CoWork). Store the
 * chosen port with the runtime's own settings manager before a desktop start.
 */
function pinDesktopControlPlanePort(cwd, port) {
  const source = String.raw`
    const {DatabaseManager}=require('./dist/daemon/electron/database/schema.js');
    const {SecureSettingsRepository}=require('./dist/daemon/electron/database/SecureSettingsRepository.js');
    const {ControlPlaneSettingsManager}=require('./dist/daemon/electron/control-plane/settings.js');
    const manager=new DatabaseManager(); new SecureSettingsRepository(manager.getDatabase());
    ControlPlaneSettingsManager.initialize();
    ControlPlaneSettingsManager.updateSettings({host:'127.0.0.1',port:Number(process.env.UP_PORT)});
    manager.close();
  `;
  const result = spawnSync(process.execPath, ["-e", source], {
    cwd,
    env: { ...environment, UP_PORT: String(port) },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, `Pinning the control plane port failed: ${result.stderr}`);
}

/** Starts a runtime from `cwd`; desktop runs the Electron app with a hidden window. */
async function runtime(cwd, kind) {
  const port = await freePort();
  const args = [
    "--enable-control-plane",
    "--print-control-plane-token",
    "--no-import-env-settings",
    "--control-plane-host",
    "127.0.0.1",
    "--control-plane-port",
    String(port),
  ];
  const connectionPath = path.join(profile, "control-plane-local.json");
  await fs.rm(connectionPath, { force: true });
  if (kind === "desktop") pinDesktopControlPlanePort(cwd, port);
  const child =
    kind === "desktop"
      ? spawn(electronExecutable, [cwd, ...args, "--user-data-dir", profile], {
          cwd,
          env: { ...environment, COWORK_HEADLESS: "0", COWORK_TEST_HIDE_MAIN_WINDOW: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        })
      : spawn(process.execPath, [path.join(cwd, "dist/daemon/daemon/main.js"), "--headless", ...args], {
          cwd,
          env: { ...environment, COWORK_HEADLESS: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        });
  let output = "";
  child.stdout.on("data", (d) => (output = (output + d).slice(-100_000)));
  child.stderr.on("data", (d) => (output = (output + d).slice(-100_000)));
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  let actualPort = port;
  const token = await waitFor(async () => {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`${kind} runtime exited early:\n${output.slice(-4000)}`);
    if (kind === "desktop") {
      const connection = await fs.readFile(connectionPath, "utf8").then(JSON.parse).catch(() => null);
      if (connection?.pid !== child.pid) return null;
      actualPort = Number(new URL(connection.url).port);
      return connection.token;
    }
    const value = output.match(/Control Plane token: (\S+)/)?.[1];
    return value && output.includes("Control Plane listening:") ? value : null;
  }, `${kind} runtime from ${path.basename(cwd)}`).catch((error) => {
    child.kill("SIGKILL");
    throw new Error(`${error.message}\n${output.slice(-4000)}`);
  });
  const socket = new WebSocket(`ws://127.0.0.1:${actualPort}`);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  let id = 0;
  const rpc = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const requestId = `up-${++id}`;
      const timer = setTimeout(() => reject(new Error(`RPC timed out: ${method}`)), 30_000);
      const onMessage = (raw) => {
        const frame = JSON.parse(String(raw));
        if (frame.type !== "res" || frame.id !== requestId) return;
        clearTimeout(timer);
        socket.off("message", onMessage);
        resolve(frame);
      };
      socket.on("message", onMessage);
      socket.send(JSON.stringify({ type: "req", id: requestId, method, params }));
    });
  const auth = await rpc("connect", { token, deviceName: "release-upgrade" });
  assert.equal(auth.ok, true, JSON.stringify(auth.error));
  return {
    rpc,
    output: () => output,
    async stop({ allowForcedStop = false } = {}) {
      socket.terminate();
      child.kill("SIGTERM");
      const done = await Promise.race([exited, sleep(30_000).then(() => null)]);
      if (!done) {
        child.kill("SIGKILL");
        await exited;
        // The 0.5.54 desktop app does not exit on SIGTERM (its shutdown hangs after the
        // database closes); a forced stop is accepted for the previous build only.
        if (allowForcedStop) return { forced: true };
        throw new Error(`${kind} runtime did not stop`);
      }
      assert.equal(done.code, 0, `${kind} runtime shutdown failed:\n${output.slice(-4000)}`);
    },
  };
}

function snapshot() {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return {
      roles: db
        .prepare(
          `SELECT id,name,display_name,description,system_prompt,is_active,is_system,role_kind,
                  capabilities,model_key,provider_type
           FROM agent_roles ORDER BY id`,
        )
        .all(),
      teams: db.prepare("SELECT id,workspace_id,name,lead_agent_role_id FROM agent_teams ORDER BY id").all(),
      members: db.prepare("SELECT team_id,agent_role_id FROM agent_team_members ORDER BY team_id,agent_role_id").all(),
      tasks: db
        .prepare(
          `SELECT id,workspace_id,status,assigned_agent_role_id,parent_task_id,title,prompt,result_summary
           FROM tasks ORDER BY id`,
        )
        .all(),
      approvals: db.prepare("SELECT id,task_id,status,type,description,details FROM approvals ORDER BY id").all(),
      routines: db.prepare("SELECT id,workspace_id,definition_json FROM automation_routines ORDER BY id").all(),
    };
  } finally {
    db.close();
  }
}
const tableNames = () => {
  const db = new Database(dbPath, { readonly: true });
  try {
    return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
  } finally {
    db.close();
  }
};

let active;
try {
  await fs.mkdir(workspacePath, { recursive: true });
  const seed = seedWithBaseline();
  active = await runtime(baseline, "desktop");
  await sleep(6000); // let the previous build finish its startup seeding
  const baselineStop = await active.stop({ allowForcedStop: true });
  active = null;
  const old = snapshot();
  const legacyRoster = old.roles.filter((role) => /^(atlas|forge|scribe)/.test(role.name));
  const legacyTeam = old.teams.find((team) => team.name === "CoWork Bot Team");
  assert(legacyRoster.length > 0, "The previous desktop build is expected to seed its named roster");
  assert(!tableNames().has("bot_responsibilities"), "The baseline must predate the new schema");

  const proofs = [];
  for (const [label, cwd, kind] of [
    ["current Node daemon, first start", root, "node"],
    ["current Node daemon, second start", root, "node"],
    ["current desktop app", root, "desktop"],
  ]) {
    active = await runtime(cwd, kind);
    await sleep(kind === "desktop" ? 6000 : 3000);
    const status = await active.rpc("automation.runtime.status");
    assert.equal(status.ok, true, JSON.stringify(status.error));
    const scope = { workspaceId: seed.workspaceId, agentRoleId: seed.mine };
    const needs = await active.rpc("bot.work.list", { ...scope, view: "needs_you", limit: 100 });
    assert.equal(needs.ok, true, JSON.stringify(needs.error));
    assert.equal(needs.payload.items.filter((item) => item.taskId === seed.waiting).length, 1);
    const results = await active.rpc("bot.work.list", { ...scope, view: "results", limit: 100 });
    assert.equal(results.payload.items.length, 2, "Assigned and delegated history stays visible");
    const listed = await active.rpc("bot.responsibility.list", scope);
    assert.equal(listed.ok, true, JSON.stringify(listed.error));
    const metrics = await active.rpc("bot.metrics.summary", { ...scope, windowDays: 30 });
    assert.equal(metrics.ok, true, JSON.stringify(metrics.error));
    await active.stop();
    active = null;
    const current = snapshot();
    // Every pre-existing role keeps its identity, prompt, activation and kind; the
    // legacy roster is now ordinary user data and is neither rewritten nor removed.
    const oldIds = new Set(old.roles.map((role) => role.id));
    assert.deepEqual(
      current.roles.filter((role) => oldIds.has(role.id)),
      old.roles,
      `${label}: existing bots must be preserved exactly`,
    );
    const added = current.roles.filter((role) => !oldIds.has(role.id));
    assert(
      added.every((role) => role.is_system === 1),
      `${label}: only system catalog roles may be added: ${JSON.stringify(added.map((r) => r.name))}`,
    );
    assert.deepEqual(current.teams, old.teams, `${label}: teams must not be created or changed`);
    assert.deepEqual(current.members, old.members, `${label}: membership must not be repaired`);
    assert.deepEqual(current.tasks, old.tasks, `${label}: history must not change or grow`);
    assert.deepEqual(current.approvals, old.approvals, `${label}: decisions must not change`);
    assert.deepEqual(current.routines, old.routines, `${label}: routines must not change`);
    const tables = tableNames();
    for (const table of [
      "bot_responsibilities",
      "bot_work_control_receipts",
      "bot_notification_intents",
      "background_dispatch_denials",
      "responsibility_action_review_claims",
    ])
      assert(tables.has(table), `${label}: missing upgraded table ${table}`);
    proofs.push({ label, preserved: true, systemRolesAdded: added.length });
  }
  console.log(
    JSON.stringify(
      {
        status: "passed",
        baselineCommit: spawnSync("git", ["-C", baseline, "rev-parse", "--short", "HEAD"], {
          encoding: "utf8",
        }).stdout.trim(),
        previousDesktopForcedStop: Boolean(baselineStop?.forced),
        legacyRosterPreserved: legacyRoster.map((role) => role.name),
        legacyTeamPreserved: legacyTeam ? legacyTeam.name : null,
        userBotsPreserved: [seed.mine, seed.renamed, seed.retired].length,
        proofs,
        modelExecution: false,
        channelDelivery: false,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(`${error.stack || error}\n${active?.output().slice(-6000) ?? ""}`);
  process.exitCode = 1;
} finally {
  await active?.stop().catch(() => {});
  if (!process.env.UP_KEEP_PROFILE) await fs.rm(profile, { recursive: true, force: true });
  else console.error(`Profile kept at ${profile}`);
}
