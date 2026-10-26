import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseManager } from "../../../electron/database/schema";
import { WorkspaceStore } from "../../../electron/database/repositories";
import { WorkspaceRepository } from "../../../electron/database/repository-facades";
import {
  HOST_FOLDER_MAX_FOLDERS,
  HOST_FOLDER_MAX_SEGMENTS,
  type HostFolderListing,
} from "../../../shared/host-api/host-folders";
import type { Workspace } from "../../../shared/types";
import { isTempWorkspaceId } from "../../../shared/types";
import { BrowserDesktopRpcService } from "../browser-desktop-rpc";
import { createBrowserHostFolderDefinitions } from "../browser-host-folder-methods";

const PERMISSIONS: Workspace["permissions"] = {
  read: true,
  write: true,
  delete: false,
  network: true,
  shell: false,
};

describe("browser host folder picker methods", () => {
  let tempDir: string;
  let home: string;
  let dataRoot: string;
  let previousHome: string | undefined;
  let previousUserDataDir: string | undefined;
  let manager: DatabaseManager;
  let workspaces: WorkspaceRepository;
  let unreadableWorkspaceIds: Set<string>;
  let defs: ReturnType<typeof definitions>;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cowork-host-folders-")));
    home = path.join(tempDir, "home");
    dataRoot = path.join(home, "CoWork Data");
    previousHome = process.env.HOME;
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.HOME = home;
    process.env.COWORK_USER_DATA_DIR = path.join(tempDir, "db");
    for (const folder of [
      "Projects/site",
      "Projects/api",
      ".config/tool",
      ".ssh",
      "repo/.git/hooks",
      "repo/.cowork/policy",
      "repo/.cowork/notes",
      "repo/src",
      "CoWork Data/profiles/default",
      "CoWork Data/browser-workspaces/made-in-browser/docs",
    ]) {
      await fs.mkdir(path.join(home, folder), { recursive: true });
    }
    await fs.mkdir(path.join(tempDir, "outside/secret"), { recursive: true });
    await fs.mkdir(path.join(tempDir, "elsewhere/shared/reports"), { recursive: true });
    await fs.writeFile(path.join(home, "notes.txt"), "not a folder");
    await fs.symlink(path.join(tempDir, "outside"), path.join(home, "outside-link"));
    await fs.symlink(path.join(home, "Projects"), path.join(home, "projects-link"));
    manager = new DatabaseManager();
    workspaces = new WorkspaceRepository(manager.getDatabase());
    unreadableWorkspaceIds = new Set();
    defs = definitions();
  });

  afterEach(async () => {
    manager?.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function definitions() {
    return createBrowserHostFolderDefinitions({
      workspaces,
      resolveWorkspace: async (workspaceId) => {
        const found = await workspaces.findById(workspaceId);
        if (!found) return null;
        return unreadableWorkspaceIds.has(workspaceId)
          ? { ...found, permissions: { ...found.permissions, read: false } }
          : found;
      },
      getDataRoot: () => dataRoot,
    });
  }

  async function invoke(name: string, args: unknown[]): Promise<unknown> {
    const definition = defs[name];
    return definition.handler(definition.validate ? definition.validate(args) : args, {} as never);
  }

  const list = (request?: unknown) =>
    invoke("listHostFolders", request === undefined ? [] : [request]) as Promise<HostFolderListing>;
  const choose = (selection: unknown) =>
    invoke("openHostFolderWorkspace", [selection]) as Promise<Workspace>;
  const userWorkspaces = async () =>
    (await workspaces.findAll()).filter(
      (workspace) => !workspace.isTemp && !isTempWorkspaceId(workspace.id),
    );

  it("declares a read listing and a keyed selection under workspaces.select", () => {
    const service = new BrowserDesktopRpcService(definitions());
    expect(service.manifest).toEqual({
      listHostFolders: { mutation: false },
      openHostFolderWorkspace: { mutation: true },
    });
    expect([...service.capabilities]).toEqual(["workspaces.select"]);
  });

  it("starts at home and lists only visible, unprotected child folders", async () => {
    const listing = await list();
    expect(listing).toMatchObject({ rootId: "home", path: [], displayPath: "~", truncated: false });
    // Files, dot folders, the CoWork data folder and a link leaving home are left out;
    // a link that stays inside home is kept.
    expect(listing.folders).toEqual(["Projects", "projects-link", "repo"]);
    expect(listing.roots).toEqual([{ id: "home", kind: "home", label: "Home" }]);
    expect(JSON.stringify(listing)).not.toContain(tempDir);
  });

  it("shows hidden folders on request but never protected ones", async () => {
    const atHome = await list({ includeHidden: true });
    expect(atHome.folders).toContain(".config");
    expect(atHome.folders).not.toContain(".ssh");
    expect(atHome.folders).not.toContain("CoWork Data");

    const inRepo = await list({ rootId: "home", path: ["repo"], includeHidden: true });
    expect(inRepo.folders).toEqual([".cowork", "src"]);
    const inCowork = await list({ rootId: "home", path: ["repo", ".cowork"], includeHidden: true });
    expect(inCowork.folders).toEqual(["notes"]);
  });

  it("refuses to open protected, escaping, missing or non-folder paths", async () => {
    for (const segments of [
      [".ssh"],
      ["repo", ".git"],
      ["repo", ".git", "hooks"],
      ["repo", ".cowork", "policy"],
      ["CoWork Data"],
      ["CoWork Data", "profiles"],
      ["outside-link"],
      ["outside-link", "secret"],
      ["missing"],
      ["notes.txt"],
    ]) {
      await expect(list({ rootId: "home", path: segments })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(choose({ rootId: "home", path: segments })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    }
    expect(await userWorkspaces()).toEqual([]);
  });

  it("rejects traversal and malformed requests before touching the filesystem", () => {
    const { listHostFolders, openHostFolderWorkspace } = definitions();
    const invalid = [
      { rootId: "home", path: [".."] },
      { rootId: "home", path: ["."] },
      { rootId: "home", path: [""] },
      { rootId: "home", path: ["Projects/site"] },
      { rootId: "home", path: ["Projects\\site"] },
      { rootId: "home", path: [path.join(tempDir, "outside")] },
      { rootId: "home", path: [`bad${String.fromCharCode(0)}name`] },
      { rootId: "home", path: ["x".repeat(256)] },
      { rootId: "home", path: Array.from({ length: HOST_FOLDER_MAX_SEGMENTS + 1 }, () => "a") },
      { rootId: "home", path: "Projects" },
      { rootId: "/", path: [] },
      { rootId: "workspace:../etc", path: [] },
      { rootId: "home", path: [], extra: true },
    ];
    for (const request of invalid) {
      expect(() => listHostFolders.validate!([request])).toThrow(
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
      expect(() => openHostFolderWorkspace.validate!([request])).toThrow(
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
    }
    expect(() => listHostFolders.validate!([{ path: ["Projects"] }])).toThrow(
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(() => listHostFolders.validate!([{ includeHidden: "yes" }])).toThrow(
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("caps the folders returned for one folder", async () => {
    const crowded = path.join(home, "crowded");
    await fs.mkdir(crowded);
    await Promise.all(
      Array.from({ length: HOST_FOLDER_MAX_FOLDERS + 20 }, (_, index) =>
        fs.mkdir(path.join(crowded, `folder-${String(index).padStart(4, "0")}`)),
      ),
    );
    const listing = await list({ rootId: "home", path: ["crowded"] });
    expect(listing.folders).toHaveLength(HOST_FOLDER_MAX_FOLDERS);
    expect(listing.folders[0]).toBe("folder-0000");
    expect(listing.truncated).toBe(true);
  });

  it("offers readable workspaces as starting points, including ones outside home", async () => {
    const shared = await workspaces.create(
      "Shared drive",
      path.join(tempDir, "elsewhere/shared"),
      PERMISSIONS,
    );
    const hidden = await workspaces.create("Hidden", path.join(tempDir, "elsewhere"), PERMISSIONS);
    unreadableWorkspaceIds.add(hidden.id);
    await workspaces.create("System", "/usr/bin", PERMISSIONS);
    const browserProject = await workspaces.create(
      "Made in browser",
      path.join(dataRoot, "browser-workspaces/made-in-browser"),
      PERMISSIONS,
    );

    const listing = await list();
    expect(listing.roots.map((root) => root.id).sort()).toEqual(
      ["home", `workspace:${shared.id}`, `workspace:${browserProject.id}`].sort(),
    );
    expect(await list({ rootId: `workspace:${shared.id}`, path: [] })).toMatchObject({
      displayPath: "Shared drive",
      folders: ["reports"],
    });
    // A project the host created inside its data folder stays browsable from its own root.
    expect(await list({ rootId: `workspace:${browserProject.id}`, path: [] })).toMatchObject({
      folders: ["docs"],
    });
    await expect(list({ rootId: `workspace:${hidden.id}`, path: [] })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("opens near a workspace: inside home by its path, otherwise at its own root", async () => {
    const site = await workspaces.create("Site", path.join(home, "Projects/site"), PERMISSIONS);
    const shared = await workspaces.create(
      "Shared drive",
      path.join(tempDir, "elsewhere/shared"),
      PERMISSIONS,
    );
    expect(await list({ startWorkspaceId: site.id })).toMatchObject({
      rootId: "home",
      path: ["Projects", "site"],
      displayPath: ["~", "Projects", "site"].join(path.sep),
    });
    expect(await list({ startWorkspaceId: shared.id })).toMatchObject({
      rootId: `workspace:${shared.id}`,
      path: [],
    });
    expect(await list({ startWorkspaceId: "missing-workspace" })).toMatchObject({
      rootId: "home",
      path: [],
    });
  });

  it("adds a workspace for a new folder once and returns it on later choices", async () => {
    const [first, second] = await Promise.all([
      choose({ rootId: "home", path: ["Projects", "api"] }),
      choose({ rootId: "home", path: ["Projects", "api"] }),
    ]);
    expect(first).toMatchObject({
      name: "api",
      path: path.join(home, "Projects/api"),
      permissions: { read: true, write: true, delete: false, network: true, shell: false },
    });
    expect(second.id).toBe(first.id);
    // Choosing the same folder through a link inside home finds the same workspace.
    expect((await choose({ rootId: "home", path: ["projects-link", "api"] })).id).toBe(first.id);
    expect(await userWorkspaces()).toHaveLength(1);
  });

  it("returns an existing workspace and refuses one the session cannot read", async () => {
    const site = new WorkspaceStore(manager.getDatabase()).create(
      "My site",
      path.join(home, "Projects/site"),
      PERMISSIONS,
    );
    expect(await choose({ rootId: "home", path: ["Projects", "site"] })).toMatchObject({
      id: site.id,
      name: "My site",
    });
    unreadableWorkspaceIds.add(site.id);
    await expect(choose({ rootId: "home", path: ["Projects", "site"] })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("removes a new workspace again when the session's policy leaves it unreadable", async () => {
    const definition = createBrowserHostFolderDefinitions({
      workspaces,
      resolveWorkspace: async (workspaceId) => {
        const found = await workspaces.findById(workspaceId);
        return found ? { ...found, permissions: { ...found.permissions, read: false } } : null;
      },
      getDataRoot: () => dataRoot,
    }).openHostFolderWorkspace;
    await expect(
      definition.handler(definition.validate!([{ rootId: "home", path: ["repo"] }]), {} as never),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await userWorkspaces()).toEqual([]);
  });
});
