import { z } from "zod";
import { HOST_COMPUTER_TOOL_NAMES } from "./bot-computer";
import { isSpaceRelativePath } from "./space-sandbox";

/** Selection is user configuration; the binding is written only by the host. */
export const ExecutionEnvironmentSelectionSchema = z
  .object({
    backend: z.enum(["bot-desktop", "cua"]),
    lifetime: z.enum(["persistent", "task"]).default("persistent"),
    space: z.string().trim().min(1).max(256).optional(),
    on: z.string().trim().min(1).max(256).optional(),
    image: z.string().trim().min(1).max(384).optional(),
    inputPaths: z.array(z.string().min(1).max(1024)).max(64).default([]),
    outputPaths: z.array(z.string().min(1).max(1024)).max(64).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.space && value.lifetime === "task") {
      context.addIssue({ code: "custom", message: "An existing computer cannot be disposable." });
    }
    for (const paths of [value.inputPaths, value.outputPaths]) {
      if (
        new Set(paths).size !== paths.length ||
        paths.some((entry) => !isSpaceRelativePath(entry))
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Computer transfers require unique workspace-relative regular-file paths outside private configuration.",
        });
      }
    }
    if (value.on && value.on !== "local" && !value.on.startsWith("host:")) {
      context.addIssue({
        code: "custom",
        message:
          "Choose local or a Cua host you own. Cloud provisioning is not qualified in this release.",
      });
    }
  });
export type ExecutionEnvironmentSelection = z.infer<typeof ExecutionEnvironmentSelectionSchema>;

export interface ExecutionEnvironmentBinding {
  version: 1;
  id: string;
  generation: number;
  taskId: string;
  workspaceId: string;
  botId?: string;
  selection: ExecutionEnvironmentSelection;
  resourceId: string;
  owned: boolean;
  os: "linux";
  cwd: string;
  state: "allocating" | "ready" | "unknown" | "cleanup_pending" | "released";
  pending?: { id: string; tool: string; inputHash: string };
  exported: Array<{ path: string; sha256: string; bytes: number }>;
  publishing?: { path: string; sha256: string; bytes: number };
  imported?: Array<{ path: string; sha256: string }>;
  processIds?: string[];
  error?: string;
  createdAt: number;
}

export const ENVIRONMENT_FILE_TOOLS = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "list_directory",
  "list_directory_with_sizes",
  "create_directory",
  "delete_file",
  "rename_file",
  "copy_file",
  "get_file_info",
  "glob",
  "grep",
  "search_files",
  "read_files",
]);
export const ENVIRONMENT_BROWSER_TOOLS = new Set([
  "browser_navigate",
  "browser_snapshot",
  "browser_get_text",
  "browser_get_content",
  "browser_click",
  "browser_fill",
  "browser_type",
  "browser_press",
  "browser_evaluate",
  "browser_screenshot",
  "browser_tabs",
  "browser_switch_tab",
  "browser_close_tab",
  "browser_back",
  "browser_forward",
  "browser_reload",
  "browser_scroll",
  "browser_wait",
]);
export const ENVIRONMENT_COMMAND_TOOLS = new Set([
  "run_command",
  "execute_code",
  "process_output",
  "stop_process",
]);
export const ENVIRONMENT_DESKTOP_TOOLS = new Set([
  "desktop_screenshot",
  "desktop_click",
  "desktop_type",
  "desktop_key",
  "desktop_scroll",
  "desktop_drag",
  "desktop_open_url",
  "desktop_save_file",
]);
export function isEnvironmentTool(name: string): boolean {
  return (
    ENVIRONMENT_FILE_TOOLS.has(name) ||
    ENVIRONMENT_BROWSER_TOOLS.has(name) ||
    ENVIRONMENT_COMMAND_TOOLS.has(name) ||
    ENVIRONMENT_DESKTOP_TOOLS.has(name) ||
    name === "computer_environment"
  );
}

const HOST_FILE_TOOLS = new Set([
  "create_document",
  "edit_document",
  "create_spreadsheet",
  "create_presentation",
  "parse_document",
  "edit_pdf_region",
  "read_pdf_visual",
  "organize_folder",
  "batch_image_process",
  "monty_run",
  "monty_transform_file",
  "monty_run_transform",
  "git_status",
  "git_diff",
  "git_commit",
  "git_merge_to_base",
  "get_env",
  "find_macos_app_processes",
  "terminate_macos_app_processes",
  "list_macos_launch_agents",
  "disable_macos_launch_agents",
  "native_application_inspect",
  "count_text",
  "text_metrics",
]);
const SERVICE_TOOLS = new Set([
  "web_search",
  "web_fetch",
  "http_request",
  "tool_search",
  "request_user_input",
  "request_takeover",
  "revise_plan",
  "task_list_create",
  "task_list_update",
  "task_list_list",
  "task_history",
  "spawn_agent",
  "wait_for_agent",
  "orchestrate_agents",
  "send_agent_message",
  "list_agents",
]);
const SERVICE_ACTION_TOOLS = new Set([
  "notion_action",
  "box_action",
  "onedrive_action",
  "google_drive_action",
  "gmail_action",
  "mailbox_action",
  "calendar_action",
  "dropbox_action",
  "sharepoint_action",
]);

/** Whether a tool can run while a task computer is selected (guest tools plus host services). */
export function isToolSupportedInEnvironment(name: string): boolean {
  if (name.startsWith("browser_")) return ENVIRONMENT_BROWSER_TOOLS.has(name);
  if (isEnvironmentTool(name)) return true;
  if (name.startsWith("desktop_")) return false;
  if (HOST_COMPUTER_TOOL_NAMES.includes(name) || HOST_FILE_TOOLS.has(name)) return false;
  // Generic local MCP drivers and filesystem servers cannot be safely relocated implicitly.
  if (name.startsWith("mcp_")) return false;
  return (
    SERVICE_TOOLS.has(name) ||
    SERVICE_ACTION_TOOLS.has(name) ||
    name.startsWith("memory_") ||
    name.startsWith("task_list_")
  );
}

/** Identity of the physical desktop; placement policy is not part of its control lease. */
export function environmentControlKey(binding: ExecutionEnvironmentBinding): string {
  if (
    binding.selection.backend === "bot-desktop" &&
    binding.resourceId.startsWith("environment:")
  ) {
    const placement = JSON.parse(binding.resourceId.slice(12));
    return `bot-desktop:${placement.host || "local"}:${placement.key}`;
  }
  return `${binding.selection.backend}:${binding.resourceId}`;
}
