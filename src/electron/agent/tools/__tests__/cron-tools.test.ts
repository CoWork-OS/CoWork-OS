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
    } as Any;
  };

  const createService = (resolveWorkspaceContext?: Any) =>
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

  it("inherits the active task access profile into a newly scheduled job", async () => {
    const daemon = {
      ...makeDaemonStub(),
      getTask: vi.fn(() => ({
        agentConfig: { accessProfileId: "ask_for_approval" },
      })),
    } as Any;
    const workspace: Workspace = {
      id: "ws-profile",
      name: "Profile Workspace",
      path: "/tmp/profile-workspace",
      createdAt: 0,
      permissions: { read: true, write: true, delete: false, network: true, shell: true },
    };

    const tools = new CronTools(workspace, daemon, "task-profile");
    const result = await tools.createJob({
      name: "Profile-aware follow-up",
      prompt: "Continue with the same access boundary.",
      schedule: { type: "interval", every: "1h" },
    });

    expect(result.success).toBe(true);
    expect(result.job?.accessProfileId).toBe("ask_for_approval");
    expect(result.job?.taskAgentConfig).toBeUndefined();
  });

  it("creates current-thread jobs as thread follow-ups", async () => {
    const daemon = makeDaemonStub();
    const workspaceId = "ws-5678";
    const workspace: Workspace = {
      id: workspaceId,
      name: "My Workspace",
      path: "/tmp/my-workspace",
      createdAt: 0,
      permissions: { read: true, write: true, delete: false, network: true, shell: false },
    };

    const tools = new CronTools(workspace, daemon, "task-current");
    const result = await tools.createJob({
      name: "Follow Up Here",
      prompt: "Return to this conversation and check progress.",
      target: "current_thread",
      schedule: { type: "interval", every: "1h" },
    });

    expect(result.success).toBe(true);
    expect(result.job).toMatchObject({
      runMode: "thread_follow_up",
      targetTaskId: "task-current",
      threadAutomation: {
        sourceTaskId: "task-current",
        wakeObjective: "Return to this conversation and check progress.",
        includeContextBrief: true,
      },
    });
  });

  it("offers and accepts only supported delivery channel types", async () => {
    const scheduleTool = CronTools.getToolDefinitions().find(
      (tool) => tool.name === "schedule_task",
    );
    const schema = scheduleTool?.input_schema as Any;
    const createEnum: string[] = schema.properties.delivery.properties.channelType.enum;
    const updateEnum: string[] =
      schema.properties.updates.properties.delivery.properties.channelType.enum;
    for (const offered of [createEnum, updateEnum]) {
      expect(offered).toContain("telegram");
      expect(offered).not.toContain("x");
      expect(offered).not.toContain("twitch");
    }

    const workspace: Workspace = {
      id: "ws-delivery",
      name: "Delivery Workspace",
      path: "/tmp/delivery-workspace",
      createdAt: 0,
      permissions: { read: true, write: true, delete: false, network: true, shell: false },
    };
    const tools = new CronTools(workspace, makeDaemonStub(), "task-delivery");

    const rejected = await tools.createJob({
      name: "Post to X",
      prompt: "Share the summary",
      schedule: { type: "interval", every: "1h" },
      delivery: { enabled: true, channelType: "x", channelId: "@me" },
    });
    expect(rejected).toEqual({ success: false, error: "Unsupported delivery channel type: x" });
    expect(await service.list({ includeDisabled: true })).toHaveLength(0);

    const created = await tools.createJob({
      name: "Post to Telegram",
      prompt: "Share the summary",
      schedule: { type: "interval", every: "1h" },
      delivery: { enabled: true, channelType: "telegram", channelId: "123" },
    });
    expect(created.success).toBe(true);

    const updated = await tools.updateJob({
      id: created.job!.id,
      updates: { delivery: { enabled: true, channelType: "twitch", channelId: "#chan" } },
    });
    expect(updated).toEqual({
      success: false,
      error: "Unsupported delivery channel type: twitch",
    });
    expect((await service.get(created.job!.id))?.delivery?.channelType).toBe("telegram");
  });
});
