import type { ToolAttemptEffect } from "../../../shared/types";
import { getConfiguredMcpToolPolicy } from "../../mcp/tool-policy";
import { isMutatingTool } from "../tool-policy-engine";

const MCP_TOOL_PREFIX = "mcp_";

/**
 * Whether a call can change something outside the conversation. Uses the same taxonomy as the
 * permission engine (`isMutatingTool`, which consults TOOL_GROUPS first); MCP tools are reads
 * only when their server marks them `readOnlyHint`, and otherwise their effect is unknown.
 */
export function resolveToolEffect(
  toolName: string,
  options: { mcpReadOnly?: (toolName: string) => boolean | undefined } = {},
): ToolAttemptEffect {
  if (toolName.startsWith(MCP_TOOL_PREFIX)) {
    const readOnly = options.mcpReadOnly
      ? options.mcpReadOnly(toolName)
      : getConfiguredMcpToolPolicy(toolName)?.readOnly;
    return readOnly === true ? "read" : "unknown";
  }
  return isMutatingTool(toolName) ? "write" : "read";
}

const TARGET_KEYS = [
  "path",
  "filePath",
  "file_path",
  "destPath",
  "destination",
  "outputPath",
  "to",
  "url",
] as const;

/** The file, path or URL a call acts on, when its input names one. */
export function toolCallTarget(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of TARGET_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 1_000);
  }
  return undefined;
}

/** A read tool that can show whether an unknown write happened. */
export function suggestedReadBackTool(toolName: string, target?: string): string {
  if (toolName.startsWith(MCP_TOOL_PREFIX)) {
    return "the connector's list, search or get tool";
  }
  if (toolName === "run_command" || toolName === "desktop_run") {
    return "a read-only command such as ls or git status";
  }
  if (target && /^https?:\/\//i.test(target)) return `web_fetch on ${target}`;
  if (target) return `read_file or list_directory on ${target}`;
  return "a read tool";
}
