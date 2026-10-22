/**
 * Read-only calls to Meshy's REST API for the chat cards and the 3D gallery: the balance,
 * one task's status and files, and recent generations. Nothing here creates a task or
 * spends credits; that goes through Meshy's MCP tools and their approvals. Signed asset
 * links are fetched only from Meshy's asset host.
 */

import type { MeshyGalleryItem, MeshyTaskInfo } from "../../shared/meshy";
import { MESHY_FORMAT_ORDER, isMeshyTaskId } from "../../shared/meshy";

const MESHY_API_BASE = "https://api.meshy.ai";
export const MESHY_ASSET_HOST = "assets.meshy.ai";
const REQUEST_TIMEOUT_MS = 15_000;
const USER_AGENT = "cowork-os-meshy";

/** Endpoints that own a model task, in the order a bare task id is looked up. */
const MODEL_ENDPOINTS: ReadonlyArray<readonly [string, string]> = [
  ["text-to-3d", "/openapi/v2/text-to-3d"],
  ["image-to-3d", "/openapi/v1/image-to-3d"],
  ["multi-image-to-3d", "/openapi/v1/multi-image-to-3d"],
  ["remesh", "/openapi/v1/remesh"],
  ["retexture", "/openapi/v1/retexture"],
  ["rigging", "/openapi/v1/rigging"],
  ["animation", "/openapi/v1/animations"],
];
const IMAGE_ENDPOINTS: ReadonlyArray<readonly [string, string]> = [
  ["text-to-image", "/openapi/v1/text-to-image"],
  ["image-to-image", "/openapi/v1/image-to-image"],
];

const STAGE_WORDS: Record<string, string> = {
  preview: "previewing",
  refine: "texturing",
  "text-to-3d-preview": "previewing",
  "text-to-3d-refine": "texturing",
  "image-to-3d": "modelling",
  "multi-image-to-3d": "modelling",
  remesh: "remeshing",
  retexture: "retexturing",
  rig: "rigging",
  rigging: "rigging",
  animate: "animating",
  animation: "animating",
  "text-to-image": "drawing",
  "image-to-image": "drawing",
};

// Result files whose name is the task's main output; other names are clips ("walking").
const MAIN_RESULT_NAMES = new Set(["rigged_character", "animation", "processed"]);
const CLIP_NAME_RE = /^[a-z0-9_]{1,40}$/;

export class MeshyApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "MeshyApiError";
  }
}

export type MeshyTaskRecord = Record<string, unknown> & { id?: unknown };

export interface MeshyApiClient {
  balance(): Promise<number | undefined>;
  task(taskId: string): Promise<MeshyTaskRecord>;
  recent(limit: number): Promise<MeshyGalleryItem[]>;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export function createMeshyApiClient(apiKey: string, fetchImpl: FetchLike = fetch): MeshyApiClient {
  const get = async (path: string): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetchImpl(`${MESHY_API_BASE}${path}`, {
        headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new MeshyApiError("Meshy is unreachable");
    }
    if (response.status === 401 || response.status === 403) {
      throw new MeshyApiError("Meshy rejected the API key", response.status);
    }
    if (!response.ok) {
      throw new MeshyApiError(`Meshy API error ${response.status}`, response.status);
    }
    return response.json();
  };

  return {
    async balance() {
      const body = (await get("/openapi/v1/balance")) as { balance?: unknown };
      return typeof body?.balance === "number" ? body.balance : undefined;
    },

    async task(taskId) {
      if (!isMeshyTaskId(taskId)) throw new MeshyApiError("Not a Meshy task id", 400);
      for (const [, path] of [...MODEL_ENDPOINTS, ...IMAGE_ENDPOINTS]) {
        let row: unknown;
        try {
          row = await get(`${path}/${taskId}`);
        } catch (error) {
          // Another endpoint owns this id; only a key or network failure ends the search.
          if (
            error instanceof MeshyApiError &&
            error.status &&
            error.status !== 401 &&
            error.status !== 403
          ) {
            continue;
          }
          throw error;
        }
        if (row && typeof row === "object" && (row as MeshyTaskRecord).id === taskId) {
          return ownedRecord(row as MeshyTaskRecord, taskId, get);
        }
      }
      throw new MeshyApiError("Meshy has no task with that id", 404);
    },

    async recent(limit) {
      const pageSize = Math.max(1, Math.min(60, Math.floor(limit)));
      const byTask = new Map<string, MeshyGalleryItem>();
      const now = Date.now();
      for (const [endpointType, path] of [...MODEL_ENDPOINTS, ...IMAGE_ENDPOINTS]) {
        let rows: unknown;
        try {
          rows = await get(`${path}?page_size=${pageSize}&sort_by=-created_at`);
        } catch (error) {
          if (error instanceof MeshyApiError && (error.status === 401 || error.status === 403)) {
            throw error;
          }
          continue; // one task type failing never hides the others
        }
        if (!Array.isArray(rows)) continue;
        const isImage = IMAGE_ENDPOINTS.some(([type]) => type === endpointType);
        for (const raw of rows) {
          if (!raw || typeof raw !== "object") continue;
          const row = raw as MeshyTaskRecord;
          if (row.status !== "SUCCEEDED" || !isMeshyTaskId(row.id)) continue;
          if (byTask.has(row.id)) continue;
          const expiresAt = numberOrNull(row.expires_at);
          byTask.set(row.id, {
            taskId: row.id,
            taskType: stringOr(row.type, endpointType),
            kind: isImage ? "image" : "model",
            prompt: stringOr(row.prompt, "") || clipLabel(resultUrls(row)),
            createdAt: numberOrNull(row.created_at) ?? 0,
            thumbnailUrl: assetUrlOrNull(row.thumbnail_url),
            credits: numberOrNull(row.consumed_credits),
            localPath: null,
            expired: expiresAt !== null && expiresAt > 0 && expiresAt <= now,
          });
        }
      }
      return [...byTask.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, pageSize);
    },
  };
}

/**
 * Meshy answers a task id on every endpoint, reshaped to that endpoint. A rig or animation
 * read from another endpoint lacks its `result` files, so it is re-read where it belongs.
 */
async function ownedRecord(
  row: MeshyTaskRecord,
  taskId: string,
  get: (path: string) => Promise<unknown>,
): Promise<MeshyTaskRecord> {
  const kind = String(row.type ?? "").toLowerCase();
  const path = kind.startsWith("rig")
    ? "/openapi/v1/rigging"
    : kind.includes("anim")
      ? "/openapi/v1/animations"
      : null;
  if (!path || (row.result && typeof row.result === "object")) return row;
  try {
    const owned = (await get(`${path}/${taskId}`)) as MeshyTaskRecord;
    return owned && owned.id === taskId ? owned : row;
  } catch {
    return row;
  }
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A signed Meshy asset URL, or null for anything served from another host. */
export function assetUrlOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === MESHY_ASSET_HOST && !url.port
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function formatOfStem(stem: string): string | null {
  return (
    MESHY_FORMAT_ORDER.find((format) => stem === format || stem.endsWith(`_${format}`)) ?? null
  );
}

/**
 * Every file a task offers as `{key: url}`: `glb`, `fbx`... for its main model, and
 * `glb:walking` style keys for animation clips. Only Meshy asset URLs are kept.
 */
export function resultUrls(row: MeshyTaskRecord): Record<string, string> {
  const out: Record<string, string> = {};
  const modelUrls = row.model_urls;
  if (modelUrls && typeof modelUrls === "object" && Object.keys(modelUrls).length > 0) {
    for (const [key, value] of Object.entries(modelUrls as Record<string, unknown>)) {
      const url = assetUrlOrNull(value);
      if (url) out[key.toLowerCase()] = url;
    }
    return out;
  }
  const result = row.result;
  if (!result || typeof result !== "object") return out;

  const take = (group: string, field: string, value: unknown) => {
    const url = assetUrlOrNull(value);
    if (!url || !field.endsWith("_url")) return;
    const stem = field.slice(0, -4);
    const format = formatOfStem(stem);
    if (!format) return;
    const what = stem.slice(0, stem.length - format.length).replace(/_+$/, "");
    if (what.includes("armature")) return; // a skeleton on its own is not a model to open
    if (!group && (!what || MAIN_RESULT_NAMES.has(what))) {
      out[format] ??= url;
      return;
    }
    const clip = (group && group !== "basic_animations" ? `${group}_${what}` : what)
      .replace(/^processed_/, "")
      .replace(/_+$/, "");
    if (clip && CLIP_NAME_RE.test(clip)) out[`${format}:${clip}`] ??= url;
  };

  for (const [field, value] of Object.entries(result as Record<string, unknown>)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [sub, url] of Object.entries(value as Record<string, unknown>))
        take(field, sub, url);
    } else {
      take("", field, value);
    }
  }
  return out;
}

/** A rig or animation has no prompt; name it by its clips ("walking, running"). */
function clipLabel(urls: Record<string, string>): string {
  const clips = new Set<string>();
  for (const key of Object.keys(urls)) {
    const clip = key.split(":")[1];
    if (clip) clips.add(clip.replace(/_/g, " "));
  }
  return [...clips].sort().join(", ");
}

/** The GLB the viewer opens for a task: its main model, else (a rig) its last clip. */
export function viewerGlbUrl(urls: Record<string, string>): string | null {
  if (urls.glb) return urls.glb;
  const clips = Object.keys(urls)
    .filter((key) => key.startsWith("glb:"))
    .sort();
  return clips.length ? urls[clips[clips.length - 1]] : null;
}

export function toTaskInfo(row: MeshyTaskRecord, taskId: string): MeshyTaskInfo {
  const status = stringOr(row.status, "UNKNOWN").toUpperCase();
  const type = stringOr(row.type, "");
  const urls = status === "SUCCEEDED" ? resultUrls(row) : {};
  const taskError =
    row.task_error && typeof row.task_error === "object"
      ? stringOr((row.task_error as { message?: unknown }).message, "")
      : "";
  const failed = status === "FAILED" || status === "CANCELED" || status === "EXPIRED";
  const imageUrls = Array.isArray(row.image_urls)
    ? row.image_urls.map(assetUrlOrNull).filter((url): url is string => Boolean(url))
    : [];
  const stageKey = stringOr(row.mode, type);
  return {
    taskId,
    status,
    progress: Math.max(0, Math.min(100, Math.round(numberOrNull(row.progress) ?? 0))),
    type,
    stage: STAGE_WORDS[stageKey] ?? STAGE_WORDS[type] ?? stageKey.replace(/-/g, " "),
    prompt: stringOr(row.prompt, "").slice(0, 200) || clipLabel(urls) || null,
    thumbnailUrl: assetUrlOrNull(row.thumbnail_url),
    credits: numberOrNull(row.consumed_credits),
    hasModel: viewerGlbUrl(urls) !== null,
    imageUrls,
    error: failed ? taskError || status.toLowerCase() : null,
    expiresAt: numberOrNull(row.expires_at),
  };
}
