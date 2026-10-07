#!/usr/bin/env node
/**
 * Combined bot acceptance in ONE disposable profile, using the compiled Node daemon,
 * the Electron desktop app with a hidden window (for the exact human review that a
 * headless runtime cannot present) and a deterministic loopback OpenAI-compatible
 * provider. No real model, credential or channel is contacted.
 *
 * Gates exercised in order, across six runtime lifetimes plus offline edits:
 *   lifecycle (arbitrary bots, explicit team, rename, deactivation, revoked membership),
 *   work projection (ordinary + delegated, scope exclusion, read-only opening),
 *   scheduled Node responsibility (quiet no-signal, signal admission, no idle model calls),
 *   two independently revised responsibilities and the desktop-only boundary,
 *   exact approval across a SIGKILL during the approval wait, one committed write,
 *   bot pause/stop with unrelated work continuing, SIGKILL during a provider response,
 *   Memory Hub correction/forget used by fresh runs with group-audience exclusion,
 *   reservation/task-creation interruption, data preservation and a metrics baseline.
 *
 * Run after `npm run build:daemon && npm run build:electron && npm run build:web`:
 *   node scripts/qa/bot-final-acceptance.mjs
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const WebSocket = require("ws");
const Database = require("better-sqlite3");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const daemonEntry = path.join(root, "dist/daemon/daemon/main.js");
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-bot-final-acceptance-"));
const workspacePath = path.join(profile, "workspace");
const foreignPath = path.join(profile, "foreign-workspace");
const dbPath = path.join(profile, "cowork-os.db");
const providerKey = "final-acceptance-local-only";
const model = "final-acceptance-model";

const files = {
  evidence: "selected-evidence.txt",
  signal: "scheduled-signal.txt",
  write: "acceptance-write.txt",
};
const evidenceContent = "Final acceptance evidence: the service window starts at 07:40 UTC.\n";
const signalContent = "Scheduled signal: rotate the fixture key on Thursday.\n";
const writeBase = "Existing target before the reviewed write.\n";
const writeContent =
  "Final acceptance reviewed write: exact bytes survive a crash during approval.\n" +
  "UTF-8 proof: Lisbon · Porto · CoWork.\n";
const writeSha256 = crypto.createHash("sha256").update(writeContent, "utf8").digest("hex");
const decisionQuestionId = "responsibility_action_review_decision";

const markers = {
  observe: "[[FA-OBSERVE]]",
  independent: "[[FA-INDEPENDENT]]",
  schedule: "[[FA-SCHEDULE]]",
  act: "[[FA-ACT]]",
  memory: "[[FA-MEMORY]]",
  audience: "[[FA-AUDIENCE]]",
  unrelated: "[[FA-UNRELATED]]",
};
const facts = {
  original: "Final acceptance release location is Lisbon",
  corrected: "Final acceptance release location is Porto",
  privateOwner: "Fixture owner privately prefers secret violet stationery",
};

const childEnvironment = Object.fromEntries(
  ["PATH", "HOME", "TMPDIR", "SystemRoot", "LANG", "LC_ALL"]
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]),
);
Object.assign(childEnvironment, {
  COWORK_USER_DATA_DIR: profile,
  COWORK_IMPORT_ENV_SETTINGS: "0",
  COWORK_PROFILE: "default",
  COWORK_HEADLESS: "1",
});
assert.equal(
  Object.keys(childEnvironment).some((key) => /(?:OPENAI|ANTHROPIC|GEMINI|AZURE).*KEY/i.test(key)),
  false,
  "The disposable daemon must not inherit provider credentials",
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const proof = { phases: [] };
let phase = "setup";
function enter(name) {
  phase = name;
  proof.phases.push(name);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function waitFor(read, label, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function withDb(read) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  try {
    return read(db);
  } finally {
    db.close();
  }
}

/** Runs compiled store code in a separate Node process against the profile database. */
function runCompiled(label, source, extraEnv = {}) {
  const result = spawnSync(process.execPath, ["-e", source], {
    cwd: root,
    env: { ...childEnvironment, ...extraEnv },
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, `${label}: ${result.error?.message}`);
  assert.equal(result.status, 0, `${label} failed: ${result.stderr}`);
  const line = result.stdout.split("\n").find((value) => value.startsWith("RESULT="));
  assert(line, `${label} returned no result: ${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice("RESULT=".length));
}

const storeHeader = String.raw`
  const path=require('node:path');
  const {DatabaseManager}=require('./dist/daemon/electron/database/schema.js');
  const {WorkspaceStore,TaskStore}=require('./dist/daemon/electron/database/repositories.js');
  const {AgentRoleStore}=require('./dist/daemon/electron/agents/AgentRoleRepository.js');
  const {AgentTeamStore}=require('./dist/daemon/electron/agents/AgentTeamRepository.js');
  const {AgentTeamMemberStore}=require('./dist/daemon/electron/agents/AgentTeamMemberRepository.js');
  const {MemoryItemsRepository}=require('./dist/daemon/electron/memory/MemoryItemsRepository.js');
  const {MemoryWriter}=require('./dist/daemon/electron/memory/MemoryWriter.js');
  const {MemoryItemsHubService}=require('./dist/daemon/electron/memory/MemoryItemsHubService.js');
  const done=(value)=>process.stdout.write('RESULT='+JSON.stringify(value)+'\n');
`;

function seedProfile() {
  return runCompiled(
    "Profile seed",
    storeHeader +
      String.raw`
  const {RoutineService}=require('./dist/daemon/electron/routines/service.js');
  const {CronService}=require('./dist/daemon/electron/cron/service.js');
  const env=process.env;
  const manager=new DatabaseManager(); const db=manager.getDatabase();
  (async()=>{
    const roles=new AgentRoleStore(db);
    const emptyRoles=roles.findAll(true).length;
    const workspaces=new WorkspaceStore(db);
    const permissions={read:true,write:true,delete:false,shell:false,network:false};
    const workspace=workspaces.create('Final acceptance workspace',env.FA_WORKSPACE,permissions);
    const foreign=workspaces.create('Foreign acceptance workspace',env.FA_FOREIGN,permissions);
    const tag=env.FA_TAG;
    const botA=roles.create({name:'fa-'+tag+'-alpha',displayName:'Arbitrary '+tag+' alpha',description:'Disposable acceptance bot',capabilities:[],systemPrompt:env.FA_PROMPT_A,heartbeatEnabled:false});
    const botB=roles.create({name:'fa-'+tag+'-beta',displayName:'Arbitrary '+tag+' beta',description:'Disposable unrelated bot',capabilities:[],systemPrompt:env.FA_PROMPT_B,heartbeatEnabled:false});
    const botC=roles.create({name:'fa-'+tag+'-gamma',displayName:'Arbitrary '+tag+' gamma',description:'Disposable deactivated bot',capabilities:[],systemPrompt:'Deactivated private instructions',heartbeatEnabled:false});
    roles.update({id:botC.id,isActive:false});
    const teams=new AgentTeamStore(db); const members=new AgentTeamMemberStore(db);
    const teamsBefore=teams.listByWorkspace(workspace.id,true).length;
    const team=teams.create({workspaceId:workspace.id,name:'Explicit acceptance team',leadAgentRoleId:botA.id});
    members.add({teamId:team.id,agentRoleId:botB.id});
    const tasks=new TaskStore(db);
    const ordinary=tasks.create({workspaceId:workspace.id,assignedAgentRoleId:botA.id,title:'Seeded ordinary assignment',prompt:'Metadata only',status:'completed',resultSummary:'Seeded ordinary result'});
    const delegated=tasks.create({workspaceId:workspace.id,parentTaskId:ordinary.id,assignedAgentRoleId:botB.id,title:'Seeded delegated child',prompt:'Metadata only',status:'completed',resultSummary:'Seeded delegated result'});
    const unrelated=tasks.create({workspaceId:workspace.id,assignedAgentRoleId:botB.id,title:'Seeded unrelated work',prompt:'Metadata only',status:'completed',resultSummary:'Unrelated result'});
    const foreignTask=tasks.create({workspaceId:foreign.id,parentTaskId:ordinary.id,assignedAgentRoleId:botA.id,title:'Seeded foreign work',prompt:'Metadata only',status:'completed',resultSummary:'Foreign result'});
    const cron=new CronService({storePath:path.join(env.COWORK_USER_DATA_DIR,'cron/jobs.json'),cronEnabled:false,createTask:async()=>{throw new Error('Seed must not dispatch');}});
    await cron.start();
    const routines=new RoutineService({db,getCronService:()=>cron,getEventTriggerService:()=>null,loadHooksSettings:()=>({enabled:false,token:'fixture',path:'/hooks',maxBodyBytes:1024,presets:[],mappings:[]}),saveHooksSettings:()=>{},createTask:async()=>{throw new Error('Seed must not dispatch');}});
    const manual=[{id:'manual',type:'manual',enabled:true}];
    const create=(name,prompt,triggers=manual)=>routines.create({name,enabled:false,workspaceId:workspace.id,prompt,connectors:[],triggers,outputs:[{kind:'task_only'}]});
    const routine={
      observe:(await create('Observe evidence',env.FA_MARK_OBSERVE+' Read the selected evidence file and report the service window.')).id,
      independent:(await create('Independent paused',env.FA_MARK_INDEPENDENT+' Remain paused during acceptance.')).id,
      schedule:(await create('Scheduled signal',env.FA_MARK_SCHEDULE+' Read the selected scheduled signal and report it.',[{id:'schedule',type:'schedule',enabled:true,schedule:{kind:'every',everyMs:1000}}])).id,
      act:(await create('Act writer',env.FA_MARK_ACT+' Write the exact reviewed acceptance content.')).id,
      memory:(await create('Memory probe',env.FA_MARK_MEMORY+' Report the release location you know from memory.')).id,
    };
    await routines.stopWorkflowRuntime(); await cron.stop();
    const repo=new MemoryItemsRepository(db); const writer=new MemoryWriter({repository:repo,bumpHotMemoryVersion:()=>{}});
    const fact=await writer.ingest({kind:'project_fact',scope:'workspace',workspaceId:workspace.id,content:env.FA_FACT_ORIGINAL,source:'user_stated',pinned:true,sourceRef:{store:'final-acceptance',id:'release-location'}});
    const privateFact=await writer.ingest({kind:'preference',scope:'global',content:env.FA_FACT_PRIVATE,source:'user_stated',privacy:'private',pinned:true});
    if(fact.status!=='written'||privateFact.status!=='written') throw new Error('Memory seed was not written');
    manager.close();
    done({emptyRoles,teamsBefore,workspaceId:workspace.id,foreignWorkspaceId:foreign.id,bots:{a:botA.id,b:botB.id,c:botC.id},teamId:team.id,tasks:{ordinary:ordinary.id,delegated:delegated.id,unrelated:unrelated.id,foreign:foreignTask.id},routine,memory:{factId:fact.item.id,privateId:privateFact.item.id}});
  })().catch(error=>{console.error(error);manager.close();process.exitCode=1;});
`,
    {
      FA_WORKSPACE: workspacePath,
      FA_FOREIGN: foreignPath,
      FA_TAG: crypto.randomBytes(4).toString("hex"),
      FA_PROMPT_A: "Alpha private instructions must survive every restart unchanged.",
      FA_PROMPT_B: "Beta private instructions must survive every restart unchanged.",
      FA_MARK_OBSERVE: markers.observe,
      FA_MARK_INDEPENDENT: markers.independent,
      FA_MARK_SCHEDULE: markers.schedule,
      FA_MARK_ACT: markers.act,
      FA_MARK_MEMORY: markers.memory,
      FA_FACT_ORIGINAL: facts.original,
      FA_FACT_PRIVATE: facts.privateOwner,
    },
  );
}

function profileSnapshot(fixture) {
  return withDb((db) => ({
    // User-created bots only; the product's system-role catalog is tracked separately.
    roles: db
      .prepare(
        `SELECT id,name,display_name,system_prompt,is_active FROM agent_roles
         WHERE COALESCE(is_system,0)=0 AND COALESCE(role_kind,'custom') NOT IN ('system','persona_template')
         ORDER BY id`,
      )
      .all(),
    systemRoles: db
      .prepare(
        `SELECT r.id,r.is_system,r.role_kind,
           (SELECT COUNT(*) FROM agent_team_members m WHERE m.agent_role_id=r.id) AS memberships,
           (SELECT COUNT(*) FROM tasks t WHERE t.assigned_agent_role_id=r.id) AS assigned
         FROM agent_roles r
         WHERE COALESCE(r.is_system,0)=1 OR COALESCE(r.role_kind,'custom') IN ('system','persona_template')`,
      )
      .all(),
    teams: db.prepare("SELECT id,workspace_id,lead_agent_role_id FROM agent_teams ORDER BY id").all(),
    members: db.prepare("SELECT team_id,agent_role_id FROM agent_team_members ORDER BY id").all(),
    taskCount: db.prepare("SELECT COUNT(*) AS n FROM tasks").get().n,
    seededTasks: db
      .prepare(
        `SELECT id,status,assigned_agent_role_id,parent_task_id,workspace_id,result_summary
         FROM tasks WHERE id IN (?,?,?,?) ORDER BY id`,
      )
      .all(
        fixture.tasks.ordinary,
        fixture.tasks.delegated,
        fixture.tasks.unrelated,
        fixture.tasks.foreign,
      ),
  }));
}

/** Deterministic provider. Each request is classified by the acceptance markers it contains. */
async function startProvider() {
  const calls = [];
  let lastMode = null;
  let holdArmed = false;
  const held = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: model, object: "model" }] }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Fixture route not found" } }));
      return;
    }
    if (request.headers.authorization !== `Bearer ${providerKey}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Fixture credential rejected" } }));
      return;
    }
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Malformed fixture request" } }));
      return;
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const text = JSON.stringify(messages);
    const toolNames = (Array.isArray(body.tools) ? body.tools : [])
      .map((tool) => tool?.function?.name)
      .filter((name) => typeof name === "string");
    const isPlanning = text.toLowerCase().includes("create an execution plan.");
    const toolResults = messages.filter((m) => m?.role === "tool" || m?.tool_call_id);
    const found = Object.entries(markers)
      .filter(([, marker]) => text.includes(marker))
      .map(([mode]) => mode);
    const mode = found.at(-1) ?? lastMode;
    if (isPlanning && mode) lastMode = mode;
    const record = {
      index: calls.length,
      mode,
      isPlanning,
      toolNames,
      hasToolResult: toolResults.length > 0,
      toolResultText: toolResults.map((m) => String(m?.content ?? "")).join("\n"),
      text,
      at: Date.now(),
    };
    calls.push(record);

    const reply = () => {
      let message;
      let finishReason = "stop";
      const target =
        mode === "schedule" ? files.signal : mode === "act" ? files.write : files.evidence;
      if (isPlanning) {
        const verb = mode === "act" ? "Write the exact reviewed content to" : "Read";
        message = {
          role: "assistant",
          content: JSON.stringify({
            description: `Acceptance ${mode ?? "unknown"} plan.`,
            steps: [
              {
                id: "1",
                description:
                  mode === "unrelated" || mode === "audience" || mode === "memory"
                    ? "Answer directly from the provided context."
                    : `${verb} ${target} and report the result.`,
                kind: "primary",
                status: "pending",
              },
            ],
          }),
        };
      } else if (!record.hasToolResult && mode === "act" && toolNames.includes("write_file")) {
        finishReason = "tool_calls";
        message = {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: `call_fa_write_${calls.length}`,
              type: "function",
              function: {
                name: "write_file",
                // Absolute, as real models often send it; review must still bind the
                // canonical workspace-relative target.
                arguments: JSON.stringify({
                  path: path.join(workspacePath, files.write),
                  content: writeContent,
                }),
              },
            },
          ],
        };
      } else if (
        !record.hasToolResult &&
        ["observe", "schedule"].includes(mode) &&
        toolNames.includes("read_file")
      ) {
        finishReason = "tool_calls";
        message = {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: `call_fa_read_${calls.length}`,
              type: "function",
              function: { name: "read_file", arguments: JSON.stringify({ path: target }) },
            },
          ],
        };
      } else {
        message = { role: "assistant", content: `Acceptance ${mode ?? "unknown"} step complete.` };
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: `chatcmpl-fa-${calls.length}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, message, finish_reason: finishReason }],
          usage: { prompt_tokens: 48, completion_tokens: 16, total_tokens: 64 },
        }),
      );
    };
    if (holdArmed) {
      holdArmed = false;
      record.held = true;
      held.push({ record, reply, response });
      return;
    }
    reply();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  return {
    calls,
    held,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    armHold() {
      holdArmed = true;
    },
    releaseHeld() {
      for (const item of held.splice(0)) {
        if (!item.response.destroyed && !item.response.writableEnded) {
          try {
            item.reply();
          } catch {
            /* The daemon may already have aborted the request. */
          }
        }
      }
    },
    forTask(mode) {
      return calls.filter((call) => call.mode === mode);
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

let requestCounter = 0;
async function rpc(socket, method, params = {}, timeoutMs = 30_000) {
  const id = `fa-${++requestCounter}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`Control Plane request timed out: ${method}`));
    }, timeoutMs);
    function onMessage(raw) {
      let frame;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (frame.type !== "res" || frame.id !== id) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(frame);
    }
    socket.on("message", onMessage);
    socket.send(JSON.stringify({ type: "req", id, method, params }));
  });
}
async function call(socket, method, params = {}) {
  const frame = await rpc(socket, method, params);
  assert.equal(frame.ok, true, `${method} failed: ${JSON.stringify(frame.error)}`);
  return frame.payload;
}

/** A runtime lifetime: the headless Node daemon, or the Electron desktop app with a hidden window. */
class Daemon {
  constructor() {
    this.output = "";
    this.child = null;
    this.socket = null;
    this.kind = "node";
  }
  async start(kind = "node") {
    this.kind = kind;
    let port = await freePort();
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
    this.child =
      kind === "desktop"
        ? spawn(require("electron"), [root, ...args, "--user-data-dir", profile], {
            cwd: root,
            env: {
              ...childEnvironment,
              COWORK_HEADLESS: "0",
              COWORK_TEST_HIDE_MAIN_WINDOW: "1",
              COWORK_DISABLE_OS_KEYCHAIN: "1",
              COWORK_WEB_ENABLED: "1",
              COWORK_WEB_PUBLIC_ORIGIN: "",
              COWORK_WEB_TRUSTED_PROXY_ADDRESSES: "",
            },
            stdio: ["ignore", "pipe", "pipe"],
          })
        : spawn(process.execPath, [daemonEntry, "--headless", ...args], {
            cwd: root,
            env: { ...childEnvironment, COWORK_DISABLE_OS_KEYCHAIN: "1" },
            stdio: ["ignore", "pipe", "pipe"],
          });
    this.output = "";
    const append = (chunk) => {
      this.output = (this.output + String(chunk)).slice(-200_000);
    };
    this.child.stdout.on("data", append);
    this.child.stderr.on("data", append);
    this.exited = new Promise((resolve) =>
      this.child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    const token = await waitFor(
      async () => {
        if (this.child.exitCode !== null || this.child.signalCode !== null)
          throw new Error(`Runtime exited early\n${this.safeOutput()}`);
        if (kind === "desktop") {
          const connection = await fs
            .readFile(connectionPath, "utf8")
            .then(JSON.parse)
            .catch(() => null);
          if (connection?.pid !== this.child.pid || typeof connection.token !== "string")
            return null;
          port = Number(new URL(connection.url).port);
          return connection.token;
        }
        const value = this.output.match(/Control Plane token: (\S+)/)?.[1];
        return value && this.output.includes("Control Plane listening:") ? value : null;
      },
      `the ${kind} Control Plane`,
      120_000,
    );
    this.base = `http://127.0.0.1:${port}`;
    this.webSession = null;
    this.socket = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((resolve, reject) => {
      this.socket.once("open", resolve);
      this.socket.once("error", reject);
    });
    const auth = await rpc(this.socket, "connect", { token, deviceName: "bot-final-acceptance" });
    assert.equal(auth.ok, true, JSON.stringify(auth.error));
    // After a SIGKILL the previous scheduler lease must expire before this runtime owns it.
    this.ownedAfterMs = await waitFor(
      async () => {
        const started = Date.now();
        const status = await call(this.socket, "automation.runtime.status");
        return status.scheduler === "owned" ? Date.now() - started + 1 : null;
      },
      `${kind} scheduler ownership`,
      120_000,
    );
    return this;
  }
  call(method, params) {
    return call(this.socket, method, params);
  }
  /** Desktop decisions use the paired web host (the desktop's remote human surface). */
  async web(method, params, operationKey = `fa-${crypto.randomUUID()}`) {
    if (!this.webSession) {
      const pairing = await this.call("web.pair");
      const response = await fetch(`${this.base}/api/web/v1/session/pair`, {
        method: "POST",
        headers: { Origin: this.base, "Content-Type": "application/json" },
        body: JSON.stringify({ code: pairing.code }),
      });
      assert.equal(response.status, 200, `Web pairing failed with HTTP ${response.status}`);
      const paired = await response.json();
      const cookie = response.headers.get("set-cookie")?.split(";")[0];
      assert(cookie, "Web pairing must return a session cookie");
      this.webSession = { cookie, csrfToken: paired.csrfToken, apiVersion: paired.apiVersion };
    }
    const response = await fetch(`${this.base}/api/web/v1/rpc`, {
      method: "POST",
      headers: {
        Origin: this.base,
        Cookie: this.webSession.cookie,
        "X-CoWork-CSRF": this.webSession.csrfToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        apiVersion: this.webSession.apiVersion,
        type: "request",
        id: `fa-web-${crypto.randomUUID()}`,
        method,
        params,
        operationKey,
      }),
    });
    assert.equal(response.status, 200, `${method} web RPC failed with HTTP ${response.status}`);
    return { frame: await response.json(), operationKey };
  }
  rpc(method, params) {
    return rpc(this.socket, method, params);
  }
  async stop() {
    if (!this.child || this.child.exitCode !== null) return;
    this.socket?.terminate();
    this.child.kill("SIGTERM");
    const drained = await Promise.race([this.exited.then(() => true), sleep(20_000).then(() => false)]);
    if (!drained) {
      this.child.kill("SIGKILL");
      await this.exited;
      throw new Error(`Daemon did not drain before the deadline\n${this.safeOutput()}`);
    }
    assert.equal(this.child.exitCode, 0, `Daemon shutdown failed\n${this.safeOutput()}`);
    this.child = null;
  }
  async kill() {
    if (!this.child || this.child.exitCode !== null) return;
    this.socket?.terminate();
    this.child.kill("SIGKILL");
    const exit = await this.exited;
    assert.equal(exit.signal, "SIGKILL");
    this.child = null;
  }
  safeOutput() {
    return this.output
      .replaceAll(profile, "[disposable-profile]")
      .replaceAll(providerKey, "[redacted]")
      .replace(/Control Plane token: \S+/g, "Control Plane token: [redacted]")
      .replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  }
}

function taskRow(taskId) {
  return withDb((db) => db.prepare("SELECT * FROM tasks WHERE id=?").get(taskId));
}
async function waitTerminal(taskId, label, timeoutMs = 90_000) {
  return waitFor(
    () => {
      const row = taskRow(taskId);
      return row && ["completed", "failed", "cancelled", "interrupted"].includes(row.status)
        ? row
        : null;
    },
    label,
    timeoutMs,
  );
}
function responsibilityTasks(responsibilityId) {
  return withDb((db) =>
    db
      .prepare("SELECT id,status,agent_config FROM tasks ORDER BY created_at")
      .all()
      .filter((row) => {
        try {
          return JSON.parse(row.agent_config || "{}").responsibilityRun?.id === responsibilityId;
        } catch {
          return false;
        }
      }),
  );
}
function readLinkedReview(taskId) {
  return withDb((db) => {
    const linked = db
      .prepare(`
        SELECT i.id AS input_id, i.status AS input_status, i.answers, i.requested_at, l.approval_id, l.revision_hash
        FROM input_requests i JOIN approval_input_links l ON l.input_id=i.id
        WHERE i.task_id=? ORDER BY i.requested_at DESC LIMIT 1`)
      .get(taskId);
    if (!linked) return null;
    const approval = db
      .prepare("SELECT id,type,status,details FROM approvals WHERE id=?")
      .get(linked.approval_id);
    return { linked, approval, details: JSON.parse(approval.details) };
  });
}
function claimRows(taskId) {
  return withDb((db) =>
    db
      .prepare(
        `SELECT c.* FROM responsibility_action_review_claims c
         JOIN approvals a ON a.id=c.approval_id WHERE a.task_id=?`,
      )
      .all(taskId),
  );
}
const readWorkspaceFile = (name) => fs.readFile(path.join(workspacePath, name), "utf8");

function observeDefinition(routineId, objective, extra = {}) {
  return {
    objective,
    engine: { kind: "routine", id: routineId },
    mode: "observe",
    sources: [{ connectorId: "workspace_files", method: "read_file", resourceId: files.evidence }],
    permittedActions: [],
    expectedOutput: "A concise report grounded in the selected file.",
    reviewBoundary: "all_effects",
    destination: { channel: "internal", id: "acceptance-results" },
    backend: "node",
    budget: { maxTokens: 4000, maxCost: 0.25 },
    ...extra,
  };
}
const control = (binding) => ({
  id: binding.id,
  expectedRevision: binding.revision,
  expectedControlVersion: binding.controlVersion,
});

let provider;
let daemon;
try {
  await fs.mkdir(workspacePath, { recursive: true, mode: 0o700 });
  await fs.mkdir(foreignPath, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(workspacePath, files.evidence), evidenceContent, { mode: 0o600 });
  await fs.writeFile(path.join(workspacePath, files.write), writeBase, { mode: 0o600 });

  // ---------------------------------------------------------------- seed
  enter("seed: empty profile, arbitrary bots, explicit team, seeded work");
  const fixture = seedProfile();
  assert.equal(fixture.emptyRoles, 0, "A fresh profile must not install any bot");
  assert.equal(fixture.teamsBefore, 0, "A standalone bot must not create a team");
  const scopeA = { workspaceId: fixture.workspaceId, agentRoleId: fixture.bots.a };
  const scopeB = { workspaceId: fixture.workspaceId, agentRoleId: fixture.bots.b };
  const seeded = profileSnapshot(fixture);
  provider = await startProvider();
  daemon = new Daemon();

  // ---------------------------------------------------------------- lifetime 1
  enter("lifetime 1: runtime capability, read-only projection, scheduled responsibility");
  await daemon.start();
  await sleep(1500);
  const status = await daemon.call("automation.runtime.status");
  assert.equal(status.runtime, "node");
  assert.equal(status.capabilities.desktopInteraction, "waiting_for_desktop");
  const afterStart = profileSnapshot(fixture);
  assert.deepEqual(afterStart.roles, seeded.roles, "Startup must not create or rewrite bots");
  assert.deepEqual(afterStart.teams, seeded.teams, "Startup must not create teams");
  assert.deepEqual(afterStart.members, seeded.members, "Startup must not repair membership");
  assert.equal(afterStart.taskCount, seeded.taskCount, "Startup must not create tasks");

  const listLatencies = [];
  const timedList = async (scope, view) => {
    const started = performance.now();
    const page = await daemon.call("bot.work.list", { ...scope, view, limit: 100 });
    listLatencies.push(performance.now() - started);
    return page;
  };
  const results1 = await timedList(scopeA, "results");
  const resultIds = results1.items.map((item) => item.taskId);
  assert.equal(resultIds.filter((id) => id === fixture.tasks.ordinary).length, 1);
  assert.equal(resultIds.filter((id) => id === fixture.tasks.delegated).length, 1);
  assert.equal(
    results1.items.find((item) => item.taskId === fixture.tasks.delegated)?.ownership,
    "delegated",
  );
  assert(!resultIds.includes(fixture.tasks.unrelated), "Unrelated bot work must stay excluded");
  assert(!resultIds.includes(fixture.tasks.foreign), "Foreign workspace work must stay excluded");
  for (const view of ["needs_you", "working", "scheduled"]) await timedList(scopeA, view);
  const crossCursor = await daemon.rpc("bot.work.list", {
    ...scopeB,
    view: "results",
    limit: 1,
    cursor: Buffer.from(
      JSON.stringify({ ...scopeA, view: "results", updatedAt: Date.now(), id: "x" }),
    ).toString("base64url"),
  });
  assert.equal(crossCursor.ok, false, "A cursor from another bot must be rejected");
  assert.equal(provider.calls.length, 0, "Opening bot work must not call a model");
  assert.equal(profileSnapshot(fixture).taskCount, seeded.taskCount, "Opening work is read-only");

  await daemon.call("llm.configure", {
    providerType: "openai-compatible",
    apiKey: providerKey,
    model,
    settings: { baseUrl: provider.baseUrl },
  });
  const route = await daemon.call("bot.notification.route.get", scopeA);
  await daemon.call("bot.notification.route.update", {
    scope: scopeA,
    requestId: crypto.randomUUID(),
    expectedVersion: route.version,
    options: { enabled: true, destination: "inbox", quietHours: null, digestMinutes: 0 },
  });

  const observe = await daemon.call("bot.responsibility.create", {
    scope: scopeA,
    definition: observeDefinition(fixture.routine.observe, "Read the selected service evidence."),
  });
  const independent = await daemon.call("bot.responsibility.create", {
    scope: scopeA,
    definition: observeDefinition(fixture.routine.independent, "Independent objective, rev 1."),
  });
  const independentRevised = await daemon.call("bot.responsibility.revise", {
    scope: scopeA,
    id: independent.id,
    expectedRevision: independent.revision,
    definition: observeDefinition(fixture.routine.independent, "Independent objective, rev 2."),
  });
  const staleRevision = await daemon.rpc("bot.responsibility.revise", {
    scope: scopeA,
    id: independent.id,
    expectedRevision: independent.revision,
    definition: observeDefinition(fixture.routine.independent, "Stale objective."),
  });
  assert.equal(staleRevision.ok, false, "A stale revision must be rejected");
  assert.equal(independentRevised.revision, 2);
  assert.equal(observe.revision, 1, "Revising one responsibility must not revise another");
  const desktopPreview = await daemon.call("bot.responsibility.preview", {
    scope: scopeA,
    definition: { ...observeDefinition(fixture.routine.observe, "Desktop only."), backend: "desktop" },
  });
  assert.equal(desktopPreview.backendPresence, "requires_desktop");
  assert.equal(desktopPreview.activationAvailable, false);

  const schedule = await daemon.call("bot.responsibility.create", {
    scope: scopeA,
    definition: observeDefinition(fixture.routine.schedule, "Report the scheduled signal.", {
      sources: [{ connectorId: "workspace_files", method: "read_file", resourceId: files.signal }],
    }),
  });
  const scheduleActive = await daemon.call("bot.responsibility.activate", {
    scope: scopeA,
    ...control(schedule),
  });
  const cronJob = () =>
    fs
      .readFile(path.join(profile, "cron/jobs.json"), "utf8")
      .then((raw) => JSON.parse(raw).jobs.find((job) => job.state?.totalRuns > 0 && job.enabled))
      .catch(() => null);
  const quiet = await waitFor(
    async () => {
      const job = await cronJob();
      return job?.state.lastStatus === "skipped" && job.state.totalRuns >= 2 ? job : null;
    },
    "two quiet scheduled checks with a missing selected source",
    45_000,
  );
  assert.equal(responsibilityTasks(schedule.id).length, 0, "No-signal checks must not admit work");
  assert.equal(provider.calls.length, 0, "No-signal checks must not call a model");
  await fs.writeFile(path.join(workspacePath, files.signal), signalContent, { mode: 0o600 });
  const scheduledTask = await waitFor(
    () => responsibilityTasks(schedule.id)[0] ?? null,
    "the changed scheduled source to admit one task",
    45_000,
  );
  const scheduledDone = await waitTerminal(scheduledTask.id, "the scheduled task to finish");
  assert.equal(scheduledDone.status, "completed", scheduledDone.error ?? "scheduled task failed");
  assert(
    provider.forTask("schedule").some((c) => c.toolResultText.includes("rotate the fixture key")),
    "The scheduled run must read its selected signal",
  );
  const callsAfterSchedule = provider.calls.length;
  const runsAfterSchedule = (await cronJob())?.state.totalRuns ?? 0;
  await waitFor(
    async () => ((await cronJob())?.state.totalRuns ?? 0) >= runsAfterSchedule + 3,
    "three further scheduled checks",
    45_000,
  );
  assert.equal(responsibilityTasks(schedule.id).length, 1, "An unchanged source must stay quiet");
  assert.equal(provider.calls.length, callsAfterSchedule, "Quiet cycles must not call a model");
  const schedulePaused = await daemon.call("bot.responsibility.pause", {
    scope: scopeA,
    ...control(scheduleActive),
  });
  proof.schedule = {
    quietChecksBeforeSignal: quiet.state.totalRuns,
    admittedTasks: 1,
    idleModelCallsAfterSignal: 0,
    pausedState: schedulePaused.state,
  };

  const observeActive = await daemon.call("bot.responsibility.activate", {
    scope: scopeA,
    ...control(observe),
  });
  const runOnce = { scope: scopeA, ...control(observeActive), requestId: "fa-observe-1" };
  const observeRun = await daemon.call("bot.responsibility.run", runOnce);
  const observeReplay = await daemon.call("bot.responsibility.run", runOnce);
  assert.equal(observeReplay.backingTaskId, observeRun.backingTaskId, "Same request, same task");
  const observeDone = await waitTerminal(observeRun.backingTaskId, "the manual observe run");
  assert.equal(observeDone.status, "completed", observeDone.error ?? "observe failed");
  assert(
    provider.forTask("observe").some((c) => c.toolResultText.includes("07:40 UTC")),
    "The observe run must read its selected source",
  );
  assert(
    !provider.calls.some((c) => c.mode === "observe" && c.toolNames.includes("write_file")),
    "Observe must not be offered write tools",
  );
  const observeResult = await daemon.call("bot.work.result", {
    ...scopeA,
    taskId: observeRun.backingTaskId,
  });
  assert.equal(observeResult.status, "completed");
  assert.equal(observeResult.delivery, "unknown", "A completed task is not proof of delivery");
  const inboxReceipt = await waitFor(
    async () => {
      const page = await daemon.call("bot.notification.receipts", scopeA);
      const receipts = page.receipts ?? page.items ?? page;
      return Array.isArray(receipts)
        ? receipts.find(
            (r) => r.taskId === observeRun.backingTaskId && r.state === "stored_in_inbox",
          )
        : null;
    },
    "an inbox delivery receipt for the observe result",
    30_000,
  );
  proof.lifetime1 = {
    readOnlyProjection: true,
    observeTask: observeDone.status,
    resultVerification: observeResult.recordedVerification,
    inboxReceipt: inboxReceipt.state,
  };
  await daemon.stop();

  // ---------------------------------------------------------------- offline edit 1
  enter("offline: rename bot and revoke explicit membership");
  runCompiled(
    "Rename and revoke",
    storeHeader +
      String.raw`
  const manager=new DatabaseManager(); const db=manager.getDatabase();
  new AgentRoleStore(db).update({id:process.env.FA_BOT_A,displayName:'Renamed acceptance alpha'});
  const removed=new AgentTeamMemberStore(db).removeByTeamAndRole(process.env.FA_TEAM,process.env.FA_BOT_B);
  manager.close(); done({removed});
`,
    { FA_BOT_A: fixture.bots.a, FA_BOT_B: fixture.bots.b, FA_TEAM: fixture.teamId },
  );
  const renamed = profileSnapshot(fixture);
  assert.deepEqual(renamed.members, [], "Membership revocation must persist");

  // ---------------------------------------------------------------- lifetime 2
  enter("lifetime 2: rename preserves routing, headless reviewed-effect boundary");
  await daemon.start();
  await sleep(2000);
  const afterRestart = profileSnapshot(fixture);
  assert.deepEqual(afterRestart.roles, renamed.roles, "Restart must not rewrite bots");
  assert.deepEqual(afterRestart.teams, renamed.teams, "Restart must not create or repair teams");
  assert.deepEqual(afterRestart.members, [], "Revoked membership must stay revoked on restart");
  assert.equal(afterRestart.taskCount, renamed.taskCount, "Restart must not create tasks");
  const results2 = await timedList(scopeA, "results");
  for (const id of [fixture.tasks.ordinary, fixture.tasks.delegated, observeRun.backingTaskId])
    assert(results2.items.some((item) => item.taskId === id), "Rename must preserve work routing");

  const actDefinition = {
    objective: "Write the exact reviewed acceptance content to the selected file.",
    engine: { kind: "routine", id: fixture.routine.act },
    mode: "act",
    sources: [],
    permittedActions: [{ connectorId: "workspace_files", method: "write_file", resourceId: files.write }],
    expectedOutput: "The selected file contains the exact reviewed content.",
    reviewBoundary: "all_effects",
    destination: { channel: "internal", id: "acceptance-results" },
    backend: "node",
    budget: { maxTokens: 4000, maxCost: 0.25 },
  };
  const act = await daemon.call("bot.responsibility.create", { scope: scopeA, definition: actDefinition });
  const headlessPreview = await daemon.call("bot.responsibility.preview", {
    scope: scopeA,
    definition: actDefinition,
  });
  assert.equal(headlessPreview.activationAvailable, false);
  assert(
    headlessPreview.activationIssues.some((issue) => issue.includes("need the desktop app")),
    `A headless runtime must report reviewed effects honestly: ${headlessPreview.activationIssues}`,
  );
  const headlessActivate = await daemon.rpc("bot.responsibility.activate", {
    scope: scopeA,
    ...control(act),
  });
  assert.equal(headlessActivate.ok, false, "Headless activation of reviewed effects must fail closed");
  assert.equal(responsibilityTasks(act.id).length, 0);
  proof.desktopBoundary = {
    desktopBackendPreview: desktopPreview.backendPresence,
    headlessReviewedActivation: "blocked before dispatch",
  };
  await daemon.stop();

  // ---------------------------------------------------------------- lifetime 3 (desktop)
  enter("lifetime 3 (desktop): exact write review, SIGKILL while waiting");
  await daemon.start("desktop");
  const desktopStatus = await daemon.call("automation.runtime.status");
  assert.equal(desktopStatus.runtime, "desktop");
  assert.equal(desktopStatus.capabilities.desktopInteraction, "supported");
  await daemon.call("llm.configure", {
    providerType: "openai-compatible",
    apiKey: providerKey,
    model,
    settings: { baseUrl: provider.baseUrl },
  });
  const actActive = await waitFor(
    async () => {
      const frame = await daemon.rpc("bot.responsibility.activate", { scope: scopeA, ...control(act) });
      if (frame.ok) return frame.payload;
      if (!/scheduler|ownership/i.test(frame.error?.message ?? ""))
        throw new Error(`Desktop activation failed: ${JSON.stringify(frame.error)}`);
      return null;
    },
    "desktop scheduler ownership for activation",
    60_000,
  );
  const actRun = await daemon.call("bot.responsibility.run", {
    scope: scopeA,
    ...control(actActive),
    requestId: "fa-act-1",
  });
  const pendingReview = await waitFor(
    () => {
      const review = readLinkedReview(actRun.backingTaskId);
      return review?.linked.input_status === "pending" && review.approval.status === "pending"
        ? review
        : null;
    },
    "the inline exact-write review",
    90_000,
  );
  assert.equal(pendingReview.details.responsibilityActionReview.contentSha256, writeSha256);
  assert.equal(pendingReview.details.responsibilityActionReview.canonicalPath, files.write);
  assert.deepEqual(
    pendingReview.details.responsibilityActionReview.targetGrant,
    { permitted: true, grantedTargets: [files.write] },
    "The review tells the user the target is one of the granted files",
  );
  assert.equal(await readWorkspaceFile(files.write), writeBase, "No write before the decision");
  const needs = await timedList(scopeA, "needs_you");
  assert(needs.items.some((item) => item.taskId === actRun.backingTaskId), "Decision in Needs you");
  const providerCallsAtKill = provider.calls.length;
  await daemon.kill();

  // ---------------------------------------------------------------- lifetime 4 (desktop)
  enter("lifetime 4 (desktop): approval survives crash, one exact commit, pause/stop, provider crash");
  await daemon.start("desktop");
  await sleep(2500);
  assert.equal(provider.calls.length, providerCallsAtKill, "Restart must not replay the model");
  const recovered = readLinkedReview(actRun.backingTaskId);
  assert.equal(recovered.linked.input_id, pendingReview.linked.input_id);
  assert.equal(recovered.linked.input_status, "pending");
  assert.equal(recovered.approval.status, "pending");
  assert.equal(await readWorkspaceFile(files.write), writeBase, "Crash must not write");
  const decision = {
    requestId: recovered.linked.input_id,
    workspaceId: fixture.workspaceId,
    taskId: actRun.backingTaskId,
    expectedVersion: recovered.linked.requested_at,
    status: "submitted",
    answers: { [decisionQuestionId]: { optionLabel: "Allow once" } },
  };
  const forged = await daemon.web("input_request.respond", {
    ...decision,
    requestId: crypto.randomUUID(),
  });
  assert.notEqual(forged.frame.result?.decision, "submitted", "An unknown request cannot decide");
  const stale = await daemon.web("input_request.respond", {
    ...decision,
    expectedVersion: recovered.linked.requested_at - 1,
  });
  assert.notEqual(stale.frame.result?.decision, "submitted", "A stale version cannot decide");
  const foreignScope = await daemon.web("input_request.respond", {
    ...decision,
    workspaceId: fixture.foreignWorkspaceId,
  });
  assert.notEqual(foreignScope.frame.result?.decision, "submitted", "Wrong scope cannot decide");
  assert.equal(claimRows(actRun.backingTaskId).length, 0, "Rejected decisions claim nothing");
  const decided = await daemon.web("input_request.respond", decision);
  assert.equal(decided.frame.error, undefined, JSON.stringify(decided.frame.error));
  assert.equal(decided.frame.result?.decision, "submitted");
  await waitFor(
    async () => {
      const content = await readWorkspaceFile(files.write).catch(() => "");
      const claims = claimRows(actRun.backingTaskId);
      return content === writeContent && claims.length === 1 && claims[0].outcome === "committed";
    },
    "the exact approved write to commit once",
  );
  const replayed = await daemon.web("input_request.respond", decision, decided.operationKey);
  assert.equal(replayed.frame.result?.decision, "submitted", "Same key replays the receipt");
  const duplicate = await daemon.web("input_request.respond", decision);
  assert.notEqual(duplicate.frame.result?.status, "handled", "A second decision must not be handled");
  const actDone = await waitTerminal(actRun.backingTaskId, "the approved act task");
  assert.equal(actDone.status, "completed", actDone.error ?? "act task failed");
  assert.equal(claimRows(actRun.backingTaskId).length, 1, "A duplicate decision must not re-run");
  assert.equal(await readWorkspaceFile(files.write), writeContent);
  const actResult = await daemon.call("bot.work.result", { ...scopeA, taskId: actRun.backingTaskId });
  const writtenOutput = actResult.outputs.find((output) => output.path.endsWith(files.write));
  assert(writtenOutput, `The result card must list the reviewed output: ${JSON.stringify(actResult)}`);
  assert.equal(writtenOutput.sha256, writeSha256, "The recorded output is the approved revision");
  assert.equal(writtenOutput.check, "matches", "The current file must match the recorded output");
  assert.equal(actResult.delivery, "unknown", "A local write is not an external delivery");
  proof.approval = {
    crashDuringWait: "SIGKILL",
    providerReplayAfterRestart: 0,
    committedClaims: 1,
    duplicateDecision: duplicate.frame.result?.status ?? duplicate.frame.error?.code,
    contentSha256: writeSha256,
    resultOutput: { check: writtenOutput.check, revision: writtenOutput.revision },
  };

  const paused = await daemon.call("bot.work.stop", {
    scope: scopeA,
    requestId: "fa-pause-bot",
    action: "pause_bot",
  });
  assert.equal(paused.futureControl?.futurePaused, true);
  const deniedRun = await daemon.rpc("bot.responsibility.run", {
    scope: scopeA,
    ...control(observeActive),
    requestId: "fa-observe-while-paused",
  });
  assert.equal(deniedRun.ok, false, "A paused bot must not admit a responsibility run");
  const deniedTask = await daemon.rpc("task.create", {
    title: "Paused bot root",
    prompt: `${markers.unrelated} must not run`,
    workspaceId: fixture.workspaceId,
    assignedAgentRoleId: fixture.bots.a,
  });
  assert.equal(deniedTask.ok, false, "A paused bot must not receive a new assigned root");
  const unrelated = await daemon.call("task.create", {
    title: "Unrelated bot work",
    prompt: `${markers.unrelated} Reply with a short confirmation.`,
    workspaceId: fixture.workspaceId,
    assignedAgentRoleId: fixture.bots.b,
  });
  const unrelatedTaskId = unrelated.taskId ?? unrelated.task?.id ?? unrelated.id;
  const unrelatedDone = await waitTerminal(unrelatedTaskId, "unrelated bot work while A is paused");
  assert.equal(unrelatedDone.status, "completed", "Unrelated work must continue");
  const resumed = await daemon.call("bot.work.stop", {
    scope: scopeA,
    requestId: "fa-resume-bot",
    action: "resume_bot",
    expectedFutureControlVersion: paused.futureControl.futureControlVersion,
  });
  assert.equal(resumed.futureControl?.futurePaused, false);

  provider.armHold();
  const stopRun = await daemon.call("bot.responsibility.run", {
    scope: scopeA,
    ...control(observeActive),
    requestId: "fa-observe-stop",
  });
  await waitFor(() => provider.held.length === 1, "a held provider response to stop");
  const stopReceipt = await daemon.call("bot.work.stop", {
    scope: scopeA,
    requestId: "fa-stop-turn",
    action: "stop_turn",
    taskId: stopRun.backingTaskId,
  });
  const settled = await waitFor(
    async () => {
      const receipt = await daemon.call("bot.work.control.get", {
        scope: scopeA,
        requestId: "fa-stop-turn",
      });
      return receipt.status === "settled" ? receipt : null;
    },
    "the stop receipt to settle",
  );
  provider.releaseHeld();
  const stoppedRow = await waitTerminal(stopRun.backingTaskId, "the stopped turn");
  assert.equal(stoppedRow.status, "cancelled");
  assert(settled.tasks.some((t) => t.taskId === stopRun.backingTaskId && t.status === "stopped"));
  proof.controls = {
    pauseBlocksRun: true,
    pauseBlocksAssignedRoot: true,
    unrelatedWorkContinued: true,
    stopReceipt: settled.status,
    stopInitialStatus: stopReceipt.status,
  };

  provider.armHold();
  const crashRun = await daemon.call("bot.responsibility.run", {
    scope: scopeA,
    ...control(observeActive),
    requestId: "fa-observe-crash",
  });
  await waitFor(() => provider.held.length === 1, "a held provider response to crash on");
  await daemon.kill();
  provider.releaseHeld();

  // ---------------------------------------------------------------- offline edit 2
  enter("offline: Memory Hub correction");
  const correction = runCompiled(
    "Memory correction",
    storeHeader +
      String.raw`
  const manager=new DatabaseManager(); const db=manager.getDatabase();
  const repo=new MemoryItemsRepository(db); const writer=new MemoryWriter({repository:repo,bumpHotMemoryVersion:()=>{}});
  const hub=new MemoryItemsHubService({getWriter:()=>writer});
  (async()=>{const revised=await hub.update({workspaceId:process.env.FA_WS,id:process.env.FA_FACT,content:process.env.FA_CORRECTED});
  manager.close(); done({success:revised.success,id:revised.item?.id});})().catch(e=>{console.error(e);manager.close();process.exitCode=1;});
`,
    { FA_WS: fixture.workspaceId, FA_FACT: fixture.memory.factId, FA_CORRECTED: facts.corrected },
  );
  assert.equal(correction.success, true);

  // ---------------------------------------------------------------- lifetime 5
  enter("lifetime 5 (node): provider-crash recovery, corrected memory, group audience");
  const writeClaimsBefore = claimRows(actRun.backingTaskId).length;
  await daemon.start();
  const crashRow = await waitFor(
    () => {
      const row = taskRow(crashRun.backingTaskId);
      return row && row.status !== "executing" && row.status !== "planning" ? row : null;
    },
    "the provider-crash task to settle after restart",
    90_000,
  );
  const crashReceipts = withDb(
    (db) =>
      db.prepare("SELECT COUNT(*) AS n FROM routine_runs WHERE backing_task_id=?").get(
        crashRun.backingTaskId,
      ).n,
  );
  assert.equal(crashReceipts, 1, "Recovery must not create a second run receipt");
  assert.equal(claimRows(actRun.backingTaskId).length, writeClaimsBefore, "No write replay");
  assert.equal(await readWorkspaceFile(files.write), writeContent, "No write replay");
  proof.providerCrash = { taskStatusAfterRestart: crashRow.status, runReceipts: crashReceipts };

  const memoryResponsibility = await daemon.call("bot.responsibility.create", {
    scope: scopeA,
    definition: observeDefinition(fixture.routine.memory, "Report the remembered release location."),
  });
  const memoryActive = await daemon.call("bot.responsibility.activate", {
    scope: scopeA,
    ...control(memoryResponsibility),
  });
  const memoryRun1 = await daemon.call("bot.responsibility.run", {
    scope: scopeA,
    ...control(memoryActive),
    requestId: "fa-memory-1",
  });
  const memoryDone1 = await waitTerminal(memoryRun1.backingTaskId, "the corrected-memory run");
  assert.equal(memoryDone1.status, "completed", memoryDone1.error ?? "memory run failed");
  const memoryText1 = provider.forTask("memory").map((c) => c.text).join("\n");
  assert(memoryText1.includes(facts.corrected), "A fresh run must use the corrected fact");
  assert(!memoryText1.includes(facts.original), "A fresh run must not use the old fact");
  const ownerSeesPrivate = memoryText1.includes(facts.privateOwner);

  const audience = await daemon.call("task.create", {
    title: "Group audience probe",
    prompt: `${markers.audience} Report what you know about stationery preferences.`,
    workspaceId: fixture.workspaceId,
    assignedAgentRoleId: fixture.bots.a,
    agentConfig: { gatewayContext: "group", originChannel: "slack" },
  });
  const audienceTaskId = audience.taskId ?? audience.task?.id ?? audience.id;
  const audienceDone = await waitTerminal(audienceTaskId, "the group-audience run");
  assert.equal(audienceDone.status, "completed", audienceDone.error ?? "audience run failed");
  const audienceText = provider.forTask("audience").map((c) => c.text).join("\n");
  assert(audienceText.length > 0, "The audience run must reach the provider");
  assert(!audienceText.includes(facts.privateOwner), "Group audiences must not see private context");
  proof.memory = {
    correctedFactUsed: true,
    oldFactAbsent: true,
    ownerPrivateContextPresentLocally: ownerSeesPrivate,
    privateContextAbsentForGroup: true,
  };
  await daemon.stop();

  // ---------------------------------------------------------------- offline edit 3
  enter("offline: Memory Hub forget");
  const forgotten = runCompiled(
    "Memory forget",
    storeHeader +
      String.raw`
  const manager=new DatabaseManager(); const db=manager.getDatabase();
  const repo=new MemoryItemsRepository(db); const writer=new MemoryWriter({repository:repo,bumpHotMemoryVersion:()=>{}});
  const hub=new MemoryItemsHubService({getWriter:()=>writer});
  (async()=>{const active=(await repo.listForView(process.env.FA_WS,'workspace')).filter(i=>i.content===process.env.FA_CORRECTED);
  let deleted=0; for(const item of active){ if((await hub.delete({workspaceId:process.env.FA_WS,id:item.id})).success) deleted++; }
  manager.close(); done({deleted});})().catch(e=>{console.error(e);manager.close();process.exitCode=1;});
`,
    { FA_WS: fixture.workspaceId, FA_CORRECTED: facts.corrected },
  );
  assert(forgotten.deleted >= 1, "The corrected fact must be forgotten");

  // ---------------------------------------------------------------- lifetime 6
  enter("lifetime 6 (node): forgotten memory, metrics baseline");
  await daemon.start();
  const memoryCallsBefore = provider.forTask("memory").length;
  const memoryRun2 = await daemon.call("bot.responsibility.run", {
    scope: scopeA,
    ...control(memoryActive),
    requestId: "fa-memory-2",
  });
  const memoryDone2 = await waitTerminal(memoryRun2.backingTaskId, "the post-forget run");
  assert.equal(memoryDone2.status, "completed", memoryDone2.error ?? "memory run failed");
  const memoryText2 = provider
    .forTask("memory")
    .slice(memoryCallsBefore)
    .map((c) => c.text)
    .join("\n");
  assert(memoryText2.length > 0);
  assert(!memoryText2.includes(facts.corrected), "A forgotten fact must not reach a fresh run");
  assert(!memoryText2.includes(facts.original), "A forgotten revision must not reach a fresh run");
  proof.memory.forgottenAbsent = true;

  for (const view of ["results", "needs_you", "working", "scheduled"]) await timedList(scopeA, view);
  const metricsFrame = await daemon.rpc("bot.metrics.summary", { ...scopeA, windowDays: 7 });
  assert.equal(metricsFrame.ok, true, JSON.stringify(metricsFrame.error));
  const metrics = metricsFrame.payload;
  assert.equal(metrics.effects.committed, 1, "Exactly one reviewed effect was committed");
  assert.equal(metrics.effects.uncertain, 0);
  assert.equal(metrics.dispatch.duplicateAdmissions, 0);
  assert.equal(metrics.unresolvedWaits.approvals, 0);
  assert(metrics.workView.samples >= 4, "The baseline includes work-view latency");
  proof.metrics = metricsFrame.ok ? metricsFrame.payload : { unavailable: metricsFrame.error };
  await daemon.stop();

  // ---------------------------------------------------------------- reservation interruption
  enter("offline: reservation and task-creation interruption");
  const crashHarness = (stage) =>
    String.raw`
    const {DatabaseManager}=require('./dist/daemon/electron/database/schema.js');
    const {TaskStore}=require('./dist/daemon/electron/database/repositories.js');
    const {DispatchBudgetStore}=require('./dist/daemon/electron/automation/dispatch-budget-store.js');
    const {SchedulerLeaseStore}=require('./dist/daemon/electron/automation/scheduler-lease-store.js');
    const manager=new DatabaseManager(); const db=manager.getDatabase();
    const fence=new SchedulerLeaseStore(db).acquire({owner:process.env.FA_OWNER,now:Date.now(),leaseMs:1000});
    if(!fence) throw new Error('lease unavailable');
    const ticket=process.env.FA_TICKET;
    const decision=new DispatchBudgetStore(db).reserve({workspaceId:process.env.FA_WS,source:'heartbeat',occurrenceKey:'final-acceptance:occurrence:1'},{schedulerFence:fence,now:Date.now(),dayStart:0,maxPerDay:100,cooldownMs:0},ticket);
    let taskId=null;
    if(decision.allowed && '${stage}'==='after_task'){
      taskId=new TaskStore(db).create({workspaceId:process.env.FA_WS,title:'Interrupted dispatch fixture',prompt:'Fixture only',status:'completed',resultSummary:'Fixture only',agentConfig:{backgroundDispatchTicket:ticket,backgroundSchedulerFence:fence}}).id;
    }
    process.stdout.write('STAGE='+JSON.stringify({allowed:decision.allowed,reason:decision.reason??null,taskId})+'\n');
    if('${stage}'==='inspect'){manager.close();} else {setInterval(()=>{},1000);}
  `;
  async function runUntilKilled(stage, owner, ticket) {
    const child = spawn(process.execPath, ["-e", crashHarness(stage)], {
      cwd: root,
      env: { ...childEnvironment, FA_WS: fixture.workspaceId, FA_OWNER: owner, FA_TICKET: ticket },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    const line = await waitFor(() => out.match(/STAGE=(.+)/)?.[1], `${stage} checkpoint`, 30_000);
    if (stage !== "inspect") {
      child.kill("SIGKILL");
      assert.equal((await exited).signal, "SIGKILL");
    } else {
      await exited;
    }
    return JSON.parse(line);
  }
  const reservation = (ticket) =>
    withDb((db) =>
      db.prepare("SELECT state,task_id FROM background_dispatch_reservations WHERE ticket=?").get(ticket),
    );
  const k1 = await runUntilKilled("after_reserve", "fa-crash-reserve", "fa-ticket-1");
  assert.equal(k1.allowed, true);
  assert.equal(reservation("fa-ticket-1").state, "reserved");
  await sleep(1200);
  const k2 = await runUntilKilled("after_task", "fa-crash-task", "fa-ticket-2");
  assert.equal(k2.allowed, true, "Takeover must reclaim the interrupted reservation");
  assert.equal(reservation("fa-ticket-1").state, "refunded");
  assert.deepEqual(reservation("fa-ticket-2"), { state: "committed", task_id: k2.taskId });
  await sleep(1200);
  const k3 = await runUntilKilled("inspect", "fa-crash-inspect", "fa-ticket-3");
  assert.equal(k3.allowed, false);
  assert.equal(k3.reason, "duplicate_occurrence", "A committed occurrence must not dispatch twice");
  assert.equal(reservation("fa-ticket-2").state, "committed", "Takeover keeps committed charges");
  proof.reservationInterruption = {
    killedAfterReserve: "refunded on takeover",
    killedAfterTaskCommit: "committed, task retained",
    replayedOccurrence: k3.reason,
  };

  // ---------------------------------------------------------------- preservation
  enter("final: user data preservation");
  const final = profileSnapshot(fixture);
  const roleById = Object.fromEntries(final.roles.map((role) => [role.id, role]));
  assert.equal(final.roles.length, 3, "No user-created bot may be created by the runtime");
  for (const role of final.systemRoles) {
    assert.equal(role.is_system, 1, "Catalog roles must stay marked as system roles");
    assert.equal(role.memberships, 0, "Catalog roles must not join user teams");
    assert.equal(role.assigned, 0, "Catalog roles must not receive this profile's work");
  }
  proof.systemRoleCatalog = {
    rolesAddedByDesktop: final.systemRoles.length,
    distinctFromUserBots: true,
  };
  assert.equal(
    roleById[fixture.bots.a].system_prompt,
    "Alpha private instructions must survive every restart unchanged.",
  );
  assert.equal(
    roleById[fixture.bots.b].system_prompt,
    "Beta private instructions must survive every restart unchanged.",
  );
  assert.equal(roleById[fixture.bots.a].display_name, "Renamed acceptance alpha");
  assert.equal(roleById[fixture.bots.c].is_active, 0, "A deactivated bot stays deactivated");
  assert.deepEqual(final.teams, seeded.teams, "Only the explicit team exists");
  assert.deepEqual(final.members, [], "Revoked membership stays revoked");
  assert.deepEqual(final.seededTasks, seeded.seededTasks, "Seeded history is unchanged");
  const independentPersisted = withDb((db) =>
    db
      .prepare(
        `SELECT b.revision,b.state,r.definition_json FROM bot_responsibilities b
         JOIN bot_responsibility_revisions r ON r.responsibility_id=b.id AND r.revision=b.revision
         WHERE b.id=?`,
      )
      .get(independent.id),
  );
  assert.equal(independentPersisted.revision, 2);
  assert.equal(independentPersisted.state, "paused");
  assert.equal(JSON.parse(independentPersisted.definition_json).objective, "Independent objective, rev 2.");

  listLatencies.sort((a, b) => a - b);
  proof.workViewLatencyMs = {
    samples: listLatencies.length,
    median: Number(listLatencies[Math.floor(listLatencies.length / 2)].toFixed(2)),
    max: Number(listLatencies.at(-1).toFixed(2)),
  };
  proof.providerCalls = provider.calls.length;
  console.log(
    JSON.stringify(
      {
        status: "passed",
        runtime: "compiled Node daemon (4 lifetimes) + Electron desktop with hidden window (2 lifetimes), one disposable profile",
        realProvider: false,
        channelDelivery: false,
        ...proof,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    `Final acceptance failed during "${phase}":\n${error.stack || error}\n` +
      `providerCalls=${JSON.stringify(
        (provider?.calls ?? []).slice(-6).map(({ text, ...rest }) => ({
          ...rest,
          text: text.slice(0, 400),
        })),
      )}\n${daemon?.safeOutput().slice(-12_000) ?? ""}`,
  );
  process.exitCode = 1;
} finally {
  await daemon?.kill().catch(() => {});
  await provider?.close().catch(() => {});
  if (!process.env.FA_KEEP_PROFILE) await fs.rm(profile, { recursive: true, force: true });
  else console.error(`Profile kept at ${profile}`);
}
