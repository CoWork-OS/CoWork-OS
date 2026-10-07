import { SchedulerOwnership } from "../SchedulerOwnership";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseManager } from "../../database/schema";
import { WorkspaceStore, TaskStore } from "../../database/repositories";
import { AgentRoleStore } from "../../agents/AgentRoleRepository";
import { AutomationRuntime } from "../AutomationRuntime";
import { createHeadlessBotAutomation } from "../headless-bot-services";
import type { AgentDaemon } from "../../agent/daemon";
import type { ChannelGateway } from "../../gateway";
import { EventEmitter } from "node:events";
import type { MCPClientManager } from "../../mcp/client/MCPClientManager";
vi.mock("electron", () => ({ app: { getPath: () => "/tmp/cowork-headless-fixture" } }));
vi.mock("../../hooks/settings", () => ({
  HooksSettingsManager: {
    loadSettings: () => ({
      enabled: false,
      token: "",
      path: "/hooks",
      maxBodyBytes: 1000,
      presets: [],
      mappings: [],
    }),
    saveSettings: vi.fn(),
  },
}));
describe("headless bot service bootstrap", () => {
  let directory: string;
  let manager: DatabaseManager;
  let runtime: AutomationRuntime;
  let services: ReturnType<typeof createHeadlessBotAutomation>;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-bot-runtime-"));
    vi.stubEnv("COWORK_USER_DATA_DIR", directory);
    manager = new DatabaseManager({ dbPath: path.join(directory, "fixture.db") });
  });
  afterEach(async () => {
    await services?.stop();
    await runtime?.shutdown();
    manager.close();
    vi.unstubAllEnvs();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  it("starts the actual persistent engines without seeding bots or running work, and drains them", async () => {
    const db = manager.getDatabase();
    const workspace = new WorkspaceStore(db).create("Fixture", directory, {
      read: true,
      write: false,
      delete: false,
      shell: false,
      network: false,
    });
    const role = new AgentRoleStore(db).create({
      name: "personal-fixture-731",
      displayName: "My private helper",
      systemPrompt: "Keep my exact instructions",
      heartbeatEnabled: false,
      capabilities: [],
      description: "Fixture bot",
      icon: "A",
    });
    new AgentRoleStore(db).update({ id: role.id, isActive: false });
    expect(new AgentRoleStore(db).findById(role.id)?.isActive).toBe(false);
    const before = db.prepare("SELECT * FROM agent_roles WHERE id = ?").get(role.id);
    runtime = new AutomationRuntime("node");
    runtime.attachOwnership(new SchedulerOwnership(db));
    const createTask = vi.fn(async (params) => new TaskStore(db).create(params));
    let gatewayEvent: Parameters<ChannelGateway["onEvent"]>[0] | undefined;
    const gateway = {
      onEvent: (handler: Parameters<ChannelGateway["onEvent"]>[0]) => {
        gatewayEvent = handler;
      },
      sendMessage: vi.fn(),
    };
    const connectors = Object.assign(new EventEmitter(), {
      syncTriggerResourceSubscriptions: vi.fn().mockResolvedValue(undefined),
    });
    services = createHeadlessBotAutomation({
      db,
      runtime,
      agentDaemon: {
        createTask,
        getWorkspaceById: (id) => (id === workspace.id ? workspace : undefined),
        getQueueStatus: () => ({ runningTaskIds: [] }),
      } as unknown as AgentDaemon,
      channelGateway: gateway as unknown as ChannelGateway,
      getCronService: () => null,
      mcpClientManager: connectors as unknown as MCPClientManager,
      log: vi.fn(),
    });
    await services.start();
    expect(createTask).not.toHaveBeenCalled();
    expect(gateway.sendMessage).not.toHaveBeenCalled();
    expect(db.prepare("SELECT * FROM agent_roles WHERE id = ?").get(role.id)).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS count FROM agent_roles").get()).toEqual({ count: 1 });
    expect(
      runtime
        .snapshot()
        .producers.filter((p) => ["heartbeat", "event_triggers", "routines"].includes(p.id))
        .every((p) => p.state === "running"),
    ).toBe(true);
    const fixtureTrigger = await services.triggers.addTrigger({
      name: "Private fixture event",
      enabled: true,
      source: "channel_message",
      conditions: [{ field: "text", operator: "equals", value: "fixture-only" }],
      action: { type: "create_task", config: { prompt: "Fixture task" } },
      workspaceId: workspace.id,
    });
    gatewayEvent?.({
      type: "message:received",
      channel: "slack",
      timestamp: new Date(),
      data: { text: "fixture-only", chatId: "synthetic", channelId: "fixture-channel" },
    } as Parameters<NonNullable<typeof gatewayEvent>>[0]);
    await services.triggers.drainPendingEvents();
    expect(createTask).toHaveBeenCalledOnce();
    expect(createTask.mock.calls[0][0]).toMatchObject({
      workspaceId: workspace.id,
      prompt: "Fixture task",
      source: "hook",
    });
    const persistedEvent = db
      .prepare("SELECT event_json FROM event_trigger_occurrences WHERE trigger_id=?")
      .get(fixtureTrigger.id) as { event_json: string };
    expect(JSON.parse(persistedEvent.event_json).fields.channelInstanceId).toBe("fixture-channel");
    await services.stop();
    expect(connectors.listenerCount("connector_event")).toBe(0);
    gatewayEvent?.({
      type: "message:received",
      channel: "slack",
      data: { text: "fixture-only" },
    } as Parameters<NonNullable<typeof gatewayEvent>>[0]);
    await services.triggers.drainPendingEvents();
    expect(createTask).toHaveBeenCalledOnce();
  });
});
