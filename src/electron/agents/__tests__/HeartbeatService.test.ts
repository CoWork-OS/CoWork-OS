/**
 * Tests for HeartbeatService
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type {
  AgentRole,
  HeartbeatEvent,
  AgentMention,
  Task,
  Activity,
} from "../../../shared/types";
import { HeartbeatService, type HeartbeatServiceDeps } from "../HeartbeatService";

// Mock electron to avoid getPath errors
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/tmp/test-cowork"),
  },
}));

// In-memory mock storage
let mockAgents: Map<string, AgentRole>;
let mockMentions: Map<string, AgentMention>;
let mockTasks: Map<string, Task>;
let heartbeatEvents: HeartbeatEvent[];
let createdTasks: Task[];

// Helper to create test agent
function createAgent(id: string, options: Partial<AgentRole> = {}): AgentRole {
  const agent: AgentRole = {
    id,
    name: `agent-${id}`,
    displayName: `Agent ${id}`,
    description: "Test agent",
    icon: "🤖",
    color: "#6366f1",
    capabilities: ["code"],
    isSystem: false,
    isActive: true,
    sortOrder: 100,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    heartbeatEnabled: false,
    heartbeatIntervalMinutes: 15,
    heartbeatStaggerOffset: 0,
    heartbeatStatus: "idle",
    lastHeartbeatAt: Date.now(),
    ...options,
  };
  mockAgents.set(id, agent);
  return agent;
}

// Helper to create test mention
function createMention(
  id: string,
  agentId: string,
  isPending: boolean = true,
  workspaceId: string = "workspace-1",
): AgentMention {
  const mention: AgentMention = {
    id,
    agentRoleId: agentId,
    mentionType: "direct",
    sourceType: "message",
    sourceId: "msg-1",
    workspaceId,
    status: isPending ? "pending" : "acknowledged",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  mockMentions.set(id, mention);
  return mention;
}

// Helper to create test task
function createTask(id: string, agentId?: string): Task {
  const task: Task = {
    id,
    title: `Task ${id}`,
    prompt: "Test prompt",
    status: "pending",
    workspaceId: "workspace-1",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    assignedAgentRoleId: agentId,
  };
  mockTasks.set(id, task);
  return task;
}

describe("HeartbeatService", () => {
  let service: HeartbeatService;
  let deps: HeartbeatServiceDeps;
  let taskIdCounter: number;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

    mockAgents = new Map();
    mockMentions = new Map();
    mockTasks = new Map();
    heartbeatEvents = [];
    createdTasks = [];
    taskIdCounter = 0;

    deps = {
      agentRoleRepo: {
        findById: (id: string) => mockAgents.get(id),
        findHeartbeatEnabled: () => {
          const results: AgentRole[] = [];
          mockAgents.forEach((agent) => {
            if (agent.heartbeatEnabled && agent.isActive) {
              results.push(agent);
            }
          });
          return results;
        },
        findAll: (includeInactive: boolean) => {
          const results: AgentRole[] = [];
          mockAgents.forEach((agent) => {
            if (includeInactive || agent.isActive) {
              results.push(agent);
            }
          });
          return results;
        },
        updateHeartbeatStatus: (id: string, status: string, lastHeartbeatAt?: number) => {
          const agent = mockAgents.get(id);
          if (agent) {
            agent.heartbeatStatus = status as Any;
            if (lastHeartbeatAt) {
              agent.lastHeartbeatAt = lastHeartbeatAt;
            }
          }
        },
      } as HeartbeatServiceDeps["agentRoleRepo"],
      mentionRepo: {
        getPendingForAgent: (agentId: string) => {
          const results: AgentMention[] = [];
          mockMentions.forEach((mention) => {
            if (mention.agentRoleId === agentId && mention.status === "pending") {
              results.push(mention);
            }
          });
          return results;
        },
      } as HeartbeatServiceDeps["mentionRepo"],
      activityRepo: {
        getRecent: () => [] as Activity[],
      } as HeartbeatServiceDeps["activityRepo"],
      workingStateRepo: {
        getByAgent: () => undefined,
      } as HeartbeatServiceDeps["workingStateRepo"],
      createTask: async (
        workspaceId: string,
        prompt: string,
        title: string,
        agentRoleId?: string,
      ) => {
        const task: Task = {
          id: `task-${++taskIdCounter}`,
          title,
          prompt,
          status: "pending",
          workspaceId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          assignedAgentRoleId: agentRoleId,
        };
        createdTasks.push(task);
        return task;
      },
      getTasksForAgent: (agentRoleId: string) => {
        const results: Task[] = [];
        mockTasks.forEach((task) => {
          if (task.assignedAgentRoleId === agentRoleId) {
            results.push(task);
          }
        });
        return results;
      },
      getDefaultWorkspaceId: () => "workspace-1",
      getDefaultWorkspacePath: () => "/tmp/default-workspace",
      getWorkspacePath: (workspaceId: string) => {
        if (workspaceId === "workspace-1") {
          return "/tmp/workspace-1";
        }
        if (workspaceId === "workspace-2") {
          return "/tmp/workspace-2";
        }
        return undefined;
      },
    };

    service = new HeartbeatService(deps);
    service.on("heartbeat", (event) => heartbeatEvents.push(event));
  });

  afterEach(async () => {
    await service.stop();
    vi.useRealTimers();
  });

  describe("start", () => {
    it("should schedule heartbeats for enabled agents", async () => {
      createAgent("agent-1", { heartbeatEnabled: true });
      createAgent("agent-2", { heartbeatEnabled: true });
      createAgent("agent-3", { heartbeatEnabled: false });

      await service.start();

      expect(vi.getTimerCount()).toBe(2);
    });

    it("should not schedule inactive agents", async () => {
      createAgent("agent-1", { heartbeatEnabled: true, isActive: false });

      await service.start();

      expect(vi.getTimerCount()).toBe(0);
    });

    it("should not start twice", async () => {
      createAgent("agent-1", { heartbeatEnabled: true });

      await service.start();
      await service.start();

      expect(vi.getTimerCount()).toBe(1);
    });
  });

  describe("stop", () => {
    it("should clear all timers", async () => {
      createAgent("agent-1", { heartbeatEnabled: true });
      createAgent("agent-2", { heartbeatEnabled: true });

      await service.start();
      await service.stop();

      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("triggerHeartbeat", () => {
    it("should execute heartbeat for valid agent", async () => {
      createAgent("agent-1", { heartbeatEnabled: true });

      const result = await service.triggerHeartbeat("agent-1");

      expect(result.agentRoleId).toBe("agent-1");
      expect(result.status).toBe("ok");
      expect(result.pendingMentions).toBe(0);
      expect(result.assignedTasks).toBe(0);
    });

    it("should return error for non-existent agent", async () => {
      const result = await service.triggerHeartbeat("non-existent");

      expect(result.status).toBe("error");
      expect(result.error).toBe("Agent role not found");
    });

    it("should find pending mentions", async () => {
      createAgent("agent-1", { heartbeatEnabled: true });
      createMention("mention-1", "agent-1", true);
      createMention("mention-2", "agent-1", true);

      const result = await service.triggerHeartbeat("agent-1");

      expect(result.pendingMentions).toBe(2);
      expect(result.status).toBe("work_done");
    });

    it("should find assigned tasks", async () => {
      createAgent("agent-1", { heartbeatEnabled: true });
      createTask("task-1", "agent-1");
      createTask("task-2", "agent-1");

      const result = await service.triggerHeartbeat("agent-1");

      expect(result.assignedTasks).toBe(2);
      expect(result.status).toBe("work_done");
    });

    it("selects workspace from pending mentions for role-profile context", async () => {
      createAgent("agent-1", { heartbeatEnabled: true });
      createMention("mention-1", "agent-1", true, "workspace-2");

      const result = await service.triggerHeartbeat("agent-1");

      expect(result.status).toBe("work_done");
      expect(createdTasks).toHaveLength(1);
      expect(createdTasks[0].workspaceId).toBe("workspace-2");
    });

    it("ignores blank workspace IDs when selecting workspace context", async () => {
      createAgent("agent-1", { heartbeatEnabled: true });
      createMention("mention-1", "agent-1", true, "   ");

      const result = await service.triggerHeartbeat("agent-1");

      expect(result.status).toBe("work_done");
      expect(createdTasks).toHaveLength(1);
      expect(createdTasks[0].workspaceId).toBe("workspace-1");
    });

    it("falls back to default workspace if top candidate workspace no longer exists", async () => {
      createAgent("agent-1", { heartbeatEnabled: true });
      createMention("mention-1", "agent-1", true, "workspace-2");

      deps.getWorkspacePath = (workspaceId: string) => {
        if (workspaceId === "workspace-1") {
          return "/tmp/workspace-1";
        }
        return undefined;
      };

      const result = await service.triggerHeartbeat("agent-1");

      expect(result.status).toBe("work_done");
      expect(createdTasks).toHaveLength(1);
      expect(createdTasks[0].workspaceId).toBe("workspace-1");
    });

    it("prefers mentions over assigned tasks when workspace timestamps are tied", async () => {
      const now = Date.now();

      createAgent("agent-1", { heartbeatEnabled: true });
      createMention("mention-1", "agent-1", true, "workspace-1");
      createTask("task-1", "agent-1");

      const mention = mockMentions.get("mention-1");
      if (mention) {
        mention.createdAt = now;
        mention.updatedAt = now;
      }

      const task = mockTasks.get("task-1");
      if (task) {
        task.updatedAt = now;
        task.workspaceId = "workspace-2";
      }

      await service.triggerHeartbeat("agent-1");

      expect(createdTasks[0].workspaceId).toBe("workspace-1");
    });

    it("skips empty workspace path values from candidates", async () => {
      createAgent("agent-1", { heartbeatEnabled: true });
      createMention("mention-1", "agent-1", true, "workspace-2");

      deps.getWorkspacePath = (workspaceId: string) => {
        if (workspaceId === "workspace-1") {
          return "/tmp/workspace-1";
        }
        if (workspaceId === "workspace-2") {
          return "   ";
        }
        return undefined;
      };

      const result = await service.triggerHeartbeat("agent-1");

      expect(result.status).toBe("work_done");
      expect(createdTasks).toHaveLength(1);
      expect(createdTasks[0].workspaceId).toBe("workspace-1");
    });

    it("should create task when work is found", async () => {
      createAgent("agent-1", { heartbeatEnabled: true });
      createMention("mention-1", "agent-1", true);

      const result = await service.triggerHeartbeat("agent-1");

      expect(result.taskCreated).toBeDefined();
      expect(createdTasks).toHaveLength(1);
      expect(createdTasks[0].assignedAgentRoleId).toBe("agent-1");
    });

    it("should emit heartbeat events", async () => {
      createAgent("agent-1", { heartbeatEnabled: true });

      await service.triggerHeartbeat("agent-1");

      const eventTypes = heartbeatEvents.map((e) => e.type);
      expect(eventTypes).toContain("started");
      expect(eventTypes).toContain("no_work");
      expect(eventTypes).toContain("completed");
    });

    it("should emit work_found event when work exists", async () => {
      createAgent("agent-1", { heartbeatEnabled: true });
      createMention("mention-1", "agent-1", true);

      await service.triggerHeartbeat("agent-1");

      const eventTypes = heartbeatEvents.map((e) => e.type);
      expect(eventTypes).toContain("work_found");
    });

    it("should update heartbeat status", async () => {
      createAgent("agent-1", { heartbeatEnabled: true });

      await service.triggerHeartbeat("agent-1");

      const agent = mockAgents.get("agent-1");
      expect(agent?.heartbeatStatus).toBe("sleeping");
      expect(agent?.lastHeartbeatAt).toBeDefined();
    });
  });

  describe("cancelHeartbeat", () => {
    it("should cancel scheduled heartbeat", async () => {
      createAgent("agent-1", { heartbeatEnabled: true });

      await service.start();
      expect(vi.getTimerCount()).toBe(1);

      service.cancelHeartbeat("agent-1");
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("getAllStatus", () => {
    it("should return status for all agents", async () => {
      createAgent("agent-1", { heartbeatEnabled: true });
      createAgent("agent-2", { heartbeatEnabled: false });

      const statuses = service.getAllStatus();

      expect(statuses).toHaveLength(2);
      expect(statuses.find((s) => s.agentRoleId === "agent-1")?.heartbeatEnabled).toBe(true);
      expect(statuses.find((s) => s.agentRoleId === "agent-2")?.heartbeatEnabled).toBe(false);
    });
  });

  describe("getStatus", () => {
    it("should return status for specific agent", async () => {
      createAgent("agent-1", { heartbeatEnabled: true, heartbeatStatus: "idle" });

      const status = service.getStatus("agent-1");

      expect(status).toBeDefined();
      expect(status?.heartbeatEnabled).toBe(true);
      expect(status?.heartbeatStatus).toBe("idle");
      expect(status?.isRunning).toBe(false);
    });

    it("should return undefined for non-existent agent", () => {
      const status = service.getStatus("non-existent");

      expect(status).toBeUndefined();
    });
  });

  describe("concurrent execution", () => {
    it("should prevent concurrent heartbeat execution", async () => {
      createAgent("agent-1", { heartbeatEnabled: true });
      createMention("mention-1", "agent-1", true);

      let resolveTask: ((task: Task) => void) | undefined;
      deps.createTask = vi.fn().mockImplementation(
        () =>
          new Promise<Task>((resolve) => {
            resolveTask = resolve;
          }),
      );

      const firstCall = service.triggerHeartbeat("agent-1");
      const secondCall = service.triggerHeartbeat("agent-1");

      await expect(secondCall).resolves.toMatchObject({
        status: "error",
        error: "Heartbeat already running",
      });

      resolveTask?.({
        id: "task-1",
        title: "Heartbeat: Agent agent-1",
        prompt: "Test prompt",
        status: "pending",
        workspaceId: "workspace-1",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        assignedAgentRoleId: "agent-1",
      });

      await expect(firstCall).resolves.toMatchObject({ status: "work_done" });
    });
  });

  describe("scheduled execution", () => {
    it("should execute heartbeat after interval", async () => {
      createAgent("agent-1", {
        heartbeatEnabled: true,
        heartbeatIntervalMinutes: 15,
        lastHeartbeatAt: Date.now(),
      });

      await service.start();

      await vi.advanceTimersByTimeAsync(15 * 60 * 1000);

      expect(
        heartbeatEvents.some((e) => e.agentRoleId === "agent-1" && e.type === "completed"),
      ).toBe(true);
    });
  });
});
