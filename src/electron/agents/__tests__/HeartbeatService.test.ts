import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentRole,
  AgentMention,
  Activity,
  HeartbeatEvent,
  ProactiveSuggestion,
  Task,
} from "../../../shared/types";
import { HeartbeatService, type HeartbeatServiceDeps } from "../HeartbeatService";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/tmp/test-cowork"),
  },
}));

let mockAgents: Map<string, AgentRole>;
let mockMentions: Map<string, AgentMention>;
let mockTasks: Map<string, Task>;
let createdTasks: Task[];
let taskUpdates: Array<{ taskId: string; updates: Partial<Task> }>;
let createdSuggestions: ProactiveSuggestion[];
let recordedActivities: Array<Record<string, unknown>>;
let heartbeatEvents: HeartbeatEvent[];
let tmpDir: string;
let workspacePaths: Map<string, string>;
let services: HeartbeatService[];

function createAgent(id: string, options: Partial<AgentRole> = {}): AgentRole {
  const agent: AgentRole = {
    id,
    name: `agent-${id}`,
    displayName: `Agent ${id}`,
    description: "Test agent",
    icon: "A",
    color: "#6366f1",
    capabilities: ["code"],
    isSystem: false,
    isActive: true,
    sortOrder: 100,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    heartbeatEnabled: true,
    heartbeatIntervalMinutes: 1,
    pulseEveryMinutes: 1,
    heartbeatStaggerOffset: 0,
    heartbeatStatus: "idle",
    heartbeatProfile: "dispatcher",
    dispatchCooldownMinutes: 60,
    maxDispatchesPerDay: 10,
    ...options,
  };
  mockAgents.set(id, agent);
  return agent;
}

function writeHeartbeatChecklist(workspaceId: string, content: string): void {
  const workspacePath = workspacePaths.get(workspaceId);
  if (!workspacePath) throw new Error(`Unknown workspace ${workspaceId}`);
  fs.mkdirSync(path.join(workspacePath, ".cowork"), { recursive: true });
  fs.writeFileSync(path.join(workspacePath, ".cowork", "HEARTBEAT.md"), content, "utf8");
}

function createService(overrides?: Partial<HeartbeatServiceDeps>): HeartbeatService {
  const deps: HeartbeatServiceDeps = {
    agentRoleRepo: {
      findById: (id: string) => mockAgents.get(id),
      findAll: (includeInactive = false) =>
        Array.from(mockAgents.values()).filter((agent) => includeInactive || agent.isActive),
      findHeartbeatEnabled: () =>
        Array.from(mockAgents.values()).filter((agent) => agent.isActive && agent.heartbeatEnabled),
      updateHeartbeatStatus: (id: string, status: AgentRole["heartbeatStatus"], lastHeartbeatAt?: number) => {
        const agent = mockAgents.get(id);
        if (!agent) return;
        agent.heartbeatStatus = status;
        if (lastHeartbeatAt) agent.lastHeartbeatAt = lastHeartbeatAt;
      },
      updateHeartbeatRunTimestamps: (
        id: string,
        updates: {
          lastPulseAt?: number;
          lastDispatchAt?: number;
          lastHeartbeatAt?: number;
          lastPulseResult?: AgentRole["lastPulseResult"];
          lastDispatchKind?: AgentRole["lastDispatchKind"];
        },
      ) => {
        const agent = mockAgents.get(id);
        if (!agent) return;
        if (updates.lastPulseAt) agent.lastPulseAt = updates.lastPulseAt;
        if (updates.lastDispatchAt) agent.lastDispatchAt = updates.lastDispatchAt;
        if (updates.lastHeartbeatAt) agent.lastHeartbeatAt = updates.lastHeartbeatAt;
        if (updates.lastPulseResult !== undefined) agent.lastPulseResult = updates.lastPulseResult;
        if (updates.lastDispatchKind !== undefined) {
          agent.lastDispatchKind = updates.lastDispatchKind;
        }
      },
    } as HeartbeatServiceDeps["agentRoleRepo"],
    mentionRepo: {
      getPendingForAgent: (agentId: string) =>
        Array.from(mockMentions.values()).filter(
          (mention) => mention.toAgentRoleId === agentId && mention.status === "pending",
        ),
    } as HeartbeatServiceDeps["mentionRepo"],
    activityRepo: {
      list: () => [] as Activity[],
    } as HeartbeatServiceDeps["activityRepo"],
    workingStateRepo: {} as HeartbeatServiceDeps["workingStateRepo"],
    createTask: async (workspaceId, prompt, title, agentRoleId, options) => {
      const task: Task = {
        id: `task-${createdTasks.length + 1}`,
        title,
        prompt,
        status: "pending",
        workspaceId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        assignedAgentRoleId: agentRoleId,
        ...options?.taskOverrides,
      };
      createdTasks.push(task);
      mockTasks.set(task.id, task);
      return task;
    },
    updateTask: (taskId, updates) => {
      taskUpdates.push({ taskId, updates });
      const existing = mockTasks.get(taskId);
      if (existing) mockTasks.set(taskId, { ...existing, ...updates, updatedAt: Date.now() });
    },
    getTasksForAgent: (agentRoleId: string) =>
      Array.from(mockTasks.values()).filter((task) => task.assignedAgentRoleId === agentRoleId),
    getDefaultWorkspaceId: () => "workspace-1",
    getDefaultWorkspacePath: () => workspacePaths.get("workspace-1"),
    getWorkspacePath: (workspaceId: string) => workspacePaths.get(workspaceId),
    hasActiveForegroundTask: () => false,
    listWorkspaceContexts: () =>
      Array.from(workspacePaths.entries()).map(([workspaceId, workspacePath]) => ({
        workspaceId,
        workspacePath,
      })),
    recordActivity: (params) => {
      recordedActivities.push(params);
    },
    createCompanionSuggestion: async (workspaceId, suggestion) => {
      const created: ProactiveSuggestion = {
        id: `suggestion-${createdSuggestions.length + 1}`,
        type: "insight",
        title: suggestion.title,
        description: suggestion.description,
        confidence: suggestion.confidence,
        workspaceId,
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      createdSuggestions.push(created);
      return created;
    },
    addNotification: async () => undefined,
    ...overrides,
  };

  const service = new HeartbeatService(deps);
  service.on("heartbeat", (event) => heartbeatEvents.push(event));
  services.push(service);
  return service;
}

describe("HeartbeatService v3", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T12:00:00Z"));
    mockAgents = new Map();
    mockMentions = new Map();
    mockTasks = new Map();
    createdTasks = [];
    taskUpdates = [];
    createdSuggestions = [];
    recordedActivities = [];
    heartbeatEvents = [];
    services = [];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-heartbeat-v3-"));
    process.env.COWORK_USER_DATA_DIR = path.join(tmpDir, "user-data");
    workspacePaths = new Map([
      ["workspace-1", path.join(tmpDir, "workspace-1")],
      ["workspace-2", path.join(tmpDir, "workspace-2")],
    ]);
    for (const workspacePath of workspacePaths.values()) {
      fs.mkdirSync(workspacePath, { recursive: true });
    }
  });

  afterEach(() => {
    for (const service of services) {
      void service.stop();
    }
    vi.clearAllTimers();
    vi.useRealTimers();
    delete process.env.COWORK_USER_DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("merges repeated identical hook signals into one compressed ledger entry", () => {
    createAgent("agent-1");
    const service = createService();

    service.submitHeartbeatSignal({
      agentRoleId: "agent-1",
      signalFamily: "awareness_signal",
      source: "hook",
      fingerprint: "same-signal",
      reason: "Files changed",
    });
    service.submitHeartbeatSignal({
      agentRoleId: "agent-1",
      signalFamily: "awareness_signal",
      source: "hook",
      fingerprint: "same-signal",
      reason: "Files changed",
    });

    const status = service.getStatus("agent-1");
    expect(status?.compressedSignalCount).toBe(2);
    expect(status?.deferred?.active).toBeUndefined();
    expect(heartbeatEvents.map((event) => event.type)).toContain("signal_merged");
  });

  it("defers and compresses during foreground work instead of creating tasks", async () => {
    createAgent("agent-1");
    const service = createService({
      hasActiveForegroundTask: () => true,
    });

    service.submitHeartbeatSignal({
      agentRoleId: "agent-1",
      signalFamily: "mentions",
      source: "hook",
      fingerprint: "mention-1",
      urgency: "high",
      confidence: 0.9,
      reason: "@agent-1 mentioned in thread",
    });

    await service.start();
    await vi.advanceTimersByTimeAsync(6_000);

    const status = service.getStatus("agent-1");
    expect(createdTasks).toHaveLength(0);
    expect(status?.deferred?.active).toBe(true);
    expect((status?.deferred?.compressedSignalCount || 0) >= 1).toBe(true);
    expect(heartbeatEvents.some((event) => event.type === "pulse_deferred")).toBe(true);
  });

  it("manual immediate wake bypasses defer rules and links created tasks to a heartbeat run", async () => {
    createAgent("agent-1", { heartbeatProfile: "dispatcher" });
    const service = createService({
      hasActiveForegroundTask: () => true,
    });

    const result = await service.triggerHeartbeat("agent-1");

    expect(result.status).toBe("work_done");
    expect(createdTasks).toHaveLength(1);
    expect(createdTasks[0]?.heartbeatRunId).toBeTruthy();
    expect(taskUpdates).toHaveLength(1);
    expect(taskUpdates[0]?.updates.heartbeatRunId).toBeTruthy();
  });

  it("replays one immediate manual pulse after an in-flight pulse finishes", async () => {
    createAgent("agent-1", { heartbeatProfile: "dispatcher" });
    let createTaskCalls = 0;
    let releaseFirstTask: (() => void) | null = null;
    const firstTaskGate = new Promise<void>((resolve) => {
      releaseFirstTask = resolve;
    });
    const service = createService({
      createTask: async (workspaceId, prompt, title, agentRoleId, options) => {
        createTaskCalls += 1;
        if (createTaskCalls === 1) {
          await firstTaskGate;
        }
        const task: Task = {
          id: `task-${createdTasks.length + 1}`,
          title,
          prompt,
          status: "pending",
          workspaceId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          assignedAgentRoleId: agentRoleId,
          ...options?.taskOverrides,
        };
        createdTasks.push(task);
        mockTasks.set(task.id, task);
        return task;
      },
    });

    const first = service.triggerHeartbeat("agent-1");
    await Promise.resolve();
    const second = service.triggerHeartbeat("agent-1");
    await Promise.resolve();
    releaseFirstTask?.();

    const [, secondResult] = await Promise.all([first, second]);

    expect(secondResult.status).toBe("work_done");
    expect(createdTasks).toHaveLength(2);
    expect(createdTasks.every((task) => Boolean(task.heartbeatRunId))).toBe(true);
  });

  it("passive low-signal wakes do not create heartbeat tasks", async () => {
    createAgent("agent-1", { heartbeatProfile: "observer" });
    const service = createService();

    service.submitHeartbeatSignal({
      agentRoleId: "agent-1",
      signalFamily: "awareness_signal",
      source: "hook",
      fingerprint: "low-noise",
      urgency: "low",
      confidence: 0.2,
      reason: "Ambient change",
    });

    await service.start();
    await vi.advanceTimersByTimeAsync(6_000);

    expect(createdTasks).toHaveLength(0);
    const pulseEvents = heartbeatEvents.filter((event) => event.type === "pulse_completed");
    expect(["idle", "suggestion"]).toContain(
      pulseEvents.at(-1)?.result?.pulseOutcome as string,
    );
  });

  it("observer profile never executes HEARTBEAT.md checklist items", async () => {
    createAgent("agent-1", { heartbeatProfile: "observer" });
    writeHeartbeatChecklist("workspace-1", "## Daily\n- Review flaky tests");
    const service = createService();

    await service.start();
    await vi.advanceTimersByTimeAsync(6_000);

    const status = service.getStatus("agent-1");
    expect(status?.checklistDueCount).toBe(0);
    expect(recordedActivities).toHaveLength(0);
    expect(createdTasks).toHaveLength(0);
  });

  it("dispatcher profile escalates due HEARTBEAT.md items into a runbook dispatch", async () => {
    createAgent("agent-1", { heartbeatProfile: "dispatcher" });
    writeHeartbeatChecklist("workspace-1", "## Daily\n- Review flaky tests");
    const service = createService();

    await service.start();
    await vi.advanceTimersByTimeAsync(6_000);

    expect(recordedActivities.some((entry) => entry.title === "Heartbeat runbook requested")).toBe(
      true,
    );
    const dispatchEvent = heartbeatEvents.find((event) => event.type === "dispatch_completed");
    expect(dispatchEvent?.dispatchKind).toBe("runbook");
  });

  it("marks checklist cadence only for the workspace selected by the pulse", async () => {
    createAgent("agent-1", { heartbeatProfile: "dispatcher" });
    writeHeartbeatChecklist("workspace-1", "## Daily\n- Review workspace one");
    writeHeartbeatChecklist("workspace-2", "## Daily\n- Review workspace two");
    const service = createService();

    await service.start();
    await vi.advanceTimersByTimeAsync(6_000);

    const status = service.getStatus("agent-1");
    expect(status?.checklistDueCount).toBe(1);
    expect(
      recordedActivities.some(
        (entry) =>
          entry.title === "Heartbeat runbook requested" && entry.workspaceId === "workspace-1",
      ),
    ).toBe(true);
  });

  it("dispatch cooldown blocks duplicate task storms from repeated strong signals", async () => {
    createAgent("agent-1", {
      heartbeatProfile: "dispatcher",
      dispatchCooldownMinutes: 120,
    });
    const service = createService();

    service.submitHeartbeatSignal({
      agentRoleId: "agent-1",
      signalFamily: "urgent_interrupt",
      source: "hook",
      fingerprint: "storm-1",
      urgency: "critical",
      confidence: 1,
      reason: "Repeated urgent issue",
    });

    await service.start();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(createdTasks).toHaveLength(1);

    service.submitHeartbeatSignal({
      agentRoleId: "agent-1",
      signalFamily: "urgent_interrupt",
      source: "hook",
      fingerprint: "storm-2",
      urgency: "critical",
      confidence: 1,
      reason: "Repeated urgent issue",
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(createdTasks).toHaveLength(1);
  });

  it("preserves signals that are refreshed while a dispatch is still in flight", async () => {
    createAgent("agent-1", { heartbeatProfile: "dispatcher" });
    let releaseTask: (() => void) | null = null;
    const taskGate = new Promise<void>((resolve) => {
      releaseTask = resolve;
    });
    const service = createService({
      createTask: async (workspaceId, prompt, title, agentRoleId, options) => {
        await taskGate;
        const task: Task = {
          id: `task-${createdTasks.length + 1}`,
          title,
          prompt,
          status: "pending",
          workspaceId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          assignedAgentRoleId: agentRoleId,
          ...options?.taskOverrides,
        };
        createdTasks.push(task);
        mockTasks.set(task.id, task);
        return task;
      },
    });

    service.submitHeartbeatSignal({
      agentRoleId: "agent-1",
      signalFamily: "urgent_interrupt",
      source: "hook",
      fingerprint: "refreshable",
      urgency: "critical",
      confidence: 1,
      reason: "First urgent signal",
    });

    const firstDispatch = service.triggerHeartbeat("agent-1");
    await Promise.resolve();

    service.submitHeartbeatSignal({
      agentRoleId: "agent-1",
      signalFamily: "urgent_interrupt",
      source: "hook",
      fingerprint: "refreshable",
      urgency: "critical",
      confidence: 1,
      reason: "Updated urgent signal",
    });

    releaseTask?.();
    await firstDispatch;

    const status = service.getStatus("agent-1");
    expect((status?.compressedSignalCount || 0) >= 1).toBe(true);
  });

  it("counts failed dispatches against the daily dispatch budget", async () => {
    createAgent("agent-1", {
      heartbeatProfile: "dispatcher",
      maxDispatchesPerDay: 1,
      dispatchCooldownMinutes: 0,
    });
    let failNextTask = true;
    const service = createService({
      createTask: async (workspaceId, prompt, title, agentRoleId, options) => {
        if (failNextTask) {
          failNextTask = false;
          throw new Error("dispatch failed");
        }
        const task: Task = {
          id: `task-${createdTasks.length + 1}`,
          title,
          prompt,
          status: "pending",
          workspaceId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          assignedAgentRoleId: agentRoleId,
          ...options?.taskOverrides,
        };
        createdTasks.push(task);
        mockTasks.set(task.id, task);
        return task;
      },
    });

    const failed = await service.triggerHeartbeat("agent-1");
    expect(failed.status).toBe("error");

    service.submitHeartbeatSignal({
      agentRoleId: "agent-1",
      signalFamily: "urgent_interrupt",
      source: "hook",
      fingerprint: "budget-check",
      urgency: "critical",
      confidence: 1,
      reason: "Another urgent signal",
    });

    await service.start();
    await vi.advanceTimersByTimeAsync(6_000);

    expect(createdTasks).toHaveLength(0);
    expect(service.getStatus("agent-1")?.dispatchesToday).toBe(1);
  });

  it("does not leave a stale in-flight dispatch after a thrown dispatch failure", async () => {
    createAgent("agent-1", { heartbeatProfile: "dispatcher" });
    let failNextTask = true;
    const service = createService({
      createTask: async (workspaceId, prompt, title, agentRoleId, options) => {
        if (failNextTask) {
          failNextTask = false;
          throw new Error("dispatch failed");
        }
        const task: Task = {
          id: `task-${createdTasks.length + 1}`,
          title,
          prompt,
          status: "pending",
          workspaceId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          assignedAgentRoleId: agentRoleId,
          ...options?.taskOverrides,
        };
        createdTasks.push(task);
        mockTasks.set(task.id, task);
        return task;
      },
    });

    const failed = await service.triggerHeartbeat("agent-1");
    expect(failed.status).toBe("error");

    const recovered = await service.triggerHeartbeat("agent-1");
    expect(recovered.status).toBe("work_done");
    expect(createdTasks).toHaveLength(1);
  });

  it("downgrades actionable pulses to idle when no workspace can execute them", async () => {
    createAgent("agent-1", { heartbeatProfile: "dispatcher" });
    const service = createService({
      getDefaultWorkspaceId: () => undefined,
      getDefaultWorkspacePath: () => undefined,
      getWorkspacePath: () => undefined,
      listWorkspaceContexts: () => [],
    });

    const result = await service.triggerHeartbeat("agent-1");

    expect(result.status).toBe("ok");
    expect(result.pulseOutcome).toBe("idle");
    expect(result.taskCreated).toBeUndefined();
    expect(createdTasks).toHaveLength(0);
    expect(service.getStatus("agent-1")?.lastPulseResult).toBe("idle");
    expect(heartbeatEvents.some((event) => event.type === "dispatch_skipped")).toBe(true);
  });

  it("reconciles stale agent heartbeat runs on service start without touching issue-linked runs", async () => {
    createAgent("agent-1");
    const service = createService();
    const runRepo = (service as any).runRepo as {
      create: (input: {
        issueId?: string;
        agentRoleId?: string;
        workspaceId?: string;
        runType: "pulse" | "dispatch";
        status?: "running" | "queued" | "completed" | "failed" | "cancelled";
      }) => { id: string };
      get: (runId: string) => { status?: string; error?: string; completedAt?: number };
    };
    const staleRun = runRepo.create({
      agentRoleId: "agent-1",
      workspaceId: "workspace-1",
      runType: "dispatch",
      status: "running",
    });
    const issueRun = runRepo.create({
      issueId: "issue-1",
      agentRoleId: "agent-1",
      workspaceId: "workspace-1",
      runType: "dispatch",
      status: "running",
    });

    await service.start();

    const updatedStaleRun = runRepo.get(staleRun.id);
    const updatedIssueRun = runRepo.get(issueRun.id);

    expect(updatedStaleRun.status).toBe("failed");
    expect(updatedStaleRun.error).toContain("restarted");
    expect(typeof updatedStaleRun.completedAt).toBe("number");
    expect(updatedIssueRun.status).toBe("running");
  });

  it("persists merged signal state across service restarts", () => {
    createAgent("agent-1");
    const first = createService();
    first.submitHeartbeatSignal({
      agentRoleId: "agent-1",
      signalFamily: "awareness_signal",
      source: "hook",
      fingerprint: "persisted",
      reason: "Persistent signal",
    });
    first.submitHeartbeatSignal({
      agentRoleId: "agent-1",
      signalFamily: "awareness_signal",
      source: "hook",
      fingerprint: "persisted",
      reason: "Persistent signal",
    });

    const second = createService();
    const status = second.getStatus("agent-1");
    expect((status?.compressedSignalCount || 0) >= 2).toBe(true);
  });
});
