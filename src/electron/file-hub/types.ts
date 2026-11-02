/**
 * File Hub types — unified file browsing across local, artifacts, and cloud.
 */

import type { Artifact } from "../../shared/types";

export const FILE_HUB_SOURCES = [
  "local",
  "artifacts",
  "google_drive",
  "onedrive",
  "dropbox",
  "box",
  "sharepoint",
] as const;

export type FileHubSource = (typeof FILE_HUB_SOURCES)[number];

export interface UnifiedFile {
  id: string;
  name: string;
  path: string;
  source: FileHubSource;
  mimeType: string;
  size: number;
  modifiedAt: number;
  provider?: string;
  isDirectory?: boolean;
  thumbnailUrl?: string;
  /**
   * Source-specific details. Local entries carry `workspacePath`: the workspace root they
   * were listed under, which the file viewer needs to open them.
   */
  metadata?: Record<string, unknown>;
}

export interface FileHubSearchResult {
  file: UnifiedFile;
  snippet?: string;
  score?: number;
}

export interface FileHubListOptions {
  source: FileHubSource;
  /**
   * Local source only: the workspace whose root to list. Without one (or for an unknown id)
   * the default workspace is used.
   */
  workspaceId?: string;
  /**
   * Local source only: a folder inside the workspace root to list. A path that does not
   * resolve (after following symlinks) inside the root lists nothing.
   */
  path?: string;
  query?: string;
  limit?: number;
  offset?: number;
}

export interface FileHubServiceDeps {
  getWorkspacePath: (workspaceId: string) => string;
  getArtifacts: (query: { limit: number }) => Promise<Array<Artifact & { workspacePath?: string }>>;
  /** Check which cloud connectors are configured */
  getConnectedSources: () => FileHubSource[];
  log?: (...args: unknown[]) => void;
}
