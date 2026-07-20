import type {
  RoutineWorkflowDefinition,
  RoutineWorkflowNode,
  WorkflowRiskLevel,
  WorkflowValidationIssue,
  WorkflowValidationResult,
} from "../../../shared/routine-workflow";
import { ROUTINE_WORKFLOW_VERSION } from "../../../shared/routine-workflow";
import { DEFAULT_WORKFLOW_LIMITS, getWorkflowOperation } from "./catalog";

export interface WorkflowValidationOptions {
  allowIncomplete?: boolean;
}

export function validateRoutineWorkflow(
  workflow: RoutineWorkflowDefinition,
  options: WorkflowValidationOptions = {},
): WorkflowValidationResult {
  const issues: WorkflowValidationIssue[] = [];
  const scopes = new Set<string>();
  const risks = new Set<WorkflowRiskLevel>();

  if (workflow.version !== ROUTINE_WORKFLOW_VERSION) {
    issues.push({
      code: "unsupported_version",
      message: `Unsupported workflow version ${String(workflow.version)}.`,
      path: "version",
      severity: "error",
    });
  }

  if (!Array.isArray(workflow.nodes) || workflow.nodes.length === 0) {
    issues.push({
      code: "missing_nodes",
      message: "A workflow needs a starter.",
      path: "nodes",
      severity: "error",
    });
    return result(issues, scopes, risks);
  }

  const limits = { ...DEFAULT_WORKFLOW_LIMITS, ...workflow.settings };
  validateWorkflowSettings(workflow, issues);
  const totalNodeCount = countWorkflowNodes(workflow.nodes);
  if (totalNodeCount > limits.maxStepCount) {
    issues.push({
      code: "step_limit",
      message: `Workflow has ${totalNodeCount} nodes including nested actions; the limit is ${limits.maxStepCount}.`,
      path: "nodes",
      severity: "error",
    });
  }

  const nodeById = new Map<string, RoutineWorkflowNode>();
  for (const [index, node] of workflow.nodes.entries()) {
    if (!node.id.trim()) {
      issues.push({
        code: "missing_node_id",
        message: "Node ID is required.",
        path: `nodes.${index}.id`,
        severity: "error",
      });
      continue;
    }
    if (nodeById.has(node.id)) {
      issues.push({
        code: "duplicate_node_id",
        message: `Duplicate node ID: ${node.id}.`,
        nodeId: node.id,
        severity: "error",
      });
      continue;
    }
    nodeById.set(node.id, node);
    inspectNode(node, `nodes.${index}`, issues, scopes, risks, options);
  }

  const starters = workflow.nodes.filter((node) => node.kind === "starter");
  if (starters.length !== 1) {
    issues.push({
      code: "starter_count",
      message: `A workflow must contain exactly one starter; found ${starters.length}.`,
      path: "nodes",
      severity: "error",
    });
  }
  const declaredStarter = nodeById.get(workflow.starterNodeId);
  if (!declaredStarter || declaredStarter.kind !== "starter") {
    issues.push({
      code: "invalid_starter",
      message: "starterNodeId must identify the workflow starter.",
      path: "starterNodeId",
      severity: "error",
    });
  }

  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  const edgeIds = new Set<string>();
  for (const [index, edge] of (workflow.edges || []).entries()) {
    if (!edge.id.trim() || edgeIds.has(edge.id)) {
      issues.push({
        code: "duplicate_edge_id",
        message: `Edge ID must be unique: ${edge.id || "(empty)"}.`,
        path: `edges.${index}.id`,
        severity: "error",
      });
    }
    edgeIds.add(edge.id);
    if (!nodeById.has(edge.sourceNodeId)) {
      issues.push({
        code: "missing_edge_source",
        message: `Unknown edge source: ${edge.sourceNodeId}.`,
        path: `edges.${index}.sourceNodeId`,
        severity: "error",
      });
    }
    if (!nodeById.has(edge.targetNodeId)) {
      issues.push({
        code: "missing_edge_target",
        message: `Unknown edge target: ${edge.targetNodeId}.`,
        path: `edges.${index}.targetNodeId`,
        severity: "error",
      });
    }
    if (edge.sourceNodeId === edge.targetNodeId) {
      issues.push({
        code: "self_edge",
        message: "A node cannot connect to itself.",
        path: `edges.${index}`,
        severity: "error",
      });
    }
    incoming.set(edge.targetNodeId, [
      ...(incoming.get(edge.targetNodeId) || []),
      edge.sourceNodeId,
    ]);
    outgoing.set(edge.sourceNodeId, [
      ...(outgoing.get(edge.sourceNodeId) || []),
      edge.targetNodeId,
    ]);
  }

  if ((incoming.get(workflow.starterNodeId) || []).length > 0) {
    issues.push({
      code: "starter_has_input",
      message: "The starter cannot have incoming edges.",
      nodeId: workflow.starterNodeId,
      severity: "error",
    });
  }

  detectCycle(workflow.nodes, outgoing, issues);
  const reachable = collectReachable(workflow.starterNodeId, outgoing);
  for (const node of workflow.nodes) {
    if (!reachable.has(node.id)) {
      issues.push({
        code: "unreachable_node",
        message: `${node.name} is not connected to the starter.`,
        nodeId: node.id,
        severity: "warning",
      });
    }
  }

  return result(issues, scopes, risks);
}

function inspectNode(
  node: RoutineWorkflowNode,
  path: string,
  issues: WorkflowValidationIssue[],
  scopes: Set<string>,
  risks: Set<WorkflowRiskLevel>,
  options: WorkflowValidationOptions,
): void {
  const definition = getWorkflowOperation(node.operation);
  if (!definition && node.operation !== "custom.mcp_tool" && node.operation !== "custom.webhook") {
    issues.push({
      code: "unknown_operation",
      message: `Unknown operation: ${node.operation}.`,
      path: `${path}.operation`,
      nodeId: node.id,
      severity: "error",
    });
    return;
  }
  if (!definition) return;
  if (definition.availability === "preview") {
    issues.push({
      code: "preview_operation",
      message: `${definition.name} is a preview and cannot be used in an active flow yet.`,
      path: `${path}.operation`,
      nodeId: node.id,
      severity: options.allowIncomplete ? "warning" : "error",
    });
  }
  if (definition.kind !== node.kind && !(definition.kind === "action" && node.kind === "custom")) {
    issues.push({
      code: "node_kind_mismatch",
      message: `${node.name} must use node kind ${definition.kind}.`,
      nodeId: node.id,
      severity: "error",
    });
  }
  for (const scope of definition.requiredScopes) scopes.add(scope);
  risks.add(definition.risk);
  for (const field of definition.fields) {
    const value = node.config[field.key];
    if (field.supportsVariables === false && value && typeof value === "object") {
      issues.push({
        code: "variables_not_allowed",
        message: `${field.label} cannot be supplied by a workflow variable.`,
        path: `${path}.config.${field.key}`,
        nodeId: node.id,
        severity: "error",
      });
    }
    if (field.required && (value === undefined || value === null || value === "")) {
      issues.push({
        code: "missing_required_field",
        message: `${field.label} is required for ${node.name}.`,
        path: `${path}.config.${field.key}`,
        nodeId: node.id,
        severity: options.allowIncomplete ? "warning" : "error",
      });
    }
  }
  if (node.operation === "custom.webhook") {
    const value = node.config.url;
    if (typeof value === "string" && value.trim()) {
      try {
        const parsed = new URL(value);
        if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error();
      } catch {
        issues.push({
          code: "invalid_webhook_url",
          message: "Signed webhook URLs must use HTTPS and cannot contain credentials.",
          path: `${path}.config.url`,
          nodeId: node.id,
          severity: "error",
        });
      }
    }
  }
  if (node.kind === "foreach") {
    if (!node.children?.length) {
      issues.push({
        code: "empty_foreach",
        message: "Repeat for each needs at least one nested action.",
        nodeId: node.id,
        severity: options.allowIncomplete ? "warning" : "error",
      });
    } else {
      for (const [index, child] of node.children.entries()) {
        if (child.kind === "starter") {
          issues.push({
            code: "nested_starter",
            message: "A loop body cannot contain a starter.",
            nodeId: child.id,
            severity: "error",
          });
        }
        inspectNode(child, `${path}.children.${index}`, issues, scopes, risks, options);
      }
    }
  }
  if (
    definition.risk !== "read" &&
    definition.risk !== "local_write" &&
    Number(node.retry?.maxAttempts || 1) > 1
  ) {
    issues.push({
      code: "unsafe_write_retry",
      message: `${node.name} performs an external action, so automatic retries are limited to one attempt.`,
      path: `${path}.retry.maxAttempts`,
      nodeId: node.id,
      severity: "warning",
    });
  }
}

function validateWorkflowSettings(
  workflow: RoutineWorkflowDefinition,
  issues: WorkflowValidationIssue[],
): void {
  const settings = workflow.settings || {};
  const bounds: Array<{
    key: keyof typeof settings;
    min: number;
    max: number;
    label: string;
  }> = [
    { key: "maxRunDurationMs", min: 1_000, max: 30 * 60 * 1_000, label: "Run duration" },
    { key: "maxStepCount", min: 1, max: 100, label: "Operation count" },
    { key: "maxForEachItems", min: 1, max: 100, label: "Loop item count" },
    { key: "maxParallelSteps", min: 1, max: 4, label: "Parallel step count" },
    { key: "retainStepDataDays", min: 1, max: 365, label: "Retention days" },
  ];
  for (const bound of bounds) {
    const value = settings[bound.key];
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < bound.min || value > bound.max) {
      issues.push({
        code: "invalid_workflow_limit",
        message: `${bound.label} must be between ${bound.min} and ${bound.max}.`,
        path: `settings.${bound.key}`,
        severity: "error",
      });
    }
  }
  if (workflowDepth(workflow.nodes) > 4) {
    issues.push({
      code: "workflow_nesting_limit",
      message: "Workflow actions cannot be nested more than four levels deep.",
      path: "nodes",
      severity: "error",
    });
  }
}

function countWorkflowNodes(nodes: RoutineWorkflowNode[]): number {
  return nodes.reduce((total, node) => total + 1 + countWorkflowNodes(node.children || []), 0);
}

function workflowDepth(nodes: RoutineWorkflowNode[], depth = 1): number {
  if (nodes.length === 0) return depth - 1;
  return nodes.reduce(
    (highest, node) => Math.max(highest, depth, workflowDepth(node.children || [], depth + 1)),
    depth,
  );
}

function detectCycle(
  nodes: RoutineWorkflowNode[],
  outgoing: Map<string, string[]>,
  issues: WorkflowValidationIssue[],
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const target of outgoing.get(id) || []) {
      if (visit(target)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  for (const node of nodes) {
    if (visit(node.id)) {
      issues.push({
        code: "cycle",
        message: "Workflow edges must not contain a cycle.",
        path: "edges",
        severity: "error",
      });
      return;
    }
  }
}

function collectReachable(starterNodeId: string, outgoing: Map<string, string[]>): Set<string> {
  const reachable = new Set<string>();
  const queue = [starterNodeId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    queue.push(...(outgoing.get(id) || []));
  }
  return reachable;
}

function result(
  issues: WorkflowValidationIssue[],
  scopes: Set<string>,
  risks: Set<WorkflowRiskLevel>,
): WorkflowValidationResult {
  return {
    valid: !issues.some((issue) => issue.severity === "error"),
    issues,
    requiredScopes: Array.from(scopes).sort(),
    riskLevels: Array.from(risks),
  };
}
