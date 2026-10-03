import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findEnclosingName, stripComments } from "../scripts/qa/sqlite-inventory.mjs";
import { DatabaseManager } from "../src/electron/database/schema";
import {
  invalidateTaskRowReads,
  TaskStore,
  WorkspaceStore,
  withTaskRowReadScope,
} from "../src/electron/database/repositories";

const nativeSqliteAvailable = await import("better-sqlite3")
  .then((module) => {
    try {
      const probe = new module.default(":memory:");
      probe.close();
      return true;
    } catch {
      return false;
    }
  })
  .catch(() => false);

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

const TASK_WRITE = /\b(?:UPDATE|INSERT INTO|INSERT OR \w+ INTO|REPLACE INTO|DELETE FROM)\s+tasks\b/;

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.(test|d)\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe("task row read scope invalidation", () => {
  it("invalidates cached task rows in every member that writes to tasks", () => {
    const missing: string[] = [];
    const files = sourceFiles(path.resolve("src"));
    // Statement catalogs (DB6) hold SQL by name; the members that run a task-writing
    // statement are the writers, so each of them must invalidate.
    const catalogTaskWrites = new Set<string>();
    for (const file of files.filter((candidate) => /-statements\.ts$/.test(candidate))) {
      const source = fs.readFileSync(file, "utf8");
      for (const match of source.matchAll(/^\s+(\w+): `([^`]*)`/gm)) {
        if (TASK_WRITE.test(match[2])) catalogTaskWrites.add(match[1]);
      }
    }
    for (const file of files) {
      const relative = path.relative(process.cwd(), file);
      // Schema migrations and maintenance run outside any read scope (post-startup
      // chunks run between awaits or in the worker, never inside a synchronous scope).
      // Deletes of issues, companies, goals, and projects would also change tasks rows
      // through ON DELETE SET NULL; no runtime code issues them today. Heartbeat run
      // pruning clears tasks.heartbeat_run_id itself and invalidates.
      if (relative === path.join("src", "electron", "database", "schema.ts")) continue;
      if (relative === path.join("src", "electron", "database", "post-startup-maintenance.ts")) {
        continue;
      }
      const lines = stripComments(fs.readFileSync(file, "utf8")).split("\n");
      const writers = new Set<string>();
      const invalidators = new Set<string>();
      const isCatalog = /-statements\.ts$/.test(relative);
      lines.forEach((line, index) => {
        if (TASK_WRITE.test(line) && !isCatalog) writers.add(findEnclosingName(lines, index));
        for (const key of catalogTaskWrites) {
          if (line.includes(`"${key}"`)) writers.add(findEnclosingName(lines, index));
        }
        if (line.includes("invalidateTaskRowReads(") && !line.includes("export function")) {
          invalidators.add(findEnclosingName(lines, index));
        }
      });
      for (const member of writers) {
        if (!invalidators.has(member)) missing.push(`${relative}: ${member}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describeWithSqlite("withTaskRowReadScope", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;
  let manager: DatabaseManager;
  let repo: TaskStore;
  let taskId: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-task-row-scope-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;
    manager = new DatabaseManager();
    const db = manager.getDatabase();
    const workspace = new WorkspaceStore(db).create("scope", path.join(tmpDir, "ws"), {
      read: true,
      write: true,
      delete: false,
      network: false,
      shell: false,
    });
    repo = new TaskStore(db);
    taskId = repo.create({
      title: "before",
      prompt: "scope",
      status: "executing",
      workspaceId: workspace.id,
    }).id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    manager.close();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const countTaskSelects = () => {
    const db = manager.getDatabase();
    const prepare = vi.spyOn(db, "prepare");
    return () =>
      prepare.mock.calls.filter(([sql]) => sql === "SELECT * FROM tasks WHERE id = ?").length;
  };

  it("reads a task row once per scope and still returns separate objects", () => {
    const selects = countTaskSelects();
    const [first, second] = withTaskRowReadScope(() => [
      repo.findById(taskId),
      repo.findById(taskId),
    ]);
    expect(selects()).toBe(1);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    first!.title = "mutated by one caller";
    expect(second!.title).toBe("before");
  });

  it("sees writes made inside the scope, including from another repository instance", () => {
    const other = new TaskStore(manager.getDatabase());
    const titles = withTaskRowReadScope(() => {
      const before = repo.findById(taskId)!.title;
      other.update(taskId, { title: "after" });
      return [before, repo.findById(taskId)!.title];
    });
    expect(titles).toEqual(["before", "after"]);
  });

  it("sees raw writes once they invalidate", () => {
    const db = manager.getDatabase();
    const title = withTaskRowReadScope(() => {
      repo.findById(taskId);
      db.prepare("UPDATE tasks SET title = ? WHERE id = ?").run("raw", taskId);
      invalidateTaskRowReads(db);
      return repo.findById(taskId)!.title;
    });
    expect(title).toBe("raw");
  });

  it("caches only inside the outermost scope", () => {
    const selects = countTaskSelects();
    withTaskRowReadScope(() => {
      repo.findById(taskId);
      withTaskRowReadScope(() => repo.findById(taskId));
      repo.findById(taskId);
    });
    expect(selects()).toBe(1);
    repo.findById(taskId);
    repo.findById(taskId);
    expect(selects()).toBe(3);
  });

  it("closes the scope when the callback throws", () => {
    const selects = countTaskSelects();
    expect(() =>
      withTaskRowReadScope(() => {
        repo.findById(taskId);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    repo.findById(taskId);
    expect(selects()).toBe(2);
  });
});
