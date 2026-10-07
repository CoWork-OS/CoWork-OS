import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildPausedResponsibilityRoutine } from "../../../shared/bot-responsibility-routine";
import { DatabaseManager } from "../../database/schema";
import { TaskStore, WorkspaceStore } from "../../database/repositories";
import { AgentRoleStore } from "../../agents/AgentRoleRepository";
import { RoutineService } from "../../routines/service";
import { CronService } from "../../cron/service";
import { BotResponsibilityService } from "../../automation/BotResponsibilityService";

describe("inline responsibility native setup", () => {
  it("creates two independent native routine bindings without starting scheduled work", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-inline-responsibility-"));
    const manager = new DatabaseManager({ dbPath: path.join(dir, "fixture.db") });
    const createTask = vi.fn();
    const cron = new CronService({
      cronEnabled: true,
      storePath: path.join(dir, "cron.json"),
      createTask,
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    try {
      const db = manager.getDatabase();
      const ws = new WorkspaceStore(db).create("Fixture", dir, {
        read: true,
        write: false,
        delete: false,
        shell: false,
        network: false,
      });
      const bot = new AgentRoleStore(db).create({
        name: "my-private-bot",
        displayName: "Mine",
        description: "Custom",
        systemPrompt: "Keep my instructions",
        capabilities: [],
      });
      const selected = { workspaceId: ws.id, agentRoleId: bot.id };
      await cron.start();
      const routines = new RoutineService({
        db,
        getCronService: () => cron,
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
      const service = new BotResponsibilityService(db, {
        runtime: () => "node",
        getRoutineService: () => routines,
        assertOwnership: async () => {},
      });
      const ids: string[] = [];
      for (const timing of ["manual", "daily"] as const) {
        const routine = await routines.create(
          buildPausedResponsibilityRoutine({
            scope: selected,
            name: `My ${timing}`,
            timing,
            timezone: "Europe/Lisbon",
          }),
        );
        expect(routine.enabled).toBe(false);
        const definition = {
          objective: `My ${timing} objective`,
          engine: { kind: "routine", id: routine.id },
          mode: "observe",
          sources: [],
          permittedActions: [],
          expectedOutput: "Summary",
          reviewBoundary: "all_effects",
          destination: { channel: "internal", id: "results" },
          backend: "node",
          budget: { maxTokens: 1000, maxCost: 1 },
        };
        const preview = await service.preview({ scope: selected, definition });
        expect(preview.executionState).toBe("paused");
        const responsibility = await service.create({ scope: selected, definition });
        expect(responsibility.state).toBe("paused");
        ids.push(responsibility.id);
      }
      expect(new Set(ids).size).toBe(2);
      expect((await service.list(selected)).map((r) => r.id).sort()).toEqual(ids.sort());
      const jobs = await cron.list({ includeDisabled: true });
      expect(jobs).toHaveLength(1);
      expect(jobs[0].enabled).toBe(false);
      expect(createTask).not.toHaveBeenCalled();
      expect(new TaskStore(db).findByWorkspace(ws.id)).toEqual([]);
      expect(new AgentRoleStore(db).findById(bot.id)?.systemPrompt).toBe("Keep my instructions");
    } finally {
      await cron.stop();
      manager.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
