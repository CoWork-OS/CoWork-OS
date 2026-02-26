/**
 * FileHubService — aggregates files from local workspace, task artifacts,
 * and cloud storage providers into a unified interface.
 */

import * as fs from "fs";
import * as path from "path";
import {
  UnifiedFile,
  FileHubSource,
  FileHubSearchResult,
  FileHubListOptions,
  FileHubServiceDeps,
} from "./types";

const MIME_EXTENSIONS: Record<string, string> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".js": "application/javascript",
  ".ts": "application/typescript",
  ".tsx": "application/typescript",
  ".jsx": "application/javascript",
  ".html": "text/html",
  ".css": "text/css",
  ".py": "text/x-python",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

export class FileHubService {
  private deps: FileHubServiceDeps;
  private recentFiles: Map<string, { file: UnifiedFile; accessedAt: number }> = new Map();
  private db: Any;

  constructor(deps: FileHubServiceDeps, db?: Any) {
    this.deps = deps;
    this.db = db;
    this.ensureSchema();
  }

  // ── List files ──────────────────────────────────────────────────

  async listFiles(options: FileHubListOptions): Promise<UnifiedFile[]> {
    switch (options.source) {
      case "local":
        return this.listLocalFiles(options);
      case "artifacts":
        return this.listArtifacts(options);
      default:
        // Cloud sources return empty until connector tools are wired
        return [];
    }
  }

  private listLocalFiles(options: FileHubListOptions): UnifiedFile[] {
    const workspacePath = options.path || this.deps.getWorkspacePath("");
    if (!workspacePath || !fs.existsSync(workspacePath)) return [];

    try {
      const entries = fs.readdirSync(workspacePath, { withFileTypes: true });
      const files: UnifiedFile[] = [];

      for (const entry of entries.slice(0, options.limit || 100)) {
        // Skip hidden files and common noise
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

        const fullPath = path.join(workspacePath, entry.name);
        try {
          const stat = fs.statSync(fullPath);
          const ext = path.extname(entry.name).toLowerCase();

          files.push({
            id: `local:${fullPath}`,
            name: entry.name,
            path: fullPath,
            source: "local",
            mimeType: entry.isDirectory()
              ? "inode/directory"
              : MIME_EXTENSIONS[ext] || "application/octet-stream",
            size: stat.size,
            modifiedAt: stat.mtimeMs,
            isDirectory: entry.isDirectory(),
          });
        } catch {
          // Inaccessible file, skip
        }
      }

      return files.sort((a, b) => b.modifiedAt - a.modifiedAt);
    } catch {
      return [];
    }
  }

  private listArtifacts(options: FileHubListOptions): UnifiedFile[] {
    const artifacts = this.deps.getArtifacts({ limit: options.limit || 50 });
    return artifacts.map((a: Any) => ({
      id: `artifact:${a.id}`,
      name: path.basename(a.path || "artifact"),
      path: a.path,
      source: "artifacts" as FileHubSource,
      mimeType: a.mime_type || "application/octet-stream",
      size: a.size || 0,
      modifiedAt: a.created_at || Date.now(),
      metadata: { taskId: a.task_id },
    }));
  }

  // ── Search ──────────────────────────────────────────────────────

  async searchFiles(query: string, sources?: FileHubSource[]): Promise<FileHubSearchResult[]> {
    const results: FileHubSearchResult[] = [];
    const targetSources = sources || ["local", "artifacts"];

    for (const source of targetSources) {
      const files = await this.listFiles({ source: source as FileHubSource, limit: 200 });
      const lowerQuery = query.toLowerCase();

      for (const file of files) {
        if (file.name.toLowerCase().includes(lowerQuery)) {
          results.push({
            file,
            snippet: file.name,
            score: file.name.toLowerCase().startsWith(lowerQuery) ? 1.0 : 0.5,
          });
        }
      }
    }

    return results.sort((a, b) => (b.score || 0) - (a.score || 0));
  }

  // ── Recent files ────────────────────────────────────────────────

  async getRecentFiles(limit = 20): Promise<UnifiedFile[]> {
    // Load from DB
    if (this.db) {
      try {
        const rows = this.db
          .prepare("SELECT * FROM file_hub_recent ORDER BY accessed_at DESC LIMIT ?")
          .all(limit) as Any[];

        return rows.map((r: Any) => ({
          id: r.id,
          name: r.name,
          path: r.path || "",
          source: r.source as FileHubSource,
          mimeType: r.mime_type || "application/octet-stream",
          size: r.size || 0,
          modifiedAt: r.accessed_at,
          metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
        }));
      } catch {
        // fallback to memory
      }
    }

    return Array.from(this.recentFiles.values())
      .sort((a, b) => b.accessedAt - a.accessedAt)
      .slice(0, limit)
      .map((r) => r.file);
  }

  trackAccess(file: UnifiedFile): void {
    const key = `${file.source}:${file.id}`;
    this.recentFiles.set(key, { file, accessedAt: Date.now() });

    // Persist to DB
    if (this.db) {
      try {
        this.db
          .prepare(
            `INSERT OR REPLACE INTO file_hub_recent
           (id, source, source_file_id, name, path, mime_type, size, accessed_at, metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            key,
            file.source,
            file.id,
            file.name,
            file.path,
            file.mimeType,
            file.size,
            Date.now(),
            file.metadata ? JSON.stringify(file.metadata) : null,
          );
      } catch {
        // ignore
      }
    }
  }

  // ── Connected sources ───────────────────────────────────────────

  getAvailableSources(): FileHubSource[] {
    const base: FileHubSource[] = ["local", "artifacts"];
    const connected = this.deps.getConnectedSources();
    return [...base, ...connected];
  }

  // ── Database ────────────────────────────────────────────────────

  private ensureSchema(): void {
    if (!this.db) return;
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS file_hub_recent (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          source_file_id TEXT NOT NULL,
          name TEXT NOT NULL,
          path TEXT,
          mime_type TEXT,
          size INTEGER,
          accessed_at INTEGER NOT NULL,
          metadata TEXT,
          UNIQUE(source, source_file_id)
        );
        CREATE INDEX IF NOT EXISTS idx_file_hub_recent_accessed ON file_hub_recent(accessed_at DESC);
      `);
    } catch {
      // Table already exists
    }
  }
}
