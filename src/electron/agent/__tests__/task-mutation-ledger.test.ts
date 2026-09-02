import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { TaskMutationLedger } from "../task-mutation-ledger";

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("TaskMutationLedger", () => {
  it("recomputes task impact from the per-file baseline and ignores unrelated dirty files", async () => {
    const workspace = temporaryDirectory("cowork-mutation-workspace-");
    const storageRoot = temporaryDirectory("cowork-mutation-ledger-");
    const target = path.join(workspace, "target.ts");
    const preExistingDirty = path.join(workspace, "already-dirty.ts");
    fs.writeFileSync(target, "one\ntwo\n", "utf8");
    fs.writeFileSync(preExistingDirty, "dirty before task\n", "utf8");
    const ledger = new TaskMutationLedger({ storageRoot, now: () => 10 });

    await ledger.captureBaseline("task-1", workspace, target);
    fs.writeFileSync(target, "one\nchanged\nthree\n", "utf8");
    let metrics = await ledger.recordMutation({
      taskId: "task-1",
      workspaceRoot: workspace,
      candidatePaths: [target],
      sourceEventId: "file-event-1",
    });

    expect(metrics.find((metric) => metric.kind === "files_changed")?.value).toBe(1);
    expect(metrics.find((metric) => metric.kind === "lines_added")?.value).toBe(2);
    expect(metrics.find((metric) => metric.kind === "lines_removed")?.value).toBe(1);

    fs.writeFileSync(target, "one\ntwo\n", "utf8");
    metrics = await ledger.recordMutation({
      taskId: "task-1",
      workspaceRoot: workspace,
      candidatePaths: [target],
      sourceEventId: "file-event-2",
    });
    expect(metrics.find((metric) => metric.kind === "files_changed")?.value).toBe(0);
    expect(metrics.find((metric) => metric.kind === "lines_added")?.value).toBe(0);
    expect(metrics.find((metric) => metric.kind === "lines_removed")?.value).toBe(0);
  });

  it("counts binary files without inventing line totals", async () => {
    const workspace = temporaryDirectory("cowork-mutation-binary-");
    const storageRoot = temporaryDirectory("cowork-mutation-ledger-");
    const target = path.join(workspace, "image.bin");
    fs.writeFileSync(target, Buffer.from([0, 1, 2]));
    const ledger = new TaskMutationLedger({ storageRoot });
    await ledger.captureBaseline("task-binary", workspace, target);
    fs.writeFileSync(target, Buffer.from([0, 1, 2, 3]));

    const metrics = await ledger.recordMutation({
      taskId: "task-binary",
      workspaceRoot: workspace,
      candidatePaths: [target],
      sourceEventId: "binary-event",
    });
    expect(metrics.find((metric) => metric.kind === "files_changed")?.value).toBe(1);
    expect(metrics.find((metric) => metric.kind === "lines_added")?.value).toBe(0);
    expect(metrics.find((metric) => metric.kind === "lines_removed")?.value).toBe(0);
  });

  it("omits line metrics when attribution was not captured", async () => {
    const workspace = temporaryDirectory("cowork-mutation-incomplete-");
    const storageRoot = temporaryDirectory("cowork-mutation-ledger-");
    const target = path.join(workspace, "uncaptured.txt");
    fs.writeFileSync(target, "written without baseline\n", "utf8");
    const ledger = new TaskMutationLedger({ storageRoot });

    const metrics = await ledger.recordMutation({
      taskId: "task-incomplete",
      workspaceRoot: workspace,
      candidatePaths: [target],
      sourceEventId: "uncaptured-event",
    });
    expect(metrics.find((metric) => metric.kind === "files_changed")?.value).toBe(1);
    expect(metrics.some((metric) => metric.kind === "lines_added")).toBe(false);
    expect(metrics.some((metric) => metric.kind === "lines_removed")).toBe(false);
  });

  it("does not count a deleted directory as a changed file", async () => {
    const workspace = temporaryDirectory("cowork-mutation-directory-");
    const storageRoot = temporaryDirectory("cowork-mutation-ledger-");
    const target = path.join(workspace, "folder");
    fs.mkdirSync(target);
    const ledger = new TaskMutationLedger({ storageRoot });
    await ledger.captureBaseline("task-directory", workspace, target);
    fs.rmdirSync(target);

    const metrics = await ledger.recordMutation({
      taskId: "task-directory",
      workspaceRoot: workspace,
      candidatePaths: [target],
      sourceEventId: "directory-event",
    });
    expect(metrics.find((metric) => metric.kind === "files_changed")?.value).toBe(0);
  });

  it("attributes tracked and untracked shell edits to an isolated worktree baseline", async () => {
    const workspace = temporaryDirectory("cowork-mutation-worktree-");
    const storageRoot = temporaryDirectory("cowork-mutation-ledger-");
    const tracked = path.join(workspace, "tracked.txt");
    fs.writeFileSync(tracked, "one\n", "utf8");
    execFileSync("git", ["-C", workspace, "init", "-b", "main"]);
    execFileSync("git", ["-C", workspace, "add", "tracked.txt"]);
    execFileSync("git", [
      "-C",
      workspace,
      "-c",
      "user.name=CoWork Test",
      "-c",
      "user.email=test@localhost",
      "commit",
      "-m",
      "baseline",
    ]);

    const ledger = new TaskMutationLedger({ storageRoot });
    await ledger.initializeTask("task-worktree", workspace, { isolatedWorktree: true });
    fs.writeFileSync(tracked, "one\ntwo\n", "utf8");
    fs.writeFileSync(path.join(workspace, "untracked.txt"), "new\nfile\n", "utf8");

    const metrics = await ledger.recordMutation({
      taskId: "task-worktree",
      workspaceRoot: workspace,
      candidatePaths: [],
      sourceEventId: "terminal-event",
      final: true,
    });
    expect(metrics.find((metric) => metric.kind === "files_changed")?.value).toBe(2);
    expect(metrics.find((metric) => metric.kind === "lines_added")?.value).toBe(3);
    expect(metrics.find((metric) => metric.kind === "lines_removed")?.value).toBe(0);
    expect(metrics.every((metric) => metric.status === "final")).toBe(true);
  });
});
