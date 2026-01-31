/**
 * Security Policy Manager
 *
 * Implements monotonic policy precedence (deny-wins) for tool access control.
 *
 * Policy layers (evaluated in order):
 * 1. Global Guardrails (blocked commands, patterns)
 * 2. Workspace Permissions (read, write, delete, shell, network)
 * 3. Context Restrictions (private/group/public channel context)
 * 4. Tool-Specific Rules (per-tool overrides)
 *
 * Key invariant: Once a tool is denied by an earlier layer, later layers CANNOT re-enable it.
 */

import {
  Workspace,
  WorkspacePermissions,
  ToolType,
  ToolRiskLevel,
  GatewayContextType,
  TOOL_GROUPS,
  ToolGroupName,
  TOOL_RISK_LEVELS,
  CONTEXT_TOOL_RESTRICTIONS,
} from '../../shared/types';
import { GuardrailSettings } from '../../shared/types';

/**
 * Result of a policy check
 */
export interface PolicyCheckResult {
  allowed: boolean;
  reason?: string;
  deniedBy?: PolicyLayer;
  requiresApproval?: boolean;
  approvalReason?: string;
}

/**
 * Policy layers in precedence order
 */
export type PolicyLayer =
  | 'global_guardrails'
  | 'workspace_permissions'
  | 'context_restrictions'
  | 'tool_specific';

/**
 * Policy decision at each layer
 */
export interface LayerDecision {
  layer: PolicyLayer;
  decision: 'allow' | 'deny' | 'require_approval' | 'pass';
  reason?: string;
}

/**
 * Context for policy evaluation
 */
export interface PolicyContext {
  workspace: Workspace;
  guardrails: GuardrailSettings;
  gatewayContext?: GatewayContextType;
  toolInput?: Record<string, any>;
}

/**
 * Security Policy Manager implementing monotonic deny-wins precedence
 */
export class SecurityPolicyManager {
  private deniedTools: Set<string> = new Set();
  private approvalRequiredTools: Set<string> = new Set();
  private layerDecisions: Map<string, LayerDecision[]> = new Map();

  constructor(private context: PolicyContext) {
    this.evaluateAllPolicies();
  }

  /**
   * Check if a tool is allowed to execute
   * Implements C2: Approval Gate Enforcement
   */
  checkToolAccess(toolName: string, input?: Record<string, any>): PolicyCheckResult {
    // Check if tool was denied by any layer
    if (this.deniedTools.has(toolName)) {
      const decisions = this.layerDecisions.get(toolName) || [];
      const denyDecision = decisions.find(d => d.decision === 'deny');
      return {
        allowed: false,
        reason: denyDecision?.reason || `Tool "${toolName}" is not permitted`,
        deniedBy: denyDecision?.layer,
      };
    }

    // Check if tool requires approval
    if (this.approvalRequiredTools.has(toolName)) {
      const decisions = this.layerDecisions.get(toolName) || [];
      const approvalDecision = decisions.find(d => d.decision === 'require_approval');
      return {
        allowed: true,
        requiresApproval: true,
        approvalReason: approvalDecision?.reason || `Tool "${toolName}" requires approval`,
      };
    }

    // Tool-specific input validation for shell commands
    if (toolName === 'run_command' && input?.command) {
      const commandCheck = this.checkCommandPolicy(input.command);
      if (!commandCheck.allowed) {
        return commandCheck;
      }
    }

    return { allowed: true };
  }

  /**
   * Check if a command is allowed by guardrails
   */
  private checkCommandPolicy(command: string): PolicyCheckResult {
    const { guardrails } = this.context;

    // Check blocked patterns (always denied, cannot be overridden)
    if (guardrails.blockDangerousCommands) {
      const allBlockedPatterns = [
        ...getDefaultBlockedPatterns(),
        ...guardrails.customBlockedPatterns,
      ];

      for (const pattern of allBlockedPatterns) {
        try {
          const regex = new RegExp(pattern, 'i');
          if (regex.test(command)) {
            return {
              allowed: false,
              reason: `Command blocked by security policy: matches pattern "${pattern}"`,
              deniedBy: 'global_guardrails',
            };
          }
        } catch {
          // Invalid regex pattern, skip
        }
      }
    }

    // Check trusted patterns (auto-approve)
    // NOTE: Trusted patterns can NEVER override a deny - they only affect approval requirement
    if (guardrails.autoApproveTrustedCommands) {
      for (const pattern of guardrails.trustedCommandPatterns) {
        if (matchGlobPattern(command, pattern)) {
          return {
            allowed: true,
            requiresApproval: false,
          };
        }
      }
    }

    // Default: requires approval for shell commands
    return {
      allowed: true,
      requiresApproval: true,
      approvalReason: 'Shell commands require approval',
    };
  }

  /**
   * Get all denied tools
   */
  getDeniedTools(): string[] {
    return Array.from(this.deniedTools);
  }

  /**
   * Get all tools requiring approval
   */
  getApprovalRequiredTools(): string[] {
    return Array.from(this.approvalRequiredTools);
  }

  /**
   * Get policy decisions for a tool (for debugging/audit)
   */
  getToolDecisions(toolName: string): LayerDecision[] {
    return this.layerDecisions.get(toolName) || [];
  }

  /**
   * Expand a tool group to individual tools
   * Implements C4: Tool Group Expansion Accuracy
   */
  static expandToolGroup(groupName: ToolGroupName): readonly string[] {
    return TOOL_GROUPS[groupName] || [];
  }

  /**
   * Check if a tool belongs to a group
   */
  static isToolInGroup(toolName: string, groupName: ToolGroupName): boolean {
    const tools = TOOL_GROUPS[groupName];
    return tools ? (tools as readonly string[]).includes(toolName) : false;
  }

  /**
   * Get risk level for a tool
   */
  static getToolRiskLevel(toolName: string): ToolRiskLevel | undefined {
    return TOOL_RISK_LEVELS[toolName as ToolType];
  }

  // Private methods

  /**
   * Evaluate all policy layers and build the denied/approval-required sets
   * Key invariant: Once denied, a tool stays denied (monotonic)
   */
  private evaluateAllPolicies(): void {
    const allTools = this.getAllKnownTools();

    for (const toolName of allTools) {
      const decisions: LayerDecision[] = [];

      // Layer 1: Global Guardrails
      const guardrailDecision = this.evaluateGuardrailLayer(toolName);
      decisions.push(guardrailDecision);
      if (guardrailDecision.decision === 'deny') {
        this.deniedTools.add(toolName);
        this.layerDecisions.set(toolName, decisions);
        continue; // Monotonic: skip remaining layers
      }

      // Layer 2: Workspace Permissions
      const workspaceDecision = this.evaluateWorkspaceLayer(toolName);
      decisions.push(workspaceDecision);
      if (workspaceDecision.decision === 'deny') {
        this.deniedTools.add(toolName);
        this.layerDecisions.set(toolName, decisions);
        continue; // Monotonic: skip remaining layers
      }

      // Layer 3: Context Restrictions (if gateway context is set)
      if (this.context.gatewayContext) {
        const contextDecision = this.evaluateContextLayer(toolName);
        decisions.push(contextDecision);
        if (contextDecision.decision === 'deny') {
          this.deniedTools.add(toolName);
          this.layerDecisions.set(toolName, decisions);
          continue; // Monotonic: skip remaining layers
        }
        if (contextDecision.decision === 'require_approval') {
          this.approvalRequiredTools.add(toolName);
        }
      }

      // Layer 4: Tool-Specific Rules
      const toolSpecificDecision = this.evaluateToolSpecificLayer(toolName);
      decisions.push(toolSpecificDecision);
      if (toolSpecificDecision.decision === 'deny') {
        this.deniedTools.add(toolName);
      } else if (toolSpecificDecision.decision === 'require_approval') {
        this.approvalRequiredTools.add(toolName);
      }

      this.layerDecisions.set(toolName, decisions);
    }
  }

  /**
   * Layer 1: Global Guardrails
   */
  private evaluateGuardrailLayer(toolName: string): LayerDecision {
    const { guardrails } = this.context;

    // Network tools require network to be allowed in guardrails
    if (SecurityPolicyManager.isToolInGroup(toolName, 'group:network')) {
      if (guardrails.enforceAllowedDomains && guardrails.allowedDomains.length === 0) {
        return {
          layer: 'global_guardrails',
          decision: 'deny',
          reason: 'Network tools blocked: no allowed domains configured',
        };
      }
    }

    return { layer: 'global_guardrails', decision: 'pass' };
  }

  /**
   * Layer 2: Workspace Permissions
   */
  private evaluateWorkspaceLayer(toolName: string): LayerDecision {
    const { workspace } = this.context;
    const permissions = workspace.permissions;

    // Check read permission
    if (SecurityPolicyManager.isToolInGroup(toolName, 'group:read')) {
      if (!permissions.read) {
        return {
          layer: 'workspace_permissions',
          decision: 'deny',
          reason: 'Workspace does not have read permission',
        };
      }
    }

    // Check write permission
    if (SecurityPolicyManager.isToolInGroup(toolName, 'group:write')) {
      if (!permissions.write) {
        return {
          layer: 'workspace_permissions',
          decision: 'deny',
          reason: 'Workspace does not have write permission',
        };
      }
    }

    // Check delete permission
    if (toolName === 'delete_file') {
      if (!permissions.delete) {
        return {
          layer: 'workspace_permissions',
          decision: 'require_approval',
          reason: 'File deletion requires approval (delete permission not granted)',
        };
      }
    }

    // Check shell permission
    if (toolName === 'run_command') {
      if (!permissions.shell) {
        return {
          layer: 'workspace_permissions',
          decision: 'deny',
          reason: 'Workspace does not have shell permission',
        };
      }
      // Shell commands always require approval even with permission
      return {
        layer: 'workspace_permissions',
        decision: 'require_approval',
        reason: 'Shell commands require approval',
      };
    }

    // Check network permission
    if (SecurityPolicyManager.isToolInGroup(toolName, 'group:network')) {
      if (!permissions.network) {
        return {
          layer: 'workspace_permissions',
          decision: 'deny',
          reason: 'Workspace does not have network permission',
        };
      }
    }

    return { layer: 'workspace_permissions', decision: 'pass' };
  }

  /**
   * Layer 3: Context Restrictions (Gateway context)
   * Implements C1: Memory Tool Isolation in Shared Contexts
   */
  private evaluateContextLayer(toolName: string): LayerDecision {
    const contextType = this.context.gatewayContext;
    if (!contextType) {
      return { layer: 'context_restrictions', decision: 'pass' };
    }

    const restrictions = CONTEXT_TOOL_RESTRICTIONS[contextType];

    // Check if tool is explicitly denied
    if (restrictions.deniedTools.includes(toolName)) {
      return {
        layer: 'context_restrictions',
        decision: 'deny',
        reason: `Tool "${toolName}" is not allowed in ${contextType} context`,
      };
    }

    // Check if tool's group is denied
    for (const groupName of restrictions.deniedGroups) {
      if (SecurityPolicyManager.isToolInGroup(toolName, groupName)) {
        return {
          layer: 'context_restrictions',
          decision: 'deny',
          reason: `Tool group "${groupName}" is not allowed in ${contextType} context`,
        };
      }
    }

    // Check if tool requires approval in this context
    if (restrictions.requireApprovalFor.includes(toolName)) {
      return {
        layer: 'context_restrictions',
        decision: 'require_approval',
        reason: `Tool "${toolName}" requires approval in ${contextType} context`,
      };
    }

    return { layer: 'context_restrictions', decision: 'pass' };
  }

  /**
   * Layer 4: Tool-Specific Rules
   */
  private evaluateToolSpecificLayer(toolName: string): LayerDecision {
    // Destructive tools always require approval
    const riskLevel = SecurityPolicyManager.getToolRiskLevel(toolName);
    if (riskLevel === 'destructive') {
      return {
        layer: 'tool_specific',
        decision: 'require_approval',
        reason: `Destructive tool "${toolName}" requires approval`,
      };
    }

    return { layer: 'tool_specific', decision: 'pass' };
  }

  /**
   * Get all known tool names
   */
  private getAllKnownTools(): string[] {
    const tools = new Set<string>();

    // Add all tools from groups
    for (const groupTools of Object.values(TOOL_GROUPS)) {
      for (const tool of groupTools) {
        tools.add(tool);
      }
    }

    // Add tools from TOOL_RISK_LEVELS
    for (const tool of Object.keys(TOOL_RISK_LEVELS)) {
      tools.add(tool);
    }

    return Array.from(tools);
  }
}

/**
 * Default blocked command patterns (security-critical)
 */
function getDefaultBlockedPatterns(): string[] {
  return [
    'sudo',
    'rm\\s+-rf\\s+/',
    'rm\\s+-rf\\s+~',
    'rm\\s+-rf\\s+/\\*',
    'rm\\s+-rf\\s+\\*',
    'mkfs',
    'dd\\s+if=',
    ':\\(\\)\\{\\s*:\\|:\\&\\s*\\};:', // Fork bomb
    'curl.*\\|.*bash',
    'wget.*\\|.*bash',
    'curl.*\\|.*sh',
    'wget.*\\|.*sh',
    'chmod\\s+777',
    '>\\s*/dev/sd',
    'mv\\s+/\\*',
    'format\\s+c:',
    'del\\s+/f\\s+/s\\s+/q',
  ];
}

/**
 * Match a command against a glob-like pattern
 */
function matchGlobPattern(command: string, pattern: string): boolean {
  // Convert glob pattern to regex
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape special chars except * and ?
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');

  try {
    const regex = new RegExp(`^${regexPattern}$`, 'i');
    return regex.test(command);
  } catch {
    return false;
  }
}

/**
 * Create a policy manager for a workspace context
 */
export function createPolicyManager(
  workspace: Workspace,
  guardrails: GuardrailSettings,
  gatewayContext?: GatewayContextType
): SecurityPolicyManager {
  return new SecurityPolicyManager({
    workspace,
    guardrails,
    gatewayContext,
  });
}

/**
 * Quick check if a tool is allowed (without full policy evaluation)
 * Use for filtering tool lists before presenting to LLM
 */
export function isToolAllowedQuick(
  toolName: string,
  workspace: Workspace,
  gatewayContext?: GatewayContextType
): boolean {
  const permissions = workspace.permissions;

  // Check basic permissions
  if (SecurityPolicyManager.isToolInGroup(toolName, 'group:read') && !permissions.read) {
    return false;
  }
  if (SecurityPolicyManager.isToolInGroup(toolName, 'group:write') && !permissions.write) {
    return false;
  }
  if (toolName === 'run_command' && !permissions.shell) {
    return false;
  }
  if (SecurityPolicyManager.isToolInGroup(toolName, 'group:network') && !permissions.network) {
    return false;
  }

  // Check context restrictions
  if (gatewayContext) {
    const restrictions = CONTEXT_TOOL_RESTRICTIONS[gatewayContext];
    if (restrictions.deniedTools.includes(toolName)) {
      return false;
    }
    for (const groupName of restrictions.deniedGroups) {
      if (SecurityPolicyManager.isToolInGroup(toolName, groupName)) {
        return false;
      }
    }
  }

  return true;
}
