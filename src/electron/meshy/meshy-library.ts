/**
 * What this machine knows about Meshy models: files the Meshy tools saved (in a project or
 * in Meshy's own folder), the Meshy task each came from, the prompt that made it and the
 * chat that asked for it. Kept as one small JSON file in Meshy's folder: paths, sizes and
 * ids only, never a URL or a key. Nothing here scans outside Meshy's own folder.
 */

import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import type { ReadableStream as WebReadableStream } from "stream/web";
import type { MeshyLocalModel } from "../../shared/meshy";
import { isMeshyTaskId } from "../../shared/meshy";
import { MESHY_ASSET_HOST } from "./meshy-api";

const LIBRARY_FILE = "cowork-library.json";
const MAX_MODELS = 500;
const MAX_TASKS = 2000;
const MAX_PROMPT_CHARS = 400;
const MAX_SCAN_DEPTH = 3;
/** A refined Meshy OBJ can be ~200 MB; this bounds a runaway response, not a real model. */
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
export const MODEL_FILE_EXT_RE = /\.(glb|gltf)$/i;

interface LibraryModel {
  path: string;
  bytes: number;
  taskId: string | null;
  chatTaskId: string | null;
  savedAt: number;
}

interface LibraryTask {
  prompt: string | null;
  tool: string;
  parentTaskId: string | null;
  chatTaskId: string | null;
  createdAt: number;
}

interface LibraryFile {
  version: 1;
  models: LibraryModel[];
  tasks: Record<string, LibraryTask>;
}

export interface MeshyLibrary {
  recordModel(entry: {
    path: string;
    taskId?: string | null;
    chatTaskId?: string | null;
  }): Promise<void>;
  recordCreation(entry: {
    taskId: string;
    tool: string;
    prompt?: string | null;
    parentTaskId?: string | null;
    chatTaskId?: string | null;
  }): Promise<void>;
  /** Saved models that still exist, newest first, plus any .glb in Meshy's own folder. */
  listModels(limit: number): Promise<MeshyLocalModel[]>;
  /** A known model file (recorded, or inside Meshy's folder); used to allow viewer reads. */
  isKnownModelPath(realPath: string): Promise<boolean>;
  taskForPath(realPath: string): Promise<string | null>;
  promptForTask(taskId: string): Promise<string | null>;
  savedPathFor(taskId: string): Promise<string | null>;
  dataDir(): string;
}

function emptyLibrary(): LibraryFile {
  return { version: 1, models: [], tasks: {} };
}

function cleanPrompt(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, MAX_PROMPT_CHARS) : null;
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * `getDataDir` is the Meshy server's folder (scanned for its downloads); `getLibraryDir`
 * holds the index, apart from it, because the server can write its own folder.
 */
export function createMeshyLibrary(
  getDataDir: () => string,
  getLibraryDir: () => string = getDataDir,
): MeshyLibrary {
  let queue: Promise<unknown> = Promise.resolve();
  // Read-modify-write runs one at a time; reads wait for writes already queued.
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  const libraryPath = () => path.join(getLibraryDir(), LIBRARY_FILE);

  const load = async (): Promise<LibraryFile> => {
    try {
      const parsed = JSON.parse(await fsPromises.readFile(libraryPath(), "utf8")) as LibraryFile;
      if (
        parsed?.version !== 1 ||
        !Array.isArray(parsed.models) ||
        typeof parsed.tasks !== "object"
      ) {
        return emptyLibrary();
      }
      return parsed;
    } catch {
      return emptyLibrary();
    }
  };

  const save = async (library: LibraryFile) => {
    const target = libraryPath();
    await fsPromises.mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.part`;
    await fsPromises.writeFile(temp, JSON.stringify(library), "utf8");
    await fsPromises.rename(temp, target);
  };

  const scanDataDir = async (): Promise<string[]> => {
    const root = getDataDir();
    const found: string[] = [];
    const walk = async (dir: string, depth: number) => {
      if (depth > MAX_SCAN_DEPTH || found.length >= MAX_MODELS) return;
      let entries: fs.Dirent[];
      try {
        entries = await fsPromises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full, depth + 1);
        else if (entry.isFile() && MODEL_FILE_EXT_RE.test(entry.name)) found.push(full);
      }
    };
    await walk(root, 0);
    return found;
  };

  return {
    dataDir: getDataDir,

    recordModel(entry) {
      return serial(async () => {
        if (!path.isAbsolute(entry.path) || !MODEL_FILE_EXT_RE.test(entry.path)) return;
        let realPath: string;
        let bytes: number;
        try {
          realPath = await fsPromises.realpath(entry.path);
          const stat = await fsPromises.stat(realPath);
          if (!stat.isFile()) return;
          bytes = stat.size;
        } catch {
          return;
        }
        const library = await load();
        const previous = library.models.find((model) => model.path === realPath);
        const next: LibraryModel = {
          path: realPath,
          bytes,
          taskId: isMeshyTaskId(entry.taskId) ? entry.taskId : (previous?.taskId ?? null),
          chatTaskId: entry.chatTaskId ?? previous?.chatTaskId ?? null,
          savedAt: Date.now(),
        };
        library.models = [next, ...library.models.filter((model) => model.path !== realPath)].slice(
          0,
          MAX_MODELS,
        );
        await save(library);
      });
    },

    recordCreation(entry) {
      return serial(async () => {
        if (!isMeshyTaskId(entry.taskId)) return;
        const library = await load();
        const previous = library.tasks[entry.taskId];
        library.tasks[entry.taskId] = {
          prompt: cleanPrompt(entry.prompt) ?? previous?.prompt ?? null,
          tool: entry.tool.slice(0, 80),
          parentTaskId: isMeshyTaskId(entry.parentTaskId)
            ? entry.parentTaskId
            : (previous?.parentTaskId ?? null),
          chatTaskId: entry.chatTaskId ?? previous?.chatTaskId ?? null,
          createdAt: previous?.createdAt ?? Date.now(),
        };
        const ids = Object.keys(library.tasks);
        if (ids.length > MAX_TASKS) {
          ids
            .sort((a, b) => library.tasks[a].createdAt - library.tasks[b].createdAt)
            .slice(0, ids.length - MAX_TASKS)
            .forEach((id) => delete library.tasks[id]);
        }
        await save(library);
      });
    },

    listModels(limit) {
      return serial(async () => {
        const library = await load();
        const seen = new Set<string>();
        const out: MeshyLocalModel[] = [];
        const add = async (filePath: string, model?: LibraryModel) => {
          if (seen.has(filePath) || out.length >= limit) return;
          seen.add(filePath);
          try {
            const stat = await fsPromises.stat(filePath);
            if (!stat.isFile()) return;
            const taskId = model?.taskId ?? null;
            out.push({
              path: filePath,
              name: path.basename(filePath),
              bytes: stat.size,
              modified: stat.mtimeMs,
              taskId,
              prompt: (taskId && library.tasks[taskId]?.prompt) || null,
              chatTaskId:
                model?.chatTaskId ?? (taskId ? library.tasks[taskId]?.chatTaskId : null) ?? null,
            });
          } catch {
            // vanished files drop out
          }
        };
        for (const model of library.models) await add(model.path, model);
        for (const filePath of await scanDataDir()) await add(filePath);
        return out.sort((a, b) => b.modified - a.modified);
      });
    },

    async isKnownModelPath(realPath) {
      if (!MODEL_FILE_EXT_RE.test(realPath)) return false;
      if (isInside(realPath, getDataDir())) return true;
      const library = await serial(load);
      return library.models.some((model) => model.path === realPath);
    },

    async taskForPath(realPath) {
      const library = await serial(load);
      return library.models.find((model) => model.path === realPath)?.taskId ?? null;
    },

    async promptForTask(taskId) {
      const library = await serial(load);
      return library.tasks[taskId]?.prompt ?? null;
    },

    async savedPathFor(taskId) {
      const library = await serial(load);
      for (const model of library.models) {
        if (model.taskId !== taskId) continue;
        if (fs.existsSync(model.path)) return model.path;
      }
      return null;
    },
  };
}

/** `name.ext`, or `name-2.ext` and so on: a save never replaces an existing file. */
export async function freeDestination(
  folder: string,
  stem: string,
  extension: string,
): Promise<string> {
  for (let index = 1; index < 1000; index += 1) {
    const candidate = path.join(folder, `${stem}${index === 1 ? "" : `-${index}`}.${extension}`);
    try {
      await fsPromises.access(candidate);
    } catch {
      return candidate;
    }
  }
  throw new Error("No free file name for the download");
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Streams a signed Meshy asset to `destination` through a temp file. */
export async function downloadMeshyAsset(
  url: string,
  destination: string,
  fetchImpl: FetchLike = fetch,
): Promise<number> {
  const assertAssetHost = (value: string) => {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.hostname !== MESHY_ASSET_HOST || parsed.port) {
      throw new Error("Unexpected download host");
    }
  };
  assertAssetHost(url);
  // Redirects are refused, so no request ever reaches a host other than Meshy's.
  const response = await fetchImpl(url, {
    redirect: "error",
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  if (response.url) assertAssetHost(response.url);
  if (response.status === 403 || response.status === 404 || response.status === 410) {
    throw new Error(
      "This Meshy download link has expired (links last 3 days after a task finishes).",
    );
  }
  if (!response.ok || !response.body)
    throw new Error(`Meshy download failed (HTTP ${response.status})`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES)
    throw new Error("Download too large");

  await fsPromises.mkdir(path.dirname(destination), { recursive: true });
  const temp = `${destination}.${process.pid}.part`;
  let bytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > MAX_DOWNLOAD_BYTES ? new Error("Download too large") : null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(response.body as unknown as WebReadableStream),
      counter,
      fs.createWriteStream(temp, { flags: "wx" }),
    );
    // Never over an existing file, even one that appeared during the download.
    await fsPromises.link(temp, destination);
  } finally {
    await fsPromises.rm(temp, { force: true });
  }
  return bytes;
}
