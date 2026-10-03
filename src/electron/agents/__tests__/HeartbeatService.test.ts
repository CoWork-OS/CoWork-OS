import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentRole,
  AgentMention,
  Activity,
  CreateAutomationRunOutcomeInput,
  HeartbeatEvent,
  ProactiveSuggestion,
  Task,
} from "../../../shared/types";
import { HeartbeatService, type HeartbeatServiceDeps } from "../HeartbeatService";
import { MemoryPressureService } from "../../memory/MemoryPressureService";

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
let automationOutcomes: CreateAutomationRunOutcomeInput[];
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
      updateHeartbeatStatus: (
        id: string,
        status: AgentRole["heartbeatStatus"],
        lastHeartbeatAt?: number,
      ) => {
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
    getTaskStatus: (taskId: string) => mockTasks.get(taskId)?.status,
    getDefaultWorkspaceId: () => "workspace-1",
    getDefaultWorkspacePath: () => workspacePaths.get("workspace-1"),
    getWorkspacePath: (workspaceId: string) => workspacePaths.get(workspaceId),
    getWorkspaceMemoryReadGuard: () => () => true,
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
    recordAutomationOutcome: async (outcome) => {
      automationOutcomes.push(outcome);
    },
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
    automationOutcomes = [];
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

  afterEach(async () => {
    for (const service of services) {
      await service.stop();
    }
    vi.clearAllTimers();
    vi.useRealTimers();
    delete process.env.COWORK_USER_DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("cancels scheduled pulses before storage is closed", async () => {
    createAgent("agent-1");
    const service = createService();
    await service.start();
    await service.stop();
    mockAgents.clear();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(heartbeatEvents).toHaveLength(0);
    expect(createdTasks).toHaveLength(0);
  });

  it("waits for in-flight dispatch and suppresses queued manual wakes on stop", async () => {
    createAgent("agent-1");
    let releaseDispatch!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const createTask = vi.fn(async () => {
      await dispatched;
      return { id: "shutdown-task", workspaceId: "workspace-1", status: "pending" } as Task;
    });
    const service = createService({ createTask });
    await service.start();
    const first = service.triggerHeartbeat("agent-1");
    await vi.waitFor(() => expect(createTask).toHaveBeenCalledTimes(1));
    const queued = service.triggerHeartbeat("agent-1");
    let stopped = false;
    const stop = service.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    releaseDispatch();
    await Promise.all([first, queued, stop]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(stopped).toBe(true);
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(await service.triggerHeartbeat("agent-1")).toMatchObject({
      status: "error",
      error: "Heartbeat service is stopped",
    });
  });

  it("merges repeated identical hook signals into one compressed ledger entry", async () => {
    createAgent("agent-1");
    const service = createService();

    await service.submitHeartbeatSignal({
      agentRoleId: "agent-1",
      signalFamily: "awareness_signal",
      source: "hook",
      fingerprint: "same-signal",
      reason: "Files changed",
    });
    await service.submitHeartbeatSignal({
      agentRoleId: "agent-1",
      signalFamily: "awareness_signal",
      source: "hook",
      fingerprint: "same-signal",
      reason: "Files changed",
    });

    const status = await service.getStatus("agent-1");
    expect(status?.compressedSignalCount).toBe(2);
    expect(status?.deferred?.active).toBeUndefined();
    expect(heartbeatEvents.map((event) => event.type)).toContain("signal_merged");
  });

  it("defers and compresses during foreground work instead of creating tasks", async () => {
    createAgent("agent-1");
    const service = createService({
      hasActiveForegroundTask: () => true,
    });

    await service.submitHeartbeatSignal({
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

    const status = await service.getStatus("agent-1");
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
    expect(automationOutcomes).toContainEqual(
      expect.objectContaining({
        usefulness: "actionable",
        title: "Agent agent-1 started background work",
        taskId: createdTasks[0]?.id,
      }),
    );
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
          // The first task finishes at once, so its dispatch is no longer in flight.
          status: createTaskCalls === 1 ? "completed" : "pending",
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

    await service.submitHeartbeatSignal({
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
    expect(["idle", "suggestion"]).toContain(pulseEvents.at(-1)?.result?.pulseOutcome as string);
  });

  it("observer profile never executes HEARTBEAT.md checklist items", async () => {
    createAgent("agent-1", { heartbeatProfile: "observer" });
    writeHeartbeatChecklist("workspace-1", "## Daily\n- Review flaky tests");
    const service = createService();

    await service.start();
    await vi.advanceTimersByTimeAsync(6_000);

    const status = await service.getStatus("agent-1");
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

    const status = await service.getStatus("agent-1");
    // Runbooks are only reported, not executed, so neither item is marked done.
    expect(status?.checklistDueCount).toBe(2);
    expect(
      recordedActivities.some(
        (entry) =>
          entry.title === "Heartbeat runbook requested" && entry.workspaceId === "workspace-1",
      ),
    ).toBe(true);
    expect(
      recordedActivities.some(
        (entry) =>
          entry.title === "Heartbeat runbook requested" && entry.workspaceId === "workspace-2",
      ),
    ).toBe(false);
  });

  it("dispatch cooldown blocks duplicate task storms from repeated strong signals", async () => {
    createAgent("agent-1", {
      heartbeatProfile: "dispatcher",
      dispatchCooldownMinutes: 120,
    });
    const service = createService();

    await service.submitHeartbeatSignal({
      agentRoleId: "agent-1",
      signalFamily: "urgent_interrupt",
      source: "hook",
      fingerprint: "storm-1",
      urgency: "critical",
      confidence: 1,
      reason: "Repeated urgent issue",
      evidenceRefs: ["incident:1"],
    });

    await service.start();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(createdTasks).toHaveLength(1);

    await service.submitHeartbeatSignal({
      agentRoleId: "agent-1",
      signalFamily: "urgent_interrupt",
      source: "hook",
      fingerprint: "storm-2",
      urgency: "critical",
      confidence: 1,
      reason: "Repeated urgent issue",
      evidenceRefs: ["incident:2"],
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(createdTasks).toHaveLength(1);
  });

  it("preserves signals that are refreshed while a dispatch is still in flight", async () => {
    createAgent("agent-1", { heartbeatProfile: "dispatcher" });
    let releaseTask: (() => void) | null = null;
    let dispatchStarted = false;
    const taskGate = new Promise<void>((resolve) => {
      releaseTask = resolve;
    });
    const service = createService({
      createTask: async (workspaceId, prompt, title, agentRoleId, options) => {
        dispatchStarted = true;
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

    await service.submitHeartbeatSignal({
      agentRoleId: "agent-1",
      signalFamily: "urgent_interrupt",
      source: "hook",
      fingerprint: "refreshable",
      urgency: "critical",
      confidence: 1,
      reason: "First urgent signal",
    });

    const firstDispatch = service.triggerHeartbeat("agent-1");
    // The dispatch reads the agent through the async storage facade before it creates the
    // task; submit the refresh once the dispatch is in flight.
    await vi.waitFor(() => expect(dispatchStarted).toBe(true));

    await service.submitHeartbeatSignal({
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

    const status = await service.getStatus("agent-1");
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
    expect(automationOutcomes).toContainEqual(
      expect.objectContaining({
        usefulness: "failed",
        title: "Agent agent-1 heartbeat failed",
      }),
    );

    await service.submitHeartbeatSignal({
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
    expect((await service.getStatus("agent-1"))?.dispatchesToday).toBe(1);
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
    expect((await service.getStatus("agent-1"))?.lastPulseResult).toBe("idle");
    expect(heartbeatEvents.some((event) => event.type === "dispatch_skipped")).toBe(true);
  });

  it("passes the workspace access guard into background memory dreaming", async () => {
    createAgent("agent-1", { heartbeatProfile: "observer" });
    const readGuard = vi.fn((_candidatePath: string) => true);
    let dreamingReadGuard: ((candidatePath: string) => boolean) | undefined;
    const service = createService({
      getWorkspaceMemoryReadGuard: () => readGuard,
      runMemoryDreaming: async (params) => {
        dreamingReadGuard = params.readGuard;
        return { id: "dreaming-1", status: "completed", candidateCount: 0 };
      },
    });

    await service.submitHeartbeatSignal({
      agentRoleId: "agent-1",
      workspaceId: "workspace-1",
      signalFamily: "memory_drift",
      source: "hook",
      fingerprint: "memory-guard",
      urgency: "high",
      confidence: 1,
      reason: "Memory needs review",
    });

    const result = await service.triggerHeartbeat("agent-1");

    expect(result.dreamingRunId).toBe("dreaming-1");
    expect(dreamingReadGuard).toBe(readGuard);
    expect(readGuard).toHaveBeenCalled();
  });

  it("skips background memory dreaming when access-profile resolution fails", async () => {
    createAgent("agent-1", { heartbeatProfile: "observer" });
    const runMemoryDreaming = vi.fn(async () => ({ id: "should-not-run" }));
    const service = createService({
      getWorkspaceMemoryReadGuard: () => {
        throw new Error("settings unavailable");
      },
      runMemoryDreaming,
    });

    await service.submitHeartbeatSignal({
      agentRoleId: "agent-1",
      workspaceId: "workspace-1",
      signalFamily: "memory_drift",
      source: "hook",
      fingerprint: "memory-guard-error",
      urgency: "high",
      confidence: 1,
      reason: "Memory needs review",
    });

    const result = await service.triggerHeartbeat("agent-1");

    expect(result.status).not.toBe("error");
    expect(result.dreamingRunId).toBeUndefined();
    expect(runMemoryDreaming).not.toHaveBeenCalled();
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
      }) => Promise<{ id: string }>;
      get: (runId: string) => Promise<{ status?: string; error?: string; completedAt?: number }>;
    };
    const staleRun = await runRepo.create({
      agentRoleId: "agent-1",
      workspaceId: "workspace-1",
      runType: "dispatch",
      status: "running",
    });
    const issueRun = await runRepo.create({
      issueId: "issue-1",
      agentRoleId: "agent-1",
      workspaceId: "workspace-1",
      runType: "dispatch",
      status: "running",
    });

    await service.start();

    const updatedStaleRun = await runRepo.get(staleRun.id);
    const updatedIssueRun = await runRepo.get(issueRun.id);

    expect(updatedStaleRun.status).toBe("failed");
    expect(updatedStaleRun.error).toContain("restarted");
    expect(typeof updatedStaleRun.completedAt).toBe("number");
    expect(updatedIssueRun.status).toBe("running");
  });

  it("persists merged signal state across service restarts", async () => {
    createAgent("agent-1");
    const first = createService();
    await first.submitHeartbeatSignal({
      agentRoleId: "agent-1",
      signalFamily: "awareness_signal",
      source: "hook",
      fingerprint: "persisted",
      reason: "Persistent signal",
    });
    await first.submitHeartbeatSignal({
      agentRoleId: "agent-1",
      signalFamily: "awareness_signal",
      source: "hook",
      fingerprint: "persisted",
      reason: "Persistent signal",
    });
    await first.stop();

    const second = createService();
    const status = await second.getStatus("agent-1");
    expect((status?.compressedSignalCount || 0) >= 2).toBe(true);
  });
});

describe("HeartbeatService pulse scheduling and dispatch guards", () => {
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
    automationOutcomes = [];
    services = [];
    MemoryPressureService.resetHandledPressure();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-heartbeat-guards-"));
    process.env.COWORK_USER_DATA_DIR = path.join(tmpDir, "user-data");
    workspacePaths = new Map([
      ["workspace-1", path.join(tmpDir, "workspace-1")],
      ["workspace-2", path.join(tmpDir, "workspace-2")],
    ]);
    for (const workspacePath of workspacePaths.values()) {
      fs.mkdirSync(workspacePath, { recursive: true });
    }
  });

  afterEach(async () => {
    for (const service of services) {
      await service.stop();
    }
    vi.clearAllTimers();
    vi.useRealTimers();
    delete process.env.COWORK_USER_DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function countingMentionRepo(gate?: Promise<void>) {
    const getPendingForAgent = vi.fn(async (_agentId: string) => {
      if (gate && getPendingForAgent.mock.calls.length === 1) await gate;
      return [] as AgentMention[];
    });
    return {
      getPendingForAgent,
      mentionRepo: { getPendingForAgent } as unknown as HeartbeatServiceDeps["mentionRepo"],
    };
  }

  function runRepoOf(service: HeartbeatService) {
    return (service as unknown as {
      runRepo: {
        create: (input: Record<string, unknown>) => Promise<{ id: string }>;
        attachTask: (runId: string, taskId: string) => Promise<void>;
        finish: (runId: string, input: Record<string, unknown>) => Promise<unknown>;
        get: (runId: string) => Promise<{ status?: string; error?: string } | undefined>;
        getLatestRun: (agentId: string, type: string) => Promise<unknown>;
        listRunningDispatches: (agentId: string) => Promise<Array<{ id: string; taskId?: string }>>;
      };
    }).runRepo;
  }

  function timersOf(service: HeartbeatService): Map<string, unknown> {
    return (service as unknown as { timers: Map<string, unknown> }).timers;
  }

  it("keeps exactly one pulse timer per agent after manual pulses", async () => {
    createAgent("agent-1", { heartbeatProfile: "observer" });
    const { getPendingForAgent, mentionRepo } = countingMentionRepo();
    const service = createService({ mentionRepo });
    await service.start();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(getPendingForAgent).toHaveBeenCalledTimes(1);

    await service.triggerHeartbeat("agent-1");
    await service.triggerHeartbeat("agent-1");
    expect(timersOf(service).size).toBe(1);

    getPendingForAgent.mockClear();
    // Cadence is one minute: one chain yields two pulses in 170 s, a leaked chain more.
    await vi.advanceTimersByTimeAsync(170_000);
    expect(getPendingForAgent).toHaveBeenCalledTimes(2);
    expect(timersOf(service).size).toBe(1);
  });

  it("reserves the running slot synchronously so concurrent pulses share one run", async () => {
    const agent = createAgent("agent-1", { heartbeatProfile: "observer" });
    const { getPendingForAgent, mentionRepo } = countingMentionRepo();
    const service = createService({ mentionRepo });
    const execute = (
      service as unknown as {
        executePulse: (agent: AgentRole, manual: boolean) => Promise<unknown>;
      }
    ).executePulse.bind(service);

    const first = execute(agent, false);
    const second = execute(agent, true);
    expect(second).toBe(first);
    await first;
    expect(getPendingForAgent).toHaveBeenCalledTimes(1);
  });

  it("runs a queued manual replay exactly once for any number of manual triggers", async () => {
    createAgent("agent-1", { heartbeatProfile: "dispatcher" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const createTask = vi.fn(async (workspaceId: string, prompt: string, title: string) => {
      if (createTask.mock.calls.length === 1) await gate;
      const task = {
        id: `task-${createTask.mock.calls.length}`,
        title,
        prompt,
        workspaceId,
        status: "completed",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as Task;
      mockTasks.set(task.id, task);
      return task;
    });
    const service = createService({ createTask });

    const first = service.triggerHeartbeat("agent-1");
    await vi.waitFor(() => expect(createTask).toHaveBeenCalledTimes(1));
    const queued = [
      service.triggerHeartbeat("agent-1"),
      service.triggerHeartbeat("agent-1"),
      service.triggerHeartbeat("agent-1"),
    ];
    release();
    await first;
    const results = await Promise.all(queued);

    expect(createTask).toHaveBeenCalledTimes(2);
    expect(results[1]).toBe(results[0]);
    expect(results[2]).toBe(results[0]);
  });

  it("reports runbooks without spending budget, marking items done, or eating signals", async () => {
    createAgent("agent-1", { heartbeatProfile: "dispatcher" });
    writeHeartbeatChecklist("workspace-1", "## Daily\n- Review flaky tests");
    const service = createService();
    await service.submitHeartbeatSignal({
      agentRoleId: "agent-1",
      workspaceId: "workspace-1",
      signalFamily: "open_loop_pressure",
      source: "hook",
      fingerprint: "open-loop",
      urgency: "low",
      confidence: 0.3,
      reason: "Open loop",
    });

    await service.start();
    await vi.advanceTimersByTimeAsync(6_000);

    const runbookReports = () =>
      recordedActivities.filter((entry) => entry.title === "Heartbeat runbook requested");
    expect(runbookReports()).toHaveLength(1);
    let status = await service.getStatus("agent-1");
    expect(status?.dispatchesToday).toBe(0);
    expect(status?.checklistDueCount).toBe(1);
    expect(status?.compressedSignalCount).toBe(1);

    // The reported runbook is not re-reported on every pulse.
    await vi.advanceTimersByTimeAsync(61_000);
    expect(runbookReports()).toHaveLength(1);

    // And it does not block evidence-backed work while the checklist stays due.
    await service.submitHeartbeatSignal({
      agentRoleId: "agent-1",
      workspaceId: "workspace-1",
      signalFamily: "urgent_interrupt",
      source: "hook",
      fingerprint: "incident",
      urgency: "critical",
      confidence: 1,
      reason: "Build broken",
      evidenceRefs: ["incident:42"],
    });
    await vi.advanceTimersByTimeAsync(61_000);
    expect(createdTasks).toHaveLength(1);
    // The real task carries the due checklist in its prompt, so that dispatch marks it done.
    expect(createdTasks[0]?.prompt).toContain("Review flaky tests");
    status = await service.getStatus("agent-1");
    expect(status?.checklistDueCount).toBe(0);
  });

  it("turns strong observer signals into a suggestion", async () => {
    createAgent("agent-1", { heartbeatProfile: "observer" });
    const service = createService();
    await service.submitHeartbeatSignal({
      agentRoleId: "agent-1",
      workspaceId: "workspace-1",
      signalFamily: "open_loop_pressure",
      source: "hook",
      fingerprint: "strong",
      urgency: "high",
      confidence: 0.95,
      reason: "Reply overdue",
    });

    await service.start();
    await vi.advanceTimersByTimeAsync(6_000);

    expect(createdSuggestions).toHaveLength(1);
    expect(createdTasks).toHaveLength(0);
    const completed = heartbeatEvents.find((event) => event.type === "pulse_completed");
    expect(completed?.result?.dispatchKind).toBe("suggestion");
  });

  it("pulses immediately on a now-wake and queues it behind a running pulse", async () => {
    createAgent("agent-1", { heartbeatProfile: "observer" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { getPendingForAgent, mentionRepo } = countingMentionRepo(gate);
    const service = createService({ mentionRepo });
    await service.start();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(getPendingForAgent).toHaveBeenCalledTimes(1);

    await service.submitWakeRequest("agent-1", { mode: "now", source: "hook", text: "Prod down" });
    await vi.advanceTimersByTimeAsync(10);
    expect(getPendingForAgent).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(10);
    expect(getPendingForAgent).toHaveBeenCalledTimes(2);

    await service.submitWakeRequest("agent-1", { mode: "now", source: "hook", text: "Again" });
    await vi.advanceTimersByTimeAsync(10);
    expect(getPendingForAgent).toHaveBeenCalledTimes(3);
    expect(timersOf(service).size).toBe(1);
  });

  it("keeps urgent wakes alive longer than the pulse cadence", async () => {
    createAgent("agent-1", { heartbeatProfile: "observer", pulseEveryMinutes: 90 });
    const service = createService();
    await service.submitWakeRequest("agent-1", { mode: "now", source: "hook", text: "Urgent" });
    const signals = (
      service as unknown as {
        signalStore: { listAgentSignals: (id: string) => Array<{ expiresAt: number }> };
      }
    ).signalStore.listAgentSignals("agent-1");
    expect(signals).toHaveLength(1);
    expect(signals[0].expiresAt - Date.now()).toBeGreaterThanOrEqual(2 * 90 * 60 * 1000);
  });

  it("merges wakes by category and workspace instead of by text", async () => {
    createAgent("agent-1", { heartbeatProfile: "observer" });
    const service = createService();
    const wake = (text: string, category: string) =>
      service.submitWakeRequest("agent-1", {
        mode: "next-heartbeat",
        source: "hook",
        text,
        workspaceId: "workspace-1",
        category,
      });
    await wake("file_modified src/a.ts", "file_change");
    await wake("file_modified src/b.ts", "file_change");
    await wake("Window: Inbox (3) - Mail", "file_change");
    await wake("main | 4 changed file(s)", "git");

    const status = await service.getStatus("agent-1");
    expect(status?.compressedSignalCount).toBe(4);
    const signals = (
      service as unknown as {
        signalStore: { listAgentSignals: (id: string) => Array<{ mergedCount: number }> };
      }
    ).signalStore.listAgentSignals("agent-1");
    expect(signals.map((signal) => signal.mergedCount).sort()).toEqual([1, 3]);
  });

  it("keeps a task dispatch in flight until its task finishes", async () => {
    createAgent("agent-1", { heartbeatProfile: "dispatcher" });
    const service = createService();
    const first = await service.triggerHeartbeat("agent-1");
    expect(first.taskCreated).toBe("task-1");
    const runRepo = runRepoOf(service);
    expect(await runRepo.listRunningDispatches("agent-1")).toEqual([
      expect.objectContaining({ taskId: "task-1" }),
    ]);

    const blocked = await service.triggerHeartbeat("agent-1");
    expect(blocked.pulseOutcome).toBe("idle");
    expect(blocked.triggerReason).toBe("Dispatch already in flight");
    expect(createdTasks).toHaveLength(1);

    mockTasks.set("task-1", { ...mockTasks.get("task-1")!, status: "completed" });
    const next = await service.triggerHeartbeat("agent-1");
    expect(next.taskCreated).toBe("task-2");
    expect(await runRepo.listRunningDispatches("agent-1")).toEqual([
      expect.objectContaining({ taskId: "task-2" }),
    ]);
  });

  it("suggests instead of creating a task when a dispatch has no evidence refs", async () => {
    createAgent("agent-1", { heartbeatProfile: "dispatcher" });
    const service = createService();
    await service.submitHeartbeatSignal({
      agentRoleId: "agent-1",
      workspaceId: "workspace-1",
      signalFamily: "urgent_interrupt",
      source: "hook",
      fingerprint: "no-evidence",
      urgency: "critical",
      confidence: 1,
      reason: "Something happened",
    });

    await service.start();
    await vi.advanceTimersByTimeAsync(6_000);

    expect(createdTasks).toHaveLength(0);
    expect(createdSuggestions).toHaveLength(1);
  });

  it("fails task dispatch runs that stay in flight past the stale limit at startup", async () => {
    createAgent("agent-1", { heartbeatProfile: "observer" });
    const service = createService();
    const runRepo = runRepoOf(service);
    const run = await runRepo.create({
      agentRoleId: "agent-1",
      workspaceId: "workspace-1",
      runType: "dispatch",
      status: "running",
    });
    await runRepo.attachTask(run.id, "task-live");
    vi.setSystemTime(new Date("2026-03-23T01:00:00Z"));

    await service.start();

    expect((await runRepo.get(run.id))?.status).toBe("failed");
  });

  it("skips run rows, reflection and Dreaming for pulses outside active hours", async () => {
    createAgent("agent-1", {
      heartbeatProfile: "observer",
      activeHours: { timezone: "UTC", startHour: 1, endHour: 2 },
    });
    const runWorkflowReflection = vi.fn(async () => ({ id: "r" }));
    const runMemoryDreaming = vi.fn(async () => ({ id: "d" }));
    const service = createService({ runWorkflowReflection, runMemoryDreaming });
    await service.submitHeartbeatSignal({
      agentRoleId: "agent-1",
      workspaceId: "workspace-1",
      signalFamily: "memory_drift",
      source: "hook",
      fingerprint: "drift",
      urgency: "high",
      confidence: 1,
      reason: "Memory drift",
    });

    await service.start();
    await vi.advanceTimersByTimeAsync(6_000);

    expect(runWorkflowReflection).not.toHaveBeenCalled();
    expect(runMemoryDreaming).not.toHaveBeenCalled();
    expect(await runRepoOf(service).getLatestRun("agent-1", "pulse")).toBeUndefined();
    expect(mockAgents.get("agent-1")?.lastPulseResult).toBe("idle");
  });

  it("defers before reflection and Dreaming during foreground work", async () => {
    createAgent("agent-1", { heartbeatProfile: "observer" });
    const runWorkflowReflection = vi.fn(async () => ({ id: "r" }));
    const runMemoryDreaming = vi.fn(async () => ({ id: "d" }));
    const service = createService({
      hasActiveForegroundTask: () => true,
      runWorkflowReflection,
      runMemoryDreaming,
    });
    await service.submitHeartbeatSignal({
      agentRoleId: "agent-1",
      workspaceId: "workspace-1",
      signalFamily: "memory_drift",
      source: "hook",
      fingerprint: "drift",
      urgency: "high",
      confidence: 1,
      reason: "Memory drift",
    });

    await service.start();
    await vi.advanceTimersByTimeAsync(6_000);

    expect(heartbeatEvents.some((event) => event.type === "pulse_deferred")).toBe(true);
    expect(runWorkflowReflection).not.toHaveBeenCalled();
    expect(runMemoryDreaming).not.toHaveBeenCalled();
    expect(await runRepoOf(service).getLatestRun("agent-1", "pulse")).toBeUndefined();
  });

  it("skips Dreaming when heartbeat memory maintenance is turned off", async () => {
    createAgent("agent-1", { heartbeatProfile: "observer" });
    const runMemoryDreaming = vi.fn(async () => ({ id: "d" }));
    const service = createService({
      runMemoryDreaming,
      getMemoryFeaturesSettings: () =>
        ({ heartbeatMaintenanceEnabled: false }) as ReturnType<
          NonNullable<HeartbeatServiceDeps["getMemoryFeaturesSettings"]>
        >,
    });
    await service.submitHeartbeatSignal({
      agentRoleId: "agent-1",
      workspaceId: "workspace-1",
      signalFamily: "memory_drift",
      source: "hook",
      fingerprint: "drift",
      urgency: "low",
      confidence: 0.4,
      reason: "Memory drift",
    });

    await service.start();
    await vi.advanceTimersByTimeAsync(6_000);

    expect(runMemoryDreaming).not.toHaveBeenCalled();
  });

  it("triggers Dreaming for hot-memory pressure only when the pressure changes", async () => {
    createAgent("agent-1", { heartbeatProfile: "observer" });
    const memoryFile = path.join(workspacePaths.get("workspace-1")!, ".cowork", "MEMORY.md");
    fs.mkdirSync(path.dirname(memoryFile), { recursive: true });
    fs.writeFileSync(memoryFile, "- Use deterministic prompts\n- Use deterministic prompts\n");
    const runMemoryDreaming = vi.fn(async () => ({ id: "d", status: "completed" }));
    const service = createService({ runMemoryDreaming });
    // Pressure analysis reads files for real, so wait for each pulse to complete.
    const pulse = async (count: number, advanceMs: number) => {
      await vi.advanceTimersByTimeAsync(advanceMs);
      await vi.waitFor(() =>
        expect(
          heartbeatEvents.filter((event) => event.type === "pulse_completed").length,
        ).toBeGreaterThanOrEqual(count),
      );
    };

    await service.start();
    await pulse(1, 6_000);
    expect(runMemoryDreaming).toHaveBeenCalledTimes(1);

    await pulse(2, 61_000);
    expect(runMemoryDreaming).toHaveBeenCalledTimes(1);

    fs.writeFileSync(
      memoryFile,
      "- Use deterministic prompts\n- Use deterministic prompts\n- Prefer pnpm for installs\n- Prefer pnpm for installs\n",
    );
    await pulse(3, 61_000);
    expect(runMemoryDreaming).toHaveBeenCalledTimes(2);
  });

  it("consumes memory signals once Dreaming ran, and keeps them when it was skipped", async () => {
    createAgent("agent-1", { heartbeatProfile: "observer" });
    let skipped: string | undefined = "cooldown";
    const runMemoryDreaming = vi.fn(async () => ({ id: "d", status: "completed", skipped }));
    const service = createService({ runMemoryDreaming });
    await service.submitHeartbeatSignal({
      agentRoleId: "agent-1",
      workspaceId: "workspace-1",
      signalFamily: "correction_learning",
      source: "tasks",
      fingerprint: "correction",
      urgency: "low",
      confidence: 0.6,
      reason: "User corrected the agent",
    });

    const pulse = async (count: number, advanceMs: number) => {
      await vi.advanceTimersByTimeAsync(advanceMs);
      await vi.waitFor(() =>
        expect(
          heartbeatEvents.filter((event) => event.type === "pulse_completed").length,
        ).toBeGreaterThanOrEqual(count),
      );
    };

    await service.start();
    await pulse(1, 6_000);
    expect(runMemoryDreaming).toHaveBeenCalledTimes(1);
    expect((await service.getStatus("agent-1"))?.compressedSignalCount).toBe(1);

    skipped = undefined;
    await pulse(2, 61_000);
    expect(runMemoryDreaming).toHaveBeenCalledTimes(2);
    expect((await service.getStatus("agent-1"))?.compressedSignalCount).toBe(0);
  });

  it("prunes old finished heartbeat runs while keeping the newest per agent", async () => {
    createAgent("agent-1", { heartbeatProfile: "observer" });
    const service = createService();
    const runRepo = runRepoOf(service);
    for (let index = 0; index < 3; index += 1) {
      const run = await runRepo.create({ agentRoleId: "agent-1", runType: "pulse" });
      await runRepo.finish(run.id, { status: "completed" });
      vi.setSystemTime(Date.now() + 1_000);
    }
    vi.setSystemTime(Date.now() + 31 * 24 * 60 * 60 * 1000);

    const pruned = await service.pruneRunHistory({ keepPerAgent: 1 });

    expect(pruned.runsDeleted).toBe(2);
    expect(await runRepo.getLatestRun("agent-1", "pulse")).toBeTruthy();
  });
});
