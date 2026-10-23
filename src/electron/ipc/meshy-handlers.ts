/**
 * IPC for 3D model cards (`::model{}` in a reply) and the Meshy connector's cards and
 * gallery. Model bytes are read only from a known workspace or from models Meshy saved;
 * Meshy calls are read-only (status, files, thumbnails) or free downloads of files a task
 * already holds. Nothing here can start a paid Meshy job.
 */

import * as fsPromises from "fs/promises";
import * as path from "path";
import { ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import { IPC_CHANNELS } from "../../shared/types";
import { MESHY_TASK_ID_RE } from "../../shared/meshy";
import type { Model3dFile } from "../../shared/meshy";
import { MODEL_FILE_EXT_RE } from "../meshy/meshy-library";
import { errorText, getMeshyService, type MeshyService } from "../meshy/meshy-service";
import { RATE_LIMIT_CONFIGS, rateLimiter } from "../utils/rate-limiter";
import { validateInput } from "../utils/validation";

/** The viewer holds a model in memory; Meshy's largest GLBs (8K textures) stay well under this. */
const MAX_MODEL_BYTES = 256 * 1024 * 1024;

const FilePathSchema = z.string().trim().min(1).max(4096);
const TaskIdSchema = z.string().regex(MESHY_TASK_ID_RE);
const ModelReadSchema = z.object({
  filePath: FilePathSchema,
  workspacePath: FilePathSchema.optional(),
});
const TaskSchema = z.object({ taskId: TaskIdSchema });
const FormatsSchema = z.object({
  taskId: TaskIdSchema,
  beside: FilePathSchema.optional(),
  workspacePath: FilePathSchema.optional(),
});
const SaveSchema = z.object({
  taskId: TaskIdSchema,
  format: z.string().regex(/^[a-z0-9]{1,8}(?::[a-z0-9_]{1,40})?$/),
  beside: FilePathSchema.optional(),
  workspacePath: FilePathSchema.optional(),
  chatTaskId: z.string().trim().min(1).max(200).optional(),
  /** Show the saved file in Finder once it is down. */
  reveal: z.boolean().optional(),
});
const GallerySchema = z.object({ limit: z.number().int().min(1).max(60).optional() }).optional();
const ImageSchema = z.object({ url: z.string().url().max(4096) });
const RevealSchema = z.object({ filePath: FilePathSchema });

export interface MeshyIpcDeps {
  /** True when this is the path of a workspace the app knows. */
  isKnownWorkspace: (workspacePath: string) => Promise<boolean>;
  service?: MeshyService;
}

function assertAppWindow(event: IpcMainInvokeEvent): void {
  if (!event.senderFrame || event.senderFrame.parent !== null) {
    throw new Error("3D models are only available to the app window");
  }
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * The real path of a model the viewer may read: inside a known workspace (relative paths
 * resolve against it), else a model Meshy saved on this machine.
 */
export async function resolveReadableModel(
  filePath: string,
  workspacePath: string | undefined,
  deps: { isKnownWorkspace: MeshyIpcDeps["isKnownWorkspace"]; service: MeshyService },
): Promise<string> {
  if (filePath.includes("\0") || !MODEL_FILE_EXT_RE.test(filePath)) {
    throw new Error("Only .glb and .gltf models can be shown");
  }
  if (
    workspacePath &&
    path.isAbsolute(workspacePath) &&
    (await deps.isKnownWorkspace(workspacePath))
  ) {
    const root = await fsPromises.realpath(workspacePath).catch(() => null);
    const candidate = path.isAbsolute(filePath) ? filePath : path.resolve(workspacePath, filePath);
    const realPath = await fsPromises.realpath(candidate).catch(() => null);
    if (root && realPath && isInside(realPath, root) && MODEL_FILE_EXT_RE.test(realPath)) {
      return realPath;
    }
  }
  if (!path.isAbsolute(filePath)) throw new Error("Model not found in this workspace");
  return deps.service.knownModel(filePath);
}

export function setupMeshyHandlers(deps: MeshyIpcDeps): void {
  const service = deps.service ?? getMeshyService();
  const readDeps = { isKnownWorkspace: deps.isKnownWorkspace, service };
  const handle = <T>(
    channel: string,
    rate: (typeof RATE_LIMIT_CONFIGS)[keyof typeof RATE_LIMIT_CONFIGS],
    run: (raw: unknown) => Promise<T>,
  ) => {
    rateLimiter.configure(channel, rate);
    ipcMain.handle(channel, async (event, raw: unknown) => {
      assertAppWindow(event);
      if (!rateLimiter.check(channel)) throw new Error("Rate limit exceeded. Try again shortly.");
      return run(raw);
    });
  };

  handle(
    IPC_CHANNELS.MODEL3D_READ,
    RATE_LIMIT_CONFIGS.frequent,
    async (raw): Promise<Model3dFile> => {
      const { filePath, workspacePath } = validateInput(ModelReadSchema, raw, "model");
      const realPath = await resolveReadableModel(filePath, workspacePath, readDeps);
      const stat = await fsPromises.stat(realPath);
      if (!stat.isFile()) throw new Error("Not a file");
      if (stat.size > MAX_MODEL_BYTES) throw new Error("This model is too large to show here");
      const bytes = await fsPromises.readFile(realPath);
      return { name: path.basename(realPath), size: stat.size, bytes: new Uint8Array(bytes) };
    },
  );

  handle(IPC_CHANNELS.MESHY_STATUS, RATE_LIMIT_CONFIGS.frequent, () => service.status());

  // Cards poll a running task every few seconds.
  handle(IPC_CHANNELS.MESHY_TASK, RATE_LIMIT_CONFIGS.frequent, async (raw) => {
    const { taskId } = validateInput(TaskSchema, raw, "Meshy task");
    return service.task(taskId);
  });

  handle(IPC_CHANNELS.MESHY_FORMATS, RATE_LIMIT_CONFIGS.standard, async (raw) => {
    const { taskId, beside, workspacePath } = validateInput(FormatsSchema, raw, "Meshy formats");
    // The model shown may be in the open project or one Meshy saved; checked like a read.
    const anchor = beside ? await resolveReadableModel(beside, workspacePath, readDeps) : undefined;
    return service.formats(taskId, anchor);
  });

  handle(IPC_CHANNELS.MESHY_SAVE, RATE_LIMIT_CONFIGS.standard, async (raw) => {
    const { taskId, format, beside, workspacePath, chatTaskId, reveal } = validateInput(
      SaveSchema,
      raw,
      "Meshy download",
    );
    const anchor = beside ? await resolveReadableModel(beside, workspacePath, readDeps) : undefined;
    const saved = await service.save(taskId, format, { anchor, chatTaskId: chatTaskId ?? null });
    if (reveal) shell.showItemInFolder(saved.path);
    return saved;
  });

  handle(IPC_CHANNELS.MESHY_ACTIONS, RATE_LIMIT_CONFIGS.standard, async (raw) => {
    const { taskId } = validateInput(TaskSchema, raw, "Meshy task");
    return service.actions(taskId);
  });

  handle(IPC_CHANNELS.MESHY_GALLERY, RATE_LIMIT_CONFIGS.standard, async (raw) => {
    const options = validateInput(GallerySchema, raw, "Meshy gallery");
    return service.gallery(options?.limit);
  });

  handle(IPC_CHANNELS.MESHY_IMAGE, RATE_LIMIT_CONFIGS.frequent, async (raw) => {
    const { url } = validateInput(ImageSchema, raw, "Meshy image");
    return { dataUrl: await service.image(url) };
  });

  handle(IPC_CHANNELS.MESHY_REVEAL, RATE_LIMIT_CONFIGS.standard, async (raw) => {
    const { filePath } = validateInput(RevealSchema, raw, "model");
    try {
      shell.showItemInFolder(await service.knownModel(filePath));
      return { success: true };
    } catch (error) {
      return { success: false, error: errorText(error) };
    }
  });
}
