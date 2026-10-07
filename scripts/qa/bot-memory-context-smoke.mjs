#!/usr/bin/env node
/** Built memory services on a disposable profile: no model or channel sends. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {createRequire} from "node:module";
const require=createRequire(import.meta.url);
const directory=await fs.mkdtemp(path.join(os.tmpdir(),"cowork-bot-memory-"));
process.env.COWORK_USER_DATA_DIR=directory;
const {DatabaseManager}=require('../../dist/daemon/electron/database/schema.js');
const {WorkspaceStore,TaskStore}=require('../../dist/daemon/electron/database/repositories.js');
const {MemoryItemsRepository}=require('../../dist/daemon/electron/memory/MemoryItemsRepository.js');
const {MemoryWriter}=require('../../dist/daemon/electron/memory/MemoryWriter.js');
const {MemoryItemsHubService}=require('../../dist/daemon/electron/memory/MemoryItemsHubService.js');
const {MemoryContextBuilderService}=require('../../dist/daemon/electron/memory/MemoryContextBuilder.js');
const {AgentRoleStore}=require('../../dist/daemon/electron/agents/AgentRoleRepository.js');
const {MemoryRecallService}=require('../../dist/daemon/electron/memory/MemoryRecall.js');
const {MemoryRecallStore}=require('../../dist/daemon/electron/memory/memory-recall-sql.js');
let manager;
try{
 manager=new DatabaseManager({dbPath:path.join(directory,'test.db')});const db=manager.getDatabase();const workspaces=new WorkspaceStore(db);const ws=workspaces.create('Fixture',directory,{read:true,write:false,delete:false,shell:false,network:false});
 const repo=new MemoryItemsRepository(db);let version=0;const writer=new MemoryWriter({repository:repo,bumpHotMemoryVersion:()=>version++});const hub=new MemoryItemsHubService({getWriter:()=>writer});
 const result=await writer.ingest({kind:'project_fact',scope:'workspace',workspaceId:ws.id,content:'Fixture release location is Lisbon',source:'user_stated',pinned:true,sourceRef:{store:'fixture',id:'fact'}});assert.equal(result.status,'written');
 const request={workspaceId:ws.id,surface:'chat',budgetTokens:2000,focus:'Fixture release location'};
 const fresh=()=>new MemoryContextBuilderService({getItemsPort:()=>repo,getHotMemoryVersion:()=>version});
 const render=async(surface='chat',gatewaySenderIsOwner)=>(await fresh().build({...request,surface,gatewaySenderIsOwner})).map(block=>block.text).join('\n');
 const cached=fresh();assert((await cached.build(request)).map(block=>block.text).join('\n').includes('Lisbon'));assert((await render()).includes('Lisbon'));
 const revised=await hub.update({workspaceId:ws.id,id:result.item.id,content:'Fixture release location is Porto'});assert.equal(revised.success,true);assert(revised.item);const corrected=await render();assert(corrected.includes('Porto'));assert(!corrected.includes('Lisbon'));assert(!(await cached.build(request)).map(block=>block.text).join('\n').includes('Lisbon'));
 const search=async query=>repo.searchForContext({workspaceId:ws.id,query,includePrivate:false,limit:10});assert((await search('Porto')).some(item=>item.id===revised.item.id));assert(!(await search('Lisbon')).some(item=>item.id===result.item.id));assert((await repo.listForView(ws.id,'workspace')).some(item=>item.id===revised.item.id));
 const privateFact=await writer.ingest({kind:'preference',scope:'global',content:'Private fixture prefers secret violet stationery',source:'user_stated',privacy:'private',pinned:true});assert.equal(privateFact.status,'written');assert((await render()).includes('secret violet'));assert(!(await render('channel_group')).includes('secret violet'));assert((await render('channel_private',true)).includes('secret violet'));assert.equal(await render('channel_private',false),'');assert.equal(await render('channel_private'),'');
 let memoryReads=0;const channelRecall=new MemoryRecallService({searchItems:async query=>{memoryReads++;return new MemoryRecallStore(db).searchItems(query);},laneEnabled:()=>true,externalConfigured:()=>false,now:()=>Date.now()});
 const recallRequest={text:'secret violet',workspaceId:ws.id,surface:'channel_private',lanes:['memory'],ids:[`memory:${privateFact.item.id}`],policy:{includePrivate:true}};
 assert.equal((await channelRecall.recall({...recallRequest,gatewaySenderIsOwner:true})).hits.length,1);const ownerReads=memoryReads;
 for(const gatewaySenderIsOwner of [false,undefined]){for(const ids of [undefined,recallRequest.ids]){const denied=await channelRecall.recall({...recallRequest,gatewaySenderIsOwner,ids,lanes:['memory','archive','conversations','knowledge','external'],policy:{includePrivate:true,allowExternal:true}});assert.deepEqual(denied.hits,[]);assert.deepEqual(denied.lanes,[]);assert.equal(memoryReads,ownerReads);}}
 assert.deepEqual((await channelRecall.recall({...recallRequest,surface:'channel_group',gatewaySenderIsOwner:true})).hits,[]);assert.equal(memoryReads,ownerReads);

 assert.equal((await hub.delete({workspaceId:ws.id,id:revised.item.id})).success,true);const forgotten=await render();assert(!forgotten.includes('Porto'));assert(!forgotten.includes('Lisbon'));assert(!(await search('Porto')).some(item=>item.id===revised.item.id));assert(!(await repo.listForView(ws.id,'workspace')).some(item=>item.id===revised.item.id));
 const roles=new AgentRoleStore(db);const original=roles.create({name:'fixture-source',displayName:'Fixture source',capabilities:[],heartbeatEnabled:false});const later=roles.create({name:'fixture-later',displayName:'Fixture later',capabilities:[],heartbeatEnabled:false});
 const tasks=new TaskStore(db);const task=tasks.create({title:'Capture fixture',prompt:'fixture',status:'completed',workspaceId:ws.id,assignedAgentRoleId:original.id});
 const capture=await writer.ingest({kind:'project_fact',scope:'workspace',workspaceId:ws.id,taskId:task.id,content:'Fixture source record has capture-time provenance',source:'inferred',sourceRef:{store:'fixture',id:'bot-capture',agentRoleId:later.id}});assert.equal(capture.status,'written');assert.equal(capture.item.sourceRef.agentRoleId,original.id);assert.equal(capture.item.sourceRef.capturedTaskId,task.id);
 const globalCapture=await writer.ingest({kind:'preference',scope:'global',originWorkspaceId:ws.id,taskId:task.id,content:'Fixture global prefers capture-time provenance',source:'inferred',sourceRef:{store:'fixture',id:'global-capture'}});assert.equal(globalCapture.status,'written');assert.equal(globalCapture.item.sourceRef.agentRoleId,original.id);
 db.prepare('UPDATE tasks SET assigned_agent_role_id = ? WHERE id = ?').run(later.id,task.id);db.prepare('UPDATE agent_roles SET is_active = 0 WHERE id = ?').run(original.id);
 const provenanceEdit=await hub.update({workspaceId:ws.id,id:capture.item.id,content:'Fixture source record keeps original provenance after correction'});assert.equal(provenanceEdit.success,true);assert.equal(provenanceEdit.item.originBotId,original.id);
 const history=await writer.ingest({mode:'migration',kind:'project_fact',scope:'workspace',workspaceId:ws.id,taskId:task.id,content:'Historical fixture has no captured bot identity',source:'inferred',sourceRef:{store:'fixture',id:'historical-capture'}});assert.equal(history.status,'written');assert.equal(history.item.sourceRef.agentRoleId,undefined);
 const historyEdit=await hub.update({workspaceId:ws.id,id:history.item.id,content:'Historical fixture remains unattributed after correction'});assert.equal(historyEdit.success,true);assert.equal(historyEdit.item.originBotId,null);
 const revisedId=provenanceEdit.item.id;manager.close();manager=new DatabaseManager({dbPath:path.join(directory,'test.db')});const reopened=new MemoryItemsRepository(manager.getDatabase());assert.equal((await reopened.findById(revisedId)).sourceRef.agentRoleId,original.id);
 console.log(JSON.stringify({builtMemoryServices:true,captureTimeBotSource:true,globalOriginBound:true,reassignmentPreservesSource:true,historicalCorrectionUnattributed:true,restartPreservesSource:true,disposableProfile:true,freshContextUsesCorrection:true,cachedContextInvalidated:true,indexedRecallUsesCorrection:true,derivedViewDropsForgottenFact:true,forgottenRevisionsExcluded:true,privateOwnerContextExcludedFromGroups:true,privateChannelRequiresOwner:true,channelRecallDeniedBeforeReads:true,modelExecution:false,channelDelivery:false}));
}finally{manager?.close();await fs.rm(directory,{recursive:true,force:true});}
