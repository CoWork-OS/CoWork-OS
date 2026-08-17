export const AGENT_SECURITY_PROTOCOL_VERSION = "cowork-os/numbat-hook/v1" as const;
export const NUMBAT_RECORD_SCHEMA_VERSION = "0.2.0" as const;

export type AgentSecurityMode = "monitor" | "enforce";
export type AgentSecurityFailurePolicy = "open" | "deny_high_risk";
export type AgentSecurityRuleProfile = "builtin" | "recommended" | "custom";

export interface AgentSecurityPolicy {
  enabled: boolean;
  mode: AgentSecurityMode;
  ruleProfile: AgentSecurityRuleProfile;
  customRuleDirs: string[];
  failurePolicy: AgentSecurityFailurePolicy;
  timeoutMs: number;
  retentionDays: number;
  scheduledScan: {
    enabled: boolean;
    intervalHours: number;
  };
  externalHooks: {
    management: "manual";
  };
}

export const DEFAULT_AGENT_SECURITY_POLICY: AgentSecurityPolicy = {
  enabled: false,
  mode: "monitor",
  ruleProfile: "recommended",
  customRuleDirs: [],
  failurePolicy: "open",
  timeoutMs: 1_500,
  retentionDays: 30,
  scheduledScan: {
    enabled: false,
    intervalHours: 24,
  },
  externalHooks: {
    management: "manual",
  },
};

export type AgentSecurityHookEventName =
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "PermissionRequested"
  | "PermissionApproved"
  | "PermissionDenied"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure";

export type AgentSecurityToolClass =
  | "shell"
  | "file_read"
  | "file_write"
  | "file_delete"
  | "network"
  | "mcp"
  | "computer_use"
  | "generic";

export interface AgentSecurityAction {
  command?: string;
  file_path?: string;
  destination_path?: string;
  url?: string;
  mcp_server?: string;
  mcp_tool?: string;
  input_keys?: string[];
}

export interface AgentSecurityHookPayload {
  protocol_version: typeof AGENT_SECURITY_PROTOCOL_VERSION;
  hook_event_name: AgentSecurityHookEventName;
  source_agent: "cowork-os";
  timestamp: string;
  task_id: string;
  session_id: string;
  tool_call_id?: string;
  workspace_path?: string;
  tool_name?: string;
  tool_class?: AgentSecurityToolClass;
  action?: AgentSecurityAction;
  // Numbat live-hook compatibility fields. This is the same bounded action
  // projection as `action`, never the original untrusted tool input.
  cwd?: string;
  tool_input?: Record<string, unknown>;
  model?: string;
  model_provider?: string;
  is_error?: boolean;
  exit_code?: number;
  duration_ms?: number;
  context?: {
    actor: "user" | "assistant" | "system" | "tool";
    provider?: string;
    model?: string;
    permission_mode?: string;
    sub_agent?: boolean;
  };
  result?: {
    success: boolean;
    exit_code?: number;
    duration_ms?: number;
    output_bytes?: number;
    error_type?: string;
  };
}

export type AgentSecurityDecision = "no_override" | "deny";
export type AgentSecurityHealth = "disabled" | "ok" | "degraded" | "unavailable";

export interface AgentSecurityHookResponse {
  protocol_version: typeof AGENT_SECURITY_PROTOCOL_VERSION;
  decision: AgentSecurityDecision;
  decision_id?: string;
  health: "ok" | "degraded";
  reason?: string;
}

export interface AgentSecurityEvaluationResult {
  decision: AgentSecurityDecision;
  health: AgentSecurityHealth;
  reason?: string;
  decisionId?: string;
  durationMs: number;
  failureCode?: string;
}

export type AgentSecurityFindingStatus = "open" | "acknowledged" | "resolved" | "false_positive";

export interface AgentSecurityFinding {
  findingId: string;
  schemaVersion: string;
  taskId?: string;
  sessionId?: string;
  sourceAgent: string;
  sourceType: string;
  ruleId: string;
  ruleVersion: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  title: string;
  status: AgentSecurityFindingStatus;
  detectedAt: string;
  observedAt?: string;
  projectPathHash?: string;
  record: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface AgentSecurityEnforcement {
  decisionId: string;
  schemaVersion: string;
  taskId?: string;
  sessionId?: string;
  toolCallId?: string;
  decision: AgentSecurityDecision;
  mode: AgentSecurityMode;
  reason: string;
  sourceAgent: string;
  findingIds: string[];
  ruleIds: string[];
  hostOutcome?: "blocked" | "executed" | "failed" | "unknown";
  record: Record<string, unknown>;
  createdAt: number;
}

export interface AgentSecurityDiagnostic {
  id: string;
  taskId?: string;
  level: "info" | "warn" | "error";
  code: string;
  message: string;
  createdAt: number;
}

export interface AgentSecurityRuntimeStatus {
  enabled: boolean;
  mode: AgentSecurityMode;
  health: AgentSecurityHealth;
  binaryPath?: string;
  binaryVersion?: string;
  schemaVersion?: string;
  lastCheckedAt?: number;
  lastError?: string;
  pendingObservations: number;
}

export interface AgentSecurityFindingQuery {
  taskId?: string;
  severity?: AgentSecurityFinding["severity"];
  status?: AgentSecurityFindingStatus;
  limit?: number;
  offset?: number;
}

export interface AgentSecurityInventoryItem {
  agentId: string;
  present: boolean;
  wired: boolean;
  liveMode?: string;
  details: Record<string, unknown>;
  checkedAt: number;
}

export interface AgentSecurityScanResult {
  outputFile: string;
  findings: number;
}

export interface AgentSecurityRulesCheckResult {
  ok: true;
  output: string;
}

export interface AgentSecurityHookManagementResult {
  output: string;
}

export interface AgentSecurityCaseBuildResult {
  caseId: string;
  taskId: string;
  bundleName: string;
  bundlePath: string;
  output: string;
}

export interface AgentSecurityCaseVerifyResult {
  bundleName: string;
  bundlePath: string;
  verified: true;
  output: string;
}
