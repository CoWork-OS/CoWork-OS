import * as fs from "node:fs";
import os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CronService, setCronService } from "../../../cron";
import { CronTools } from "../cron-tools";
import { TEMP_WORKSPACE_ID, type Workspace } from "../../../../shared/types";

describe("CronTools.schedule_create workspace behavior", () => {
  let tmpUserDataDir: string;
  let service: CronService;

  const makeDaemonStub = () => {
    return {
      logEvent: vi.fn(),
      createWorkspace: vi.fn(),
    } as any;
  };

  const createService = (resolveWorkspaceContext?: any) =>
    new CronService({
      cronEnabled: true,
      storePath: path.join(tmpUserDataDir, "cron", "jobs.json"),
      createTask: async () => ({ id: "task-123" }),
      resolveWorkspaceContext,
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      nowMs: () => 1000,
    });

  beforeEach(async () => {
    tmpUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-cron-tools-test-"));
    service = createService();
    setCronService(service);
    await service.start();
  });

  afterEach(async () => {
    setCronService(null);
    await service.stop();
    try {
      fs.rmSync(tmpUserDataDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  });

  it("delegates temp-workspace normalization to CronService", async () => {
    await service.stop();
    service = createService(async ({ phase }: { phase: "add" | "run" }) => {
      if (phase === "add") {
        return { workspaceId: "managed-scheduled-workspace" };
      }
      return null;
    });
    setCronService(service);
    await service.start();

    const daemon = makeDaemonStub();
    const tempWorkspace: Workspace = {
      id: TEMP_WORKSPACE_ID,
      name: "Temporary Workspace",
      path: path.join(os.tmpdir(), "cowork-os-temp"),
      createdAt: 0,
      permissions: {
        read: true,
        write: true,
        delete: true,
        network: true,
        shell: false,
        unrestrictedFileAccess: true,
      },
      isTemp: true,
    };

    const tools = new CronTools(tempWorkspace, daemon, "task-1");
    const result = await tools.createJob({
      name: "Daily Briefing",
      prompt: "/brief",
      schedule: { type: "interval", every: "1h" },
    });

    expect(result.success).toBe(true);
    expect(result.job?.workspaceId).toBe("managed-scheduled-workspace");
    expect(daemon.createWorkspace).not.toHaveBeenCalled();
  });

  it("uses the active workspace ID when no resolver override is returned", async () => {
    const daemon = makeDaemonStub();
    const workspaceId = "ws-1234";
    const normalWorkspace: Workspace = {
      id: workspaceId,
      name: "My Workspace",
      path: "/tmp/my-workspace",
      createdAt: 0,
      permissions: { read: true, write: true, delete: false, network: true, shell: false },
    };

    const tools = new CronTools(normalWorkspace, daemon, "task-2");
    const result = await tools.createJob({
      name: "Ping",
      prompt: "Say hello",
      schedule: { type: "interval", every: "1h" },
    });

    expect(result.success).toBe(true);
    expect(result.job?.workspaceId).toBe(workspaceId);
  });
});
