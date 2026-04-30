import type {
  AgentConfig,
  AgentRole,
  ApprovalType,
  OperationalAutonomyPolicy,
} from "../../shared/types";

const DEFAULT_AUTO_APPROVE_TYPES: ApprovalType[] = ["run_command"];
const SAFE_AUTONOMY_APPROVE_TYPES: ApprovalType[] = ["run_command"];
const FOUNDER_EDGE_APPROVE_TYPES: ApprovalType[] = ["run_command"];

function normalizeApprovalTypes(value: unknown): ApprovalType[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(
      (entry): entry is ApprovalType =>
        entry === "run_command" ||
        entry === "external_service" ||
        entry === "network_access" ||
        entry === "data_export" ||
        entry === "computer_use" ||
        entry === "delete_file" ||
        entry === "delete_multiple" ||
        entry === "bulk_rename",
    );
  return normalized;
}

export function resolveOperationalAutonomyPolicy(
  agent: Pick<AgentRole, "soul">,
): OperationalAutonomyPolicy | undefined {
  const rawSoul = typeof agent.soul === "string" ? agent.soul.trim() : "";
  if (!rawSoul) return undefined;

  try {
    const soul = JSON.parse(rawSoul) as {
      autonomyPolicy?: Partial<OperationalAutonomyPolicy>;
    };
    const policy = soul.autonomyPolicy;
    if (!policy?.preset) return undefined;

    return {
      preset: policy.preset,
      autonomousMode: typeof policy.autonomousMode === "boolean" ? policy.autonomousMode : undefined,
      autoApproveTypes: normalizeApprovalTypes(policy.autoApproveTypes),
      allowUserInput: typeof policy.allowUserInput === "boolean" ? policy.allowUserInput : undefined,
      pauseForRequiredDecision:
        typeof policy.pauseForRequiredDecision === "boolean"
          ? policy.pauseForRequiredDecision
          : undefined,
      requireWorktree: typeof policy.requireWorktree === "boolean" ? policy.requireWorktree : undefined,
    };
  } catch {
    return undefined;
  }
}

export function buildAgentConfigFromAutonomyPolicy(
  policy?: OperationalAutonomyPolicy,
): Partial<AgentConfig> {
  if (!policy) return {};

  if (policy.preset === "manual") {
    return {
      ...(typeof policy.allowUserInput === "boolean" ? { allowUserInput: policy.allowUserInput } : {}),
      ...(typeof policy.pauseForRequiredDecision === "boolean"
        ? { pauseForRequiredDecision: policy.pauseForRequiredDecision }
        : {}),
      ...(typeof policy.requireWorktree === "boolean" ? { requireWorktree: policy.requireWorktree } : {}),
    };
  }

  const autoApproveTypes =
    policy.autoApproveTypes !== undefined
      ? policy.autoApproveTypes
      : policy.preset === "founder_edge"
        ? FOUNDER_EDGE_APPROVE_TYPES
        : policy.preset === "safe_autonomy"
          ? SAFE_AUTONOMY_APPROVE_TYPES
          : DEFAULT_AUTO_APPROVE_TYPES;
  return {
    autonomousMode: policy.autonomousMode ?? true,
    autoApproveTypes,
    allowUserInput: policy.allowUserInput ?? false,
    pauseForRequiredDecision: policy.pauseForRequiredDecision ?? false,
    ...(typeof policy.requireWorktree === "boolean" ? { requireWorktree: policy.requireWorktree } : {}),
  };
}

export function buildCoreAutomationAgentConfig(
  rolePolicy?: OperationalAutonomyPolicy,
  overrides?: Partial<AgentConfig>,
): Partial<AgentConfig> {
  return {
    ...buildAgentConfigFromAutonomyPolicy({
      preset: "founder_edge",
      autonomousMode: true,
      allowUserInput: false,
      pauseForRequiredDecision: false,
    }),
    ...buildAgentConfigFromAutonomyPolicy(rolePolicy),
    allowUserInput: false,
    pauseForRequiredDecision: false,
    ...overrides,
  };
}
