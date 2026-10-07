import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  BotResponsibilityDefinition,
  BotResponsibilityScope,
} from "../../../shared/bot-responsibility";
import { AgentRoleStore } from "../../agents/AgentRoleRepository";
import { RoutineService } from "../../routines/service";
import { DatabaseManager } from "../../database/schema";
import { WorkspaceStore, TaskStore } from "../../database/repositories";
import { serviceStatements } from "../../database/service-statements";
import {
  BotResponsibilityStore,
  readResponsibilityTaskChannelInstances,
  resolveResponsibilityHistoryChannel,
} from "../responsibility-store";
import {
  assertResponsibilityTaskPolicy,
  fileResponsibilityOperation,
} from "../responsibility-task-policy";

const CHANNEL_TYPE = "slack";
const CHAT_ID = "chat-123";
const SIGNAL_JOB_ID = "fixture-job";

describe("responsibility cached history instance binding", () => {
  let dir: string;
  let manager: DatabaseManager;
  let db: Database.Database;
  let scope: BotResponsibilityScope;
  let engine: string;
  let definition: BotResponsibilityDefinition;
  let routines: RoutineService;
  let responsibilities: BotResponsibilityStore;
  let tasks: TaskStore;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-responsibility-history-"));
    manager = new DatabaseManager({ dbPath: path.join(dir, "fixture.db") });
    db = manager.getDatabase();
    const workspace = new WorkspaceStore(db).create("Fixture", dir, {
      read: true,
      write: true,
      delete: false,
      shell: false,
      network: false,
    });
    const bot = new AgentRoleStore(db).create({
      name: "private",
      displayName: "Private",
      description: "Fixture",
      capabilities: [],
      systemPrompt: "Private",
    });
    scope = { workspaceId: workspace.id, agentRoleId: bot.id };
    routines = new RoutineService({
      db,
      getCronService: () => null,
      getEventTriggerService: () => null,
      loadHooksSettings: () => ({
        enabled: false,
        token: "fixture",
        path: "/hooks",
        maxBodyBytes: 1024,
        presets: [],
        mappings: [],
      }),
      saveHooksSettings: () => undefined,
      createTask: () => undefined,
    });
    engine = (
      await routines.create({
        name: "Fixture",
        workspaceId: workspace.id,
        enabled: false,
        prompt: "Inspect cached channel history",
        connectors: [],
        triggers: [{ id: "manual", type: "manual", enabled: true }],
      })
    ).id;
    // Expose the same engine to the scheduled-source resolver without starting a scheduler.
    db.prepare("UPDATE automation_routines SET triggers_json=? WHERE id=?").run(
      JSON.stringify([
        {
          id: "schedule",
          type: "schedule",
          enabled: true,
          managedCronJobId: SIGNAL_JOB_ID,
        },
      ]),
      engine,
    );
    definition = {
      objective: "Inspect cached history",
      engine: { kind: "routine", id: engine },
      mode: "observe",
      sources: [
        { connectorId: `gateway:${CHANNEL_TYPE}`, method: "channel_history", resourceId: CHAT_ID },
        { connectorId: "workspace_files", method: "read_file", resourceId: "evidence.md" },
      ],
      permittedActions: [],
      expectedOutput: "Summary",
      reviewBoundary: "all_effects",
      destination: { channel: "internal", id: "results" },
      backend: "node",
      budget: { maxTokens: 1000, maxCost: 0 },
    };
    responsibilities = new BotResponsibilityStore(db);
    tasks = new TaskStore(db);
    addChannel("channel-a");
  });

  afterEach(async () => {
    await routines.stopWorkflowRuntime();
    manager.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function addChannel(id: string, enabled = true): void {
    db.prepare(
      `INSERT INTO channels
        (id,type,name,enabled,config,security_config,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?, ?,?)`,
    ).run(
      id,
      CHANNEL_TYPE,
      id,
      enabled ? 1 : 0,
      "{}",
      '{"mode":"open"}',
      "disconnected",
      Date.now(),
      Date.now(),
    );
  }

  function addMessage(channelId: string, id = "message-a"): void {
    db.prepare(
      `INSERT INTO channel_messages
        (id,channel_id,channel_message_id,chat_id,direction,content,attachments,timestamp)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(id, channelId, `remote-${id}`, CHAT_ID, "incoming", `cached ${id}`, null, Date.now());
  }

  function bind(): string {
    const binding = responsibilities.create(scope, definition, Date.now());
    db.prepare("UPDATE bot_responsibilities SET state='active' WHERE id=?").run(binding.id);
    return binding.id;
  }

  function createTask(governed: boolean) {
    return tasks.create({
      title: "History read",
      prompt: "Inspect selected cached history",
      status: "pending",
      workspaceId: scope.workspaceId,
      agentConfig: governed ? { automationRoutineId: engine } : {},
      budgetTokens: 2000,
      budgetCost: 2,
    });
  }

  function read(taskId: string, channelId = "channel-a") {
    return serviceStatements(db).unit("botResponsibility_readChannelHistory", [
      taskId,
      CHANNEL_TYPE,
      channelId,
      CHAT_ID,
      null,
      "both",
      50,
      "node",
    ]);
  }

  it("samples and reads cache from the same unique enabled configured instance", async () => {
    addMessage("channel-a");
    bind();
    const task = createTask(true);
    expect(resolveResponsibilityHistoryChannel(db, CHANNEL_TYPE)).toEqual({
      kind: "enabled",
      id: "channel-a",
    });
    expect(responsibilities.signalContext(SIGNAL_JOB_ID, true)?.history).toEqual([
      expect.objectContaining({ hasSignal: true }),
    ]);
    await expect(read(task.id)).resolves.toEqual([expect.objectContaining({ id: "message-a" })]);
  });

  it("fails closed on an enabled row plus a disabled duplicate for source samples and reads", async () => {
    addMessage("channel-a");
    bind();
    const task = createTask(true);
    addChannel("channel-disabled", false);
    expect(resolveResponsibilityHistoryChannel(db, CHANNEL_TYPE)).toEqual({ kind: "ambiguous" });
    expect(() => responsibilities.signalContext(SIGNAL_JOB_ID, true)).toThrow("ambiguous");
    await expect(read(task.id)).rejects.toThrow("ambiguous");
  });

  it("rejects a disabled singleton and a host-resolved instance replaced before the worker read", async () => {
    addMessage("channel-a");
    bind();
    const task = createTask(true);
    const originalFingerprint = responsibilities.signalContext(SIGNAL_JOB_ID, true)?.history[0]
      ?.fingerprint;

    db.prepare("UPDATE channels SET enabled=0 WHERE id=?").run("channel-a");
    expect(() => responsibilities.signalContext(SIGNAL_JOB_ID, true)).toThrow("not enabled");
    await expect(read(task.id)).rejects.toThrow("not enabled");

    db.prepare("DELETE FROM channel_messages WHERE channel_id=?").run("channel-a");
    db.prepare("DELETE FROM channels WHERE id=?").run("channel-a");
    addChannel("channel-replacement");
    addMessage("channel-replacement");
    const replacementFingerprint = responsibilities.signalContext(SIGNAL_JOB_ID, true)?.history[0]
      ?.fingerprint;
    expect(replacementFingerprint).not.toBe(originalFingerprint);
    await expect(read(task.id, "channel-replacement")).rejects.toThrow(
      "changed since task admission",
    );
  });

  it("persists an instance receipt for a child and carries the same pin through its lineage", async () => {
    addMessage("channel-a");
    bind();
    const parent = createTask(true);
    const child = tasks.create({
      title: "Child history read",
      prompt: "Inspect the inherited source",
      status: "pending",
      workspaceId: scope.workspaceId,
      parentTaskId: parent.id,
      agentConfig: {},
      budgetTokens: 1000,
      budgetCost: 1,
    });
    expect(readResponsibilityTaskChannelInstances(db, parent.id)).toEqual([
      { channelType: CHANNEL_TYPE, channelId: "channel-a" },
    ]);
    expect(readResponsibilityTaskChannelInstances(db, child.id)).toEqual([
      { channelType: CHANNEL_TYPE, channelId: "channel-a" },
    ]);
    await expect(read(child.id)).resolves.toEqual([expect.objectContaining({ id: "message-a" })]);

    db.prepare("DELETE FROM channel_messages WHERE channel_id=?").run("channel-a");
    db.prepare("DELETE FROM channels WHERE id=?").run("channel-a");
    addChannel("channel-replacement");
    addMessage("channel-replacement");
    await expect(read(child.id, "channel-replacement")).rejects.toThrow(
      "changed since task admission",
    );
  });

  it("rejects child admission after its inherited channel instance has been replaced", () => {
    addMessage("channel-a");
    bind();
    const parent = createTask(true);
    db.prepare("DELETE FROM channel_messages WHERE channel_id=?").run("channel-a");
    db.prepare("DELETE FROM channels WHERE id=?").run("channel-a");
    addChannel("channel-replacement");

    expect(() =>
      tasks.create({
        title: "Child history read",
        prompt: "Inspect the inherited source",
        status: "pending",
        workspaceId: scope.workspaceId,
        parentTaskId: parent.id,
        agentConfig: {},
        budgetTokens: 1000,
        budgetCost: 1,
      }),
    ).toThrow("channel instance receipt is unavailable or changed");
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE parent_task_id=?").get(parent.id),
    ).toEqual({ count: 0 });
  });

  it("fails governed channel reads closed when a legacy run has no instance receipt", async () => {
    addMessage("channel-a");
    bind();
    const task = createTask(true);
    db.prepare("DELETE FROM bot_responsibility_run_channel_instances WHERE task_id=?").run(task.id);
    db.exec("DROP TABLE bot_responsibility_run_channel_instances");
    await routines.stopWorkflowRuntime();
    manager.close();

    manager = new DatabaseManager({ dbPath: path.join(dir, "fixture.db") });
    db = manager.getDatabase();
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='bot_responsibility_run_channel_instances'",
        )
        .get(),
    ).toBeDefined();
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM bot_responsibility_run_channel_instances").get(),
    ).toEqual({ count: 0 });

    await expect(read(task.id)).rejects.toThrow("instance receipt is unavailable");
    expect(() =>
      assertResponsibilityTaskPolicy(
        db,
        task.id,
        scope.workspaceId,
        fileResponsibilityOperation("read_file", { path: "evidence.md" }, dir),
      ),
    ).not.toThrow();
  });

  it("preserves ordinary history reads while using the already-resolved channel id", async () => {
    addMessage("channel-a");
    addChannel("channel-disabled", false);
    const task = createTask(false);
    await expect(read(task.id)).resolves.toEqual([expect.objectContaining({ id: "message-a" })]);
  });
});
