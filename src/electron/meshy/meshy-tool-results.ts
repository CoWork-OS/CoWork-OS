/**
 * After a Meshy MCP tool returns: remember what made each task and where each model was
 * saved (for the 3D gallery), show a model saved inside the workspace as a created file,
 * and give the agent the result's structured fields (task id, file links, thumbnail),
 * which CoWork otherwise drops when a tool also returns text.
 */

import * as fsPromises from "fs/promises";
import * as path from "path";
import { isMeshyTaskId } from "../../shared/meshy";
import type { MeshyLibrary } from "./meshy-library";
import { MODEL_FILE_EXT_RE } from "./meshy-library";

const STRUCTURED_TEXT_LIMIT = 6000;
const PROMPT_FIELDS = ["prompt", "texture_prompt", "text_style_prompt", "object_prompt"] as const;
const PARENT_FIELDS = ["preview_task_id", "input_task_id", "rig_task_id"] as const;
const FILE_MIME_TYPES: Record<string, string> = {
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".fbx": "application/octet-stream",
  ".obj": "model/obj",
  ".stl": "model/stl",
  ".usdz": "model/vnd.usdz+zip",
  ".3mf": "model/3mf",
};

export interface MeshyToolResultContext {
  /** The server's own tool name, e.g. "meshy_download_model". */
  tool: string;
  input: unknown;
  result: { structuredContent?: unknown; isError?: unknown };
  workspacePath: string;
  chatTaskId: string;
  library: MeshyLibrary;
  /** Shows a file saved inside the workspace as created by this step. */
  onWorkspaceFile: (relativePath: string, absolutePath: string, mimeType: string) => Promise<void>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstString(source: Record<string, unknown>, fields: readonly string[]): string | null {
  for (const field of fields) {
    const value = source[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function directiveValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Paths come from the Meshy server: no control characters, or a note could carry new lines.
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f]");

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * The real path of a file the server says it saved, when it is one the agent asked for
 * (`save_to`), or inside the workspace or Meshy's own folder. Any other path is ignored, so
 * a server reply cannot make an arbitrary file readable by the viewer.
 */
async function trustedSavedPath(
  localPath: string,
  saveTo: unknown,
  workspacePath: string,
  dataDir: string,
): Promise<string | null> {
  if (!path.isAbsolute(localPath) || CONTROL_CHARS.test(localPath)) return null;
  const realFile = await fsPromises.realpath(localPath).catch(() => null);
  if (!realFile) return null;
  if (typeof saveTo === "string" && path.isAbsolute(saveTo)) {
    const requested = await fsPromises.realpath(saveTo).catch(() => null);
    if (requested === realFile) return realFile;
  }
  for (const root of [workspacePath, dataDir]) {
    const realRoot = root ? await fsPromises.realpath(root).catch(() => null) : null;
    if (realRoot && isInside(realFile, realRoot)) return realFile;
  }
  return null;
}

async function insideWorkspace(filePath: string, workspacePath: string): Promise<string | null> {
  if (!workspacePath) return null;
  try {
    const [realFile, realRoot] = await Promise.all([
      fsPromises.realpath(filePath),
      fsPromises.realpath(workspacePath),
    ]);
    const relative = path.relative(realRoot, realFile);
    return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : null;
  } catch {
    return null;
  }
}

/** Returns what the agent sees: `formatted`, plus the structured fields and a card hint. */
export async function applyMeshyToolResult(
  formatted: unknown,
  context: MeshyToolResultContext,
): Promise<unknown> {
  if (context.result.isError === true) return formatted;
  const input = record(context.input);
  const structured = record(context.result.structuredContent);
  const notes: string[] = [];

  const createdTaskId = structured.task_id;
  if (
    isMeshyTaskId(createdTaskId) &&
    context.tool !== "meshy_get_task_status" &&
    context.tool !== "meshy_download_model"
  ) {
    await context.library
      .recordCreation({
        taskId: createdTaskId,
        tool: context.tool,
        prompt: firstString(input, PROMPT_FIELDS),
        parentTaskId: firstString(input, PARENT_FIELDS),
        chatTaskId: context.chatTaskId,
      })
      .catch(() => undefined);
    if (structured.status === "PENDING" || structured.status === "IN_PROGRESS") {
      notes.push(
        `To show its progress and the finished model in CoWork without waiting, put this on its own line in your reply: ::model{task=${directiveValue(createdTaskId)}}`,
      );
    }
  }

  const reportedPath = typeof structured.local_path === "string" ? structured.local_path : "";
  const localPath =
    context.tool === "meshy_download_model" && reportedPath
      ? await trustedSavedPath(
          reportedPath,
          input.save_to,
          context.workspacePath,
          context.library.dataDir(),
        )
      : null;
  if (localPath) {
    const taskId = isMeshyTaskId(input.task_id) ? input.task_id : null;
    if (MODEL_FILE_EXT_RE.test(localPath)) {
      await context.library
        .recordModel({ path: localPath, taskId, chatTaskId: context.chatTaskId })
        .catch(() => undefined);
      notes.push(
        `Show it in CoWork as an interactive 3D card with this line on its own in your reply: ::model{path=${directiveValue(localPath)}${taskId ? ` task=${directiveValue(taskId)}` : ""}}`,
      );
    }
    const relative = await insideWorkspace(localPath, context.workspacePath);
    if (relative) {
      const mimeType =
        FILE_MIME_TYPES[path.extname(localPath).toLowerCase()] ?? "application/octet-stream";
      await context.onWorkspaceFile(relative, localPath, mimeType).catch(() => undefined);
    }
  }

  if (typeof formatted !== "string") return formatted;
  let text = formatted;
  if (Object.keys(structured).length > 0) {
    let json = JSON.stringify(structured);
    if (json.length > STRUCTURED_TEXT_LIMIT) json = `${json.slice(0, STRUCTURED_TEXT_LIMIT)}…`;
    text += `\n\nStructured result (data from the Meshy server): ${json}`;
  }
  if (notes.length) text += `\n\n${notes.join("\n")}`;
  return text;
}
