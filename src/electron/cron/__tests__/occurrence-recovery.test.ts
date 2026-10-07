import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DatabaseManager } from "../../database/schema";
import { TaskStore, WorkspaceStore } from "../../database/repositories";
import { CronService } from "../service";
import { saveCronStore } from "../store";

// Represents process exit after SQLite task commit but before cron's lastTaskId checkpoint.
describe("cron exact occurrence crash recovery", () => {
  it("recovers a completed task beyond sidebar pagination after database reopen", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-cron-occurrence-"));
    const dbPath = path.join(dir, "fixture.db");
    let manager = new DatabaseManager({ dbPath });
    let cron: CronService | undefined;
    try {
      const ws = new WorkspaceStore(manager.getDatabase()).create("Fixture", dir, {
        read: true,
        write: false,
        delete: false,
        shell: false,
        network: false,
      });
      const tasks = new TaskStore(manager.getDatabase());
      const committed = tasks.create({
        title: "Private schedule",
        prompt: "Fixture",
        workspaceId: ws.id,
        source: "cron",
        status: "completed",
        agentConfig: { scheduledJobId: "job", scheduledRunAtMs: 1000 },
      });
      // Same job, other run; same run, another job; enough unrelated tasks to hide the target in a 50-row scan.
      tasks.create({
        title: "Other run",
        prompt: "Fixture",
        workspaceId: ws.id,
        source: "cron",
        status: "completed",
        agentConfig: { scheduledJobId: "job", scheduledRunAtMs: 999 },
      });
      for (let n = 0; n < 60; n++)
        tasks.create({
          title: `Other ${n}`,
          prompt: "Fixture",
          workspaceId: ws.id,
          status: "completed",
        });
      const storePath = path.join(dir, "cron.json");
      await saveCronStore(storePath, {
        version: 1,
        jobs: [
          {
            id: "job",
            name: "Private schedule",
            enabled: false,
            createdAtMs: 1,
            updatedAtMs: 1,
            workspaceId: ws.id,
            taskPrompt: "Fixture",
            schedule: { kind: "every", everyMs: 60000 },
            state: { runningAtMs: 1000, runningRunMode: "new_task", runHistory: [] },
          },
        ],
      });
      manager.close();
      manager = new DatabaseManager({ dbPath });
      const reopened = new TaskStore(manager.getDatabase());
      const createTask = vi.fn();
      const deps = {
        storePath,
        cronEnabled: true,
        nowMs: () => 2000,
        createTask,
        findTaskForRun: async ({
          workspaceId,
          jobId,
          runAtMs,
        }: {
          workspaceId: string;
          jobId: string;
          runAtMs: number;
        }) => reopened.findByScheduledRun(workspaceId, jobId, runAtMs),
        getTaskStatus: async (id: string) => reopened.findById(id) ?? null,
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      };
      cron = new CronService(deps);
      await cron.start();
      expect((await cron.get("job"))?.state).toMatchObject({
        lastTaskId: committed.id,
        lastStatus: "ok",
        totalRuns: 1,
      });
      await cron.stop();
      cron = new CronService(deps);
      await cron.start();
      expect((await cron.get("job"))?.state.runHistory).toHaveLength(1);
      expect(createTask).not.toHaveBeenCalled();
      // Multiple exact candidates are ambiguous; never choose an arbitrary task.
      reopened.create({
        title: "Duplicate",
        prompt: "Fixture",
        workspaceId: ws.id,
        source: "cron",
        status: "completed",
        agentConfig: { scheduledJobId: "job", scheduledRunAtMs: 1000 },
      });
      expect(reopened.findByScheduledRun(ws.id, "job", 1000)).toBeNull();
      expect(reopened.findByScheduledRun("other-workspace", "job", 1000)).toBeNull();
    } finally {
      await cron?.stop();
      manager.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
