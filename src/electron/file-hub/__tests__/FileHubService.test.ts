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

  // ── Selected workspace ───────────────────────────────────────

  describe("selected workspace", () => {
    let otherDir: string;

    beforeEach(() => {
      otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "filehub-other-"));
      fs.writeFileSync(path.join(tmpDir, "default.txt"), "default");
      fs.mkdirSync(path.join(otherDir, "docs"));
      fs.writeFileSync(path.join(otherDir, "selected.txt"), "selected");
      fs.writeFileSync(path.join(otherDir, "docs", "report.md"), "# Report");
    });

    afterEach(() => {
      fs.rmSync(otherDir, { recursive: true, force: true });
    });

    // Mirrors the main-process dep: a known id picks its workspace, anything else the default.
    const depsFor = () =>
      makeDeps({
        getWorkspacePath: (workspaceId) => (workspaceId === "ws-other" ? otherDir : tmpDir),
      });

    it("lists the root of the workspace the id selects", async () => {
      const service = new FileHubService(depsFor());
      const files = await service.listFiles({ source: "local", workspaceId: "ws-other" });

      expect(files.map((f) => f.name).sort()).toEqual(["docs", "selected.txt"]);
      for (const file of files) {
        expect(file.metadata?.workspacePath).toBe(path.resolve(otherDir));
      }
    });

    it("falls back to the default workspace for a missing or unknown id", async () => {
      const service = new FileHubService(depsFor());
      for (const workspaceId of [undefined, "", "ws-unknown"]) {
        const files = await service.listFiles({ source: "local", workspaceId });
        expect(files.map((f) => f.name)).toEqual(["default.txt"]);
      }
    });

    it("checks folder requests against the selected workspace root", async () => {
      const service = new FileHubService(depsFor());

      const inside = await service.listFiles({
        source: "local",
        workspaceId: "ws-other",
        path: path.join(otherDir, "docs"),
      });
      expect(inside.map((f) => f.name)).toEqual(["report.md"]);

      // A folder of another workspace is outside the selected root.
      expect(
        await service.listFiles({ source: "local", workspaceId: "ws-other", path: tmpDir }),
      ).toEqual([]);
      expect(
        await service.listFiles({ source: "local", path: path.join(otherDir, "docs") }),
      ).toEqual([]);
    });

    it("searches the selected workspace", async () => {
      const service = new FileHubService(depsFor());
      const selected = await service.searchFiles("selected", ["local"], "ws-other");
      expect(selected.map((r) => r.file.name)).toEqual(["selected.txt"]);
      expect(await service.searchFiles("selected", ["local"])).toEqual([]);
    });
  });

  // ── Workspace root + folder navigation ───────────────────────

  describe("folder navigation inside the workspace", () => {
    let outsideDir: string;

    beforeEach(() => {
      outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "filehub-outside-"));
      fs.writeFileSync(path.join(outsideDir, "secret.txt"), "outside");
    });

    afterEach(() => {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    });

    it("tags every local entry with the workspace root it was listed under", async () => {
      fs.writeFileSync(path.join(tmpDir, "notes.md"), "# Notes");
      fs.mkdirSync(path.join(tmpDir, "docs"));

      const service = new FileHubService(makeDeps({ getWorkspacePath: () => tmpDir }));
      const files = await service.listFiles({ source: "local" });

      expect(files).toHaveLength(2);
      for (const file of files) {
        expect(file.metadata?.workspacePath).toBe(path.resolve(tmpDir));
      }
    });

    it("lists a subfolder by absolute or workspace-relative path", async () => {
      fs.mkdirSync(path.join(tmpDir, "docs", "drafts"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "docs", "plan.md"), "# Plan");
      fs.writeFileSync(path.join(tmpDir, "top.txt"), "top");

      const service = new FileHubService(makeDeps({ getWorkspacePath: () => tmpDir }));

      const absolute = await service.listFiles({
        source: "local",
        path: path.join(tmpDir, "docs"),
      });
      expect(absolute.map((f) => f.name).sort()).toEqual(["drafts", "plan.md"]);
      const plan = absolute.find((f) => f.name === "plan.md")!;
      expect(plan.path).toBe(path.join(path.resolve(tmpDir), "docs", "plan.md"));
      expect(plan.metadata?.workspacePath).toBe(path.resolve(tmpDir));
      expect(absolute.find((f) => f.name === "drafts")!.isDirectory).toBe(true);

      const relative = await service.listFiles({ source: "local", path: "docs" });
      expect(relative.map((f) => f.name).sort()).toEqual(["drafts", "plan.md"]);
    });

    it("refuses a folder outside the workspace root", async () => {
      const service = new FileHubService(makeDeps({ getWorkspacePath: () => tmpDir }));
      const files = await service.listFiles({ source: "local", path: outsideDir });
      expect(files).toEqual([]);
    });

    it("refuses '..' escapes out of the workspace root", async () => {
      fs.mkdirSync(path.join(tmpDir, "docs"));
      const service = new FileHubService(makeDeps({ getWorkspacePath: () => tmpDir }));

      expect(await service.listFiles({ source: "local", path: path.join(tmpDir, "..") })).toEqual(
        [],
      );
      expect(
        await service.listFiles({
          source: "local",
          path: `${tmpDir}/docs/../../${path.basename(outsideDir)}`,
        }),
      ).toEqual([]);
      expect(await service.listFiles({ source: "local", path: "../" })).toEqual([]);
    });

    it("refuses a symlinked folder that points outside, and leaves it out of listings", async () => {
      fs.writeFileSync(path.join(tmpDir, "inside.txt"), "inside");
      fs.symlinkSync(outsideDir, path.join(tmpDir, "escape"), "dir");
      fs.symlinkSync(path.join(outsideDir, "secret.txt"), path.join(tmpDir, "secret-link.txt"));

      const service = new FileHubService(makeDeps({ getWorkspacePath: () => tmpDir }));

      const root = await service.listFiles({ source: "local" });
      expect(root.map((f) => f.name)).toEqual(["inside.txt"]);

      const escaped = await service.listFiles({
        source: "local",
        path: path.join(tmpDir, "escape"),
      });
      expect(escaped).toEqual([]);
    });

    it("keeps a symlinked folder that stays inside the workspace navigable", async () => {
      fs.mkdirSync(path.join(tmpDir, "real"));
      fs.writeFileSync(path.join(tmpDir, "real", "file.txt"), "hello");
      fs.symlinkSync(path.join(tmpDir, "real"), path.join(tmpDir, "alias"), "dir");

      const service = new FileHubService(makeDeps({ getWorkspacePath: () => tmpDir }));

      const root = await service.listFiles({ source: "local" });
      const alias = root.find((f) => f.name === "alias");
      expect(alias?.isDirectory).toBe(true);

      const inside = await service.listFiles({ source: "local", path: alias!.path });
      expect(inside.map((f) => f.name)).toEqual(["file.txt"]);
      expect(inside[0].metadata?.workspacePath).toBe(path.resolve(tmpDir));
    });

    it("lists nothing when the requested path is a file, missing, or there is no workspace", async () => {
      fs.writeFileSync(path.join(tmpDir, "file.txt"), "hello");

      const service = new FileHubService(makeDeps({ getWorkspacePath: () => tmpDir }));
      expect(
        await service.listFiles({ source: "local", path: path.join(tmpDir, "file.txt") }),
      ).toEqual([]);
      expect(
        await service.listFiles({ source: "local", path: path.join(tmpDir, "missing") }),
      ).toEqual([]);

      // A renderer-supplied path never stands in for a missing workspace root.
      const noWorkspace = new FileHubService(makeDeps({ getWorkspacePath: () => "" }));
      expect(await noWorkspace.listFiles({ source: "local", path: tmpDir })).toEqual([]);
    });
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
