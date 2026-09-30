import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MemoryService } from "../../../electron/memory/MemoryService";
import * as Cron from "../../../electron/cron";
import { ensureDefaultKitCronJobs } from "../../../electron/context/kit-operations";
import { createBrowserMemoryDefinitions } from "../browser-memory-methods";
import type { Workspace } from "../../../shared/types";

let root: string;
let workspace: Workspace;
async function call(name: string, args: unknown[]) {
  const method = createBrowserMemoryDefinitions({ resolveWorkspace: async () => workspace })[name];
  return method.handler(method.validate?.(args) ?? args, {} as never);
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-kit-test-"));
  workspace = {
    id: "__temp_workspace__",
    path: path.join(root, "workspace"),
    permissions: { read: true, write: true, delete: false },
  } as Workspace;
  await fs.mkdir(workspace.path);
  vi.spyOn(MemoryService, "syncWorkspaceMarkdown").mockResolvedValue(undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe("browser workspace kit", () => {
  it("reads missing kit status without creating lifecycle state or a directory", async () => {
    expect(await call("getWorkspaceKitStatus", [workspace.id])).toMatchObject({ hasKitDir: false });
    expect(await fs.readdir(workspace.path)).toEqual([]);
  });
  it("initializes shared templates without overwriting existing notes and creates project folders", async () => {
    await fs.mkdir(path.join(workspace.path, ".cowork"));
    await fs.writeFile(path.join(workspace.path, ".cowork", "MEMORY.md"), "User-owned memory note");
    expect(
      await call("initWorkspaceKit", [{ workspaceId: workspace.id, mode: "missing" }]),
    ).toMatchObject({ hasKitDir: true });
    expect(await fs.readFile(path.join(workspace.path, ".cowork", "MEMORY.md"), "utf8")).toBe(
      "User-owned memory note",
    );
    expect(await fs.readFile(path.join(workspace.path, ".cowork", "AGENTS.md"), "utf8")).toContain(
      "# Workspace Rules",
    );
    await call("createWorkspaceKitProject", [
      { workspaceId: workspace.id, projectId: "test-project" },
    ]);
    expect(
      await fs.readFile(
        path.join(workspace.path, ".cowork", "projects", "test-project", "CONTEXT.md"),
        "utf8",
      ),
    ).toContain("## Goals");
    await expect(
      call("createWorkspaceKitProject", [{ workspaceId: workspace.id, projectId: "../escape" }]),
    ).rejects.toThrow();
  });
  it("rejects read-only writes and symlink escapes before touching outside files", async () => {
    workspace.permissions.write = false;
    await expect(call("initWorkspaceKit", [{ workspaceId: workspace.id }])).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await fs.readdir(workspace.path)).toEqual([]);
    workspace.permissions.write = true;
    const outside = path.join(root, "outside");
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(workspace.path, ".cowork"));
    await expect(call("getWorkspaceKitStatus", [workspace.id])).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(call("initWorkspaceKit", [{ workspaceId: workspace.id }])).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await fs.readdir(outside)).toEqual([]);
  });
  it("bounds file reads and rejects history-directory escapes", async () => {
    await fs.mkdir(path.join(workspace.path, ".cowork"));
    await fs.writeFile(
      path.join(workspace.path, ".cowork", "AGENTS.md"),
      "x".repeat(2 * 1024 * 1024 + 1),
    );
    await expect(call("getWorkspaceKitStatus", [workspace.id])).rejects.toMatchObject({
      statusCode: 413,
    });
    await fs.unlink(path.join(workspace.path, ".cowork", "AGENTS.md"));
    const outside = path.join(root, "outside");
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(workspace.path, ".cowork", ".history"));
    await expect(call("initWorkspaceKit", [{ workspaceId: workspace.id }])).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await fs.readdir(outside)).toEqual([]);
  });
  it("keeps explicit policy-file denies and redirects outside the trusted seed paths blocked", async () => {
    workspace.permissions.accessFilesystemRules = [
      { path: path.join(workspace.path, ".cowork", "policy"), access: "deny" },
    ];
    await expect(call("initWorkspaceKit", [{ workspaceId: workspace.id }])).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      fs.stat(path.join(workspace.path, ".cowork", "policy", "tools.monty")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    workspace.permissions.accessFilesystemRules = [];
    await fs.mkdir(path.join(workspace.path, ".git"));
    await fs.symlink(
      path.join(workspace.path, ".git"),
      path.join(workspace.path, ".cowork", "policy"),
    );
    await expect(call("initWorkspaceKit", [{ workspaceId: workspace.id }])).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await fs.readdir(path.join(workspace.path, ".git"))).toEqual([]);
  });

  it("does not report kit scheduling as successful after a refused scheduler write", async () => {
    vi.spyOn(Cron, "getCronService").mockReturnValue({
      list: async () => [],
      add: async () => ({ ok: false, error: "Scheduler storage refused" }),
    } as never);
    await expect(ensureDefaultKitCronJobs("workspace-one", "missing", true)).rejects.toThrow(
      "Scheduler storage refused",
    );
  });
});
