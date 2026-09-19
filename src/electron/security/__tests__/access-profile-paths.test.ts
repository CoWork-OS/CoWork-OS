import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  authorizeToolActionWithFallback,
  assertWorkspaceReadableFileAccessWithApproval,
  canonicalizeAccessPath,
  evaluateWorkspaceFilesystemAccess,
  isAccessPathWithin,
  resolveWorkspaceFilesystemAccessWithApproval,
  resolveWorkspaceFilesystemAccessesWithApproval,
} from "../access-profile-paths";
import type { Workspace } from "../../../shared/types";

const cleanupPaths: string[] = [];

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-access-paths-"));
  cleanupPaths.push(workspacePath);
  return {
    id: "workspace-1",
    name: "Workspace",
    path: workspacePath,
    permissions: {
      read: true,
      write: true,
      delete: false,
      shell: false,
      network: false,
      unrestrictedFileAccess: false,
      allowedPaths: [],
    },
    createdAt: Date.now(),
    ...overrides,
  };
}

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target) fs.rmSync(target, { recursive: true, force: true });
  }
});

describe("workspace access-profile path evaluation", () => {
  it("does not let a broader root turn a read-only rule into a write grant", () => {
    const workspace = makeWorkspace();
    const readOnlyPath = path.join(workspace.path, "readonly");
    workspace.permissions.accessWorkspaceRoots = [workspace.path];
    workspace.permissions.accessFilesystemRules = [{ path: readOnlyPath, access: "read" }];

    expect(evaluateWorkspaceFilesystemAccess(workspace, readOnlyPath, "read").decision).toBe(
      "allow",
    );
    expect(evaluateWorkspaceFilesystemAccess(workspace, readOnlyPath, "write")).toMatchObject({
      decision: "deny",
      reason: "profile_filesystem_denied",
    });
  });

  it("resolves symlinks before allowing a workspace read", () => {
    const workspace = makeWorkspace();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-access-outside-"));
    cleanupPaths.push(outsideDir);
    const outsideFile = path.join(outsideDir, "secret.txt");
    const linkPath = path.join(workspace.path, "linked.txt");
    fs.writeFileSync(outsideFile, "secret", "utf8");
    fs.symlinkSync(outsideFile, linkPath);

    expect(evaluateWorkspaceFilesystemAccess(workspace, linkPath, "read")).toMatchObject({
      decision: "deny",
      reason: "outside_workspace",
    });
  });

  it("uses component boundaries instead of string prefixes", () => {
    const workspace = makeWorkspace();
    const sibling = `${workspace.path}-sibling`;
    expect(isAccessPathWithin(workspace.path, sibling)).toBe(false);
    expect(evaluateWorkspaceFilesystemAccess(workspace, sibling, "read").decision).toBe("deny");
  });

  it("keeps temporary-workspace compatibility scoped to unprofiled temp access", () => {
    const workspace = makeWorkspace({ isTemp: true });
    const externalTempFile = path.join(os.tmpdir(), "cowork-access-external.txt");
    expect(evaluateWorkspaceFilesystemAccess(workspace, externalTempFile, "read").reason).toBe(
      "temporary_workspace",
    );

    workspace.permissions.accessWorkspaceRoots = [path.join(os.tmpdir(), "explicit-root")];
    expect(evaluateWorkspaceFilesystemAccess(workspace, externalTempFile, "read").decision).toBe(
      "deny",
    );
  });

  it("requests a one-shot grant only for a plain external boundary crossing", async () => {
    const workspace = makeWorkspace({ isTemp: false });
    const externalFile = path.join(os.homedir(), ".cowork-access-approved.txt");
    const requests: Array<{ path: string; operation: string }> = [];
    const result = await resolveWorkspaceFilesystemAccessWithApproval(
      workspace,
      externalFile,
      "write",
      "test output",
      {
        request: async (request) => {
          requests.push({ path: request.path, operation: request.operation });
          return true;
        },
      },
    );

    expect(result).toMatchObject({ decision: "allow", reason: "external_approval" });
    expect(requests).toEqual([{ path: externalFile, operation: "write" }]);
  });

  it("uses one scoped request for a multi-path external filesystem operation", async () => {
    const workspace = makeWorkspace({ isTemp: false });
    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-access-external-"));
    cleanupPaths.push(externalRoot);
    const source = path.join(externalRoot, "source.txt");
    const destination = path.join(externalRoot, "destination.txt");
    fs.writeFileSync(source, "source", "utf8");
    const canonicalSource = canonicalizeAccessPath(source);
    const canonicalDestination = canonicalizeAccessPath(destination);
    const requests: Array<{
      path: string;
      paths?: string[];
      pathOperations?: Array<{ path: string; operation: string }>;
    }> = [];

    const results = await resolveWorkspaceFilesystemAccessesWithApproval(
      workspace,
      [
        { rawPath: source, operation: "read", label: "source file" },
        { rawPath: destination, operation: "write", label: "destination file" },
      ],
      {
        request: async (request) => {
          requests.push(request);
          return true;
        },
      },
    );

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.decision === "allow")).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      path: canonicalSource,
      paths: [canonicalSource, canonicalDestination],
      pathOperations: [
        { path: canonicalSource, operation: "read" },
        { path: canonicalDestination, operation: "write" },
      ],
    });
  });

  it("rejects an external target rebound to another canonical file while approval is pending", async () => {
    const workspace = makeWorkspace({ isTemp: false });
    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-access-rebind-"));
    cleanupPaths.push(externalRoot);
    const candidate = path.join(externalRoot, "candidate.txt");
    const replacement = path.join(externalRoot, "replacement.txt");
    fs.writeFileSync(candidate, "candidate", "utf8");
    fs.writeFileSync(replacement, "replacement", "utf8");

    const result = await resolveWorkspaceFilesystemAccessWithApproval(
      workspace,
      candidate,
      "read",
      "external file",
      {
        request: async () => {
          fs.unlinkSync(candidate);
          fs.symlinkSync(replacement, candidate);
          return true;
        },
      },
    );

    expect(result).toMatchObject({
      decision: "deny",
      reason: "path_changed_after_approval",
      externalApprovalGranted: false,
    });
  });

  it("rechecks internal targets while a different external path awaits approval", async () => {
    const workspace = makeWorkspace({ isTemp: false });
    const internal = path.join(workspace.path, "internal.txt");
    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-access-rebind-"));
    cleanupPaths.push(externalRoot);
    const replacement = path.join(externalRoot, "replacement.txt");
    const externalDestination = path.join(externalRoot, "destination.txt");
    fs.writeFileSync(internal, "internal", "utf8");
    fs.writeFileSync(replacement, "replacement", "utf8");

    const results = await resolveWorkspaceFilesystemAccessesWithApproval(
      workspace,
      [
        { rawPath: internal, operation: "read", label: "internal file" },
        { rawPath: externalDestination, operation: "write", label: "external destination" },
      ],
      {
        request: async () => {
          fs.unlinkSync(internal);
          fs.symlinkSync(replacement, internal);
          return true;
        },
      },
    );

    expect(results[0]).toMatchObject({
      decision: "deny",
      reason: "path_changed_after_approval",
      externalApprovalGranted: false,
    });
  });

  it("rejects a readable file whose canonical target changes during approval", async () => {
    const workspace = makeWorkspace({ isTemp: false });
    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-access-rebind-"));
    cleanupPaths.push(externalRoot);
    const candidate = path.join(externalRoot, "candidate.txt");
    const replacement = path.join(externalRoot, "replacement.txt");
    fs.writeFileSync(candidate, "candidate", "utf8");
    fs.writeFileSync(replacement, "replacement", "utf8");

    await expect(
      assertWorkspaceReadableFileAccessWithApproval(workspace, candidate, "external file", {
        request: async () => {
          fs.unlinkSync(candidate);
          fs.symlinkSync(replacement, candidate);
          return true;
        },
      }),
    ).rejects.toThrow("path_changed_after_approval");
  });

  it("fails closed without prompting when the legacy policy evaluator denies", async () => {
    let requestCount = 0;
    const approved = await authorizeToolActionWithFallback(
      {
        evaluateToolPermission: () => ({ decision: "deny" }),
        requestApproval: async () => {
          requestCount += 1;
          return true;
        },
      },
      "task-never",
      {
        toolName: "run_command",
        approvalType: "run_command",
      },
    );

    expect(approved).toBe(false);
    expect(requestCount).toBe(0);
  });

  it("preserves explicit consent when a legacy evaluator allows the resource", async () => {
    const requests: unknown[] = [];
    const allowed = await authorizeToolActionWithFallback(
      {
        evaluateToolPermission: () => ({ decision: "allow" }),
        requestApproval: async (...args: unknown[]) => {
          requests.push(args);
          return false;
        },
      },
      "task-consent",
      {
        toolName: "delete_file",
        approvalType: "delete_file",
        requireExplicitApproval: true,
      },
    );
    expect(allowed).toBe(false);
    expect(requests).toHaveLength(1);
  });

  it("preserves explicit consent when auto-approval is disabled", async () => {
    const requestApproval = vi.fn(async () => false);
    const allowed = await authorizeToolActionWithFallback(
      {
        evaluateToolPermission: () => ({ decision: "allow" }),
        requestApproval,
      },
      "task-consent",
      {
        toolName: "delete_file",
        approvalType: "delete_file",
        allowAutoApprove: false,
      },
    );

    expect(allowed).toBe(false);
    expect(requestApproval).toHaveBeenCalledWith(
      "task-consent",
      "delete_file",
      expect.any(String),
      {},
      expect.objectContaining({ allowAutoApprove: false }),
    );
  });

  it("does not turn a profile deny into an approval prompt", async () => {
    const workspace = makeWorkspace({ isTemp: false });
    const deniedPath = path.join(workspace.path, "private.txt");
    workspace.permissions.accessFilesystemRules = [{ path: deniedPath, access: "deny" }];
    const request = async () => true;

    const result = await resolveWorkspaceFilesystemAccessWithApproval(
      workspace,
      deniedPath,
      "write",
      "denied output",
      { request },
    );

    expect(result).toMatchObject({ decision: "deny", reason: "profile_filesystem_denied" });
  });

  it("does not let a finite profile filesystem scope be widened by external approval", async () => {
    const workspace = makeWorkspace({ isTemp: false });
    const scopedRoot = path.join(workspace.path, "allowed");
    const externalFile = path.join(os.tmpdir(), "cowork-scoped-external.txt");
    workspace.permissions.accessProfileId = "scoped-profile";
    workspace.permissions.accessProfileScoped = true;
    workspace.permissions.accessFilesystemScoped = true;
    workspace.permissions.accessWorkspaceRoots = [scopedRoot];
    workspace.permissions.allowedPaths = [os.tmpdir()];

    let requestCount = 0;
    const result = await resolveWorkspaceFilesystemAccessWithApproval(
      workspace,
      externalFile,
      "write",
      "scoped output",
      {
        request: async () => {
          requestCount += 1;
          return true;
        },
      },
    );

    expect(result).toMatchObject({
      decision: "deny",
      reason: "profile_filesystem_outside",
      externalApprovalGranted: false,
    });
    expect(requestCount).toBe(0);
  });

  it("infers a finite filesystem scope for older persisted workspaces", async () => {
    const workspace = makeWorkspace({ isTemp: false });
    const scopedRoot = path.join(workspace.path, "allowed");
    const externalFile = path.join(os.tmpdir(), "cowork-legacy-scoped-external.txt");
    workspace.permissions.accessProfileId = "scoped-profile";
    workspace.permissions.accessProfileScoped = true;
    workspace.permissions.accessWorkspaceRoots = [scopedRoot];
    workspace.permissions.allowedPaths = [os.tmpdir()];

    let requestCount = 0;
    const result = await resolveWorkspaceFilesystemAccessWithApproval(
      workspace,
      externalFile,
      "write",
      "legacy scoped output",
      {
        request: async () => {
          requestCount += 1;
          return true;
        },
      },
    );

    expect(result).toMatchObject({
      decision: "deny",
      reason: "profile_filesystem_outside",
      externalApprovalGranted: false,
    });
    expect(requestCount).toBe(0);
  });

  it("hard-denies protected system mutations before asking for external approval", async () => {
    const workspace = makeWorkspace({ isTemp: false });
    const protectedPath =
      process.platform === "win32"
        ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cowork-test.txt")
        : "/etc/cowork-test.txt";
    workspace.permissions.unrestrictedFileAccess = true;
    let requestCount = 0;

    const result = await resolveWorkspaceFilesystemAccessWithApproval(
      workspace,
      protectedPath,
      "write",
      "protected output",
      {
        request: async () => {
          requestCount += 1;
          return true;
        },
      },
    );

    expect(result).toMatchObject({
      decision: "deny",
      reason: "protected_path",
      externalApprovalGranted: false,
    });
    expect(requestCount).toBe(0);
  });
});

describe("protected in-workspace paths", () => {
  const protectedTargets = [
    [".cowork/policy/permissions.json", "permission mirror"],
    [".cowork/policy/tools.monty", "tool-policy script"],
    [".cowork/policy", "policy directory itself"],
    [".git/hooks/pre-commit", "git hook"],
    [".git/config", "git config"],
    ["vendor/dep/.git/hooks/pre-commit", "nested repository hook"],
  ] as const;

  for (const [relative, label] of protectedTargets) {
    it(`denies writes to the ${label}`, () => {
      const workspace = makeWorkspace();
      const target = path.join(workspace.path, relative);

      expect(evaluateWorkspaceFilesystemAccess(workspace, target, "write")).toMatchObject({
        decision: "deny",
        reason: "protected_path",
      });
    });

    it(`denies deletes of the ${label}`, () => {
      const workspace = makeWorkspace({
        permissions: {
          read: true,
          write: true,
          delete: true,
          shell: false,
          network: false,
          unrestrictedFileAccess: true,
          allowedPaths: [],
        },
      });
      const target = path.join(workspace.path, relative);

      expect(evaluateWorkspaceFilesystemAccess(workspace, target, "delete")).toMatchObject({
        decision: "deny",
        reason: "protected_path",
      });
    });

    it(`still allows reads of the ${label}`, () => {
      const workspace = makeWorkspace();
      const target = path.join(workspace.path, relative);

      expect(evaluateWorkspaceFilesystemAccess(workspace, target, "read").decision).toBe("allow");
    });
  }

  it("matches protected segments case-insensitively", () => {
    const workspace = makeWorkspace();
    const target = path.join(workspace.path, ".GIT", "hooks", "pre-commit");

    expect(evaluateWorkspaceFilesystemAccess(workspace, target, "write")).toMatchObject({
      decision: "deny",
      reason: "protected_path",
    });
  });

  it("denies a write laundered through a symlink into .git", () => {
    const workspace = makeWorkspace();
    fs.mkdirSync(path.join(workspace.path, ".git", "hooks"), { recursive: true });
    const link = path.join(workspace.path, "innocent");
    fs.symlinkSync(path.join(workspace.path, ".git", "hooks"), link, "dir");

    expect(
      evaluateWorkspaceFilesystemAccess(workspace, path.join(link, "pre-commit"), "write"),
    ).toMatchObject({ decision: "deny", reason: "protected_path" });
  });

  it("allows writing .git/info/exclude, which CoWork maintains itself", () => {
    const workspace = makeWorkspace();
    const target = path.join(workspace.path, ".git", "info", "exclude");

    expect(evaluateWorkspaceFilesystemAccess(workspace, target, "write").decision).toBe("allow");
  });

  it("keeps the .git/info/exclude carve-out to that exact path", () => {
    const workspace = makeWorkspace();

    for (const relative of [
      ".git/info/exclude-evil",
      ".git/info/exclude/nested",
      ".git/info/config",
      ".git/info",
    ]) {
      expect(
        evaluateWorkspaceFilesystemAccess(workspace, path.join(workspace.path, relative), "write"),
      ).toMatchObject({ decision: "deny", reason: "protected_path" });
    }
  });

  it("does not over-match ordinary workspace paths", () => {
    const workspace = makeWorkspace();

    for (const relative of [
      ".cowork/tmp/scratch.txt",
      ".cowork/automated-outputs/report.md",
      ".github/workflows/ci.yml",
      "src/.gitignore",
      "gitignore-notes.md",
      "policy/notes.md",
    ]) {
      expect(
        evaluateWorkspaceFilesystemAccess(workspace, path.join(workspace.path, relative), "write")
          .decision,
      ).toBe("allow");
    }
  });
});
