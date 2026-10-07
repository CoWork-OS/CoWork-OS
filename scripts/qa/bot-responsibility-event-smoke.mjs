/** Compiled Node event admission with disposable SQLite/cache; no model or delivery. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { DatabaseManager } = require("../../dist/daemon/electron/database/schema.js");
const {
  TaskStore,
  WorkspaceStore,
} = require("../../dist/daemon/electron/database/repositories.js");
const { AgentRoleStore } = require("../../dist/daemon/electron/agents/AgentRoleRepository.js");
const { RoutineService } = require("../../dist/daemon/electron/routines/service.js");
const {
  EventTriggerService,
} = require("../../dist/daemon/electron/triggers/EventTriggerService.js");
const {
  BotResponsibilityService,
} = require("../../dist/daemon/electron/automation/BotResponsibilityService.js");
const {
  SchedulerLeaseStore,
} = require("../../dist/daemon/electron/automation/scheduler-lease-store.js");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-event-smoke-"));
let manager, triggers, routines;
try {
  manager = new DatabaseManager({ dbPath: path.join(dir, "fixture.db") });
  const db = manager.getDatabase();
  const workspace = new WorkspaceStore(db).create("Fixture", dir, {
    read: true,
    write: false,
    delete: false,
    shell: false,
    network: false,
  });
  const bot = new AgentRoleStore(db).create({
    name: "my-private-event-fixture",
    displayName: "Private",
    description: "Fixture",
    systemPrompt: "Keep private bot instructions",
    capabilities: [],
  });
  const scope = { workspaceId: workspace.id, agentRoleId: bot.id };
  db.prepare(
    "INSERT INTO channels(id,type,name,enabled,config,security_config,created_at,updated_at) VALUES('history','slack','Fixture',1,'{}','{}',0,0)",
  ).run();
  const createTask = async (input) => ({
    id: new TaskStore(db).create({ ...input, status: "queued" }).id,
  });
  const start = async () => {
    triggers = new EventTriggerService(
      { createTask, getDefaultWorkspaceId: () => workspace.id },
      db,
    );
    await triggers.start();
  };
  await start();
  routines = new RoutineService({
    db,
    getCronService: () => null,
    getEventTriggerService: () => triggers,
    loadHooksSettings: () => ({
      enabled: false,
      token: "fixture",
      path: "/hooks",
      maxBodyBytes: 1024,
      presets: [],
      mappings: [],
    }),
    saveHooksSettings: () => {},
    createTask,
  });
  const lease = new SchedulerLeaseStore(db);
  const fence = lease.acquire({ owner: "fixture", now: Date.now(), leaseMs: 60000 });
  const service = new BotResponsibilityService(db, {
    runtime: () => "node",
    getRoutineService: () => routines,
    assertOwnership: async () => {},
    getSchedulerFence: () => fence,
  });
  const engine = await routines.create({
    name: "Selected chat",
    enabled: false,
    workspaceId: workspace.id,
    prompt: "Inspect selected sources",
    connectors: [],
    triggers: [
      {
        id: "channel",
        type: "channel_event",
        enabled: true,
        channelType: "slack",
        chatId: "selected-chat",
        cooldownMs: 0,
      },
    ],
  });
  const saved = await service.create({
    scope,
    definition: {
      objective: "Inspect selected chat",
      engine: { kind: "routine", id: engine.id },
      mode: "observe",
      sources: [
        { connectorId: "gateway:slack", method: "channel_history", resourceId: "selected-chat" },
      ],
      permittedActions: [],
      expectedOutput: "Internal report",
      reviewBoundary: "all_effects",
      destination: { channel: "internal", id: "results" },
      backend: "node",
      budget: { maxCost: 0, maxTokens: 1000 },
    },
  });
  await service.activate({
    scope,
    id: saved.id,
    expectedRevision: saved.revision,
    expectedControlVersion: saved.controlVersion,
  });
  let eventTimestamp = Date.now();
  const event = () => ({
    source: "channel_message",
    timestamp: eventTimestamp++,
    fields: {
      channelType: "slack",
      channelInstanceId: "history",
      chatId: "selected-chat",
      text: "UNTRUSTED EVENT INSTRUCTIONS",
      senderName: "Fixture",
    },
  });
  const count = () => db.prepare("SELECT COUNT(*) AS count FROM tasks").get().count;
  await triggers.evaluateEvent(event());
  assert.equal(count(), 0);
  db.prepare(
    "INSERT INTO channel_messages(id,channel_id,channel_message_id,chat_id,direction,content,timestamp) VALUES('m1','history','message','selected-chat','incoming','A',1)",
  ).run();
  const cachedEvent = event();
  await Promise.all([
    triggers.evaluateEvent(cachedEvent),
    triggers.evaluateEvent(cachedEvent),
  ]);
  assert.equal(count(), 1);
  await triggers.stop();
  await start();
  await triggers.evaluateEvent(event());
  assert.equal(count(), 1);
  db.prepare("UPDATE channel_messages SET content='B' WHERE id='m1'").run();
  await triggers.evaluateEvent(event());
  assert.equal(count(), 2);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM bot_responsibility_signal_runs").get().count,
    2,
  );
  assert.equal(
    new AgentRoleStore(db).findById(bot.id).systemPrompt,
    "Keep private bot instructions",
  );
  for (const row of db.prepare("SELECT prompt,agent_config FROM tasks").all()) {
    assert(!row.prompt.includes("UNTRUSTED EVENT INSTRUCTIONS"));
    assert(!row.prompt.includes("{{event."));
    assert.equal(JSON.parse(row.agent_config).responsibilitySignal, undefined);
  }
  console.log(
    JSON.stringify({
      fixture: true,
      compiledNodeEventAdmission: true,
      emptySourceQuiet: true,
      concurrentReplayTasks: 1,
      replayAfterServiceRestartTasks: 1,
      changedSourceTasks: 2,
      privateBotPreserved: true,
      modelExecution: false,
      channelDelivery: false,
    }),
  );
} finally {
  await routines?.stopWorkflowRuntime();
  await triggers?.stop();
  manager?.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
