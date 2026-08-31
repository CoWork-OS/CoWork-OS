import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isResolvedPathInsideRoot, resolveRealPathWithinWorkspace } from "../viewer-path-security";

describe("viewer path security", () => {
  let tempRoot: string;
  let workspaceRoot: string;
  let externalRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-viewer-path-"));
    workspaceRoot = path.join(tempRoot, "workspace");
    externalRoot = path.join(tempRoot, "external");
    await fs.mkdir(workspaceRoot);
    await fs.mkdir(externalRoot);
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("allows a symlink only when its real target stays inside the workspace", async () => {
    const target = path.join(workspaceRoot, "notes.txt");
    const link = path.join(workspaceRoot, "notes-link.txt");
    await fs.writeFile(target, "safe");
    await fs.symlink(target, link);

    await expect(resolveRealPathWithinWorkspace(link, workspaceRoot)).resolves.toBe(
      await fs.realpath(target),
    );
  });

  it("rejects workspace symlinks whose real target escapes the workspace", async () => {
    const target = path.join(externalRoot, "secret.txt");
    const link = path.join(workspaceRoot, "allowed-name.txt");
    await fs.writeFile(target, "secret");
    await fs.symlink(target, link);

    await expect(resolveRealPathWithinWorkspace(link, workspaceRoot)).rejects.toThrow(
      "resolves outside the workspace",
    );
  });

  it("treats lexical siblings as outside the resolved workspace root", () => {
    expect(
      isResolvedPathInsideRoot(path.join(tempRoot, "workspace-sibling", "file.txt"), workspaceRoot),
    ).toBe(false);
  });
});
