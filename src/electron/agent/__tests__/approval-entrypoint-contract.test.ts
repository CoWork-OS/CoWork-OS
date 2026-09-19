import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Workspace } from "../../../shared/types";
import { canonicalizeAccessPath } from "../../security/access-profile-paths";
import { EditTools } from "../tools/edit-tools";
import { FileTools } from "../tools/file-tools";

function makeWorkspace(workspacePath: string): Workspace {
  return {
    id: "approval-contract-workspace",
    name: "Approval contract workspace",
    path: workspacePath,
    createdAt: Date.now(),
    isTemp: false,
    permissions: {
      read: true,
      write: true,
      delete: true,
      network: false,
      shell: false,
      unrestrictedFileAccess: false,
    },
  };
}

describe("filesystem approval entrypoint contracts", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves the canonical path and per-target approval state for multi-path operations", async () => {
    const workspacePath = fs.mkdtempSync(
      path.join(os.tmpdir(), "cowork-approval-contract-workspace-"),
    );
    const externalPath = fs.mkdtempSync(
      path.join(os.tmpdir(), "cowork-approval-contract-external-"),
    );
    temporaryDirectories.push(workspacePath, externalPath);

    const internalFile = path.join(workspacePath, "inside.txt");
    const externalFile = path.join(externalPath, "outside.txt");
    fs.writeFileSync(internalFile, "inside", "utf8");
    fs.writeFileSync(externalFile, "outside", "utf8");

    const daemon = {
      logEvent: vi.fn(),
      requestApproval: vi.fn().mockResolvedValue(true),
    } as Any;
    const fileTools = new FileTools(makeWorkspace(workspacePath), daemon, "approval-contract-task");

    const resolved = await (fileTools as Any).resolvePathsWithExternalApproval([
      { inputPath: "inside.txt", operation: "read", label: "source file" },
      { inputPath: externalFile, operation: "read", label: "source file" },
    ]);

    expect(resolved).toEqual([
      { path: canonicalizeAccessPath(internalFile), externalApprovalGranted: false },
      { path: canonicalizeAccessPath(externalFile), externalApprovalGranted: true },
    ]);
    expect(daemon.requestApproval).toHaveBeenCalledTimes(1);
  });

  it("uses an explicit external grant for an in-workspace symlink target", async () => {
    if (process.platform === "win32") return;

    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-approval-link-workspace-"));
    const externalPath = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-approval-link-external-"));
    temporaryDirectories.push(workspacePath, externalPath);

    const externalFile = path.join(externalPath, "outside.txt");
    fs.writeFileSync(externalFile, "old", "utf8");
    fs.symlinkSync(externalFile, path.join(workspacePath, "link.txt"));

    const daemon = {
      logEvent: vi.fn(),
      requestApproval: vi.fn().mockResolvedValue(true),
    } as Any;
    const fileTools = new FileTools(makeWorkspace(workspacePath), daemon, "approval-link-task");

    await fileTools.writeFile("link.txt", "new");

    expect(fs.readFileSync(externalFile, "utf8")).toBe("new");
    expect(daemon.requestApproval).toHaveBeenCalledTimes(1);
  });

  it("lets a typed delete allow discharge destructive consent without a second prompt", async () => {
    const workspacePath = fs.mkdtempSync(
      path.join(os.tmpdir(), "cowork-delete-contract-workspace-"),
    );
    temporaryDirectories.push(workspacePath);

    const targetPath = path.join(workspacePath, "delete-me.txt");
    fs.writeFileSync(targetPath, "remove", "utf8");
    const daemon = {
      logEvent: vi.fn(),
      evaluateToolPermission: vi.fn(() => ({ decision: "allow" })),
      requestApproval: vi.fn(),
    } as Any;
    const fileTools = new FileTools(makeWorkspace(workspacePath), daemon, "delete-contract-task");

    await expect(fileTools.deleteFile("delete-me.txt")).resolves.toEqual({ success: true });

    expect(daemon.requestApproval).not.toHaveBeenCalled();
    expect(daemon.evaluateToolPermission).toHaveBeenCalledWith(
      "delete-contract-task",
      expect.objectContaining({
        toolName: "delete_file",
        approvalType: "delete_file",
      }),
    );
    expect(fs.existsSync(targetPath)).toBe(false);
  });

  it("rejects an edit when its symlink target changes during the mutation baseline await", async () => {
    if (process.platform === "win32") return;

    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-edit-race-workspace-"));
    const externalPath = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-edit-race-external-"));
    temporaryDirectories.push(workspacePath, externalPath);

    const targetPath = path.join(workspacePath, "target.txt");
    const externalFile = path.join(externalPath, "outside.txt");
    fs.writeFileSync(targetPath, "old", "utf8");
    fs.writeFileSync(externalFile, "outside", "utf8");

    const daemon = {
      logEvent: vi.fn(),
      captureTaskMutationBaseline: vi.fn(async () => {
        fs.unlinkSync(targetPath);
        fs.symlinkSync(externalFile, targetPath);
      }),
    } as Any;
    const editTools = new EditTools(makeWorkspace(workspacePath), daemon, "edit-race-task");

    const result = await editTools.editFile({
      file_path: "target.txt",
      old_string: "old",
      new_string: "new",
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/outside workspace|changed during edit/i);
    expect(fs.readFileSync(externalFile, "utf8")).toBe("outside");
    expect(fs.readlinkSync(targetPath)).toBe(externalFile);
  });

  it("rejects an approved external write when its target is rebound during the baseline await", async () => {
    if (process.platform === "win32") return;

    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-write-race-workspace-"));
    const externalPath = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-write-race-external-"));
    temporaryDirectories.push(workspacePath, externalPath);

    const approvedTarget = path.join(externalPath, "approved.txt");
    const replacementTarget = path.join(externalPath, "replacement.txt");
    fs.writeFileSync(approvedTarget, "approved", "utf8");
    fs.writeFileSync(replacementTarget, "replacement", "utf8");

    const daemon = {
      logEvent: vi.fn(),
      requestApproval: vi.fn().mockResolvedValue(true),
      captureTaskMutationBaseline: vi.fn(async () => {
        fs.unlinkSync(approvedTarget);
        fs.symlinkSync(replacementTarget, approvedTarget);
      }),
    } as Any;
    const fileTools = new FileTools(makeWorkspace(workspacePath), daemon, "write-race-task");

    await expect(fileTools.writeFile(approvedTarget, "mutated")).rejects.toThrow(
      /target changed during mutation baseline/i,
    );
    expect(fs.readFileSync(replacementTarget, "utf8")).toBe("replacement");
    expect(fs.readlinkSync(approvedTarget)).toBe(replacementTarget);
  });

  it("rejects an approved external copy destination rebound during the baseline await", async () => {
    if (process.platform === "win32") return;

    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-copy-race-workspace-"));
    const externalPath = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-copy-race-external-"));
    temporaryDirectories.push(workspacePath, externalPath);

    const sourcePath = path.join(workspacePath, "source.txt");
    const approvedTarget = path.join(externalPath, "approved.txt");
    const replacementTarget = path.join(externalPath, "replacement.txt");
    fs.writeFileSync(sourcePath, "source", "utf8");
    fs.writeFileSync(approvedTarget, "approved", "utf8");
    fs.writeFileSync(replacementTarget, "replacement", "utf8");

    const daemon = {
      logEvent: vi.fn(),
      requestApproval: vi.fn().mockResolvedValue(true),
      captureTaskMutationBaseline: vi.fn(async () => {
        fs.unlinkSync(approvedTarget);
        fs.symlinkSync(replacementTarget, approvedTarget);
      }),
    } as Any;
    const fileTools = new FileTools(makeWorkspace(workspacePath), daemon, "copy-race-task");

    await expect(fileTools.copyFile(sourcePath, approvedTarget)).rejects.toThrow(
      /target changed during mutation baseline/i,
    );
    expect(fs.readFileSync(replacementTarget, "utf8")).toBe("replacement");
    expect(fs.readlinkSync(approvedTarget)).toBe(replacementTarget);
  });

  it("rejects an approved external rename destination rebound during the baseline await", async () => {
    if (process.platform === "win32") return;

    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-rename-race-workspace-"));
    const externalPath = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-rename-race-external-"));
    temporaryDirectories.push(workspacePath, externalPath);

    const sourcePath = path.join(workspacePath, "source.txt");
    const approvedTarget = path.join(externalPath, "approved.txt");
    const replacementTarget = path.join(externalPath, "replacement.txt");
    fs.writeFileSync(sourcePath, "source", "utf8");
    fs.writeFileSync(approvedTarget, "approved", "utf8");
    fs.writeFileSync(replacementTarget, "replacement", "utf8");

    let swapped = false;
    const daemon = {
      logEvent: vi.fn(),
      requestApproval: vi.fn().mockResolvedValue(true),
      captureTaskMutationBaseline: vi.fn(async (_taskId: string, baselinePath: string) => {
        if (!swapped && path.basename(baselinePath) === "approved.txt") {
          swapped = true;
          fs.unlinkSync(approvedTarget);
          fs.symlinkSync(replacementTarget, approvedTarget);
        }
      }),
    } as Any;
    const fileTools = new FileTools(makeWorkspace(workspacePath), daemon, "rename-race-task");

    await expect(fileTools.renameFile(sourcePath, approvedTarget)).rejects.toThrow(
      /target changed during mutation baseline/i,
    );
    expect(fs.readFileSync(sourcePath, "utf8")).toBe("source");
    expect(fs.readFileSync(replacementTarget, "utf8")).toBe("replacement");
    expect(fs.readlinkSync(approvedTarget)).toBe(replacementTarget);
  });

  it("rejects an approved external delete target rebound during the baseline await", async () => {
    if (process.platform === "win32") return;

    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-delete-race-workspace-"));
    const externalPath = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-delete-race-external-"));
    temporaryDirectories.push(workspacePath, externalPath);

    const approvedTarget = path.join(externalPath, "approved.txt");
    const replacementTarget = path.join(externalPath, "replacement.txt");
    fs.writeFileSync(approvedTarget, "approved", "utf8");
    fs.writeFileSync(replacementTarget, "replacement", "utf8");

    const daemon = {
      logEvent: vi.fn(),
      requestApproval: vi.fn().mockResolvedValue(true),
      captureTaskMutationBaseline: vi.fn(async () => {
        fs.unlinkSync(approvedTarget);
        fs.symlinkSync(replacementTarget, approvedTarget);
      }),
    } as Any;
    const fileTools = new FileTools(makeWorkspace(workspacePath), daemon, "delete-race-task");

    await expect(fileTools.deleteFile(approvedTarget)).rejects.toThrow(
      /target changed during mutation baseline/i,
    );
    expect(fs.readFileSync(replacementTarget, "utf8")).toBe("replacement");
    expect(fs.readlinkSync(approvedTarget)).toBe(replacementTarget);
  });
});
