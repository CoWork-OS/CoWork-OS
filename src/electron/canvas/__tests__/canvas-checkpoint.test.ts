/** Real CanvasManager checkpoint tests with temporary files and no Electron windows. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { CanvasSession } from "../../../shared/types";

vi.mock("electron", () => {
  throw new Error("Cannot find module 'electron'");
});

import { CanvasManager } from "../canvas-manager";

type ManagerState = {
  sessions: Map<string, CanvasSession>;
  maxCheckpointsPerSession: number;
  persistSessions(): Promise<void>;
};

describe("Canvas Checkpoint System", () => {
  let store: CanvasManager;
  let state: ManagerState;
  let tmpDir: string;
  const sessionId = "test-session-1";

  beforeEach(async () => {
    store = CanvasManager.getInstance();
    await store.cleanup();
    // Checkpoint restore persists session metadata; tests must never write the user's store.
    state = store as unknown as ManagerState;
    vi.spyOn(state, "persistSessions").mockResolvedValue(undefined);
    state.maxCheckpointsPerSession = 50;
    tmpDir = mkdtempSync(path.join(tmpdir(), "canvas-test-"));
    writeFileSync(path.join(tmpDir, "index.html"), "<h1>Hello</h1>", "utf-8");
    writeFileSync(path.join(tmpDir, "style.css"), "body { color: red; }", "utf-8");
    for (const id of [sessionId, "session-a", "session-b"]) {
      state.sessions.set(id, {
        id,
        taskId: `task-${id}`,
        workspaceId: "test-workspace",
        sessionDir: tmpDir,
        status: "active",
        createdAt: Date.now(),
        lastUpdatedAt: Date.now(),
      });
    }
  });

  afterEach(async () => {
    await store.cleanup();
    store.setEventCallback(() => {});
    state.maxCheckpointsPerSession = 50;
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("saveCheckpoint", () => {
    it("rejects a missing session before accessing any files", async () => {
      await expect(store.saveCheckpoint("unknown")).rejects.toThrow("Canvas session not found");
    });

    it("skips subdirectories and files above the checkpoint size limit", async () => {
      mkdirSync(path.join(tmpDir, "assets"));
      writeFileSync(path.join(tmpDir, "large.txt"), Buffer.alloc(5 * 1024 * 1024 + 1));

      const checkpoint = await store.saveCheckpoint(sessionId, "bounded");

      expect(Object.keys(checkpoint.files).sort()).toEqual(["index.html", "style.css"]);
    });

    it("captures all files in the session directory", async () => {
      const cp = await store.saveCheckpoint(sessionId, "v1");

      expect(cp.id).toBeTruthy();
      expect(cp.sessionId).toBe(sessionId);
      expect(cp.label).toBe("v1");
      expect(cp.createdAt).toBeGreaterThan(0);
      expect(Object.keys(cp.files)).toHaveLength(2);
      expect(cp.files["index.html"]).toBe("<h1>Hello</h1>");
      expect(cp.files["style.css"]).toBe("body { color: red; }");
    });

    it("generates a default label if none provided", async () => {
      const cp = await store.saveCheckpoint(sessionId);

      expect(cp.label).toMatch(/^Checkpoint /);
    });

    it("throws if session directory does not exist", async () => {
      state.sessions.get(sessionId)!.sessionDir = path.join(tmpDir, "missing");
      await expect(store.saveCheckpoint(sessionId)).rejects.toThrow(
        "Canvas session directory not found",
      );
    });

    it("stores multiple checkpoints for the same session", async () => {
      await store.saveCheckpoint(sessionId, "v1");
      writeFileSync(path.join(tmpDir, "index.html"), "<h1>Updated</h1>", "utf-8");
      await store.saveCheckpoint(sessionId, "v2");

      const checkpoints = store.listCheckpoints(sessionId);
      expect(checkpoints).toHaveLength(2);
      expect(checkpoints[0].label).toBe("v1");
      expect(checkpoints[1].label).toBe("v2");
    });

    it("evicts oldest checkpoints when exceeding max per session", async () => {
      state.maxCheckpointsPerSession = 3;
      await store.saveCheckpoint(sessionId, "cp-1");
      await store.saveCheckpoint(sessionId, "cp-2");
      await store.saveCheckpoint(sessionId, "cp-3");
      await store.saveCheckpoint(sessionId, "cp-4");

      const checkpoints = store.listCheckpoints(sessionId);
      // Should have evicted cp-1
      expect(checkpoints).toHaveLength(3);
      expect(checkpoints[0].label).toBe("cp-2");
      expect(checkpoints[2].label).toBe("cp-4");
    });
  });

  describe("restoreCheckpoint", () => {
    it("rejects a deleted session directory instead of recreating it", async () => {
      const checkpoint = await store.saveCheckpoint(sessionId, "saved");
      rmSync(tmpDir, { recursive: true });

      await expect(store.restoreCheckpoint(sessionId, checkpoint.id)).rejects.toThrow(
        "session directory was deleted",
      );
    });

    it("restores HTML mode and emits checkpoint and session updates", async () => {
      const checkpoint = await store.saveCheckpoint(sessionId, "saved");
      const session = state.sessions.get(sessionId)!;
      session.mode = "browser";
      session.url = "https://example.com";
      const onEvent = vi.fn();
      store.setEventCallback(onEvent);

      await store.restoreCheckpoint(sessionId, checkpoint.id);

      expect(session.mode).toBe("html");
      expect(session.url).toBeUndefined();
      expect(onEvent.mock.calls.map(([event]) => event.type)).toEqual([
        "checkpoint_restored",
        "session_updated",
      ]);
      expect(onEvent.mock.calls[0][0]).toMatchObject({
        sessionId,
        checkpoint: { id: checkpoint.id, label: "saved" },
      });
    });

    it("restores files to the checkpoint state", async () => {
      const cp = await store.saveCheckpoint(sessionId, "original");

      // Modify files
      writeFileSync(path.join(tmpDir, "index.html"), "<h1>Modified</h1>", "utf-8");
      writeFileSync(path.join(tmpDir, "style.css"), "body { color: blue; }", "utf-8");

      // Restore
      await store.restoreCheckpoint(sessionId, cp.id);

      // Verify files are restored
      const html = await fs.readFile(path.join(tmpDir, "index.html"), "utf-8");
      const css = await fs.readFile(path.join(tmpDir, "style.css"), "utf-8");
      expect(html).toBe("<h1>Hello</h1>");
      expect(css).toBe("body { color: red; }");
    });

    it("returns the restored checkpoint", async () => {
      const cp = await store.saveCheckpoint(sessionId, "saved");
      const restored = await store.restoreCheckpoint(sessionId, cp.id);

      expect(restored.id).toBe(cp.id);
      expect(restored.label).toBe("saved");
    });

    it("throws if no checkpoints exist for the session", async () => {
      await expect(store.restoreCheckpoint(sessionId, "bogus-id")).rejects.toThrow(
        "No checkpoints found",
      );
    });

    it("throws if checkpoint ID is not found", async () => {
      await store.saveCheckpoint(sessionId, "v1");

      await expect(store.restoreCheckpoint(sessionId, "nonexistent")).rejects.toThrow(
        "Checkpoint not found",
      );
    });

    it("can restore to an earlier checkpoint after multiple saves", async () => {
      const cp1 = await store.saveCheckpoint(sessionId, "v1");

      writeFileSync(path.join(tmpDir, "index.html"), "<h1>V2</h1>", "utf-8");
      await store.saveCheckpoint(sessionId, "v2");

      writeFileSync(path.join(tmpDir, "index.html"), "<h1>V3</h1>", "utf-8");
      await store.saveCheckpoint(sessionId, "v3");

      // Restore to v1
      await store.restoreCheckpoint(sessionId, cp1.id);

      const html = await fs.readFile(path.join(tmpDir, "index.html"), "utf-8");
      expect(html).toBe("<h1>Hello</h1>");
    });
  });

  describe("listCheckpoints", () => {
    it("returns empty array for unknown session", () => {
      expect(store.listCheckpoints("unknown")).toEqual([]);
    });

    it("returns checkpoints without file contents", async () => {
      await store.saveCheckpoint(sessionId, "v1");

      const checkpoints = store.listCheckpoints(sessionId);
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0].files).toEqual({});
      expect(checkpoints[0].label).toBe("v1");
      expect(checkpoints[0].sessionId).toBe(sessionId);
    });

    it("preserves checkpoint ordering", async () => {
      await store.saveCheckpoint(sessionId, "first");
      await store.saveCheckpoint(sessionId, "second");
      await store.saveCheckpoint(sessionId, "third");

      const labels = store.listCheckpoints(sessionId).map((cp) => cp.label);
      expect(labels).toEqual(["first", "second", "third"]);
    });
  });

  describe("deleteCheckpoint", () => {
    it("removes a checkpoint by ID", async () => {
      const cp = await store.saveCheckpoint(sessionId, "to-delete");

      expect(store.deleteCheckpoint(sessionId, cp.id)).toBe(true);
      expect(store.listCheckpoints(sessionId)).toHaveLength(0);
    });

    it("returns false for unknown session", () => {
      expect(store.deleteCheckpoint("unknown", "bogus")).toBe(false);
    });

    it("returns false for unknown checkpoint ID", async () => {
      await store.saveCheckpoint(sessionId, "v1");

      expect(store.deleteCheckpoint(sessionId, "nonexistent")).toBe(false);
      expect(store.listCheckpoints(sessionId)).toHaveLength(1);
    });

    it("only deletes the specified checkpoint", async () => {
      await store.saveCheckpoint(sessionId, "keep-1");
      const cp = await store.saveCheckpoint(sessionId, "delete-me");
      await store.saveCheckpoint(sessionId, "keep-2");

      store.deleteCheckpoint(sessionId, cp.id);

      const labels = store.listCheckpoints(sessionId).map((c) => c.label);
      expect(labels).toEqual(["keep-1", "keep-2"]);
    });
  });

  describe("cleanup", () => {
    it("removes all checkpoints for all sessions", async () => {
      await store.saveCheckpoint("session-a", "a1");
      await store.saveCheckpoint("session-b", "b1");

      await store.cleanup();

      expect(store.listCheckpoints("session-a")).toEqual([]);
      expect(store.listCheckpoints("session-b")).toEqual([]);
    });
  });

  describe("multi-file checkpoints", () => {
    it("handles sessions with many files", async () => {
      for (let i = 0; i < 10; i++) {
        writeFileSync(path.join(tmpDir, `file-${i}.js`), `// file ${i}`, "utf-8");
      }

      const cp = await store.saveCheckpoint(sessionId, "many-files");

      // 2 original files + 10 JS files
      expect(Object.keys(cp.files).length).toBe(12);
    });

    it("restores multi-file checkpoints correctly", async () => {
      writeFileSync(path.join(tmpDir, "app.js"), 'console.log("v1")', "utf-8");

      const cp = await store.saveCheckpoint(sessionId, "with-js");

      // Modify everything
      writeFileSync(path.join(tmpDir, "index.html"), "<h1>Changed</h1>", "utf-8");
      writeFileSync(path.join(tmpDir, "style.css"), "body { }", "utf-8");
      writeFileSync(path.join(tmpDir, "app.js"), 'console.log("v2")', "utf-8");

      await store.restoreCheckpoint(sessionId, cp.id);

      const html = await fs.readFile(path.join(tmpDir, "index.html"), "utf-8");
      const css = await fs.readFile(path.join(tmpDir, "style.css"), "utf-8");
      const js = await fs.readFile(path.join(tmpDir, "app.js"), "utf-8");

      expect(html).toBe("<h1>Hello</h1>");
      expect(css).toBe("body { color: red; }");
      expect(js).toBe('console.log("v1")');
    });
  });

  it("compares saved file states and finds a named build phase checkpoint", async () => {
    const concept = await store.saveCheckpoint(sessionId, "Phase 1 — Concept");
    writeFileSync(path.join(tmpDir, "index.html"), "<h1>Scaffold</h1>");
    rmSync(path.join(tmpDir, "style.css"));
    writeFileSync(path.join(tmpDir, "app.js"), "console.log('ready')");
    const scaffold = await store.saveCheckpoint(sessionId, "Phase 3 — Scaffold");

    expect(store.diffCheckpoints(sessionId, concept.id, scaffold.id)).toEqual({
      added: ["app.js"],
      removed: ["style.css"],
      modified: ["index.html"],
    });
    expect(store.findCheckpointByLabel(sessionId, "Phase 1 — Concept")).toEqual(concept);
    expect(store.findCheckpointByLabel(sessionId, "missing")).toBeUndefined();
    expect(store.diffCheckpoints(sessionId, "missing", scaffold.id)).toBeNull();
    expect(store.diffCheckpoints("unknown", concept.id, scaffold.id)).toBeNull();
  });
});
