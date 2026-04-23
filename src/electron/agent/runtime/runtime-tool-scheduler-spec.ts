import type {
  RuntimeToolConcurrencyClass,
  RuntimeToolMetadata,
} from "../../../shared/types";
import { isComputerUseToolName } from "../../../shared/computer-use-contract";
import {
  canonicalizeToolName,
  isArtifactGenerationToolName,
  isFileMutationToolName,
} from "../tool-semantics";

export interface ToolExecutionScopeKey {
  kind: string;
  key: string;
}

export interface RuntimeToolSchedulerPostExecutionEffectArgs {
  toolName: string;
  input: Any;
  outcome: {
    result?: Any;
    error?: unknown;
    durationMs?: number;
    resultJson?: string;
    metadata?: Record<string, unknown>;
  };
}

export interface RuntimeToolSchedulerSpec {
  concurrencyClass: RuntimeToolConcurrencyClass;
  readOnly: boolean;
  idempotent: boolean;
  resolveScopeKeys?: (args: {
    toolName: string;
    input: Any;
    runtime?: RuntimeToolMetadata;
  }) => ToolExecutionScopeKey[];
  postExecutionEffect?: (
    args: RuntimeToolSchedulerPostExecutionEffectArgs,
  ) => Promise<void> | void;
}

export interface RuntimeToolSchedulerSpecContext {
  toolName: string;
  input: Any;
  runtime?: RuntimeToolMetadata;
}

export type RuntimeToolSchedulerSpecOverride =
  | Partial<RuntimeToolSchedulerSpec>
  | undefined;

export type RuntimeToolSchedulerSpecResolver = (
  args: RuntimeToolSchedulerSpecContext,
) => RuntimeToolSchedulerSpecOverride;

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
  "search_quotes",
  "search_sessions",
  "memory_topics_load",
  "memory_curated_read",
  "supermemory_profile",
  "supermemory_search",
  "scratchpad_read",
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

const IDEMPOTENT_TOOLS = new Set([
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
  "search_quotes",
  "search_sessions",
  "memory_topics_load",
  "memory_curated_read",
  "supermemory_profile",
  "supermemory_search",
  "scratchpad_read",
]);

const FILE_SCOPE_KEYS = [
  "path",
  "paths",
  "filename",
  "destPath",
  "destination",
  "sourcePath",
  "targetPath",
  "from",
  "to",
  "cwd",
];

export function resolveDefaultRuntimeToolSchedulerSpec(
  args: RuntimeToolSchedulerSpecContext,
): RuntimeToolSchedulerSpec {
  const toolName = canonicalizeToolName(String(args.toolName || "").trim());
  const concurrencyClass = inferSchedulerConcurrencyClass(toolName, args.runtime);
  const readOnly = inferSchedulerReadOnly(toolName, concurrencyClass, args.runtime);
  return {
    concurrencyClass,
    readOnly,
    idempotent: inferSchedulerIdempotent(toolName, readOnly),
    resolveScopeKeys: ({ input }) => inferSchedulerScopeKeys(toolName, input),
  };
}

export function resolveRuntimeToolSchedulerSpec(
  args: RuntimeToolSchedulerSpecContext,
  override?: RuntimeToolSchedulerSpecOverride,
): RuntimeToolSchedulerSpec {
  const resolved = resolveDefaultRuntimeToolSchedulerSpec(args);
  if (!override) return resolved;
  return {
    ...resolved,
    ...override,
    resolveScopeKeys: override.resolveScopeKeys || resolved.resolveScopeKeys,
    postExecutionEffect:
      override.postExecutionEffect || resolved.postExecutionEffect,
  };
}

export function createStaticRuntimeToolSchedulerSpecResolver(
  override: Partial<RuntimeToolSchedulerSpec>,
): RuntimeToolSchedulerSpecResolver {
  return () => override;
}

export function resolveToolExecutionScopeKeys(args: {
  spec: RuntimeToolSchedulerSpec;
  toolName: string;
  input: Any;
  runtime?: RuntimeToolMetadata;
}): ToolExecutionScopeKey[] {
  if (typeof args.spec.resolveScopeKeys !== "function") {
    return [];
  }
  return args.spec.resolveScopeKeys({
    toolName: args.toolName,
    input: args.input,
    runtime: args.runtime,
  });
}

export function serializeToolExecutionScopeKey(
  scopeKey: ToolExecutionScopeKey,
): string {
  return `${scopeKey.kind}:${scopeKey.key}`;
}

function inferSchedulerConcurrencyClass(
  toolName: string,
  runtime?: RuntimeToolMetadata,
): RuntimeToolConcurrencyClass {
  if (toolName.startsWith("mcp_") || toolName.endsWith("_action")) {
    return "serial_only";
  }
  if (
    toolName.startsWith("browser_") ||
    toolName.startsWith("qa_") ||
    toolName.startsWith("canvas_") ||
    isComputerUseToolName(toolName)
  ) {
    return "serial_only";
  }
  if (EXCLUSIVE_TOOLS.has(toolName)) return "exclusive";
  if (READ_PARALLEL_TOOLS.has(toolName)) return "read_parallel";
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
  if (isArtifactGenerationToolName(toolName) || isFileMutationToolName(toolName)) {
    return "exclusive";
  }
  return runtime?.concurrencyClass || "serial_only";
}

function inferSchedulerReadOnly(
  toolName: string,
  concurrencyClass: RuntimeToolConcurrencyClass,
  runtime?: RuntimeToolMetadata,
): boolean {
  if (toolName === "run_command" || toolName === "run_applescript") return false;
  if (toolName.endsWith("_action") || toolName.startsWith("mcp_")) {
    return runtime?.readOnly ?? false;
  }
  if (
    toolName.startsWith("browser_") ||
    toolName.startsWith("canvas_") ||
    isComputerUseToolName(toolName)
  ) {
    return runtime?.readOnly ?? false;
  }
  if (isArtifactGenerationToolName(toolName) || isFileMutationToolName(toolName)) {
    return false;
  }
  return concurrencyClass === "read_parallel";
}

function inferSchedulerIdempotent(toolName: string, readOnly: boolean): boolean {
  if (IDEMPOTENT_TOOLS.has(toolName)) return true;
  if (
    toolName.startsWith("browser_") ||
    toolName.startsWith("canvas_") ||
    isComputerUseToolName(toolName)
  ) {
    return false;
  }
  if (!readOnly) return false;
  return (
    toolName.startsWith("read_") ||
    toolName.startsWith("list_") ||
    toolName.startsWith("get_") ||
    toolName.startsWith("search_") ||
    toolName.startsWith("check_") ||
    toolName.startsWith("describe_") ||
    toolName.startsWith("query_")
  );
}

function inferSchedulerScopeKeys(
  toolName: string,
  input: Any,
): ToolExecutionScopeKey[] {
  if (toolName.startsWith("browser_")) {
    return [
      {
        kind: "browser_session",
        key: String(input?.session_id || "default"),
      },
    ];
  }
  if (toolName.startsWith("qa_")) {
    return [
      {
        kind: "qa_session",
        key: String(input?.session_id || "default"),
      },
    ];
  }
  if (toolName.startsWith("canvas_")) {
    return [
      {
        kind: "canvas_session",
        key: String(input?.session_id || "default"),
      },
    ];
  }
  if (isComputerUseToolName(toolName)) {
    return [{ kind: "computer_device", key: "default" }];
  }
  if (toolName === "run_command" || toolName === "run_applescript") {
    return [{ kind: "process", key: toolName }];
  }
  if (toolName.startsWith("mcp_") || toolName.endsWith("_action")) {
    return [{ kind: "external_service", key: getExternalServiceScope(toolName) }];
  }
  if (isArtifactGenerationToolName(toolName) || isFileMutationToolName(toolName)) {
    const paths = extractPathScopeKeys(input);
    return paths.length > 0
      ? paths.map((entry) => ({ kind: "workspace_path", key: entry }))
      : [{ kind: "workspace_path", key: "*" }];
  }
  return [];
}

function extractPathScopeKeys(input: Any): string[] {
  const results = new Set<string>();
  for (const key of FILE_SCOPE_KEYS) {
    const value = input?.[key];
    if (typeof value === "string" && value.trim().length > 0) {
      results.add(normalizeScopePath(value));
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string" && entry.trim().length > 0) {
          results.add(normalizeScopePath(entry));
        }
      }
    }
  }
  return Array.from(results.values()).sort();
}

function normalizeScopePath(raw: string): string {
  return String(raw || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .toLowerCase();
}

function getExternalServiceScope(toolName: string): string {
  if (toolName.startsWith("mcp_")) {
    const parts = toolName.split("_");
    return parts.length > 1 ? parts[1]! : "mcp";
  }
  return toolName.replace(/_action$/, "");
}
