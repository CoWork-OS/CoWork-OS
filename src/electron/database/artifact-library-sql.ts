import type Database from "better-sqlite3";
import type { Artifact } from "../../shared/types";

export type LibraryArtifact = Artifact & { workspacePath?: string };

type LibraryArtifactRow = {
  id: string;
  task_id: string;
  path: string;
  mime_type: string;
  sha256: string;
  size: number;
  created_at: number;
  workspace_path: string | null;
};

/**
 * The newest saved task artifacts across every workspace, with the workspace
 * folder each one belongs to, for the Library's Artifacts source.
 */
export function listRecentArtifacts(db: Database.Database, limit: number): LibraryArtifact[] {
  const rows = db
    .prepare(
      `SELECT artifacts.*, workspaces.path AS workspace_path
       FROM artifacts
       JOIN tasks ON tasks.id = artifacts.task_id
       JOIN workspaces ON workspaces.id = tasks.workspace_id
       ORDER BY artifacts.created_at DESC, artifacts.id DESC
       LIMIT ?`,
    )
    .all(limit) as LibraryArtifactRow[];
  return rows.map((row) => ({
    id: row.id,
    taskId: row.task_id,
    path: row.path,
    mimeType: row.mime_type,
    sha256: row.sha256,
    size: row.size,
    createdAt: row.created_at,
    workspacePath: row.workspace_path ?? undefined,
  }));
}
