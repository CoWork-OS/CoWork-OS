import type Database from "better-sqlite3";

export interface FileHubRecentInput {
  key: string;
  source: string;
  sourceFileId: string;
  name: string;
  path: string | undefined;
  mimeType: string | undefined;
  size: number | undefined;
  accessedAt: number;
  metadataJson: string | null;
}

/**
 * The file hub's recent-files table (async SQLite migration plan, DB6). As services-domain
 * units these run in the database worker when the domain is routed there; schema setup
 * stays in `FileHubService` on the host.
 */
export class FileHubStore {
  constructor(private readonly db: Database.Database) {}

  // oxlint-disable-next-line typescript/no-explicit-any -- rows are mapped by FileHubService
  recentRows(limit: number): any[] {
    return this.db
      .prepare("SELECT * FROM file_hub_recent ORDER BY accessed_at DESC LIMIT ?")
      .all(limit);
  }

  trackRecent(input: FileHubRecentInput): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO file_hub_recent
       (id, source, source_file_id, name, path, mime_type, size, accessed_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.key,
        input.source,
        input.sourceFileId,
        input.name,
        input.path ?? null,
        input.mimeType ?? null,
        input.size ?? null,
        input.accessedAt,
        input.metadataJson,
      );
  }
}
