import type Database from "better-sqlite3";
import * as path from "node:path";
import type { ApprovalRequest, Workspace, WorkspacePermissions } from "../../shared/types";
import { authorizationToolInput } from "../security/authorization-identity";
import { assertWorkspaceFilesystemAccess } from "../security/access-profile-paths";
import { WorkspaceArtifactEvidenceInspector } from "../sessions/WorkspaceArtifactEvidenceInspector";

export type ApprovalDraftReadContext = Pick<Workspace, "path" | "permissions">;
const MAX_FILES = 4;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const inspector = new WorkspaceArtifactEvidenceInspector({ maxBytes: MAX_FILE_BYTES });
const previewInspector = new WorkspaceArtifactEvidenceInspector({
  maxBytes: MAX_FILE_BYTES,
  previewMaxChars: 2000,
});
const READ_KEYS = [
  "read",
  "unrestrictedFileAccess",
  "allowedPaths",
  "accessWorkspaceRoots",
  "accessFilesystemRules",
  "accessProfileId",
  "accessFilesystemScoped",
  "accessProfileScoped",
  "accessProfileUnavailable",
  "accessSandboxMode",
] as const;
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
/** Declared dependencies and known filesystem tool inputs, never arbitrary string/command scanning. */
export function approvalDraftReferences(
  request: Pick<ApprovalRequest, "type" | "details">,
): string[] {
  const details = record(request.details),
    input = record(authorizationToolInput(details));
  const candidates: unknown[] = [];
  if (details.reviewFiles !== undefined && !Array.isArray(details.reviewFiles))
    throw new Error("Invalid approval draft references");
  if (Array.isArray(details.reviewFiles)) candidates.push(...details.reviewFiles);
  if (
    ["delete_file", "delete_multiple", "workspace_write", "external_file_access"].includes(
      request.type,
    )
  ) {
    for (const item of [details, input]) {
      for (const key of ["path", "filePath", "file_path", "sourcePath", "destPath", "targetPath"])
        if (item[key] !== undefined) candidates.push(item[key]);
      if (Array.isArray(item.paths)) candidates.push(...item.paths);
      if (Array.isArray(item.pathOperations))
        candidates.push(...item.pathOperations.map((entry) => record(entry).path));
    }
  }
  if (request.type === "data_export") {
    for (const key of ["path", "filePath", "file_path", "imagePath", "pdfPath"])
      if (input[key] !== undefined) candidates.push(input[key]);
  }
  if (
    candidates.length > 64 ||
    candidates.some((value) => typeof value !== "string" || !value.trim() || value.length > 2048)
  )
    throw new Error("Invalid approval draft references");
  const references = [...new Set(candidates as string[])];
  if (references.length > MAX_FILES) throw new Error("Too many approval draft files");
  return references;
}
function workspaceForTask(db: Database.Database, taskId: string): Workspace {
  const row = db
    .prepare(
      "SELECT w.id, w.path, w.permissions FROM tasks t JOIN workspaces w ON w.id = t.workspace_id WHERE t.id = ?",
    )
    .get(taskId) as { id: string; path: string; permissions: string } | undefined;
  if (!row || typeof row.path !== "string" || !row.path)
    throw new Error("Draft workspace is unavailable");
  return { id: row.id, path: row.path, permissions: JSON.parse(row.permissions) } as Workspace;
}
function inspect(
  workspace: Workspace,
  context: ApprovalDraftReadContext,
  reference: string,
  preview = false,
) {
  if (
    path.resolve(workspace.path) !== path.resolve(context.path) ||
    workspace.permissions.read !== true ||
    context.permissions.read !== true
  )
    throw new Error("Draft read scope is unavailable");
  assertWorkspaceFilesystemAccess(workspace, reference, "read", "approval draft revision");
  const textFile =
    /\.(?:txt|md|markdown|json|csv|tsv|ya?ml|toml|xml|html?|css|[cm]?jsx?|[cm]?tsx?|py|sh|sql)$/i.test(
      reference,
    );
  const result = (preview && textFile ? previewInspector : inspector).inspect(context, reference);
  if (result.status === "unavailable") throw new Error("Draft revision cannot be inspected");
  return result;
}

/** Only the trusted daemon supplies read context; user-supplied hashes are discarded. */
export function captureApprovalDrafts(
  db: Database.Database,
  request: Omit<ApprovalRequest, "id">,
  context?: ApprovalDraftReadContext,
): Any {
  if (!request.details || typeof request.details !== "object" || Array.isArray(request.details))
    return request.details;
  const details = { ...request.details };
  delete details.draftRevision;
  let references: string[];
  try {
    references = approvalDraftReferences({ ...request, details });
  } catch {
    return {
      ...details,
      draftRevision: { version: 1, state: "unavailable", reason: "invalid_references" },
    };
  }
  if (references.length === 0) return details;
  try {
    if (!context) throw new Error("Missing trusted read context");
    const permissions: WorkspacePermissions = {
      write: false,
      delete: false,
      network: false,
      shell: false,
      read: false,
      ...Object.fromEntries(
        READ_KEYS.filter((key) => context.permissions[key] !== undefined).map((key) => [
          key,
          context.permissions[key],
        ]),
      ),
    };
    if (JSON.stringify(permissions).length > 16000) throw new Error("Read policy exceeds limit");
    const safeContext = { path: context.path, permissions };
    const workspace = workspaceForTask(db, request.taskId);
    const entries = references.map((reference) => ({
      reference,
      ...inspect(workspace, safeContext, reference),
    }));
    // Constraints can only narrow trusted capture; caller hashes never become evidence.
    if (details.expectedDraftRevisions !== undefined) {
      if (
        !Array.isArray(details.expectedDraftRevisions) ||
        details.expectedDraftRevisions.length !== entries.length
      )
        throw new Error("Invalid expected draft revisions");
      for (let index = 0; index < entries.length; index++) {
        const expected = record(details.expectedDraftRevisions[index]);
        const entry = entries[index];
        if (
          entry.status !== "present" ||
          expected.reference !== entry.reference ||
          expected.sha256 !== entry.sha256 ||
          expected.size !== entry.size
        )
          throw new Error("Snapshot differs from approval draft");
      }
    }
    return {
      ...details,
      draftRevision: {
        version: 1,
        state: "bound",
        workspaceId: workspace.id,
        context: safeContext,
        entries,
      },
    };
  } catch {
    return {
      ...details,
      draftRevision: { version: 1, state: "unavailable", reason: "read_or_revision_unavailable" },
    };
  }
}

/** Called by the channel writer at publication, claim and the atomic approval transition. */
export function assertApprovalDraftsCurrent(
  db: Database.Database,
  request: Pick<ApprovalRequest, "taskId" | "type" | "details">,
): void {
  const references = approvalDraftReferences(request);
  if (references.length === 0) return;
  const binding = record(record(request.details).draftRevision);
  if (
    binding.version !== 1 ||
    binding.state !== "bound" ||
    !Array.isArray(binding.entries) ||
    binding.entries.length !== references.length
  )
    throw new Error("Approval draft has no trusted revision");
  const workspace = workspaceForTask(db, request.taskId);
  if (binding.workspaceId !== workspace.id) throw new Error("Approval draft workspace changed");
  const context = record(binding.context);
  if (
    typeof context.path !== "string" ||
    !context.permissions ||
    typeof context.permissions !== "object"
  )
    throw new Error("Approval draft read policy is unavailable");
  for (let index = 0; index < references.length; index++) {
    const entry = record(binding.entries[index]);
    if (entry.reference !== references[index]) throw new Error("Approval draft references changed");
    const current = inspect(workspace, context as ApprovalDraftReadContext, references[index]);
    if (
      current.status !== entry.status ||
      current.path !== entry.path ||
      (current.status === "present" &&
        (current.sha256 !== entry.sha256 || current.size !== entry.size))
    )
      throw new Error("Approval draft revision changed");
  }
}

/** Transient desktop preview, read from the exact recorded file version without storing content. */
export function readApprovalDraftPreviews(db: Database.Database, request: ApprovalRequest) {
  assertApprovalDraftsCurrent(db, request);
  const binding = record(record(request.details).draftRevision);
  if (binding.state !== "bound" || !Array.isArray(binding.entries)) return [];
  const workspace = workspaceForTask(db, request.taskId);
  const context = binding.context as ApprovalDraftReadContext;
  const previews: Array<{ reference: string; sha256: string; text: string; truncated: boolean }> =
    [];
  for (const raw of binding.entries) {
    const entry = record(raw);
    if (entry.status !== "present" || typeof entry.reference !== "string") continue;
    const current = inspect(workspace, context, entry.reference, true);
    if (
      current.status !== "present" ||
      current.sha256 !== entry.sha256 ||
      current.size !== entry.size ||
      current.path !== entry.path
    )
      throw new Error("Approval draft revision changed");
    if (current.preview)
      previews.push({ reference: entry.reference, sha256: current.sha256, ...current.preview });
  }
  return previews;
}
