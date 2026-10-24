import { z } from "zod";
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
