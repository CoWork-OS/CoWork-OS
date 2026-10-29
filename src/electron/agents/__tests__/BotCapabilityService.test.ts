import { describe, expect, it, vi } from "vitest";
import type { AgentRole } from "../../../shared/types";
import { BotCapabilityService, type BotCapabilityServiceDeps } from "../BotCapabilityService";

const ROLE = { id: "bot-1", worksOn: "browser" } as AgentRole;

function deps(overrides: Partial<BotCapabilityServiceDeps> = {}): BotCapabilityServiceDeps {
  return {
    findRole: () => ROLE,
    workspaceExists: () => true,
    listBotWork: async (query) => ({
      workspaceId: query.workspaceId,
      agentRoleId: query.agentRoleId,
      view: query.view,
      items: ["weekly", "daily"].map((scheduleId) => ({
        id: scheduleId,
        scheduleId,
        title: scheduleId,
        view: "scheduled" as const,
        status: "scheduled" as const,
        ownership: "assigned" as const,
        conversation: false,
        updatedAt: 0,
        verification: "unverified" as const,
        delivery: "unknown" as const,
      })),
      counts: { needs_you: 0, working: 0, scheduled: 2, results: 0 },
      scheduleAvailability: "available",
      scheduleRuntime: "running",
    }),
    listResponsibilities: async () => [],
    listServices: async () => [],
    listChannels: async () => [],
    mcpSettings: () => ({ prefix: "mcp_", servers: [] }),
    memoryCount: async () => ({ available: true, saved: 4 }),
    recallPastChats: () => true,
    access: () => ({ label: "Ask for approval", approvalInChats: "on-request" }),
    desktopWorkFolder: () => false,
    ...overrides,
  };
}

describe("BotCapabilityService", () => {
  it("validates the request strictly", async () => {
    const service = new BotCapabilityService(deps());
    await expect(service.describe({ workspaceId: "ws-1" })).rejects.toThrow();
    await expect(
      service.describe({ workspaceId: "ws-1", agentRoleId: "bot-1", extra: true }),
    ).rejects.toThrow();
  });

  it("refuses an unknown bot or workspace", async () => {
    await expect(
      new BotCapabilityService(deps({ findRole: () => undefined })).describe({
        workspaceId: "ws-1",
        agentRoleId: "bot-1",
      }),
    ).rejects.toThrow("Bot not found");
    await expect(
      new BotCapabilityService(deps({ workspaceExists: () => false })).describe({
        workspaceId: "ws-1",
        agentRoleId: "bot-1",
      }),
    ).rejects.toThrow("Workspace not found");
  });

  it("asks the bot work view for this bot's scheduled items", async () => {
    const listBotWork = vi.fn(deps().listBotWork);
    const summary = await new BotCapabilityService(deps({ listBotWork })).describe({
      workspaceId: "ws-1",
      agentRoleId: "bot-1",
    });
    expect(listBotWork).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      agentRoleId: "bot-1",
      view: "scheduled",
      limit: 100,
    });
    expect(summary.schedules.scheduled).toBe(2);
    expect(summary.where.worksOn).toBe("browser");
    expect(summary.memory.saved).toBe(4);
    expect(summary.partial).toEqual([]);
  });

  it("keeps the card when one section's read fails", async () => {
    const failing = async () => {
      throw new Error("offline");
    };
    const summary = await new BotCapabilityService(
      deps({
        listServices: failing,
        listResponsibilities: failing,
        memoryCount: failing,
        access: () => {
          throw new Error("settings unreadable");
        },
      }),
    ).describe({ workspaceId: "ws-1", agentRoleId: "bot-1" });
    expect(summary.partial).toEqual(["services", "schedules", "memory", "safeguards"]);
    expect(summary.where.reach.host).toBe(false);
  });

  it("treats a failed channel read as a failed services section", async () => {
    const summary = await new BotCapabilityService(
      deps({
        listChannels: async () => {
          throw new Error("gateway down");
        },
      }),
    ).describe({ workspaceId: "ws-1", agentRoleId: "bot-1" });
    expect(summary.partial).toContain("services");
  });
});
