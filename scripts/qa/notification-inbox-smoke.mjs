#!/usr/bin/env node
/** Concurrent processes exercise the built inbox service on a disposable profile. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {spawn} from "node:child_process";
import {createRequire} from "node:module";
const require=createRequire(import.meta.url);
const Database=require("better-sqlite3");
const root=path.resolve(path.dirname(new URL(import.meta.url).pathname),"../..");
const {NOTIFICATION_INBOX_SCHEMA,NotificationInboxStore}=require(path.join(root,"dist/daemon/electron/notifications/NotificationInboxStore.js"));
const {NotificationService}=require(path.join(root,"dist/daemon/electron/notifications/service.js"));
const directory=await fs.mkdtemp(path.join(os.tmpdir(),"cowork-inbox-concurrent-"));
const dbPath=path.join(directory,"inbox.db"),storePath=path.join(directory,"notifications.json");
let db;
try{
 const legacy={id:"legacy",type:"info",title:"Legacy",message:"Private imported body",read:false,createdAt:1};
 const source=JSON.stringify({version:1,notifications:[legacy]});await fs.writeFile(storePath,source);
 db=new Database(dbPath);db.pragma("journal_mode=WAL");db.exec(NOTIFICATION_INBOX_SCHEMA);
 const initial=new NotificationService({db,storePath});await initial.refresh();assert.equal(initial.list().length,1);
 const code=`
 const Database=require('better-sqlite3');const {NotificationService}=require('./dist/daemon/electron/notifications/service.js');
 const db=new Database(process.argv[1]);db.pragma('busy_timeout=10000');const service=new NotificationService({db,storePath:process.argv[2]});
 (async()=>{const label=process.argv[3];await service.refresh();for(let i=0;i<35;i++){const id=label+'-'+i;await service.add({id,type:'info',title:'Fixture',message:'Private disposable body'});if(i%5===0)await service.markRead(id);if(i%7===0)await service.delete(id);}db.close();})().catch(error=>{console.error(error);process.exitCode=1;});`;
 const run=label=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,["-e",code,dbPath,storePath,label],{cwd:root,env:{PATH:process.env.PATH,HOME:process.env.HOME},stdio:["ignore","pipe","pipe"]});let output="";child.stdout.on("data",chunk=>output+=chunk);child.stderr.on("data",chunk=>output+=chunk);const timer=setTimeout(()=>{child.kill("SIGKILL");reject(Error("Concurrent inbox child exceeded deadline"));},30000);child.once("error",error=>{clearTimeout(timer);reject(error);});child.once("exit",status=>{clearTimeout(timer);status===0?resolve():reject(Error(output));});});
 await Promise.all([run("a"),run("b")]);await initial.refresh();assert.equal(initial.list().length,61);const store=new NotificationInboxStore(db);
 for(const label of ["a","b"])for(let i=0;i<35;i++){const id=label+"-"+i;assert(store.contains(id));const entry=initial.list().find(row=>row.id===id);if(i%7===0)assert.equal(entry,undefined);else {assert(entry);assert.equal(entry.read,i%5===0);}}
 await initial.delete("legacy");const restarted=new NotificationService({db,storePath});await restarted.refresh();assert(!restarted.list().some(row=>row.id==="legacy"));assert(await restarted.containsDeliveryIdentity("legacy"));assert.equal(await fs.readFile(storePath,"utf8"),source);
 console.log(JSON.stringify({canonicalInbox:"passed",concurrentProcesses:2,uniqueDeliveryIdentities:71,currentBodies:60,legacyImportedOnce:true,deletedBodiesNotRestored:true,legacySourceUnchanged:true}));
}finally{db?.close();await fs.rm(directory,{recursive:true,force:true});}
