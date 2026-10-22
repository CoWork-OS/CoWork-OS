/**
 * Where CoWork finds the Meshy connector: its saved MCP server config, its API key and the
 * folder it writes to. Meshy runs as Meshy's own MCP server (installed from the registry
 * entry "meshy"); the app talks to Meshy's REST API directly only for what the chat cards
 * and the gallery show (status, thumbnails, downloads), never to spend credits.
 */

import * as path from "path";
import { MCPSettingsManager } from "../mcp/settings";
import type { MCPServerConfig } from "../mcp/types";
import type { ToolCostPolicy } from "../mcp/tool-costs";
import { getUserDataDir } from "../utils/user-data-dir";

export const MESHY_REGISTRY_ID = "meshy";
export const MESHY_PACKAGE_NAME = "@meshy-ai/meshy-mcp-server";
export const MESHY_API_KEY_ENV = "MESHY_API_KEY";

/**
 * Meshy's API price list per tool (credits), as ranges where the AI model, texture size or
 * action count changes the price. Read-only and free tools are left out.
 */
export const MESHY_COST_POLICY: ToolCostPolicy = {
  vendor: "Meshy",
  unit: "credits",
  limit: 200,
  costs: {
    meshy_text_to_3d: { low: 5, high: 25 },
    meshy_image_to_3d: { low: 5, high: 40 },
    meshy_multi_image_to_3d: { low: 5, high: 40 },
    meshy_text_to_3d_refine: { low: 10, high: 15 },
    meshy_retexture: { low: 10, high: 15 },
    meshy_text_to_image: { low: 3, high: 9 },
    meshy_image_to_image: { low: 3, high: 12 },
    meshy_rig: { low: 5, high: 5 },
    meshy_animate: { low: 3, high: 3, note: "3 per action", perItemField: "action_ids" },
    meshy_text_to_motion: { low: 3, high: 10 },
    meshy_remesh: { low: 5, high: 5 },
    meshy_uv_unwrap: { low: 5, high: 5 },
    meshy_convert: { low: 1, high: 1 },
    meshy_resize: { low: 1, high: 1 },
    meshy_process_multicolor: { low: 10, high: 10 },
    meshy_repair_printability: { low: 10, high: 10 },
    meshy_auto_split: { low: 10, high: 10 },
    meshy_creative_lab: { low: 6, high: 62 },
  },
  // Reads and free tools. Anything else Meshy adds later has an unknown cost and asks.
  freeTools: new Set([
    "meshy_get_task_status",
    "meshy_list_tasks",
    "meshy_list_models",
    "meshy_download_model",
    "meshy_cancel_task",
    "meshy_check_balance",
    "meshy_list_usage",
    "meshy_list_animations",
    "meshy_send_to_slicer",
    "meshy_analyze_printability",
  ]),
};

/** A server is Meshy when installed from the registry entry, or when it launches Meshy's package. */
export function isMeshyServerConfig(server: Pick<MCPServerConfig, "registryId" | "args">): boolean {
  if (server.registryId === MESHY_REGISTRY_ID) return true;
  return (server.args ?? []).some(
    (arg) =>
      typeof arg === "string" &&
      (arg === MESHY_PACKAGE_NAME || arg.startsWith(`${MESHY_PACKAGE_NAME}@`)),
  );
}

export function findMeshyServerConfig(): MCPServerConfig | undefined {
  try {
    return MCPSettingsManager.loadSettings().servers.find(isMeshyServerConfig);
  } catch {
    return undefined;
  }
}

/** The key saved in the connector's environment (stored in the encrypted MCP settings). */
export function getMeshyApiKey(server = findMeshyServerConfig()): string | null {
  const key = server?.env?.[MESHY_API_KEY_ENV];
  return typeof key === "string" && key.trim() ? key.trim() : null;
}

/**
 * The Meshy server's own folder: its cwd, where `meshy_download_model` saves without
 * `save_to`. Models in it are readable by the viewer, so only the registry install's
 * folder under the app data dir counts; any other cwd falls back to that folder.
 */
export function getMeshyDataDir(server = findMeshyServerConfig()): string {
  const fallback = path.join(getUserDataDir(), "mcp-data", MESHY_REGISTRY_ID);
  const cwd = typeof server?.cwd === "string" ? path.resolve(server.cwd.trim()) : "";
  const appData = path.join(getUserDataDir(), "mcp-data");
  const insideAppData = cwd.startsWith(`${appData}${path.sep}`);
  return server?.registryId === MESHY_REGISTRY_ID && insideAppData ? cwd : fallback;
}

/**
 * Where CoWork keeps its own index of Meshy models. Not the server's folder: the server can
 * write there, and the index decides which files the viewer may read.
 */
export function getMeshyLibraryDir(): string {
  return path.join(getUserDataDir(), "meshy");
}

export function costPolicyForServer(
  server: Pick<MCPServerConfig, "registryId" | "args"> | undefined,
): ToolCostPolicy | null {
  return server && isMeshyServerConfig(server) ? MESHY_COST_POLICY : null;
}
