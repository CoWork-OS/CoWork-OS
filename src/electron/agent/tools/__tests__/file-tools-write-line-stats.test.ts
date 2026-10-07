import Database from "better-sqlite3";
import * as fsp from "fs/promises";
/**
 * write_file reports whether it replaced an existing file and the approximate line counts of
 * the change on its file_created event, which the timeline shows as "Edited x.ts +2 −1".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { Workspace } from "../../../../shared/types";
import { FileTools } from "../file-tools";

vi.mock("fs/promises", { spy: true });

type Any = any; // oxlint-disable-line typescript-eslint(no-explicit-any)

describe("FileTools write_file line stats", () => {
  let tmpDir: string;
  let fileTools: FileTools;
  let logEvent: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.mocked(fsp.open).mockReset();
    vi.mocked(fsp.open).mockImplementation(
      (await vi.importActual<typeof import("fs/promises")>("fs/promises")).open,
    );
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-file-line-stats-"));
    const workspace: Workspace = {
      id: "w1",
      name: "Test",
      path: tmpDir,
      createdAt: Date.now(),
      permissions: { read: true, write: true, delete: true, network: false, shell: false },
    };
    logEvent = vi.fn();
    const daemon = {
      logEvent,
      requestApproval: vi.fn().mockResolvedValue(true),
      captureTaskMutationBaseline: vi.fn(),
    } as Any;
    fileTools = new FileTools(workspace, daemon, "task-1");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const fileCreatedPayload = () =>
    logEvent.mock.calls.filter(([, type]) => type === "file_created").at(-1)?.[2];

  it("reports a new file with every line added", async () => {
    await fileTools.writeFile("notes.md", "one\ntwo\nthree\n");

    expect(fileCreatedPayload()).toMatchObject({
      path: "notes.md",
      existed: false,
      linesAdded: 3,
      linesRemoved: 0,
    });
  });

  it("reports an overwrite with the lines it changed", async () => {
    fs.writeFileSync(path.join(tmpDir, "notes.md"), "one\ntwo\nthree\n");

    await fileTools.writeFile("notes.md", "one\nTWO\nthree\nfour\n");

    expect(fileCreatedPayload()).toMatchObject({
      path: "notes.md",
      existed: true,
      linesAdded: 2,
      linesRemoved: 1,
    });
  });
  it("keeps existing content when workspace authority changes while opening the file", async () => {
    const target = path.join(tmpDir, "notes.md");
    fs.writeFileSync(target, "original");
    const open = (await vi.importActual<typeof import("fs/promises")>("fs/promises")).open;
    vi.spyOn(fsp, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      const workspace = (fileTools as Any).workspace;
      fileTools.setWorkspace({
        ...workspace,
        permissions: { ...workspace.permissions, write: false },
      });
      return handle;
    });
    await expect(fileTools.writeFile("notes.md", "replacement")).rejects.toThrow(
      "File authority changed",
    );
    expect(fs.readFileSync(target, "utf-8")).toBe("original");
    expect(fileCreatedPayload()).toBeUndefined();
  });

  it("keeps existing content when a durable stop arrives during opened-file identity checks", async () => {
    const db = new Database(":memory:");
    db.exec(
      "CREATE TABLE tasks(id TEXT PRIMARY KEY,workspace_id TEXT,parent_task_id TEXT,agent_config TEXT);CREATE TABLE bot_task_stop_intents(task_id TEXT PRIMARY KEY,active INTEGER)",
    );
    db.prepare("INSERT INTO tasks VALUES('task-1','w1',NULL,NULL)").run();
    (fileTools as Any).daemon.getDatabase = () => db;
    const target = path.join(tmpDir, "notes.md");
    fs.writeFileSync(target, "original");
    const open = (await vi.importActual<typeof import("fs/promises")>("fs/promises")).open;
    vi.spyOn(fsp, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      const stat = handle.stat.bind(handle);
      vi.spyOn(handle, "stat").mockImplementation(async () => {
        const info = await stat();
        db.prepare("INSERT OR IGNORE INTO bot_task_stop_intents VALUES('task-1',1)").run();
        return info;
      });
      return handle;
    });
    try {
      await expect(fileTools.writeFile("notes.md", "replacement")).rejects.toThrow(
        "persisted stop request",
      );
      expect(fs.readFileSync(target, "utf-8")).toBe("original");
      expect(fileCreatedPayload()).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("fails closed for a governed write without policy storage", async () => {
    (fileTools as Any).daemon.getTaskById = vi.fn().mockResolvedValue({
      agentConfig: { automationRoutineId: "governed" },
    });
    await expect(fileTools.writeFile("notes.md", "replacement")).rejects.toThrow(
      "Responsibility policy storage is unavailable",
    );
    expect(fs.existsSync(path.join(tmpDir, "notes.md"))).toBe(false);
  });
  it("preserves content when the write phase aborts during its final guard", async () => {
    const target = path.join(tmpDir, "notes.md");
    fs.writeFileSync(target, "original");
    const stat = fs.statSync(target);
    const controller = new AbortController();
    let checks = 0;
    await expect(
      (fileTools as Any).writeBoundFile(
        {
          path: target,
          targetRealPath: target,
          targetIdentity: stat,
        },
        "replacement",
        controller.signal,
        async () => {
          if (++checks === 2) controller.abort();
        },
      ),
    ).rejects.toThrow("File write cancelled before effect");
    expect(fs.readFileSync(target, "utf-8")).toBe("original");
  });
});
