/**
 * Meshy 3D in CoWork: what the chat cards and the 3D gallery get from the main process.
 * Generation happens through Meshy's MCP server behind the normal tool approvals; these
 * shapes only describe tasks and files that already exist.
 */

/** Meshy task ids are UUIDs (v4 or v7). */
export const MESHY_TASK_ID_RE = /^[0-9a-f][0-9a-f-]{15,63}$/;

export function isMeshyTaskId(value: unknown): value is string {
  return typeof value === "string" && MESHY_TASK_ID_RE.test(value);
}

/** File types a finished Meshy task can hold, in the order the Download menu lists them. */
export const MESHY_FORMAT_ORDER = ["glb", "fbx", "obj", "stl", "usdz", "3mf", "blend"] as const;

export interface MeshyStatus {
  /** A Meshy connector is installed. */
  installed: boolean;
  /** It has an API key. */
  configured: boolean;
  balance?: number;
  /** Why there is no balance (bad key, offline). */
  error?: string;
}

export interface MeshyTaskInfo {
  taskId: string;
  /** PENDING, IN_PROGRESS, SUCCEEDED, FAILED, CANCELED, EXPIRED */
  status: string;
  progress: number;
  /** Meshy's task type, e.g. "text-to-3d-preview", "image-to-3d", "rig". */
  type: string;
  /** What it is doing now, as a short word ("previewing", "texturing"). */
  stage: string;
  prompt: string | null;
  thumbnailUrl: string | null;
  credits: number | null;
  /** The task has a GLB the viewer can open. */
  hasModel: boolean;
  /** Image tasks: their image URLs. */
  imageUrls: string[];
  error: string | null;
  /** Milliseconds since epoch; signed links stop working then. */
  expiresAt: number | null;
}

export interface MeshyFormatOption {
  /** "glb", or "glb:walking" for an animation clip. */
  key: string;
  format: string;
  clip: string | null;
  /** Absolute path when this file is already saved beside the model. */
  savedPath: string | null;
}

export interface MeshyNextAction {
  id: string;
  label: string;
  cost: number;
  /** False when the balance is known and lower than the cost. */
  affordable: boolean;
  /** The chat message the button sends; the agent then calls the tool behind its approval. */
  message: string;
}

export interface MeshyGalleryItem {
  taskId: string;
  taskType: string;
  kind: "model" | "image";
  prompt: string;
  createdAt: number;
  thumbnailUrl: string | null;
  credits: number | null;
  /** A saved copy on this machine, when there is one. */
  localPath: string | null;
  expired: boolean;
}

export interface MeshyLocalModel {
  path: string;
  name: string;
  bytes: number;
  modified: number;
  taskId: string | null;
  prompt: string | null;
  /** The CoWork task (chat) that made or saved it. */
  chatTaskId: string | null;
}

export interface MeshyGallery {
  status: MeshyStatus;
  recent: MeshyGalleryItem[];
  local: MeshyLocalModel[];
  /** Where Meshy saves when no folder was given. */
  dataDir: string;
}

export interface Model3dFile {
  name: string;
  size: number;
  /** The file's bytes; the viewer parses them without fetching. */
  bytes: Uint8Array;
}
