#!/usr/bin/env node
/** Disposable compiled CLI metadata proof. No decisions, model calls or messages. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-cli-approval-revision-"));
const environment = Object.fromEntries(["PATH", "HOME", "TMPDIR", "SystemRoot"]
  .filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
Object.assign(environment, {COWORK_USER_DATA_DIR: directory, COWORK_HEADLESS: "1", COWORK_IMPORT_ENV_SETTINGS: "0"});
function run(args) {
  const result = spawnSync(process.execPath, args, {cwd: root, env: environment, encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024});
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
try {
  const seed = run(["-e", `
    const {DatabaseManager}=require('./dist/cli/electron/database/schema.js');
    const {WorkspaceStore,TaskStore,ApprovalStore}=require('./dist/cli/electron/database/repositories.js');
    const {approvalRequestRevisionHash}=require('./dist/cli/electron/agent/approval-revision.js');
    const m=new DatabaseManager();const db=m.getDatabase();
    const w=new WorkspaceStore(db).create('CLI fixture',process.env.COWORK_USER_DATA_DIR,{read:true,write:false,delete:false,shell:false,network:false});
    const t=new TaskStore(db).create({title:'Review fixture',prompt:'Synthetic metadata only',workspaceId:w.id,status:'blocked'});
    const a=new ApprovalStore(db).create({taskId:t.id,type:'run_command',description:'Review exact fixture arguments',details:{command:'fixture --target draft.md',params:{fixtureOnly:true}},status:'pending',requestedAt:Date.now()});
    console.log('FIXTURE='+JSON.stringify({id:a.id,hash:approvalRequestRevisionHash(a)}));m.close();
  `]);
  const expected = JSON.parse(seed.split("\n").find((line) => line.startsWith("FIXTURE=")).slice(8));
  const listing = run([path.join(root, "dist/cli/cli/direct-run.js"), "--approvals-list", "--json"]);
  const event = listing.split("\n").filter(Boolean).map((line) => {try {return JSON.parse(line)} catch {return null}}).find((entry) => entry?.type === "approvals");
  assert.ok(event, "Compiled local CLI returned no approval list");
  const approval = event.approvals.find((row) => row.id === expected.id);
  assert.ok(approval, "Fixture approval absent");
  assert.equal(approval.revisionHash, expected.hash);
  assert.equal(approval.details.command, "fixture --target draft.md");
  const text = run([path.join(root, "dist/cli/cli/direct-run.js"), "--approvals-list"]);
  assert.ok(text.includes(`--revision-hash ${expected.hash}`));
  assert.ok(text.includes("fixture --target draft.md"));
  run(["-e", `
    const {DatabaseManager}=require('./dist/cli/electron/database/schema.js');const m=new DatabaseManager();
    const db=m.getDatabase();const rows=db.prepare('SELECT status FROM approvals').all();
    if(rows.length!==1||rows[0].status!=='pending'||db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n!==1)throw Error('Metadata listing changed fixture work');m.close();
  `]);
  const entry = await fs.readFile(path.join(root, "dist/cli/cli/direct-run.js"));
  console.log(JSON.stringify({fixture:true,modelExecution:false,approvalDecision:false,channelDelivery:false,compiledListRevision:true,displayedDetails:true,metadataPreserved:true,compiledDirectRunSha256:createHash("sha256").update(entry).digest("hex")}));
} finally {
  await fs.rm(directory, {recursive:true,force:true});
}
