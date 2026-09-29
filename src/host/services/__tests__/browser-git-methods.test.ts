import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitService } from "../../../electron/git/GitService";
import type { Workspace } from "../../../shared/types";
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
  } = {},
) {
  return createBrowserGitMethods({
    resolveWorkspace: async () => workspace,
    getCapabilities: async () =>
      options.available === false
        ? { "git.read": { available: false, reason: "test disabled" } }
        : { "git.read": { available: true } },
    git: options.git,
    maxDiffBytes: options.maxDiffBytes,
  });
}

function invoke(
  methods: ReturnType<typeof createMethods>,
  name: "git.status" | "git.diff",
  params: unknown,
): Promise<unknown> {
  const method = methods[name];
  return Promise.resolve(method.handler(context, method.validateParams!(params)));
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

  it("returns a bounded status summary without file names or host paths", async () => {
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
    expect(JSON.stringify(result)).not.toContain("tracked.txt");
    expect(JSON.stringify(result)).not.toContain("untracked.txt");
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
});
