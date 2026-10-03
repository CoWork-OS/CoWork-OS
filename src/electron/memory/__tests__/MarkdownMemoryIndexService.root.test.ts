import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseManager } from "../../database/schema";
import {
  MarkdownMemoryIndexService,
  isExcludedMarkdownIndexPath,
  resolveMarkdownIndexRoot,
} from "../MarkdownMemoryIndexService";

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

describe("markdown memory index root and exclusions", () => {
  const cleanups: Array<() => void> = [];
  const previousUserDataDir = process.env.COWORK_USER_DATA_DIR;

  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
  });

  function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-md-index-"));
    process.env.COWORK_USER_DATA_DIR = path.join(dir, "userdata");
    const manager = new DatabaseManager();
    const workspaceDir = path.join(dir, "workspace");
    const kit = path.join(workspaceDir, ".cowork");
    writeFile(path.join(kit, "USER.md"), "# User\n\n- Prefers concise release notes\n");
    writeFile(path.join(kit, "memory", "2026-10-03.md"), "# Daily\n\n- release notes drafted\n");
    writeFile(path.join(kit, ".history", "USER.md.1.md"), "# Snapshot\n\n- release notes old\n");
    writeFile(path.join(kit, "subconscious", "dream.md"), "# Dream\n\n- release notes dream\n");
    writeFile(path.join(kit, "chronicle", "frame.md"), "# Frame\n\n- release notes frame\n");
    writeFile(path.join(kit, "memory", "transcripts", "t.md"), "# T\n\n- release notes t\n");
    writeFile(path.join(kit, "memory", "topics", "memory-1.md"), "# Topic\n\n- release notes\n");
    writeFile(path.join(kit, "scratchpad-task.md"), "# Scratch\n\n- release notes scratch\n");
    writeFile(path.join(workspaceDir, "docs", "guide.md"), "# Guide\n\n- release notes guide\n");
    cleanups.push(() => {
      manager.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const db = manager.getDatabase();
    db.prepare(
      `INSERT INTO workspaces (id, name, path, created_at, permissions) VALUES ('ws', 'Index', ?, ?, '{}')`,
    ).run(workspaceDir, Date.now());
    return { db, workspaceDir, kit };
  }

  async function indexedPaths(service: MarkdownMemoryIndexService): Promise<string[]> {
    const rows = await (service as Any).store.listIndexedFiles("ws");
    return rows.map((row: { path: string }) => row.path).sort();
  }

  it("normalizes the index root to <workspace>/.cowork", () => {
    expect(resolveMarkdownIndexRoot("/w")).toBe(path.join(path.resolve("/w"), ".cowork"));
    expect(resolveMarkdownIndexRoot("/w/.cowork")).toBe(path.resolve("/w/.cowork"));
  });

  it("excludes history, subconscious, chronicle, transcripts, topics and scratchpads", () => {
    for (const excluded of [
      ".history/USER.md.1.md",
      "subconscious/dream.md",
      "chronicle/frame.md",
      "memory/transcripts/t.md",
      "memory/topics/memory-1.md",
      "scratchpad-task.md",
      "projects/a/.history/x.md",
      ".cowork/USER.md",
      "../docs/guide.md",
    ]) {
      expect(isExcludedMarkdownIndexPath(excluded), excluded).toBe(true);
    }
    for (const kept of ["USER.md", "memory/2026-10-03.md", "projects/a/CONTEXT.md"]) {
      expect(isExcludedMarkdownIndexPath(kept), kept).toBe(false);
    }
  });

  it("indexes the same .cowork files whichever root the caller passes", async () => {
    const { db, workspaceDir, kit } = setup();
    const service = new MarkdownMemoryIndexService(db);

    await service.syncWorkspace("ws", workspaceDir, true);
    const fromRoot = await indexedPaths(service);
    expect(fromRoot).toEqual(["USER.md", "memory/2026-10-03.md"]);

    await service.syncWorkspace("ws", kit, true);
    expect(await indexedPaths(service)).toEqual(fromRoot);

    const hits = await service.search("ws", workspaceDir, "release notes", 10);
    expect(hits.map((hit) => (hit as Any).path).sort()).toEqual([
      "USER.md",
      "memory/2026-10-03.md",
    ]);
    service.shutdown();
  });

  it("purges rows indexed before the exclusions and the root normalization", async () => {
    const { db, workspaceDir } = setup();
    const legacy = new MarkdownMemoryIndexService(db);
    const now = Date.now();
    const stale = [".history/old.md", "subconscious/dream.md", ".cowork/USER.md"];
    await (legacy as Any).store.applySync({
      workspaceId: "ws",
      now,
      metadataOnly: [],
      reindex: stale.map((relPath) => ({
        relPath,
        mtime: now,
        size: 10,
        content: "# Old\n\n- release notes stale\n",
        contentHash: `hash-${relPath}`,
      })),
      removedPaths: [],
    });
    expect(await indexedPaths(legacy)).toEqual([...stale].sort());
    // Search filters stale rows even before the purge runs.
    expect(await legacy.search("ws", workspaceDir, "release notes stale", 10)).toEqual([]);
    legacy.shutdown();

    const service = new MarkdownMemoryIndexService(db);
    await service.syncWorkspace("ws", workspaceDir, true);
    expect(await indexedPaths(service)).toEqual(["USER.md", "memory/2026-10-03.md"]);
    service.shutdown();
  });
});
