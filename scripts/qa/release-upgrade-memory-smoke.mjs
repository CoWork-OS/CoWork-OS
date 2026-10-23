#!/usr/bin/env node
/**
 * Upgrade-path acceptance of the memory migrations from the previous release. A disposable
 * profile is seeded by the PREVIOUS build's compiled stores (curated entries, profile facts,
 * a contact's note and commitment, a history item, archive rows, workspace markdown notes, a
 * task with events and a few settings) and opened once by the previous desktop app. The
 * one-time memory jobs (lane and payload migration, archive cleanup, legacy retirement, the
 * memory folder's fact retirement) then run in the first build that has them: the current
 * daemon when the previous release predates the memory engine (0.5.54, whose legacy stores
 * and generated USER.md / MEMORY.md blocks are migrated and checked), otherwise the previous
 * daemon, after which the current daemon must leave the migrated profile exactly as it is.
 * Then the current daemon again and the current desktop app (idempotent), the previous
 * daemon again (downgrade tolerance, docs/troubleshooting.md), and the current daemon after
 * the previous build stored new facts. No provider is configured and nothing leaves the
 * machine.
 *
 * Everything lives under one mkdtemp directory: the profile, the workspace, the memory
 * folder (`<profile>/memory-repo`, the default for a custom data directory) and HOME.
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
 *   COWORK_UPGRADE_BASELINE=/tmp/cowork-baseline/node_modules/cowork-os npm run qa:memory:upgrade
 *
 * A built checkout of the previous release works as the baseline too. The run takes about
 * eight minutes (the deferred jobs start 90-120 s after startup). UP_KEEP_PROFILE=1 keeps the
 * profile (and each runtime's log under logs/) for inspection. UP_SKIP_REUPGRADE=1 skips step
 * 6 (downgrade, new facts, upgrade again).
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
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
for (const [dir, entries] of [
  [baseline, ["dist/daemon/daemon/main.js", "dist/electron/electron/main.js"]],
  [root, ["dist/daemon/daemon/main.js", "dist/electron/electron/main.js"]],
])
  for (const entry of entries)
    await fs.access(path.join(dir, entry)).catch(() => {
      throw new Error(`${dir} is missing ${entry}; build or set it up first`);
    });
const baselineVersion = JSON.parse(await fs.readFile(path.join(baseline, "package.json"), "utf8")).version;

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-memory-upgrade-"));
const profile = path.join(sandbox, "profile");
const home = path.join(sandbox, "home");
const workspacePath = path.join(sandbox, "workspace");
const dbPath = path.join(profile, "cowork-os.db");
const memoryRepo = path.join(profile, "memory-repo");
const backupsDir = path.join(profile, "backups");
const kitDir = path.join(workspacePath, ".cowork");
await Promise.all([profile, home, workspacePath].map((dir) => fs.mkdir(dir, { recursive: true })));

// The real memory folder must never be touched. A running CoWork app may write to it during
// the smoke, so the proof is that no file changed since the start holds a seeded fact.
const realMemoryFolder = path.join(os.homedir(), "CoWork Memory");
const smokeStartedAt = Date.now();

const environment = Object.fromEntries(
  ["PATH", "TMPDIR", "SystemRoot", "LANG", "LC_ALL"]
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]),
);
Object.assign(environment, {
  HOME: home,
  COWORK_USER_DATA_DIR: profile,
  COWORK_IMPORT_ENV_SETTINGS: "0",
  COWORK_PROFILE: "default",
  COWORK_DISABLE_OS_KEYCHAIN: "1",
  GIT_CONFIG_NOSYSTEM: "1",
});
assert.equal(
  Object.keys(environment).some((key) => /(?:OPENAI|ANTHROPIC|GEMINI|AZURE).*KEY/i.test(key)),
  false,
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(read, label, timeoutMs = 120_000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await sleep(intervalMs);
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

/** Runs `source` with node from `cwd` (a checkout) against the disposable profile. */
function runNode(cwd, source, label, extraEnv = {}) {
  const result = spawnSync(process.execPath, ["-e", source], {
    cwd,
    env: { ...environment, ...extraEnv },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, `${label} failed:\n${result.stdout}\n${result.stderr}`);
  const out = result.stdout.match(/^RESULT=(.+)$/m);
  return out ? JSON.parse(out[1]) : null;
}

// ---- 1. Seed with the previous build ----

const MARK = {
  curatedUser: "CURATED-USER: prefers metric units in every report",
  curatedWorkspace: "CURATED-WS: the release train ships on Thursdays",
  curatedRule: "CURATED-RULE: always run the upgrade smoke before tagging",
  profilePref: "PROFILE-PREF: likes answers with a short summary first",
  profileWork: "PROFILE-WORK: works as a release engineer on the desktop app",
  profileRule: "PROFILE-RULE: never schedule meetings before 9am",
  relPref: "I prefer RELPREF dark mode dashboards in every tool",
  relContext: "Please remember that RELCTX the QA lab is on floor three",
  commitment: "Remind me to COMMIT renew the signing certificate tomorrow",
  mailCommitment: "MAIL-COMMIT: send Dana the QA report",
  peopleNote: "PEOPLE-NOTE: Dana prefers email over chat",
  history: "Completed task: History item",
  userText: "USER-TEXT: I wrote this line by hand and it must survive.",
  memoryText: "MEMORY-TEXT: hand-written project note that must survive.",
  archiveObservation: "ARCHIVE-OBS: upgrade notes observed during QA",
  summary: "SUMMARY: QA day summary",
  userName: "Quinn",
  searchKey: "qa-dummy-brave-key-not-real",
};

/**
 * Opens the memory stores of the build in `cwd` from a `node -e` script. Builds up to 0.5.54
 * write facts to their own legacy stores (synchronous services); later builds write through
 * the memory engine (MemoryWriter, memory_items), which a script has to start itself as the
 * runtimes do. Each script calls `await openMemory(manager)` and ends with `finish(manager, result)`
 * (the engine's workers keep the process alive otherwise).
 */
const OPEN_MEMORY = String.raw`
  const repos=require('./dist/daemon/electron/database/repositories.js');
  // 0.5.54 names the synchronous stores *Repository; later builds name them *Store.
  const Stores={Workspace:repos.WorkspaceStore||repos.WorkspaceRepository,Task:repos.TaskStore||repos.TaskRepository,Memory:repos.MemoryStore||repos.MemoryRepository,MemorySummary:repos.MemorySummaryStore||repos.MemorySummaryRepository};
  const {CuratedMemoryService}=require('./dist/daemon/electron/memory/CuratedMemoryService.js');
  const {UserProfileService}=require('./dist/daemon/electron/memory/UserProfileService.js');
  const {RelationshipMemoryService}=require('./dist/daemon/electron/memory/RelationshipMemoryService.js');
  const {PersonalityManager}=require('./dist/daemon/electron/settings/personality-manager.js');
  const memoryEngine=require('fs').existsSync('./dist/daemon/electron/memory/memory-engine-bootstrap.js')?require('./dist/daemon/electron/memory/memory-engine-bootstrap.js'):null;
  const memoryGeneration=memoryEngine?'writer':'legacy';
  let stopMemory=()=>{};
  async function openMemory(manager){
    PersonalityManager.initialize(); CuratedMemoryService.initialize(manager);
    if(!memoryEngine) return;
    const {MemoryService}=require('./dist/daemon/electron/memory/MemoryService.js');
    MemoryService.initialize(manager);
    stopMemory=await memoryEngine.startMemoryEngine(MemoryService.getStatements?.()||manager.getDatabase());
  }
  function finish(manager,result){
    stopMemory(); manager.close();
    if(result!==undefined) process.stdout.write('RESULT='+JSON.stringify(result)+'\n');
    process.exit(0);
  }
`;

function seedWithBaseline() {
  const source = String.raw`
    const {DatabaseManager}=require('./dist/daemon/electron/database/schema.js');
    const {SecureSettingsRepository}=require('./dist/daemon/electron/database/SecureSettingsRepository.js');
    const {AppearanceManager}=require('./dist/daemon/electron/settings/appearance-manager.js');
    ${OPEN_MEMORY}
    const fs=require('fs'); const path=require('path');
    const M=JSON.parse(process.env.UP_MARK); const wsPath=process.env.UP_WS;
    const manager=new DatabaseManager(); const db=manager.getDatabase();
    (async()=>{
      const kit=path.join(wsPath,'.cowork'); fs.mkdirSync(path.join(kit,'memory','daily'),{recursive:true});
      fs.writeFileSync(path.join(kit,'USER.md'),'# User Profile\n\n'+M.userText+'\n');
      fs.writeFileSync(path.join(kit,'MEMORY.md'),'# Long-Term Memory\n\n'+M.memoryText+'\n');
      fs.writeFileSync(path.join(kit,'memory','notes.md'),'# Notes\n\n- MARKDOWN-NOTE: the staging database is called upgrade-qa-db.\n');
      fs.writeFileSync(path.join(kit,'memory','daily','2026-10-01.md'),'# 2026-10-01\n\n- DAILY-NOTE: reviewed the upgrade plan.\n');
      const ws=new Stores.Workspace(db).create('Upgrade QA Workspace',wsPath,{read:true,write:true,delete:false,shell:false,network:false});
      const secure=new SecureSettingsRepository(db);
      AppearanceManager.initialize();
      await openMemory(manager);
      const tasks=new Stores.Task(db); const events=new repos.TaskEventRepository(db);
      const task=tasks.create({workspaceId:ws.id,title:'Upgrade QA task',prompt:'Metadata only',status:'completed',resultSummary:'Done'});
      const t0=Date.now()-3600000;
      for(let i=0;i<3;i++) events.create({taskId:task.id,timestamp:t0+i*1000,type:i===0?'task_created':'log',payload:{message:'QA event '+i}});
      // Curated entries (0.5.54 also renders the generated USER.md / MEMORY.md blocks).
      const curated={};
      for(const [key,target,kind] of [['curatedUser','user','preference'],['curatedWorkspace','workspace','project_fact'],['curatedRule','workspace','workflow_rule']]){
        const r=await CuratedMemoryService.curate({workspaceId:ws.id,action:'add',target,kind,content:M[key],skipMemoryWriteGate:true});
        if(!r.success||!r.entry) throw new Error('curate failed: '+r.error); curated[key]=r.entry.id;
      }
      // Global profile facts.
      const facts={};
      for(const [key,category] of [['profilePref','preference'],['profileWork','work'],['profileRule','constraint']])
        facts[key]=(await UserProfileService.addFact({category,value:M[key],source:'manual'})).id;
      PersonalityManager.setUserName(M.userName);
      // Relationship items: a contact's note and commitment (mailbox) and a history item in
      // every build; 0.5.54 also learns a preference, a context and a commitment from chat.
      if(RelationshipMemoryService.ingestUserMessage){
        RelationshipMemoryService.ingestUserMessage(M.relPref+'.');
        RelationshipMemoryService.ingestUserMessage(M.relContext+'.');
        RelationshipMemoryService.ingestUserMessage(M.commitment+'.');
      }
      await RelationshipMemoryService.rememberMailboxInsights({facts:[M.peopleNote],commitments:[{text:M.mailCommitment,dueAt:Date.now()+86400000}],contactIdentityId:'contact-dana',taskId:task.id});
      await RelationshipMemoryService.recordTaskCompletion('History item','Done',task.id);
      // Archive rows: an observation (kept), raw telemetry (cleaned up) and, in 0.5.54 (later
      // builds keep suggestions in their own table from the first open), a suggestion (moved).
      const mem=new Stores.Memory(db);
      const row=(type,content)=>mem.create({workspaceId:ws.id,taskId:task.id,type,content,tokens:8,isCompressed:false,isPrivate:false}).id;
      const archive={
        observation:row('observation',M.archiveObservation),
        telemetry:row('observation','Tool called: read_file {"path":"x"}'),
        suggestion:memoryGeneration==='legacy'?row('insight','[SUGGESTION] '+JSON.stringify({id:'sugg-qa-1',type:'follow_up',title:'QA suggestion',description:'Check the upgrade',confidence:0.8,createdAt:Date.now(),expiresAt:Date.now()+86400000,dismissed:false,actedOn:false,workspaceId:ws.id})):null,
      };
      // memory_summaries is retired after 0.5.54.
      const summary=Stores.MemorySummary?new Stores.MemorySummary(db).create({workspaceId:ws.id,timePeriod:'day',periodStart:t0,periodEnd:t0+86400000,summary:M.summary,memoryIds:[archive.observation],tokens:5}).id:null;
      // Settings: a plain one and a secret one (both encrypted at rest).
      AppearanceManager.saveSettings({themeMode:'dark'});
      secure.save('search',{primaryProvider:'brave',fallbackProvider:null,brave:{apiKey:M.searchKey}});
      finish(manager,{memoryGeneration,workspaceId:ws.id,taskId:task.id,curated,facts,archive,summary});
    })().catch(e=>{console.error(e);process.exit(1);});
  `;
  return runNode(baseline, source, "Baseline seed", { UP_WS: workspacePath, UP_MARK: JSON.stringify(MARK) });
}

// ---- Runtimes ----

/** Lines that must never appear in a runtime's output during the upgrade. */
const FAILURE_LINES =
  /(migration[^\n]*(fail|error|incomplete|retried)|retirement (skipped|failed)|export or fact retirement failed|Memory repo failed|cannot be read|UnsupportedSchemaVersion|SqliteError|Uncaught|Unhandled(Promise)?Rejection|TypeError|ReferenceError)/i;

/**
 * The desktop app applies --control-plane-port only in headless mode; otherwise it binds the
 * port stored in the profile (default 18789, often taken by a running CoWork). Store the
 * chosen port with the runtime's own settings manager before a desktop start.
 */
function pinDesktopControlPlanePort(cwd, port) {
  runNode(
    cwd,
    String.raw`
      const {DatabaseManager}=require('./dist/daemon/electron/database/schema.js');
      const {SecureSettingsRepository}=require('./dist/daemon/electron/database/SecureSettingsRepository.js');
      const {ControlPlaneSettingsManager}=require('./dist/daemon/electron/control-plane/settings.js');
      const manager=new DatabaseManager(); new SecureSettingsRepository(manager.getDatabase());
      ControlPlaneSettingsManager.initialize();
      ControlPlaneSettingsManager.updateSettings({host:'127.0.0.1',port:Number(process.env.UP_PORT)});
      manager.close();
    `,
    "Pinning the control plane port",
    { UP_PORT: String(port) },
  );
}

/** Starts a runtime from `cwd`; desktop runs the Electron app with a hidden window. */
async function runtime(cwd, kind, label) {
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
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  let actualPort = port;
  const token = await waitFor(async () => {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`${label} exited early:\n${output.slice(-4000)}`);
    if (kind === "desktop") {
      const connection = await fs.readFile(connectionPath, "utf8").then(JSON.parse).catch(() => null);
      if (connection?.pid !== child.pid) return null;
      actualPort = Number(new URL(connection.url).port);
      return connection.token;
    }
    const value = output.match(/Control Plane token: (\S+)/)?.[1];
    return value && output.includes("Control Plane listening:") ? value : null;
  }, label).catch((error) => {
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
      const requestId = `mem-${++id}`;
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
  const auth = await rpc("connect", { token, deviceName: "memory-upgrade" });
  assert.equal(auth.ok, true, JSON.stringify(auth.error));
  return {
    label,
    rpc,
    output: () => output,
    alive: () => child.exitCode === null && child.signalCode === null,
    async stop({ allowForcedStop = false } = {}) {
      socket.terminate();
      child.kill("SIGTERM");
      const done = await Promise.race([exited, sleep(45_000).then(() => null)]);
      if (!done) {
        child.kill("SIGKILL");
        await exited;
        // Older desktop builds (0.5.54) do not exit on SIGTERM (their shutdown hangs after
        // the database closes); a forced stop is accepted for the previous build only.
        if (allowForcedStop) return { output, failureLines: [], forced: true };
        throw new Error(`${label} did not stop:\n${output.slice(-4000)}`);
      }
      assert.equal(done.code, 0, `${label} shutdown failed (${done.signal ?? done.code}):\n${output.slice(-4000)}`);
      const bad = output.split("\n").filter((line) => FAILURE_LINES.test(line));
      return { output, failureLines: bad };
    },
  };
}

const logsDir = path.join(sandbox, "logs");
/** Keeps each runtime's output next to the profile (removed with it unless UP_KEEP_PROFILE). */
async function saveLog(label, output) {
  await fs.mkdir(logsDir, { recursive: true });
  await fs.writeFile(path.join(logsDir, `${label.replace(/[^a-z0-9]+/gi, "-")}.log`), output);
}

// ---- Database readers ----

function withDb(read) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}
const tableNames = () =>
  withDb((db) => new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)));
const schemaSql = () =>
  withDb((db) =>
    db
      .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
      .all(),
  );
const maintenance = (key) =>
  withDb((db) => {
    try {
      const row = db.prepare("SELECT value FROM maintenance_state WHERE key = ?").get(key);
      return row ? JSON.parse(row.value) : null;
    } catch {
      return null;
    }
  });
const tasksAndEvents = () =>
  withDb((db) => ({
    tasks: db.prepare("SELECT id, workspace_id, title, prompt, status, result_summary FROM tasks ORDER BY id").all(),
    events: db.prepare("SELECT id, task_id, type, timestamp, payload FROM task_events ORDER BY timestamp, id").all(),
  }));
const secureCategories = () =>
  withDb((db) => db.prepare("SELECT category FROM secure_settings ORDER BY category").all().map((r) => r.category));
const memoryItems = () =>
  withDb((db) =>
    db
      .prepare(
        `SELECT id, kind, scope, scope_ref, status, privacy, source, content, source_ref
         FROM memory_items ORDER BY created_at, id`,
      )
      .all(),
  );

async function readTree(dir) {
  const out = {};
  if (!existsSync(dir)) return out;
  for (const entry of await fs.readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const abs = path.join(entry.parentPath ?? entry.path, entry.name);
    const rel = path.relative(dir, abs);
    if (rel.split(path.sep).includes(".git")) continue;
    out[rel] = await fs.readFile(abs, "utf8");
  }
  return out;
}

/** Files of the memory folder that contain `text`. */
function filesWith(tree, text) {
  return Object.keys(tree).filter((file) => tree[file].includes(text));
}

function readSecureSettings(cwd, categories) {
  return runNode(
    cwd,
    String.raw`
      const {DatabaseManager}=require('./dist/daemon/electron/database/schema.js');
      const {SecureSettingsRepository}=require('./dist/daemon/electron/database/SecureSettingsRepository.js');
      const manager=new DatabaseManager(); const repo=new SecureSettingsRepository(manager.getDatabase());
      const out={};
      for(const c of JSON.parse(process.env.UP_CATS)){
        const r=repo.loadWithStatus?repo.loadWithStatus(c,{logErrors:false}):{status:'success',data:repo.load(c)};
        out[c]={status:r.status,data:r.data};
      }
      manager.close(); process.stdout.write('RESULT='+JSON.stringify(out)+'\n');
    `,
    `Secure settings read (${path.basename(cwd)})`,
    { UP_CATS: JSON.stringify(categories) },
  );
}

// ---- Run ----

const MARKER_KEYS = [
  "memory_items_lane_migration_v1",
  "memory_payload_tables_migration_v1",
  "memory_cleanup_migration_v1",
  "legacy_memory_retirement_v1",
];
const markers = () => Object.fromEntries(MARKER_KEYS.map((key) => [key, maintenance(key)]));
const folderRetirementMarker = path.join(memoryRepo, ".git", "cowork-fact-retirement-v1");
const archiveIds = () => withDb((db) => db.prepare("SELECT id FROM memories ORDER BY id").all().map((r) => r.id));
const backups = async () => (existsSync(backupsDir) ? (await fs.readdir(backupsDir)).sort() : []);
const kitFiles = async () => ({
  user: await fs.readFile(path.join(kitDir, "USER.md"), "utf8"),
  memory: await fs.readFile(path.join(kitDir, "MEMORY.md"), "utf8"),
});

let active;
const report = { status: "running", baselineVersion, steps: [] };

/**
 * Runs the daemon from `cwd` until the deferred one-time memory jobs are done. Lane and payload
 * migration run at startup; the archive cleanup ~90 s and the legacy retirement ~120 s after it
 * (LEGACY_MEMORY_RETIREMENT_DELAY_MS; it writes its marker with nothing to retire, too), then
 * the memory folder's fact retirement. No env hook shortens them, so wait for the markers.
 */
async function runOneTimeMemoryJobs(cwd, label) {
  const startedAt = Date.now();
  active = await runtime(cwd, "node", label);
  const running = () => {
    if (!active.alive()) throw new Error(`daemon exited:\n${active.output().slice(-4000)}`);
  };
  const retirementMarker = await waitFor(
    () => running() || maintenance("legacy_memory_retirement_v1"),
    "legacy memory retirement marker",
    240_000,
    1000,
  );
  // The backup must already exist when the marker (written with the table drop) appears.
  const backupsAtMarker = await backups();
  await waitFor(() => running() || maintenance("memory_cleanup_migration_v1"), "archive cleanup marker", 240_000, 1000);
  await waitFor(
    () => running() || existsSync(folderRetirementMarker),
    "memory folder fact retirement marker",
    60_000,
    1000,
  );
  await sleep(3000);
  const run = await active.stop();
  active = null;
  await saveLog(label, run.output);
  report.steps.push({
    step: label,
    seconds: Math.round((Date.now() - startedAt) / 1000),
    failureLines: run.failureLines,
  });
  assert.deepEqual(run.failureLines, [], `${label} reported migration errors`);
  return { retirementMarker, backupsAtMarker };
}

try {
  const seed = seedWithBaseline();
  // Up to 0.5.54 facts live in legacy stores, which the first build with the memory engine
  // moves into memory_items and the memory folder (the current build, here). From 0.5.55 on
  // the previous build has done that itself; the current build must then leave it alone.
  const legacyBaseline = seed.memoryGeneration === "legacy";
  report.baselineMemory = seed.memoryGeneration;
  if (legacyBaseline) {
    const seededKit = await kitFiles();
    assert(seededKit.user.includes("cowork:auto:curated-user:start"), "The baseline renders the USER.md block");
    assert(seededKit.memory.includes("cowork:auto:curated-workspace:start"), "The baseline renders the MEMORY.md block");
  }

  // ---- 2. One run of the previous desktop app ----
  active = await runtime(baseline, "desktop", "previous desktop app");
  await sleep(8000);
  const baselineRun = await active.stop({ allowForcedStop: true });
  active = null;
  await saveLog("previous desktop app", baselineRun.output);
  report.steps.push({ step: "previous desktop app", forcedStop: Boolean(baselineRun.forced) });
  const tablesBefore = tableNames();
  if (legacyBaseline) {
    for (const table of ["curated_memory_entries", "memory_summaries", "memories"])
      assert(tablesBefore.has(table), `The baseline profile has ${table}`);
    assert(!tablesBefore.has("memory_items"), "The baseline must predate memory_items");
  } else {
    assert(tablesBefore.has("memory_items"), "The baseline has the memory engine");
  }
  const historyBefore = tasksAndEvents();
  assert(historyBefore.tasks.some((task) => task.id === seed.taskId));
  assert(historyBefore.events.filter((event) => event.task_id === seed.taskId).length >= 3);
  const markdownNotesBefore = await readTree(path.join(kitDir, "memory"));
  const kitBeforeUpgrade = await kitFiles();
  const categoriesBefore = secureCategories();
  for (const category of [
    "search",
    "appearance",
    "personality",
    ...(legacyBaseline ? ["user-profile", "relationship-memory"] : []),
  ])
    assert(categoriesBefore.includes(category), `The baseline stored ${category}`);

  // ---- 3. The one-time memory jobs: the current daemon's first start on a legacy profile,
  // otherwise the previous daemon (as on every profile that already ran the previous release).
  const jobs = await runOneTimeMemoryJobs(
    legacyBaseline ? root : baseline,
    legacyBaseline ? "current daemon, first start" : "previous daemon, one-time memory jobs",
  );

  // Lane migration and retirement.
  const laneMarker = maintenance("memory_items_lane_migration_v1");
  assert(laneMarker, "lane migration marker");
  assert(maintenance("memory_payload_tables_migration_v1"), "payload migration marker");
  const tablesAfter = tableNames();
  for (const table of ["curated_memory_entries", "memory_summaries"])
    assert(!tablesAfter.has(table), `${table} is retired`);
  const categoriesAfter = secureCategories();
  for (const category of ["user-profile", "relationship-memory"])
    assert(!categoriesAfter.includes(category), `SecureSettings ${category} is retired`);
  for (const category of ["search", "appearance", "personality"])
    assert(categoriesAfter.includes(category), `SecureSettings ${category} is kept`);

  const { retirementMarker } = jobs;
  assert.equal(retirementMarker.counts?.missing ?? 0, 0, "retirement left nothing missing");
  if (legacyBaseline) {
    // Backup before retirement: written by this run, 0600, holding the curated rows.
    const legacyBackups = jobs.backupsAtMarker.filter((name) => name.startsWith("legacy-memory-"));
    assert.equal(legacyBackups.length, 1, `one legacy backup when the tables were dropped: ${jobs.backupsAtMarker}`);
    const backupFile = path.join(backupsDir, legacyBackups[0]);
    assert.equal(statSync(backupFile).mode & 0o777, 0o600, "backup is owner-only");
    assert.equal(retirementMarker.backup?.file, legacyBackups[0], "marker names the backup");
    const encrypted = legacyBackups[0].endsWith(".json.enc");
    assert.equal(retirementMarker.backup?.encrypted, encrypted);
    if (!encrypted) {
      // COWORK_DISABLE_OS_KEYCHAIN=1 (and a plain Node daemon) has no OS encryption: the
      // export is plaintext without the settings blobs, by design.
      const backup = JSON.parse(await fs.readFile(backupFile, "utf8"));
      assert.equal(backup.settings?.omitted, "os_encryption_unavailable");
      const curatedIds = backup.curatedMemoryEntries.map((row) => row.id).sort();
      assert.deepEqual(curatedIds, Object.values(seed.curated).sort(), "backup holds every curated row");
    }
  }
  // The folder's fact retirement backs up the rows it tombstones (owner-only).
  const folderRetirement = JSON.parse(await fs.readFile(folderRetirementMarker, "utf8"));
  if (folderRetirement.backup)
    assert.equal(
      statSync(path.join(backupsDir, folderRetirement.backup)).mode & 0o777,
      0o600,
      "fact retirement backup is owner-only",
    );

  // memory_items: commitments and people notes stay in the database.
  const items = memoryItems();
  const active1 = items.filter((item) => item.status === "active");
  const findItem = (text) => active1.find((item) => item.content.includes(text));
  for (const text of [...(legacyBaseline ? ["COMMIT renew the signing certificate"] : []), MARK.mailCommitment]) {
    const item = findItem(text);
    assert(item, `commitment "${text}" is an active memory item`);
    assert.equal(item.kind, "commitment");
  }
  const note = findItem(MARK.peopleNote);
  assert(note, "people note is an active memory item");
  assert.equal(note.scope, "contact");
  assert.equal(note.scope_ref, "contact-dana");
  assert.equal(note.privacy, "private");
  assert(!items.some((item) => item.content.includes(MARK.history)), "history items are not facts");

  // Memory folder at the configured location (the default for a custom data dir). The
  // preferred name and the facts learned from chat are seeded by 0.5.54 only.
  assert(existsSync(path.join(memoryRepo, ".git")), "memory folder is a git repo inside the profile");
  const folder = await readTree(memoryRepo);
  const expectations = [
    [MARK.curatedUser, "MEMORY.md"],
    [MARK.curatedWorkspace, "workspaces/upgrade-qa-workspace.md"],
    [MARK.curatedRule, "workspaces/upgrade-qa-workspace.md"],
    [MARK.profilePref, "me.md"],
    [MARK.profileWork, "me.md"],
    [MARK.profileRule, "lessons.md"],
    ...(legacyBaseline
      ? [
          [`Preferred name: ${MARK.userName}`, "MEMORY.md"],
          [MARK.relPref, "me.md"],
          [MARK.relContext, "lessons.md"],
        ]
      : []),
  ];
  const placement = expectations.map(([text, file]) => ({ text, expected: file, found: filesWith(folder, text) }));
  report.folderPlacement = placement;
  for (const { text, expected, found } of placement)
    assert.deepEqual(found, [expected], `"${text}" belongs in ${expected} only (found in ${found.join(", ") || "none"})`);
  for (const text of ["COMMIT renew", MARK.mailCommitment, MARK.peopleNote, MARK.history])
    assert.deepEqual(filesWith(folder, text), [], `"${text}" must stay out of the memory folder`);
  // Facts the folder holds are retired from memory_items (tombstoned).
  for (const [text] of expectations)
    assert(!findItem(text), `"${text}" is no longer an active memory item once the folder holds it`);

  // Archive: telemetry cleaned, observation kept, suggestion moved.
  withDb((db) => {
    const ids = new Set(db.prepare("SELECT id FROM memories").all().map((r) => r.id));
    assert(ids.has(seed.archive.observation), "archive observation kept");
    assert(!ids.has(seed.archive.telemetry), "raw telemetry cleaned up");
    if (seed.archive.suggestion) {
      assert(!ids.has(seed.archive.suggestion), "suggestion moved out of the archive");
      assert(db.prepare("SELECT 1 FROM suggestions WHERE id = ?").get("sugg-qa-1"), "suggestion moved");
    }
  });

  // Tasks and events untouched; workspace markdown notes untouched.
  assert.deepEqual(tasksAndEvents(), historyBefore, "tasks and events must not change");
  assert.deepEqual(await readTree(path.join(kitDir, "memory")), markdownNotesBefore, "markdown notes untouched");
  assert.deepEqual(await kitFiles(), kitBeforeUpgrade, "startup alone does not rewrite the kit files");

  let kitNow = kitBeforeUpgrade;
  if (legacyBaseline) {
    // ---- Kit files: the generated blocks are removed once a task plans in the workspace
    // (kit-block-strip.ts). No provider is configured, so the strip is run through the
    // current build's module on the upgraded profile.
    const strip = runNode(
      root,
      String.raw`
        const {DatabaseManager}=require('./dist/daemon/electron/database/schema.js');
        const {SecureSettingsRepository}=require('./dist/daemon/electron/database/SecureSettingsRepository.js');
        const {stripCuratedKitBlocksOnce}=require('./dist/daemon/electron/memory/kit-block-strip.js');
        const manager=new DatabaseManager(); const db=manager.getDatabase(); new SecureSettingsRepository(db);
        const row=db.prepare('SELECT * FROM workspaces WHERE id = ?').get(process.env.UP_WS_ID);
        const workspace={id:row.id,name:row.name,path:row.path,createdAt:row.created_at,permissions:JSON.parse(row.permissions)};
        stripCuratedKitBlocksOnce(workspace,()=>true).then(r=>{manager.close();process.stdout.write('RESULT='+JSON.stringify(r)+'\n');},e=>{console.error(e);process.exitCode=1;});
      `,
      "Kit block strip",
      { UP_WS_ID: seed.workspaceId },
    );
    report.kitStrip = strip;
    assert.equal(strip.status, "done", JSON.stringify(strip));
    kitNow = await kitFiles();
    for (const [text, label] of [
      [kitNow.user, "USER.md"],
      [kitNow.memory, "MEMORY.md"],
    ]) {
      assert(!text.includes("cowork:auto:"), `${label} has no generated block`);
      assert(!text.includes("CURATED-"), `${label} no longer quotes curated facts`);
    }
    assert(kitNow.user.includes(MARK.userText), "USER.md keeps the user's text");
    assert(kitNow.memory.includes(MARK.memoryText), "MEMORY.md keeps the user's text");
    for (const [name, before] of [
      ["USER.md", kitBeforeUpgrade.user],
      ["MEMORY.md", kitBeforeUpgrade.memory],
    ]) {
      const snapshots = await readTree(path.join(kitDir, ".history", name));
      assert(
        Object.values(snapshots).some((content) => content === before),
        `.history/${name} holds the previous content`,
      );
    }
  } else {
    // ---- 3b. Current daemon, first start on a profile the previous build already migrated:
    // kept past the deferred jobs' delays, none of them may run again or move anything.
    const migrated = {
      markers: markers(),
      folder: await readTree(memoryRepo),
      items: memoryItems(),
      backups: await backups(),
      archive: archiveIds(),
    };
    const label = "current daemon, first start";
    const startedAt = Date.now();
    active = await runtime(root, "node", label);
    await sleep(135_000);
    assert(active.alive(), `${label} exited:\n${active.output().slice(-4000)}`);
    const run = await active.stop();
    active = null;
    await saveLog(label, run.output);
    report.steps.push({ step: label, seconds: Math.round((Date.now() - startedAt) / 1000), failureLines: run.failureLines });
    assert.deepEqual(run.failureLines, [], `${label} reported migration errors`);
    assert.deepEqual(markers(), migrated.markers, `${label}: the one-time memory jobs must not run again`);
    assert.deepEqual(await readTree(memoryRepo), migrated.folder, `${label}: memory folder must not change`);
    assert.deepEqual(memoryItems(), migrated.items, `${label}: memory items must not change`);
    assert.deepEqual(await backups(), migrated.backups, `${label}: no new backups`);
    assert.deepEqual(archiveIds(), migrated.archive, `${label}: the archive must not change`);
    assert.deepEqual(tasksAndEvents(), historyBefore, `${label}: tasks and events must not change`);
    assert.deepEqual(await kitFiles(), kitBeforeUpgrade, `${label}: the kit files must not change`);
  }

  // ---- 4. Current daemon again and the current desktop app: idempotent ----
  const settled = {
    schema: schemaSql(),
    folder: await readTree(memoryRepo),
    items: memoryItems(),
    backups: await backups(),
    kit: kitNow,
  };
  // The desktop app creates a few desktop-only tables and indexes on its first start (the
  // daemon never does), so its first start may only add objects; every later start must
  // leave the schema exactly as it was.
  const objectKey = (object) => `${object.type}:${object.name}`;
  for (const [kind, label, additionsAllowed] of [
    ["node", "current daemon, second start", false],
    ["desktop", "current desktop app, first start", true],
    ["desktop", "current desktop app, second start", false],
  ]) {
    active = await runtime(root, kind, label);
    await sleep(kind === "desktop" ? 10_000 : 6000);
    const run = await active.stop();
    active = null;
    await saveLog(label, run.output);
    report.steps.push({ step: label, failureLines: run.failureLines });
    assert.deepEqual(run.failureLines, [], `${label} reported migration errors`);
    const schemaNow = schemaSql();
    if (additionsAllowed) {
      const now = new Map(schemaNow.map((object) => [objectKey(object), object]));
      for (const object of settled.schema)
        assert.deepEqual(now.get(objectKey(object)), object, `${label}: ${objectKey(object)} must not change`);
      const added = schemaNow.filter((object) => !settled.schema.some((o) => objectKey(o) === objectKey(object)));
      report.steps.at(-1).schemaObjectsAdded = added.map(objectKey);
      assert(
        added.every((object) => object.type === "table" || object.type === "index"),
        `${label}: only tables and indexes may be added`,
      );
      settled.schema = schemaNow;
    } else {
      assert.deepEqual(schemaNow, settled.schema, `${label}: schema must not change again`);
    }
    assert.deepEqual(await readTree(memoryRepo), settled.folder, `${label}: memory folder must not change`);
    assert.deepEqual(memoryItems(), settled.items, `${label}: memory items must not change`);
    assert.deepEqual(await backups(), settled.backups, `${label}: no new backups`);
    assert.deepEqual(tasksAndEvents(), historyBefore, `${label}: tasks and events must not change`);
  }

  // Settings still readable by the current build, the secret one included.
  const settings = readSecureSettings(root, ["search", "appearance", "personality"]);
  assert.equal(settings.search.status, "success");
  assert.equal(settings.search.data?.brave?.apiKey, MARK.searchKey, "secret setting readable");
  assert.equal(settings.appearance.data?.themeMode, "dark", "plain setting readable");
  assert.equal(settings.personality.data?.relationship?.userName, MARK.userName, "user name kept");

  // ---- 5. Downgrade: the previous daemon opens the upgraded profile ----
  active = await runtime(baseline, "node", "previous daemon on the upgraded profile");
  await sleep(6000);
  const downgrade = await active.stop();
  active = null;
  await saveLog("previous daemon on the upgraded profile", downgrade.output);
  report.steps.push({ step: "previous daemon on the upgraded profile", failureLines: downgrade.failureLines });
  assert.deepEqual(downgrade.failureLines, [], "previous daemon reported errors on the upgraded profile");
  const oldSettings = readSecureSettings(baseline, ["search"]);
  assert.equal(oldSettings.search.data?.brave?.apiKey, MARK.searchKey, "previous build reads the secret");
  assert.deepEqual(tasksAndEvents().tasks, historyBefore.tasks, "downgrade keeps the tasks");

  // ---- 6. Re-upgrade after a downgrade: facts the previous build stored meanwhile ----
  if (!process.env.UP_SKIP_REUPGRADE) {
  // The previous build writes new facts to its own stores (0.5.54: SecureSettings
  // user-profile and curated_memory_entries, which it recreates; later builds: memory_items
  // without the folder, which only the runtimes open). Opening the profile with the current
  // build again must not silently drop them.
  runNode(
    baseline,
    String.raw`
      const {DatabaseManager}=require('./dist/daemon/electron/database/schema.js');
      const {SecureSettingsRepository}=require('./dist/daemon/electron/database/SecureSettingsRepository.js');
      ${OPEN_MEMORY}
      const manager=new DatabaseManager(); new SecureSettingsRepository(manager.getDatabase());
      (async()=>{
        await openMemory(manager);
        await UserProfileService.addFact({category:'preference',value:process.env.UP_FACT,source:'manual'});
        const r=await CuratedMemoryService.curate({workspaceId:process.env.UP_WS_ID,action:'add',target:'workspace',kind:'project_fact',content:process.env.UP_CURATED,skipMemoryWriteGate:true});
        if(!r.success) throw new Error(r.error);
        finish(manager);
      })().catch(e=>{console.error(e);process.exit(1);});
    `,
    "Downgraded build writes new facts",
    {
      UP_WS_ID: seed.workspaceId,
      UP_FACT: "DOWNGRADE-FACT: prefers tabs over spaces",
      UP_CURATED: "DOWNGRADE-CURATED: the QA lab moved to floor four",
    },
  );
  active = await runtime(root, "node", "current daemon after the downgrade");
  await sleep(8000);
  const reUpgrade = await active.stop();
  active = null;
  await saveLog("current daemon after the downgrade", reUpgrade.output);
  report.steps.push({ step: "current daemon after the downgrade", failureLines: reUpgrade.failureLines });
  const folderAfterReUpgrade = await readTree(memoryRepo);
  const itemsAfterReUpgrade = memoryItems();
  report.reUpgrade = Object.fromEntries(
    ["DOWNGRADE-FACT", "DOWNGRADE-CURATED"].map((text) => [
      text,
      {
        inFolder: filesWith(folderAfterReUpgrade, text),
        inMemoryItems: itemsAfterReUpgrade.some((item) => item.content.includes(text)),
      },
    ]),
  );
  for (const [text, where] of Object.entries(report.reUpgrade))
    assert(
      where.inFolder.length > 0 || where.inMemoryItems,
      `"${text}", stored by the previous build after a downgrade, is lost on the next upgrade`,
    );
  }

  const realFolderLeaks = [];
  if (existsSync(realMemoryFolder))
    for (const entry of await fs.readdir(realMemoryFolder, { withFileTypes: true, recursive: true })) {
      const file = path.join(entry.parentPath ?? entry.path, entry.name);
      if (!entry.isFile() || file.split(path.sep).includes(".git") || statSync(file).mtimeMs < smokeStartedAt) continue;
      const text = await fs.readFile(file, "utf8");
      // The seeded sentences (the bare user name is too common to tell anything).
      if (Object.values(MARK).some((mark) => mark.length > 20 && text.includes(mark)) || /DOWNGRADE-(FACT|CURATED)/.test(text))
        realFolderLeaks.push(path.relative(realMemoryFolder, file));
    }
  assert.deepEqual(realFolderLeaks, [], "the real ~/CoWork Memory must not receive the smoke's facts");

  report.status = "passed";
  report.retirement = {
    counts: retirementMarker.counts,
    droppedTables: retirementMarker.droppedTables,
    settingsDeleted: retirementMarker.settingsDeleted,
    backup: retirementMarker.backup,
  };
  report.factRetirement = folderRetirement;
  report.laneMigration = laneMarker;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.status = "failed";
  console.error(JSON.stringify(report, null, 2));
  console.error(`${error.stack || error}\n${active?.output().slice(-6000) ?? ""}`);
  process.exitCode = 1;
} finally {
  await active?.stop().catch(() => {});
  if (!process.env.UP_KEEP_PROFILE) await fs.rm(sandbox, { recursive: true, force: true });
  else console.error(`Profile kept at ${sandbox}`);
}
