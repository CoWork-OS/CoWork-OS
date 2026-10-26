import type { Workspace } from "../types";

/**
 * The browser folder picker browses host folders below a small set of starting
 * points. A browser names a folder by one of these roots plus folder names, never
 * by an absolute host path, and the host re-checks the folder on every request.
 */
export const HOST_FOLDER_HOME_ROOT_ID = "home";
export const HOST_FOLDER_WORKSPACE_ROOT_PREFIX = "workspace:";

/** Child folders returned for one folder; larger folders report `truncated`. */
export const HOST_FOLDER_MAX_FOLDERS = 500;
/** Directory entries read for one folder before the listing stops. */
export const HOST_FOLDER_MAX_SCANNED_ENTRIES = 10_000;
export const HOST_FOLDER_MAX_SEGMENTS = 64;
export const HOST_FOLDER_MAX_SEGMENT_LENGTH = 255;
export const HOST_FOLDER_MAX_WORKSPACE_ROOTS = 50;

export interface HostFolderRoot {
  /** `home`, or `workspace:<workspace id>` for an existing readable workspace. */
  id: string;
  kind: "home" | "workspace";
  /** "Home", or the workspace name. Never a host path. */
  label: string;
}

export interface HostFolderListRequest {
  /** Omitted: start near `startWorkspaceId` when given, otherwise at the home folder. */
  rootId?: string;
  /** Folder names below the root. */
  path?: string[];
  /** Open the picker where an existing workspace lives. Ignored when `rootId` is set. */
  startWorkspaceId?: string;
  /** Include dot folders (and ~/Library on macOS). Protected folders stay hidden. */
  includeHidden?: boolean;
}

export interface HostFolderListing {
  roots: HostFolderRoot[];
  rootId: string;
  path: string[];
  /** "~/Projects/site" or "<workspace name>/docs", for display only. */
  displayPath: string;
  /** Child folder names, sorted; protected and unreadable folders are left out. */
  folders: string[];
  /** True when the folder held more entries than the host reads or returns. */
  truncated: boolean;
}

export interface HostFolderSelection {
  rootId: string;
  path: string[];
}

/** The browser-host methods behind the folder picker. */
export interface BrowserHostFolderApi {
  listHostFolders: (request: HostFolderListRequest) => Promise<HostFolderListing>;
  /** Returns the workspace for the folder, adding one when the folder is not a workspace yet. */
  openHostFolderWorkspace: (selection: HostFolderSelection) => Promise<Workspace>;
}
