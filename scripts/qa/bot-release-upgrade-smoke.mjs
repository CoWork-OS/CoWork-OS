#!/usr/bin/env node
/**
 * Upgrade-path acceptance from the previous release. A disposable profile is created
 * by the PREVIOUS build (its compiled stores, a channel with paired users written as raw
 * SQL, then one run of its desktop app, which may seed its own roster), and is then opened
 * by the current Node daemon (twice) and the current desktop app. User bots, prompts,
 * teams, membership, history, pending decisions, routines and memory must be preserved,
 * whatever the previous build seeded is kept as user data, and the new schema must be
 * added in place: the agent_roles columns (access_profile_id, works_on, desktop_host,
 * desktop_group) are added empty, and the one-time channel_users pairing reset (#459)
 * revokes every legacy grant and pending code once, never again. No provider is
 * configured and no channel or model is contacted.
 *
 * The baseline is the published package of the previous release (a git checkout of an
 * older tag may not build against the current node_modules). Pin the exact version:
 * setup re-runs npm install, which would otherwise resolve a caret range to a newer one.
 *
 *   mkdir /tmp/cowork-baseline && cd /tmp/cowork-baseline
 *   echo '{"name":"baseline","private":true}' > package.json
 *   npm install --ignore-scripts --omit=optional --save-exact cowork-os@0.5.60
 *   node node_modules/electron/install.js   # the Electron binary (skipped by --ignore-scripts)
 *   npm run --prefix node_modules/cowork-os setup
 *   cd - && npm run build:daemon && npm run build:electron
 *   COWORK_UPGRADE_BASELINE=/tmp/cowork-baseline/node_modules/cowork-os npm run qa:bots:upgrade
 *
 * A built checkout of the previous release works as the baseline too. UP_KEEP_PROFILE=1
 * keeps the profile for inspection.
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
assert(baseline, "Set COWORK_UPGRADE_BASELINE to the previous release (installed package or built checkout)");
for (const entry of ["dist/daemon/daemon/main.js", "dist/electron/electron/main.js"])
  await fs.access(path.join(baseline, entry)).catch(() => {
    throw new Error(`The baseline is missing ${entry}; build or set it up first`);
  });
const baselineVersion = JSON.parse(await fs.readFile(path.join(baseline, "package.json"), "utf8")).version;
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
      // A channel with a paired user (a legacy global grant) and one with a pending code.
      // Raw SQL over the columns every release has, so no store signature is assumed.
      const now=Date.now();
      db.prepare("INSERT INTO channels (id,type,name,enabled,config,security_config,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .run('up-channel','telegram','Upgrade channel',0,'{}',JSON.stringify({mode:'pairing'}),'disconnected',now,now);
      const user=db.prepare("INSERT INTO channel_users (id,channel_id,channel_user_id,display_name,username,allowed,pairing_code,pairing_attempts,pairing_expires_at,created_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
      user.run('up-user-paired','up-channel','tg-1001','Paired user','paired',1,null,0,null,now-60000,now-30000);
      user.run('up-user-pending','up-channel','tg-1002','Pending user','pending',0,'QA1234',1,now+3600000,now-50000,now-20000);
      manager.close();
      process.stdout.write('SEED='+JSON.stringify({workspaceId:ws.id,mine:mine.id,renamed:renamed.id,retired:retired.id,team:team.id,waiting:waiting.id,routine:routine.id,channelUsers:['up-user-paired','up-user-pending']})+'\n');
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
        // Older desktop builds (0.5.54) do not exit on SIGTERM (their shutdown hangs after
        // the database closes); a forced stop is accepted for the previous build only.
        if (allowForcedStop) return { forced: true };
        throw new Error(`${kind} runtime did not stop`);
      }
      assert.equal(done.code, 0, `${kind} runtime shutdown failed:\n${output.slice(-4000)}`);
    },
  };
}

/** The agent_roles columns added in 0.5.61; empty for every role that existed before. */
const NEW_ROLE_COLUMNS = ["access_profile_id", "works_on", "desktop_host", "desktop_group"];
/** The channel_users columns of the one-time pairing reset (#459). */
const PAIRING_COLUMNS = ["allowed_dm", "allowed_group", "pairing_context"];

function withDb(read, { readonly = true } = {}) {
  const db = new Database(dbPath, { readonly, fileMustExist: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}
const columnNames = (table) =>
  withDb((db) => new Set(db.pragma(`table_info(${table})`).map((column) => column.name)));
const tableNames = () =>
  withDb((db) => new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)));

function snapshot() {
  return withDb((db) => ({
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
  }));
}
/** Channel users with every column the profile has (the pairing columns once added). */
const channelUsers = () => withDb((db) => db.prepare("SELECT * FROM channel_users ORDER BY id").all());
/** The new agent_roles columns of the given roles. */
const newRoleColumns = (ids) =>
  withDb((db) =>
    db
      .prepare(`SELECT id,${NEW_ROLE_COLUMNS.join(",")} FROM agent_roles WHERE id IN (${ids.map(() => "?").join(",")})`)
      .all(...ids),
  );

let active;
try {
  await fs.mkdir(workspacePath, { recursive: true });
  const seed = seedWithBaseline();
  active = await runtime(baseline, "desktop");
  await sleep(6000); // let the previous build finish its startup seeding
  const baselineStop = await active.stop({ allowForcedStop: true });
  active = null;
  const old = snapshot();
  // Whatever the previous desktop build seeded (0.5.54 seeds a named roster and a default
  // team; later builds seed nothing) is ordinary user data from here on.
  const legacyRoster = old.roles.filter((role) => /^(atlas|forge|scribe)/.test(role.name));
  const legacyTeam = old.teams.find((team) => team.name === "CoWork Bot Team");
  const tablesBefore = tableNames();
  const roleColumnsBefore = columnNames("agent_roles");
  const pairingColumnsBefore = columnNames("channel_users");
  const usersBefore = channelUsers();
  assert.deepEqual(
    usersBefore.map((user) => user.id),
    seed.channelUsers,
    "The previous build keeps the seeded channel users",
  );
  // A baseline that predates the reset must run it on the first upgraded start.
  const expectPairingReset = PAIRING_COLUMNS.some((column) => !pairingColumnsBefore.has(column));
  // Columns the baseline already has are not new for this upgrade.
  const rolesColumnsAdded = NEW_ROLE_COLUMNS.filter((column) => !roleColumnsBefore.has(column));
  const oldRoleIds = old.roles.map((role) => role.id);
  const oldRoleExtras = rolesColumnsAdded.length === NEW_ROLE_COLUMNS.length ? null : newRoleColumns(oldRoleIds);

  const proofs = [];
  let usersAfterFirstStart = null;
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

    // agent_roles: the new columns exist and are not invented for existing roles.
    const roleColumns = columnNames("agent_roles");
    for (const column of NEW_ROLE_COLUMNS) assert(roleColumns.has(column), `${label}: agent_roles.${column} missing`);
    const extras = newRoleColumns(oldRoleIds);
    if (oldRoleExtras) assert.deepEqual(extras, oldRoleExtras, `${label}: existing role settings must not change`);
    else
      for (const role of extras)
        for (const column of NEW_ROLE_COLUMNS)
          assert.equal(role[column], null, `${label}: ${role.id}.${column} must start empty`);

    // channel_users (#459): the first upgraded start revokes every legacy grant and pending
    // code but keeps the users; a grant made afterwards survives every later start.
    const pairingColumns = columnNames("channel_users");
    for (const column of PAIRING_COLUMNS)
      assert(pairingColumns.has(column), `${label}: channel_users.${column} missing`);
    const users = channelUsers();
    const identity = ({ id, channel_id, channel_user_id, display_name, username, created_at }) => ({
      id,
      channel_id,
      channel_user_id,
      display_name,
      username,
      created_at,
    });
    assert.deepEqual(users.map(identity), usersBefore.map(identity), `${label}: channel users must be kept`);
    if (!usersAfterFirstStart) {
      if (expectPairingReset)
        for (const user of users)
          assert.deepEqual(
            {
              allowed: user.allowed,
              allowed_dm: user.allowed_dm,
              allowed_group: user.allowed_group,
              pairing_code: user.pairing_code,
              pairing_expires_at: user.pairing_expires_at,
              pairing_context: user.pairing_context,
            },
            {
              allowed: 0,
              allowed_dm: 0,
              allowed_group: 0,
              pairing_code: null,
              pairing_expires_at: null,
              pairing_context: null,
            },
            `${label}: legacy pairing of ${user.id} must be revoked`,
          );
      else assert.deepEqual(users, usersBefore, `${label}: context-scoped pairing must not change`);
      // The user pairs again in a direct message; that grant is not a legacy one.
      withDb(
        (db) =>
          db
            .prepare(
              "UPDATE channel_users SET allowed = 1, allowed_dm = 1, pairing_context = 'dm' WHERE id = 'up-user-paired'",
            )
            .run(),
        { readonly: false },
      );
      usersAfterFirstStart = channelUsers();
    } else {
      assert.deepEqual(users, usersAfterFirstStart, `${label}: the pairing reset must run only once`);
    }
    proofs.push({ label, preserved: true, systemRolesAdded: added.length });
  }
  console.log(
    JSON.stringify(
      {
        status: "passed",
        baselineVersion,
        previousDesktopForcedStop: Boolean(baselineStop?.forced),
        legacyRosterPreserved: legacyRoster.map((role) => role.name),
        legacyTeamPreserved: legacyTeam ? legacyTeam.name : null,
        userBotsPreserved: [seed.mine, seed.renamed, seed.retired].length,
        roleColumnsAdded: rolesColumnsAdded,
        pairingReset: expectPairingReset,
        channelUsersKept: seed.channelUsers.length,
        // Tables of removed features are dropped on purpose; the ones read above stay.
        tablesDropped: [...tablesBefore].filter((table) => !tableNames().has(table)).sort(),
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
