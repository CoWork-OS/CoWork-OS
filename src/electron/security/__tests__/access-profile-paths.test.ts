import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateWorkspaceFilesystemAccess,
  isAccessPathWithin,
  resolveWorkspaceFilesystemAccessWithApproval,
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
