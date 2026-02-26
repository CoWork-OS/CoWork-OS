import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FileHubService } from "../FileHubService";
import { FileHubServiceDeps, UnifiedFile } from "../types";

function makeDeps(overrides: Partial<FileHubServiceDeps> = {}): FileHubServiceDeps {
  return {
    getWorkspacePath: () => "",
    getArtifacts: () => [],
    getConnectedSources: () => [],
    log: vi.fn(),
    ...overrides,
  };
}

describe("FileHubService", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "filehub-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Local file listing ────────────────────────────────────────

  it("lists local files from workspace directory", async () => {
    fs.writeFileSync(path.join(tmpDir, "readme.md"), "# Hello");
    fs.writeFileSync(path.join(tmpDir, "config.json"), "{}");

    const service = new FileHubService(makeDeps({ getWorkspacePath: () => tmpDir }));
    const files = await service.listFiles({ source: "local" });

    expect(files.length).toBe(2);
    const names = files.map((f) => f.name).sort();
    expect(names).toEqual(["config.json", "readme.md"]);
  });

  it("assigns correct MIME types", async () => {
    fs.writeFileSync(path.join(tmpDir, "doc.md"), "# Markdown");
    fs.writeFileSync(path.join(tmpDir, "style.css"), "body {}");
    fs.writeFileSync(path.join(tmpDir, "app.ts"), "const x = 1;");

    const service = new FileHubService(makeDeps({ getWorkspacePath: () => tmpDir }));
    const files = await service.listFiles({ source: "local" });

    const mimeMap = Object.fromEntries(files.map((f) => [f.name, f.mimeType]));
    expect(mimeMap["doc.md"]).toBe("text/markdown");
    expect(mimeMap["style.css"]).toBe("text/css");
    expect(mimeMap["app.ts"]).toBe("application/typescript");
  });

  it("skips hidden files and node_modules", async () => {
    fs.writeFileSync(path.join(tmpDir, ".hidden"), "secret");
    fs.mkdirSync(path.join(tmpDir, "node_modules"));
    fs.writeFileSync(path.join(tmpDir, "visible.txt"), "hello");

    const service = new FileHubService(makeDeps({ getWorkspacePath: () => tmpDir }));
    const files = await service.listFiles({ source: "local" });

    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("visible.txt");
  });

  it("returns empty array for non-existent directory", async () => {
    const service = new FileHubService(makeDeps({ getWorkspacePath: () => "/nonexistent/path" }));
    const files = await service.listFiles({ source: "local" });
    expect(files).toEqual([]);
  });

  it("includes directory entries", async () => {
    fs.mkdirSync(path.join(tmpDir, "subdir"));
    fs.writeFileSync(path.join(tmpDir, "file.txt"), "hello");

    const service = new FileHubService(makeDeps({ getWorkspacePath: () => tmpDir }));
    const files = await service.listFiles({ source: "local" });

    const dir = files.find((f) => f.name === "subdir");
    expect(dir).toBeDefined();
    expect(dir!.mimeType).toBe("inode/directory");
    expect(dir!.isDirectory).toBe(true);
  });

  // ── Artifact listing ──────────────────────────────────────────

  it("lists task artifacts", async () => {
    const service = new FileHubService(
      makeDeps({
        getArtifacts: () => [
          {
            id: "a1",
            path: "/output/report.pdf",
            mime_type: "application/pdf",
            size: 5000,
            created_at: Date.now(),
            task_id: "t1",
          },
        ],
      }),
    );

    const files = await service.listFiles({ source: "artifacts" });
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("report.pdf");
    expect(files[0].source).toBe("artifacts");
  });

  // ── Search ────────────────────────────────────────────────────

  it("searches files by name", async () => {
    fs.writeFileSync(path.join(tmpDir, "report.md"), "# Report");
    fs.writeFileSync(path.join(tmpDir, "notes.md"), "# Notes");
    fs.writeFileSync(path.join(tmpDir, "data.json"), "{}");

    const service = new FileHubService(makeDeps({ getWorkspacePath: () => tmpDir }));
    const results = await service.searchFiles("report", ["local"]);

    expect(results).toHaveLength(1);
    expect(results[0].file.name).toBe("report.md");
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("search is case-insensitive", async () => {
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# README");

    const service = new FileHubService(makeDeps({ getWorkspacePath: () => tmpDir }));
    const results = await service.searchFiles("readme", ["local"]);

    expect(results).toHaveLength(1);
  });

  it("ranks prefix matches higher", async () => {
    fs.writeFileSync(path.join(tmpDir, "report-final.md"), "x");
    fs.writeFileSync(path.join(tmpDir, "old-report.md"), "x");

    const service = new FileHubService(makeDeps({ getWorkspacePath: () => tmpDir }));
    const results = await service.searchFiles("report", ["local"]);

    expect(results).toHaveLength(2);
    // Prefix match should score higher
    expect(results[0].file.name).toBe("report-final.md");
    expect(results[0].score).toBeGreaterThan(results[1].score!);
  });

  // ── Available sources ─────────────────────────────────────────

  it("returns local and artifacts as base sources", () => {
    const service = new FileHubService(makeDeps());
    const sources = service.getAvailableSources();
    expect(sources).toContain("local");
    expect(sources).toContain("artifacts");
  });

  it("includes connected cloud sources", () => {
    const service = new FileHubService(
      makeDeps({
        getConnectedSources: () => ["google_drive", "dropbox"],
      }),
    );
    const sources = service.getAvailableSources();
    expect(sources).toContain("google_drive");
    expect(sources).toContain("dropbox");
  });

  // ── Recent files tracking ─────────────────────────────────────

  it("tracks file access in memory", async () => {
    const service = new FileHubService(makeDeps());

    const file: UnifiedFile = {
      id: "local:/tmp/test.md",
      name: "test.md",
      path: "/tmp/test.md",
      source: "local",
      mimeType: "text/markdown",
      size: 100,
      modifiedAt: Date.now(),
    };

    service.trackAccess(file);
    const recent = await service.getRecentFiles(10);
    expect(recent).toHaveLength(1);
    expect(recent[0].name).toBe("test.md");
  });

  // ── Cloud sources return empty ────────────────────────────────

  it("returns empty for cloud sources not yet wired", async () => {
    const service = new FileHubService(makeDeps());
    const files = await service.listFiles({ source: "google_drive" });
    expect(files).toEqual([]);
  });

  // ── Respects limit ────────────────────────────────────────────

  it("respects file listing limit", async () => {
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(tmpDir, `file-${i}.txt`), `content ${i}`);
    }

    const service = new FileHubService(makeDeps({ getWorkspacePath: () => tmpDir }));
    const files = await service.listFiles({ source: "local", limit: 3 });
    expect(files.length).toBeLessThanOrEqual(3);
  });
});
