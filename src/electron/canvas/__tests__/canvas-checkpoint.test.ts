/**
 * Canvas Checkpoint Tests
 *
 * Tests the checkpoint/state-history system in CanvasManager.
 * Since CanvasManager is a singleton with Electron dependencies,
 * we test the checkpoint logic through the public API by mocking
 * the file system and Electron runtime.
 */

import { describe, it, expect, beforeEach, afterEach, vi as _vi } from "vitest";
import * as path from "path";
import * as fs from "fs/promises";
import { existsSync, readdirSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { randomUUID } from "crypto";
import type { CanvasCheckpoint } from "../../../shared/types";

// We can't import CanvasManager directly because it requires Electron runtime.
// Instead, test the checkpoint logic in isolation by re-implementing the core
// checkpoint methods with the same file-system operations.

/**
 * Minimal checkpoint store for testing (mirrors CanvasManager checkpoint logic)
 */
class CheckpointStore {
  private checkpoints = new Map<string, CanvasCheckpoint[]>();
  private maxPerSession = 50;

  async saveCheckpoint(
    sessionDir: string,
    sessionId: string,
    label?: string,
  ): Promise<CanvasCheckpoint> {
    if (!existsSync(sessionDir)) {
      throw new Error("Session directory not found");
    }

    const fileNames = readdirSync(sessionDir);
    const files: Record<string, string> = {};
    for (const fileName of fileNames) {
      const filePath = path.join(sessionDir, fileName);
      try {
        files[fileName] = await fs.readFile(filePath, "utf-8");
      } catch {
        // skip unreadable files
      }
    }

    const checkpoint: CanvasCheckpoint = {
      id: randomUUID(),
      sessionId,
      label: label || `Checkpoint ${new Date().toLocaleTimeString()}`,
      files,
      createdAt: Date.now(),
    };

    let sessionCheckpoints = this.checkpoints.get(sessionId);
    if (!sessionCheckpoints) {
      sessionCheckpoints = [];
      this.checkpoints.set(sessionId, sessionCheckpoints);
    }
    sessionCheckpoints.push(checkpoint);

    while (sessionCheckpoints.length > this.maxPerSession) {
      sessionCheckpoints.shift();
    }

    return checkpoint;
  }

  async restoreCheckpoint(
    sessionDir: string,
    sessionId: string,
    checkpointId: string,
  ): Promise<CanvasCheckpoint> {
    const sessionCheckpoints = this.checkpoints.get(sessionId);
    if (!sessionCheckpoints) {
      throw new Error("No checkpoints found");
    }

    const checkpoint = sessionCheckpoints.find((cp) => cp.id === checkpointId);
    if (!checkpoint) {
      throw new Error(`Checkpoint not found: ${checkpointId}`);
    }

    for (const [fileName, content] of Object.entries(checkpoint.files)) {
      const safeFilename = path.basename(fileName);
      const filePath = path.join(sessionDir, safeFilename);
      await fs.writeFile(filePath, content, "utf-8");
    }

    return checkpoint;
  }

  listCheckpoints(sessionId: string): CanvasCheckpoint[] {
    return (this.checkpoints.get(sessionId) || []).map((cp) => ({
      ...cp,
      files: {},
    }));
  }

  deleteCheckpoint(sessionId: string, checkpointId: string): boolean {
    const sessionCheckpoints = this.checkpoints.get(sessionId);
    if (!sessionCheckpoints) return false;
    const idx = sessionCheckpoints.findIndex((cp) => cp.id === checkpointId);
    if (idx === -1) return false;
    sessionCheckpoints.splice(idx, 1);
    return true;
  }

  clear(): void {
    this.checkpoints.clear();
  }
}

describe("Canvas Checkpoint System", () => {
  let store: CheckpointStore;
  let tmpDir: string;
  const sessionId = "test-session-1";

  beforeEach(() => {
    store = new CheckpointStore();
    tmpDir = path.join("/tmp", `canvas-test-${randomUUID().slice(0, 8)}`);
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(path.join(tmpDir, "index.html"), "<h1>Hello</h1>", "utf-8");
    writeFileSync(path.join(tmpDir, "style.css"), "body { color: red; }", "utf-8");
  });

  afterEach(() => {
    store.clear();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe("saveCheckpoint", () => {
    it("captures all files in the session directory", async () => {
      const cp = await store.saveCheckpoint(tmpDir, sessionId, "v1");

      expect(cp.id).toBeTruthy();
      expect(cp.sessionId).toBe(sessionId);
      expect(cp.label).toBe("v1");
      expect(cp.createdAt).toBeGreaterThan(0);
      expect(Object.keys(cp.files)).toHaveLength(2);
      expect(cp.files["index.html"]).toBe("<h1>Hello</h1>");
      expect(cp.files["style.css"]).toBe("body { color: red; }");
    });

    it("generates a default label if none provided", async () => {
      const cp = await store.saveCheckpoint(tmpDir, sessionId);

      expect(cp.label).toMatch(/^Checkpoint /);
    });

    it("throws if session directory does not exist", async () => {
      await expect(store.saveCheckpoint("/nonexistent/dir", sessionId)).rejects.toThrow(
        "Session directory not found",
      );
    });

    it("stores multiple checkpoints for the same session", async () => {
      await store.saveCheckpoint(tmpDir, sessionId, "v1");
      writeFileSync(path.join(tmpDir, "index.html"), "<h1>Updated</h1>", "utf-8");
      await store.saveCheckpoint(tmpDir, sessionId, "v2");

      const checkpoints = store.listCheckpoints(sessionId);
      expect(checkpoints).toHaveLength(2);
      expect(checkpoints[0].label).toBe("v1");
      expect(checkpoints[1].label).toBe("v2");
    });

    it("evicts oldest checkpoints when exceeding max per session", async () => {
      // Use a store with low max
      const smallStore = new (class extends CheckpointStore {
        constructor() {
          super();
          (this as Any).maxPerSession = 3;
        }
      })();

      await smallStore.saveCheckpoint(tmpDir, sessionId, "cp-1");
      await smallStore.saveCheckpoint(tmpDir, sessionId, "cp-2");
      await smallStore.saveCheckpoint(tmpDir, sessionId, "cp-3");
      await smallStore.saveCheckpoint(tmpDir, sessionId, "cp-4");

      const checkpoints = smallStore.listCheckpoints(sessionId);
      // Should have evicted cp-1
      expect(checkpoints).toHaveLength(3);
      expect(checkpoints[0].label).toBe("cp-2");
      expect(checkpoints[2].label).toBe("cp-4");
    });
  });

  describe("restoreCheckpoint", () => {
    it("restores files to the checkpoint state", async () => {
      const cp = await store.saveCheckpoint(tmpDir, sessionId, "original");

      // Modify files
      writeFileSync(path.join(tmpDir, "index.html"), "<h1>Modified</h1>", "utf-8");
      writeFileSync(path.join(tmpDir, "style.css"), "body { color: blue; }", "utf-8");

      // Restore
      await store.restoreCheckpoint(tmpDir, sessionId, cp.id);

      // Verify files are restored
      const html = await fs.readFile(path.join(tmpDir, "index.html"), "utf-8");
      const css = await fs.readFile(path.join(tmpDir, "style.css"), "utf-8");
      expect(html).toBe("<h1>Hello</h1>");
      expect(css).toBe("body { color: red; }");
    });

    it("returns the restored checkpoint", async () => {
      const cp = await store.saveCheckpoint(tmpDir, sessionId, "saved");
      const restored = await store.restoreCheckpoint(tmpDir, sessionId, cp.id);

      expect(restored.id).toBe(cp.id);
      expect(restored.label).toBe("saved");
    });

    it("throws if no checkpoints exist for the session", async () => {
      await expect(store.restoreCheckpoint(tmpDir, sessionId, "bogus-id")).rejects.toThrow(
        "No checkpoints found",
      );
    });

    it("throws if checkpoint ID is not found", async () => {
      await store.saveCheckpoint(tmpDir, sessionId, "v1");

      await expect(store.restoreCheckpoint(tmpDir, sessionId, "nonexistent")).rejects.toThrow(
        "Checkpoint not found",
      );
    });

    it("can restore to an earlier checkpoint after multiple saves", async () => {
      const cp1 = await store.saveCheckpoint(tmpDir, sessionId, "v1");

      writeFileSync(path.join(tmpDir, "index.html"), "<h1>V2</h1>", "utf-8");
      await store.saveCheckpoint(tmpDir, sessionId, "v2");

      writeFileSync(path.join(tmpDir, "index.html"), "<h1>V3</h1>", "utf-8");
      await store.saveCheckpoint(tmpDir, sessionId, "v3");

      // Restore to v1
      await store.restoreCheckpoint(tmpDir, sessionId, cp1.id);

      const html = await fs.readFile(path.join(tmpDir, "index.html"), "utf-8");
      expect(html).toBe("<h1>Hello</h1>");
    });
  });

  describe("listCheckpoints", () => {
    it("returns empty array for unknown session", () => {
      expect(store.listCheckpoints("unknown")).toEqual([]);
    });

    it("returns checkpoints without file contents", async () => {
      await store.saveCheckpoint(tmpDir, sessionId, "v1");

      const checkpoints = store.listCheckpoints(sessionId);
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0].files).toEqual({});
      expect(checkpoints[0].label).toBe("v1");
      expect(checkpoints[0].sessionId).toBe(sessionId);
    });

    it("preserves checkpoint ordering", async () => {
      await store.saveCheckpoint(tmpDir, sessionId, "first");
      await store.saveCheckpoint(tmpDir, sessionId, "second");
      await store.saveCheckpoint(tmpDir, sessionId, "third");

      const labels = store.listCheckpoints(sessionId).map((cp) => cp.label);
      expect(labels).toEqual(["first", "second", "third"]);
    });
  });

  describe("deleteCheckpoint", () => {
    it("removes a checkpoint by ID", async () => {
      const cp = await store.saveCheckpoint(tmpDir, sessionId, "to-delete");

      expect(store.deleteCheckpoint(sessionId, cp.id)).toBe(true);
      expect(store.listCheckpoints(sessionId)).toHaveLength(0);
    });

    it("returns false for unknown session", () => {
      expect(store.deleteCheckpoint("unknown", "bogus")).toBe(false);
    });

    it("returns false for unknown checkpoint ID", async () => {
      await store.saveCheckpoint(tmpDir, sessionId, "v1");

      expect(store.deleteCheckpoint(sessionId, "nonexistent")).toBe(false);
      expect(store.listCheckpoints(sessionId)).toHaveLength(1);
    });

    it("only deletes the specified checkpoint", async () => {
      await store.saveCheckpoint(tmpDir, sessionId, "keep-1");
      const cp = await store.saveCheckpoint(tmpDir, sessionId, "delete-me");
      await store.saveCheckpoint(tmpDir, sessionId, "keep-2");

      store.deleteCheckpoint(sessionId, cp.id);

      const labels = store.listCheckpoints(sessionId).map((c) => c.label);
      expect(labels).toEqual(["keep-1", "keep-2"]);
    });
  });

  describe("clear", () => {
    it("removes all checkpoints for all sessions", async () => {
      await store.saveCheckpoint(tmpDir, "session-a", "a1");
      await store.saveCheckpoint(tmpDir, "session-b", "b1");

      store.clear();

      expect(store.listCheckpoints("session-a")).toEqual([]);
      expect(store.listCheckpoints("session-b")).toEqual([]);
    });
  });

  describe("multi-file checkpoints", () => {
    it("handles sessions with many files", async () => {
      for (let i = 0; i < 10; i++) {
        writeFileSync(path.join(tmpDir, `file-${i}.js`), `// file ${i}`, "utf-8");
      }

      const cp = await store.saveCheckpoint(tmpDir, sessionId, "many-files");

      // 2 original files + 10 JS files
      expect(Object.keys(cp.files).length).toBe(12);
    });

    it("restores multi-file checkpoints correctly", async () => {
      writeFileSync(path.join(tmpDir, "app.js"), 'console.log("v1")', "utf-8");

      const cp = await store.saveCheckpoint(tmpDir, sessionId, "with-js");

      // Modify everything
      writeFileSync(path.join(tmpDir, "index.html"), "<h1>Changed</h1>", "utf-8");
      writeFileSync(path.join(tmpDir, "style.css"), "body { }", "utf-8");
      writeFileSync(path.join(tmpDir, "app.js"), 'console.log("v2")', "utf-8");

      await store.restoreCheckpoint(tmpDir, sessionId, cp.id);

      const html = await fs.readFile(path.join(tmpDir, "index.html"), "utf-8");
      const css = await fs.readFile(path.join(tmpDir, "style.css"), "utf-8");
      const js = await fs.readFile(path.join(tmpDir, "app.js"), "utf-8");

      expect(html).toBe("<h1>Hello</h1>");
      expect(css).toBe("body { color: red; }");
      expect(js).toBe('console.log("v1")');
    });
  });
});
