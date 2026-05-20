import { EventEmitter } from "events";
import { v4 as uuidv4 } from "uuid";
import type { Task, AgentConfig, OrchestrationGraphNode, OrchestrationGraphRun, OrchestrationNodeNotification, WorkerRoleKind } from "../../../shared/types";
import { getACPRegistry } from "../../acp";
import { RemoteAgentInvoker } from "../../acp/remote-invoker";
import { OrchestrationGraphRepository, type OrchestrationGraphSnapshot } from "./OrchestrationGraphRepository";

interface AgentRoleLike {
  id: string;
  name: string;
  displayName: string;
  description?: string;
  icon: string;
  capabilities: string[];
  isActive: boolean;
}

export interface OrchestrationGraphNodeInput {
  id?: string;
  key?: string;
  title: string;
  prompt: string;
  kind: OrchestrationGraphNode["kind"];
  dispatchTarget: OrchestrationGraphNode["dispatchTarget"];
  workerRole?: WorkerRoleKind;
  parentTaskId?: string;
  assignedAgentRoleId?: string;
  capabilityHint?: OrchestrationGraphNode["capabilityHint"];
  acpAgentId?: string;
  agentConfig?: AgentConfig;
  teamRunId?: string;
  teamItemId?: string;
  workflowPhaseId?: string;
  acpTaskId?: string;
  metadata?: Record<string, unknown>;
}

export interface OrchestrationGraphCreateInput {
  rootTaskId: string;
  workspaceId: string;
  kind: OrchestrationGraphRun["kind"];
  maxParallel: number;
  metadata?: Record<string, unknown>;
  nodes: OrchestrationGraphNodeInput[];
  edges?: Array<{ fromNodeKey: string; toNodeKey: string }>;
}

export interface OrchestrationGraphEngineDeps {
    createChildTask: (params: {
      title: string;
      prompt: string;
      workspaceId: string;
      parentTaskId: string;
      agentType: "sub" | "parallel";
      agentConfig?: AgentConfig;
      depth?: number;
      assignedAgentRoleId?: string;
      workerRole?: WorkerRoleKind;
      teamRunId?: string;
      teamItemId?: string;
    }) => Promise<Task>;
    createRootTask: (params: {
      title: string;
      prompt: string;
      workspaceId: string;
      assignedAgentRoleId?: string;
      workerRole?: WorkerRoleKind;
      agentConfig?: AgentConfig;
      source?: Task["source"];
    }) => Promise<Task>;
  getTaskById: (taskId: string) => Promise<Task | undefined>;
  cancelTask: (taskId: string) => Promise<void>;
  getActiveAgentRoles: () => AgentRoleLike[];
  emitRootEvent?: (rootTaskId: string, eventType: string, payload: Record<string, unknown>) => void;
}

function isTerminalNodeStatus(status: OrchestrationGraphNode["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "blocked";
}

function summarizeTask(task: Task): string {
  if (typeof task.resultSummary === "string" && task.resultSummary.trim()) {
    return task.resultSummary.trim();
  }
  if (typeof task.error === "string" && task.error.trim()) {
    return task.error.trim();
  }
  return `Task ${task.status}`;
}

function notificationToPayload(notification: OrchestrationNodeNotification): Record<string, unknown> {
  return {
    runId: notification.runId,
    nodeId: notification.nodeId,
    taskId: notification.taskId,
    remoteTaskId: notification.remoteTaskId,
    publicHandle: notification.publicHandle,
    status: notification.status,
    summary: notification.summary,
    result: notification.result,
    usage: notification.usage,
    error: notification.error,
    target: notification.target,
    workerRole: notification.workerRole,
    semanticSummary: notification.semanticSummary,
    verificationVerdict: notification.verificationVerdict,
    verificationReport: notification.verificationReport,
  };
}

export class OrchestrationGraphEngine extends EventEmitter {
  private readonly repo: OrchestrationGraphRepository;
  private readonly remoteInvoker = new RemoteAgentInvoker();
  private reconcileTimer: NodeJS.Timeout | null = null;
  private readonly runLocks = new Set<string>();

  constructor(
    db: import("better-sqlite3").Database,
    private readonly deps: OrchestrationGraphEngineDeps,
  ) {
    super();
    this.repo = new OrchestrationGraphRepository(db);
  }

  getRepository(): OrchestrationGraphRepository {
    return this.repo;
  }

  start(): void {
    if (this.reconcileTimer) return;
    this.reconcileTimer = setInterval(() => {
      void this.resumeRunningRuns();
    }, 1500);
  }

  stop(): void {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
  }

  async createRun(input: OrchestrationGraphCreateInput): Promise<OrchestrationGraphSnapshot> {
    const runId = uuidv4();
    const nodeIdByKey = new Map<string, string>();
    const nodes = input.nodes.map((node, index) => {
      const id = node.id ?? uuidv4();
      const key = node.key || node.teamItemId || node.workflowPhaseId || node.acpTaskId || `node-${index + 1}`;
      nodeIdByKey.set(key, id);
      return {
        id,
        key,
        title: node.title,
        prompt: node.prompt,
        kind: node.kind,
        status: "pending" as const,
        dispatchTarget: node.dispatchTarget,
        workerRole: node.workerRole,
        parentTaskId: node.parentTaskId,
        assignedAgentRoleId: node.assignedAgentRoleId,
        capabilityHint: node.capabilityHint,
        acpAgentId: node.acpAgentId,
        agentConfig: node.agentConfig,
        teamRunId: node.teamRunId,
        teamItemId: node.teamItemId,
        workflowPhaseId: node.workflowPhaseId,
        acpTaskId: node.acpTaskId,
        metadata: node.metadata,
      };
    });
    const edges = (input.edges || []).flatMap((edge) => {
      const fromNodeId = nodeIdByKey.get(edge.fromNodeKey);
      const toNodeId = nodeIdByKey.get(edge.toNodeKey);
      if (!fromNodeId || !toNodeId) return [];
      return [{ fromNodeId, toNodeId }];
    });
    const snapshot = this.repo.createRun({
      run: {
        id: runId,
        rootTaskId: input.rootTaskId,
        workspaceId: input.workspaceId,
        kind: input.kind,
        status: "running",
        maxParallel: Math.max(1, input.maxParallel || 1),
        metadata: input.metadata,
      },
      nodes,
      edges,
    });
    this.emitRootEvent(snapshot.run.rootTaskId, "orchestration_run_created", {
      runId: snapshot.run.id,
      kind: snapshot.run.kind,
      nodeCount: snapshot.nodes.length,
    });
    await this.tickRun(snapshot.run.id);
    return this.repo.findSnapshotByRunId(snapshot.run.id)!;
  }

  async appendNodes(input: {
    runId: string;
    nodes: OrchestrationGraphNodeInput[];
    edges?: Array<{ fromNodeId?: string; fromNodeKey?: string; toNodeId?: string; toNodeKey?: string }>;
  }): Promise<OrchestrationGraphSnapshot | undefined> {
    const existing = this.repo.findSnapshotByRunId(input.runId);
    if (!existing) return undefined;
    const nodeIdByKey = new Map(existing.nodes.map((node) => [node.key, node.id]));
    const nodes = input.nodes.map((node, index) => {
      const id = node.id ?? uuidv4();
      const key = node.key || node.teamItemId || node.workflowPhaseId || node.acpTaskId || `node-${existing.nodes.length + index + 1}`;
      nodeIdByKey.set(key, id);
      return {
        id,
        key,
        title: node.title,
        prompt: node.prompt,
        kind: node.kind,
        status: "pending" as const,
        dispatchTarget: node.dispatchTarget,
        workerRole: node.workerRole,
        parentTaskId: node.parentTaskId,
        assignedAgentRoleId: node.assignedAgentRoleId,
        capabilityHint: node.capabilityHint,
        acpAgentId: node.acpAgentId,
        agentConfig: node.agentConfig,
        teamRunId: node.teamRunId,
        teamItemId: node.teamItemId,
        workflowPhaseId: node.workflowPhaseId,
        acpTaskId: node.acpTaskId,
        metadata: node.metadata,
      };
    });
    const edges = (input.edges || []).flatMap((edge) => {
      const fromNodeId = edge.fromNodeId || (edge.fromNodeKey ? nodeIdByKey.get(edge.fromNodeKey) : undefined);
      const toNodeId = edge.toNodeId || (edge.toNodeKey ? nodeIdByKey.get(edge.toNodeKey) : undefined);
      if (!fromNodeId || !toNodeId) return [];
      return [{ fromNodeId, toNodeId }];
    });
    const updated = this.repo.appendNodes({
      runId: input.runId,
      nodes,
      edges,
    });
    if (updated) {
      await this.tickRun(updated.run.id);
    }
    return updated;
  }

  async resumeRunningRuns(): Promise<void> {
    const runs = this.repo.listRunningSnapshots();
    for (const snapshot of runs) {
      await this.tickRun(snapshot.run.id);
    }
  }

  async tickRun(runId: string): Promise<OrchestrationGraphSnapshot | undefined> {
    if (this.runLocks.has(runId)) {
      return this.repo.findSnapshotByRunId(runId);
    }
    this.runLocks.add(runId);
    try {
      let snapshot = this.repo.findSnapshotByRunId(runId);
      if (!snapshot || snapshot.run.status !== "running") return snapshot;

      await this.reconcileActiveNodes(snapshot);
      snapshot = this.repo.findSnapshotByRunId(runId);
      if (!snapshot || snapshot.run.status !== "running") return snapshot;

      const readyNodes = this.computeReadyNodes(snapshot);
      for (const node of readyNodes) {
        this.repo.updateNode(node.id, { status: "ready" });
        this.emitRootEvent(snapshot.run.rootTaskId, "orchestration_node_ready", {
          runId: snapshot.run.id,
          nodeId: node.id,
          title: node.title,
          kind: node.kind,
        });
      }

      snapshot = this.repo.findSnapshotByRunId(runId);
      if (!snapshot || snapshot.run.status !== "running") return snapshot;

      const activeCount = snapshot.nodes.filter((node) => node.status === "running").length;
      const capacity = Math.max(0, snapshot.run.maxParallel - activeCount);
      const dispatchable = snapshot.nodes
        .filter((node) => node.status === "ready")
        .slice(0, capacity);
      for (const node of dispatchable) {
        await this.dispatchNode(snapshot.run, node);
      }

      snapshot = this.repo.findSnapshotByRunId(runId);
      if (!snapshot) return snapshot;
      await this.finalizeRunIfTerminal(snapshot);
      return this.repo.findSnapshotByRunId(runId);
    } finally {
      this.runLocks.delete(runId);
    }
  }

  resolveHandle(rootTaskId: string, handle: string): OrchestrationGraphNode | undefined {
    return this.repo.findNodeByHandle(rootTaskId, handle);
  }

  async waitForHandle(
    rootTaskId: string,
    handle: string,
    timeoutSeconds: number,
  ): Promise<{
    success: boolean;
    status: string;
    message: string;
    resultSummary?: string;
    error?: string;
    node?: OrchestrationGraphNode;
  }> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      const node = this.resolveHandle(rootTaskId, handle);
      if (!node) {
        return {
          success: false,
          status: "not_found",
          message: `Delegated node ${handle} not found`,
          error: "TASK_NOT_FOUND",
        };
      }
      const snapshot = this.repo.findSnapshotByRunId(node.runId);
      if (snapshot?.run.status === "running") {
        await this.tickRun(node.runId);
      }
      const refreshed = this.resolveHandle(rootTaskId, handle);
      if (!refreshed) {
        return {
          success: false,
          status: "not_found",
          message: `Delegated node ${handle} not found`,
          error: "TASK_NOT_FOUND",
        };
      }
      if (isTerminalNodeStatus(refreshed.status)) {
        const success = refreshed.status === "completed";
        return {
          success,
          status: refreshed.status,
          message: success
            ? "Delegated work completed successfully"
            : `Delegated work ${refreshed.status}`,
          resultSummary: refreshed.summary || refreshed.output,
          error: refreshed.error,
          node: refreshed,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return {
      success: false,
      status: "timeout",
      message: `Timeout waiting for delegated work ${handle} (${timeoutSeconds}s)`,
      error: "TIMEOUT",
    };
  }

  async cancelHandle(rootTaskId: string, handle: string): Promise<boolean> {
    const node = this.resolveHandle(rootTaskId, handle);
    if (!node) return false;
    if (node.taskId) {
      await this.deps.cancelTask(node.taskId);
    } else if (node.acpAgentId && node.remoteTaskId) {
      const agent = getACPRegistry().getAgent(node.acpAgentId, this.deps.getActiveAgentRoles());
      if (agent?.origin === "remote" && agent.endpoint) {
        await this.remoteInvoker.cancel(agent, node.remoteTaskId);
      }
    }
    this.repo.updateNode(node.id, {
      status: "cancelled",
      error: node.error || "Cancelled",
      completedAt: Date.now(),
      summary: node.summary || "Cancelled",
    });
    await this.tickRun(node.runId);
    return true;
  }

  private computeReadyNodes(snapshot: OrchestrationGraphSnapshot): OrchestrationGraphNode[] {
    const terminalNodeIds = new Set(
      snapshot.nodes.filter((node) => node.status === "completed").map((node) => node.id),
    );
    const blockedNodeIds = new Set(
      snapshot.nodes.filter((node) => node.status === "failed" || node.status === "cancelled").map((node) => node.id),
    );
    const incomingByTarget = new Map<string, string[]>();
    for (const edge of snapshot.edges) {
      const existing = incomingByTarget.get(edge.toNodeId) || [];
      existing.push(edge.fromNodeId);
      incomingByTarget.set(edge.toNodeId, existing);
    }
    return snapshot.nodes.filter((node) => {
      if (node.status !== "pending") return false;
      const incoming = incomingByTarget.get(node.id) || [];
      if (incoming.some((from) => blockedNodeIds.has(from))) {
        this.repo.updateNode(node.id, {
          status: "blocked",
          error: "Dependency failed or was cancelled",
          completedAt: Date.now(),
          summary: "Blocked by failed dependency",
        });
        return false;
      }
      return incoming.every((from) => terminalNodeIds.has(from));
    });
  }

  private async dispatchNode(run: OrchestrationGraphRun, node: OrchestrationGraphNode): Promise<void> {
    try {
      const prompt = this.buildPromptWithDependencyContext(run.id, node);
      if (node.dispatchTarget === "remote_acp") {
        await this.dispatchRemoteAcpNode(run, { ...node, prompt });
        return;
      }

      if (node.dispatchTarget === "local_role" && node.parentTaskId === undefined) {
        const task = await this.deps.createRootTask({
          title: node.title,
          prompt,
          workspaceId: run.workspaceId,
          assignedAgentRoleId: node.assignedAgentRoleId,
          workerRole: node.workerRole,
          agentConfig: node.agentConfig,
          source: "api",
        });
        this.markNodeRunning(run, node, task.id);
        return;
      }

      const child = await this.deps.createChildTask({
        title: node.title,
        prompt,
        workspaceId: run.workspaceId,
        parentTaskId: node.parentTaskId || run.rootTaskId,
        agentType: "sub",
        agentConfig: node.agentConfig,
        workerRole: node.workerRole,
        depth:
          typeof node.metadata?.depth === "number" && Number.isFinite(node.metadata.depth)
            ? Math.max(1, Math.floor(node.metadata.depth))
            : undefined,
        assignedAgentRoleId: node.assignedAgentRoleId,
        teamRunId: node.teamRunId,
        teamItemId: node.teamItemId,
      });
      this.markNodeRunning(run, node, child.id);
    } catch (error: Any) {
      const message = error?.message || String(error);
      const updated = this.repo.updateNode(node.id, {
        status: "failed",
        error: message,
        summary: message,
        completedAt: Date.now(),
      });
      const notification = this.buildNotification(run.id, updated || node, "failed");
      this.repo.createNodeEvent(run.id, node.id, "orchestration_node_failed", notificationToPayload(notification));
      this.emit("node_notification", notification);
      this.emitRootEvent(run.rootTaskId, "orchestration_node_failed", notificationToPayload(notification));
    }
  }

  private markNodeRunning(run: OrchestrationGraphRun, node: OrchestrationGraphNode, taskId: string): void {
    const updated = this.repo.updateNode(node.id, {
      status: "running",
      taskId,
      publicHandle: taskId,
      startedAt: Date.now(),
      summary: `Dispatched: ${node.title}`,
    });
    const effectiveNode = updated || node;
    const notification = this.buildNotification(run.id, effectiveNode, "running");
    this.repo.createNodeEvent(run.id, node.id, "orchestration_node_dispatched", notificationToPayload(notification));
    this.emit("node_notification", notification);
    this.emitRootEvent(run.rootTaskId, "orchestration_node_dispatched", {
      ...notificationToPayload(notification),
      handle: taskId,
    });
  }

  private async dispatchRemoteAcpNode(run: OrchestrationGraphRun, node: OrchestrationGraphNode): Promise<void> {
    const acpAgentId = node.acpAgentId;
    if (!acpAgentId) {
      throw new Error("Remote ACP node is missing acpAgentId");
    }
    const agent = getACPRegistry().getAgent(acpAgentId, this.deps.getActiveAgentRoles());
    if (!agent || agent.origin !== "remote" || !agent.endpoint) {
      throw new Error(`ACP agent ${acpAgentId} is unavailable`);
    }
    const result = await this.remoteInvoker.invoke(agent, {
      assigneeId: acpAgentId,
      title: node.title,
      prompt: node.prompt,
      workspaceId: run.workspaceId,
    });
    const terminal =
      result.status === "completed" || result.status === "failed" || result.status === "cancelled";
    const updated = this.repo.updateNode(node.id, {
      status: terminal ? result.status : "running",
      remoteTaskId: result.remoteTaskId,
      publicHandle: result.remoteTaskId,
      startedAt: Date.now(),
      summary:
        result.status === "completed"
          ? result.result || "Remote ACP task completed"
          : result.status === "running"
            ? `Remote ACP task running via ${agent.name}`
            : result.error || `Remote ACP task ${result.status}`,
      output: result.status === "completed" ? result.result : undefined,
      error: result.status === "failed" || result.status === "cancelled" ? result.error : undefined,
      completedAt: terminal ? Date.now() : undefined,
    });
    const effectiveNode = updated || node;
    const notification = this.buildNotification(
      run.id,
      effectiveNode,
      terminal ? (effectiveNode.status as OrchestrationNodeNotification["status"]) : "running",
    );
    this.repo.createNodeEvent(
      run.id,
      node.id,
      terminal ? "orchestration_node_completed" : "orchestration_node_dispatched",
      notificationToPayload(notification),
    );
    this.emit("node_notification", notification);
    this.emitRootEvent(
      run.rootTaskId,
      terminal ? (effectiveNode.status === "completed" ? "orchestration_node_completed" : "orchestration_node_failed") : "orchestration_node_dispatched",
      notificationToPayload(notification),
    );
  }

  private async reconcileActiveNodes(snapshot: OrchestrationGraphSnapshot): Promise<void> {
    for (const node of snapshot.nodes) {
      if (node.status !== "running") continue;
      if (node.taskId) {
        const task = await this.deps.getTaskById(node.taskId);
        if (!task) continue;
        if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
          const nextStatus =
            task.status === "completed"
              ? "completed"
              : task.status === "cancelled"
                ? "cancelled"
                : "failed";
          const updated = this.repo.updateNode(node.id, {
            status: nextStatus,
            summary: summarizeTask(task),
            output: task.resultSummary,
            error: typeof task.error === "string" ? task.error : undefined,
            completedAt: Date.now(),
          });
          const effectiveNode = updated || node;
          const notification = this.buildNotification(
            snapshot.run.id,
            effectiveNode,
            nextStatus,
          );
          this.repo.createNodeEvent(
            snapshot.run.id,
            node.id,
            nextStatus === "completed" ? "orchestration_node_completed" : "orchestration_node_failed",
            notificationToPayload(notification),
          );
          this.emit("node_notification", notification);
          this.emitRootEvent(
            snapshot.run.rootTaskId,
            nextStatus === "completed" ? "orchestration_node_completed" : "orchestration_node_failed",
            notificationToPayload(notification),
          );
        }
        continue;
      }
      if (node.acpAgentId && node.remoteTaskId) {
        const agent = getACPRegistry().getAgent(node.acpAgentId, this.deps.getActiveAgentRoles());
        if (!agent || agent.origin !== "remote" || !agent.endpoint) continue;
        const result = await this.remoteInvoker.pollStatus(agent, node.remoteTaskId);
        if (result.status === "running" || result.status === "pending") continue;
        const nextStatus =
          result.status === "completed"
            ? "completed"
            : result.status === "cancelled"
              ? "cancelled"
              : "failed";
        const updated = this.repo.updateNode(node.id, {
          status: nextStatus,
          summary: result.result || result.error || `Remote ACP task ${result.status}`,
          output: result.result,
          error: result.error,
          completedAt: Date.now(),
        });
        const effectiveNode = updated || node;
        const notification = this.buildNotification(
          snapshot.run.id,
          effectiveNode,
          nextStatus,
        );
        this.repo.createNodeEvent(
          snapshot.run.id,
          node.id,
          nextStatus === "completed" ? "orchestration_node_completed" : "orchestration_node_failed",
          notificationToPayload(notification),
        );
        this.emit("node_notification", notification);
        this.emitRootEvent(
          snapshot.run.rootTaskId,
          nextStatus === "completed" ? "orchestration_node_completed" : "orchestration_node_failed",
          notificationToPayload(notification),
        );
      }
    }
  }

  private async finalizeRunIfTerminal(snapshot: OrchestrationGraphSnapshot): Promise<void> {
    if (snapshot.nodes.some((node) => !isTerminalNodeStatus(node.status))) return;
    const hasFailure = snapshot.nodes.some(
      (node) => node.status === "failed" || node.status === "cancelled" || node.status === "blocked",
    );
    const status = hasFailure ? "failed" : "completed";
    const updated = this.repo.updateRun(snapshot.run.id, {
      status,
      completedAt: Date.now(),
    });
    const summary = {
      runId: snapshot.run.id,
      status,
      total: snapshot.nodes.length,
      completed: snapshot.nodes.filter((node) => node.status === "completed").length,
      failed: snapshot.nodes.filter((node) => node.status !== "completed").length,
    };
    this.emitRootEvent(
      snapshot.run.rootTaskId,
      status === "completed" ? "orchestration_run_completed" : "orchestration_run_failed",
      summary,
    );
    this.emit("run_terminal", {
      ...summary,
      run: updated || snapshot.run,
    });
  }

  private buildNotification(
    runId: string,
    node: OrchestrationGraphNode,
    status: OrchestrationNodeNotification["status"],
  ): OrchestrationNodeNotification {
    return {
      runId,
      nodeId: node.id,
      taskId: node.taskId,
      remoteTaskId: node.remoteTaskId,
      publicHandle: node.publicHandle,
      status,
      summary: node.summary || node.output || node.error || `${node.title}: ${status}`,
      result: node.output,
      error: node.error,
      target: node.dispatchTarget,
      workerRole: node.workerRole,
      semanticSummary: node.semanticSummary,
      verificationVerdict: node.verificationVerdict,
      verificationReport: node.verificationReport,
    };
  }

  private emitRootEvent(rootTaskId: string, eventType: string, payload: Record<string, unknown>): void {
    if (!rootTaskId) return;
    this.deps.emitRootEvent?.(rootTaskId, eventType, payload);
  }

  private buildPromptWithDependencyContext(runId: string, node: OrchestrationGraphNode): string {
    const snapshot = this.repo.findSnapshotByRunId(runId);
    if (!snapshot) return node.prompt;
    const predecessorIds = snapshot.edges
      .filter((edge) => edge.toNodeId === node.id)
      .map((edge) => edge.fromNodeId);
    if (predecessorIds.length === 0) return node.prompt;
    const predecessors = snapshot.nodes.filter((candidate) => predecessorIds.includes(candidate.id));
    const completedOutputs = predecessors
      .map((candidate, index) => {
        const text = candidate.output || candidate.summary || "";
        if (!text.trim()) return "";
        return `Dependency ${index + 1} (${candidate.title}) output:\n---\n${text}\n---`;
      })
      .filter(Boolean);
    if (completedOutputs.length === 0) return node.prompt;
    return [
      "You are executing a dependency-aware orchestration node.",
      "",
      ...completedOutputs,
      "",
      "Your task:",
      node.prompt,
    ].join("\n");
  }
}
