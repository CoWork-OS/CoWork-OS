#!/usr/bin/env node
/** Built durable routing on a disposable profile. No adapter, model or action execution. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
const require=createRequire(import.meta.url);
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cowork-channel-decision-'));
process.env.COWORK_USER_DATA_DIR=directory;
const {DatabaseManager}=require('../../dist/daemon/electron/database/schema.js');
const {WorkspaceStore,TaskStore,ApprovalStore}=require('../../dist/daemon/electron/database/repositories.js');
const {AgentRoleStore}=require('../../dist/daemon/electron/agents/AgentRoleRepository.js');
const {ChannelDecisionRepository}=require('../../dist/daemon/electron/gateway/ChannelDecisionRepository.js');
const {DatabaseClient}=require('../../dist/daemon/electron/database/async/DatabaseClient.js');
const {DATABASE_COMMANDS,requiredTablesFor}=require('../../dist/daemon/electron/database/async/commands.js');
const {setStatementClient}=require('../../dist/daemon/electron/database/statements/statement-route.js');
const {ChannelDecisionService}=require('../../dist/daemon/electron/gateway/ChannelDecisionService.js');
const {TeamsConversationReferenceRepository}=require('../../dist/daemon/electron/gateway/TeamsConversationReferenceRepository.js');
const {teamsDecisionEvent}=require('../../dist/daemon/electron/gateway/channels/decision-cards.js');
const {ApprovalRepository}=require('../../dist/daemon/electron/database/repository-facades.js');
let manager,client;let workerUnitCalls=0;
try {
 manager=new DatabaseManager({dbPath:path.join(directory,'test.db')});let db=manager.getDatabase();
 const ws=new WorkspaceStore(db).create('Decision fixture',directory,{read:true,write:false,shell:false,network:false,delete:false});
 const bot=new AgentRoleStore(db).create({name:'decision-fixture',displayName:'Decision fixture',capabilities:[],heartbeatEnabled:false});
 const tasks=new TaskStore(db);const root=tasks.create({title:'Origin fixture',prompt:'fixture',status:'blocked',workspaceId:ws.id,assignedAgentRoleId:bot.id,agentConfig:{gatewayContext:'private'}});
 const child=tasks.create({title:'Child fixture',prompt:'fixture',status:'blocked',workspaceId:ws.id,parentTaskId:root.id,agentType:'sub'});
 const requestedAt=Date.now();const details=JSON.stringify({command:'node --version',revisionHash:'fixture-r1'});
 const approval=new ApprovalStore(db).create({taskId:child.id,type:'run_command',description:'Review the fixture command',details:JSON.parse(details),status:'pending',requestedAt});
 const channel=randomUUID(),session=randomUUID();
 db.prepare("INSERT INTO channels (id,type,name,enabled,config,security_config,created_at,updated_at) VALUES (?,'slack','Fixture',1,'{}','{}',?,?)").run(channel,requestedAt,requestedAt);
 db.prepare("INSERT INTO channel_users (id,channel_id,channel_user_id,display_name,allowed,created_at,last_seen_at) VALUES (?,?,'fixture-actor','Fixture actor',1,?,?)").run(randomUUID(),channel,requestedAt,requestedAt);
 db.prepare("INSERT INTO channel_sessions (id,channel_id,chat_id,task_id,workspace_id,context,created_at,last_activity_at) VALUES (?,?,'fixture-chat',?,?,?, ?,?)").run(session,channel,root.id,ws.id,JSON.stringify({taskRequesterUserId:'fixture-actor'}),requestedAt,requestedAt);
 const legacyInputId=randomUUID();db.prepare("INSERT INTO input_requests (id,task_id,questions,status,requested_at) VALUES (?,?,?,'pending',?)").run(legacyInputId,root.id,JSON.stringify([{id:'legacy-choice',header:'Legacy',question:'Legacy choice'}]),requestedAt);
 db.exec('DROP TABLE channel_approval_consumption');db.exec('DROP TABLE channel_decision_routes');db.exec('DROP TABLE teams_conversation_references');db.exec('DROP TABLE approval_input_links');manager.close();manager=new DatabaseManager({dbPath:path.join(directory,'test.db')});db=manager.getDatabase();assert.equal(new ApprovalStore(db).findById(approval.id).status,'pending');assert.equal(db.prepare('SELECT is_active FROM agent_roles WHERE id = ?').get(bot.id).is_active,1);
 assert.equal(db.prepare('SELECT status FROM input_requests WHERE id = ?').get(legacyInputId).status,'pending');assert.equal(db.prepare('SELECT COUNT(*) AS n FROM approval_input_links').get().n,0);
 const repo=new ChannelDecisionRepository(db);const route=await repo.create({approvalId:approval.id,sessionId:session,actorId:'fixture-actor'});
 assert.equal(route.taskId,child.id);assert.equal(route.rootTaskId,root.id);assert.equal(route.botId,bot.id);assert.equal(route.expiresAt,requestedAt+300_000);
 client=await DatabaseClient.start({dbPath:manager.getDatabasePath(),requiredTables:requiredTablesFor(DATABASE_COMMANDS),workerPath:path.resolve('dist/daemon/electron/database/async/database-worker.js')});const execute=client.execute.bind(client);client.execute=(...args)=>{if(args[0].startsWith('statements.'))workerUnitCalls++;return execute(...args);};setStatementClient('services',manager.getDatabasePath(),client);
 assert.equal((await repo.create({approvalId:approval.id,sessionId:session,actorId:'fixture-actor'})).id,route.id);
 const delivery=await repo.beginDelivery(route.id);await assert.rejects(repo.beginDelivery(route.id));
 await assert.rejects(repo.delivered(route.id,'foreign-claim','fixture-message'));
 await repo.delivered(route.id,delivery.deliveryClaimId,'fixture-message');
 const callback={routeId:route.id,channelId:channel,channelType:'slack',chatId:'fixture-chat',messageId:'fixture-message',actorId:'fixture-actor',callbackId:'fixture-click',action:'approve',transport:'slack_socket'};
 await assert.rejects(repo.claim({...callback,actorId:'wrong-actor'}));
 db.prepare("UPDATE approvals SET details = ? WHERE id = ?").run(JSON.stringify({command:'changed'}),approval.id);await assert.rejects(repo.claim(callback));
 db.prepare("UPDATE approvals SET details = ? WHERE id = ?").run(details,approval.id);
 const claimed=await repo.claim(callback);assert.equal(claimed.state,'claimed');assert.equal(new ApprovalStore(db).findById(approval.id).status,'pending');
 const casRequest=new ApprovalStore(db).create({taskId:child.id,type:'run_command',description:'Atomic fixture response',details:{command:'fixture command'},status:'pending',requestedAt:Date.now()});
 setStatementClient('storage',manager.getDatabasePath(),client);
 const workerAttempt=new ApprovalRepository(db).resolvePending(casRequest.id,'approved',casRequest);
 const hostWon=new ApprovalStore(db).resolvePending(casRequest.id,'denied',casRequest);const workerWon=await workerAttempt;
 assert.equal(Number(hostWon)+Number(workerWon),1);assert.equal(new ApprovalStore(db).findById(casRequest.id).status,hostWon?'denied':'approved');assert.equal(new ApprovalStore(db).update(casRequest.id,'denied'),false);
 const approvalFacade=new ApprovalRepository(db);
 const originalGuard={routeId:route.id,claimId:claimed.claimId};
 db.prepare("UPDATE channels SET config = ? WHERE id = ?").run('{"ownerUserIds":[]}',channel);
 await assert.rejects(approvalFacade.resolvePending(approval.id,'approved',approval,undefined,originalGuard));
 assert.equal(new ApprovalStore(db).findById(approval.id).status,'pending');
 db.prepare("UPDATE channels SET config = ? WHERE id = ?").run('{}',channel);
 const guardedRequest=new ApprovalStore(db).create({taskId:child.id,type:'run_command',description:'Guarded fixture response',details:{command:'guarded fixture'},status:'pending',requestedAt:Date.now()});
 const guardedRoute=await repo.create({approvalId:guardedRequest.id,sessionId:session,actorId:'fixture-actor'});
 const guardedDelivery=await repo.beginDelivery(guardedRoute.id);await repo.delivered(guardedRoute.id,guardedDelivery.deliveryClaimId,'guarded-message');
 const guardedClaim=await repo.claim({...callback,routeId:guardedRoute.id,messageId:'guarded-message',callbackId:'guarded-click'});
 assert.equal(await approvalFacade.resolvePending(guardedRequest.id,'approved',guardedRequest,undefined,{routeId:guardedRoute.id,claimId:guardedClaim.claimId}),true);
 await repo.finish(guardedRoute.id,guardedClaim.claimId,'handled');
 assert.equal(new ApprovalStore(db).findById(guardedRequest.id).status,'approved');
 assert.equal(await approvalFacade.approvedRevisionCurrent(guardedRequest.id,guardedRoute.approvalRevisionHash),true);
 db.prepare("UPDATE channels SET config = ? WHERE id = ?").run(JSON.stringify({ownerUserIds:['fixture-actor'],decisionMessagesEnabled:true}),channel);
 const serviceRequest=new ApprovalStore(db).create({taskId:child.id,type:'run_command',description:'Service fixture response',details:{command:'service fixture'},status:'pending',requestedAt:Date.now()});
 let syntheticCards=0;let serviceResponses=0;
 const syntheticAdapter={type:'slack',status:'connected',decisionCapabilities:{approve:true,deny:true},sendDecision:async()=>{syntheticCards++;return 'service-message';}};
 const service=new ChannelDecisionService({repository:repo,
  getSession:async(id)=>id===session?{id:session,channelId:channel}:undefined,
  getChannel:async(id)=>{const row=db.prepare('SELECT * FROM channels WHERE id = ?').get(id);return row?{...row,enabled:row.enabled===1,config:JSON.parse(row.config)}:undefined;},
  getApproval:async(id)=>new ApprovalStore(db).findById(id),getAdapter:(id)=>id===channel?syntheticAdapter:undefined,
  describeApproval:(request)=>request.description,
  respond:async(input)=>{serviceResponses++;assert.match(input.expectedRevisionHash,/^[a-f0-9]{64}$/);assert.equal(input.attribution.principalId,'gateway:slack:fixture-actor');return await approvalFacade.resolvePending(input.approvalId,input.approved?'approved':'denied',new ApprovalStore(db).findById(input.approvalId),input.attribution,input.guard)?'handled':'not_found';},
 });
 await assert.rejects(service.publish({approvalId:serviceRequest.id,sessionId:session,actorId:'allowlisted-contact'}));
 const serviceRoute=await service.publish({approvalId:serviceRequest.id,sessionId:session,actorId:'fixture-actor'});
 await service.publish({approvalId:serviceRequest.id,sessionId:session,actorId:'fixture-actor'});assert.equal(syntheticCards,1);
 const serviceEvent={...callback,routeId:serviceRoute.id,messageId:'service-message',callbackId:'service-click'};delete serviceEvent.channelId;
 assert.equal(await service.handle(channel,serviceEvent),'handled');assert.equal(serviceResponses,1);
 assert.equal(new ApprovalStore(db).findById(serviceRequest.id).status,'approved');
 await assert.rejects(service.handle(channel,serviceEvent));assert.equal(serviceResponses,1);
 // Capture and validate actual workspace bytes through the routed storage writer.
 const draftPath=path.join(directory,'reviewed-draft.md');await fs.writeFile(draftPath,'reviewed fixture bytes');
 const draftRequest=await approvalFacade.create({taskId:child.id,type:'data_export',description:'Review fixture file',details:{reviewFiles:['reviewed-draft.md'],draftRevision:{state:'forged'}},status:'pending',requestedAt:Date.now()},{path:directory,permissions:ws.permissions});
 assert.equal(draftRequest.details.draftRevision.state,'bound');assert.match(draftRequest.details.draftRevision.entries[0].sha256,/^[a-f0-9]{64}$/);
 const draftRoute=await repo.create({approvalId:draftRequest.id,sessionId:session,actorId:'fixture-actor'});
 const draftDelivery=await repo.beginDelivery(draftRoute.id);await repo.delivered(draftRoute.id,draftDelivery.deliveryClaimId,'draft-message');
 const draftCallback={...callback,routeId:draftRoute.id,messageId:'draft-message',callbackId:'draft-click'};
 await fs.writeFile(draftPath,'changed before click');await assert.rejects(repo.claim(draftCallback));
 await fs.writeFile(draftPath,'reviewed fixture bytes');const draftClaim=await repo.claim(draftCallback);
 await fs.writeFile(draftPath,'changed after claim');await assert.rejects(approvalFacade.resolvePending(draftRequest.id,'approved',draftRequest,undefined,{routeId:draftRoute.id,claimId:draftClaim.claimId}));
 assert.equal(new ApprovalStore(db).findById(draftRequest.id).status,'pending');
 assert.equal(await approvalFacade.approvedRevisionCurrent(guardedRequest.id,(await repo.get(guardedRoute.id)).approvalRevisionHash),false);
 const grantedFileRequest=await approvalFacade.create({taskId:child.id,type:'data_export',description:'Grant consumption fixture',details:{reviewFiles:['reviewed-draft.md']},status:'pending',requestedAt:Date.now()},{path:directory,permissions:ws.permissions});
 assert.equal(await approvalFacade.resolvePending(grantedFileRequest.id,'approved',grantedFileRequest),true);
 const {approvalRequestRevisionHash}=require('../../dist/daemon/electron/agent/approval-revision.js');const grantRevision=approvalRequestRevisionHash(grantedFileRequest);
 assert.equal(await approvalFacade.approvedRevisionCurrent(grantedFileRequest.id,grantRevision),true);
 await fs.writeFile(draftPath,'changed before consumption');assert.equal(await approvalFacade.approvedRevisionCurrent(grantedFileRequest.id,grantRevision),false);
 // Execute the compiled inline resumption path with the real storage worker,
 // a synthetic local answer and no provider or approved effect.
 const {AgentDaemon}=require('../../dist/daemon/electron/agent/daemon.js');
 process.env.COWORK_APPROVAL_PROMPTS='off';process.env.COWORK_HEADLESS='0';
 const inlineTasks=new TaskStore(db);const inlineTask=inlineTasks.create({title:'Inline worker fixture',prompt:'fixture',status:'executing',workspaceId:ws.id,agentConfig:{accessProfileId:'ask_for_approval'}});
 let inlineSuccesses=0;
 const inlineDaemon={approvalRepo:approvalFacade,taskRepo:inlineTasks,pendingApprovals:new Map(),
  requestAssistantApproval:AgentDaemon.prototype.requestAssistantApproval,isApprovalAuthorityCurrent:async()=>true,
  evaluatePermissionRequest:async()=>({evaluation:{decision:'ask',reason:{type:'mode',mode:'default',summary:'Review fixture'}},promptDetails:{scope:{kind:'tool',toolName:'http_request'}},trackingKey:'fixture-inline',authorizationKey:'fixture-inline',workspace:ws,runtime:{recordPermissionSuccess:()=>{inlineSuccesses++;},recordPermissionDenial:()=>{}}}),
  logEvent:()=>{},updateTask:()=>{},requestUserInput:async()=>({requestId:'fixture-input',status:'submitted',answers:{approval_decision:{optionLabel:'Allow once'}}}),
 };
 await fs.writeFile(draftPath,'inline reviewed bytes');
 const inlineDetails={tool:'http_request',reviewFiles:['reviewed-draft.md']};
 assert.equal(await AgentDaemon.prototype.requestApproval.call(inlineDaemon,inlineTask.id,'data_export','Inline worker fixture',inlineDetails,{allowAutoApprove:false}),true);assert.equal(inlineSuccesses,1);
 inlineDaemon.requestUserInput=async()=>{await fs.writeFile(draftPath,'changed while inline card was open');return {requestId:'fixture-input-changed',status:'submitted',answers:{approval_decision:{optionLabel:'Allow once'}}};};
 assert.equal(await AgentDaemon.prototype.requestApproval.call(inlineDaemon,inlineTask.id,'data_export','Changed inline worker fixture',inlineDetails,{allowAutoApprove:false}),false);assert.equal(inlineSuccesses,1);
 const {InputRequestRepository}=require('../../dist/daemon/electron/database/repository-facades.js');
 const {InputRequestStore}=require('../../dist/daemon/electron/database/repositories.js');
 const {buildAssistantApprovalRequest}=require('../../dist/daemon/electron/agent/assistant-approval.js');
 const inputFacade=new InputRequestRepository(db);
 const interruptedApproval=await approvalFacade.create({taskId:inlineTask.id,type:'run_command',description:'Interrupted inline fixture',details:{command:'fixture only'},status:'pending',requestedAt:Date.now()});
 const interruptedBinding={approvalId:interruptedApproval.id,revisionHash:approvalRequestRevisionHash(interruptedApproval)};
 const interruptedInput=await inputFacade.create({taskId:inlineTask.id,...buildAssistantApprovalRequest('run_command','Interrupted fixture',{}),requestedAt:Date.now(),status:'pending'},interruptedBinding);
 assert.deepEqual(await inputFacade.getApprovalBinding(interruptedInput.id),{...interruptedBinding,taskId:inlineTask.id});
 const racedInput=await inputFacade.create({taskId:inlineTask.id,questions:[{id:'fixture-choice',header:'Fixture',question:'Fixture choice'}],requestedAt:Date.now(),status:'pending'});
 const inputWorkerAttempt=inputFacade.resolve(racedInput.id,'submitted',{ 'fixture-choice':{otherText:'fixture'} });
 const inputHostWon=new InputRequestStore(db).resolve(racedInput.id,'dismissed');const inputWorkerWon=await inputWorkerAttempt;assert.equal(Number(inputHostWon)+Number(inputWorkerWon),1);
 const teamsChannel=randomUUID();const teamsConfig=JSON.stringify({appId:'fixture-app',tenantId:'fixture-tenant',ownerUserIds:['fixture-actor'],decisionMessagesEnabled:true});db.prepare("INSERT INTO channels (id,type,name,enabled,config,security_config,created_at,updated_at) VALUES (?,'teams','Teams fixture',1,?,'{}',?,?)").run(teamsChannel,teamsConfig,requestedAt,requestedAt);
 const teamsReferences=new TeamsConversationReferenceRepository(db);const teamsPolicy=await teamsReferences.policy(teamsChannel);
 const teamsScope={channelId:teamsChannel,appId:'fixture-app',tenantId:'fixture-tenant',policyHash:teamsPolicy};
 const teamsReference={channelId:'msteams',serviceUrl:'https://smba.trafficmanager.net/amer/',bot:{id:'fixture-bot'},conversation:{id:'fixture-teams-chat',tenantId:'fixture-tenant'}};
 await teamsReferences.put({...teamsScope,reference:teamsReference});assert.deepEqual(await teamsReferences.get({...teamsScope,chatId:'fixture-teams-chat'}),teamsReference);
 db.prepare("UPDATE channels SET config = 'changed-fixture' WHERE id = ?").run(teamsChannel);
 await assert.rejects(teamsReferences.get({...teamsScope,chatId:'fixture-teams-chat'}));db.prepare("UPDATE channels SET config = ? WHERE id = ?").run(teamsConfig,teamsChannel);
 const teamsSession=randomUUID();db.prepare("INSERT INTO channel_users (id,channel_id,channel_user_id,display_name,allowed,created_at,last_seen_at) VALUES (?,?,'fixture-actor','Fixture actor',1,?,?)").run(randomUUID(),teamsChannel,requestedAt,requestedAt);
 db.prepare("INSERT INTO channel_sessions (id,channel_id,chat_id,task_id,workspace_id,context,created_at,last_activity_at) VALUES (?,?,'fixture-teams-chat',?,?,?, ?,?)").run(teamsSession,teamsChannel,root.id,ws.id,JSON.stringify({taskRequesterUserId:'fixture-actor'}),requestedAt,requestedAt);
 const teamsRequest=await approvalFacade.create({taskId:child.id,type:'run_command',description:'Restarted Teams fixture approval',details:{command:'fixture only'},status:'pending',requestedAt:Date.now()});
 const teamsRoute=await repo.create({approvalId:teamsRequest.id,sessionId:teamsSession,actorId:'fixture-actor'});const teamsDelivery=await repo.beginDelivery(teamsRoute.id);await repo.delivered(teamsRoute.id,teamsDelivery.deliveryClaimId,'fixture-teams-message');
 assert(workerUnitCalls>=8);
 await client.close(2000);client=null;setStatementClient(null,null,null);manager.close();manager=new DatabaseManager({dbPath:path.join(directory,'test.db')});
 const restartedTeamsReferences=new TeamsConversationReferenceRepository(manager.getDatabase());assert.deepEqual(await restartedTeamsReferences.get({...teamsScope,chatId:'fixture-teams-chat'}),teamsReference);
 const restartDb=manager.getDatabase(), restartApprovals=new ApprovalRepository(restartDb),restartRoutes=new ChannelDecisionRepository(restartDb);
 let teamsResponses=0;
 const restartedTeamsService=new ChannelDecisionService({repository:restartRoutes,
  getSession:async(id)=>id===teamsSession?{id,channelId:teamsChannel}:undefined,
  getChannel:async(id)=>{const row=restartDb.prepare('SELECT * FROM channels WHERE id = ?').get(id);return row?{...row,enabled:row.enabled===1,config:JSON.parse(row.config)}:undefined;},
  getApproval:async(id)=>new ApprovalStore(restartDb).findById(id),getAdapter:()=>undefined,describeApproval:(request)=>request.description,
  respond:async(input)=>{teamsResponses++;return await restartApprovals.resolvePending(input.approvalId,input.approved?'approved':'denied',new ApprovalStore(restartDb).findById(input.approvalId),input.attribution,input.guard)?'handled':'not_found';},
 });
 const recoveredTeamsRef=await restartedTeamsReferences.get({...teamsScope,chatId:'fixture-teams-chat'});
 const normalizedTeamsEvent=teamsDecisionEvent({type:'message',channelId:'msteams',id:'fixture-teams-click',replyToId:'fixture-teams-message',from:{id:'fixture-actor'},recipient:{id:recoveredTeamsRef.bot.id},conversation:recoveredTeamsRef.conversation,channelData:{tenant:{id:'fixture-tenant'}},value:{coworkDecision:1,routeId:teamsRoute.id,action:'approve'}},'fixture-tenant',recoveredTeamsRef.bot.id);
 assert(normalizedTeamsEvent);assert.equal((await restartRoutes.get(teamsRoute.id)).state,'sent');assert.equal(await restartedTeamsService.handle(teamsChannel,normalizedTeamsEvent),'handled');assert.equal(teamsResponses,1);assert.equal(new ApprovalStore(restartDb).findById(teamsRequest.id).status,'approved');await assert.rejects(restartedTeamsService.handle(teamsChannel,normalizedTeamsEvent));assert.equal(teamsResponses,1);
 const restartedInputs=new InputRequestRepository(restartDb);assert.deepEqual(await restartedInputs.getApprovalBinding(interruptedInput.id),{...interruptedBinding,taskId:inlineTask.id});
 let interruptedResumes=0;const interruptedDaemon={inputRequestRepo:restartedInputs,approvalRepo:restartApprovals,pendingInputRequests:new Map(),resolveRestartedResponsibilityActionReviewInput:async()=>null,logEvent:()=>{},resumeTaskAfterDurableWait:async()=>{interruptedResumes++;}};
 assert.equal((await AgentDaemon.prototype.respondToInputRequest.call(interruptedDaemon,{requestId:interruptedInput.id,status:'submitted',answers:{approval_decision:{optionLabel:'Allow once'}}})).status,'handled');assert.equal(interruptedResumes,0);assert.equal((await restartedInputs.findById(interruptedInput.id)).status,'dismissed');assert.equal((await restartApprovals.findById(interruptedApproval.id)).status,'denied');
 assert.equal(await restartApprovals.approvedRevisionCurrent(teamsRequest.id,teamsRoute.approvalRevisionHash),true);
 restartDb.prepare("UPDATE channels SET enabled=0 WHERE id=?").run(teamsChannel);
 assert.equal(await restartApprovals.approvedRevisionCurrent(teamsRequest.id,teamsRoute.approvalRevisionHash),false);
 assert.equal((await restartApprovals.findById(teamsRequest.id)).status,'approved');
 const recovered=new ChannelDecisionRepository(manager.getDatabase());assert.equal((await recovered.get(route.id)).claimId,claimed.claimId);await assert.rejects(recovered.claim(callback));
 await recovered.finish(route.id,claimed.claimId,'delivery_unknown');assert.equal((await recovered.get(route.id)).outcome,'delivery_unknown');assert.equal(new ApprovalStore(manager.getDatabase()).findById(approval.id).status,'pending');
 console.log(JSON.stringify({disposableProfile:true,upgradePreservesApprovalAndBot:true,legacyTeamsReferenceTableCreated:true,legacyInputPreserved:true,builtDatabaseAndRepository:true,hostAndWorker:true,workerUnitCalls,childOriginBound:true,deadlineFromApproval:true,publicationClaimFenced:true,wrongActorDenied:true,changedRequestDenied:true,singleUseCallback:true,restartPreservesClaim:true,transportLeavesApprovalPending:true,atomicApprovalResolution:true,oppositeResponseCannotOverwrite:true,atomicChannelGuard:true,revokedChannelDeniedAfterClaim:true,teamsPendingDecisionRestartResolution:true,teamsDuplicateAfterRestartDenied:true,teamsReferenceWorkerParity:true,teamsReferenceRestartRecovery:true,teamsReferenceChangedConfigDenied:true,approvedFileConsumptionWorkerGuard:true,inlineWorkerRevisionGuard:true,inlineBindingRestartRefusesReplay:true,inputResponseSingleWinner:true,channelWinnerConsumptionAuthority:true,channelWinnerRestartRevocationDenied:true,trustedWorkerDraftCapture:true,changedFileDeniedBeforeClick:true,changedFileDeniedAfterClaim:true,serviceOwnerAuthorization:true,serviceCallbackResolution:true,syntheticCards,serviceResponses,modelExecution:false,channelDelivery:false,actionExecution:false}));
} finally {await client?.close(2000);setStatementClient(null,null,null);manager?.close();await fs.rm(directory,{recursive:true,force:true});}

// Imported daemon modules retain maintenance timers. This disposable process
// exits only after the assertions and successful database/profile cleanup.
process.exit(0);
