import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Task, WorktreeInfo } from "../../../shared/types";
import { GitService } from "../GitService";
import { buildMergeReview, type MergeReviewSources } from "../merge-review";

function worktree(taskId: string, branchName: string, overrides: Partial<WorktreeInfo> = {}) {
  return {
    taskId,
    workspaceId: "ws-1",
    repoPath: "/repo",
    worktreePath: `/repo/.cowork-worktrees/${taskId}`,
    branchName,
    baseBranch: "main",
    baseCommit: "a".repeat(40),
    status: "active",
    createdAt: Number(taskId.replace(/\D/g, "")) || 0,
    ...overrides,
  } as WorktreeInfo;
}

function sources(input: {
  worktrees: WorktreeInfo[];
  tasks: Record<string, Partial<Task>>;
  files: Record<string, string[]>;
  conflicts?: (a: string, b: string) => string[] | null;
}): MergeReviewSources {
  return {
    listWorktrees: async () => input.worktrees,
    getTask: async (taskId) =>
      input.tasks[taskId]
        ? ({ id: taskId, status: "completed", ...input.tasks[taskId] } as Task)
        : undefined,
    diffStats: async (info) => ({
      filesChanged: input.files[info.taskId]?.length ?? 0,
      linesAdded: 3,
      linesRemoved: 1,
    }),
    changedFiles: async (info) => input.files[info.taskId] ?? [],
    latestCheck: async (taskId) =>
      taskId === "t1"
        ? { passed: true }
        : taskId === "t2"
          ? { passed: false, message: "1 failing" }
          : undefined,
    mergeConflicts: async (_repo, a, b) => (input.conflicts ? input.conflicts(a, b) : []),
  };
}

describe("merge review", () => {
  it("groups Compare variants as one intent and checks only across intents", async () => {
    const review = await buildMergeReview(
      "ws-1",
      sources({
        worktrees: [
          worktree("t1", "cowork/v1"),
          worktree("t2", "cowork/v2"),
          worktree("t3", "cowork/footer"),
          worktree("t4", "cowork/done", { status: "merged" }),
        ],
        tasks: {
          t1: { title: "Dashboard", agentConfig: { compareGroupId: "g1", compareVariant: 1 } },
          t2: { title: "Dashboard (b)", agentConfig: { compareGroupId: "g1", compareVariant: 2 } },
          t3: { title: "Fix footer" },
          t4: { title: "Already merged" },
        },
        files: {
          t1: ["src/app.ts", "src/chart.ts"],
          t2: ["src/app.ts"],
          t3: ["src/app.ts", "src/footer.ts"],
        },
        conflicts: (a, b) => (a === "cowork/v1" && b === "cowork/footer" ? ["src/app.ts"] : []),
      }),
    );

    expect(review.groups.map((group) => [group.intent, group.compareGroupId ?? null])).toEqual([
      ["Dashboard", "g1"],
      ["Fix footer", null],
    ]);
    expect(review.groups[0].tasks.map((task) => [task.variant, task.check?.passed])).toEqual([
      [1, true],
      [2, false],
    ]);
    // The two variants both change src/app.ts, but they are alternatives: only the footer fix
    // has to combine with them.
    expect(review.checks.overlaps).toEqual([{ path: "src/app.ts", taskIds: ["t1", "t2", "t3"] }]);
    expect(review.checks.conflicts).toEqual([{ taskIds: ["t1", "t3"], files: ["src/app.ts"] }]);
    expect(review.checks.conflictCheckAvailable).toBe(true);
  });

  it("says when git cannot check conflicts", async () => {
    const review = await buildMergeReview(
      "ws-1",
      sources({
        worktrees: [worktree("t1", "a"), worktree("t3", "b")],
        tasks: { t1: { title: "One" }, t3: { title: "Two" } },
        files: {},
        conflicts: () => null,
      }),
    );
    expect(review.checks.conflictCheckAvailable).toBe(false);
    expect(review.checks.conflicts).toEqual([]);
  });
});

const gitVersion = (() => {
  try {
    const out = execFileSync("git", ["--version"], { encoding: "utf8" });
    const [major, minor] = (/(\d+)\.(\d+)/.exec(out) ?? []).slice(1).map(Number);
    return { major, minor };
  } catch {
    return null;
  }
})();
const mergeTreeSupported =
  gitVersion !== null &&
  (gitVersion.major > 2 || (gitVersion.major === 2 && gitVersion.minor >= 38));

describe.skipIf(!gitVersion)("git helpers for the merge review", () => {
  function repo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-merge-review-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "Test",
          GIT_COMMITTER_EMAIL: "test@example.com",
        },
      }).trim();
    git("init", "-q", "-b", "main");
    fs.writeFileSync(path.join(dir, "app.txt"), "line 1\nline 2\n");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    const write = (branch: string, file: string, content: string) => {
      git("checkout", "-q", "-B", branch, "main");
      fs.writeFileSync(path.join(dir, file), content);
      git("add", ".");
      git("commit", "-q", "-m", branch);
      git("checkout", "-q", "main");
    };
    return { dir, git, write };
  }

  it("resolves a branch to its commit and refuses a short or unknown id", async () => {
    const { dir, git } = repo();
    const head = git("rev-parse", "HEAD");
    expect(await GitService.resolveCommit(dir, { branch: "main" })).toBe(head);
    expect(await GitService.resolveCommit(dir, { commit: head })).toBe(head);
    await expect(GitService.resolveCommit(dir, { commit: head.slice(0, 7) })).rejects.toThrow(
      "40-character",
    );
    await expect(GitService.resolveCommit(dir, { commit: "f".repeat(40) })).rejects.toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(!mergeTreeSupported)("finds files two branches would conflict in", async () => {
    const { dir, write } = repo();
    write("left", "app.txt", "left\nline 2\n");
    write("right", "app.txt", "right\nline 2\n");
    write("other", "notes.txt", "notes\n");
    expect(await GitService.mergeConflicts(dir, "left", "right")).toEqual(["app.txt"]);
    expect(await GitService.mergeConflicts(dir, "left", "other")).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
