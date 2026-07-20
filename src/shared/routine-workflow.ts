/**
 * Versioned, serializable contracts for deterministic Routine workflows.
 *
 * These types intentionally live in shared code so Electron, preload, the
 * renderer, CLI, and Control Plane can exchange workflow definitions without
 * importing runtime-only modules.
 */

export const ROUTINE_WORKFLOW_VERSION = 1 as const;

export type WorkflowJsonPrimitive = string | number | boolean | null;

export interface WorkflowReference {
  /** Dot path such as `trigger.subject`, `node-2.summary`, or `item.id`. */
  $ref: string;
  /** Optional value used when the referenced path is missing. */
  default?: WorkflowInputValue;
}

export interface WorkflowTemplateValue {
  /** Text template supporting `{{trigger.subject}}` style references. */
  $template: string;
}

export type WorkflowInputValue =
  | WorkflowJsonPrimitive
  | WorkflowReference
  | WorkflowTemplateValue
  | WorkflowInputValue[]
  | { [key: string]: WorkflowInputValue };

export type WorkflowNodeKind =
  | "starter"
  | "action"
  | "ai"
  | "condition"
  | "filter"
  | "foreach"
  | "agent"
  | "custom";

export type WorkflowRiskLevel = "read" | "local_write" | "external_write" | "data_export";

export interface WorkflowRetryPolicy {
  maxAttempts: number;
  initialDelayMs?: number;
  backoffMultiplier?: number;
  maxDelayMs?: number;
}

export interface RoutineWorkflowNode {
  id: string;
  kind: WorkflowNodeKind;
  /** Stable catalog operation, for example `gmail.draft_email`. */
  operation: string;
  name: string;
  description?: string;
  config: Record<string, WorkflowInputValue>;
  position?: { x: number; y: number };
  timeoutMs?: number;
  retry?: WorkflowRetryPolicy;
  onError?: "fail" | "continue";
  approvalMode?: "inherit" | "always_confirm" | "never_confirm_safe";
  /** Nested deterministic body for `control.foreach`. */
  children?: RoutineWorkflowNode[];
  metadata?: Record<string, WorkflowInputValue>;
}

export interface RoutineWorkflowEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  /** Named branch such as `success`, `true`, `false`, `body`, or `after`. */
  sourcePort?: string;
  targetPort?: string;
}

export interface RoutineWorkflowSettings {
  maxRunDurationMs?: number;
  maxStepCount?: number;
  maxForEachItems?: number;
  maxParallelSteps?: number;
  retainStepDataDays?: number;
}

export interface RoutineWorkflowDefinition {
  version: typeof ROUTINE_WORKFLOW_VERSION;
  starterNodeId: string;
  nodes: RoutineWorkflowNode[];
  edges: RoutineWorkflowEdge[];
  accountBindings?: Record<string, string>;
  settings?: RoutineWorkflowSettings;
  generatedFromPrompt?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface WorkflowValidationIssue {
  code: string;
  message: string;
  path?: string;
  nodeId?: string;
  severity: "error" | "warning";
}

export interface WorkflowValidationResult {
  valid: boolean;
  issues: WorkflowValidationIssue[];
  requiredScopes: string[];
  riskLevels: WorkflowRiskLevel[];
}

export interface WorkflowFieldDefinition {
  key: string;
  label: string;
  type: "string" | "number" | "boolean" | "select" | "json" | "list";
  required?: boolean;
  description?: string;
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
  defaultValue?: WorkflowInputValue;
  supportsVariables?: boolean;
}

export interface WorkflowOperationDefinition {
  id: string;
  kind: WorkflowNodeKind;
  category: string;
  provider: string;
  name: string;
  description: string;
  risk: WorkflowRiskLevel;
  fields: WorkflowFieldDefinition[];
  outputFields: string[];
  requiredScopes: string[];
  connectorId?: string;
  toolName?: string;
  availability?: "available" | "requires_connection" | "preview";
}

export interface WorkflowCapabilities {
  version: typeof ROUTINE_WORKFLOW_VERSION;
  operations: WorkflowOperationDefinition[];
  templates: RoutineWorkflowTemplate[];
  limits: Required<RoutineWorkflowSettings>;
}

export interface RoutineWorkflowTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  promptHints: string[];
  workflow: RoutineWorkflowDefinition;
}

export type RoutineWorkflowRunStatus =
  | "queued"
  | "running"
  | "waiting_for_approval"
  | "completed"
  | "partial_success"
  | "failed"
  | "cancelled";

export type RoutineWorkflowStepStatus =
  | "pending"
  | "ready"
  | "running"
  | "waiting_for_approval"
  | "retrying"
  | "skipped"
  | "completed"
  | "failed"
  | "cancelled";

export interface RoutineWorkflowStepRecord {
  id: string;
  runId: string;
  routineId: string;
  nodeId: string;
  operation: string;
  status: RoutineWorkflowStepStatus;
  attemptCount: number;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  approvalId?: string;
  startedAt?: number;
  finishedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface RoutineWorkflowRunRecord {
  id: string;
  routineId: string;
  workflowVersionId: string;
  status: RoutineWorkflowRunStatus;
  triggerNodeId: string;
  eventId?: string;
  idempotencyKey?: string;
  context: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface RoutineWorkflowEventEnvelope {
  id?: string;
  routineId: string;
  triggerNodeId: string;
  source: string;
  idempotencyKey: string;
  receivedAt?: number;
  availableAt?: number;
  payload: Record<string, unknown>;
  summary?: string;
}

export interface RoutineWorkflowTestRequest {
  routineId?: string;
  workflow?: RoutineWorkflowDefinition;
  sampleEvent?: Record<string, unknown>;
  nodeId?: string;
  dryRun?: boolean;
}

export interface RoutineWorkflowApprovalRequest {
  runId: string;
  stepId: string;
  approved: boolean;
}
