import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/tmp/test-cowork"),
  },
}));

// We test the internal functions by importing the service and exercising it
// through the public API. The service interacts with fs and a database, so
// we use real temp dirs and a minimal mock database.

import { LoreService } from "../LoreService";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeFile(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf-8");
}

function readFile(p: string): string {
  return fs.readFileSync(p, "utf-8");
}

/** Minimal mock that satisfies the Database parameter LoreService expects. */
function createMockDb(rows: any[] = []) {
  return {
    prepare: () => ({
      all: () => rows,
    }),
  } as any;
}

/** Minimal task row used by TaskRepository.findById */
function makeTaskRow(overrides: Record<string, any> = {}) {
  return {
    id: overrides.id ?? "task-1",
    title: overrides.title ?? "Implemented the auth flow",
    workspaceId: overrides.workspaceId ?? "ws-1",
    parentTaskId: overrides.parentTaskId ?? null,
    resultSummary: overrides.resultSummary ?? null,
    agentConfig: overrides.agentConfig ?? null,
    status: "completed",
    ...overrides,
  };
}

function makeWorkspaceRow(id: string, workspacePath: string) {
  return { id, path: workspacePath, name: "test-workspace" };
}

describe("LoreService", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-lore-"));
    // Create .cowork/ so the service recognises the kit directory.
    fs.mkdirSync(path.join(tmpDir, ".cowork"), { recursive: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // ---------------------------------------------------------------------------
  // upsertMarkedSection (exercised through flush)
  // ---------------------------------------------------------------------------

  describe("LORE.md auto-update markers", () => {
    it("creates LORE.md from default template when file does not exist", async () => {
      const db = createMockDb();
      const service = new LoreService(db);

      // Patch repos to return our test data.
      (service as any).taskRepo = {
        findById: () => makeTaskRow({ workspaceId: "ws-1" }),
      };
      (service as any).workspaceRepo = {
        findById: () => makeWorkspaceRow("ws-1", tmpDir),
      };

      // Simulate a task_completed event via the internal method.
      (service as any).ingestTaskCompleted(
        "task-1",
        { resultSummary: "Auth flow done" },
        Date.now(),
      );

      // Flush immediately (bypass debounce).
      await (service as any).flushWorkspace("ws-1");

      const lorePath = path.join(tmpDir, ".cowork", "LORE.md");
      expect(fs.existsSync(lorePath)).toBe(true);

      const content = readFile(lorePath);
      expect(content).toContain("# Shared Lore");
      expect(content).toContain("<!-- cowork:auto:lore:start -->");
      expect(content).toContain("Auth flow done");
      expect(content).toContain("<!-- cowork:auto:lore:end -->");
    });

    it("appends new entries within existing markers", async () => {
      const lorePath = path.join(tmpDir, ".cowork", "LORE.md");
      writeFile(
        lorePath,
        [
          "# Shared Lore",
          "",
          "## Milestones",
          "<!-- cowork:auto:lore:start -->",
          "- [2025-01-01] Old entry — something cool",
          "<!-- cowork:auto:lore:end -->",
          "",
          "## Notes",
          "- keep this",
          "",
        ].join("\n"),
      );

      const db = createMockDb();
      const service = new LoreService(db);
      (service as any).taskRepo = {
        findById: () => makeTaskRow({ workspaceId: "ws-1", title: "Fixed the deploy pipeline" }),
      };
      (service as any).workspaceRepo = {
        findById: () => makeWorkspaceRow("ws-1", tmpDir),
      };

      (service as any).ingestTaskCompleted(
        "task-2",
        { resultSummary: "Pipeline green" },
        Date.now(),
      );
      await (service as any).flushWorkspace("ws-1");

      const content = readFile(lorePath);
      // Old entry preserved
      expect(content).toContain("Old entry — something cool");
      // New entry added
      expect(content).toContain("Fixed the deploy pipeline");
      expect(content).toContain("Pipeline green");
      // Manual section preserved
      expect(content).toContain("## Notes");
      expect(content).toContain("keep this");
    });

    it("removes (none) placeholder when real entries arrive", async () => {
      const lorePath = path.join(tmpDir, ".cowork", "LORE.md");
      writeFile(
        lorePath,
        [
          "# Shared Lore",
          "",
          "## Milestones",
          "<!-- cowork:auto:lore:start -->",
          "- (none)",
          "<!-- cowork:auto:lore:end -->",
          "",
        ].join("\n"),
      );

      const db = createMockDb();
      const service = new LoreService(db);
      (service as any).taskRepo = {
        findById: () => makeTaskRow({ workspaceId: "ws-1" }),
      };
      (service as any).workspaceRepo = {
        findById: () => makeWorkspaceRow("ws-1", tmpDir),
      };

      (service as any).ingestTaskCompleted("task-1", {}, Date.now());
      await (service as any).flushWorkspace("ws-1");

      const content = readFile(lorePath);
      expect(content).not.toContain("- (none)");
      expect(content).toContain("Implemented the auth flow");
    });
  });

  // ---------------------------------------------------------------------------
  // Filtering logic
  // ---------------------------------------------------------------------------

  describe("task filtering", () => {
    it("skips tasks with short titles (< 10 chars)", async () => {
      const db = createMockDb();
      const service = new LoreService(db);
      (service as any).taskRepo = {
        findById: () => makeTaskRow({ workspaceId: "ws-1", title: "Fix bug" }),
      };
      (service as any).workspaceRepo = {
        findById: () => makeWorkspaceRow("ws-1", tmpDir),
      };

      (service as any).ingestTaskCompleted("task-short", {}, Date.now());
      const state = (service as any).stateByWorkspace.get("ws-1");
      expect(state).toBeUndefined();
    });

    it("skips sub-tasks (tasks with parentTaskId)", async () => {
      const db = createMockDb();
      const service = new LoreService(db);
      (service as any).taskRepo = {
        findById: () =>
          makeTaskRow({
            workspaceId: "ws-1",
            parentTaskId: "parent-task",
            title: "A sub-task that is long enough",
          }),
      };
      (service as any).workspaceRepo = {
        findById: () => makeWorkspaceRow("ws-1", tmpDir),
      };

      (service as any).ingestTaskCompleted("task-sub", {}, Date.now());
      const state = (service as any).stateByWorkspace.get("ws-1");
      expect(state).toBeUndefined();
    });

    it("skips public/group gateway tasks", async () => {
      const db = createMockDb();
      const service = new LoreService(db);
      (service as any).taskRepo = {
        findById: () =>
          makeTaskRow({
            workspaceId: "ws-1",
            agentConfig: { gatewayContext: "public" },
            title: "A public task that is long enough",
          }),
      };
      (service as any).workspaceRepo = {
        findById: () => makeWorkspaceRow("ws-1", tmpDir),
      };

      (service as any).ingestTaskCompleted("task-pub", {}, Date.now());
      const state = (service as any).stateByWorkspace.get("ws-1");
      expect(state).toBeUndefined();
    });

    it("deduplicates entries by taskId", async () => {
      const db = createMockDb();
      const service = new LoreService(db);
      (service as any).taskRepo = {
        findById: () => makeTaskRow({ workspaceId: "ws-1" }),
      };
      (service as any).workspaceRepo = {
        findById: () => makeWorkspaceRow("ws-1", tmpDir),
      };

      (service as any).ingestTaskCompleted("task-dup", {}, Date.now());
      (service as any).ingestTaskCompleted("task-dup", {}, Date.now());

      const state = (service as any).stateByWorkspace.get("ws-1");
      expect(state.entries).toHaveLength(1);
    });

    it("skips workspaces without .cowork/ directory", async () => {
      // Remove .cowork/ dir
      fs.rmSync(path.join(tmpDir, ".cowork"), { recursive: true, force: true });

      const db = createMockDb();
      const service = new LoreService(db);
      (service as any).taskRepo = {
        findById: () => makeTaskRow({ workspaceId: "ws-1" }),
      };
      (service as any).workspaceRepo = {
        findById: () => makeWorkspaceRow("ws-1", tmpDir),
      };

      (service as any).ingestTaskCompleted("task-nokit", {}, Date.now());
      const state = (service as any).stateByWorkspace.get("ws-1");
      expect(state).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Entry capping
  // ---------------------------------------------------------------------------

  describe("entry capping", () => {
    it("caps auto entries at MAX_LORE_ENTRIES (40)", async () => {
      // Create a LORE.md with 39 existing entries
      const existingLines = Array.from({ length: 39 }, (_, i) => `- [2025-01-01] Task ${i + 1}`);
      const lorePath = path.join(tmpDir, ".cowork", "LORE.md");
      writeFile(
        lorePath,
        [
          "# Shared Lore",
          "",
          "## Milestones",
          "<!-- cowork:auto:lore:start -->",
          ...existingLines,
          "<!-- cowork:auto:lore:end -->",
          "",
        ].join("\n"),
      );

      const db = createMockDb();
      const service = new LoreService(db);

      // Add 3 new entries (39 + 3 = 42, should be capped to 40)
      (service as any).taskRepo = {
        findById: (id: string) =>
          makeTaskRow({ id, workspaceId: "ws-1", title: `New task entry ${id}` }),
      };
      (service as any).workspaceRepo = {
        findById: () => makeWorkspaceRow("ws-1", tmpDir),
      };

      (service as any).ingestTaskCompleted("new-1", {}, Date.now());
      (service as any).ingestTaskCompleted("new-2", {}, Date.now());
      (service as any).ingestTaskCompleted("new-3", {}, Date.now());
      await (service as any).flushWorkspace("ws-1");

      const content = readFile(lorePath);
      const entryLines = content.split("\n").filter((l: string) => l.startsWith("- ["));
      expect(entryLines.length).toBe(40);
      // Oldest entries should be pruned (Task 1 and Task 2 gone)
      expect(content).not.toContain("Task 1\n");
      expect(content).toContain("New task entry new-3");
    });

    it("deduplicates milestones that already exist in auto section", async () => {
      vi.setSystemTime(new Date("2026-03-01T10:00:00Z"));
      const lorePath = path.join(tmpDir, ".cowork", "LORE.md");
      writeFile(
        lorePath,
        [
          "# Shared Lore",
          "",
          "## Milestones",
          "<!-- cowork:auto:lore:start -->",
          "- [2026-03-01] Implemented the auth flow",
          "<!-- cowork:auto:lore:end -->",
          "",
        ].join("\n"),
      );

      const db = createMockDb();
      const service = new LoreService(db);
      (service as any).taskRepo = {
        findById: () => makeTaskRow({ workspaceId: "ws-1", title: "Implemented the auth flow" }),
      };
      (service as any).workspaceRepo = {
        findById: () => makeWorkspaceRow("ws-1", tmpDir),
      };

      (service as any).ingestTaskCompleted("task-1", {}, Date.now());
      await (service as any).flushWorkspace("ws-1");

      const content = readFile(lorePath);
      const matches = content.match(/- \[2026-03-01\] Implemented the auth flow/g) || [];
      expect(matches).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Debounce
  // ---------------------------------------------------------------------------

  describe("flush debouncing", () => {
    it("debounces writes with 12s interval", async () => {
      const db = createMockDb();
      const service = new LoreService(db);
      (service as any).taskRepo = {
        findById: () => makeTaskRow({ workspaceId: "ws-1" }),
      };
      (service as any).workspaceRepo = {
        findById: () => makeWorkspaceRow("ws-1", tmpDir),
      };

      (service as any).ingestTaskCompleted("task-debounce", {}, Date.now());

      // File should NOT exist yet (flush hasn't fired).
      const lorePath = path.join(tmpDir, ".cowork", "LORE.md");
      expect(fs.existsSync(lorePath)).toBe(false);

      // Advance timers past debounce threshold.
      await vi.advanceTimersByTimeAsync(13_000);

      // Now the file should exist.
      expect(fs.existsSync(lorePath)).toBe(true);
      const content = readFile(lorePath);
      expect(content).toContain("Implemented the auth flow");
    });
  });

  // ---------------------------------------------------------------------------
  // Entry formatting
  // ---------------------------------------------------------------------------

  describe("entry formatting", () => {
    it("formats entries with date stamp, title, and summary", async () => {
      vi.setSystemTime(new Date("2026-03-15T10:00:00Z"));

      const db = createMockDb();
      const service = new LoreService(db);
      (service as any).taskRepo = {
        findById: () =>
          makeTaskRow({
            workspaceId: "ws-1",
            title: "Refactored the payment module",
          }),
      };
      (service as any).workspaceRepo = {
        findById: () => makeWorkspaceRow("ws-1", tmpDir),
      };

      (service as any).ingestTaskCompleted(
        "task-fmt",
        { resultSummary: "Clean separation of concerns" },
        Date.now(),
      );
      await (service as any).flushWorkspace("ws-1");

      const lorePath = path.join(tmpDir, ".cowork", "LORE.md");
      const content = readFile(lorePath);
      expect(content).toContain(
        "[2026-03-15] Refactored the payment module — Clean separation of concerns",
      );
    });

    it("formats entries without summary when resultSummary is empty", async () => {
      const db = createMockDb();
      const service = new LoreService(db);
      (service as any).taskRepo = {
        findById: () =>
          makeTaskRow({
            workspaceId: "ws-1",
            title: "Updated the README file",
          }),
      };
      (service as any).workspaceRepo = {
        findById: () => makeWorkspaceRow("ws-1", tmpDir),
      };

      (service as any).ingestTaskCompleted("task-nosummary", {}, Date.now());
      await (service as any).flushWorkspace("ws-1");

      const lorePath = path.join(tmpDir, ".cowork", "LORE.md");
      const content = readFile(lorePath);
      expect(content).toContain("Updated the README file");
      expect(content).not.toContain(" — ");
    });
  });
});
