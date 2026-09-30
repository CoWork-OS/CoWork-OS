import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";
import type { Artifact, ArtifactRevision, Task, Workspace } from "../../../shared/types";
import type { WebRequestContext } from "../../web/WebApplication";
import {
  BROWSER_ARTIFACT_DOWNLOAD_PATH,
  BrowserArtifacts,
  createBrowserArtifactMethods,
  type BrowserArtifactsOptions,
} from "../browser-artifacts";

const context: WebRequestContext = {
  audience: "control-plane",
  identity: {
    installationId: "opaque-installation",
    profileId: "opaque-profile",
    generation: "generation-a",
    runtime: "node",
    platform: "linux",
    appVersion: "test",
  },
  sessionId: "browser-session-a",
};

describe("BrowserArtifacts", () => {
  let tempRoot: string;
  let workspaceRoot: string;
  let workspace: Workspace;
  let task: Pick<Task, "id" | "workspaceId">;
  let artifact: Artifact;
  let artifactContent: Buffer;
  let revision: ArtifactRevision | undefined;
  let capabilityAvailable: boolean;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-browser-artifacts-"));
    workspaceRoot = path.join(tempRoot, "workspace");
    await fs.mkdir(workspaceRoot);
    await fs.mkdir(path.join(workspaceRoot, "output"));
    artifactContent = Buffer.from("0123456789");
    const artifactPath = path.join(workspaceRoot, "output", "report.txt");
    await fs.writeFile(artifactPath, artifactContent);
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
    task = { id: "task-1", workspaceId: workspace.id };
    artifact = {
      id: "artifact-1",
      taskId: task.id,
      path: artifactPath,
      mimeType: "text/plain",
      sha256: sha256(artifactContent),
      size: artifactContent.byteLength,
      createdAt: Date.now(),
    };
    revision = undefined;
    capabilityAvailable = true;
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("lists a bounded page with safe metadata and no host path", async () => {
    const second = await createArtifact("chart.csv", Buffer.from("x,y\n1,2"), "text/csv");
    const third = await createArtifact("notes.md", Buffer.from("notes"), "text/markdown");
    const files = createService({
      listTaskArtifacts: async (request) => {
        const rows = [artifact, second, third];
        return {
          task,
          workspace,
          artifacts: rows.slice(request.offset, request.offset + request.limit + 1),
          hasMore: request.offset + request.limit < rows.length,
        };
      },
    });

    const listing = await files.listTaskArtifacts(context, {
      taskId: task.id,
      workspaceId: workspace.id,
      limit: 2,
      offset: 0,
    });

    expect(listing).toEqual({
      taskId: task.id,
      workspaceId: workspace.id,
      artifacts: [
        {
          artifactId: artifact.id,
          name: "report.txt",
          mimeType: "text/plain",
          size: artifact.size,
          createdAt: artifact.createdAt,
        },
        {
          artifactId: second.id,
          name: "chart.csv",
          mimeType: "text/csv",
          size: second.size,
          createdAt: second.createdAt,
        },
      ],
      limit: 2,
      offset: 0,
      nextOffset: 2,
      hasMore: true,
    });
    expect(JSON.stringify(listing)).not.toContain(workspaceRoot);
    expect(JSON.stringify(listing)).not.toContain(artifact.path);
    expect(JSON.stringify(listing)).not.toContain("sourceRef");
  });

  it("caps page size at 100 and rejects task/workspace scope mismatches", async () => {
    const files = createService();
    await expect(
      files.listTaskArtifacts(context, {
        taskId: task.id,
        workspaceId: workspace.id,
        limit: 101,
        offset: 0,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });

    const mismatched = createService({
      listTaskArtifacts: async () => ({
        task,
        workspace: { ...workspace, id: "other" },
        artifacts: [],
        hasMore: false,
      }),
    });
    await expect(
      mismatched.listTaskArtifacts(context, {
        taskId: task.id,
        workspaceId: workspace.id,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("registers only safe listing and handle creation RPC methods", () => {
    const methods = createBrowserArtifactMethods(createService());
    expect(Object.keys(methods)).toEqual(["task.artifacts.list", "artifact.download.create"]);
    expect(methods["task.artifacts.list"].capability).toBe("artifacts.read");
    expect(methods["artifact.download.create"].capability).toBe("artifacts.read");
    expect(methods["artifact.download.create"].mutation).toBe(true);
  });

  it("mints an opaque session-bound handle without returning a host path", async () => {
    const files = createService();
    const issued = await files.createDownloadHandle(context, { artifactId: artifact.id });

    expect(issued).toMatchObject({
      artifactId: artifact.id,
      fileName: "report.txt",
      mimeType: "text/plain",
      size: artifact.size,
    });
    expect(issued.handle).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.expiresAt).toBeGreaterThan(Date.now());
    expect(JSON.stringify(issued)).not.toContain(workspaceRoot);
    expect(JSON.stringify(issued)).not.toContain(artifact.path);
  });

  it("streams one requested byte range and consumes the handle exactly once", async () => {
    const files = createService();
    const issued = await files.createDownloadHandle(context, { artifactId: artifact.id });
    const server = await startDownloadServer(files);
    try {
      const response = await redeem(server.url, issued.handle, "bytes=2-5");
      expect(response.status).toBe(206);
      expect(response.headers.get("accept-ranges")).toBe("bytes");
      expect(response.headers.get("content-range")).toBe(`bytes 2-5/${artifact.size}`);
      expect(response.headers.get("content-length")).toBe("4");
      expect(response.headers.get("content-disposition")).toContain("attachment");
      expect(await response.text()).toBe("2345");

      const replay = await redeem(server.url, issued.handle);
      expect(replay.status).toBe(404);
    } finally {
      await closeServer(server.server);
    }
  });

  it("supports suffix ranges with a newly minted handle per request", async () => {
    const files = createService();
    const server = await startDownloadServer(files);
    try {
      const first = await files.createDownloadHandle(context, { artifactId: artifact.id });
      const firstResponse = await redeem(server.url, first.handle, "bytes=-3");
      expect(firstResponse.status).toBe(206);
      expect(await firstResponse.text()).toBe("789");

      const second = await files.createDownloadHandle(context, { artifactId: artifact.id });
      const secondResponse = await redeem(server.url, second.handle, "bytes=7-");
      expect(secondResponse.status).toBe(206);
      expect(await secondResponse.text()).toBe("789");
    } finally {
      await closeServer(server.server);
    }
  });

  it("returns 416 for malformed, multi-range, and unsatisfiable requests", async () => {
    const files = createService();
    const server = await startDownloadServer(files);
    try {
      for (const range of ["bytes=4-2", "bytes=20-30", "bytes=0-1,4-5"]) {
        const issued = await files.createDownloadHandle(context, { artifactId: artifact.id });
        const response = await redeem(server.url, issued.handle, range);
        expect(response.status).toBe(416);
        expect(response.headers.get("content-range")).toBe(`bytes */${artifact.size}`);
        expect(await response.text()).not.toContain(artifact.path);
      }
    } finally {
      await closeServer(server.server);
    }
  });

  it("caps full and ranged responses while allowing bounded partial retrieval", async () => {
    const files = createService({ maxResponseBytes: 4 });
    const server = await startDownloadServer(files);
    try {
      const full = await files.createDownloadHandle(context, { artifactId: artifact.id });
      const tooLarge = await redeem(server.url, full.handle);
      expect(tooLarge.status).toBe(413);
      expect(await tooLarge.text()).not.toContain(artifactContent.toString());

      const ranged = await files.createDownloadHandle(context, { artifactId: artifact.id });
      const response = await redeem(server.url, ranged.handle, "bytes=0-3");
      expect(response.status).toBe(206);
      expect(await response.text()).toBe("0123");
    } finally {
      await closeServer(server.server);
    }
  });

  it("rechecks capability, session binding, and profile access at redemption", async () => {
    let denied = false;
    const files = createService({
      resolveArtifact: async (selector, requestContext) => {
        if (requestContext.sessionId !== context.sessionId) return null;
        return {
          artifact,
          task,
          workspace: denied
            ? {
                ...workspace,
                permissions: {
                  ...workspace.permissions,
                  accessFilesystemRules: [{ path: artifact.path, access: "deny" }],
                },
              }
            : workspace,
        };
      },
    });
    const issued = await files.createDownloadHandle(context, { artifactId: artifact.id });
    const otherSessionServer = await startDownloadServer(files, {
      ...context,
      sessionId: "browser-session-other",
    });
    try {
      const wrongSession = await redeem(otherSessionServer.url, issued.handle);
      expect(wrongSession.status).toBe(404);
    } finally {
      await closeServer(otherSessionServer.server);
    }

    capabilityAvailable = false;
    const disabled = await createService()
      .createDownloadHandle(context, { artifactId: artifact.id })
      .catch((error) => error);
    expect(disabled).toMatchObject({ statusCode: 403 });
    capabilityAvailable = true;
    denied = true;
    const server = await startDownloadServer(files);
    try {
      const revoked = await redeem(server.url, issued.handle);
      expect(revoked.status).toBe(404);
      expect(await revoked.text()).not.toContain(artifactContent.toString());
    } finally {
      await closeServer(server.server);
    }
  });

  it("deletes outstanding handles on session revocation and host disposal", async () => {
    const files = createService();
    const revoked = await files.createDownloadHandle(context, { artifactId: artifact.id });
    files.revokeSession(context.sessionId);
    const server = await startDownloadServer(files);
    try {
      expect((await redeem(server.url, revoked.handle)).status).toBe(404);
    } finally {
      await closeServer(server.server);
    }

    const disposed = await files.createDownloadHandle(context, { artifactId: artifact.id });
    files.dispose();
    const disposedServer = await startDownloadServer(files);
    try {
      expect((await redeem(disposedServer.url, disposed.handle)).status).toBe(404);
    } finally {
      await closeServer(disposedServer.server);
    }
  });

  it("rejects content that no longer matches the canonical artifact hash", async () => {
    await fs.writeFile(artifact.path, "XXXXXXXXXX");
    const files = createService();
    await expect(
      files.createDownloadHandle(context, { artifactId: artifact.id }),
    ).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it.skipIf(process.platform === "win32")(
    "denies symlink escape and path replacement after handle creation",
    async () => {
      const outside = path.join(tempRoot, "outside.txt");
      await fs.writeFile(outside, "outside secret");
      await fs.rm(artifact.path);
      await fs.symlink(outside, artifact.path);
      const denied = createService();
      await expect(
        denied.createDownloadHandle(context, { artifactId: artifact.id }),
      ).rejects.toMatchObject({ statusCode: 404 });

      await fs.rm(artifact.path);
      await fs.writeFile(artifact.path, artifactContent);
      artifact = {
        ...artifact,
        sha256: sha256(artifactContent),
        size: artifactContent.byteLength,
      };
      const files = createService();
      const issued = await files.createDownloadHandle(context, { artifactId: artifact.id });
      await fs.rename(artifact.path, `${artifact.path}.original`);
      await fs.symlink(outside, artifact.path);
      const server = await startDownloadServer(files);
      try {
        const response = await redeem(server.url, issued.handle);
        expect(response.status).toBe(404);
        expect(await response.text()).not.toContain("outside secret");
      } finally {
        await closeServer(server.server);
      }
    },
  );

  it("allows an external artifact only through an explicit profile read rule", async () => {
    const externalPath = path.join(tempRoot, "external.csv");
    const content = Buffer.from("a,b\n1,2");
    await fs.writeFile(externalPath, content);
    workspace.permissions.accessFilesystemRules = [{ path: externalPath, access: "read" }];
    artifact = {
      ...artifact,
      path: externalPath,
      mimeType: "text/csv",
      sha256: sha256(content),
      size: content.length,
    };
    const files = createService();
    const issued = await files.createDownloadHandle(context, { artifactId: artifact.id });
    const server = await startDownloadServer(files);
    try {
      const response = await redeem(server.url, issued.handle, "bytes=0-2");
      expect(response.status).toBe(206);
      expect(await response.text()).toBe("a,b");
    } finally {
      await closeServer(server.server);
    }
  });

  it("resolves only committed or superseded linked artifact revisions", async () => {
    revision = {
      id: "revision-1",
      sessionId: "session-1",
      taskId: task.id,
      artifactId: artifact.id,
      revision: 1,
      path: artifact.path,
      mimeType: artifact.mimeType,
      sha256: artifact.sha256,
      size: artifact.size,
      status: "committed",
      createdBy: "agent",
      createdAt: artifact.createdAt,
    };
    const files = createService();
    const issued = await files.createDownloadHandle(context, { artifactRevisionId: revision.id });
    expect(issued.artifactId).toBe(artifact.id);

    revision = { ...revision, status: "retracted" };
    await expect(
      files.createDownloadHandle(context, { artifactRevisionId: revision.id }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects an invalid route query instead of accepting URL-supplied handles", async () => {
    const files = createService();
    const issued = await files.createDownloadHandle(context, { artifactId: artifact.id });
    const server = await startDownloadServer(files);
    try {
      const response = await fetch(
        `${server.url}${BROWSER_ARTIFACT_DOWNLOAD_PATH}?handle=${issued.handle}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ handle: issued.handle }),
        },
      );
      expect(response.status).toBe(400);
      expect(response.headers.get("content-disposition")).toBeNull();
    } finally {
      await closeServer(server.server);
    }
  });

  it("times out an incomplete artifact redemption body without consuming its handle", async () => {
    const files = createService({ requestBodyTimeoutMs: 25 });
    const issued = await files.createDownloadHandle(context, { artifactId: artifact.id });
    const server = await startDownloadServer(files);
    try {
      const incomplete = await postIncompleteJsonRequest(
        server.url,
        BROWSER_ARTIFACT_DOWNLOAD_PATH,
      );
      expect(incomplete.status).toBe(408);
      expect(incomplete.headers.connection).toBe("close");
      expect(JSON.parse(incomplete.body).error.message).toBe("Request body timed out.");

      const redeemed = await redeem(server.url, issued.handle);
      expect(redeemed.status).toBe(200);
      expect(await redeemed.text()).toBe(artifactContent.toString("utf8"));
    } finally {
      await closeServer(server.server);
    }
  });

  function createService(overrides: Partial<BrowserArtifactsOptions> = {}): BrowserArtifacts {
    return new BrowserArtifacts({
      getCapabilities: () =>
        capabilityAvailable
          ? { "artifacts.read": { available: true } }
          : { "artifacts.read": { available: false, reason: "disabled" } },
      resolveArtifact: (selector) => {
        if ("artifactRevisionId" in selector) {
          return revision ? { artifact, task, workspace, revision } : null;
        }
        return selector.artifactId === artifact.id ? { artifact, task, workspace } : null;
      },
      listTaskArtifacts: (request) => {
        const rows = [artifact];
        return {
          task,
          workspace,
          artifacts: rows.slice(request.offset, request.offset + request.limit + 1),
          hasMore: request.offset + request.limit < rows.length,
        };
      },
      ...overrides,
    });
  }

  async function createArtifact(
    fileName: string,
    content: Buffer,
    mimeType: string,
  ): Promise<Artifact> {
    const artifactPath = path.join(workspaceRoot, "output", fileName);
    await fs.writeFile(artifactPath, content);
    return {
      id: `artifact-${fileName}`,
      taskId: task.id,
      path: artifactPath,
      mimeType,
      sha256: sha256(content),
      size: content.length,
      createdAt: Date.now(),
    };
  }
});

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

async function startDownloadServer(
  artifacts: BrowserArtifacts,
  requestContext: WebRequestContext = context,
): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer((req, res) => {
    void artifacts.handleDownloadRequest(requestContext, req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
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

async function redeem(baseUrl: string, handle: string, range?: string): Promise<Response> {
  return fetch(`${baseUrl}${BROWSER_ARTIFACT_DOWNLOAD_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(range ? { range } : {}),
    },
    body: JSON.stringify({ handle }),
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
      reject(new Error("The incomplete artifact JSON request did not receive a response."));
    }, 2_000);
    request.once("error", (error) => {
      if (!responseReceived) {
        clearTimeout(timer);
        reject(error);
      }
    });
    request.write('{"handle":');
  });
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
