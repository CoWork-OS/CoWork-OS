import type {
  RuntimeToolApprovalKind,
  RuntimeToolCapabilityTag,
  RuntimeToolConcurrencyClass,
  RuntimeToolInterruptBehavior,
  RuntimeToolMetadata,
  RuntimeToolResultKind,
  RuntimeToolSideEffectLevel,
} from "../../../shared/types";
import { isComputerUseToolName } from "../../../shared/computer-use-contract";
import type { LLMTool } from "../llm/types";
import { getToolExposureMetadata } from "../tool-policy-engine";
import {
  canonicalizeToolName,
  isArtifactGenerationToolName,
  isFileMutationToolName,
} from "../tool-semantics";

const READ_PARALLEL_TOOLS = new Set([
  "read_file",
  "read_files",
  "list_directory",
  "list_directory_with_sizes",
  "get_file_info",
  "search_files",
  "glob",
  "grep",
  "web_fetch",
  "web_search",
  "http_request",
  "git_status",
  "git_diff",
  "git_log",
  "git_show",
  "git_branch",
  "git_ls_files",
  "git_blame",
  "git_refs",
  "task_history",
  "task_list_list",
  "search_memories",
  "memory_search_index",
  "memory_timeline",
  "memory_details",
  "search_quotes",
  "search_sessions",
  "memory_topics_load",
  "memory_curated_read",
  "supermemory_profile",
  "supermemory_search",
  "scratchpad_read",
  "browser_get_content",
  "browser_get_text",
  "browser_screenshot",
  "browser_wait",
  "screen_context_resolve",
]);

const EXCLUSIVE_TOOLS = new Set([
  "write_file",
  "edit_file",
  "delete_file",
  "create_directory",
  "rename_file",
  "copy_file",
  "run_command",
  "run_applescript",
  "spawn_agent",
  "orchestrate_agents",
  "send_agent_message",
  "cancel_agent",
  "pause_agent",
  "resume_agent",
  "switch_workspace",
]);

const ALWAYS_EXPOSE_TOOLS = new Set([
  "read_file",
  "read_files",
  "list_directory",
  "get_file_info",
  "search_files",
  "glob",
  "grep",
  "web_fetch",
  "web_search",
  "http_request",
  "run_command",
  "write_file",
  "edit_file",
  "create_directory",
  "rename_file",
  "copy_file",
  "delete_file",
  "revise_plan",
  "request_user_input",
  "task_history",
  "scratchpad_write",
  "scratchpad_read",
  "search_memories",
  "memory_search_index",
  "memory_timeline",
  "memory_details",
  "search_quotes",
  "search_sessions",
  "memory_topics_load",
  "memory_save",
  "memory_curate",
  "memory_curated_read",
  "supermemory_profile",
  "supermemory_search",
  "supermemory_remember",
  "supermemory_forget",
]);

function inferCapabilityTags(toolName: string): RuntimeToolCapabilityTag[] {
  const tags = new Set<RuntimeToolCapabilityTag>();
  const exposure = getToolExposureMetadata(toolName);
  tags.add(exposure.lane as RuntimeToolCapabilityTag);
  if (toolName.startsWith("mcp_")) tags.add("mcp");
  if (toolName === "run_command") tags.add("shell");
  if (toolName.startsWith("browser_")) tags.add("browser");
  if (toolName.startsWith("canvas_")) tags.add("artifact");
  if (toolName.endsWith("_action")) tags.add("integration");
  return Array.from(tags);
}

function inferConcurrencyClass(toolName: string): RuntimeToolConcurrencyClass {
  if (toolName.startsWith("mcp_")) {
    return toolName.includes("read") || toolName.includes("search") ? "read_parallel" : "serial_only";
  }
  if (READ_PARALLEL_TOOLS.has(toolName)) return "read_parallel";
  if (EXCLUSIVE_TOOLS.has(toolName)) return "exclusive";
  if (toolName.startsWith("browser_") || toolName.startsWith("canvas_")) return "serial_only";
  if (toolName.endsWith("_action")) return "serial_only";
  if (isComputerUseToolName(toolName)) return "serial_only";
  if (isArtifactGenerationToolName(toolName) || isFileMutationToolName(toolName)) return "exclusive";
  if (
    toolName.startsWith("read_") ||
    toolName.startsWith("list_") ||
    toolName.startsWith("get_") ||
    toolName.startsWith("search_") ||
    toolName.startsWith("find_") ||
    toolName.startsWith("inspect_")
  ) {
    return "read_parallel";
  }
  return "serial_only";
}

function inferReadOnly(toolName: string, concurrencyClass: RuntimeToolConcurrencyClass): boolean {
  if (toolName === "run_command") return false;
  if (toolName === "analyze_image" || toolName === "read_pdf_visual") return false;
  if (toolName.endsWith("_action")) return false;
  if (toolName.startsWith("browser_")) {
    return (
      toolName === "browser_get_content" ||
      toolName === "browser_get_text" ||
      toolName === "browser_screenshot" ||
      toolName === "browser_wait"
    );
  }
  if (toolName.startsWith("canvas_")) return false;
  if (toolName.startsWith("mcp_")) return concurrencyClass === "read_parallel";
  if (isArtifactGenerationToolName(toolName) || isFileMutationToolName(toolName)) return false;
  return concurrencyClass === "read_parallel";
}

function inferInterruptBehavior(toolName: string, readOnly: boolean): RuntimeToolInterruptBehavior {
  if (toolName === "run_command") return "cancel";
  if (toolName.startsWith("browser_") || isComputerUseToolName(toolName)) return "cancel";
  return readOnly ? "cancel" : "block";
}

function inferApprovalKind(toolName: string, readOnly: boolean): RuntimeToolApprovalKind {
  if (
    toolName === "task_list_create" ||
    toolName === "task_list_update" ||
    toolName === "task_list_list"
  ) {
    return "none";
  }
  if (toolName === "run_command") return "shell_sensitive";
  if (toolName === "analyze_image" || toolName === "read_pdf_visual") return "data_export";
  if (toolName === "delete_file" || toolName.endsWith("_action")) return "destructive";
  if (toolName.startsWith("mcp_")) return "external_service";
  return readOnly ? "none" : "workspace_policy";
}

function inferSideEffectLevel(toolName: string, readOnly: boolean): RuntimeToolSideEffectLevel {
  if (readOnly) return "none";
  if (toolName === "analyze_image" || toolName === "read_pdf_visual") return "high";
  if (toolName === "delete_file" || toolName.endsWith("_action")) return "high";
  if (toolName === "run_command" || toolName.startsWith("browser_") || isComputerUseToolName(toolName)) {
    return "medium";
  }
  return "low";
}

function inferResultKind(toolName: string): RuntimeToolResultKind {
  if (toolName === "run_command") return "command";
  if (toolName.startsWith("browser_")) return "browser";
  if (toolName.endsWith("_action") || toolName.startsWith("mcp_")) return "integration";
  if (toolName === "web_search" || toolName === "glob" || toolName === "grep" || toolName === "search_files") {
    return "search";
  }
  if (isArtifactGenerationToolName(toolName) || toolName.startsWith("generate_") || toolName.startsWith("create_")) {
    return "artifact";
  }
  if (isFileMutationToolName(toolName) || toolName.startsWith("write_") || toolName.startsWith("edit_")) {
    return "mutation";
  }
  if (
    toolName.startsWith("read_") ||
    toolName.startsWith("list_") ||
    toolName.startsWith("get_") ||
    toolName === "web_fetch"
  ) {
    return "read";
  }
  return "generic";
}

export function getDefaultRuntimeToolMetadata(toolName: string): RuntimeToolMetadata {
  const canonicalName = canonicalizeToolName(String(toolName || "").trim());
  const exposure = getToolExposureMetadata(canonicalName);
  const concurrencyClass = inferConcurrencyClass(canonicalName);
  const readOnly = inferReadOnly(canonicalName, concurrencyClass);
  return {
    readOnly,
    concurrencyClass,
    interruptBehavior: inferInterruptBehavior(canonicalName, readOnly),
    approvalKind: inferApprovalKind(canonicalName, readOnly),
    sideEffectLevel: inferSideEffectLevel(canonicalName, readOnly),
    deferLoad: canonicalName.startsWith("mcp_") || canonicalName.endsWith("_action"),
    alwaysExpose: ALWAYS_EXPOSE_TOOLS.has(canonicalName),
    resultKind: inferResultKind(canonicalName),
    supportsContextMutation: !readOnly,
    capabilityTags: inferCapabilityTags(canonicalName),
    exposure: exposure.exposure,
  };
}

export function withRuntimeToolMetadata(tool: LLMTool, overrides?: Partial<RuntimeToolMetadata>): LLMTool {
  return {
    ...tool,
    runtime: {
      ...getDefaultRuntimeToolMetadata(tool.name),
      ...(tool.runtime || {}),
      ...(overrides || {}),
    },
  };
}

export function withRuntimeToolMetadataList(tools: LLMTool[]): LLMTool[] {
  return tools.map((tool) => withRuntimeToolMetadata(tool));
}

export function isRuntimeToolParallelEligible(tool: Pick<LLMTool, "name" | "runtime">): boolean {
  const metadata = tool.runtime || getDefaultRuntimeToolMetadata(tool.name);
  return metadata.concurrencyClass === "read_parallel" || metadata.concurrencyClass === "side_effect_parallel";
}
