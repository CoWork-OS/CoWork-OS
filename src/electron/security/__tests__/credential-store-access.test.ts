import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  evaluateWorkspaceFilesystemAccess,
  resolveWorkspaceFilesystemAccessWithApproval,
} from "../access-profile-paths";
import type { Workspace } from "../../../shared/types";

let home: string;
const originalHome = process.env.HOME;

function makeWorkspace(
  workspacePath: string,
  permissions: Partial<Workspace["permissions"]> = {},
): Workspace {
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
      ...permissions,
    },
    createdAt: Date.now(),
  };
}

function writeFile(relative: string, content = "secret"): string {
  const target = path.join(home, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-credential-home-"));
  process.env.HOME = home;
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("credential stores in the workspace file evaluator", () => {
  it("keeps ~/.ssh closed when the workspace is the home folder", () => {
    const key = writeFile(".ssh/id_ed25519");
    const notes = writeFile("notes.txt", "hello");
    const workspace = makeWorkspace(home);

    expect(evaluateWorkspaceFilesystemAccess(workspace, key, "read")).toMatchObject({
      decision: "deny",
      reason: "credential_store",
    });
    expect(evaluateWorkspaceFilesystemAccess(workspace, "~/.ssh/config", "write")).toMatchObject({
      decision: "deny",
      reason: "credential_store",
    });
    expect(evaluateWorkspaceFilesystemAccess(workspace, notes, "read").decision).toBe("allow");
  });

  it("is not opened by Full access or a one-shot external approval", () => {
    const key = writeFile(".aws/credentials");
    const workspace = makeWorkspace(fs.mkdtempSync(path.join(home, "project-")), {
      unrestrictedFileAccess: true,
    });

    expect(evaluateWorkspaceFilesystemAccess(workspace, key, "read").reason).toBe(
      "credential_store",
    );
    expect(
      evaluateWorkspaceFilesystemAccess(workspace, key, "read", { externalApprovalGranted: true })
        .reason,
    ).toBe("credential_store");
  });

  it("never turns a credential path into an approval prompt", async () => {
    const key = writeFile(".ssh/id_rsa");
    const workspace = makeWorkspace(fs.mkdtempSync(path.join(home, "project-")));
    const request = vi.fn(async () => true);

    const result = await resolveWorkspaceFilesystemAccessWithApproval(
      workspace,
      key,
      "read",
      "file",
      {
        request,
      },
    );

    expect(result).toMatchObject({ decision: "deny", reason: "credential_store" });
    expect(request).not.toHaveBeenCalled();
  });

  it("opens a store only to a grant made on the store itself", () => {
    const key = writeFile(".ssh/id_ed25519");
    const inSsh = makeWorkspace(path.join(home, ".ssh"));
    expect(evaluateWorkspaceFilesystemAccess(inSsh, key, "read").decision).toBe("allow");

    const homeWithRoot = makeWorkspace(home, { accessWorkspaceRoots: [path.join(home, ".ssh")] });
    expect(evaluateWorkspaceFilesystemAccess(homeWithRoot, key, "write").decision).toBe("allow");

    const homeWithHomeRoot = makeWorkspace(home, { accessWorkspaceRoots: [home] });
    expect(evaluateWorkspaceFilesystemAccess(homeWithHomeRoot, key, "read").reason).toBe(
      "credential_store",
    );
  });

  it("lets a read rule on a store open reads only", () => {
    const credentials = writeFile(".aws/credentials");
    const workspace = makeWorkspace(home, {
      accessFilesystemRules: [{ path: path.join(home, ".aws"), access: "read" }],
    });

    expect(evaluateWorkspaceFilesystemAccess(workspace, credentials, "read").decision).toBe(
      "allow",
    );
    expect(evaluateWorkspaceFilesystemAccess(workspace, credentials, "write").decision).toBe(
      "deny",
    );
  });

  it("follows a workspace symlink into a store", () => {
    writeFile(".ssh/id_ed25519");
    const project = fs.mkdtempSync(path.join(home, "project-"));
    fs.symlinkSync(path.join(home, ".ssh"), path.join(project, "keys"));
    const workspace = makeWorkspace(project);

    expect(
      evaluateWorkspaceFilesystemAccess(workspace, path.join(project, "keys/id_ed25519"), "read")
        .reason,
    ).toBe("credential_store");
  });

  it("covers a store that is itself a link to a dotfiles folder", () => {
    const target = writeFile("dotfiles/ssh/config");
    fs.symlinkSync(path.join(home, "dotfiles/ssh"), path.join(home, ".ssh"));
    const workspace = makeWorkspace(home);

    expect(evaluateWorkspaceFilesystemAccess(workspace, target, "read").reason).toBe(
      "credential_store",
    );
    expect(evaluateWorkspaceFilesystemAccess(workspace, "~/.ssh/config", "read").reason).toBe(
      "credential_store",
    );
  });

  it.skipIf(process.platform === "linux")("matches a store spelled in another case", () => {
    writeFile(".ssh/id_ed25519");
    const workspace = makeWorkspace(home);

    expect(
      evaluateWorkspaceFilesystemAccess(workspace, path.join(home, ".SSH/id_ed25519"), "read")
        .reason,
    ).toBe("credential_store");
  });
});
