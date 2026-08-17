import path from "node:path";
import {
  AGENT_SECURITY_PROTOCOL_VERSION,
  type AgentSecurityAction,
  type AgentSecurityHookEventName,
  type AgentSecurityHookPayload,
  type AgentSecurityToolClass,
} from "../../../shared/agent-security";
import { isSensitiveAgentSecurityKey, redactAgentSecurityString } from "./NumbatRedaction";

const FILE_READ_TOOLS = new Set([
  "read_file",
  "read_files",
  "parse_document",
  "get_file_info",
  "list_directory",
  "list_directory_with_sizes",
  "search_files",
  "glob",
  "grep",
  "git_show",
  "git_diff",
]);
const FILE_DELETE_TOOLS = new Set(["delete_file"]);
const FILE_WRITE_TOOLS = new Set([
  "write_file",
  "edit_file",
  "create_directory",
  "rename_file",
  "copy_file",
  "create_document",
  "edit_document",
  "create_spreadsheet",
  "create_presentation",
  "edit_pdf_region",
]);
const NETWORK_TOOLS = new Set([
  "web_fetch",
  "web_search",
  "http_request",
  "browser_navigate",
  "browser_fetch",
  "browser_open",
  "scrape_page",
  "scrape_session",
]);
const COMMAND_KEYS = ["command", "cmd", "script", "shell_command"] as const;
const FILE_KEYS = [
  "path",
  "file_path",
  "filePath",
  "sourcePath",
  "source_path",
  "old_path",
] as const;
const DESTINATION_KEYS = [
  "destination_path",
  "destinationPath",
  "destPath",
  "new_path",
  "newPath",
] as const;
const URL_KEYS = ["url", "uri", "endpoint", "origin"] as const;

type PlainObject = Record<string, unknown>;

function asObject(value: unknown): PlainObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as PlainObject) : {};
}

function firstString(input: PlainObject, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function normalizeToolName(toolName: string): string {
  return toolName.replace(/^(?:functions|tools?|mcp)\./, "").trim();
}

function parseMcpName(toolName: string): { server?: string; tool?: string } {
  const doubleUnderscore = toolName.match(/^mcp__([^_]+(?:_[^_]+)*)__([^_].*)$/);
  if (doubleUnderscore) {
    return { server: doubleUnderscore[1], tool: doubleUnderscore[2] };
  }
  const dotted = toolName.match(/^mcp[.:/]([^.:/]+)[.:/](.+)$/);
  if (dotted) return { server: dotted[1], tool: dotted[2] };
  return {};
}

function inferToolClass(toolName: string): AgentSecurityToolClass {
  const normalized = normalizeToolName(toolName);
  if (normalized === "run_command" || normalized === "run_applescript") return "shell";
  if (FILE_DELETE_TOOLS.has(normalized)) return "file_delete";
  if (FILE_WRITE_TOOLS.has(normalized)) return "file_write";
  if (FILE_READ_TOOLS.has(normalized)) return "file_read";
  if (NETWORK_TOOLS.has(normalized) || normalized.startsWith("browser_")) return "network";
  if (normalized.startsWith("mcp_") || normalized.startsWith("mcp__")) return "mcp";
  if (
    normalized === "screenshot" ||
    normalized === "click" ||
    normalized === "type_text" ||
    normalized === "keypress" ||
    normalized === "drag" ||
    normalized === "scroll"
  ) {
    return "computer_use";
  }
  return "generic";
}

function resolveFilePath(rawPath: string | undefined, workspacePath?: string): string | undefined {
  if (!rawPath) return undefined;
  if (path.isAbsolute(rawPath) || !workspacePath) return rawPath;
  return path.resolve(workspacePath, rawPath);
}

function inputKeys(input: PlainObject): string[] {
  return Object.keys(input)
    .slice(0, 64)
    .map((key) => (isSensitiveAgentSecurityKey(key) ? "[REDACTED_KEY]" : key));
}

export function buildAgentSecurityAction(
  toolName: string,
  toolInput: unknown,
  workspacePath?: string,
): { toolClass: AgentSecurityToolClass; action: AgentSecurityAction } {
  const normalized = normalizeToolName(toolName);
  const input = asObject(toolInput);
  const toolClass = inferToolClass(normalized);
  const action: AgentSecurityAction = { input_keys: inputKeys(input) };
  if (toolClass === "shell") {
    const command = firstString(input, COMMAND_KEYS);
    action.command = command ? redactAgentSecurityString(command, 8_192) : undefined;
  } else if (
    toolClass === "file_read" ||
    toolClass === "file_write" ||
    toolClass === "file_delete"
  ) {
    const filePath = resolveFilePath(firstString(input, FILE_KEYS), workspacePath);
    const destinationPath = resolveFilePath(firstString(input, DESTINATION_KEYS), workspacePath);
    action.file_path = filePath ? redactAgentSecurityString(filePath, 4_096) : undefined;
    action.destination_path = destinationPath
      ? redactAgentSecurityString(destinationPath, 4_096)
      : undefined;
  } else if (toolClass === "network") {
    const url = firstString(input, URL_KEYS);
    action.url = url ? redactAgentSecurityString(url, 4_096) : undefined;
  } else if (toolClass === "mcp") {
    const parsed = parseMcpName(normalized);
    action.mcp_server = parsed.server || firstString(input, ["server", "serverName", "mcp_server"]);
    action.mcp_tool = parsed.tool || firstString(input, ["tool", "toolName", "mcp_tool"]);
  }
  return { toolClass, action };
}

export function buildAgentSecurityHookPayload(input: {
  hookEventName: AgentSecurityHookEventName;
  taskId: string;
  sessionId?: string;
  workspacePath?: string;
  toolCallId?: string;
  toolName?: string;
  toolInput?: unknown;
  actor?: "user" | "assistant" | "system" | "tool";
  provider?: string;
  model?: string;
  permissionMode?: string;
  subAgent?: boolean;
  result?: AgentSecurityHookPayload["result"];
}): AgentSecurityHookPayload {
  const mapped = input.toolName
    ? buildAgentSecurityAction(input.toolName, input.toolInput, input.workspacePath)
    : undefined;
  const toolInput: Record<string, unknown> | undefined = mapped
    ? {
        ...(mapped.action.command ? { command: mapped.action.command } : {}),
        ...(mapped.action.file_path ? { path: mapped.action.file_path } : {}),
        ...(mapped.action.destination_path
          ? { destination_path: mapped.action.destination_path }
          : {}),
        ...(mapped.action.url ? { url: mapped.action.url } : {}),
        ...(mapped.action.mcp_server ? { mcp_server: mapped.action.mcp_server } : {}),
        ...(mapped.action.mcp_tool ? { mcp_tool: mapped.action.mcp_tool } : {}),
        ...(mapped.action.input_keys ? { input_keys: mapped.action.input_keys } : {}),
      }
    : undefined;
  return {
    protocol_version: AGENT_SECURITY_PROTOCOL_VERSION,
    hook_event_name: input.hookEventName,
    source_agent: "cowork-os",
    timestamp: new Date().toISOString(),
    task_id: input.taskId,
    session_id: input.sessionId || input.taskId,
    tool_call_id: input.toolCallId,
    workspace_path: input.workspacePath,
    cwd: input.workspacePath,
    tool_name: input.toolName ? normalizeToolName(input.toolName) : undefined,
    tool_class: mapped?.toolClass,
    action: mapped?.action,
    tool_input: toolInput,
    model: input.model,
    model_provider: input.provider,
    is_error: input.result ? !input.result.success : undefined,
    exit_code: input.result?.exit_code,
    duration_ms: input.result?.duration_ms,
    context: {
      actor: input.actor || (input.toolName ? "assistant" : "system"),
      provider: input.provider,
      model: input.model,
      permission_mode: input.permissionMode,
      sub_agent: input.subAgent,
    },
    result: input.result,
  };
}

export function hookEventToLifecycle(eventName: AgentSecurityHookEventName): string {
  switch (eventName) {
    case "SessionStart":
      return "session-start";
    case "SessionEnd":
      return "session-end";
    case "UserPromptSubmit":
      return "prompt";
    case "PermissionRequested":
      return "permission-requested";
    case "PermissionApproved":
      return "permission-approved";
    case "PermissionDenied":
      return "permission-denied";
    case "PreToolUse":
      return "pre-tool";
    case "PostToolUse":
      return "post-tool";
    case "PostToolUseFailure":
      return "post-tool-failure";
  }
}
