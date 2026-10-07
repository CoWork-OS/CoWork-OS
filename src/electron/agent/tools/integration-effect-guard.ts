import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { GoogleWorkspaceSettingsData, Workspace } from "../../../shared/types";
import {
  getGoogleWorkspaceSettingsForAccount,
  hasGoogleWorkspaceScopeCoverage,
  hasGoogleWorkspaceTokens,
  inferGoogleWorkspaceConnectionMode,
} from "../../../shared/google-workspace";
import type { MCPAuthConfig } from "../../mcp/types";
import { enforceResponsibilityToolPolicy } from "../../automation/responsibility-task-policy";
import { isProvenOAuthRefresh } from "../../security/oauth-refresh-proof";
import { WorkspaceArtifactEvidenceInspector } from "../../sessions/WorkspaceArtifactEvidenceInspector";
import { getBundledGoogleWorkspaceOAuthClientId } from "../../utils/google-workspace-oauth-client";
import type { AgentDaemon } from "../daemon";

const MAX_REVIEWED_UPLOAD_BYTES = 4 * 1024 * 1024;

export function googleWorkspaceAuthConfig(settings: GoogleWorkspaceSettingsData): MCPAuthConfig {
  const effective = getGoogleWorkspaceSettingsForAccount(settings);
  return {
    type: "bearer",
    token: effective.accessToken,
    refreshToken: effective.refreshToken,
    clientId: effective.clientId || getBundledGoogleWorkspaceOAuthClientId(),
    clientSecret: effective.clientSecret,
    tokenUrl: effective.refreshToken ? "https://oauth2.googleapis.com/token" : undefined,
    expiresAt: effective.tokenExpiresAt,
  };
}

export function googleWorkspacePolicyFingerprint(settings: GoogleWorkspaceSettingsData): string {
  const accounts = (settings.accounts || [])
    .map(({ email, name, scopes, connectionMode }) => ({
      email: email.toLowerCase(),
      name,
      scopes: scopes ? [...scopes].sort() : undefined,
      connectionMode,
    }))
    .sort((left, right) => left.email.localeCompare(right.email));
  return JSON.stringify({
    enabled: settings.enabled,
    connectionMode: settings.connectionMode,
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    builtinOAuthClientAvailable: settings.builtinOAuthClientAvailable,
    activeAccountEmail: settings.activeAccountEmail?.toLowerCase(),
    scopes: settings.scopes ? [...settings.scopes].sort() : undefined,
    accounts,
    timeoutMs: settings.timeoutMs,
    loginHint: settings.loginHint,
  });
}

export function googleWorkspaceScopeReady(
  settings: GoogleWorkspaceSettingsData,
  scope: "gmail" | "workspace",
  requiredMode?: "gmail" | "workspace",
): boolean {
  const mode = inferGoogleWorkspaceConnectionMode(settings.connectionMode, settings.scopes);
  return (
    settings.enabled &&
    (!requiredMode || mode === requiredMode) &&
    hasGoogleWorkspaceTokens(settings) &&
    hasGoogleWorkspaceScopeCoverage(settings.scopes, scope)
  );
}

export interface IntegrationUploadSnapshot {
  path: string;
  sha256: string;
  size: number;
  data: Buffer;
  workspaceBound: boolean;
}

function workspaceFingerprint(workspace: Workspace): string {
  return JSON.stringify({
    id: workspace.id,
    path: workspace.path,
    permissions: workspace.permissions,
  });
}

function sameFileRevision(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function captureApprovedExternalFile(filePath: string): IntegrationUploadSnapshot {
  let canonicalPath: string;
  try {
    canonicalPath = fs.realpathSync.native(filePath);
  } catch {
    throw new Error("Upload file is no longer available for review");
  }

  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  let fd: number | undefined;
  try {
    fd = fs.openSync(canonicalPath, flags);
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new Error("Upload input is not a regular file");
    if (before.size > BigInt(MAX_REVIEWED_UPLOAD_BYTES)) {
      throw new Error("Upload file exceeds the 4 MiB review limit");
    }
    const data = fs.readFileSync(fd);
    const after = fs.fstatSync(fd, { bigint: true });
    if (!sameFileRevision(before, after) || BigInt(data.length) !== after.size) {
      throw new Error("Upload file changed while its revision was being reviewed");
    }
    if (fs.realpathSync.native(filePath) !== canonicalPath) {
      throw new Error("Upload file path changed while its revision was being reviewed");
    }
    return {
      path: canonicalPath,
      sha256: createHash("sha256").update(data).digest("hex"),
      size: data.length,
      data,
      workspaceBound: false,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      /review limit|changed while|not a regular file/.test(error.message)
    )
      throw error;
    throw new Error("Upload file cannot be captured safely for review");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Capture the bytes from the canonical file already admitted by the workspace read gate. */
export function captureIntegrationUploadSnapshot(
  workspace: Workspace,
  resolvedPath: string,
): IntegrationUploadSnapshot {
  const inspected = new WorkspaceArtifactEvidenceInspector({
    maxBytes: MAX_REVIEWED_UPLOAD_BYTES,
  }).snapshot(workspace, resolvedPath);
  if (inspected.status === "present" && inspected.data) {
    if (inspected.data.length !== inspected.size) {
      throw new Error("Upload file changed while its revision was being reviewed");
    }
    return {
      path: inspected.path,
      sha256: inspected.sha256,
      size: inspected.size,
      data: inspected.data,
      workspaceBound: true,
    };
  }
  if (inspected.status === "unavailable" && inspected.reason === "outside_workspace") {
    return captureApprovedExternalFile(resolvedPath);
  }
  if (inspected.status === "unavailable" && inspected.reason === "too_large") {
    throw new Error("Upload file exceeds the 4 MiB review limit");
  }
  throw new Error("Upload file cannot be captured safely for review");
}

function assertUploadSnapshotCurrent(
  workspace: Workspace,
  snapshot: IntegrationUploadSnapshot,
): void {
  const current = snapshot.workspaceBound
    ? captureIntegrationUploadSnapshot(workspace, snapshot.path)
    : captureApprovedExternalFile(snapshot.path);
  const sentHash = createHash("sha256").update(snapshot.data).digest("hex");
  if (
    current.path !== snapshot.path ||
    current.sha256 !== snapshot.sha256 ||
    current.size !== snapshot.size ||
    sentHash !== snapshot.sha256 ||
    snapshot.data.length !== snapshot.size
  ) {
    throw new Error("Upload file revision changed before send");
  }
}

function isWithinWorkspace(workspace: Workspace, filePath: string): boolean {
  try {
    const root = fs.realpathSync.native(path.resolve(workspace.path));
    const relative = path.relative(root, filePath);
    return (
      relative === "" ||
      (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
    );
  } catch {
    return false;
  }
}

export function workspaceIntegrationUploadReview(
  workspace: Workspace,
  toolName: string,
  toolInput: unknown,
  action: string,
  destination: Record<string, unknown>,
  file: IntegrationUploadSnapshot,
): Record<string, unknown> {
  const revision = { path: file.path, sha256: file.sha256, size: file.size };
  const details: Record<string, unknown> = {
    tool: toolName,
    params: structuredClone(toolInput),
    action,
    ...destination,
    reviewedFileRevision: revision,
  };
  if (isWithinWorkspace(workspace, file.path)) {
    details.reviewFiles = [file.path];
    details.expectedDraftRevisions = [
      { reference: file.path, sha256: file.sha256, size: file.size },
    ];
  } else {
    // The caller has already completed the separate external_file_access approval.
    // Keep the revision in the service approval without asking the workspace-only
    // approval-draft reader to inspect an external path.
    details.externalFileRevision = revision;
  }
  return details;
}

export function integrationEffectReview(
  toolName: string,
  toolInput: unknown,
  action: string,
  destination: Record<string, unknown>,
): Record<string, unknown> {
  return {
    tool: toolName,
    params: structuredClone(toolInput),
    action,
    ...structuredClone(destination),
  };
}

export function integrationEffectRequestDigest(
  method: string,
  requestPath: string,
  body: unknown,
): string {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, canonicalize(item)]),
      );
    }
    return value;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonicalize({ method, path: requestPath, body: body ?? null })))
    .digest("hex");
}

interface GuardOptions<Settings> {
  daemon: AgentDaemon;
  taskId: string;
  workspace: Workspace;
  getWorkspace(): Workspace;
  toolName: string;
  toolInput: unknown;
  approvalDetails: Record<string, unknown>;
  uploadSnapshot?: IntegrationUploadSnapshot;
  initialSettings: Settings;
  loadSettings(): Settings;
  settingsEnabled(settings: Settings): boolean;
  settingsFingerprint(settings: Settings): string;
  authConfig(settings: Settings): MCPAuthConfig;
  errorPrefix: string;
}

/** Rechecks reviewed connector bytes, local authority and current consent at the send boundary. */
export async function createIntegrationEffectGuard<Settings>(
  options: GuardOptions<Settings>,
): Promise<() => Promise<void>> {
  const { daemon, taskId, workspace } = options;
  const admittedScope = workspaceFingerprint(workspace);
  const admittedSettings = options.settingsFingerprint(options.initialSettings);
  const admittedAuth = structuredClone(options.authConfig(options.initialSettings));
  const getAuthority = daemon.getToolEffectAuthority;
  if (typeof getAuthority !== "function")
    throw new Error(`${options.errorPrefix} authority unavailable`);
  const admittedAuthority = await getAuthority.call(daemon, taskId, options.approvalDetails);
  if (!admittedAuthority) throw new Error(`${options.errorPrefix} authority unavailable`);

  const checkCurrent = () => {
    const currentWorkspace = daemon.getEffectiveWorkspaceForTask(taskId);
    const localWorkspace = options.getWorkspace();
    const currentSettings = options.loadSettings();
    if (
      !currentWorkspace ||
      workspaceFingerprint(currentWorkspace) !== admittedScope ||
      workspaceFingerprint(localWorkspace) !== admittedScope ||
      workspaceFingerprint(workspace) !== admittedScope ||
      !options.settingsEnabled(currentSettings) ||
      options.settingsFingerprint(currentSettings) !== admittedSettings ||
      !isProvenOAuthRefresh(admittedAuth, options.authConfig(currentSettings))
    ) {
      throw new Error(`${options.errorPrefix} authority changed before send`);
    }
  };

  return async () => {
    checkCurrent();
    await enforceResponsibilityToolPolicy(
      daemon.getDatabase(),
      taskId,
      workspace.id,
      workspace.path,
      options.toolName,
      options.toolInput,
    );
    checkCurrent();
    const currentAuthority = await getAuthority.call(daemon, taskId, options.approvalDetails);
    checkCurrent();
    if (!currentAuthority || currentAuthority !== admittedAuthority)
      throw new Error(`${options.errorPrefix} task authority changed before send`);
    if (options.uploadSnapshot) assertUploadSnapshotCurrent(workspace, options.uploadSnapshot);
    checkCurrent();
  };
}
