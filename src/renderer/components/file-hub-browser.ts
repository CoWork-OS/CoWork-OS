import type { Workspace } from "../../shared/types";
import { isTempWorkspaceId } from "../../shared/types";
import { webEndpoint } from "../../renderer-web/transport";

const MAX_LIST_ENTRIES = 100;
const MAX_SEARCH_DIRECTORIES = 80;
const MAX_SEARCH_DEPTH = 8;
const MAX_SEARCH_RESULTS = 1_000;
const MAX_ARTIFACT_TASKS = 100;
const MAX_ARTIFACTS_PER_TASK = 100;
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;

export type BrowserWorkspaceFileEntry = {
  name: string;
  relativePath: string;
  type: "file" | "directory";
  size: number;
};

export type BrowserWorkspaceFileListing = {
  workspaceId: string;
  relativePath: string;
  entries: BrowserWorkspaceFileEntry[];
  truncated: boolean;
};

export type BrowserArtifactEntry = {
  artifactId: string;
  name: string;
  mimeType: string;
  size: number;
  createdAt: number;
};

export type BrowserArtifactListResult = {
  taskId: string;
  workspaceId: string;
  artifacts: BrowserArtifactEntry[];
  limit: number;
  offset: number;
  nextOffset: number;
  hasMore: boolean;
};

export type BrowserArtifactDownloadHandle = {
  handle: string;
  artifactId: string;
  fileName: string;
  mimeType: string;
  size: number;
  expiresAt: number;
};

export type FileHubEntry = {
  id: string;
  name: string;
  path: string;
  source: "local" | "artifacts";
  mimeType: string;
  size: number;
  modifiedAt?: number;
  isDirectory?: boolean;
  metadata?: Record<string, unknown>;
};

export type BrowserFileHubApi = {
  listWorkspaces: () => Promise<Workspace[]>;
  listTasks: (options?: {
    limit?: number;
    offset?: number;
  }) => Promise<Array<{ id: string; workspaceId?: string | null }>>;
  listBrowserWorkspaceFiles: (request: {
    workspaceId: string;
    relativePath: string;
    limit: number;
  }) => Promise<BrowserWorkspaceFileListing>;
  listBrowserTaskArtifacts: (request: {
    taskId: string;
    workspaceId: string;
    limit: number;
    offset: number;
  }) => Promise<BrowserArtifactListResult>;
  createBrowserArtifactDownload: (request: {
    artifactId: string;
  }) => Promise<BrowserArtifactDownloadHandle>;
};

export type BrowserFileHubAdapter = {
  resolveWorkspace: (workspaceId: string) => Promise<Workspace>;
  listWorkspaceDirectory: (
    workspaceId: string,
    relativePath?: string,
  ) => Promise<{
    entries: FileHubEntry[];
    truncated: boolean;
  }>;
  searchWorkspaceFiles: (
    workspaceId: string,
    query: string,
    relativePath?: string,
  ) => Promise<{ entries: FileHubEntry[]; truncated: boolean }>;
  listWorkspaceArtifacts: (workspaceId: string) => Promise<{
    entries: FileHubEntry[];
    truncated: boolean;
  }>;
  downloadWorkspaceFile: (workspaceId: string, relativePath: string) => Promise<Blob>;
  downloadArtifact: (artifactId: string) => Promise<{ fileName: string; blob: Blob }>;
};

export function createBrowserFileHubAdapter(
  api: BrowserFileHubApi,
  dependencies: {
    fetch?: typeof fetch;
    endpoint?: (path: string) => URL;
  } = {},
): BrowserFileHubAdapter {
  const fetchImpl = dependencies.fetch ?? fetch;
  const endpoint = dependencies.endpoint ?? ((path: string) => webEndpoint(path));
  let csrfTokenPromise: Promise<string> | null = null;

  const csrfToken = async (): Promise<string> => {
    if (!csrfTokenPromise) {
      csrfTokenPromise = (async () => {
        const response = await fetchImpl(endpoint("session/bootstrap"), {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!response.ok) throw new Error("Your browser session needs to be refreshed.");
        const bootstrap = (await response.json()) as { csrfToken?: unknown };
        if (typeof bootstrap.csrfToken !== "string" || !bootstrap.csrfToken) {
          throw new Error("The browser session did not provide a file access token.");
        }
        return bootstrap.csrfToken;
      })().catch((error) => {
        csrfTokenPromise = null;
        throw error;
      });
    }
    return csrfTokenPromise;
  };

  const resolveWorkspace = async (workspaceId: string): Promise<Workspace> => {
    if (typeof workspaceId !== "string" || !workspaceId || workspaceId.length > 128) {
      throw new Error("Select a workspace before opening the Library.");
    }
    const workspace = (await api.listWorkspaces()).find(
      (candidate) => candidate.id === workspaceId,
    );
    if (
      !workspace ||
      workspace.permissions?.read !== true ||
      workspace.isTemp === true ||
      isTempWorkspaceId(workspace.id)
    ) {
      throw new Error("This workspace is not available to the browser Library.");
    }
    return workspace;
  };

  const listDirectory = async (
    workspaceId: string,
    relativePath = "",
  ): Promise<{ entries: FileHubEntry[]; truncated: boolean }> => {
    const workspace = await resolveWorkspace(workspaceId);
    assertRelativePath(relativePath, true);
    const listing = await api.listBrowserWorkspaceFiles({
      workspaceId: workspace.id,
      relativePath,
      limit: MAX_LIST_ENTRIES,
    });
    if (
      listing.workspaceId !== workspace.id ||
      listing.relativePath !== relativePath ||
      !Array.isArray(listing.entries)
    ) {
      throw new Error("The host returned an invalid workspace file listing.");
    }
    return {
      entries: listing.entries.flatMap((entry) => {
        if (
          !entry ||
          typeof entry.name !== "string" ||
          !entry.name ||
          !isChildPath(relativePath, entry.relativePath) ||
          (entry.type !== "file" && entry.type !== "directory") ||
          !Number.isFinite(entry.size) ||
          entry.size < 0
        ) {
          return [];
        }
        return [workspaceEntry(workspace.id, entry)];
      }),
      truncated: listing.truncated === true,
    };
  };

  const searchWorkspaceFiles = async (
    workspaceId: string,
    query: string,
    relativePath = "",
  ): Promise<{ entries: FileHubEntry[]; truncated: boolean }> => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return listDirectory(workspaceId, relativePath);
    assertRelativePath(relativePath, true);
    await resolveWorkspace(workspaceId);

    const pending = [{ path: relativePath, depth: 0 }];
    const visited = new Set<string>();
    const matches: FileHubEntry[] = [];
    let truncated = false;
    while (pending.length > 0 && visited.size < MAX_SEARCH_DIRECTORIES) {
      const current = pending.shift();
      if (!current || visited.has(current.path)) continue;
      visited.add(current.path);
      const page = await listDirectory(workspaceId, current.path);
      truncated ||= page.truncated;
      for (const entry of page.entries) {
        if (entry.isDirectory) {
          if (current.depth < MAX_SEARCH_DEPTH) {
            pending.push({ path: entry.path, depth: current.depth + 1 });
          } else {
            truncated = true;
          }
        } else if (
          entry.name.toLocaleLowerCase().includes(normalizedQuery) ||
          entry.path.toLocaleLowerCase().includes(normalizedQuery)
        ) {
          matches.push(entry);
          if (matches.length >= MAX_SEARCH_RESULTS) {
            truncated = true;
            return { entries: matches, truncated };
          }
        }
      }
    }
    if (pending.length > 0) truncated = true;
    return { entries: matches, truncated };
  };

  const listWorkspaceArtifacts = async (
    workspaceId: string,
  ): Promise<{ entries: FileHubEntry[]; truncated: boolean }> => {
    const workspace = await resolveWorkspace(workspaceId);
    const tasks = await api.listTasks({ limit: MAX_ARTIFACT_TASKS, offset: 0 });
    const workspaceTasks = tasks
      .filter((task) => task && task.workspaceId === workspace.id && typeof task.id === "string")
      .slice(0, MAX_ARTIFACT_TASKS);
    let truncated = tasks.length >= MAX_ARTIFACT_TASKS;
    const entries: FileHubEntry[] = [];

    for (let offset = 0; offset < workspaceTasks.length; offset += 5) {
      const taskBatch = workspaceTasks.slice(offset, offset + 5);
      const pages = await Promise.all(
        taskBatch.map(async (task) => {
          try {
            const result = await api.listBrowserTaskArtifacts({
              taskId: task.id,
              workspaceId: workspace.id,
              limit: MAX_ARTIFACTS_PER_TASK,
              offset: 0,
            });
            if (
              result.taskId !== task.id ||
              result.workspaceId !== workspace.id ||
              !Array.isArray(result.artifacts)
            ) {
              truncated = true;
              return [];
            }
            truncated ||= result.hasMore;
            return result.artifacts.map((artifact) =>
              artifactEntry(task.id, workspace.id, artifact),
            );
          } catch {
            truncated = true;
            return [];
          }
        }),
      );
      entries.push(...pages.flat());
    }
    entries.sort((left, right) => (right.modifiedAt ?? 0) - (left.modifiedAt ?? 0));
    return { entries, truncated };
  };

  const downloadWorkspaceFile = async (
    workspaceId: string,
    relativePath: string,
  ): Promise<Blob> => {
    const workspace = await resolveWorkspace(workspaceId);
    assertRelativePath(relativePath, false);
    const token = await csrfToken();
    const response = await fetchImpl(endpoint("workspace-files/download"), {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json", "X-CoWork-CSRF": token },
      body: JSON.stringify({ workspaceId: workspace.id, relativePath }),
    });
    if (!response.ok) throw downloadError(response.status);
    return responseBlob(response);
  };

  const downloadArtifact = async (
    artifactId: string,
  ): Promise<{ fileName: string; blob: Blob }> => {
    if (typeof artifactId !== "string" || !artifactId || artifactId.length > 128) {
      throw new Error("This artifact is unavailable.");
    }
    const grant = await api.createBrowserArtifactDownload({ artifactId });
    if (
      !grant ||
      typeof grant.handle !== "string" ||
      !grant.handle ||
      grant.artifactId !== artifactId ||
      typeof grant.fileName !== "string"
    ) {
      throw new Error("The host could not prepare this artifact download.");
    }
    const token = await csrfToken();
    const response = await fetchImpl(endpoint("artifacts/download"), {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json", "X-CoWork-CSRF": token },
      body: JSON.stringify({ handle: grant.handle }),
    });
    if (!response.ok) throw downloadError(response.status);
    return { fileName: grant.fileName, blob: await responseBlob(response) };
  };

  return {
    resolveWorkspace,
    listWorkspaceDirectory: listDirectory,
    searchWorkspaceFiles,
    listWorkspaceArtifacts,
    downloadWorkspaceFile,
    downloadArtifact,
  };
}

function workspaceEntry(workspaceId: string, entry: BrowserWorkspaceFileEntry): FileHubEntry {
  return {
    id: `workspace:${workspaceId}:${entry.relativePath}`,
    name: entry.name,
    path: entry.relativePath,
    source: "local",
    mimeType: entry.type === "directory" ? "inode/directory" : mimeTypeForName(entry.name),
    size: entry.size,
    isDirectory: entry.type === "directory",
  };
}

function artifactEntry(
  taskId: string,
  workspaceId: string,
  artifact: BrowserArtifactEntry,
): FileHubEntry {
  return {
    id: `artifact:${taskId}:${artifact.artifactId}`,
    name: artifact.name,
    path: artifact.artifactId,
    source: "artifacts",
    mimeType: artifact.mimeType,
    size: artifact.size,
    modifiedAt: artifact.createdAt,
    metadata: { taskId, workspaceId, artifactId: artifact.artifactId },
  };
}

function mimeTypeForName(name: string): string {
  const extension = name.slice(name.lastIndexOf(".")).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".bmp": "image/bmp",
    ".csv": "text/csv",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".json": "application/json",
    ".md": "text/markdown",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ts": "application/typescript",
    ".tsx": "application/typescript",
    ".txt": "text/plain",
    ".webp": "image/webp",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
  return mimeTypes[extension] || "application/octet-stream";
}

function isChildPath(parentPath: string, childPath: unknown): childPath is string {
  if (typeof childPath !== "string") return false;
  try {
    assertRelativePath(childPath, false);
  } catch {
    return false;
  }
  return !parentPath || childPath.startsWith(`${parentPath}/`);
}

function assertRelativePath(value: unknown, allowEmpty: boolean): asserts value is string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && !value) ||
    value.length > 4096 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /^[A-Za-z]:/.test(value) ||
    /[\0-\x1f\x7f]/.test(value) ||
    (value !== "" &&
      value.split("/").some((segment) => segment === "" || segment === "." || segment === ".."))
  ) {
    throw new Error("This file path is not available in the browser.");
  }
}

async function responseBlob(response: Response): Promise<Blob> {
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader && /^\d+$/.test(lengthHeader) && Number(lengthHeader) > MAX_DOWNLOAD_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("This file exceeds the browser download limit.");
  }
  const reader = response.body?.getReader();
  if (!reader) return new Blob([], { type: response.headers.get("content-type") || "" });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_DOWNLOAD_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("This file exceeds the browser download limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const buffer = new ArrayBuffer(total);
  const bytes = new Uint8Array(buffer);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Blob([buffer], { type: response.headers.get("content-type") || "" });
}

function downloadError(status: number): Error {
  if (status === 404 || status === 403)
    return new Error("This file is no longer available to you.");
  if (status === 413) return new Error("This file is larger than the browser download limit.");
  return new Error("The host could not download this file.");
}
