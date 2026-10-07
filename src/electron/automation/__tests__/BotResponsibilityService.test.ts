import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseManager } from "../../database/schema";
import { WorkspaceStore } from "../../database/repositories";
import { AgentRoleStore } from "../../agents/AgentRoleRepository";
import { BotResponsibilityService } from "../BotResponsibilityService";
import { RoutineService } from "../../routines/service";
import type {
  BotResponsibilityDefinition,
  BotResponsibilityScope,
} from "../../../shared/bot-responsibility";
const definition = (id: string): BotResponsibilityDefinition => ({
  objective: "Inspect evidence",
  engine: { kind: "routine", id },
  mode: "observe",
  sources: [],
  permittedActions: [],
  expectedOutput: "Internal report",
  reviewBoundary: "all_effects",
  destination: { channel: "internal", id: "results" },
  backend: "node",
  budget: { maxTokens: 1000, maxCost: 1 },
});
describe("shared responsibility preview and editing", () => {
  let directory: string;
  let manager: DatabaseManager;
  let scope: BotResponsibilityScope;
  let routines: RoutineService;
  let service: BotResponsibilityService;
  let nextSchedule: ReturnType<typeof vi.fn>;
  let createTask: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-responsibility-preview-"));
    manager = new DatabaseManager({ dbPath: path.join(directory, "fixture.db") });
    const db = manager.getDatabase();
    const workspace = new WorkspaceStore(db).create("Fixture", directory, {
      read: true,
      write: false,
      delete: false,
      shell: false,
      network: false,
    });
    const bot = new AgentRoleStore(db).create({
      name: "private",
      displayName: "Private",
      description: "Custom",
      systemPrompt: "Custom",
      capabilities: [],
    });
    scope = { workspaceId: workspace.id, agentRoleId: bot.id };
    createTask = vi.fn();
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
      saveHooksSettings: vi.fn(),
      createTask,
    });
    nextSchedule = vi.fn().mockResolvedValue(12345);
    service = new BotResponsibilityService(db, {
      now: () => 10000,
      runtime: () => "node",
      nextSchedule,
    });
  });
  afterEach(async () => {
    await routines.stopWorkflowRuntime();
    manager.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const routine = () =>
    routines.create({
      name: "Manual",
      enabled: false,
      workspaceId: scope.workspaceId,
      prompt: "Fixture",
      connectors: [],
      triggers: [{ id: "manual", type: "manual", enabled: true }],
    });
  it("previews without writing definitions, creating work or enabling its engine", async () => {
    const engine = await routine();
    const before = manager
      .getDatabase()
      .prepare("SELECT * FROM automation_routines WHERE id = ?")
      .get(engine.id);
    const preview = await service.preview({ scope, definition: definition(engine.id) });
    expect(preview).toMatchObject({
      triggerSummary: ["On demand"],
      executionState: "paused",
      activationAvailable: false,
      backendPresence: "present",
      schedulePreviewState: "event_or_manual",
    });
    expect(await service.list(scope)).toEqual([]);
    expect(createTask).not.toHaveBeenCalled();
    expect(nextSchedule).not.toHaveBeenCalled();
    expect(
      manager
        .getDatabase()
        .prepare("SELECT * FROM automation_routines WHERE id = ?")
        .get(engine.id),
    ).toEqual(before);
  });
  it("calculates the preview from the saved schedule, not client-supplied timing", async () => {
    const engine = await routine();
    manager
      .getDatabase()
      .prepare("UPDATE automation_routines SET triggers_json = ? WHERE id = ?")
      .run(
        JSON.stringify([
          {
            id: "schedule",
            type: "schedule",
            enabled: true,
            schedule: { kind: "every", everyMs: 60000, anchorMs: 10000 },
          },
        ]),
        engine.id,
      );
    const preview = await service.preview({ scope, definition: definition(engine.id) });
    expect(preview).toMatchObject({
      nextRunIfEnabledAt: 12345,
      schedulePreviewState: "calculated",
      executionState: "paused",
    });
    expect(nextSchedule).toHaveBeenCalledWith(
      { kind: "every", everyMs: 60000, anchorMs: 10000 },
      10000,
    );
    await expect(
      service.preview({ scope, definition: definition(engine.id), nextRunAt: 1 }),
    ).rejects.toThrow();
    expect(await service.list(scope)).toEqual([]);
  });
  it("reports unavailable timing and desktop absence without inventing a wake", async () => {
    const engine = await routine();
    manager
      .getDatabase()
      .prepare("UPDATE automation_routines SET triggers_json = ? WHERE id = ?")
      .run(
        JSON.stringify([{ type: "schedule", schedule: { kind: "cron", expr: "0 9 * * *" } }]),
        engine.id,
      );
    nextSchedule.mockRejectedValue(new Error("timeout"));
    const preview = await service.preview({
      scope,
      definition: { ...definition(engine.id), backend: "desktop" },
    });
    expect(preview).toMatchObject({
      schedulePreviewState: "unavailable",
      backendPresence: "requires_desktop",
    });
    expect(preview.nextRunIfEnabledAt).toBeUndefined();
  });
  it("saves independent paused definitions and edits only the expected revision", async () => {
    const first = await routine();
    const second = await routine();
    const saved = await service.create({ scope, definition: definition(first.id) });
    await service.create({ scope, definition: definition(second.id) });
    const revised = await service.revise({
      scope,
      id: saved.id,
      expectedRevision: 1,
      definition: {
        ...definition(first.id),
        mode: "propose",
        objective: "Prepare a reviewed draft",
      },
    });
    expect(revised).toMatchObject({ id: saved.id, revision: 2, state: "paused" });
    expect(await service.list(scope)).toHaveLength(2);
    expect(createTask).not.toHaveBeenCalled();
    await expect(
      service.revise({
        scope,
        id: saved.id,
        expectedRevision: 1,
        definition: definition(first.id),
      }),
    ).rejects.toThrow("revision changed");
  });
  it("excludes foreign-workspace and other-bot bound engines from the choices", async () => {
    const own = await routine();
    const other = new AgentRoleStore(manager.getDatabase()).create({
      name: "other",
      displayName: "Other",
      description: "Custom",
      systemPrompt: "Other",
      capabilities: [],
    });
    await service.create({
      scope: { ...scope, agentRoleId: other.id },
      definition: definition(own.id),
    });
    expect(await service.engines(scope)).toEqual([]);
    await expect(service.preview({ scope, definition: definition(own.id) })).rejects.toThrow(
      "belongs to another bot",
    );
    const foreign = new WorkspaceStore(manager.getDatabase()).create(
      "Foreign",
      path.join(directory, "foreign"),
      { read: true, write: false, delete: false, shell: false, network: false },
    );
    expect(await service.engines({ ...scope, workspaceId: foreign.id })).toEqual([]);
    await expect(
      service.preview({
        scope: { ...scope, workspaceId: foreign.id },
        definition: definition(own.id),
      }),
    ).rejects.toThrow("outside the selected workspace");
  });
});
