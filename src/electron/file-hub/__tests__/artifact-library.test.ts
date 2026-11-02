import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ArtifactRepository } from "../../database/repository-facades";
import { FileHubService } from "../FileHubService";

describe("Library task artifacts", () => {
  it("lists recent saved artifacts with their registered workspace roots", async () => {
    const db = new Database(":memory:");
    try {
      db.exec(`
        CREATE TABLE workspaces (id TEXT PRIMARY KEY, path TEXT NOT NULL);
        CREATE TABLE tasks (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL);
        CREATE TABLE artifacts (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL, path TEXT NOT NULL,
          mime_type TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
        INSERT INTO workspaces VALUES ('w1', '/project');
        INSERT INTO tasks VALUES ('t1', 'w1');
        INSERT INTO artifacts VALUES ('a1', 't1', '/project/old.txt', 'text/plain', 'hash', 1, 10);
        INSERT INTO artifacts VALUES ('a2', 't1', '/project/report.pdf', 'application/pdf', 'hash', 20, 20);
      `);
      const artifacts = new ArtifactRepository(db);
      const service = new FileHubService({
        getWorkspacePath: () => "/project",
        getArtifacts: ({ limit }) => artifacts.findRecent(limit),
        getConnectedSources: () => [],
      });

      const files = await service.listFiles({ source: "artifacts", limit: 1 });
      expect(files).toEqual([
        expect.objectContaining({
          id: "artifact:a2",
          name: "report.pdf",
          path: "/project/report.pdf",
          mimeType: "application/pdf",
          modifiedAt: 20,
          metadata: { taskId: "t1", workspacePath: "/project" },
        }),
      ]);
      const results = await service.searchFiles("old.txt", ["artifacts"]);
      expect(results.map((result) => result.file.name)).toEqual(["old.txt"]);
    } finally {
      db.close();
    }
  });
});
