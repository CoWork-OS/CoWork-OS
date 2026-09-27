import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { Workspace } from "../../../shared/types";
import {
  WorkspaceArtifactEvidenceInspector,
  type WorkspaceArtifactEvidenceIo,
} from "../WorkspaceArtifactEvidenceInspector";

describe("WorkspaceArtifactEvidenceInspector", () => {
  let tempDir = "";

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = "";
  });

  function setup(permissions: Partial<Workspace["permissions"]> = {}) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-artifact-evidence-"));
    const workspacePath = path.join(tempDir, "workspace");
    fs.mkdirSync(workspacePath, { recursive: true });
    const workspace: Pick<Workspace, "path" | "permissions"> = {
      path: workspacePath,
      permissions: {
        read: true,
        write: true,
        delete: false,
        shell: false,
        network: false,
        ...permissions,
      },
    };
    return { workspace, workspacePath };
  }

  it("hashes an exact regular workspace file under the existing read authority", () => {
    const { workspace, workspacePath } = setup();
    const target = path.join(workspacePath, "report.txt");
    fs.writeFileSync(target, "current output");

    expect(new WorkspaceArtifactEvidenceInspector().inspect(workspace, "report.txt")).toEqual({
      status: "present",
      path: fs.realpathSync(target),
      sha256: createHash("sha256").update("current output").digest("hex"),
      size: Buffer.byteLength("current output"),
    });
  });

  it("rejects paths outside the workspace, symlinks, and non-regular targets", () => {
    const { workspace, workspacePath } = setup();
    const outside = path.join(tempDir, "outside.txt");
    fs.writeFileSync(outside, "outside");
    fs.symlinkSync(outside, path.join(workspacePath, "linked.txt"));
    fs.mkdirSync(path.join(workspacePath, "folder"));

    const inspector = new WorkspaceArtifactEvidenceInspector();
    expect(inspector.inspect(workspace, outside)).toMatchObject({
      status: "unavailable",
      reason: "outside_workspace",
    });
    expect(inspector.inspect(workspace, "linked.txt")).toMatchObject({
      status: "unavailable",
      reason: "symlink",
    });
    expect(inspector.inspect(workspace, "folder")).toMatchObject({
      status: "unavailable",
      reason: "not_regular_file",
    });
  });

  it("distinguishes missing targets, read denial, and files over the bounded size", () => {
    const { workspace, workspacePath } = setup();
    fs.writeFileSync(path.join(workspacePath, "large.txt"), "12345");

    expect(new WorkspaceArtifactEvidenceInspector().inspect(workspace, "absent.txt")).toMatchObject(
      {
        status: "missing",
      },
    );
    expect(
      new WorkspaceArtifactEvidenceInspector({ maxBytes: 4 }).inspect(workspace, "large.txt"),
    ).toMatchObject({ status: "unavailable", reason: "too_large" });
    expect(
      new WorkspaceArtifactEvidenceInspector().inspect(
        { ...workspace, permissions: { ...workspace.permissions, read: false } },
        "large.txt",
      ),
    ).toMatchObject({ status: "unavailable", reason: "access_denied" });
  });

  it("rejects a path replaced between open and final identity checks", () => {
    const { workspace, workspacePath } = setup();
    const target = path.join(workspacePath, "changing.txt");
    const replacement = `${target}.replacement`;
    fs.writeFileSync(target, "original");
    let replaced = false;
    const io: WorkspaceArtifactEvidenceIo = {
      realpathSync: (filePath) => fs.realpathSync.native(filePath),
      lstatSync: (filePath, options) => fs.lstatSync(filePath, options),
      openSync: (filePath, flags) => fs.openSync(filePath, flags),
      fstatSync: (fd, options) => fs.fstatSync(fd, options),
      readSync: (fd, buffer, offset, length, position) => {
        if (!replaced) {
          replaced = true;
          fs.writeFileSync(replacement, "replacement bytes");
          fs.renameSync(replacement, target);
        }
        return fs.readSync(fd, buffer, offset, length, position);
      },
      closeSync: (fd) => fs.closeSync(fd),
    };

    expect(
      new WorkspaceArtifactEvidenceInspector({ io }).inspect(workspace, "changing.txt"),
    ).toMatchObject({
      status: "unavailable",
      reason: "changed_during_read",
    });
  });
});
