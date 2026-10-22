/**
 * The main-process side of the Meshy cards and gallery. Each method answers one IPC call;
 * none of them spends credits. Buttons that would ("Texture it", "Rig") return a chat
 * message instead, so the agent makes the call behind its usual approval.
 */

import * as fsPromises from "fs/promises";
import * as path from "path";
import type {
  MeshyFormatOption,
  MeshyGallery,
  MeshyNextAction,
  MeshyStatus,
  MeshyTaskInfo,
} from "../../shared/meshy";
import { MESHY_FORMAT_ORDER, isMeshyTaskId } from "../../shared/meshy";
import {
  MeshyApiError,
  assetUrlOrNull,
  createMeshyApiClient,
  resultUrls,
  toTaskInfo,
  viewerGlbUrl,
  type MeshyApiClient,
} from "./meshy-api";
import {
  createMeshyLibrary,
  downloadMeshyAsset,
  freeDestination,
  MODEL_FILE_EXT_RE,
} from "./meshy-library";
import {
  findMeshyServerConfig,
  getMeshyApiKey,
  getMeshyDataDir,
  getMeshyLibraryDir,
} from "./meshy-server";

const THUMBNAIL_MAX_BYTES = 10 * 1024 * 1024;
const THUMBNAIL_CACHE_SIZE = 64;
const THUMBNAIL_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

const GENERATED = ["text-to-3d-refine", "image-to-3d", "multi-image-to-3d"];

/** Follow-ups a finished task supports; `cost: null` means "what the task itself cost". */
const NEXT_ACTIONS: ReadonlyArray<{
  id: string;
  label: string;
  cost: number | null;
  types: readonly string[];
  ask: string;
}> = [
  {
    id: "texture",
    label: "Texture it",
    cost: 10,
    types: ["text-to-3d-preview"],
    ask: "texture it with meshy_text_to_3d_refine (10 credits). Ask me for a texture style only if I haven't given one.",
  },
  {
    id: "regenerate",
    label: "Regenerate",
    cost: null,
    types: ["text-to-3d-preview"],
    ask: "make a NEW meshy_text_to_3d preview with the same prompt and model type (read them with meshy_get_task_status) and a new seed ({cost} credits, what the first one cost).",
  },
  {
    id: "remesh",
    label: "Remesh",
    cost: 5,
    types: ["text-to-3d-preview", ...GENERATED, "retexture"],
    ask: "remesh it with meshy_remesh (5 credits). Suggest a triangle target for what it is and ask me for the target and triangle or quad topology before calling.",
  },
  {
    id: "retexture",
    label: "Retexture",
    cost: 10,
    types: ["text-to-3d-preview", ...GENERATED, "remesh"],
    ask: "retexture it with meshy_retexture (10 credits). Ask me for the style first.",
  },
  {
    id: "rig",
    label: "Rig",
    cost: 5,
    types: [...GENERATED, "retexture", "remesh"],
    ask: "rig it with meshy_rig (5 credits, walking and running clips included). Only if it is a textured humanoid; say so and stop if it is not.",
  },
  {
    id: "animate",
    label: "Animate",
    cost: 3,
    types: ["rig"],
    ask: "animate this rig with meshy_animate (3 credits per action). Look up action ids with meshy_list_animations and ask me which ones I want.",
  },
  {
    id: "resize",
    label: "Resize",
    cost: 1,
    types: [...GENERATED, "remesh", "retexture"],
    ask: "resize it to real-world size with meshy_resize (1 credit). Ask me for the height.",
  },
  {
    id: "printability",
    label: "Check printability",
    cost: 0,
    types: ["text-to-3d-preview", ...GENERATED, "remesh", "retexture"],
    ask: "check it for 3D printing with meshy_analyze_printability (free) and summarise the result.",
  },
];

export interface ModelReadAccess {
  /** True when the renderer's workspace path is a workspace the app knows. */
  isKnownWorkspace(workspacePath: string): Promise<boolean>;
}

export class MeshyService {
  private readonly library = createMeshyLibrary(
    () => getMeshyDataDir(),
    () => getMeshyLibraryDir(),
  );
  private readonly thumbnails = new Map<string, string>();

  constructor(
    private readonly clientFor: (apiKey: string) => MeshyApiClient = (key) =>
      createMeshyApiClient(key),
  ) {}

  getLibrary() {
    return this.library;
  }

  private client(): MeshyApiClient {
    const key = getMeshyApiKey();
    if (!key) throw new MeshyApiError("Add your Meshy API key in Settings → Connectors → Meshy.");
    return this.clientFor(key);
  }

  async status(): Promise<MeshyStatus> {
    const server = findMeshyServerConfig();
    if (!server) return { installed: false, configured: false };
    if (!getMeshyApiKey(server)) return { installed: true, configured: false };
    try {
      const balance = await this.client().balance();
      return { installed: true, configured: true, ...(balance !== undefined ? { balance } : {}) };
    } catch (error) {
      return { installed: true, configured: true, error: errorText(error) };
    }
  }

  async task(taskId: string): Promise<MeshyTaskInfo> {
    assertTaskId(taskId);
    const info = toTaskInfo(await this.client().task(taskId), taskId);
    if (!info.prompt) info.prompt = await this.library.promptForTask(taskId);
    return info;
  }

  /** `anchor`: the real path of the model shown, already checked by the caller. */
  async formats(taskId: string, anchor?: string): Promise<MeshyFormatOption[]> {
    assertTaskId(taskId);
    const urls = resultUrls(await this.client().task(taskId));
    const options: MeshyFormatOption[] = [];
    for (const key of Object.keys(urls)) {
      const [format, clip] = key.split(":");
      if (!(MESHY_FORMAT_ORDER as readonly string[]).includes(format)) continue;
      let savedPath: string | null = null;
      if (anchor) {
        const candidate = path.join(
          path.dirname(anchor),
          `${path.basename(anchor, path.extname(anchor))}${clip ? `-${clip}` : ""}.${format}`,
        );
        savedPath = (await exists(candidate)) ? candidate : null;
      }
      options.push({ key, format, clip: clip ?? null, savedPath });
    }
    const order = (key: string) => {
      const index = (MESHY_FORMAT_ORDER as readonly string[]).indexOf(key.split(":")[0]);
      return index < 0 ? 99 : index;
    };
    return options.sort((a, b) => order(a.key) - order(b.key) || a.key.localeCompare(b.key));
  }

  /**
   * Saves one file type of a finished task (no credits: Meshy made them all at generation
   * time) next to `anchor` (the real path of the model shown, already checked by the
   * caller), else under Meshy's folder. Returns the saved path.
   */
  async save(
    taskId: string,
    formatKey: string,
    options: { anchor?: string; chatTaskId?: string | null } = {},
  ): Promise<{ path: string }> {
    assertTaskId(taskId);
    const [format, clip] = formatKey.split(":");
    if (!(MESHY_FORMAT_ORDER as readonly string[]).includes(format)) {
      throw new Error("Unknown file type");
    }
    if (clip !== undefined && !/^[a-z0-9_]{1,40}$/.test(clip)) throw new Error("Unknown clip");
    const anchor = options.anchor ?? null;
    const row = await this.client().task(taskId);
    const urls = resultUrls(row);
    const url = formatKey === "glb" && !urls.glb ? viewerGlbUrl(urls) : urls[formatKey];
    if (!url) throw new Error(`This Meshy task has no ${format.toUpperCase()} file`);

    if (!anchor && format === "glb" && !clip) {
      const existing = await this.library.savedPathFor(taskId);
      if (existing) return { path: existing };
    }
    const folder = anchor
      ? path.dirname(anchor)
      : path.join(this.library.dataDir(), "meshy_output", taskId);
    const stem = `${anchor ? path.basename(anchor, path.extname(anchor)) : "model"}${clip ? `-${clip}` : ""}`;
    const destination = await freeDestination(folder, stem, format);
    await downloadMeshyAsset(url, destination);
    if (format === "obj") {
      // An OBJ's material file names its textures; keep it beside the mesh when Meshy has one.
      const mtl = urls.mtl;
      if (mtl) {
        const mtlPath = await freeDestination(folder, stem, "mtl");
        await downloadMeshyAsset(mtl, mtlPath).catch(() => undefined);
      }
    }
    if (MODEL_FILE_EXT_RE.test(destination)) {
      await this.library.recordModel({ path: destination, taskId, chatTaskId: options.chatTaskId });
    }
    return { path: destination };
  }

  async actions(taskId: string): Promise<{ balance: number | null; actions: MeshyNextAction[] }> {
    assertTaskId(taskId);
    const client = this.client();
    const row = await client.task(taskId);
    const type = String(row.type ?? "").toLowerCase();
    const spent = typeof row.consumed_credits === "number" ? row.consumed_credits : null;
    const balance = await client.balance().catch(() => undefined);
    const prompt =
      typeof row.prompt === "string" ? row.prompt.replace(/\s+/g, " ").trim().slice(0, 80) : "";
    const subject = `Meshy task ${taskId}${prompt ? ` ("${prompt.replace(/"/g, "'")}")` : ""}`;
    const actions: MeshyNextAction[] = [];
    for (const action of NEXT_ACTIONS) {
      if (!action.types.includes(type)) continue;
      const cost = action.cost ?? spent;
      if (cost === null) continue; // never offer a button that cannot say what it spends
      const ask = action.ask.replace("{cost}", String(cost));
      actions.push({
        id: action.id,
        label: action.label,
        cost,
        affordable: balance === undefined || cost <= balance,
        message:
          cost > 0
            ? `${subject}: ${ask} This message is my confirmation of the ${cost}-credit cost.`
            : `${subject}: ${ask}`,
      });
    }
    return { balance: balance ?? null, actions };
  }

  async gallery(limit = 24): Promise<MeshyGallery> {
    const status = await this.status();
    const local = await this.library.listModels(200);
    let recent: MeshyGallery["recent"] = [];
    if (status.configured && !status.error) {
      try {
        recent = await this.client().recent(limit);
      } catch {
        recent = [];
      }
    }
    const savedByTask = new Map<string, string>();
    for (const model of local) if (model.taskId) savedByTask.set(model.taskId, model.path);
    const withLocal = await Promise.all(
      recent.map(async (item) => ({
        ...item,
        prompt: (await this.library.promptForTask(item.taskId)) || item.prompt,
        localPath: item.kind === "model" ? (savedByTask.get(item.taskId) ?? null) : null,
      })),
    );
    return {
      status,
      recent: withLocal.filter((item) => !item.expired || item.localPath),
      local,
      dataDir: this.library.dataDir(),
    };
  }

  /** A Meshy thumbnail or concept image as a data URL (the renderer cannot reach Meshy's host). */
  async image(url: string): Promise<string> {
    const asset = assetUrlOrNull(url);
    if (!asset) throw new Error("Only Meshy asset links can be shown");
    const extension = path.extname(new URL(asset).pathname).toLowerCase();
    const mimeType = THUMBNAIL_TYPES[extension];
    if (!mimeType) throw new Error("Not an image");
    const cached = this.thumbnails.get(asset);
    if (cached) return cached;
    // Redirects are refused, so no request ever reaches a host other than Meshy's.
    const response = await fetch(asset, { redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Image unavailable (HTTP ${response.status})`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > THUMBNAIL_MAX_BYTES) throw new Error("Image too large");
    const dataUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;
    this.thumbnails.set(asset, dataUrl);
    if (this.thumbnails.size > THUMBNAIL_CACHE_SIZE) {
      this.thumbnails.delete(this.thumbnails.keys().next().value as string);
    }
    return dataUrl;
  }

  /** The real path of a model the gallery may read: recorded, or inside Meshy's folder. */
  async knownModel(filePath: string): Promise<string> {
    if (typeof filePath !== "string" || !path.isAbsolute(filePath) || filePath.includes("\0")) {
      throw new Error("Model path must be absolute");
    }
    const realPath = await fsPromises.realpath(filePath).catch(() => null);
    if (!realPath || !(await this.library.isKnownModelPath(realPath))) {
      throw new Error("That model is not one Meshy saved on this machine");
    }
    return realPath;
  }
}

function assertTaskId(taskId: string): void {
  if (!isMeshyTaskId(taskId)) throw new Error("Not a Meshy task id");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fsPromises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let sharedService: MeshyService | null = null;

export function getMeshyService(): MeshyService {
  sharedService ??= new MeshyService();
  return sharedService;
}
