import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureWorkspaceDirectory, ensureWorkspaceDirectorySync } from "../workspace-directory";
import { TranscriptStore } from "../../memory/TranscriptStore";
import { createScheduledRunDirectory } from "../../cron/workspace-context";
import { writeTemplate } from "../../context/kit-operations";
import { writeKitFileWithSnapshot } from "../../context/kit-revisions";
import { appendWorkspacePermissionManifestRule } from "../../security/workspace-permission-manifest";

const roots: string[] = [];
function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-deleted-workspace-"));
  roots.push(root);
  const result = path.join(root, "Desktop", "justinGPT");
  fs.mkdirSync(result, { recursive: true });
  return result;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("deleted workspace folders", () => {
  it("creates nested artifacts in an existing workspace", async () => {
    const root = workspace();
    const directory = path.join(root, ".cowork", "memory", "summaries");
    await ensureWorkspaceDirectory(root, directory);
    ensureWorkspaceDirectorySync(root, directory);
    expect(fs.statSync(directory).isDirectory()).toBe(true);
  });

  it("does not restore a deleted root or deleted ancestor", async () => {
    const root = workspace();
    fs.rmSync(path.dirname(root), { recursive: true });
    await expect(ensureWorkspaceDirectory(root, path.join(root, ".cowork"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(() => ensureWorkspaceDirectorySync(root, path.join(root, ".cowork"))).toThrow(
      "Workspace folder is missing",
    );
    expect(fs.existsSync(path.dirname(root))).toBe(false);
  });

  it("accepts canonical artifact paths for a workspace registered through an alias", async () => {
    const root = workspace();
    const alias = path.join(path.dirname(root), "project-alias");
    fs.symlinkSync(root, alias, "dir");
    const directory = path.join(fs.realpathSync(root), ".cowork", "memory");
    await ensureWorkspaceDirectory(alias, directory);
    expect(fs.statSync(directory).isDirectory()).toBe(true);
  });

  it("does not recreate a root deleted between directory writes", async () => {
    const root = workspace();
    const originalMkdir = fs.promises.mkdir.bind(fs.promises);
    vi.spyOn(fs.promises, "mkdir").mockImplementation(
      async (...args: Parameters<typeof fs.promises.mkdir>) => {
        fs.rmSync(root, { recursive: true, force: true });
        return originalMkdir(...args);
      },
    );
    await expect(
      ensureWorkspaceDirectory(root, path.join(root, ".cowork", "memory")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(fs.existsSync(root)).toBe(false);
  });

  it("rejects directories outside the workspace", async () => {
    const root = workspace();
    await expect(ensureWorkspaceDirectory(root, path.join(root, "..", "outside"))).rejects.toThrow(
      "outside the workspace",
    );
  });

  it("keeps deleted folders absent during transcript, memory, scheduling and kit writes", async () => {
    const root = workspace();
    fs.rmSync(root, { recursive: true });
    const operations = [
      () => TranscriptStore.ensureLayout(root),
      () => writeTemplate(root, ".cowork/MEMORY.md", "Memory", "missing"),
    ];
    for (const operation of operations) {
      await expect(operation()).rejects.toMatchObject({ code: "ENOENT" });
      expect(fs.existsSync(root)).toBe(false);
    }
    expect(() => createScheduledRunDirectory(root)).toThrow("Workspace folder is missing");
    expect(() =>
      writeKitFileWithSnapshot(path.join(root, ".cowork", "LORE.md"), "Lore", "agent"),
    ).toThrow("Workspace folder is missing");
    const result = appendWorkspacePermissionManifestRule(root, {
      toolName: "read_file",
      decision: "allow",
      scope: "tool",
      createdAt: Date.now(),
    } as Any);
    expect(result.success).toBe(false);
    expect(fs.existsSync(root)).toBe(false);
  });
});
