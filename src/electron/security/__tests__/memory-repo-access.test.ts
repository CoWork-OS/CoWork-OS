/**
 * The memory repo as an app-owned root (docs/memory-repo-phase1-design.md §6.4): writes are a
 * hard `protected_path` boundary everywhere under it, reads need the task's memory repo
 * scope, and grep/glob accept it as a search root under the same rule.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: vi.fn().mockReturnValue("/mock/user/data") },
}));

import {
  evaluateWorkspaceFilesystemAccess,
  resolveWorkspaceFilesystemAccessWithApproval,
} from "../access-profile-paths";
import {
  getMemoryRepoRoot,
  getTeamMemoryRepoRoots,
  isMemoryRepoReadAllowed,
  runWithMemoryRepoAccess,
  setMemoryRepoRoot,
  setTeamMemoryRepoRoots,
} from "../memory-repo-access";
import { GrepTools } from "../../agent/tools/grep-tools";
import { GlobTools } from "../../agent/tools/glob-tools";
import { FileTools } from "../../agent/tools/file-tools";
import type { Workspace } from "../../../shared/types";

const cleanup: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

function makeWorkspace(workspacePath: string, overrides: Partial<Workspace["permissions"]> = {}) {
  return {
    id: "ws-1",
    name: "Workspace",
    path: workspacePath,
    permissions: {
      read: true,
      write: true,
      delete: true,
      shell: false,
      network: false,
      unrestrictedFileAccess: false,
      allowedPaths: [],
      ...overrides,
    },
    createdAt: Date.now(),
  } as Workspace;
}

const allowed = <T>(fn: () => T): T => runWithMemoryRepoAccess({ readAllowed: true }, fn);
const refused = <T>(fn: () => T): T => runWithMemoryRepoAccess({ readAllowed: false }, fn);

describe("memory repo filesystem boundary", () => {
  let repo: string;
  let workspace: Workspace;

  beforeEach(() => {
    repo = tempDir("cowork-memory-repo-");
    fs.mkdirSync(path.join(repo, ".git", "hooks"), { recursive: true });
    fs.mkdirSync(path.join(repo, "workspaces"));
    fs.writeFileSync(path.join(repo, "MEMORY.md"), "# Memory\n\n- Deploys go through staging\n");
    fs.writeFileSync(path.join(repo, "workspaces", "app.md"), "# App\n\n- Uses pnpm\n");
    fs.writeFileSync(path.join(repo, ".git", "config"), "[core]\n");
    setMemoryRepoRoot(repo);
    workspace = makeWorkspace(tempDir("cowork-memory-ws-"));
  });

  afterEach(() => {
    setMemoryRepoRoot(null);
    while (cleanup.length > 0) {
      const target = cleanup.pop();
      if (target) fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it("registers and clears the root", () => {
    expect(getMemoryRepoRoot()).toBe(path.resolve(repo));
    setMemoryRepoRoot(null);
    expect(getMemoryRepoRoot()).toBeNull();
    // Without a registered root the path is an ordinary outside path again.
    expect(
      evaluateWorkspaceFilesystemAccess(workspace, path.join(repo, "MEMORY.md"), "read"),
    ).toMatchObject({ decision: "deny", reason: "outside_workspace" });
  });

  it("reads only inside a task scope whose memory repo layer is on", () => {
    const file = path.join(repo, "MEMORY.md");
    expect(isMemoryRepoReadAllowed()).toBe(false);
    expect(evaluateWorkspaceFilesystemAccess(workspace, file, "read")).toMatchObject({
      decision: "deny",
      reason: "memory_repo_unavailable",
    });
    expect(refused(() => evaluateWorkspaceFilesystemAccess(workspace, file, "read"))).toMatchObject(
      { decision: "deny", reason: "memory_repo_unavailable" },
    );
    expect(allowed(() => evaluateWorkspaceFilesystemAccess(workspace, file, "read"))).toMatchObject(
      {
        decision: "allow",
        reason: "memory_repo_read",
      },
    );
    expect(allowed(() => evaluateWorkspaceFilesystemAccess(workspace, repo, "read")).decision).toBe(
      "allow",
    );
  });

  it("lets a swarm-only scope read its own swarm folder and nothing else (phase 5 §2)", () => {
    const swarm = path.join(repo, "swarms", "goal-a1b2c3d4");
    fs.mkdirSync(swarm, { recursive: true });
    fs.mkdirSync(path.join(repo, "swarms", "other-ffffffff"), { recursive: true });
    fs.writeFileSync(path.join(swarm, "findings.md"), "# Findings\n");
    fs.writeFileSync(path.join(repo, "swarms", "other-ffffffff", "findings.md"), "# Findings\n");
    // A symlink inside the swarm folder must not reach the rest of the repo.
    fs.symlinkSync(path.join(repo, "MEMORY.md"), path.join(swarm, "leak.md"));
    const swarmOnly = <T>(fn: () => T): T =>
      runWithMemoryRepoAccess({ readAllowed: false, swarmPrefix: "swarms/goal-a1b2c3d4" }, fn);
    const read = (target: string) =>
      swarmOnly(() => evaluateWorkspaceFilesystemAccess(workspace, target, "read"));
    expect(read(path.join(swarm, "findings.md"))).toMatchObject({
      decision: "allow",
      reason: "memory_repo_read",
    });
    expect(read(swarm).decision).toBe("allow");
    for (const target of [
      path.join(repo, "MEMORY.md"),
      path.join(repo, "swarms"),
      path.join(repo, "swarms", "other-ffffffff", "findings.md"),
      path.join(swarm, "..", "..", "MEMORY.md"),
      path.join(swarm, "leak.md"),
    ]) {
      expect(read(target)).toMatchObject({ decision: "deny", reason: "memory_repo_unavailable" });
    }
    expect(
      swarmOnly(() => evaluateWorkspaceFilesystemAccess(workspace, path.join(swarm, "findings.md"), "write")),
    ).toMatchObject({ decision: "deny", reason: "protected_path" });
    // A malformed prefix is ignored.
    expect(
      runWithMemoryRepoAccess({ readAllowed: false, swarmPrefix: "swarms/../" }, () =>
        evaluateWorkspaceFilesystemAccess(workspace, path.join(repo, "MEMORY.md"), "read"),
      ),
    ).toMatchObject({ decision: "deny" });
  });

  it("never offers an approval for a refused read", async () => {
    const request = vi.fn(async () => true);
    const result = await resolveWorkspaceFilesystemAccessWithApproval(
      workspace,
      path.join(repo, "MEMORY.md"),
      "read",
      "read_file",
      { request },
    );
    expect(result).toMatchObject({ decision: "deny", reason: "memory_repo_unavailable" });
    expect(request).not.toHaveBeenCalled();
  });

  it("denies every mutation with protected_path, even with unrestricted access or approval", () => {
    const unrestricted = makeWorkspace(workspace.path, { unrestrictedFileAccess: true });
    for (const target of [
      path.join(repo, "MEMORY.md"),
      path.join(repo, "new.md"),
      path.join(repo, "workspaces", "app.md"),
      path.join(repo, ".git", "hooks", "pre-commit"),
      repo,
    ]) {
      for (const operation of ["write", "delete"] as const) {
        expect(
          allowed(() =>
            evaluateWorkspaceFilesystemAccess(unrestricted, target, operation, {
              externalApprovalGranted: true,
            }),
          ),
        ).toMatchObject({ decision: "deny", reason: "protected_path" });
      }
    }
  });

  it("denies writes when the workspace contains the repo, and profile write rules cannot grant them", () => {
    const home = tempDir("cowork-memory-home-");
    const nestedRepo = path.join(home, ".cowork-memory");
    fs.mkdirSync(nestedRepo);
    fs.writeFileSync(path.join(nestedRepo, "MEMORY.md"), "# Memory\n");
    setMemoryRepoRoot(nestedRepo);
    const homeWorkspace = makeWorkspace(home, {
      accessFilesystemRules: [{ path: nestedRepo, access: "write" }],
    });
    expect(
      evaluateWorkspaceFilesystemAccess(homeWorkspace, path.join(nestedRepo, "MEMORY.md"), "write"),
    ).toMatchObject({ decision: "deny", reason: "protected_path" });
    // Reads of the repo inside the workspace still follow the memory repo rule.
    expect(
      evaluateWorkspaceFilesystemAccess(homeWorkspace, path.join(nestedRepo, "MEMORY.md"), "read"),
    ).toMatchObject({ decision: "deny", reason: "memory_repo_unavailable" });
    // The rest of the workspace is unaffected.
    expect(
      evaluateWorkspaceFilesystemAccess(homeWorkspace, path.join(home, "notes.md"), "write")
        .decision,
    ).toBe("allow");
  });

  it("never reads the repo's .git (it keeps forgotten lines)", () => {
    expect(
      allowed(() =>
        evaluateWorkspaceFilesystemAccess(workspace, path.join(repo, ".git", "config"), "read"),
      ),
    ).toMatchObject({ decision: "deny", reason: "protected_path" });
    expect(
      allowed(() => evaluateWorkspaceFilesystemAccess(workspace, path.join(repo, ".GIT"), "read")),
    ).toMatchObject({ decision: "deny", reason: "protected_path" });
  });

  it("catches symlinks and .. segments into the repo", () => {
    const link = path.join(workspace.path, "mem-link");
    fs.symlinkSync(repo, link);
    expect(
      evaluateWorkspaceFilesystemAccess(workspace, path.join(link, "MEMORY.md"), "write"),
    ).toMatchObject({ decision: "deny", reason: "protected_path" });
    expect(
      evaluateWorkspaceFilesystemAccess(workspace, path.join(link, "MEMORY.md"), "read"),
    ).toMatchObject({ decision: "deny", reason: "memory_repo_unavailable" });
    const dotted = path.join(workspace.path, "..", path.basename(repo), "MEMORY.md");
    expect(evaluateWorkspaceFilesystemAccess(workspace, dotted, "write")).toMatchObject({
      decision: "deny",
      reason: "protected_path",
    });
    // A file that does not exist yet under a symlinked directory is still inside.
    expect(
      evaluateWorkspaceFilesystemAccess(workspace, path.join(link, "workspaces", "x.md"), "write"),
    ).toMatchObject({ decision: "deny", reason: "protected_path" });
  });

  it("keeps profile deny rules for reads", () => {
    const denied = makeWorkspace(workspace.path, {
      accessFilesystemRules: [{ path: repo, access: "deny" }],
    });
    expect(
      allowed(() =>
        evaluateWorkspaceFilesystemAccess(denied, path.join(repo, "MEMORY.md"), "read"),
      ),
    ).toMatchObject({ decision: "deny", reason: "profile_filesystem_denied" });
  });

  it("lets read_file and list_directory read the repo but never write it", async () => {
    const daemon = {
      logEvent: vi.fn(),
      requestApproval: vi.fn().mockResolvedValue(true),
      captureTaskMutationBaseline: vi.fn(),
      recordSensitiveSourceRead: vi.fn(),
    } as Any;
    const files = new FileTools(workspace, daemon, "task-1");
    const memoryFile = path.join(repo, "MEMORY.md");

    const read = await allowed(() => files.readFile(memoryFile));
    expect(read.content).toContain("Deploys go through staging");
    const listing = await allowed(() => files.listDirectory(repo));
    expect(JSON.stringify(listing)).toContain("MEMORY.md");

    await expect(refused(() => files.readFile(memoryFile))).rejects.toThrow();
    await expect(allowed(() => files.writeFile(memoryFile, "- planted"))).rejects.toThrow();
    expect(fs.readFileSync(memoryFile, "utf8")).toContain("Deploys go through staging");
    // A refused read is never turned into an approval prompt.
    expect(daemon.requestApproval).not.toHaveBeenCalled();
  });

  it("lets grep and glob search the repo only under the task scope", async () => {
    const daemon = { logEvent: vi.fn(), registerArtifact: vi.fn() } as Any;
    const grep = new GrepTools(workspace, daemon, "task-1");
    const glob = new GlobTools(workspace, daemon, "task-1");

    const grepResult = await allowed(() => grep.grep({ pattern: "pnpm", path: repo }));
    expect(grepResult.success).toBe(true);
    expect(grepResult.matches.map((match) => fs.realpathSync(match.file))).toEqual([
      path.join(fs.realpathSync(repo), "workspaces", "app.md"),
    ]);
    const gitHit = await allowed(() => grep.grep({ pattern: "core", path: repo }));
    expect(gitHit.matches).toEqual([]);

    const globResult = await allowed(() => glob.glob({ pattern: "**/*.md", path: repo }));
    expect(globResult.success).toBe(true);
    expect(globResult.matches.map((match) => path.basename(match.path)).sort()).toEqual([
      "MEMORY.md",
      "app.md",
    ]);

    const grepRefused = await refused(() => grep.grep({ pattern: "pnpm", path: repo }));
    expect(grepRefused.success).toBe(false);
    expect(grepRefused.error).toContain("memory folder is not readable");
    const globRefused = await glob.glob({ pattern: "**/*.md", path: repo });
    expect(globRefused.success).toBe(false);
    expect(globRefused.error).toContain("memory folder is not readable");
  });
});

describe("team memory repo filesystem boundary", () => {
  let team: string;
  let workspace: Workspace;

  beforeEach(() => {
    team = tempDir("cowork-team-memory-");
    fs.mkdirSync(path.join(team, ".git"));
    fs.mkdirSync(path.join(team, "topics"));
    fs.writeFileSync(path.join(team, "MEMORY.md"), "# Team\n\n- Releases ship on Tuesdays\n");
    fs.writeFileSync(path.join(team, "topics", "ci.md"), "# CI\n\n- CI runs on buildkite\n");
    fs.writeFileSync(path.join(team, ".git", "config"), "[core]\n");
    // No personal folder: a team repo is protected on its own.
    setMemoryRepoRoot(null);
    setTeamMemoryRepoRoots([team]);
    workspace = makeWorkspace(tempDir("cowork-team-ws-"));
  });

  afterEach(() => {
    setTeamMemoryRepoRoots([]);
    setMemoryRepoRoot(null);
    while (cleanup.length > 0) {
      const target = cleanup.pop();
      if (target) fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it("registers and clears the roots", () => {
    expect(getTeamMemoryRepoRoots()).toEqual([path.resolve(team)]);
    setTeamMemoryRepoRoots([]);
    expect(
      evaluateWorkspaceFilesystemAccess(workspace, path.join(team, "MEMORY.md"), "read"),
    ).toMatchObject({ decision: "deny", reason: "outside_workspace" });
  });

  it("reads only inside a task scope whose memory repo layer is on", () => {
    const file = path.join(team, "MEMORY.md");
    expect(evaluateWorkspaceFilesystemAccess(workspace, file, "read")).toMatchObject({
      decision: "deny",
      reason: "memory_repo_unavailable",
    });
    expect(refused(() => evaluateWorkspaceFilesystemAccess(workspace, file, "read"))).toMatchObject(
      { decision: "deny", reason: "memory_repo_unavailable" },
    );
    expect(allowed(() => evaluateWorkspaceFilesystemAccess(workspace, file, "read"))).toMatchObject(
      { decision: "allow", reason: "memory_repo_read" },
    );
  });

  it("denies every mutation and any .git access with protected_path", () => {
    const unrestricted = makeWorkspace(workspace.path, { unrestrictedFileAccess: true });
    for (const target of [
      path.join(team, "MEMORY.md"),
      path.join(team, "new.md"),
      path.join(team, "topics", "ci.md"),
      path.join(team, "topics", "new-dir"),
      team,
    ]) {
      for (const operation of ["write", "delete"] as const) {
        expect(
          allowed(() =>
            evaluateWorkspaceFilesystemAccess(unrestricted, target, operation, {
              externalApprovalGranted: true,
            }),
          ),
        ).toMatchObject({ decision: "deny", reason: "protected_path" });
      }
    }
    expect(
      allowed(() =>
        evaluateWorkspaceFilesystemAccess(workspace, path.join(team, ".git", "config"), "read"),
      ),
    ).toMatchObject({ decision: "deny", reason: "protected_path" });
  });

  it("applies next to the personal folder and catches symlinks into the team repo", () => {
    const personal = tempDir("cowork-memory-repo-");
    setMemoryRepoRoot(personal);
    const link = path.join(workspace.path, "team-link");
    fs.symlinkSync(team, link);
    expect(
      evaluateWorkspaceFilesystemAccess(workspace, path.join(link, "MEMORY.md"), "write"),
    ).toMatchObject({ decision: "deny", reason: "protected_path" });
    expect(
      evaluateWorkspaceFilesystemAccess(workspace, path.join(link, "MEMORY.md"), "read"),
    ).toMatchObject({ decision: "deny", reason: "memory_repo_unavailable" });
    expect(
      evaluateWorkspaceFilesystemAccess(workspace, path.join(personal, "MEMORY.md"), "write"),
    ).toMatchObject({ decision: "deny", reason: "protected_path" });
  });

  it("denies writes when the workspace contains the team repo", () => {
    const home = tempDir("cowork-team-home-");
    const nested = path.join(home, "team-memory");
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, "MEMORY.md"), "# Team\n");
    setTeamMemoryRepoRoots([team, nested]);
    const homeWorkspace = makeWorkspace(home, {
      accessFilesystemRules: [{ path: nested, access: "write" }],
    });
    expect(
      evaluateWorkspaceFilesystemAccess(homeWorkspace, path.join(nested, "MEMORY.md"), "write"),
    ).toMatchObject({ decision: "deny", reason: "protected_path" });
    expect(
      evaluateWorkspaceFilesystemAccess(homeWorkspace, path.join(home, "notes.md"), "write")
        .decision,
    ).toBe("allow");
  });

  it("lets grep and glob search a team repo only under the task scope", async () => {
    const daemon = { logEvent: vi.fn(), registerArtifact: vi.fn() } as Any;
    const grep = new GrepTools(workspace, daemon, "task-1");
    const glob = new GlobTools(workspace, daemon, "task-1");

    const grepResult = await allowed(() => grep.grep({ pattern: "buildkite", path: team }));
    expect(grepResult.success).toBe(true);
    expect(grepResult.matches.map((match) => fs.realpathSync(match.file))).toEqual([
      path.join(fs.realpathSync(team), "topics", "ci.md"),
    ]);
    const globResult = await allowed(() => glob.glob({ pattern: "**/*.md", path: team }));
    expect(globResult.success).toBe(true);
    expect(globResult.matches.map((match) => path.basename(match.path)).sort()).toEqual([
      "MEMORY.md",
      "ci.md",
    ]);

    const grepRefused = await refused(() => grep.grep({ pattern: "buildkite", path: team }));
    expect(grepRefused.success).toBe(false);
    const globRefused = await glob.glob({ pattern: "**/*.md", path: team });
    expect(globRefused.success).toBe(false);
  });
});
