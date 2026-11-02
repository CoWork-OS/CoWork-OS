/**
 * Full-duplex child agents: spawn_agent returns at once, wait_for_agent never blocks on a pushed
 * child, and the child's result reaches the parent as a follow-up event that the turn loop
 * drains at its next iteration, after any user follow-up that was already waiting.
 */
import { describe, expect, it, vi } from "vitest";
import type { OrchestrationGraphNode, Task, Workspace } from "../../../../shared/types";
import { runningTurnUpdateText } from "../../background-process-notifications";
import { TurnKernel, type TurnKernelIterationState } from "../../runtime/turn-kernel";

vi.mock("electron", () => ({
  app: { getPath: vi.fn().mockReturnValue("/tmp") },
}));

vi.mock("../../../mcp/client/MCPClientManager", () => ({
  MCPClientManager: {
    getInstance: vi.fn().mockImplementation(() => {
      throw new Error("MCP not initialized");
    }),
  },
}));

vi.mock("../../../mcp/settings", () => ({
  MCPSettingsManager: {
    initialize: vi.fn(),
    loadSettings: vi.fn().mockReturnValue({ toolNamePrefix: "mcp_" }),
    updateServer: vi.fn().mockReturnValue({}),
  },
}));

vi.mock("../../../mcp/registry/MCPRegistryManager", () => ({
  MCPRegistryManager: { installServer: vi.fn() },
}));

vi.mock("../../../hooks/settings", () => ({
  HooksSettingsManager: {
    initialize: vi.fn(),
    loadSettings: vi.fn().mockReturnValue({
      enabled: false,
      token: "",
      path: "/hooks",
      maxBodyBytes: 256 * 1024,
      presets: [],
      mappings: [],
    }),
    enableHooks: vi.fn(),
    updateConfig: vi.fn(),
  },
}));

vi.mock("../../../settings/personality-manager", () => ({
  PersonalityManager: {
    loadSettings: vi.fn().mockReturnValue({}),
    saveSettings: vi.fn(),
    setUserName: vi.fn(),
    getUserName: vi.fn(),
    getAgentName: vi.fn().mockReturnValue("CoWork"),
    setActivePersona: vi.fn(),
    setResponseStyle: vi.fn(),
    setQuirks: vi.fn(),
    clearCache: vi.fn(),
  },
}));

vi.mock("../../custom-skill-loader", () => ({
  getCustomSkillLoader: vi.fn().mockReturnValue({
    forWorkspace() {
      return this;
    },
    getSkill: vi.fn(),
    listModelInvocableSkills: vi.fn().mockReturnValue([]),
    expandPrompt: vi.fn().mockReturnValue(""),
    getSkillDescriptionsForModel: vi.fn().mockReturnValue(""),
  }),
}));

vi.mock("../mention-tools", () => ({
  MentionTools: class MockMentionTools {
    getTools() {
      return [];
    }
    static getToolDefinitions() {
      return [];
    }
  },
}));

import { ToolRegistry } from "../registry";
import { AgentDaemon } from "../../daemon";

const workspace: Workspace = {
  id: "ws-1",
  name: "Test Workspace",
  path: "/tmp",
  createdAt: 1,
  permissions: { read: true, write: true, delete: true, network: true, shell: false },
};

const parentTask: Task = {
  id: "parent-task",
  title: "Parent",
  prompt: "Ship the parser fix",
  status: "executing",
  source: "manual",
  workspaceId: workspace.id,
  createdAt: 1,
  updatedAt: 1,
  depth: 0,
};

interface QueuedFollowUp {
  message: string;
  messageSource?: "user" | "agent";
  notificationKind?: "background_process" | "agent_output";
  messageId?: string;
}

/**
 * One running spawn_agent child, the parent's follow-up queue, and the daemon push path
 * (journal, flush, sendMessage into the running loop's queue) from AgentDaemon itself.
 */
function scenario(
  options: { run?: Record<string, unknown>; afterTurn?: boolean; parent?: Partial<Task> } = {},
) {
  const run: Record<string, unknown> = {
    id: "run-1",
    kind: "delegation",
    rootTaskId: "parent-task",
    status: "running",
    maxParallel: 1,
    metadata: { createdBy: "spawn_agent" },
    ...options.run,
  };
  const node: OrchestrationGraphNode = {
    id: "node-1",
    runId: "run-1",
    key: "spawn-1",
    title: "Check the parser",
    prompt: "Check the parser",
    kind: "child_task",
    status: "running",
    dispatchTarget: "local_task",
    parentTaskId: "parent-task",
    taskId: "child-1",
    publicHandle: "child-1",
    createdAt: 1,
    updatedAt: 1,
  } as OrchestrationGraphNode;
  const child: Task = {
    ...parentTask,
    id: "child-1",
    title: "Check the parser",
    parentTaskId: "parent-task",
    agentType: "sub",
    depth: 1,
  };
  const parent: Task = { ...parentTask, ...options.parent };
  const tasks = new Map<string, Task>([
    [parent.id, parent],
    [child.id, child],
  ]);
  const pendingFollowUps: QueuedFollowUp[] = [];
  const events: Array<{ taskId: string; type: string; payload: Any }> = [];
  const work: Promise<unknown>[] = [];
  const logEvent = (taskId: string, type: string, payload: Any) =>
    events.push({ taskId, type, payload });

  const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
    shutdownRequested: false,
    taskRepo: { findById: (id: string) => tasks.get(id) },
    hasPendingUserDecisionForTask: () => false,
    eventRepo: {
      findByTaskIdAndTypes: (taskId: string, types: string[]) =>
        events.filter((event) => event.taskId === taskId && types.includes(event.type)),
    },
    getOrchestrationGraphRepository: () => ({
      findSnapshotByRunId: async () => ({ run, nodes: [node], edges: [] }),
    }),
    // The parent's loop is running, so the daemon queues the notice for its next iteration.
    getExecutorForTask: () => ({ runtime: { state: { queues: { pendingFollowUps } } } }),
    getExistingUserFollowUpResult: () => null,
    sendMessage: vi.fn(
      async (_taskId: string, message: string, _images: unknown, _quoted: unknown, opts: Any) => {
        opts.admissionGuard?.();
        pendingFollowUps.push({
          message,
          messageSource: opts.messageSource,
          notificationKind: opts.notificationKind,
          messageId: opts.messageId,
        });
        return { queued: true, deliveryMode: "follow_up", deliveryStatus: "queued" };
      },
    ),
    timelineRowsCommitted: async () => undefined,
    trackBackgroundWork: (promise: Promise<unknown>) => {
      work.push(promise);
      return promise;
    },
    logEvent,
  });
  // ToolRegistry's view of the daemon: the same state, without the rest of AgentDaemon.
  const toolDaemon = {
    logEvent,
    getTaskById: async (id: string) => tasks.get(id),
    getChildTasks: async () => [],
    listOrchestrationGraphsByRootTask: async () => [],
    // The run keeps whatever spawn_agent asked for, as the graph repository would.
    createOrchestrationGraphRun: vi.fn(async (params: { metadata?: Record<string, unknown> }) => {
      run.metadata = params.metadata;
      return { run, nodes: [node], edges: [] };
    }),
    findDelegatedNode: async (_root: string, handle: string) =>
      handle === node.publicHandle ? node : undefined,
    getOrchestrationGraphSnapshot: async () => ({ run, nodes: [node], edges: [] }),
    waitForDelegatedNode: vi.fn(async () => ({
      success: false,
      status: "timeout",
      message: "Timeout waiting for delegated work child-1 (15s)",
      error: "TIMEOUT",
    })),
    canReceiveCompletionAfterTurn: () => options.afterTurn ?? true,
  };

  /** The child finishes: the graph engine reports its node, and the daemon pushes it. */
  const finishChild = async (status: "completed" | "failed", resultSummary: string) => {
    node.status = status;
    node.output = resultSummary;
    tasks.set(child.id, { ...child, status, resultSummary });
    await daemon.notifySpawnedAgentCompletion({
      runId: run.id,
      nodeId: node.id,
      taskId: child.id,
      publicHandle: node.publicHandle,
      status,
      summary: resultSummary,
      result: resultSummary,
      target: "local_task",
    });
    await Promise.all(work);
  };

  const registry = new ToolRegistry(workspace, toolDaemon as Any, "parent-task");
  return { daemon, toolDaemon, registry, node, pendingFollowUps, events, finishChild };
}

describe("spawn_agent results arrive as events", () => {
  it("injects a queued user follow-up at the next iteration before the child's completion arrives", async () => {
    const s = scenario();
    const injected: Array<{ iteration: number; text: string; kind?: string }> = [];
    let waitResult: Any;
    let waitMs = -1;
    let childPushesWhenUserFollowUpInjected = -1;

    // The model spawns a child, checks on it once, and finishes once the result has arrived.
    const script = [
      { tool: "spawn_agent", input: { prompt: "Check the parser against the fixtures" } },
      { tool: "wait_for_agent", input: { task_id: "child-1" } },
      { text: "Both done." },
    ];

    const kernel = new TurnKernel(
      { mode: "follow_up", messages: [], maxIterations: 5, maxEmptyResponses: 2 },
      {
        drainPendingMessages: (state: TurnKernelIterationState) => {
          // As the executor does: drain everything queued at the start of the iteration.
          for (const item of s.pendingFollowUps.splice(0)) {
            const text = runningTurnUpdateText(item);
            state.messages.push({ role: "user", content: text });
            if (item.messageSource === "user")
              childPushesWhenUserFollowUpInjected = s.daemon.sendMessage.mock.calls.length;
            injected.push({
              iteration: state.iterationCount + 1,
              text,
              kind: item.notificationKind,
            });
          }
        },
        requestResponse: async (state) => ({
          response: script[state.iterationCount - 1],
          availableTools: [],
        }),
        handleResponse: async (prepared, state) => {
          const step = prepared.response as { tool?: string; input?: Any; text?: string };
          if (!step.tool) return { continueLoop: false };
          const startedAt = Date.now();
          const result = await s.registry.executeTool(step.tool, step.input);
          if (step.tool === "spawn_agent") {
            expect(result).toMatchObject({ success: true, task_id: "child-1" });
            // The user types while the parent is still working.
            s.pendingFollowUps.push({
              message: "Also update the changelog",
              messageSource: "user",
            });
          }
          if (step.tool === "wait_for_agent") {
            waitMs = Date.now() - startedAt;
            waitResult = result;
            // The child finishes only after the parent's loop has moved on.
            await s.finishChild("completed", "Parser handles all 12 fixtures.");
          }
          state.messages.push({ role: "assistant", content: JSON.stringify(result) });
          return { continueLoop: true };
        },
      },
    );

    const outcome = await kernel.run();

    expect(outcome.iterations).toBe(3);
    expect(injected).toEqual([
      { iteration: 2, text: "USER UPDATE: Also update the changelog", kind: undefined },
      {
        iteration: 3,
        text: expect.stringContaining(
          "RUNTIME NOTICE: Agent Check the parser (task child-1) finished with status completed.",
        ),
        kind: "agent_output",
      },
    ]);
    expect(injected[1].text).toContain("Parser handles all 12 fixtures.");
    // The user's follow-up did not wait for the child: nothing had been pushed yet.
    expect(childPushesWhenUserFollowUpInjected).toBe(0);
    // wait_for_agent returned at once instead of polling for up to 300 s.
    expect(waitResult).toMatchObject({ success: true, status: "running", task_id: "child-1" });
    expect(waitResult.message).toMatch(/^Running; its result will arrive automatically/);
    expect(waitMs).toBeLessThan(1000);
    expect(s.toolDaemon.waitForDelegatedNode).not.toHaveBeenCalled();
    expect(s.daemon.sendMessage).toHaveBeenCalledTimes(1);
    expect(s.daemon.sendMessage.mock.calls[0][4]).toMatchObject({
      messageSource: "agent",
      notificationKind: "agent_output",
      messageId: "agent-result-child-1",
    });
    expect(s.events.filter((event) => event.type === "agent_completed")).toHaveLength(1);
  });

  it("marks the spawn for push delivery and says polling is unnecessary", async () => {
    const s = scenario();
    const spawned = await s.registry.executeTool("spawn_agent", { prompt: "Check the parser" });
    expect(s.toolDaemon.createOrchestrationGraphRun.mock.calls[0][0].metadata).toEqual({
      createdBy: "spawn_agent",
    });
    expect(spawned.message).toContain("arrive automatically");
    expect(spawned.message).toContain("do not poll");
  });

  it("keeps wait: true inline so its result is not pushed a second time", async () => {
    const s = scenario({
      run: { metadata: { createdBy: "spawn_agent", resultDelivery: "inline" } },
    });
    s.toolDaemon.waitForDelegatedNode.mockResolvedValueOnce({
      success: true,
      status: "completed",
      message: "Delegated work completed successfully",
      resultSummary: "done",
    });
    const result = await s.registry.executeTool("spawn_agent", {
      prompt: "Check the parser",
      wait: true,
    });
    expect(s.toolDaemon.createOrchestrationGraphRun.mock.calls[0][0].metadata).toEqual({
      createdBy: "spawn_agent",
      resultDelivery: "inline",
    });
    expect(result).toMatchObject({ success: true, result: "done" });
    await s.finishChild("completed", "done");
    expect(s.daemon.sendMessage).not.toHaveBeenCalled();
  });

  it("short-waits at most 15 seconds when the caller passes a timeout", async () => {
    const s = scenario();
    const result = await s.registry.executeTool("wait_for_agent", {
      task_id: "child-1",
      timeout_seconds: 300,
    });
    expect(s.toolDaemon.waitForDelegatedNode).toHaveBeenCalledWith("parent-task", "child-1", 15);
    expect(result).toMatchObject({ success: true, status: "running" });

    s.toolDaemon.waitForDelegatedNode.mockClear();
    await s.registry.executeTool("wait_for_agent", { task_id: "child-1", timeout_seconds: 4 });
    expect(s.toolDaemon.waitForDelegatedNode).toHaveBeenCalledWith("parent-task", "child-1", 4);
  });

  it("returns a finished child's result at once", async () => {
    const s = scenario();
    s.node.status = "failed";
    s.node.error = "Fixture 7 timed out";
    const result = await s.registry.executeTool("wait_for_agent", { task_id: "child-1" });
    expect(result).toMatchObject({
      success: false,
      status: "failed",
      error: "Fixture 7 timed out",
    });
    expect(s.toolDaemon.waitForDelegatedNode).not.toHaveBeenCalled();
  });

  it("tells a task that ends with its turn to keep working rather than end", async () => {
    const s = scenario({ afterTurn: false });
    const result = await s.registry.executeTool("wait_for_agent", { task_id: "child-1" });
    expect(result.status).toBe("running");
    expect(result.message).toContain("This task ends when your turn ends");
    expect(result.message).toContain("timeout_seconds (at most 15)");
  });

  it("still waits for an agent whose result is not pushed", async () => {
    const s = scenario({ run: { metadata: { createdBy: "orchestrate_agents" } } });
    s.toolDaemon.waitForDelegatedNode.mockResolvedValueOnce({
      success: true,
      status: "completed",
      message: "Delegated work completed successfully",
      resultSummary: "done",
      node: s.node,
    });
    const result = await s.registry.executeTool("wait_for_agent", { task_id: "child-1" });
    expect(s.toolDaemon.waitForDelegatedNode).toHaveBeenCalledWith("parent-task", "child-1", 300);
    expect(result).toMatchObject({ success: true, status: "completed", result_summary: "done" });
  });

  it("describes event delivery in the spawn_agent and wait_for_agent tools", () => {
    const s = scenario();
    const tools = s.registry.getTools();
    const spawn = tools.find((tool) => tool.name === "spawn_agent")!;
    const wait = tools.find((tool) => tool.name === "wait_for_agent")!;
    expect(spawn.description).toContain("arrives in this session automatically as an event");
    expect(spawn.description).toContain("polling with wait_for_agent is unnecessary");
    expect(wait.description).toContain("do not poll");
    expect(wait.description).toContain("at most 15");
    expect(tools.some((tool) => tool.name === "get_agent_status")).toBe(true);
  });
});
