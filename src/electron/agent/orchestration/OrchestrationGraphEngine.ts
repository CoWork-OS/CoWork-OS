import { GraphTaskAdmissionClosedError, type GraphTaskAdmission } from "./graph-task-admission";
import { serviceStatements } from "../../database/service-statements";
import type Database from "better-sqlite3";
import { EventEmitter } from "events";
import { v4 as uuidv4 } from "uuid";
import type {
  Task,
  AgentConfig,
  OrchestrationGraphNode,
  OrchestrationGraphRun,
  OrchestrationNodeNotification,
  WorkerRoleKind,
} from "../../../shared/types";
import { getACPRegistry, type ACPAgentCard } from "../../acp";
import { RemoteAgentInvoker } from "../../acp/remote-invoker";
import { redactSecrets } from "../../memory/sensitive-content";
import type { RemoteAcpAdmissionGate, RemoteAcpDispatchRequest } from "./remote-acp-admission";
import {
  type OrchestrationDispatchClaim,
  type OrchestrationNodeCancellationAttempt,
  type OrchestrationGraphSnapshot,
} from "./OrchestrationGraphRepository";
import { OrchestrationGraphRepository } from "./orchestration-graph-repository-facades";

const activeDispatchClaimIds = new Set<string>();
const activeRunCancellationIds = new Set<string>();

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
    graphAdmission?: GraphTaskAdmission;
  }) => Promise<Task>;
  createRootTask: (params: {
    title: string;
    prompt: string;
    workspaceId: string;
    assignedAgentRoleId?: string;
    workerRole?: WorkerRoleKind;
    agentConfig?: AgentConfig;
    source?: Task["source"];
    graphAdmission?: GraphTaskAdmission;
  }) => Promise<Task>;
  getTaskById: (taskId: string) => Promise<Task | undefined>;
  cancelTask: (taskId: string) => Promise<void>;
  getActiveAgentRoles: () => AgentRoleLike[];
  /**
   * Required admission for `remote_acp` nodes. Remote dispatch skips the tool
   * policy and approval middleware local nodes run under, so every remote send
   * needs an explicit decision here first (see remote-acp-admission.ts).
   */
  remoteAcpAdmission: RemoteAcpAdmissionGate;
  emitRootEvent?: (rootTaskId: string, eventType: string, payload: Record<string, unknown>) => void;
}

function isTerminalNodeStatus(status: OrchestrationGraphNode["status"]): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled" || status === "blocked"
  );
}

function dispatchClaimForNode(
  node: OrchestrationGraphNode,
): OrchestrationDispatchClaim | undefined {
  const claim = node.metadata?.dispatchClaim;
  return claim && typeof claim === "object" && "id" in claim
    ? (claim as OrchestrationDispatchClaim)
    : undefined;
}

function taskGraphStatus(
  task: Task,
): Extract<OrchestrationGraphNode["status"], "completed" | "failed" | "cancelled"> | undefined {
  if (task.status === "completed") return "completed";
  if (task.status === "failed") return "failed";
  if (task.status === "cancelled") return "cancelled";
  return undefined;
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

function notificationToPayload(
  notification: OrchestrationNodeNotification,
): Record<string, unknown> {
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
    private readonly db: Database.Database,
    private readonly deps: OrchestrationGraphEngineDeps,
  ) {
    super();
    this.repo = new OrchestrationGraphRepository(db);
  }

  getRepository(): OrchestrationGraphRepository {
    return this.repo;
  }

  private reconciling = false;

  start(): void {
    if (this.reconcileTimer) return;
    this.reconcileTimer = setInterval(() => {
      // One pass at a time: under backpressure a slow pass must not queue more reads.
      if (this.reconciling) return;
      this.reconciling = true;
      void this.resumeRunningRuns()
        .catch((error: unknown) => {
          console.warn("[OrchestrationGraphEngine] Reconcile pass failed:", error);
        })
        .finally(() => {
          this.reconciling = false;
        });
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
      const key =
        node.key ||
        node.teamItemId ||
        node.workflowPhaseId ||
        node.acpTaskId ||
        `node-${index + 1}`;
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
    const snapshot = await this.repo.createRun({
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
    return (await this.repo.findSnapshotByRunId(snapshot.run.id))!;
  }

  async appendNodes(input: {
    runId: string;
    nodes: OrchestrationGraphNodeInput[];
    edges?: Array<{
      fromNodeId?: string;
      fromNodeKey?: string;
      toNodeId?: string;
      toNodeKey?: string;
    }>;
  }): Promise<OrchestrationGraphSnapshot | undefined> {
    const existing = await this.repo.findSnapshotByRunId(input.runId);
    if (!existing) return undefined;
    const nodeIdByKey = new Map(existing.nodes.map((node) => [node.key, node.id]));
    const nodes = input.nodes.map((node, index) => {
      const id = node.id ?? uuidv4();
      const key =
        node.key ||
        node.teamItemId ||
        node.workflowPhaseId ||
        node.acpTaskId ||
        `node-${existing.nodes.length + index + 1}`;
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
      const fromNodeId =
        edge.fromNodeId || (edge.fromNodeKey ? nodeIdByKey.get(edge.fromNodeKey) : undefined);
      const toNodeId =
        edge.toNodeId || (edge.toNodeKey ? nodeIdByKey.get(edge.toNodeKey) : undefined);
      if (!fromNodeId || !toNodeId) return [];
      return [{ fromNodeId, toNodeId }];
    });
    const updated = await this.repo.appendNodes({
      runId: input.runId,
      nodes,
      edges,
    });
    if (!updated) return updated;
    // Return the post-dispatch snapshot: callers (the team orchestrator's
    // synthesis step) read the appended node's taskId and status from it.
    return (await this.tickRun(updated.run.id)) ?? updated;
  }

  async resumeRunningRuns(): Promise<void> {
    const runs = await this.repo.listRunningSnapshots();
    for (const snapshot of runs) {
      await this.tickRun(snapshot.run.id);
    }
    await this.reconcileCancelledRuns();
  }

  private async reconcileCancelledRuns(): Promise<void> {
    for (const snapshot of await this.repo.listCancelledSnapshots()) {
      if (activeRunCancellationIds.has(snapshot.run.id)) continue;
      for (const node of snapshot.nodes) {
        if (node.status === "pending" || node.status === "ready") {
          await this.repo.cancelUnstartedNode(node.id, "Cancelled before dispatch");
          continue;
        }
        if (node.status !== "running") continue;

        const claim = dispatchClaimForNode(node);
        const cancellation = node.metadata?.cancellation as
          | OrchestrationNodeCancellationAttempt
          | undefined;
        const message =
          cancellation?.outcome === "in_flight"
            ? "Cancellation was interrupted before its outcome was persisted; task ownership is unresolved"
            : "Run admission closed before node cancellation was recorded; task ownership is unresolved";
        const updated = await this.repo.resolveInterruptedCancellation(
          node.id,
          claim?.id,
          cancellation?.requestId,
          message,
        );
        if (!updated) continue;
        const payload = {
          runId: snapshot.run.id,
          nodeId: node.id,
          taskId: updated.taskId,
          remoteTaskId: updated.remoteTaskId,
          status: updated.status,
          summary: updated.summary,
          error: updated.error,
          cancellation: updated.metadata?.cancellation,
        };
        await this.repo.createNodeEvent(
          snapshot.run.id,
          node.id,
          "orchestration_node_blocked",
          payload,
        );
        this.emitRootEvent(snapshot.run.rootTaskId, "orchestration_node_blocked", payload);
        this.emitBlockedNodeNotification(snapshot.run.id, updated);
      }
    }
  }

  async tickRun(runId: string): Promise<OrchestrationGraphSnapshot | undefined> {
    if (this.runLocks.has(runId)) {
      return await this.repo.findSnapshotByRunId(runId);
    }
    this.runLocks.add(runId);
    try {
      let snapshot = await this.repo.findSnapshotByRunId(runId);
      if (!snapshot || snapshot.run.status !== "running") return snapshot;

      await this.reconcileActiveNodes(snapshot);
      snapshot = await this.repo.findSnapshotByRunId(runId);
      if (!snapshot || snapshot.run.status !== "running") return snapshot;

      const readyNodes = await this.computeReadyNodes(snapshot);
      for (const node of readyNodes) {
        if (!(await this.repo.markNodeReady(node.id))) continue;
        this.emitRootEvent(snapshot.run.rootTaskId, "orchestration_node_ready", {
          runId: snapshot.run.id,
          nodeId: node.id,
          title: node.title,
          kind: node.kind,
        });
      }

      snapshot = await this.repo.findSnapshotByRunId(runId);
      if (!snapshot || snapshot.run.status !== "running") return snapshot;

      const activeCount = snapshot.nodes.filter((node) => node.status === "running").length;
      const capacity = Math.max(0, snapshot.run.maxParallel - activeCount);
      const dispatchable = snapshot.nodes
        .filter((node) => node.status === "ready")
        .slice(0, capacity);
      for (const node of dispatchable) {
        await this.dispatchNode(snapshot.run, node);
      }

      snapshot = await this.repo.findSnapshotByRunId(runId);
      if (!snapshot) return snapshot;
      if (snapshot.run.status !== "running") return snapshot;
      await this.finalizeRunIfTerminal(snapshot);
      return await this.repo.findSnapshotByRunId(runId);
    } finally {
      this.runLocks.delete(runId);
    }
  }

  async resolveHandle(
    rootTaskId: string,
    handle: string,
  ): Promise<OrchestrationGraphNode | undefined> {
    return await this.repo.findNodeByHandle(rootTaskId, handle);
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
      const node = await this.resolveHandle(rootTaskId, handle);
      if (!node) {
        return {
          success: false,
          status: "not_found",
          message: `Delegated node ${handle} not found`,
          error: "TASK_NOT_FOUND",
        };
      }
      const snapshot = await this.repo.findSnapshotByRunId(node.runId);
      if (snapshot?.run.status === "running") {
        await this.tickRun(node.runId);
      }
      const refreshed = await this.resolveHandle(rootTaskId, handle);
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
    const node = await this.resolveHandle(rootTaskId, handle);
    if (!node) return false;
    if (node.status === "completed" || node.status === "failed" || node.status === "cancelled") {
      return true;
    }
    if (node.status === "pending" || node.status === "ready") {
      const cancelled = await this.repo.cancelUnstartedNode(node.id, "Cancelled before dispatch");
      if (!cancelled || cancelled.status !== "cancelled") return false;
      await this.tickRun(node.runId);
      return true;
    }

    const stopped = await this.requestNodeCancellation(node, "Cancelled by delegated-work owner");
    await this.tickRun(node.runId);
    return stopped;
  }

  async cancelRunForRootTask(rootTaskId: string): Promise<{
    runIds: string[];
    acknowledgedNodeIds: string[];
    terminalNodeIds: string[];
    unresolvedNodeIds: string[];
  }> {
    const runIds = await this.repo.cancelRunningRunsForRootTask(rootTaskId);
    for (const runId of runIds) activeRunCancellationIds.add(runId);
    const result = {
      runIds,
      acknowledgedNodeIds: [] as string[],
      terminalNodeIds: [] as string[],
      unresolvedNodeIds: [] as string[],
    };
    try {
      const nodesToStop: OrchestrationGraphNode[] = [];

      for (const runId of result.runIds) {
        const closed = await this.repo.findSnapshotByRunId(runId);
        for (const node of closed?.nodes || []) {
          if (node.status === "pending" || node.status === "ready") {
            const cancelled = await this.repo.cancelUnstartedNode(
              node.id,
              "Cancelled before dispatch",
            );
            if (cancelled?.status === "cancelled") result.acknowledgedNodeIds.push(node.id);
            continue;
          }
          if (isTerminalNodeStatus(node.status)) {
            if (node.status === "blocked") result.unresolvedNodeIds.push(node.id);
            else result.terminalNodeIds.push(node.id);
            continue;
          }
          nodesToStop.push(node);
        }
      }

      const stopResults = await Promise.allSettled(
        nodesToStop.map(async (node) => ({
          nodeId: node.id,
          stopped: await this.requestNodeCancellation(node, "Parent task cancellation requested"),
        })),
      );
      for (let index = 0; index < stopResults.length; index += 1) {
        const stopped = stopResults[index];
        const nodeId = nodesToStop[index].id;
        const latest = await this.repo.findNodeById(nodeId);
        const cancellation = latest?.metadata?.cancellation as
          | OrchestrationNodeCancellationAttempt
          | undefined;
        if (stopped.status === "fulfilled" && stopped.value.stopped) {
          if (cancellation?.outcome === "acknowledged") result.acknowledgedNodeIds.push(nodeId);
          else result.terminalNodeIds.push(nodeId);
        } else {
          result.unresolvedNodeIds.push(nodeId);
        }
      }
      return result;
    } finally {
      for (const runId of runIds) activeRunCancellationIds.delete(runId);
    }
  }

  private async requestNodeCancellation(
    node: OrchestrationGraphNode,
    reason: string,
  ): Promise<boolean> {
    const requestId = uuidv4();
    const requestedAt = Date.now();
    const ownership = node.taskId ? "local" : node.remoteTaskId ? "remote" : "unknown";
    const attempt: OrchestrationNodeCancellationAttempt = {
      requestId,
      requestedAt,
      ownership,
      outcome: "in_flight",
    };
    const begun = await this.repo.beginNodeCancellation(node.id, attempt);
    if (!begun) return false;
    const dispatchClaimId = dispatchClaimForNode(begun)?.id;
    let status: OrchestrationGraphNode["status"] = "blocked";
    let outcome: OrchestrationNodeCancellationAttempt["outcome"] = "unresolved";
    let resultStatus: string | undefined;
    let error: string | undefined;
    let summary = `${reason}; ownership is unresolved`;

    if (node.taskId) {
      try {
        let task = await this.deps.getTaskById(node.taskId);
        if (!task) {
          error = `Local task ${node.taskId} could not be found; cancellation ownership is unresolved`;
        } else {
          let terminalStatus = taskGraphStatus(task);
          if (!terminalStatus) {
            await this.deps.cancelTask(node.taskId);
            task = await this.deps.getTaskById(node.taskId);
            terminalStatus = task ? taskGraphStatus(task) : undefined;
          }
          if (terminalStatus) {
            status = terminalStatus;
            outcome = terminalStatus === "cancelled" ? "acknowledged" : "already_terminal";
            resultStatus = terminalStatus;
            summary =
              terminalStatus === "cancelled"
                ? "Local task cancellation acknowledged"
                : `Local task was already terminal (${terminalStatus})`;
          } else {
            error = `Local task ${node.taskId} did not confirm a terminal cancellation state`;
          }
        }
      } catch (cancelError) {
        error = cancelError instanceof Error ? cancelError.message : String(cancelError);
      }
    } else if (node.remoteTaskId && node.acpAgentId) {
      try {
        const agent = getACPRegistry().getAgent(node.acpAgentId, this.deps.getActiveAgentRoles());
        if (!agent || agent.origin !== "remote" || !agent.endpoint) {
          error = `Remote ACP agent ${node.acpAgentId} is unavailable; remote task ownership is unresolved`;
        } else {
          const response = await this.remoteInvoker.cancel(agent, node.remoteTaskId);
          resultStatus = response.status;
          if (response.status === "cancelled") {
            status = "cancelled";
            outcome = "acknowledged";
            summary = "Remote ACP cancellation acknowledged";
          } else if (response.status === "completed" || response.status === "failed") {
            status = response.status;
            outcome = "already_terminal";
            summary = `Remote ACP task was already terminal (${response.status})`;
          } else {
            error = `Remote ACP cancellation was not acknowledged (status: ${response.status})`;
          }
        }
      } catch (cancelError) {
        error = cancelError instanceof Error ? cancelError.message : String(cancelError);
      }
    } else {
      error = `${reason}; no task identity was persisted, so the dispatch outcome is unknown`;
    }

    const current = await this.repo.findNodeById(node.id);
    if (!current) return false;
    const currentClaim = dispatchClaimForNode(current);
    if ((currentClaim?.id || undefined) !== dispatchClaimId) return false;
    if (
      current.status === "completed" ||
      current.status === "failed" ||
      current.status === "cancelled"
    ) {
      return true;
    }
    const cancellation: OrchestrationNodeCancellationAttempt = {
      requestId,
      requestedAt,
      dispatchClaimId,
      ownership,
      outcome,
      resultStatus,
      error,
    };
    const metadata = {
      ...(current.metadata || {}),
      cancellation,
    };
    const updated = await this.repo.updateNodeForCancellation(node.id, requestId, dispatchClaimId, {
      status,
      error: status === "blocked" ? error || summary : error,
      summary,
      completedAt: Date.now(),
      metadata,
    });
    if (!updated) return false;
    await this.repo.createNodeEvent(node.runId, node.id, `orchestration_node_${outcome}`, {
      runId: node.runId,
      nodeId: node.id,
      taskId: updated.taskId,
      remoteTaskId: updated.remoteTaskId,
      status: updated.status,
      summary: updated.summary,
      error: updated.error,
      cancellation,
    });
    const rootTaskId =
      (await this.repo.findSnapshotByRunId(node.runId))?.run.rootTaskId || node.runId;
    this.emitRootEvent(rootTaskId, `orchestration_node_${outcome}`, {
      runId: node.runId,
      nodeId: node.id,
      taskId: updated.taskId,
      remoteTaskId: updated.remoteTaskId,
      status: updated.status,
      summary: updated.summary,
      error: updated.error,
      cancellation,
    });
    this.emitBlockedNodeNotification(node.runId, updated);
    return outcome === "acknowledged" || outcome === "already_terminal";
  }

  private async computeReadyNodes(
    snapshot: OrchestrationGraphSnapshot,
  ): Promise<OrchestrationGraphNode[]> {
    const terminalNodeIds = new Set(
      snapshot.nodes.filter((node) => node.status === "completed").map((node) => node.id),
    );
    const blockedNodeIds = new Set(
      snapshot.nodes
        .filter(
          (node) =>
            node.status === "failed" || node.status === "cancelled" || node.status === "blocked",
        )
        .map((node) => node.id),
    );
    const incomingByTarget = new Map<string, string[]>();
    for (const edge of snapshot.edges) {
      const existing = incomingByTarget.get(edge.toNodeId) || [];
      existing.push(edge.fromNodeId);
      incomingByTarget.set(edge.toNodeId, existing);
    }
    const ready: OrchestrationGraphNode[] = [];
    for (const node of snapshot.nodes) {
      if (node.status !== "pending") continue;
      const incoming = incomingByTarget.get(node.id) || [];
      if (incoming.some((from) => blockedNodeIds.has(from))) {
        const blocked = await this.repo.updateNode(node.id, {
          status: "blocked",
          error: "Dependency failed or was cancelled",
          completedAt: Date.now(),
          summary: "Blocked by failed dependency",
        });
        if (blocked) this.emitBlockedNodeNotification(snapshot.run.id, blocked);
        continue;
      }
      if (incoming.every((from) => terminalNodeIds.has(from))) ready.push(node);
    }
    return ready;
  }

  private async dispatchNode(
    run: OrchestrationGraphRun,
    node: OrchestrationGraphNode,
  ): Promise<void> {
    const claimId = uuidv4();
    const claimed = await this.repo.claimReadyNode(node.id, {
      id: claimId,
      claimedAt: Date.now(),
      ownerPid: process.pid,
      phase: "claimed",
    });
    if (!claimed) return;
    activeDispatchClaimIds.add(claimId);
    let effectBoundaryEntered = false;

    try {
      const prompt = await this.buildPromptWithDependencyContext(run.id, claimed);
      await serviceStatements(this.db).unit("botWorkControl_assertNotStopped", [run.rootTaskId]);
      if (claimed.dispatchTarget === "remote_acp") {
        const agent = this.resolveRemoteAcpAgent(claimed);
        // Parent excerpts and recent findings ride along in the prompt; strip
        // secret values before they leave the host or reach the approval record.
        const outbound = redactSecrets(prompt);
        await this.admitRemoteAcpDispatch({
          runId: run.id,
          nodeId: claimed.id,
          rootTaskId: run.rootTaskId,
          workspaceId: run.workspaceId,
          agent,
          title: claimed.title,
          prompt: outbound.text,
          redactedSecretCount: outbound.count,
        });
        // Approval can take arbitrarily long: recheck stop, ownership and the
        // agent so a cancelled run or a re-pointed endpoint is not dispatched.
        await serviceStatements(this.db).unit("botWorkControl_assertNotStopped", [run.rootTaskId]);
        await this.assertDispatchClaimCurrent(run.id, claimed.id, claimId);
        const admittedAgent = this.resolveRemoteAcpAgent(claimed);
        if (admittedAgent.endpoint !== agent.endpoint) {
          throw new Error("Remote ACP agent endpoint changed while dispatch awaited admission");
        }
        effectBoundaryEntered = true;
        await this.dispatchRemoteAcpNode(
          run,
          { ...claimed, prompt: outbound.text },
          admittedAgent,
          claimId,
        );
        return;
      }

      if (claimed.dispatchTarget === "local_role" && claimed.parentTaskId === undefined) {
        effectBoundaryEntered = true;
        const task = await this.deps.createRootTask({
          title: claimed.title,
          prompt,
          workspaceId: run.workspaceId,
          assignedAgentRoleId: claimed.assignedAgentRoleId,
          workerRole: claimed.workerRole,
          agentConfig: claimed.agentConfig,
          source: "api",
          graphAdmission: { runId: run.id, nodeId: claimed.id, claimId },
        });
        await this.persistLocalDispatchResult(run, claimed, claimId, task);
        return;
      }

      effectBoundaryEntered = true;
      const child = await this.deps.createChildTask({
        title: claimed.title,
        prompt,
        workspaceId: run.workspaceId,
        parentTaskId: claimed.parentTaskId || run.rootTaskId,
        agentType: "sub",
        agentConfig: claimed.agentConfig,
        workerRole: claimed.workerRole,
        depth:
          typeof claimed.metadata?.depth === "number" && Number.isFinite(claimed.metadata.depth)
            ? Math.max(1, Math.floor(claimed.metadata.depth))
            : undefined,
        assignedAgentRoleId: claimed.assignedAgentRoleId,
        teamRunId: claimed.teamRunId,
        teamItemId: claimed.teamItemId,
        graphAdmission: { runId: run.id, nodeId: claimed.id, claimId },
      });
      await this.persistLocalDispatchResult(run, claimed, claimId, child);
    } catch (error: Any) {
      const message = error?.message || String(error);
      await this.recordDispatchFailure(
        run,
        claimed,
        claimId,
        message,
        effectBoundaryEntered && !(error instanceof GraphTaskAdmissionClosedError),
      );
    } finally {
      activeDispatchClaimIds.delete(claimId);
    }
  }

  private async recordDispatchFailure(
    run: OrchestrationGraphRun,
    node: OrchestrationGraphNode,
    claimId: string,
    message: string,
    effectBoundaryEntered: boolean,
  ): Promise<void> {
    const current = await this.repo.findNodeById(node.id);
    const claim = current && dispatchClaimForNode(current);
    if (!current || claim?.id !== claimId) return;
    const preserveStatus =
      current.status === "blocked" ||
      current.status === "cancelled" ||
      current.status === "completed" ||
      current.status === "failed";
    const status = preserveStatus ? current.status : effectBoundaryEntered ? "blocked" : "failed";
    const metadata = {
      ...(current.metadata || {}),
      dispatchClaim: {
        ...claim,
        phase: effectBoundaryEntered ? "unknown" : "identity_persisted",
        error: message,
      },
      ...(effectBoundaryEntered ? { dispatchOutcome: "unknown" } : {}),
    };
    const updated = await this.repo.updateNodeForDispatchClaim(node.id, claimId, {
      status,
      error: message,
      summary: effectBoundaryEntered ? `Dispatch outcome is unknown: ${message}` : message,
      completedAt: Date.now(),
      metadata,
    });
    if (!updated) return;
    const eventType =
      status === "failed" ? "orchestration_node_failed" : "orchestration_node_blocked";
    const payload = {
      runId: run.id,
      nodeId: node.id,
      status,
      summary: updated.summary,
      error: updated.error,
      dispatchClaim: metadata.dispatchClaim,
    };
    await this.repo.createNodeEvent(run.id, node.id, eventType, payload);
    this.emitRootEvent(run.rootTaskId, eventType, payload);
    // Only notify on a transition this call made; a preserved terminal status was already notified.
    if (!preserveStatus && (status === "failed" || status === "blocked")) {
      this.emit("node_notification", this.buildNotification(run.id, updated, status));
    }
  }

  private async persistLocalDispatchResult(
    run: OrchestrationGraphRun,
    node: OrchestrationGraphNode,
    claimId: string,
    task: Task,
  ): Promise<void> {
    const current = await this.repo.findNodeById(node.id);
    const claim = current && dispatchClaimForNode(current);
    if (!current || claim?.id !== claimId) return;
    const latestRun = (await this.repo.findSnapshotByRunId(run.id))?.run;
    const terminalStatus = taskGraphStatus(task);
    const status =
      (["completed", "failed", "cancelled"].includes(current.status)
        ? current.status
        : undefined) ||
      terminalStatus ||
      (latestRun?.status === "running" && current.status === "running" ? "running" : "blocked");
    const cancellationRequested = status === "blocked" || latestRun?.status !== "running";
    const metadata = {
      ...(current.metadata || {}),
      dispatchClaim: {
        ...claim,
        phase: "identity_persisted",
        taskId: task.id,
      },
      dispatchReceipt: { claimId, taskId: task.id, recordedAt: Date.now() },
    };
    const updated = await this.repo.updateNodeForDispatchClaim(node.id, claimId, {
      status,
      taskId: task.id,
      publicHandle: task.id,
      startedAt: current.startedAt || Date.now(),
      completedAt:
        current.completedAt ||
        (terminalStatus ? Date.now() : status === "blocked" ? Date.now() : undefined),
      summary:
        status === "running"
          ? `Dispatched: ${node.title}`
          : terminalStatus
            ? summarizeTask(task)
            : `Task identity persisted after cancellation was requested (${task.id})`,
      error: status === "running" || status === "completed" ? undefined : task.error || undefined,
      metadata,
    });
    if (!updated) return;

    if (cancellationRequested) {
      if (latestRun?.metadata?.botWorkControl) return;
      await this.requestNodeCancellation(
        updated,
        "Cancellation requested while dispatch was in flight",
      );
      return;
    }
    if (terminalStatus) {
      await this.emitTaskTerminalEvent(run, updated, terminalStatus);
      return;
    }
    const notification = this.buildNotification(run.id, updated, "running");
    await this.repo.createNodeEvent(
      run.id,
      node.id,
      "orchestration_node_dispatched",
      notificationToPayload(notification),
    );
    this.emit("node_notification", notification);
    this.emitRootEvent(run.rootTaskId, "orchestration_node_dispatched", {
      ...notificationToPayload(notification),
      handle: task.id,
    });
  }

  private resolveRemoteAcpAgent(node: OrchestrationGraphNode): ACPAgentCard {
    const acpAgentId = node.acpAgentId;
    if (!acpAgentId) throw new Error("Remote ACP node is missing acpAgentId");
    const agent = getACPRegistry().getAgent(acpAgentId, this.deps.getActiveAgentRoles());
    if (!agent || agent.origin !== "remote" || !agent.endpoint) {
      throw new Error(`ACP agent ${acpAgentId} is unavailable`);
    }
    return agent;
  }

  /** Throws a visible reason unless the remote dispatch is allowed or approved. */
  private async admitRemoteAcpDispatch(request: RemoteAcpDispatchRequest): Promise<void> {
    const admission = this.deps.remoteAcpAdmission;
    const decision = await admission.evaluate(request);
    if (decision.decision === "deny") {
      throw new Error(`Remote ACP dispatch denied: ${decision.reason}`);
    }
    if (decision.decision === "allow") return;
    const approval = await admission.requestApproval(request, decision.reason);
    if (!approval.approved) {
      throw new Error(
        `Remote ACP dispatch was not approved: ${approval.reason || decision.reason}`,
      );
    }
  }

  private async assertDispatchClaimCurrent(
    runId: string,
    nodeId: string,
    claimId: string,
  ): Promise<void> {
    const current = await this.repo.findNodeById(nodeId);
    const latestRun = (await this.repo.findSnapshotByRunId(runId))?.run;
    if (
      !current ||
      dispatchClaimForNode(current)?.id !== claimId ||
      current.status !== "running" ||
      latestRun?.status !== "running"
    ) {
      throw new Error("Orchestration run changed while remote dispatch awaited admission");
    }
  }

  private async dispatchRemoteAcpNode(
    run: OrchestrationGraphRun,
    node: OrchestrationGraphNode,
    agent: ACPAgentCard,
    claimId: string,
  ): Promise<void> {
    const result = await this.remoteInvoker.invoke(agent, {
      assigneeId: agent.id,
      title: node.title,
      prompt: node.prompt,
      workspaceId: run.workspaceId,
    });
    const terminal =
      result.status === "completed" || result.status === "failed" || result.status === "cancelled";
    const current = await this.repo.findNodeById(node.id);
    const claim = current && dispatchClaimForNode(current);
    if (!current || claim?.id !== claimId) return;
    const latestRun = (await this.repo.findSnapshotByRunId(run.id))?.run;
    const identityKnown = Boolean(result.remoteTaskId);
    const knownTerminal = terminal;
    const interrupted = latestRun?.status !== "running" || current.status !== "running";
    const status = knownTerminal
      ? result.status
      : identityKnown && !interrupted
        ? "running"
        : "blocked";
    const unknown = !knownTerminal && (!identityKnown || interrupted);
    const metadata = {
      ...(current.metadata || {}),
      dispatchClaim: {
        ...claim,
        phase: identityKnown || knownTerminal ? "identity_persisted" : "unknown",
        remoteTaskId: result.remoteTaskId,
        error: unknown
          ? result.error || "Remote dispatch identity was not safely recorded"
          : undefined,
      },
      ...(unknown ? { dispatchOutcome: "unknown" } : {}),
      ...(identityKnown
        ? {
            dispatchReceipt: { claimId, remoteTaskId: result.remoteTaskId, recordedAt: Date.now() },
          }
        : {}),
    };
    const updated = await this.repo.updateNodeForDispatchClaim(node.id, claimId, {
      status,
      remoteTaskId: result.remoteTaskId,
      publicHandle: result.remoteTaskId,
      startedAt: current.startedAt || Date.now(),
      summary:
        result.status === "completed"
          ? result.result || "Remote ACP task completed"
          : result.status === "running"
            ? status === "running"
              ? `Remote ACP task running via ${agent.name}`
              : "Remote ACP task identity persisted after cancellation was requested"
            : result.error || `Remote ACP task ${result.status}`,
      output: result.status === "completed" ? result.result : undefined,
      error:
        unknown || result.status === "failed" || result.status === "cancelled"
          ? result.error || "Remote dispatch outcome is unresolved"
          : undefined,
      completedAt: terminal || unknown ? Date.now() : undefined,
      metadata,
    });
    if (!updated) return;
    if (unknown) {
      if (identityKnown) {
        await this.requestNodeCancellation(
          updated,
          "Cancellation requested while remote dispatch was in flight",
        );
      } else {
        this.emitRootEvent(run.rootTaskId, "orchestration_node_blocked", {
          runId: run.id,
          nodeId: node.id,
          remoteTaskId: result.remoteTaskId,
          error: updated.error,
          dispatchClaim: metadata.dispatchClaim,
        });
        this.emitBlockedNodeNotification(run.id, updated);
      }
      return;
    }
    if (terminal) {
      await this.emitTaskTerminalEvent(
        run,
        updated,
        updated.status as OrchestrationNodeNotification["status"],
      );
      return;
    }
    const notification = this.buildNotification(run.id, updated, "running");
    await this.repo.createNodeEvent(
      run.id,
      node.id,
      "orchestration_node_dispatched",
      notificationToPayload(notification),
    );
    this.emit("node_notification", notification);
    this.emitRootEvent(
      run.rootTaskId,
      "orchestration_node_dispatched",
      notificationToPayload(notification),
    );
  }

  private async emitTaskTerminalEvent(
    run: OrchestrationGraphRun,
    node: OrchestrationGraphNode,
    status: OrchestrationNodeNotification["status"],
  ): Promise<void> {
    const notification = this.buildNotification(run.id, node, status);
    const eventType =
      status === "completed" ? "orchestration_node_completed" : "orchestration_node_failed";
    await this.repo.createNodeEvent(
      run.id,
      node.id,
      eventType,
      notificationToPayload(notification),
    );
    this.emit("node_notification", notification);
    this.emitRootEvent(run.rootTaskId, eventType, notificationToPayload(notification));
  }

  private async reconcileActiveNodes(snapshot: OrchestrationGraphSnapshot): Promise<void> {
    for (const node of snapshot.nodes) {
      if (node.status !== "running") continue;
      if (!node.taskId && !node.remoteTaskId) {
        const claim = dispatchClaimForNode(node);
        if (claim && activeDispatchClaimIds.has(claim.id)) continue;
        await this.blockUnknownDispatch(
          snapshot.run,
          node,
          claim,
          "A dispatch claim has no persisted task identity; the external outcome is unknown",
        );
        continue;
      }
      if (node.taskId) {
        const task = await this.deps.getTaskById(node.taskId);
        if (!task) {
          await this.blockUnknownDispatch(
            snapshot.run,
            node,
            dispatchClaimForNode(node),
            `Recorded local task ${node.taskId} is unavailable; ownership is unresolved`,
          );
          continue;
        }
        if (
          task.status === "completed" ||
          task.status === "failed" ||
          task.status === "cancelled"
        ) {
          const nextStatus =
            task.status === "completed"
              ? "completed"
              : task.status === "cancelled"
                ? "cancelled"
                : "failed";
          const updated = await this.repo.updateNode(node.id, {
            status: nextStatus,
            summary: summarizeTask(task),
            output: task.resultSummary,
            error: typeof task.error === "string" ? task.error : undefined,
            completedAt: Date.now(),
          });
          const effectiveNode = updated || node;
          const notification = this.buildNotification(snapshot.run.id, effectiveNode, nextStatus);
          await this.repo.createNodeEvent(
            snapshot.run.id,
            node.id,
            nextStatus === "completed"
              ? "orchestration_node_completed"
              : "orchestration_node_failed",
            notificationToPayload(notification),
          );
          this.emit("node_notification", notification);
          this.emitRootEvent(
            snapshot.run.rootTaskId,
            nextStatus === "completed"
              ? "orchestration_node_completed"
              : "orchestration_node_failed",
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
        const updated = await this.repo.updateNode(node.id, {
          status: nextStatus,
          summary: result.result || result.error || `Remote ACP task ${result.status}`,
          output: result.result,
          error: result.error,
          completedAt: Date.now(),
        });
        const effectiveNode = updated || node;
        const notification = this.buildNotification(snapshot.run.id, effectiveNode, nextStatus);
        await this.repo.createNodeEvent(
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

  private async blockUnknownDispatch(
    run: OrchestrationGraphRun,
    node: OrchestrationGraphNode,
    claim: OrchestrationDispatchClaim | undefined,
    message: string,
  ): Promise<void> {
    const current = await this.repo.findNodeById(node.id);
    if (!current || current.status !== "running") return;
    const currentClaim = dispatchClaimForNode(current);
    if ((currentClaim?.id || undefined) !== (claim?.id || undefined)) return;
    const metadata = {
      ...(current.metadata || {}),
      dispatchOutcome: "unknown",
      dispatchClaim: claim ? { ...claim, phase: "unknown" as const, error: message } : undefined,
    };
    const updates = {
      status: "blocked" as const,
      error: message,
      summary: "Blocked because dispatch ownership is unresolved",
      completedAt: Date.now(),
      metadata,
    };
    const updated = claim
      ? await this.repo.updateNodeForDispatchClaim(node.id, claim.id, updates)
      : await this.repo.updateNode(node.id, updates);
    if (!updated) return;
    const payload = {
      runId: run.id,
      nodeId: node.id,
      taskId: node.taskId,
      remoteTaskId: node.remoteTaskId,
      status: "blocked",
      summary: updated.summary,
      error: message,
      dispatchClaim: claim,
    };
    await this.repo.createNodeEvent(run.id, node.id, "orchestration_node_blocked", payload);
    this.emitRootEvent(run.rootTaskId, "orchestration_node_blocked", payload);
    this.emitBlockedNodeNotification(run.id, updated);
  }

  /**
   * Graph-backed team items only advance through node_notification, so every
   * transition into "blocked" must be announced or the item stays in_progress.
   */
  private emitBlockedNodeNotification(runId: string, node: OrchestrationGraphNode): void {
    if (node.status !== "blocked") return;
    this.emit("node_notification", this.buildNotification(runId, node, "blocked"));
  }

  private async finalizeRunIfTerminal(snapshot: OrchestrationGraphSnapshot): Promise<void> {
    if (snapshot.nodes.some((node) => !isTerminalNodeStatus(node.status))) return;
    const hasFailure = snapshot.nodes.some(
      (node) =>
        node.status === "failed" || node.status === "cancelled" || node.status === "blocked",
    );
    const status = hasFailure ? "failed" : "completed";
    const updated = await this.repo.finishRunIfRunning(snapshot.run.id, status);
    if (!updated || updated.status === "cancelled") return;
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

  private emitRootEvent(
    rootTaskId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): void {
    if (!rootTaskId) return;
    this.deps.emitRootEvent?.(rootTaskId, eventType, payload);
  }

  private async buildPromptWithDependencyContext(
    runId: string,
    node: OrchestrationGraphNode,
  ): Promise<string> {
    const snapshot = await this.repo.findSnapshotByRunId(runId);
    if (!snapshot) return node.prompt;
    const predecessorIds = snapshot.edges
      .filter((edge) => edge.toNodeId === node.id)
      .map((edge) => edge.fromNodeId);
    if (predecessorIds.length === 0) return node.prompt;
    const predecessors = snapshot.nodes.filter((candidate) =>
      predecessorIds.includes(candidate.id),
    );
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
