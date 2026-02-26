import { ConversationMode, ExecutionMode, TaskDomain, ToolDecision } from "../../shared/types";

export interface ToolPolicyContext {
  executionMode?: ExecutionMode;
  taskDomain?: TaskDomain;
  conversationMode?: ConversationMode;
  taskIntent?: string;
}

export interface ToolPolicyResult {
  decision: ToolDecision;
  reason?: string;
  mode: ExecutionMode;
  domain: TaskDomain;
}

export interface BlockedTool {
  name: string;
  decision: ToolDecision;
  reason?: string;
}

const READONLY_GIT_TOOLS = new Set([
  "git_status",
  "git_diff",
  "git_log",
  "git_show",
  "git_branch",
  "git_ls_files",
  "git_blame",
  "git_refs",
]);

const ALWAYS_MUTATING = new Set([
  "run_command",
  "run_applescript",
  "schedule_task",
  "spawn_agent",
  "orchestrate_agents",
  "send_agent_message",
  "cancel_agent",
  "pause_agent",
  "resume_agent",
  "switch_workspace",
  "browser_click",
  "browser_type",
  "browser_drag",
  "browser_scroll",
  "browser_select_option",
  "browser_press_key",
  "browser_handle_dialog",
  "browser_file_upload",
  "browser_go_back",
  "browser_refresh",
  "browser_new_tab",
  "browser_close_tab",
  "browser_close",
  "cloud_sandbox_create",
  "cloud_sandbox_exec",
  "cloud_sandbox_write_file",
  "cloud_sandbox_delete",
  "domain_register",
  "domain_dns_add",
  "domain_dns_delete",
  "x402_fetch",
]);

const MUTATING_PREFIXES = [
  "create_",
  "write_",
  "edit_",
  "delete_",
  "rename_",
  "move_",
  "copy_",
  "generate_",
  "publish_",
  "deploy_",
  "submit_",
  "approve_",
  "merge_",
  "rebase_",
  "revert_",
  "push_",
  "mint_",
  "airdrop_",
];

const READONLY_PREFIXES = [
  "read_",
  "list_",
  "get_",
  "search_",
  "find_",
  "inspect_",
  "check_",
  "task_",
  "web_",
];

function isReadOnlyByPrefix(toolName: string): boolean {
  return READONLY_PREFIXES.some((prefix) => toolName.startsWith(prefix));
}

function isMutatingGitTool(toolName: string): boolean {
  return toolName.startsWith("git_") && !READONLY_GIT_TOOLS.has(toolName);
}

function isMutatingTool(toolName: string): boolean {
  if (ALWAYS_MUTATING.has(toolName)) return true;
  if (isMutatingGitTool(toolName)) return true;
  if (toolName.endsWith("_action")) return true;
  if (toolName.startsWith("mcp_")) return true;
  if (isReadOnlyByPrefix(toolName)) return false;
  return MUTATING_PREFIXES.some((prefix) => toolName.startsWith(prefix));
}

function inferModeFromConversationMode(conversationMode?: ConversationMode): ExecutionMode | null {
  if (conversationMode === "chat" || conversationMode === "think") return "analyze";
  return null;
}

export function normalizeExecutionMode(
  executionMode: ExecutionMode | undefined,
  conversationMode?: ConversationMode,
): ExecutionMode {
  if (executionMode) return executionMode;
  return inferModeFromConversationMode(conversationMode) ?? "execute";
}

export function normalizeTaskDomain(taskDomain: TaskDomain | undefined): TaskDomain {
  return taskDomain ?? "auto";
}

function applyModeGate(toolName: string, mode: ExecutionMode): string | null {
  if (mode === "execute") return null;
  if (!isMutatingTool(toolName)) return null;

  if (mode === "propose") {
    return `Tool "${toolName}" is blocked in propose mode because it may mutate state. Switch to execute mode to run it.`;
  }
  return `Tool "${toolName}" is blocked in analyze mode. Analyze mode is read-only by design.`;
}

function applyDomainGate(toolName: string, domain: TaskDomain): string | null {
  if (domain === "auto" || domain === "code" || domain === "operations") return null;

  if (toolName === "run_command" || toolName === "run_applescript") {
    return `Tool "${toolName}" is blocked for the "${domain}" domain. Use non-shell tools or switch domain to code/operations.`;
  }

  if (isMutatingGitTool(toolName)) {
    return `Tool "${toolName}" is blocked for the "${domain}" domain because git mutation is not expected here.`;
  }

  if (
    toolName.startsWith("cloud_sandbox_") ||
    toolName.startsWith("domain_") ||
    toolName.startsWith("wallet_") ||
    toolName.startsWith("x402_")
  ) {
    return `Tool "${toolName}" is blocked for the "${domain}" domain because it is operations-specific.`;
  }

  return null;
}

export function evaluateToolPolicy(toolName: string, ctx: ToolPolicyContext): ToolPolicyResult {
  const mode = normalizeExecutionMode(ctx.executionMode, ctx.conversationMode);
  const domain = normalizeTaskDomain(ctx.taskDomain);

  const modeReason = applyModeGate(toolName, mode);
  if (modeReason) {
    return { decision: "deny", reason: modeReason, mode, domain };
  }

  const domainReason = applyDomainGate(toolName, domain);
  if (domainReason) {
    return { decision: "deny", reason: domainReason, mode, domain };
  }

  return { decision: "allow", mode, domain };
}

export function filterToolsByPolicy<T extends { name: string }>(
  tools: T[],
  ctx: ToolPolicyContext,
): { tools: T[]; blocked: BlockedTool[] } {
  const allowed: T[] = [];
  const blocked: BlockedTool[] = [];

  for (const tool of tools) {
    const decision = evaluateToolPolicy(tool.name, ctx);
    if (decision.decision === "allow") {
      allowed.push(tool);
      continue;
    }

    blocked.push({
      name: tool.name,
      decision: decision.decision,
      reason: decision.reason,
    });
  }

  return { tools: allowed, blocked };
}
