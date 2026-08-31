import * as path from "node:path";
import type { Workspace } from "../../shared/types";
import {
  assertWorkspaceFilesystemAccess,
  type AccessFilesystemOperation,
} from "../security/access-profile-paths";
import { assertNetworkPolicyAllowed } from "../security/network-policy";
import { buildYouTubeWatchUrl, extractYouTubeVideoId } from "./url";

export interface YouTubeIngestionOptions {
  assertFilesystemAccess?: (requestedPath: string, operation: AccessFilesystemOperation) => string;
}

/**
 * Build the filesystem callback used by task and IPC entry points. The
 * ingestion service also runs as a standalone utility in tests, so the
 * callback remains optional there; production callers must provide it.
 */
export function createYouTubeIngestionOptions(
  workspace: Pick<Workspace, "path" | "permissions">,
): YouTubeIngestionOptions {
  return {
    assertFilesystemAccess: (requestedPath, operation) =>
      assertWorkspaceFilesystemAccess(
        workspace,
        requestedPath,
        operation,
        "YouTube transcript cache",
      ),
  };
}

/**
 * yt-dlp and the Python transcript fallback run as local child processes and
 * cannot enforce per-domain allow/deny rules themselves. Refuse that
 * combination rather than letting a subprocess escape the profile's network
 * boundary. The normal network policy still validates the canonical YouTube
 * endpoint and workspace/profile network switches.
 */
export function assertYouTubeIngestionAccess(
  workspace: Pick<Workspace, "path" | "permissions">,
  rawInput: string,
  toolName: string,
): string {
  const videoId = extractYouTubeVideoId(rawInput);
  if (!videoId) throw new Error("Expected a YouTube URL or 11-character video ID.");

  if ((workspace.permissions.accessDomainRules || []).length > 0) {
    throw new Error(
      "YouTube ingestion cannot be combined with domain-scoped network rules because the local transcript process cannot enforce its child-request domains.",
    );
  }

  const url = buildYouTubeWatchUrl(videoId);
  assertNetworkPolicyAllowed({
    url,
    toolName,
    networkEnabled: workspace.permissions.network,
    accessNetworkMode: workspace.permissions.accessNetworkMode,
    profileDomainRules: workspace.permissions.accessDomainRules,
  });
  return url;
}

export function assertYouTubeCacheAccess(
  workspace: Pick<Workspace, "path" | "permissions">,
  operation: "read" | "write",
): string {
  return assertWorkspaceFilesystemAccess(
    workspace,
    path.join(workspace.path, ".cowork", "youtube"),
    operation,
    "YouTube transcript cache",
  );
}
