import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import type {
  OrchestrationGraphEdge,
  OrchestrationGraphNode,
  OrchestrationGraphRun,
  OrchestrationNodeNotification,
  VerificationVerdict,
  WorkerRoleKind,
} from "../../../shared/types";

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

interface RunRow {
  id: string;
  root_task_id: string;
  workspace_id: string;
  kind: OrchestrationGraphRun["kind"];
  status: OrchestrationGraphRun["status"];
  max_parallel: number;
  metadata: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

interface NodeRow {
  id: string;
  run_id: string;
  node_key: string;
  title: string;
  prompt: string;
  kind: OrchestrationGraphNode["kind"];
  status: OrchestrationGraphNode["status"];
  dispatch_target: OrchestrationGraphNode["dispatchTarget"];
  worker_role: OrchestrationGraphNode["workerRole"] | null;
  parent_task_id: string | null;
  assigned_agent_role_id: string | null;
  capability_hint: string | null;
  acp_agent_id: string | null;
  agent_config: string | null;
  task_id: string | null;
  remote_task_id: string | null;
  public_handle: string | null;
  summary: string | null;
  output: string | null;
  error: string | null;
  team_run_id: string | null;
  team_item_id: string | null;
  workflow_phase_id: string | null;
  acp_task_id: string | null;
  metadata: string | null;
  verification_verdict: VerificationVerdict | null;
  verification_report: string | null;
  semantic_summary: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  completed_at: number | null;
}

interface EdgeRow {
  id: string;
  run_id: string;
  from_node_id: string;
  to_node_id: string;
}

function rowToRun(row: RunRow): OrchestrationGraphRun {
  return {
    id: row.id,
    rootTaskId: row.root_task_id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    status: row.status,
    maxParallel: row.max_parallel,
    metadata: safeJsonParse<Record<string, unknown>>(row.metadata, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
  };
}

function rowToNode(row: NodeRow): OrchestrationGraphNode {
  return {
    id: row.id,
    runId: row.run_id,
    key: row.node_key,
    title: row.title,
    prompt: row.prompt,
    kind: row.kind,
    status: row.status,
    dispatchTarget: row.dispatch_target,
    workerRole: row.worker_role ?? undefined,
    parentTaskId: row.parent_task_id ?? undefined,
    assignedAgentRoleId: row.assigned_agent_role_id ?? undefined,
    capabilityHint: (row.capability_hint as OrchestrationGraphNode["capabilityHint"]) ?? undefined,
    acpAgentId: row.acp_agent_id ?? undefined,
    agentConfig: safeJsonParse(row.agent_config, undefined),
    taskId: row.task_id ?? undefined,
    remoteTaskId: row.remote_task_id ?? undefined,
    publicHandle: row.public_handle ?? undefined,
    summary: row.summary ?? undefined,
    output: row.output ?? undefined,
    error: row.error ?? undefined,
    teamRunId: row.team_run_id ?? undefined,
    teamItemId: row.team_item_id ?? undefined,
    workflowPhaseId: row.workflow_phase_id ?? undefined,
    acpTaskId: row.acp_task_id ?? undefined,
    metadata: safeJsonParse<Record<string, unknown>>(row.metadata, {}),
    verificationVerdict: row.verification_verdict ?? undefined,
    verificationReport: row.verification_report ?? undefined,
    semanticSummary: row.semantic_summary ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
  };
}

function rowToEdge(row: EdgeRow): OrchestrationGraphEdge {
  return {
    id: row.id,
    runId: row.run_id,
    fromNodeId: row.from_node_id,
    toNodeId: row.to_node_id,
  };
}

export interface OrchestrationGraphSnapshot {
  run: OrchestrationGraphRun;
  nodes: OrchestrationGraphNode[];
  edges: OrchestrationGraphEdge[];
}

type OrchestrationGraphEdgeInsert = Omit<OrchestrationGraphEdge, "id" | "runId"> & {
  id?: string;
};

export class OrchestrationGraphRepository {
  constructor(private readonly db: Database.Database) {}

  createRun(input: {
    run: Omit<OrchestrationGraphRun, "createdAt" | "updatedAt"> & {
      id?: string;
      createdAt?: number;
      updatedAt?: number;
    };
    nodes: Array<
      Omit<OrchestrationGraphNode, "runId" | "createdAt" | "updatedAt"> & {
        id?: string;
        createdAt?: number;
        updatedAt?: number;
      }
    >;
    edges?: OrchestrationGraphEdgeInsert[];
  }): OrchestrationGraphSnapshot {
    const now = Date.now();
    const runId = input.run.id ?? uuidv4();
    const run: OrchestrationGraphRun = {
      ...input.run,
      id: runId,
      createdAt: input.run.createdAt ?? now,
      updatedAt: input.run.updatedAt ?? now,
    };

    const nodes: OrchestrationGraphNode[] = input.nodes.map((node, index) => ({
      ...node,
      id: node.id ?? uuidv4(),
      runId,
      createdAt: node.createdAt ?? now + index,
      updatedAt: node.updatedAt ?? now + index,
    }));
    const edges: OrchestrationGraphEdge[] = (input.edges || []).map((edge) => ({
      ...edge,
      id: edge.id ?? uuidv4(),
      runId,
    }));

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO orchestration_graph_runs (
            id, root_task_id, workspace_id, kind, status, max_parallel, metadata,
            created_at, updated_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          run.id,
          run.rootTaskId,
          run.workspaceId,
          run.kind,
          run.status,
          run.maxParallel,
          JSON.stringify(run.metadata || {}),
          run.createdAt,
          run.updatedAt,
          run.completedAt ?? null,
        );

      const insertNode = this.db.prepare(
        `INSERT INTO orchestration_graph_nodes (
          id, run_id, node_key, title, prompt, kind, status, dispatch_target, worker_role,
          parent_task_id, assigned_agent_role_id, capability_hint, acp_agent_id, agent_config,
          task_id, remote_task_id, public_handle, summary, output, error,
          team_run_id, team_item_id, workflow_phase_id, acp_task_id, metadata,
          verification_verdict, verification_report, semantic_summary,
          created_at, updated_at, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      for (const node of nodes) {
        insertNode.run(
          node.id,
          node.runId,
          node.key,
          node.title,
          node.prompt,
          node.kind,
          node.status,
          node.dispatchTarget,
          node.workerRole ?? null,
          node.parentTaskId ?? null,
          node.assignedAgentRoleId ?? null,
          node.capabilityHint ?? null,
          node.acpAgentId ?? null,
          node.agentConfig ? JSON.stringify(node.agentConfig) : null,
          node.taskId ?? null,
          node.remoteTaskId ?? null,
          node.publicHandle ?? null,
          node.summary ?? null,
          node.output ?? null,
          node.error ?? null,
          node.teamRunId ?? null,
          node.teamItemId ?? null,
          node.workflowPhaseId ?? null,
          node.acpTaskId ?? null,
          JSON.stringify(node.metadata || {}),
          node.verificationVerdict ?? null,
          node.verificationReport ?? null,
          node.semanticSummary ?? null,
          node.createdAt,
          node.updatedAt,
          node.startedAt ?? null,
          node.completedAt ?? null,
        );
      }

      if (edges.length > 0) {
        const insertEdge = this.db.prepare(
          `INSERT INTO orchestration_graph_edges (id, run_id, from_node_id, to_node_id)
           VALUES (?, ?, ?, ?)`,
        );
        for (const edge of edges) {
          insertEdge.run(edge.id, edge.runId, edge.fromNodeId, edge.toNodeId);
        }
      }
    });

    tx();
    return { run, nodes, edges };
  }

  appendNodes(input: {
    runId: string;
    nodes: Array<
      Omit<OrchestrationGraphNode, "runId" | "createdAt" | "updatedAt"> & {
        id?: string;
        createdAt?: number;
        updatedAt?: number;
      }
    >;
    edges?: OrchestrationGraphEdgeInsert[];
  }): OrchestrationGraphSnapshot | undefined {
    const existing = this.findSnapshotByRunId(input.runId);
    if (!existing) return undefined;
    const now = Date.now();
    const nodes: OrchestrationGraphNode[] = input.nodes.map((node, index) => ({
      ...node,
      id: node.id ?? uuidv4(),
      runId: input.runId,
      createdAt: node.createdAt ?? now + index,
      updatedAt: node.updatedAt ?? now + index,
    }));
    const edges: OrchestrationGraphEdge[] = (input.edges || []).map((edge) => ({
      ...edge,
      id: edge.id ?? uuidv4(),
      runId: input.runId,
    }));

    const tx = this.db.transaction(() => {
      const insertNode = this.db.prepare(
        `INSERT INTO orchestration_graph_nodes (
          id, run_id, node_key, title, prompt, kind, status, dispatch_target, worker_role,
          parent_task_id, assigned_agent_role_id, capability_hint, acp_agent_id, agent_config,
          task_id, remote_task_id, public_handle, summary, output, error,
          team_run_id, team_item_id, workflow_phase_id, acp_task_id, metadata,
          verification_verdict, verification_report, semantic_summary,
          created_at, updated_at, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const node of nodes) {
        insertNode.run(
          node.id,
          node.runId,
          node.key,
          node.title,
          node.prompt,
          node.kind,
          node.status,
          node.dispatchTarget,
          node.workerRole ?? null,
          node.parentTaskId ?? null,
          node.assignedAgentRoleId ?? null,
          node.capabilityHint ?? null,
          node.acpAgentId ?? null,
          node.agentConfig ? JSON.stringify(node.agentConfig) : null,
          node.taskId ?? null,
          node.remoteTaskId ?? null,
          node.publicHandle ?? null,
          node.summary ?? null,
          node.output ?? null,
          node.error ?? null,
          node.teamRunId ?? null,
          node.teamItemId ?? null,
          node.workflowPhaseId ?? null,
          node.acpTaskId ?? null,
          JSON.stringify(node.metadata || {}),
          node.verificationVerdict ?? null,
          node.verificationReport ?? null,
          node.semanticSummary ?? null,
          node.createdAt,
          node.updatedAt,
          node.startedAt ?? null,
          node.completedAt ?? null,
        );
      }
      if (edges.length > 0) {
        const insertEdge = this.db.prepare(
          `INSERT INTO orchestration_graph_edges (id, run_id, from_node_id, to_node_id)
           VALUES (?, ?, ?, ?)`,
        );
        for (const edge of edges) {
          insertEdge.run(edge.id, edge.runId, edge.fromNodeId, edge.toNodeId);
        }
      }
      this.db
        .prepare("UPDATE orchestration_graph_runs SET updated_at = ? WHERE id = ?")
        .run(now, input.runId);
    });

    tx();
    return this.findSnapshotByRunId(input.runId);
  }

  findSnapshotByRunId(runId: string): OrchestrationGraphSnapshot | undefined {
    const runRow = this.db
      .prepare("SELECT * FROM orchestration_graph_runs WHERE id = ?")
      .get(runId) as RunRow | undefined;
    if (!runRow) return undefined;
    const nodes = this.listNodesByRun(runId);
    const edges = this.listEdgesByRun(runId);
    return { run: rowToRun(runRow), nodes, edges };
  }

  findSnapshotByRootTaskId(rootTaskId: string): OrchestrationGraphSnapshot | undefined {
    const runRow = this.db
      .prepare(
        "SELECT * FROM orchestration_graph_runs WHERE root_task_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(rootTaskId) as RunRow | undefined;
    if (!runRow) return undefined;
    return this.findSnapshotByRunId(runRow.id);
  }

  listSnapshotsByRootTaskId(rootTaskId: string): OrchestrationGraphSnapshot[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM orchestration_graph_runs WHERE root_task_id = ? ORDER BY created_at DESC",
      )
      .all(rootTaskId) as RunRow[];
    return rows
      .map((row) => this.findSnapshotByRunId(row.id))
      .filter((value): value is OrchestrationGraphSnapshot => Boolean(value));
  }

  listRunningSnapshots(): OrchestrationGraphSnapshot[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM orchestration_graph_runs WHERE status = 'running' ORDER BY updated_at DESC",
      )
      .all() as RunRow[];
    return rows
      .map((row) => this.findSnapshotByRunId(row.id))
      .filter((value): value is OrchestrationGraphSnapshot => Boolean(value));
  }

  listNodesByRun(runId: string): OrchestrationGraphNode[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM orchestration_graph_nodes WHERE run_id = ? ORDER BY created_at ASC, id ASC",
      )
      .all(runId) as NodeRow[];
    return rows.map(rowToNode);
  }

  listEdgesByRun(runId: string): OrchestrationGraphEdge[] {
    const rows = this.db
      .prepare("SELECT * FROM orchestration_graph_edges WHERE run_id = ? ORDER BY id ASC")
      .all(runId) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  findNodeByHandle(rootTaskId: string, handle: string): OrchestrationGraphNode | undefined {
    const value = handle.trim();
    if (!value) return undefined;
    const row = this.db
      .prepare(
        `SELECT n.* FROM orchestration_graph_nodes n
         INNER JOIN orchestration_graph_runs r ON r.id = n.run_id
         WHERE r.root_task_id = ?
           AND (n.public_handle = ? OR n.task_id = ? OR n.remote_task_id = ?)
         ORDER BY n.created_at DESC
         LIMIT 1`,
      )
      .get(rootTaskId, value, value, value) as NodeRow | undefined;
    return row ? rowToNode(row) : undefined;
  }

  findNodeById(nodeId: string): OrchestrationGraphNode | undefined {
    const row = this.db
      .prepare("SELECT * FROM orchestration_graph_nodes WHERE id = ?")
      .get(nodeId) as NodeRow | undefined;
    return row ? rowToNode(row) : undefined;
  }

  findNodeByTeamItemId(teamItemId: string): OrchestrationGraphNode | undefined {
    const row = this.db
      .prepare("SELECT * FROM orchestration_graph_nodes WHERE team_item_id = ? LIMIT 1")
      .get(teamItemId) as NodeRow | undefined;
    return row ? rowToNode(row) : undefined;
  }

  findSnapshotByTeamRunId(teamRunId: string): OrchestrationGraphSnapshot | undefined {
    const row = this.db
      .prepare(
        `SELECT r.* FROM orchestration_graph_runs r
         INNER JOIN orchestration_graph_nodes n ON n.run_id = r.id
         WHERE n.team_run_id = ?
         ORDER BY r.created_at DESC
         LIMIT 1`,
      )
      .get(teamRunId) as RunRow | undefined;
    return row ? this.findSnapshotByRunId(row.id) : undefined;
  }

  findNodeByAcpTaskId(acpTaskId: string): OrchestrationGraphNode | undefined {
    const row = this.db
      .prepare("SELECT * FROM orchestration_graph_nodes WHERE acp_task_id = ? LIMIT 1")
      .get(acpTaskId) as NodeRow | undefined;
    return row ? rowToNode(row) : undefined;
  }

  updateRun(
    runId: string,
    updates: Partial<
      Pick<OrchestrationGraphRun, "status" | "maxParallel" | "metadata" | "completedAt">
    >,
  ): OrchestrationGraphRun | undefined {
    const existing = this.findSnapshotByRunId(runId)?.run;
    if (!existing) return undefined;
    const fields: string[] = [];
    const values: unknown[] = [];
    if (updates.status !== undefined) {
      fields.push("status = ?");
      values.push(updates.status);
    }
    if (updates.maxParallel !== undefined) {
      fields.push("max_parallel = ?");
      values.push(updates.maxParallel);
    }
    if (updates.metadata !== undefined) {
      fields.push("metadata = ?");
      values.push(JSON.stringify(updates.metadata || {}));
    }
    if (updates.completedAt !== undefined) {
      fields.push("completed_at = ?");
      values.push(updates.completedAt ?? null);
    }
    fields.push("updated_at = ?");
    values.push(Date.now());
    values.push(runId);
    this.db
      .prepare(`UPDATE orchestration_graph_runs SET ${fields.join(", ")} WHERE id = ?`)
      .run(...values);
    return this.findSnapshotByRunId(runId)?.run;
  }

  updateNode(
    nodeId: string,
    updates: Partial<
      Pick<
        OrchestrationGraphNode,
        | "status"
        | "taskId"
        | "remoteTaskId"
        | "publicHandle"
        | "summary"
        | "output"
        | "error"
        | "startedAt"
        | "completedAt"
        | "workerRole"
        | "verificationVerdict"
        | "verificationReport"
        | "semanticSummary"
        | "agentConfig"
        | "metadata"
      >
    >,
  ): OrchestrationGraphNode | undefined {
    const existingRow = this.db
      .prepare("SELECT * FROM orchestration_graph_nodes WHERE id = ?")
      .get(nodeId) as NodeRow | undefined;
    if (!existingRow) return undefined;
    const fields: string[] = [];
    const values: unknown[] = [];
    if (updates.status !== undefined) {
      fields.push("status = ?");
      values.push(updates.status);
    }
    if (updates.taskId !== undefined) {
      fields.push("task_id = ?");
      values.push(updates.taskId ?? null);
    }
    if (updates.remoteTaskId !== undefined) {
      fields.push("remote_task_id = ?");
      values.push(updates.remoteTaskId ?? null);
    }
    if (updates.publicHandle !== undefined) {
      fields.push("public_handle = ?");
      values.push(updates.publicHandle ?? null);
    }
    if (updates.summary !== undefined) {
      fields.push("summary = ?");
      values.push(updates.summary ?? null);
    }
    if (updates.output !== undefined) {
      fields.push("output = ?");
      values.push(updates.output ?? null);
    }
    if (updates.error !== undefined) {
      fields.push("error = ?");
      values.push(updates.error ?? null);
    }
    if (updates.startedAt !== undefined) {
      fields.push("started_at = ?");
      values.push(updates.startedAt ?? null);
    }
    if (updates.completedAt !== undefined) {
      fields.push("completed_at = ?");
      values.push(updates.completedAt ?? null);
    }
    if (updates.workerRole !== undefined) {
      fields.push("worker_role = ?");
      values.push(updates.workerRole ?? null);
    }
    if (updates.verificationVerdict !== undefined) {
      fields.push("verification_verdict = ?");
      values.push(updates.verificationVerdict ?? null);
    }
    if (updates.verificationReport !== undefined) {
      fields.push("verification_report = ?");
      values.push(updates.verificationReport ?? null);
    }
    if (updates.semanticSummary !== undefined) {
      fields.push("semantic_summary = ?");
      values.push(updates.semanticSummary ?? null);
    }
    if (updates.agentConfig !== undefined) {
      fields.push("agent_config = ?");
      values.push(updates.agentConfig ? JSON.stringify(updates.agentConfig) : null);
    }
    if (updates.metadata !== undefined) {
      fields.push("metadata = ?");
      values.push(JSON.stringify(updates.metadata || {}));
    }
    fields.push("updated_at = ?");
    values.push(Date.now());
    values.push(nodeId);
    this.db
      .prepare(`UPDATE orchestration_graph_nodes SET ${fields.join(", ")} WHERE id = ?`)
      .run(...values);
    const row = this.db
      .prepare("SELECT * FROM orchestration_graph_nodes WHERE id = ?")
      .get(nodeId) as NodeRow | undefined;
    return row ? rowToNode(row) : undefined;
  }

  createNodeEvent(
    runId: string,
    nodeId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): void {
    this.db
      .prepare(
        `INSERT INTO orchestration_graph_node_events (id, run_id, node_id, event_type, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(uuidv4(), runId, nodeId, eventType, JSON.stringify(payload || {}), Date.now());
  }

  listNodeNotifications(runId: string): OrchestrationNodeNotification[] {
    const rows = this.db
      .prepare(
        `SELECT n.id as node_id, n.task_id, n.remote_task_id, n.public_handle, n.status, n.summary,
                n.output, n.error, n.dispatch_target, n.worker_role, n.semantic_summary,
                n.verification_verdict, n.verification_report
         FROM orchestration_graph_nodes n
         WHERE n.run_id = ?
         ORDER BY n.updated_at ASC`,
      )
      .all(runId) as Array<{
      node_id: string;
      task_id: string | null;
      remote_task_id: string | null;
      public_handle: string | null;
      status: OrchestrationNodeNotification["status"];
      summary: string | null;
      output: string | null;
      error: string | null;
      dispatch_target: OrchestrationNodeNotification["target"];
      worker_role: WorkerRoleKind | null;
      semantic_summary: string | null;
      verification_verdict: VerificationVerdict | null;
      verification_report: string | null;
    }>;
    return rows
      .filter(
        (row) =>
          row.status === "running" ||
          row.status === "completed" ||
          row.status === "failed" ||
          row.status === "cancelled",
      )
      .map((row) => ({
        runId,
        nodeId: row.node_id,
        taskId: row.task_id ?? undefined,
        remoteTaskId: row.remote_task_id ?? undefined,
        publicHandle: row.public_handle ?? undefined,
        status: row.status,
        summary: row.summary || "",
        result: row.output ?? undefined,
        error: row.error ?? undefined,
        target: row.dispatch_target,
        workerRole: row.worker_role ?? undefined,
        semanticSummary: row.semantic_summary ?? undefined,
        verificationVerdict:
          (row.verification_verdict as OrchestrationNodeNotification["verificationVerdict"]) ??
          undefined,
        verificationReport: row.verification_report ?? undefined,
      }));
  }
}
