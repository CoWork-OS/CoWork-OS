/**
 * Tests for HeartbeatService
 */

import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type {
  AgentRole,
  HeartbeatEvent,
  AgentMention,
  Task,
  Activity,
  ProactiveSuggestion,
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
let createdSuggestions: ProactiveSuggestion[];
let notifications: Array<Record<string, unknown>>;
let capturedMemories: Array<{
  workspaceId: string;
  taskId: string | undefined;
  type: string;
  content: string;
  isPrivate?: boolean;
  options?: {
    origin?: string;
    batchKey?: string;
    signalFamily?: string;
    priority?: string;
  };
}>;
let tmpDir: string;
let workspacePaths: Map<string, string>;

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

function writeHeartbeatChecklist(workspaceId: string, content: string): void {
  const workspacePath = workspacePaths.get(workspaceId);
  if (!workspacePath) {
    throw new Error(`Unknown workspace ${workspaceId}`);
  }
  fs.mkdirSync(path.join(workspacePath, ".cowork"), { recursive: true });
  fs.writeFileSync(path.join(workspacePath, ".cowork", "HEARTBEAT.md"), content, "utf8");
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
    createdSuggestions = [];
    notifications = [];
    capturedMemories = [];
    taskIdCounter = 0;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-heartbeat-"));
    process.env.COWORK_USER_DATA_DIR = path.join(tmpDir, "user-data");
    workspacePaths = new Map([
      ["workspace-1", path.join(tmpDir, "workspace-1")],
      ["workspace-2", path.join(tmpDir, "workspace-2")],
    ]);
    for (const workspacePath of workspacePaths.values()) {
      fs.mkdirSync(workspacePath, { recursive: true });
    }

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
        list: () => [] as Activity[],
      } as HeartbeatServiceDeps["activityRepo"],
      workingStateRepo: {
        getByAgent: () => undefined,
      } as HeartbeatServiceDeps["workingStateRepo"],
      createTask: async (
        workspaceId: string,
        prompt: string,
        title: string,
        agentRoleId?: string,
        options?: {
          source?: Task["source"];
          agentConfig?: Task["agentConfig"];
        },
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
          agentConfig: options?.agentConfig,
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
      getDefaultWorkspacePath: () => workspacePaths.get("workspace-1"),
      getWorkspacePath: (workspaceId: string) => {
        return workspacePaths.get(workspaceId);
      },
      hasActiveForegroundTask: () => false,
      listWorkspaceContexts: () =>
        Array.from(workspacePaths.entries()).map(([workspaceId, workspacePath]) => ({
          workspaceId,
          workspacePath,
        })),
      getMemoryFeaturesSettings: () => ({
        contextPackInjectionEnabled: true,
        heartbeatMaintenanceEnabled: true,
      }),
      getAwarenessSummary: () => null,
      listActiveSuggestions: () => createdSuggestions,
      createCompanionSuggestion: async (workspaceId, suggestion) => {
        const created: ProactiveSuggestion = {
          id: `suggestion-${createdSuggestions.length + 1}`,
          type: suggestion.type || "insight",
          title: suggestion.title,
          description: suggestion.description,
          actionPrompt: suggestion.actionPrompt,
          sourceTaskId: suggestion.sourceTaskId,
          sourceEntity: suggestion.sourceEntity,
          confidence: suggestion.confidence,
          suggestionClass: suggestion.suggestionClass,
          urgency: suggestion.urgency,
          learningSignalIds: suggestion.learningSignalIds,
          workspaceScope: suggestion.workspaceScope,
          sourceSignals: suggestion.sourceSignals,
          recommendedDelivery: suggestion.recommendedDelivery,
          companionStyle: suggestion.companionStyle,
          createdAt: Date.now(),
          expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
          dismissed: false,
          actedOn: false,
        };
        createdSuggestions.push(created);
        return created;
      },
      addNotification: async (params) => {
        notifications.push(params);
      },
      captureMemory: async (workspaceId, taskId, type, content, isPrivate, options) => {
        capturedMemories.push({ workspaceId, taskId, type, content, isPrivate, options });
      },
    };

    service = new HeartbeatService(deps);
    service.on("heartbeat", (event) => heartbeatEvents.push(event));
  });

  afterEach(async () => {
    await service.stop();
    delete process.env.COWORK_USER_DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
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

    it("creates heartbeat work from awareness signals without mentions or assigned tasks", async () => {
      createAgent("agent-1", { heartbeatEnabled: true });
      deps.getAwarenessSummary = () => ({
        generatedAt: Date.now(),
        workspaceId: "workspace-1",
        currentFocus: "VS Code — launch-checklist.md",
        whatChanged: [],
        whatMattersNow: [
          {
            id: "focus-1",
            title: "Editing launch-checklist.md",
            detail: "Recent focus shifted into release prep.",
            source: "apps",
            score: 0.82,
            tags: ["focus", "context"],
            requiresHeartbeat: true,
          },
        ],
        dueSoon: [
          {
            id: "due-1",
            title: "Launch checklist review",
            detail: "Due in 2 hours",
            source: "tasks",
            score: 0.95,
            tags: ["due_soon"],
            requiresHeartbeat: true,
          },
        ],
        beliefs: [],
        wakeReasons: ["focus_shift", "deadline_risk"],
      });
      service = new HeartbeatService(deps);
      service.on("heartbeat", (event) => heartbeatEvents.push(event));

      const result = await service.triggerHeartbeat("agent-1");

      expect(result.status).toBe("work_done");
      expect(result.outputType).toBe("status_digest");
      expect(createdTasks).toHaveLength(1);
      expect(createdTasks[0].prompt).toContain("Awareness Signals");
      expect(createdTasks[0].prompt).toContain("Due Soon");
    });

    it("tags heartbeat companion memory captures with source metadata", async () => {
      createAgent("agent-1", { heartbeatEnabled: true });
      deps.getAwarenessSummary = () => ({
        generatedAt: Date.now(),
        workspaceId: "workspace-1",
        currentFocus: "Release prep",
        whatChanged: [],
        whatMattersNow: [],
        dueSoon: [
          {
            id: "due-heartbeat",
            title: "Release review",
            detail: "Follow up on the release checklist.",
            source: "tasks",
            score: 0.95,
            tags: ["due_soon"],
            requiresHeartbeat: false,
          },
        ],
        beliefs: [],
        wakeReasons: ["deadline_risk"],
      });
      service = new HeartbeatService(deps);
      service.on("heartbeat", (event) => heartbeatEvents.push(event));

      await service.triggerHeartbeat("agent-1");

      expect(capturedMemories).toHaveLength(1);
      expect(capturedMemories[0]?.options).toMatchObject({
        origin: "heartbeat",
        signalFamily: "urgent_interrupt",
      });
      expect(String(capturedMemories[0]?.options?.batchKey || "")).toContain("heartbeat:workspace-1");
    });

    it("stays silent when only weak passive signals exist", async () => {
      createAgent("agent-1", { heartbeatEnabled: true });
      deps.getAwarenessSummary = () => ({
        generatedAt: Date.now(),
        workspaceId: "workspace-1",
        currentFocus: "",
        whatChanged: [],
        whatMattersNow: [],
        dueSoon: [],
        beliefs: [],
        wakeReasons: [],
      });
      service = new HeartbeatService(deps);
      service.on("heartbeat", (event) => heartbeatEvents.push(event));

      const result = await service.triggerHeartbeat("agent-1");

      expect(result.status).toBe("ok");
      expect(result.decisionMode).toBe("silent");
      expect(createdTasks).toHaveLength(0);
      expect(createdSuggestions).toHaveLength(0);
    });

    it("creates an inbox suggestion for repeated cross-workspace pressure", async () => {
      createAgent("agent-1", { heartbeatEnabled: true });
      deps.getAwarenessSummary = (workspaceId?: string) => ({
        generatedAt: Date.now(),
        workspaceId: workspaceId || "workspace-1",
        currentFocus: "",
        whatChanged: [],
        whatMattersNow: [
          {
            id: `priority-${workspaceId}`,
            title: `Priority in ${workspaceId}`,
            detail: "Competing attention detected.",
            source: "tasks",
            score: 0.7,
            tags: ["priority"],
            requiresHeartbeat: false,
          },
        ],
        dueSoon: [],
        beliefs: [],
        wakeReasons: ["focus_shift"],
      });
      service = new HeartbeatService(deps);
      service.on("heartbeat", (event) => heartbeatEvents.push(event));

      const result = await service.triggerHeartbeat("agent-1");

      expect(result.status).toBe("work_done");
      expect(result.decisionMode).toBe("inbox_suggestion");
      expect(result.workspaceScope).toBe("all");
      expect(createdTasks).toHaveLength(0);
      expect(createdSuggestions).toHaveLength(1);
      expect(notifications).toHaveLength(1);
      expect(notifications[0]?.type).toBe("companion_suggestion");
    });

    it("creates a low-risk follow-up task when open-loop pressure is high", async () => {
      createAgent("agent-1", { heartbeatEnabled: true, autonomyLevel: "lead" });
      deps.getAwarenessSummary = () => ({
        generatedAt: Date.now(),
        workspaceId: "workspace-1",
        currentFocus: "VS Code",
        whatChanged: [],
        whatMattersNow: [],
        dueSoon: [],
        beliefs: [],
        wakeReasons: [],
      });
      deps.getAutonomyState = () => ({
        goals: [],
        openLoops: [
          { id: "loop-1", title: "Follow up QA" },
          { id: "loop-2", title: "Review docs" },
          { id: "loop-3", title: "Triage build" },
        ],
      });
      deps.getAutonomyDecisions = () => [
        {
          id: "decision-1",
          title: "Consolidate blockers",
          description: "Several work items need a single owner.",
          status: "suggested",
          priority: "high",
        },
      ] as Any[];
      service = new HeartbeatService(deps);
      service.on("heartbeat", (event) => heartbeatEvents.push(event));

      const result = await service.triggerHeartbeat("agent-1");

      expect(result.status).toBe("work_done");
      expect(result.decisionMode).toBe("task_creation");
      expect(result.signalFamily).toBe("open_loop_pressure");
      expect(createdTasks).toHaveLength(1);
    });

    it("nudges only for high-confidence urgent states", async () => {
      createAgent("agent-1", { heartbeatEnabled: true });
      deps.getAwarenessSummary = () => ({
        generatedAt: Date.now(),
        workspaceId: "workspace-1",
        currentFocus: "Calendar",
        whatChanged: [],
        whatMattersNow: [],
        dueSoon: [
          {
            id: "due-urgent",
            title: "Production incident follow-up",
            detail: "Due in 15 minutes",
            source: "tasks",
            score: 0.96,
            tags: ["due_soon"],
            requiresHeartbeat: false,
          },
        ],
        beliefs: [],
        wakeReasons: ["deadline_risk"],
      });
      service = new HeartbeatService(deps);
      service.on("heartbeat", (event) => heartbeatEvents.push(event));

      const result = await service.triggerHeartbeat("agent-1");

      expect(result.status).toBe("work_done");
      expect(result.decisionMode).toBe("nudge");
      expect(createdTasks).toHaveLength(0);
      expect(createdSuggestions).toHaveLength(1);
      expect(notifications).toHaveLength(1);
      expect(notifications[0]?.recommendedDelivery).toBe("nudge");
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

    it("does not create a task for passive next-heartbeat wake requests alone", async () => {
      createAgent("agent-1", { heartbeatEnabled: true });

      service.submitWakeRequest("agent-1", {
        mode: "next-heartbeat",
        source: "hook",
        text: "Git state changed in workspace-1",
      });

      const result = await service.triggerHeartbeat("agent-1");

      expect(result.status).toBe("ok");
      expect(createdTasks).toHaveLength(0);
    });

    it("creates a task for explicit immediate wake requests", async () => {
      createAgent("agent-1", { heartbeatEnabled: true });

      service.submitWakeRequest("agent-1", {
        mode: "now",
        source: "manual",
        text: "Check this now",
      });

      await vi.advanceTimersByTimeAsync(10_000);

      expect(createdTasks).toHaveLength(1);
      expect(createdTasks[0]?.title).toBe("Heartbeat: Agent agent-1");
    });

    it("suppresses scheduled heartbeat task creation while a foreground task is active", async () => {
      createAgent("agent-1", {
        heartbeatEnabled: true,
        autonomyLevel: "lead",
      });
      writeHeartbeatChecklist("workspace-1", "# Recurring Checks\n\n## Daily\n- Review blockers\n");
      deps.hasActiveForegroundTask = () => true;

      const result = await service.triggerHeartbeat("agent-1");

      expect(result.status).toBe("ok");
      expect(result.silent).toBe(true);
      expect(createdTasks).toHaveLength(0);
    });

    it("still allows manual immediate wake requests while a foreground task is active", async () => {
      createAgent("agent-1", { heartbeatEnabled: true });
      deps.hasActiveForegroundTask = () => true;

      service.submitWakeRequest("agent-1", {
        mode: "now",
        source: "manual",
        text: "Check this now",
      });

      await vi.advanceTimersByTimeAsync(10_000);

      expect(createdTasks).toHaveLength(1);
      expect(createdTasks[0]?.title).toBe("Heartbeat: Agent agent-1");
    });

    it("respects proactive task frequencyMinutes and does not run every heartbeat", async () => {
      createAgent("agent-1", {
        heartbeatEnabled: true,
        soul: JSON.stringify({
          cognitiveOffload: {
            proactiveTasks: [
              {
                id: "proactive-1",
                name: "Inbox check",
                description: "Check inbox for urgent updates",
                category: "routine-automation",
                promptTemplate: "Check inbox and summarize urgent items.",
                frequencyMinutes: 60,
                priority: 1,
                enabled: true,
              },
            ],
          },
        }),
      });

      const first = await service.triggerHeartbeat("agent-1");
      expect(first.status).toBe("work_done");
      expect(createdTasks).toHaveLength(1);
      expect(createdTasks[0].prompt).toContain("## Proactive Tasks");

      const second = await service.triggerHeartbeat("agent-1");
      expect(second.status).toBe("ok");
      expect(createdTasks).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

      const third = await service.triggerHeartbeat("agent-1");
      expect(third.status).toBe("work_done");
      expect(createdTasks).toHaveLength(2);
    });

    it("runs maintenance heartbeats for lead agents with HEARTBEAT.md even without mentions", async () => {
      createAgent("agent-1", {
        heartbeatEnabled: true,
        autonomyLevel: "lead",
      });
      writeHeartbeatChecklist(
        "workspace-1",
        "# Recurring Checks\n\n## Daily\n- Check git status for drift\n- Review open loops\n",
      );

      const result = await service.triggerHeartbeat("agent-1");

      expect(result.status).toBe("work_done");
      expect(result.maintenanceChecks).toBe(2);
      expect(result.maintenanceWorkspaceId).toBe("workspace-1");
      expect(createdTasks).toHaveLength(1);
      expect(createdTasks[0].prompt).toContain("## HEARTBEAT.md Recurring Checks");
      expect(createdTasks[0].prompt).toContain("Check git status for drift");
    });

    it("applies founder-edge autonomy policy from agent soul to heartbeat-dispatched work", async () => {
      createAgent("agent-1", {
        heartbeatEnabled: true,
        autonomyLevel: "lead",
        soul: JSON.stringify({
          autonomyPolicy: {
            preset: "founder_edge",
            autoApproveTypes: ["run_command"],
            pauseForRequiredDecision: false,
          },
        }),
      });
      writeHeartbeatChecklist("workspace-1", "# Recurring Checks\n\n## Daily\n- Review blockers\n");

      const result = await service.triggerHeartbeat("agent-1");

      expect(result.status).toBe("work_done");
      expect(createdTasks).toHaveLength(1);
      expect(createdTasks[0].agentConfig?.autonomousMode).toBe(true);
      expect(createdTasks[0].agentConfig?.allowUserInput).toBe(false);
      expect(createdTasks[0].agentConfig?.autoApproveTypes).toEqual(["run_command"]);
      expect(createdTasks[0].agentConfig?.pauseForRequiredDecision).toBe(false);
    });

    it("does not run HEARTBEAT.md maintenance for non-lead agents", async () => {
      createAgent("agent-1", {
        heartbeatEnabled: true,
        autonomyLevel: "specialist",
      });
      writeHeartbeatChecklist("workspace-1", "# Recurring Checks\n\n## Daily\n- Review blockers\n");

      const result = await service.triggerHeartbeat("agent-1");

      expect(result.status).toBe("ok");
      expect(result.maintenanceChecks).toBe(0);
      expect(createdTasks).toHaveLength(0);
    });

    it("persists proactive cadence across service restarts", async () => {
      createAgent("agent-persist", {
        heartbeatEnabled: true,
        soul: JSON.stringify({
          cognitiveOffload: {
            proactiveTasks: [
              {
                id: "proactive-persist-1",
                name: "Inbox check",
                description: "Check inbox for urgent updates",
                category: "routine-automation",
                promptTemplate: "Check inbox and summarize urgent items.",
                frequencyMinutes: 60,
                priority: 1,
                enabled: true,
              },
            ],
          },
        }),
      });

      const first = await service.triggerHeartbeat("agent-persist");
      expect(first.status).toBe("work_done");
      expect(createdTasks).toHaveLength(1);

      await service.stop();
      heartbeatEvents = [];
      createdTasks = [];
      service = new HeartbeatService(deps);
      service.on("heartbeat", (event) => heartbeatEvents.push(event));

      const second = await service.triggerHeartbeat("agent-persist");
      expect(second.status).toBe("ok");
      expect(createdTasks).toHaveLength(0);
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

    it("reschedules from updated heartbeat state instead of running again immediately", async () => {
      createAgent("agent-1", {
        heartbeatEnabled: true,
        heartbeatIntervalMinutes: 15,
        lastHeartbeatAt: Date.now() - 60 * 60 * 1000,
      });

      await service.start();

      await vi.runOnlyPendingTimersAsync();

      const completed = heartbeatEvents.filter(
        (event) => event.agentRoleId === "agent-1" && event.type === "completed",
      );
      expect(completed).toHaveLength(1);

      heartbeatEvents.length = 0;
      await vi.advanceTimersByTimeAsync(14 * 60 * 1000);
      expect(
        heartbeatEvents.some((event) => event.agentRoleId === "agent-1" && event.type === "completed"),
      ).toBe(false);

      await vi.advanceTimersByTimeAsync(60 * 1000);
      expect(
        heartbeatEvents.some((event) => event.agentRoleId === "agent-1" && event.type === "completed"),
      ).toBe(true);
    });
  });
});
