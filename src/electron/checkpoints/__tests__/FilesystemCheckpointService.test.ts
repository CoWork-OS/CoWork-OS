import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FilesystemCheckpointService } from "../FilesystemCheckpointService";

describe("FilesystemCheckpointService", () => {
  let userDataDir: string;
  let workspacePath: string;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-checkpoints-user-data-"));
    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-checkpoints-workspace-"));
    process.env.COWORK_USER_DATA_DIR = userDataDir;
  });

  afterEach(async () => {
    delete process.env.COWORK_USER_DATA_DIR;
    await fs.rm(userDataDir, { recursive: true, force: true });
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  it("captures a pre-mutation snapshot and restores agent-owned changes", async () => {
    const filePath = path.join(workspacePath, "README.md");
    await fs.writeFile(filePath, "before\n", "utf8");

    const checkpoint = await FilesystemCheckpointService.ensureCheckpoint({
      workspacePath,
      taskId: "task-1",
      reason: "before write_file",
    });
    expect(checkpoint?.sequence).toBe(1);

    await fs.writeFile(filePath, "after\n", "utf8");
    await FilesystemCheckpointService.recordMutation({ workspacePath, checkpoint });

    const diff = await FilesystemCheckpointService.diff(workspacePath, 1);
    expect(diff.entries).toEqual([
      {
        path: "README.md",
        status: "modified",
        kind: "file",
        previousSize: 7,
        currentSize: 6,
        previousMode: 0o644,
        currentMode: 0o644,
      },
    ]);

    const result = await FilesystemCheckpointService.rollback({ workspacePath, sequence: 1 });
    expect(result.restored).toEqual(["README.md"]);
    expect(await fs.readFile(filePath, "utf8")).toBe("before\n");
    expect(result.preRollbackCheckpoint?.reason).toContain("before rollback");
  });

  it("preserves a hand edit unless restoreAll is requested", async () => {
    const filePath = path.join(workspacePath, "notes.txt");
    await fs.writeFile(filePath, "original\n", "utf8");

    const checkpoint = await FilesystemCheckpointService.ensureCheckpoint({
      workspacePath,
      reason: "before agent edit",
    });
    await fs.writeFile(filePath, "agent edit\n", "utf8");
    await FilesystemCheckpointService.recordMutation({ workspacePath, checkpoint });
    await fs.writeFile(filePath, "human edit\n", "utf8");

    const result = await FilesystemCheckpointService.rollback({ workspacePath, sequence: 1 });
    expect(result.restored).toEqual([]);
    expect(result.kept).toEqual(["notes.txt"]);
    expect(await fs.readFile(filePath, "utf8")).toBe("human edit\n");

    const forceResult = await FilesystemCheckpointService.rollback({
      workspacePath,
      sequence: 1,
      restoreAll: true,
    });
    expect(forceResult.restored).toEqual(["notes.txt"]);
    expect(await fs.readFile(filePath, "utf8")).toBe("original\n");
  });

  it("reports added and deleted files and ignores excluded secrets", async () => {
    await fs.writeFile(path.join(workspacePath, "kept.txt"), "kept\n", "utf8");
    await fs.writeFile(path.join(workspacePath, ".env.local"), "SECRET=do-not-store\n", "utf8");
    await fs.writeFile(
      path.join(workspacePath, "notes.txt"),
      "api_key=abcdefghijklmnopqrstuvwxyz\n",
      "utf8",
    );
    const checkpoint = await FilesystemCheckpointService.ensureCheckpoint({
      workspacePath,
      reason: "before shell mutation",
    });

    await fs.rm(path.join(workspacePath, "kept.txt"));
    await fs.writeFile(path.join(workspacePath, "new.txt"), "new\n", "utf8");
    await FilesystemCheckpointService.recordMutation({ workspacePath, checkpoint });

    const diff = await FilesystemCheckpointService.diff(workspacePath, 1);
    expect(diff.entries).toEqual([
      { path: "kept.txt", status: "deleted", kind: "file", previousSize: 5, previousMode: 0o644 },
      { path: "new.txt", status: "added", kind: "file", currentSize: 4, currentMode: 0o644 },
    ]);
    expect(JSON.stringify(await FilesystemCheckpointService.list(workspacePath))).not.toContain(
      "do-not-store",
    );
    expect(diff.entries.some((entry) => entry.path === "notes.txt")).toBe(false);
  });

  it("can restore one file without touching another changed file", async () => {
    const firstPath = path.join(workspacePath, "first.txt");
    const secondPath = path.join(workspacePath, "second.txt");
    await fs.writeFile(firstPath, "first before\n", "utf8");
    await fs.writeFile(secondPath, "second before\n", "utf8");
    const checkpoint = await FilesystemCheckpointService.ensureCheckpoint({
      workspacePath,
      reason: "before two-file edit",
    });

    await fs.writeFile(firstPath, "first after\n", "utf8");
    await fs.writeFile(secondPath, "second after\n", "utf8");
    await FilesystemCheckpointService.recordMutation({ workspacePath, checkpoint });

    const result = await FilesystemCheckpointService.rollback({
      workspacePath,
      sequence: 1,
      paths: ["first.txt"],
    });
    expect(result.restored).toEqual(["first.txt"]);
    expect(await fs.readFile(firstPath, "utf8")).toBe("first before\n");
    expect(await fs.readFile(secondPath, "utf8")).toBe("second after\n");
  });

  it("preserves a hand edit that occurs before a later agent checkpoint", async () => {
    const filePath = path.join(workspacePath, "evolving.txt");
    await fs.writeFile(filePath, "original\n", "utf8");
    const first = await FilesystemCheckpointService.ensureCheckpoint({
      workspacePath,
      reason: "before first edit",
    });
    await fs.writeFile(filePath, "agent one\n", "utf8");
    await FilesystemCheckpointService.recordMutation({ workspacePath, checkpoint: first });

    await fs.writeFile(filePath, "human edit\n", "utf8");
    const second = await FilesystemCheckpointService.ensureCheckpoint({
      workspacePath,
      reason: "before second edit",
    });
    await fs.writeFile(filePath, "agent two\n", "utf8");
    await FilesystemCheckpointService.recordMutation({ workspacePath, checkpoint: second });

    const result = await FilesystemCheckpointService.rollback({ workspacePath, sequence: 1 });
    expect(result.kept).toEqual(["evolving.txt"]);
    expect(await fs.readFile(filePath, "utf8")).toBe("agent two\n");
  });

  it("restores mode changes and removes agent-created empty directories", async () => {
    const filePath = path.join(workspacePath, "mode.txt");
    await fs.writeFile(filePath, "content\n", "utf8");
    const checkpoint = await FilesystemCheckpointService.ensureCheckpoint({
      workspacePath,
      reason: "before metadata mutation",
    });

    await fs.chmod(filePath, 0o600);
    await fs.mkdir(path.join(workspacePath, "empty-dir"));
    await FilesystemCheckpointService.recordMutation({ workspacePath, checkpoint });

    const diff = await FilesystemCheckpointService.diff(workspacePath, 1);
    expect(diff.entries).toEqual([
      {
        path: "empty-dir",
        status: "added",
        kind: "directory",
      },
      {
        path: "mode.txt",
        status: "modified",
        kind: "file",
        previousSize: 8,
        currentSize: 8,
        previousMode: 0o644,
        currentMode: 0o600,
      },
    ]);

    const result = await FilesystemCheckpointService.rollback({ workspacePath, sequence: 1 });
    expect(result.restored).toEqual(["empty-dir", "mode.txt"]);
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o644);
    await expect(fs.stat(path.join(workspacePath, "empty-dir"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("replaces symlinks safely without writing through them", async () => {
    const filePath = path.join(workspacePath, "tracked.txt");
    const outsidePath = path.join(userDataDir, "outside.txt");
    await fs.writeFile(filePath, "tracked\n", "utf8");
    await fs.writeFile(outsidePath, "outside\n", "utf8");
    const checkpoint = await FilesystemCheckpointService.ensureCheckpoint({
      workspacePath,
      reason: "before symlink mutation",
    });

    await fs.unlink(filePath);
    await fs.symlink(outsidePath, filePath);
    await FilesystemCheckpointService.recordMutation({ workspacePath, checkpoint });

    const result = await FilesystemCheckpointService.rollback({ workspacePath, sequence: 1 });
    expect(result.restored).toEqual(["tracked.txt"]);
    expect(await fs.readFile(filePath, "utf8")).toBe("tracked\n");
    expect(await fs.readFile(outsidePath, "utf8")).toBe("outside\n");
  });

  it("refuses to restore through a symlinked parent directory", async () => {
    const nestedDirectory = path.join(workspacePath, "nested");
    const nestedFile = path.join(nestedDirectory, "tracked.txt");
    const outsideDirectory = path.join(userDataDir, "outside-directory");
    await fs.mkdir(nestedDirectory);
    await fs.writeFile(nestedFile, "tracked\n", "utf8");
    const checkpoint = await FilesystemCheckpointService.ensureCheckpoint({
      workspacePath,
      reason: "before parent symlink mutation",
    });

    await fs.rm(nestedDirectory, { recursive: true });
    await fs.mkdir(outsideDirectory);
    await fs.symlink(outsideDirectory, nestedDirectory);
    await FilesystemCheckpointService.recordMutation({ workspacePath, checkpoint });

    await expect(
      FilesystemCheckpointService.rollback({ workspacePath, sequence: checkpoint!.sequence }),
    ).rejects.toThrow("Refusing to traverse symlink");
    await expect(fs.stat(path.join(outsideDirectory, "tracked.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("recovers the checkpoint index after an interrupted metadata write", async () => {
    await fs.writeFile(path.join(workspacePath, "recover.txt"), "recover\n", "utf8");
    await FilesystemCheckpointService.ensureCheckpoint({
      workspacePath,
      reason: "before index corruption",
    });
    const storeRoot = path.join(userDataDir, "filesystem-checkpoints");
    const projects = await fs.readdir(storeRoot, { withFileTypes: true });
    const project = projects.find((entry) => entry.isDirectory() && entry.name !== "blobs");
    expect(project).toBeDefined();
    await fs.writeFile(path.join(storeRoot, project!.name, "index.json"), "{broken", "utf8");

    const checkpoints = await FilesystemCheckpointService.list(workspacePath);
    expect(checkpoints.map((entry) => entry.sequence)).toEqual([1]);
  });

  it("keeps checkpoint retention bounded", async () => {
    const filePath = path.join(workspacePath, "retained.txt");
    await fs.writeFile(filePath, "0\n", "utf8");
    for (let index = 0; index < 55; index += 1) {
      const checkpoint = await FilesystemCheckpointService.ensureCheckpoint({
        workspacePath,
        reason: `before retention mutation ${index}`,
      });
      await fs.writeFile(filePath, `${index + 1}\n`, "utf8");
      await FilesystemCheckpointService.recordMutation({ workspacePath, checkpoint });
    }

    const checkpoints = await FilesystemCheckpointService.list(workspacePath);
    expect(checkpoints.length).toBeLessThanOrEqual(50);
  });
});
