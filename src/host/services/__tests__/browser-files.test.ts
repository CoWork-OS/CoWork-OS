import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";
import type { Workspace } from "../../../shared/types";
import type { WebRequestContext } from "../../web/WebApplication";
import {
  BrowserWorkspaceFiles,
  createBrowserWorkspaceFileMethods,
  type BrowserWorkspaceFilesOptions,
} from "../browser-files";

const context: WebRequestContext = {
  audience: "control-plane",
  identity: {
    installationId: "install-opaque",
    profileId: "profile-opaque",
    generation: "generation-1",
    runtime: "node",
    platform: "linux",
    appVersion: "test",
  },
  sessionId: "session-opaque",
};

describe("BrowserWorkspaceFiles", () => {
  let tempRoot: string;
  let workspaceRoot: string;
  let workspace: Workspace;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-browser-files-"));
    workspaceRoot = path.join(tempRoot, "workspace");
    await fs.mkdir(workspaceRoot);
    workspace = {
      id: "workspace-1",
      name: "Fixture workspace",
      path: workspaceRoot,
      createdAt: Date.now(),
      permissions: {
        read: true,
        write: false,
        delete: false,
        network: false,
        shell: false,
      },
    };
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("lists bounded, workspace-relative entries without returning host paths", async () => {
    await fs.mkdir(path.join(workspaceRoot, "docs"));
    await fs.writeFile(path.join(workspaceRoot, "docs", "a.txt"), "a");
    await fs.writeFile(path.join(workspaceRoot, "docs", "b.txt"), "bb");
    await fs.writeFile(path.join(workspaceRoot, "docs", "c.txt"), "ccc");
    const files = createService({ maxEntries: 2 });

    const listing = await files.list(context, { workspaceId: workspace.id, relativePath: "docs" });

    expect(listing).toEqual({
      workspaceId: workspace.id,
      relativePath: "docs",
      entries: [
        { name: "a.txt", relativePath: "docs/a.txt", type: "file", size: 1 },
        { name: "b.txt", relativePath: "docs/b.txt", type: "file", size: 2 },
      ],
      truncated: true,
    });
    expect(JSON.stringify(listing)).not.toContain(workspaceRoot);
  });

  it("filters entries denied by the effective workspace filesystem profile", async () => {
    await fs.writeFile(path.join(workspaceRoot, "public.txt"), "visible");
    await fs.writeFile(path.join(workspaceRoot, "private.txt"), "hidden");
    workspace.permissions.accessFilesystemRules = [{ path: "private.txt", access: "deny" }];
    const files = createService();

    const listing = await files.list(context, { workspaceId: workspace.id, relativePath: "" });

    expect(listing.entries.map((entry) => entry.name)).toEqual(["public.txt"]);
  });

  it("rejects denied workspaces, temporary workspaces, and traversal paths", async () => {
    const files = createService();
    const deniedWorkspace = {
      ...workspace,
      permissions: { ...workspace.permissions, read: false },
    };
    const deniedFiles = createService({ resolveWorkspace: () => deniedWorkspace });
    await expect(
      deniedFiles.list(context, { workspaceId: workspace.id, relativePath: "" }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      files.list(context, { workspaceId: "__temp_workspace__:ephemeral", relativePath: "" }),
    ).rejects.toMatchObject({ statusCode: 404 });

    for (const relativePath of [
      "../outside.txt",
      "/etc/passwd",
      "C:/secret",
      "a//b",
      "a/./b",
      "a/../b",
      "a\\b",
    ]) {
      await expect(
        files.list(context, { workspaceId: workspace.id, relativePath }),
      ).rejects.toMatchObject({ statusCode: 400 });
    }
    await expect(
      files.list(context, { workspaceId: workspace.id, relativePath: "%2e%2e/outside.txt" }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it.skipIf(process.platform === "win32")(
    "does not follow workspace symlinks outside the canonical root",
    async () => {
      const outsideFile = path.join(tempRoot, "outside.txt");
      await fs.writeFile(outsideFile, "outside secret");
      await fs.symlink(outsideFile, path.join(workspaceRoot, "escape.txt"));
      const files = createService();

      const listing = await files.list(context, { workspaceId: workspace.id, relativePath: "" });
      expect(listing.entries).toEqual([]);
      await expect(
        files.list(context, { workspaceId: workspace.id, relativePath: "escape.txt" }),
      ).rejects.toMatchObject({ statusCode: 404 });
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a directory symlink replacement between validation and open",
    async () => {
      const sourceDirectory = path.join(workspaceRoot, "reports");
      const movedDirectory = path.join(workspaceRoot, "reports-original");
      const outsideDirectory = path.join(tempRoot, "outside");
      await fs.mkdir(sourceDirectory);
      await fs.mkdir(outsideDirectory);
      await fs.writeFile(path.join(sourceDirectory, "summary.txt"), "inside");
      await fs.writeFile(path.join(outsideDirectory, "summary.txt"), "outside secret");

      let swapped = false;
      let openedHandle: fs.FileHandle | undefined;
      const files = new (class extends BrowserWorkspaceFiles {
        protected override async openReadHandle(filePath: string, flags: number) {
          if (!swapped) {
            swapped = true;
            await fs.rename(sourceDirectory, movedDirectory);
            await fs.symlink(outsideDirectory, sourceDirectory, "dir");
          }
          openedHandle = await fs.open(filePath, flags || fsConstants.O_RDONLY);
          return openedHandle;
        }
      })(serviceOptions());
      const server = await startDownloadServer(files);
      try {
        const response = await postDownload(server.url, workspace.id, "reports/summary.txt");
        expect(swapped).toBe(true);
        expect(response.status).toBe(404);
        expect(await response.text()).not.toContain("outside secret");
        await expect(openedHandle?.stat()).rejects.toThrow();
      } finally {
        await closeServer(server.server);
      }
    },
  );

  it("streams an authorized file over the dedicated HTTP helper", async () => {
    const fileName = "résumé.csv";
    const content = "name,value\nAda,42\n";
    await fs.writeFile(path.join(workspaceRoot, fileName), content);
    const files = createService();
    const server = await startDownloadServer(files);
    try {
      const response = await fetch(`${server.url}/api/web/v1/workspace-files/download`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: workspace.id, relativePath: fileName }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
      expect(response.headers.get("content-disposition")).toContain(
        "filename*=UTF-8''r%C3%A9sum%C3%A9.csv",
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toBe(content);
    } finally {
      await closeServer(server.server);
    }
  });

  it("times out an incomplete workspace download request and closes its connection", async () => {
    const files = createService({ requestBodyTimeoutMs: 25 });
    const server = await startDownloadServer(files);
    try {
      const response = await postIncompleteJsonRequest(
        server.url,
        "/api/web/v1/workspace-files/download",
      );
      expect(response.status).toBe(408);
      expect(response.headers.connection).toBe("close");
      expect(JSON.parse(response.body).error.message).toBe("Request body timed out.");
    } finally {
      await closeServer(server.server);
    }
  });

  it.skipIf(process.platform === "win32")(
    "rejects external symlink downloads and files above the configured content bound",
    async () => {
      const outsideFile = path.join(tempRoot, "secret.txt");
      await fs.writeFile(outsideFile, "outside secret");
      await fs.symlink(outsideFile, path.join(workspaceRoot, "escape.txt"));
      await fs.writeFile(path.join(workspaceRoot, "large.txt"), "12345");
      const files = createService({ maxDownloadBytes: 4 });
      const server = await startDownloadServer(files);
      try {
        const escape = await postDownload(server.url, workspace.id, "escape.txt");
        expect(escape.status).toBe(404);
        expect(await escape.text()).not.toContain("outside secret");

        const large = await postDownload(server.url, workspace.id, "large.txt");
        expect(large.status).toBe(413);
        expect(await large.text()).not.toContain("12345");
      } finally {
        await closeServer(server.server);
      }
    },
  );

  it("closes the opened file when the browser cancels a streamed download", async () => {
    const fileName = "large.bin";
    const file = await fs.open(path.join(workspaceRoot, fileName), "w");
    await file.truncate(16 * 1024 * 1024);
    await file.close();
    const files = new (class extends BrowserWorkspaceFiles {
      openedHandle?: fs.FileHandle;

      protected override async openReadHandle(filePath: string, flags: number) {
        this.openedHandle = await super.openReadHandle(filePath, flags);
        return this.openedHandle;
      }
    })(serviceOptions());
    const server = await startDownloadServer(files);
    try {
      await new Promise<void>((resolve, reject) => {
        const request = http.request(
          `${server.url}/api/web/v1/workspace-files/download`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
          },
          (response) => {
            response.destroy();
            resolve();
          },
        );
        request.once("error", reject);
        request.end(JSON.stringify({ workspaceId: workspace.id, relativePath: fileName }));
      });
      expect(files.openedHandle).toBeDefined();
      await waitForHandleToClose(files.openedHandle!);
    } finally {
      await closeServer(server.server);
    }
  });

  it("requires the files.read capability and keeps the route body bounded", async () => {
    const disabled = createService({ capabilitiesAvailable: false });
    await expect(
      disabled.list(context, { workspaceId: workspace.id, relativePath: "" }),
    ).rejects.toMatchObject({ statusCode: 403 });

    await fs.writeFile(path.join(workspaceRoot, "secret.txt"), "secret");
    const disabledServer = await startDownloadServer(disabled);
    try {
      const response = await postDownload(disabledServer.url, workspace.id, "secret.txt");
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain("secret");
    } finally {
      await closeServer(disabledServer.server);
    }

    const smallBodyLimit = createService({ maxRequestBytes: 256 });
    const server = await startDownloadServer(smallBodyLimit);
    try {
      const response = await fetch(`${server.url}/api/web/v1/workspace-files/download`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId: workspace.id,
          relativePath: "a".repeat(300),
        }),
      });
      expect(response.status).toBe(413);
    } finally {
      await closeServer(server.server);
    }
  });

  it("streams one authorized raw upload into a new workspace file atomically", async () => {
    workspace.permissions.write = true;
    await fs.mkdir(path.join(workspaceRoot, "incoming"));
    const files = createService();
    const server = await startDownloadServer(files);
    const content = Buffer.from("name,value\nAda,42\n", "utf8");
    try {
      const response = await postUpload(server.url, workspace.id, "incoming/résumé.csv", content);

      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({
        apiVersion: 1,
        workspaceId: workspace.id,
        relativePath: "incoming/résumé.csv",
        size: content.length,
        sha256: createHash("sha256").update(content).digest("hex"),
      });
      expect(await fs.readFile(path.join(workspaceRoot, "incoming", "résumé.csv"))).toEqual(
        content,
      );
      expect(await fs.readdir(path.join(workspaceRoot, "incoming"))).toEqual(["résumé.csv"]);
    } finally {
      await closeServer(server.server);
    }
  });

  it("requires upload capability, workspace write permission, and effective write access", async () => {
    workspace.permissions.write = true;
    const noCapability = createService({ uploadCapabilitiesAvailable: false });
    const noCapabilityServer = await startDownloadServer(noCapability);
    try {
      const response = await postUpload(
        noCapabilityServer.url,
        workspace.id,
        "blocked.txt",
        Buffer.from("secret"),
      );
      expect(response.status).toBe(403);
      expect(await fs.readdir(workspaceRoot)).toEqual([]);
    } finally {
      await closeServer(noCapabilityServer.server);
    }

    workspace.permissions.write = false;
    const readOnly = createService();
    const readOnlyServer = await startDownloadServer(readOnly);
    try {
      const response = await postUpload(
        readOnlyServer.url,
        workspace.id,
        "blocked.txt",
        Buffer.from("secret"),
      );
      expect(response.status).toBe(404);
      expect(await fs.readdir(workspaceRoot)).toEqual([]);
    } finally {
      await closeServer(readOnlyServer.server);
    }

    workspace.permissions.write = true;
    workspace.permissions.accessFilesystemRules = [{ path: "private.txt", access: "deny" }];
    const deniedPath = createService();
    const deniedPathServer = await startDownloadServer(deniedPath);
    try {
      const response = await postUpload(
        deniedPathServer.url,
        workspace.id,
        "private.txt",
        Buffer.from("secret"),
      );
      expect(response.status).toBe(404);
      expect(await fs.readdir(workspaceRoot)).toEqual([]);
    } finally {
      await closeServer(deniedPathServer.server);
    }
  });

  it("requires an explicit create-only precondition and never overwrites existing files", async () => {
    workspace.permissions.write = true;
    await fs.writeFile(path.join(workspaceRoot, "existing.txt"), "original");
    const files = createService();
    const server = await startDownloadServer(files);
    try {
      const missingPrecondition = await postUpload(
        server.url,
        workspace.id,
        "new.txt",
        Buffer.from("new"),
        { "if-none-match": "" },
      );
      expect(missingPrecondition.status).toBe(428);

      const conflict = await postUpload(
        server.url,
        workspace.id,
        "existing.txt",
        Buffer.from("replacement"),
      );
      expect(conflict.status).toBe(409);
      expect(await fs.readFile(path.join(workspaceRoot, "existing.txt"), "utf8")).toBe("original");
      expect((await fs.readdir(workspaceRoot)).sort()).toEqual(["existing.txt"]);
    } finally {
      await closeServer(server.server);
    }
  });

  it("rejects traversal, symlink targets, and symlinked parent directories", async () => {
    workspace.permissions.write = true;
    const outside = path.join(tempRoot, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "secret.txt"), "outside");
    await fs.symlink(outside, path.join(workspaceRoot, "linked"), "dir");
    await fs.symlink(path.join(outside, "secret.txt"), path.join(workspaceRoot, "target.txt"));
    const files = createService();
    const server = await startDownloadServer(files);
    try {
      for (const relativePath of ["../escape.txt", "linked/new.txt", "target.txt"]) {
        const response = await postUpload(
          server.url,
          workspace.id,
          relativePath,
          Buffer.from("replacement"),
        );
        expect([400, 404, 409]).toContain(response.status);
      }
      expect(await fs.readFile(path.join(outside, "secret.txt"), "utf8")).toBe("outside");
      expect((await fs.readdir(outside)).sort()).toEqual(["secret.txt"]);
    } finally {
      await closeServer(server.server);
    }
  });

  it("enforces per-file and active workspace byte limits and cleans the staging file", async () => {
    workspace.permissions.write = true;
    const sizeLimited = createService({ maxUploadBytes: 4 });
    const sizeServer = await startDownloadServer(sizeLimited);
    try {
      const response = await postChunkedUpload(
        sizeServer.url,
        workspace.id,
        "too-large.bin",
        Buffer.from("12345"),
      );
      expect(response.status).toBe(413);
      expect(await fs.readdir(workspaceRoot)).toEqual([]);
    } finally {
      await closeServer(sizeServer.server);
    }

    let openedHandle: fs.FileHandle | undefined;
    let notifyOpened: (() => void) | undefined;
    const opened = new Promise<void>((resolve) => {
      notifyOpened = resolve;
    });
    const quotaService = new (class extends BrowserWorkspaceFiles {
      protected override async openUploadTempHandle(filePath: string, flags: number, mode: number) {
        openedHandle = await super.openUploadTempHandle(filePath, flags, mode);
        notifyOpened?.();
        return openedHandle;
      }
    })(serviceOptions({ maxUploadBytes: 16, maxWorkspaceActiveUploadBytes: 4 }));
    const quotaServer = await startDownloadServer(quotaService);
    const firstRequest = http.request(`${quotaServer.url}/api/web/v1/workspace-files/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-cowork-workspace-id": workspace.id,
        "x-cowork-relative-path": "in-flight.bin",
        "if-none-match": "*",
      },
    });
    firstRequest.on("error", () => undefined);
    const firstResponse = new Promise<number>((resolve, reject) => {
      firstRequest.once("response", (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode || 500));
        response.once("error", reject);
      });
      firstRequest.once("error", reject);
    });
    try {
      firstRequest.write(Buffer.from("1234"));
      await opened;
      await waitForFileSize(openedHandle!, 4);

      const secondResponse = await postUpload(
        quotaServer.url,
        workspace.id,
        "over-quota.bin",
        Buffer.from("5"),
      );
      expect(secondResponse.status).toBe(429);
      firstRequest.end();
      expect(await firstResponse).toBe(201);
      expect(await fs.readFile(path.join(workspaceRoot, "in-flight.bin"), "utf8")).toBe("1234");
      expect((await fs.readdir(workspaceRoot)).sort()).toEqual(["in-flight.bin"]);
    } finally {
      firstRequest.destroy();
      await closeServer(quotaServer.server);
    }
  });

  it("removes partial staging data when an upload is cancelled", async () => {
    workspace.permissions.write = true;
    let openedHandle: fs.FileHandle | undefined;
    let notifyOpened: (() => void) | undefined;
    const opened = new Promise<void>((resolve) => {
      notifyOpened = resolve;
    });
    const files = new (class extends BrowserWorkspaceFiles {
      protected override async openUploadTempHandle(filePath: string, flags: number, mode: number) {
        openedHandle = await super.openUploadTempHandle(filePath, flags, mode);
        notifyOpened?.();
        return openedHandle;
      }
    })(serviceOptions());
    const server = await startDownloadServer(files);
    const request = http.request(`${server.url}/api/web/v1/workspace-files/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-cowork-workspace-id": workspace.id,
        "x-cowork-relative-path": "partial.bin",
        "if-none-match": "*",
      },
    });
    request.on("error", () => undefined);
    try {
      request.write(Buffer.alloc(256 * 1024, 7));
      await opened;
      await waitForFileSize(openedHandle!, 1);
      request.destroy();
      await waitForHandleToClose(openedHandle!);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await fs.readdir(workspaceRoot)).toEqual([]);
    } finally {
      request.destroy();
      await closeServer(server.server);
    }
  });

  it("times out a stalled upload and releases its staging file and active byte quota", async () => {
    workspace.permissions.write = true;
    let openedHandle: fs.FileHandle | undefined;
    let notifyOpened: (() => void) | undefined;
    const opened = new Promise<void>((resolve) => {
      notifyOpened = resolve;
    });
    const files = new (class extends BrowserWorkspaceFiles {
      protected override async openUploadTempHandle(filePath: string, flags: number, mode: number) {
        openedHandle = await super.openUploadTempHandle(filePath, flags, mode);
        notifyOpened?.();
        return openedHandle;
      }
    })(serviceOptions({ uploadBodyTimeoutMs: 50, maxWorkspaceActiveUploadBytes: 4 }));
    const server = await startDownloadServer(files);
    const request = http.request(`${server.url}/api/web/v1/workspace-files/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "content-length": "8",
        "x-cowork-workspace-id": workspace.id,
        "x-cowork-relative-path": "stalled.bin",
        "if-none-match": "*",
      },
    });
    request.on("error", () => undefined);
    const timeoutResponse = new Promise<number>((resolve, reject) => {
      let receivedResponse = false;
      request.once("response", (response) => {
        receivedResponse = true;
        response.resume();
        response.once("end", () => resolve(response.statusCode || 500));
        response.once("error", reject);
      });
      request.once("error", (error) => {
        if (!receivedResponse) reject(error);
      });
    });
    try {
      request.write(Buffer.from("1234"));
      await opened;
      await waitForFileSize(openedHandle!, 4);

      expect(await timeoutResponse).toBe(408);
      await waitForHandleToClose(openedHandle!);
      expect(await fs.readdir(workspaceRoot)).toEqual([]);

      const afterTimeout = await postUpload(
        server.url,
        workspace.id,
        "after-timeout.bin",
        Buffer.from("5678"),
      );
      expect(afterTimeout.status).toBe(201);
      expect(await fs.readFile(path.join(workspaceRoot, "after-timeout.bin"), "utf8")).toBe("5678");
    } finally {
      request.destroy();
      await closeServer(server.server);
    }
  });

  it.skipIf(process.platform === "win32")(
    "fails closed when the destination directory is swapped for an external symlink before staging",
    async () => {
      workspace.permissions.write = true;
      const destinationDirectory = path.join(workspaceRoot, "reports");
      const movedDirectory = path.join(workspaceRoot, "reports-original");
      const outsideDirectory = path.join(tempRoot, "outside-race");
      await fs.mkdir(destinationDirectory);
      await fs.mkdir(outsideDirectory);
      const files = new (class extends BrowserWorkspaceFiles {
        private swapped = false;

        protected override async openUploadTempHandle(
          filePath: string,
          flags: number,
          mode: number,
        ) {
          if (!this.swapped) {
            this.swapped = true;
            await fs.rename(destinationDirectory, movedDirectory);
            await fs.symlink(outsideDirectory, destinationDirectory, "dir");
          }
          return super.openUploadTempHandle(filePath, flags, mode);
        }
      })(serviceOptions());
      const server = await startDownloadServer(files);
      try {
        const response = await postUpload(
          server.url,
          workspace.id,
          "reports/summary.txt",
          Buffer.from("must not escape"),
        );
        expect(response.status).toBe(404);
        expect(await fs.readdir(outsideDirectory)).toEqual([]);
        expect(await fs.readdir(movedDirectory)).toEqual([]);
      } finally {
        await closeServer(server.server);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "hides reserved staging files and symlink aliases, denies their downloads, and reaps stale temps",
    async () => {
      workspace.permissions.write = true;
      const tempName = ".cowork-upload-00000000-0000-4000-8000-000000000000.tmp";
      const tempPath = path.join(workspaceRoot, tempName);
      const aliasPath = path.join(workspaceRoot, "partial-alias.txt");
      await fs.writeFile(tempPath, "partial secret");
      await fs.symlink(tempPath, aliasPath);
      const files = createService();

      const listing = await files.list(context, {
        workspaceId: workspace.id,
        relativePath: "",
      });
      expect(listing.entries).toEqual([]);

      const server = await startDownloadServer(files);
      try {
        const directDownload = await postDownload(server.url, workspace.id, tempName);
        expect(directDownload.status).toBe(400);
        const aliasDownload = await postDownload(server.url, workspace.id, "partial-alias.txt");
        expect(aliasDownload.status).toBe(404);
        expect(await aliasDownload.text()).not.toContain("partial secret");

        const staleTime = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
        await fs.utimes(tempPath, staleTime, staleTime);
        const upload = await postUpload(
          server.url,
          workspace.id,
          "complete.txt",
          Buffer.from("complete"),
        );
        expect(upload.status).toBe(201);
        await expect(fs.lstat(tempPath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await closeServer(server.server);
      }
    },
  );

  it("registers only metadata listing in generic RPC and uses a fixed download route", async () => {
    const files = createService();
    const methods = createBrowserWorkspaceFileMethods(files);
    expect(Object.keys(methods)).toEqual(["workspace.files.list"]);
    expect(methods["workspace.files.list"].capability).toBe("files.read");

    const server = await startDownloadServer(files);
    try {
      const response = await fetch(
        `${server.url}/api/web/v1/workspace-files/download?path=secret`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workspaceId: workspace.id, relativePath: "missing.txt" }),
        },
      );
      expect(response.status).toBe(400);
      expect(response.headers.get("content-disposition")).toBeNull();
    } finally {
      await closeServer(server.server);
    }
  });

  function createService(
    overrides: Partial<BrowserWorkspaceFilesOptions> & {
      capabilitiesAvailable?: boolean;
      uploadCapabilitiesAvailable?: boolean;
    } = {},
  ): BrowserWorkspaceFiles {
    const {
      capabilitiesAvailable = true,
      uploadCapabilitiesAvailable = true,
      ...options
    } = overrides;
    return new BrowserWorkspaceFiles(
      serviceOptions({
        ...options,
        capabilitiesAvailable,
        uploadCapabilitiesAvailable,
      }),
    );
  }

  function serviceOptions(
    overrides: Partial<BrowserWorkspaceFilesOptions> & {
      capabilitiesAvailable?: boolean;
      uploadCapabilitiesAvailable?: boolean;
    } = {},
  ): BrowserWorkspaceFilesOptions {
    const {
      capabilitiesAvailable = true,
      uploadCapabilitiesAvailable = true,
      ...options
    } = overrides;
    return {
      resolveWorkspace: () => workspace,
      getCapabilities: () => ({
        "files.read": { available: capabilitiesAvailable },
        "files.upload": { available: uploadCapabilitiesAvailable },
      }),
      ...options,
    };
  }
});

async function startDownloadServer(files: BrowserWorkspaceFiles): Promise<{
  server: http.Server;
  url: string;
}> {
  const server = http.createServer((req, res) => {
    void files
      .handleUploadRequest(context, req, res)
      .then((uploadHandled) =>
        uploadHandled ? true : files.handleDownloadRequest(context, req, res),
      )
      .then((handled) => {
        if (!handled && !res.writableEnded) {
          res.writeHead(404);
          res.end();
        }
      })
      .catch(() => {
        if (!res.headersSent && !res.writableEnded) {
          res.writeHead(500);
          res.end();
        }
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind.");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function waitForHandleToClose(handle: fs.FileHandle): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await handle.stat();
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Browser download did not release its file handle after disconnect.");
}

async function postDownload(
  baseUrl: string,
  workspaceId: string,
  relativePath: string,
): Promise<Response> {
  return fetch(`${baseUrl}/api/web/v1/workspace-files/download`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId, relativePath }),
  });
}

function postIncompleteJsonRequest(
  baseUrl: string,
  route: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    let responseReceived = false;
    const request = http.request(`${baseUrl}${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "128",
      },
      agent: false,
    });
    request.once("response", (response) => {
      responseReceived = true;
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => {
        clearTimeout(timer);
        resolve({
          status: response.statusCode || 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
      response.once("error", reject);
    });
    const timer = setTimeout(() => {
      request.destroy();
      reject(new Error("The incomplete workspace JSON request did not receive a response."));
    }, 2_000);
    request.once("error", (error) => {
      if (!responseReceived) {
        clearTimeout(timer);
        reject(error);
      }
    });
    request.write('{"workspaceId":');
  });
}

async function postUpload(
  baseUrl: string,
  workspaceId: string,
  relativePath: string,
  content: Buffer,
  additionalHeaders: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}/api/web/v1/workspace-files/upload`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-cowork-workspace-id": workspaceId,
      "x-cowork-relative-path": encodeURIComponent(relativePath),
      "if-none-match": "*",
      ...additionalHeaders,
    },
    body: new Uint8Array(content),
  });
}

async function postChunkedUpload(
  baseUrl: string,
  workspaceId: string,
  relativePath: string,
  content: Buffer,
): Promise<Response> {
  return await new Promise<Response>((resolve, reject) => {
    const request = http.request(`${baseUrl}/api/web/v1/workspace-files/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "transfer-encoding": "chunked",
        "x-cowork-workspace-id": workspaceId,
        "x-cowork-relative-path": encodeURIComponent(relativePath),
        "if-none-match": "*",
      },
    });
    request.once("error", reject);
    request.once("response", (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("error", reject);
      response.once("end", () =>
        resolve(
          new Response(Buffer.concat(chunks), {
            status: response.statusCode || 500,
            headers: response.headers as HeadersInit,
          }),
        ),
      );
    });
    request.end(content);
  });
}

async function waitForFileSize(handle: fs.FileHandle, minimum: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      if ((await handle.stat()).size >= minimum) return;
    } catch {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Browser upload did not write its first chunk before cancellation.");
}
