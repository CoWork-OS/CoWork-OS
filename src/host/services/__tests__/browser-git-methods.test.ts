import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitService } from "../../../electron/git/GitService";
import type { Workspace } from "../../../shared/types";
import type {
  BrowserGitMutationIntent,
  BrowserGitMutationReceipts,
} from "../../../shared/host-api/git";
import {
  createBrowserGitMethods,
  type BrowserGitOperations,
  type BrowserGitStatusSummary,
} from "../browser-git-methods";

const execFile = promisify(execFileCallback);
const context = {
  audience: "browser-test",
  identity: {
    installationId: "installation",
    profileId: "profile-default",
    generation: "generation-one",
    runtime: "node" as const,
    platform: "linux" as const,
    appVersion: "test",
  },
  sessionId: "session-one",
};

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function createRepository(): Promise<{ root: string; workspace: Workspace }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-browser-git-"));
  roots.push(root);
  await execFile("git", ["init", "--quiet"], { cwd: root });
  await execFile("git", ["config", "user.name", "Browser Git Test"], { cwd: root });
  await execFile("git", ["config", "user.email", "browser-git@example.test"], { cwd: root });
  await fs.writeFile(path.join(root, "tracked.txt"), "base\n");
  await execFile("git", ["add", "tracked.txt"], { cwd: root });
  await execFile("git", ["commit", "--quiet", "-m", "base"], { cwd: root });
  return { root, workspace: makeWorkspace(root) };
}

function makeWorkspace(root: string, overrides: Partial<Workspace["permissions"]> = {}): Workspace {
  return {
    id: "workspace-one",
    name: "Browser Git test",
    path: root,
    createdAt: 1,
    permissions: {
      read: true,
      write: false,
      delete: false,
      network: false,
      shell: false,
      ...overrides,
    },
  };
}

function createMethods(
  workspace: Workspace,
  options: {
    git?: BrowserGitOperations;
    maxDiffBytes?: number;
    available?: boolean;
    receipts?: BrowserGitMutationReceipts;
    writeAvailable?: boolean;
  } = {},
) {
  return createBrowserGitMethods({
    resolveWorkspace: async () => workspace,
    getCapabilities: async () =>
      options.available === false
        ? {
            "git.read": { available: false, reason: "test disabled" },
            "git.write": { available: false, reason: "test disabled" },
          }
        : {
            "git.read": { available: true },
            "git.write": options.writeAvailable
              ? { available: true }
              : { available: false, reason: "test disabled" },
          },
    receipts: options.receipts,
    git: options.git,
    maxDiffBytes: options.maxDiffBytes,
  });
}

function createReceiptStore(): BrowserGitMutationReceipts {
  const receipts = new Map<
    string,
    {
      fingerprint: string;
      intent: BrowserGitMutationIntent;
      state: "pending" | "completed";
      result?: {
        workspaceId: string;
        action: "stage" | "unstage" | "commit";
        outcome: "applied" | "reconciled";
        revision: string;
        branch: string | null;
        changedFiles: number;
        stagedChanges: number;
        commitSha?: string;
        filesChanged?: number;
      };
    }
  >();
  return {
    reserve: async (key, fingerprint, intent) => {
      const previous = receipts.get(key);
      if (previous) return { created: false, receipt: previous };
      const receipt = { fingerprint, intent, state: "pending" as const };
      receipts.set(key, receipt);
      return { created: true, receipt };
    },
    complete: async (key, result) => {
      const receipt = receipts.get(key);
      if (!receipt) throw new Error("Missing test receipt");
      receipts.set(key, { ...receipt, state: "completed", result });
    },
    get: async (key) => receipts.get(key) ?? null,
  };
}

function invoke(
  methods: ReturnType<typeof createMethods>,
  name: "git.status" | "git.diff",
  params: unknown,
): Promise<unknown> {
  const method = methods[name];
  return Promise.resolve(method.handler(context, method.validateParams!(params)));
}

function invokeMutation(
  methods: ReturnType<typeof createMethods>,
  name: "git.stage" | "git.unstage" | "git.commit",
  params: unknown,
  operationKey: string,
): Promise<unknown> {
  const method = methods[name];
  if (!method) throw new Error(`${name} is unavailable`);
  return Promise.resolve(
    method.handler({ ...context, operationKey }, method.validateParams!(params)),
  );
}

describe("browser Git methods", () => {
  it("reads status before a repository has its first commit", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-browser-git-unborn-"));
    roots.push(root);
    await execFile("git", ["init", "--quiet"], { cwd: root });
    const workspace = makeWorkspace(root);
    const result = (await invoke(createMethods(workspace), "git.status", {
      workspaceId: workspace.id,
    })) as BrowserGitStatusSummary;
    expect(result.isRepository).toBe(true);
    expect(result.clean).toBe(true);
    expect(result.branch).toEqual(expect.any(String));
  });

  it("returns a bounded status summary with authorized relative paths, not host paths", async () => {
    const { root, workspace } = await createRepository();
    await fs.writeFile(path.join(root, "tracked.txt"), "staged\n");
    await execFile("git", ["add", "tracked.txt"], { cwd: root });
    await fs.writeFile(path.join(root, "tracked.txt"), "unstaged\n");
    await fs.writeFile(path.join(root, "untracked.txt"), "new\n");

    const result = (await invoke(createMethods(workspace), "git.status", {
      workspaceId: workspace.id,
    })) as BrowserGitStatusSummary;

    expect(result).toMatchObject({
      workspaceId: workspace.id,
      isRepository: true,
      clean: false,
      changedFiles: 2,
      stagedChanges: 1,
      unstagedChanges: 1,
      untrackedFiles: 1,
      conflictedFiles: 0,
      truncated: false,
    });
    expect(result.branch).toEqual(expect.any(String));
    expect(JSON.stringify(result)).not.toContain(root);
    expect(result.files.map((file) => file.path)).toEqual(["tracked.txt", "untracked.txt"]);
  });

  it("bounds diff bytes and reports whether the returned diff was truncated", async () => {
    const { root, workspace } = await createRepository();
    await fs.writeFile(path.join(root, "tracked.txt"), `${"changed line\n".repeat(200)}`);

    const result = (await invoke(createMethods(workspace, { maxDiffBytes: 512 }), "git.diff", {
      workspaceId: workspace.id,
      relativePath: "tracked.txt",
    })) as {
      workspaceId: string;
      relativePath: string | null;
      staged: boolean;
      diff: string;
      truncated: boolean;
    };

    expect(result).toMatchObject({
      workspaceId: workspace.id,
      relativePath: "tracked.txt",
      staged: false,
      truncated: true,
    });
    expect(Buffer.byteLength(result.diff, "utf8")).toBeLessThanOrEqual(512);
    expect(result.diff).toContain("diff --git a/tracked.txt b/tracked.txt");
    expect(result.diff).not.toContain(root);
  });

  it("denies repository-wide views under a finite filesystem profile but permits an allowed file diff", async () => {
    const { root } = await createRepository();
    await fs.writeFile(path.join(root, "tracked.txt"), "changed\n");
    await fs.writeFile(path.join(root, "private.txt"), "private change\n");
    const workspace = makeWorkspace(root, {
      accessFilesystemScoped: true,
      accessFilesystemRules: [{ path: "private.txt", access: "deny" }],
    });
    const gitGetStatus = vi.fn(GitService.getStatus);
    const gitGetDiff = vi.fn(GitService.getDiff);
    const git: BrowserGitOperations = {
      isGitRepo: (directoryPath) => GitService.isGitRepo(directoryPath),
      getRepoRoot: (directoryPath) => GitService.getRepoRoot(directoryPath),
      getCurrentBranch: (repositoryPath) => GitService.getCurrentBranch(repositoryPath),
      getStatus: gitGetStatus,
      getDiff: gitGetDiff,
    };
    const methods = createMethods(workspace, { git });

    await expect(
      invoke(methods, "git.status", { workspaceId: workspace.id }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      statusCode: 403,
    });
    await expect(invoke(methods, "git.diff", { workspaceId: workspace.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
      statusCode: 403,
    });
    await expect(
      invoke(methods, "git.diff", { workspaceId: workspace.id, relativePath: "private.txt" }),
    ).rejects.toMatchObject({ statusCode: 404 });
    const allowed = (await invoke(methods, "git.diff", {
      workspaceId: workspace.id,
      relativePath: "tracked.txt",
    })) as { diff: string; relativePath: string | null };
    expect(allowed.relativePath).toBe("tracked.txt");
    expect(allowed.diff).toContain("changed");
    expect(allowed.diff).not.toContain("private change");
    expect(gitGetStatus).not.toHaveBeenCalled();
    expect(gitGetDiff).toHaveBeenCalledTimes(1);
    expect(gitGetDiff.mock.calls[0]?.[1]?.file).toBe("tracked.txt");
  });

  it("rejects traversal, symlink aliases, missing capabilities, and non-repository parents", async () => {
    const { root, workspace } = await createRepository();
    const methods = createMethods(workspace);
    for (const relativePath of ["../outside.txt", "/etc/passwd", "C:/secret", "folder\\file"]) {
      expect(() =>
        methods["git.diff"].validateParams!({ workspaceId: workspace.id, relativePath }),
      ).toThrow("Invalid browser Git parameters");
    }

    const outside = path.join(root, "..", `${path.basename(root)}-outside-secret.txt`);
    roots.push(outside);
    await fs.writeFile(outside, "secret\n");
    await fs.symlink(outside, path.join(root, "alias.txt"));
    await expect(
      invoke(methods, "git.diff", { workspaceId: workspace.id, relativePath: "alias.txt" }),
    ).rejects.toMatchObject({ statusCode: 404 });

    const unavailable = createMethods(workspace, { available: false });
    await expect(
      invoke(unavailable, "git.status", { workspaceId: workspace.id }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_CAPABILITY",
    });

    const nestedRoot = path.join(root, "nested-workspace");
    await fs.mkdir(nestedRoot);
    const nestedWorkspace = makeWorkspace(nestedRoot);
    await expect(
      invoke(createMethods(nestedWorkspace), "git.status", { workspaceId: nestedWorkspace.id }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("passes shell-like file names as literal Git pathspecs without shell execution", async () => {
    const { root, workspace } = await createRepository();
    const result = (await invoke(createMethods(workspace), "git.diff", {
      workspaceId: workspace.id,
      relativePath: "$(touch pwned)",
    })) as { diff: string; relativePath: string | null };

    expect(result).toMatchObject({ diff: "", relativePath: "$(touch pwned)" });
    await expect(fs.access(path.join(root, "pwned"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("validates workspace IDs and staged diff options before running Git", () => {
    const methods = createMethods(makeWorkspace("/tmp/workspace"));
    expect(() => methods["git.status"].validateParams!({ workspaceId: "" })).toThrow(
      "Invalid browser Git parameters",
    );
    expect(() => methods["git.diff"].validateParams!({ workspaceId: "id", staged: "yes" })).toThrow(
      "Invalid browser Git parameters",
    );
  });

  it("stages and unstages only selected files, then reconciles an exact replay", async () => {
    const { root, workspace: originalWorkspace } = await createRepository();
    const workspace = makeWorkspace(root, { write: true });
    await fs.writeFile(path.join(root, "tracked.txt"), "changed\n");
    await fs.writeFile(path.join(root, "untracked.txt"), "leave me unstaged\n");
    const methods = createMethods(workspace, {
      receipts: createReceiptStore(),
      writeAvailable: true,
    });
    const initial = (await invoke(methods, "git.status", {
      workspaceId: workspace.id,
    })) as BrowserGitStatusSummary;
    const request = {
      workspaceId: workspace.id,
      expectedRevision: initial.revision,
      relativePaths: ["tracked.txt"],
    };

    const staged = (await invokeMutation(methods, "git.stage", request, "stage-key-0001")) as {
      outcome: string;
      stagedChanges: number;
    };
    expect(staged).toMatchObject({ outcome: "applied", stagedChanges: 1 });
    const stagedNames = await execFile("git", ["diff", "--cached", "--name-only"], { cwd: root });
    expect(stagedNames.stdout.trim()).toBe("tracked.txt");
    const replay = (await invokeMutation(methods, "git.stage", request, "stage-key-0001")) as {
      outcome: string;
    };
    expect(replay.outcome).toBe("reconciled");

    const afterStage = (await invoke(methods, "git.status", {
      workspaceId: workspace.id,
    })) as BrowserGitStatusSummary;
    await invokeMutation(
      methods,
      "git.unstage",
      {
        workspaceId: workspace.id,
        expectedRevision: afterStage.revision,
        relativePaths: ["tracked.txt"],
      },
      "unstage-key-0001",
    );
    const status = await execFile("git", ["status", "--porcelain"], { cwd: root });
    expect(status.stdout).toContain(" M tracked.txt");
    expect(status.stdout).toContain("?? untracked.txt");
    expect(originalWorkspace.permissions.write).toBe(false);
  });

  it("commits only staged changes, skips repository hooks, and replays without a duplicate commit", async () => {
    const { root } = await createRepository();
    const workspace = makeWorkspace(root, { write: true });
    await fs.writeFile(path.join(root, "tracked.txt"), "staged content\n");
    await execFile("git", ["add", "tracked.txt"], { cwd: root });
    await fs.writeFile(path.join(root, "other.txt"), "unstaged content\n");
    const hookMarker = path.join(root, "hook-ran");
    const hook = path.join(root, ".git", "hooks", "pre-commit");
    await fs.writeFile(hook, `#!/bin/sh\ntouch '${hookMarker}'\n`, { mode: 0o755 });
    const methods = createMethods(workspace, {
      receipts: createReceiptStore(),
      writeAvailable: true,
    });
    const initial = (await invoke(methods, "git.status", {
      workspaceId: workspace.id,
    })) as BrowserGitStatusSummary;
    const request = {
      workspaceId: workspace.id,
      expectedRevision: initial.revision,
      message: "browser change",
    };

    const result = (await invokeMutation(methods, "git.commit", request, "commit-key-0001")) as {
      commitSha: string;
      outcome: string;
    };
    expect(result).toMatchObject({ outcome: "applied", commitSha: expect.any(String) });
    const committedFiles = await execFile("git", ["show", "--format=", "--name-only", "HEAD"], {
      cwd: root,
    });
    expect(committedFiles.stdout.trim()).toBe("tracked.txt");
    await expect(fs.access(hookMarker)).rejects.toMatchObject({ code: "ENOENT" });

    const replay = (await invokeMutation(methods, "git.commit", request, "commit-key-0001")) as {
      commitSha: string;
      outcome: string;
    };
    expect(replay).toMatchObject({ outcome: "reconciled", commitSha: result.commitSha });
    const count = await execFile("git", ["rev-list", "--count", "HEAD"], { cwd: root });
    expect(count.stdout.trim()).toBe("2");
    const remaining = await execFile("git", ["status", "--porcelain"], { cwd: root });
    expect(remaining.stdout).toContain("?? other.txt");
  });

  it("rejects stale revisions and workspaces without Git write authority", async () => {
    const { root } = await createRepository();
    const workspace = makeWorkspace(root, { write: true });
    await fs.writeFile(path.join(root, "tracked.txt"), "first\n");
    const methods = createMethods(workspace, {
      receipts: createReceiptStore(),
      writeAvailable: true,
    });
    const initial = (await invoke(methods, "git.status", {
      workspaceId: workspace.id,
    })) as BrowserGitStatusSummary;
    await fs.writeFile(path.join(root, "tracked.txt"), "changed again\n");
    await expect(
      invokeMutation(
        methods,
        "git.stage",
        {
          workspaceId: workspace.id,
          expectedRevision: initial.revision,
          relativePaths: ["tracked.txt"],
        },
        "stale-key-0001",
      ),
    ).rejects.toMatchObject({ code: "STALE_STATE" });

    const readOnly = createMethods(workspace, {
      receipts: createReceiptStore(),
      writeAvailable: false,
    });
    const current = (await invoke(readOnly, "git.status", {
      workspaceId: workspace.id,
    })) as BrowserGitStatusSummary;
    await expect(
      invokeMutation(
        readOnly,
        "git.stage",
        {
          workspaceId: workspace.id,
          expectedRevision: current.revision,
          relativePaths: ["tracked.txt"],
        },
        "forbidden-key-01",
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
  });
});
