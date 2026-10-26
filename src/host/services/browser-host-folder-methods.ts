import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WorkspaceRepository } from "../../electron/database/repository-facades";
import {
  canonicalizeAccessPath,
  findCredentialStore,
  isProtectedFilesystemPath,
  isProtectedWorkspacePath,
} from "../../electron/security/access-profile-paths";
import { getUserDataRootDir } from "../../electron/utils/user-data-dir";
import {
  HOST_FOLDER_HOME_ROOT_ID,
  HOST_FOLDER_MAX_FOLDERS,
  HOST_FOLDER_MAX_SCANNED_ENTRIES,
  HOST_FOLDER_MAX_SEGMENT_LENGTH,
  HOST_FOLDER_MAX_SEGMENTS,
  HOST_FOLDER_MAX_WORKSPACE_ROOTS,
  HOST_FOLDER_WORKSPACE_ROOT_PREFIX,
  type HostFolderListing,
  type HostFolderListRequest,
  type HostFolderRoot,
  type HostFolderSelection,
} from "../../shared/host-api/host-folders";
import type { Workspace } from "../../shared/types";
import { isTempWorkspaceId } from "../../shared/types";
import { WebApplicationError } from "../web/WebApplication";
import type { BrowserDesktopDefinitions } from "./browser-desktop-rpc";
import { toBrowserWorkspace } from "./browser-desktop-read-methods";

export interface BrowserHostFolderDefinitionsOptions {
  workspaces: Pick<WorkspaceRepository, "findAll" | "create" | "delete">;
  /** The profile/admin-scoped resolver used by every other browser workspace method. */
  resolveWorkspace: (workspaceId: string) => Promise<Workspace | null>;
  /** CoWork's own data (database, settings, profiles); never browsable from another root. */
  getDataRoot?: () => string;
}

/** Same baseline as a browser-created project: no delete, and shell left to access profiles. */
const NEW_WORKSPACE_PERMISSIONS: Workspace["permissions"] = {
  read: true,
  write: true,
  delete: false,
  network: true,
  shell: false,
};

const CONTROL_CHARACTERS = new RegExp("[\\u0000-\\u001f\\u007f]");
const CONTROL_CHARACTERS_GLOBAL = new RegExp("[\\u0000-\\u001f\\u007f]", "g");
const ROOT_ID_PATTERN = /^(home|workspace:[A-Za-z0-9._:-]{1,128})$/;

interface ResolvedRoot extends HostFolderRoot {
  /** Canonical host path of the root. Never sent to the browser. */
  folder: string;
}

/**
 * Host folder picker for the browser app, the server-side stand-in for the
 * native folder dialog.
 *
 * Starting points: the host user's home folder, plus the folders of existing
 * workspaces this session can read (for workspaces outside home). A browser
 * names a folder as a root id plus folder names; it never sends an absolute
 * path. Every request re-resolves the folder and refuses one that:
 * - leaves its root (`..`, separators, or a symlink pointing elsewhere),
 * - is an OS location (`isProtectedFilesystemPath`),
 * - sits in a protected segment such as `.git` or `.cowork/policy`
 *   (`isProtectedWorkspacePath`, checked from the filesystem root so any depth counts),
 * - sits in a credential store such as ~/.ssh (`findCredentialStore`),
 * - sits in CoWork's own data folder, unless the root already does (a browser-created project).
 * Refused folders are left out of listings, and choosing one fails.
 */
export function createBrowserHostFolderDefinitions(
  options: BrowserHostFolderDefinitionsOptions,
): BrowserDesktopDefinitions {
  const getDataRoot = options.getDataRoot ?? getUserDataRootDir;
  // Choosing a folder may add a workspace. Run those one at a time, so two
  // requests for the same folder find one workspace rather than adding two.
  let selectionQueue: Promise<unknown> = Promise.resolve();

  const readableWorkspaces = async (): Promise<Workspace[]> => {
    const raw = (await options.workspaces.findAll()).filter(
      (workspace) => !workspace.isTemp && !isTempWorkspaceId(workspace.id),
    );
    const resolved = await Promise.all(
      raw.map((workspace) => options.resolveWorkspace(workspace.id)),
    );
    return resolved.filter((workspace): workspace is Workspace => isReadableWorkspace(workspace));
  };

  const homeRoot = (): ResolvedRoot => ({
    id: HOST_FOLDER_HOME_ROOT_ID,
    kind: "home",
    label: "Home",
    folder: canonicalizeAccessPath(os.homedir()),
  });

  const workspaceRoot = (workspace: Workspace): ResolvedRoot | null => {
    if (!workspace.path) return null;
    const folder = canonicalizeAccessPath(workspace.path);
    if (isRefusedFolder(folder, workspace.path, folder, null)) return null;
    return {
      id: `${HOST_FOLDER_WORKSPACE_ROOT_PREFIX}${workspace.id}`,
      kind: "workspace",
      label: workspace.name,
      folder,
    };
  };

  const listRoots = async (): Promise<ResolvedRoot[]> => {
    const roots: ResolvedRoot[] = [homeRoot()];
    for (const workspace of await readableWorkspaces()) {
      if (roots.length > HOST_FOLDER_MAX_WORKSPACE_ROOTS) break;
      const root = workspaceRoot(workspace);
      if (root) roots.push(root);
    }
    return roots;
  };

  const resolveRoot = async (rootId: string): Promise<ResolvedRoot> => {
    if (rootId === HOST_FOLDER_HOME_ROOT_ID) return homeRoot();
    const workspace = await options.resolveWorkspace(
      rootId.slice(HOST_FOLDER_WORKSPACE_ROOT_PREFIX.length),
    );
    const root = isReadableWorkspace(workspace) ? workspaceRoot(workspace) : null;
    if (!root) throw folderUnavailable();
    return root;
  };

  /** The canonical folder for root + names, after every boundary check. */
  const resolveFolder = async (root: ResolvedRoot, segments: string[]): Promise<string> => {
    const lexical = path.join(root.folder, ...segments);
    let folder: string;
    try {
      folder = await fs.realpath(lexical);
      if (!(await fs.stat(folder)).isDirectory()) throw new Error("not a folder");
    } catch {
      throw folderUnavailable();
    }
    if (
      !isPathWithin(root.folder, folder) ||
      isRefusedFolder(root.folder, lexical, folder, canonicalizeAccessPath(getDataRoot()))
    ) {
      throw folderUnavailable();
    }
    return folder;
  };

  const listChildFolders = async (
    root: ResolvedRoot,
    folder: string,
    lexical: string,
    includeHidden: boolean,
  ): Promise<{ folders: string[]; truncated: boolean }> => {
    const dataRoot = canonicalizeAccessPath(getDataRoot());
    const atHome = root.kind === "home" && folder === root.folder;
    const names: string[] = [];
    let scanned = 0;
    let truncated = false;
    let directory: Awaited<ReturnType<typeof fs.opendir>>;
    try {
      directory = await fs.opendir(folder);
    } catch {
      throw folderUnavailable();
    }
    try {
      for await (const entry of directory) {
        scanned += 1;
        if (scanned > HOST_FOLDER_MAX_SCANNED_ENTRIES) {
          truncated = true;
          break;
        }
        if (!includeHidden && isHiddenFolderName(entry.name, atHome)) continue;
        const childLexical = path.join(lexical, entry.name);
        let child = path.join(folder, entry.name);
        if (entry.isSymbolicLink()) {
          // Follow a link only while it stays inside this root.
          try {
            child = await fs.realpath(child);
            if (!(await fs.stat(child)).isDirectory()) continue;
          } catch {
            continue;
          }
          if (!isPathWithin(root.folder, child)) continue;
        } else if (!entry.isDirectory()) {
          continue;
        }
        if (isRefusedFolder(root.folder, childLexical, child, dataRoot)) continue;
        names.push(entry.name);
      }
    } catch {
      throw folderUnavailable();
    } finally {
      // The iterator closes the directory; this covers an early exit before it starts.
      await directory.close().catch(() => undefined);
    }
    names.sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }));
    if (names.length > HOST_FOLDER_MAX_FOLDERS) truncated = true;
    return { folders: names.slice(0, HOST_FOLDER_MAX_FOLDERS), truncated };
  };

  /** Where the picker opens for a workspace: inside home when it lives there, else its own root. */
  const startNearWorkspace = async (
    workspaceId: string,
  ): Promise<{ root: ResolvedRoot; segments: string[] }> => {
    const workspace = await options.resolveWorkspace(workspaceId);
    const root = isReadableWorkspace(workspace) ? workspaceRoot(workspace) : null;
    if (!root) return { root: homeRoot(), segments: [] };
    const home = homeRoot();
    if (isPathWithin(home.folder, root.folder)) {
      const segments = path.relative(home.folder, root.folder).split(path.sep).filter(Boolean);
      try {
        await resolveFolder(home, segments);
        return { root: home, segments };
      } catch {
        return { root: home, segments: [] };
      }
    }
    return { root, segments: [] };
  };

  const selectFolder = async (selection: HostFolderSelection): Promise<Workspace> => {
    const root = await resolveRoot(selection.rootId);
    const folder = await resolveFolder(root, selection.path);
    const all = await options.workspaces.findAll();
    const existing = all.find((workspace) => {
      if (!workspace.path) return false;
      return samePath(canonicalizeAccessPath(workspace.path), folder);
    });
    if (existing) {
      const effective =
        existing.isTemp || isTempWorkspaceId(existing.id)
          ? null
          : await options.resolveWorkspace(existing.id);
      if (!effective?.permissions.read) {
        throw new WebApplicationError("FORBIDDEN", "That folder's workspace is unavailable.", 403);
      }
      return toBrowserWorkspace(effective);
    }

    const name = workspaceName(root, selection.path, folder);
    let created: Workspace | undefined;
    try {
      created = await options.workspaces.create(name, folder, { ...NEW_WORKSPACE_PERMISSIONS });
      const effective = await options.resolveWorkspace(created.id);
      if (!effective?.permissions.read) {
        throw new WebApplicationError("FORBIDDEN", "This folder is unavailable.", 403);
      }
      return toBrowserWorkspace(effective);
    } catch (error) {
      if (created) await options.workspaces.delete(created.id).catch(() => undefined);
      if (error instanceof WebApplicationError) throw error;
      throw new WebApplicationError(
        "HOST_UNAVAILABLE",
        "The host could not add this folder.",
        503,
        true,
      );
    }
  };

  return {
    listHostFolders: {
      capability: "workspaces.select",
      minArgs: 0,
      maxArgs: 1,
      validate: ([request]) => [parseListRequest(request)],
      handler: async ([request]): Promise<HostFolderListing> => {
        const parsed = request as ParsedListRequest;
        const start = parsed.rootId
          ? { root: await resolveRoot(parsed.rootId), segments: parsed.path ?? [] }
          : parsed.startWorkspaceId
            ? await startNearWorkspace(parsed.startWorkspaceId)
            : { root: homeRoot(), segments: [] };
        const folder = await resolveFolder(start.root, start.segments);
        const listing = await listChildFolders(
          start.root,
          folder,
          path.join(start.root.folder, ...start.segments),
          parsed.includeHidden,
        );
        return {
          roots: (await listRoots()).map(({ id, kind, label }) => ({ id, kind, label })),
          rootId: start.root.id,
          path: start.segments,
          displayPath: displayPath(start.root, start.segments),
          ...listing,
        };
      },
    },
    openHostFolderWorkspace: {
      capability: "workspaces.select",
      mutation: true,
      minArgs: 1,
      maxArgs: 1,
      validate: ([selection]) => [parseSelection(selection)],
      handler: async ([selection]) => {
        const result = selectionQueue.then(() => selectFolder(selection as HostFolderSelection));
        selectionQueue = result.catch(() => undefined);
        return result;
      },
    },
  };
}

function isReadableWorkspace(workspace: Workspace | null): workspace is Workspace {
  return (
    workspace !== null &&
    workspace.permissions.read === true &&
    !workspace.isTemp &&
    !isTempWorkspaceId(workspace.id)
  );
}

function isRefusedFolder(
  rootFolder: string,
  lexicalPath: string,
  folder: string,
  dataRoot: string | null,
): boolean {
  return (
    isProtectedFilesystemPath(folder) ||
    isProtectedFilesystemPath(lexicalPath) ||
    isProtectedWorkspacePath(path.parse(folder).root, folder) ||
    isProtectedWorkspacePath(path.parse(lexicalPath).root, lexicalPath) ||
    findCredentialStore(lexicalPath, folder) !== undefined ||
    (dataRoot !== null && isPathWithin(dataRoot, folder) && !isPathWithin(dataRoot, rootFolder))
  );
}

/** Dot folders, and ~/Library on macOS, which Finder hides too. */
function isHiddenFolderName(name: string, atHome: boolean): boolean {
  return name.startsWith(".") || (atHome && process.platform === "darwin" && name === "Library");
}

/** Containment on canonical paths, case-insensitive where the filesystem usually is. */
function isPathWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(foldCase(parent), foldCase(candidate));
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function samePath(left: string, right: string): boolean {
  return foldCase(path.resolve(left)) === foldCase(path.resolve(right));
}

function foldCase(value: string): string {
  return process.platform === "linux" ? value : value.toLowerCase();
}

function displayPath(root: ResolvedRoot, segments: string[]): string {
  const base = root.kind === "home" ? "~" : root.label;
  return segments.length ? [base, ...segments].join(path.sep) : base;
}

function workspaceName(root: ResolvedRoot, segments: string[], folder: string): string {
  const raw = segments.at(-1) ?? (path.basename(folder) || root.label);
  return raw.replace(CONTROL_CHARACTERS_GLOBAL, " ").trim().slice(0, 100) || "Workspace";
}

type ParsedListRequest = HostFolderListRequest & { includeHidden: boolean };

function parseListRequest(value: unknown): ParsedListRequest {
  if (value === undefined) return { includeHidden: false };
  const record = requireRecord(value, ["rootId", "path", "startWorkspaceId", "includeHidden"]);
  if (record.includeHidden !== undefined && typeof record.includeHidden !== "boolean") {
    throw invalidRequest();
  }
  if (record.rootId === undefined && record.path !== undefined) throw invalidRequest();
  const startWorkspaceId =
    record.startWorkspaceId === undefined ? undefined : parseWorkspaceId(record.startWorkspaceId);
  return {
    ...(record.rootId !== undefined ? { rootId: parseRootId(record.rootId) } : {}),
    ...(record.rootId !== undefined ? { path: parseSegments(record.path) } : {}),
    ...(startWorkspaceId ? { startWorkspaceId } : {}),
    includeHidden: record.includeHidden === true,
  };
}

function parseSelection(value: unknown): HostFolderSelection {
  const record = requireRecord(value, ["rootId", "path"]);
  return { rootId: parseRootId(record.rootId), path: parseSegments(record.path) };
}

function parseRootId(value: unknown): string {
  if (typeof value !== "string" || !ROOT_ID_PATTERN.test(value)) throw invalidRequest();
  return value;
}

function parseWorkspaceId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw invalidRequest();
  }
  return value;
}

/** Folder names only: no separators, no `.`/`..`, no control characters. */
function parseSegments(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > HOST_FOLDER_MAX_SEGMENTS) throw invalidRequest();
  return value.map((segment) => {
    if (
      typeof segment !== "string" ||
      segment.length === 0 ||
      segment.length > HOST_FOLDER_MAX_SEGMENT_LENGTH ||
      segment === "." ||
      segment === ".." ||
      segment.includes("/") ||
      segment.includes("\\") ||
      (process.platform === "win32" && segment.includes(":")) ||
      CONTROL_CHARACTERS.test(segment)
    ) {
      throw invalidRequest();
    }
    return segment;
  });
}

function requireRecord(value: unknown, allowedKeys: string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowedKeys.includes(key))
  ) {
    throw invalidRequest();
  }
  return value as Record<string, unknown>;
}

function invalidRequest(): WebApplicationError {
  return new WebApplicationError("INVALID_REQUEST", "Invalid folder request.", 400);
}

function folderUnavailable(): WebApplicationError {
  return new WebApplicationError("NOT_FOUND", "This folder is unavailable.", 404);
}
