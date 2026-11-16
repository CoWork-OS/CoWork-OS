import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HOST_CAPABILITIES,
  WEB_API_PATH,
  WEB_ARTIFACT_DOWNLOAD_PATH,
  WEB_WORKSPACE_FILE_MEDIA_PATH_PREFIX,
  WEB_WORKSPACE_FILE_DOWNLOAD_PATH,
  WEB_WORKSPACE_FILE_UPLOAD_PATH,
  type HostCapabilities,
  type HostIdentity,
} from "../../../shared/host-api/contracts";
import {
  WebApplication,
  type WebApplicationOptions,
  type WebDeploymentPolicy,
} from "../WebApplication";
import type { PersistedWebSession, WebSessionStore } from "../session-store";
import { readBrowserAppSignInCode } from "../../../shared/browser-app-link";
import {
  createBrowserAppSignInLink,
  getBrowserAppStatus,
  signOutBrowserApp,
  type BrowserAppAccess,
} from "../../services/browser-app-control";

interface TestHost {
  app: WebApplication;
  server: http.Server;
  origin: string;
  port: number;
  directory: string;
  calls: ReturnType<typeof vi.fn>;
  identity: HostIdentity;
  close: () => Promise<void>;
}

const listeners = new Set<() => Promise<void>>();
afterEach(async () => {
  await Promise.all([...listeners].map((close) => close()));
  listeners.clear();
});

async function createHost(
  options: {
    deployment?: WebDeploymentPolicy;
    enabled?: boolean;
    pairingTtlMs?: number;
    requestBodyTimeoutMs?: number;
    sessionIdleTtlMs?: number;
    sessionMaxTtlMs?: number;
    sessionPersistIntervalMs?: number;
    sessionStore?: WebSessionStore;
    identity?: Partial<HostIdentity>;
    log?: WebApplicationOptions["log"];
    methods?: WebApplicationOptions["methods"];
    handleWorkspaceFileDownload?: WebApplicationOptions["handleWorkspaceFileDownload"];
    handleWorkspaceFileUpload?: WebApplicationOptions["handleWorkspaceFileUpload"];
    handleWorkspaceFileMedia?: WebApplicationOptions["handleWorkspaceFileMedia"];
    handleArtifactDownload?: WebApplicationOptions["handleArtifactDownload"];
    onSessionRevoked?: WebApplicationOptions["onSessionRevoked"];
    getSignatureDirectory?: WebApplicationOptions["getSignatureDirectory"];
  } = {},
): Promise<TestHost> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-web-app-"));
  await fs.writeFile(path.join(directory, "index.html"), "<main>browser shell</main>");
  await fs.writeFile(
    path.join(directory, "web-manifest.json"),
    JSON.stringify({ buildId: "build-one" }),
  );
  await fs.mkdir(path.join(directory, "assets"));
  await fs.writeFile(path.join(directory, "assets", "app.js"), "globalThis.ready = true;");

  const identity: HostIdentity = {
    installationId: "opaque-web-installation",
    profileId: "profile-alpha",
    generation: "generation-one",
    runtime: "node",
    platform: "linux",
    appVersion: "1.2.3",
    ...options.identity,
  };
  const capabilities = Object.fromEntries(
    HOST_CAPABILITIES.map((name) => [name, { available: true }]),
  ) as HostCapabilities;
  const calls = vi.fn(async (context: unknown, params: unknown) => ({ context, params }));
  const app = new WebApplication({
    enabled: options.enabled ?? true,
    webDirectory: directory,
    deployment: options.deployment ?? { mode: "loopback" },
    getHostIdentity: () => identity,
    getCapabilities: async () => capabilities,
    getSessionBootstrap: async () => ({
      capabilities,
      providerReady: true,
      onboardingCompleted: true,
      disclaimerAccepted: true,
      activeWorkspaceId: "workspace-1",
    }),
    methods: options.methods ?? {
      "tasks.create": { capability: "tasks.create", mutation: true, handler: calls },
      "tasks.read": { capability: "tasks.read", handler: calls },
    },
    handleWorkspaceFileDownload: options.handleWorkspaceFileDownload,
    handleWorkspaceFileUpload: options.handleWorkspaceFileUpload,
    handleWorkspaceFileMedia: options.handleWorkspaceFileMedia,
    handleArtifactDownload: options.handleArtifactDownload,
    onSessionRevoked: options.onSessionRevoked,
    getSignatureDirectory: options.getSignatureDirectory,
    pairingTtlMs: options.pairingTtlMs,
    requestBodyTimeoutMs: options.requestBodyTimeoutMs,
    sessionIdleTtlMs: options.sessionIdleTtlMs,
    sessionMaxTtlMs: options.sessionMaxTtlMs,
    sessionPersistIntervalMs: options.sessionPersistIntervalMs,
    sessionStore: options.sessionStore,
    log: options.log,
  });
  const server = http.createServer((req, res) => {
    void mount.handleRequest(req, res).then((handled) => {
      if (!handled && !res.writableEnded) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  const mount = app.mount({
    audience: "test-browser",
    listenerHost: "127.0.0.1",
    getListenerPort: () => {
      const address = server.address();
      return address && typeof address !== "string" ? address.port : undefined;
    },
  });
  server.on("upgrade", (req, socket, head) => {
    void mount
      .handleUpgrade(req, socket, head)
      .then((handled) => {
        if (!handled && !socket.destroyed) socket.destroy();
      })
      .catch(() => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected an IP listener address");
  const port = address.port;
  const close = async () => {
    await mount.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  };
  listeners.add(close);
  return {
    app,
    server,
    origin: `http://127.0.0.1:${port}`,
    port,
    directory,
    calls,
    identity,
    close,
  };
}

function request(
  host: TestHost,
  options: {
    path: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: host.port,
        path: options.path,
        method: options.method ?? "GET",
        headers: options.headers,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.once("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function requestIncompleteUpload(
  host: TestHost,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    let responseReceived = false;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: host.port,
        path: WEB_WORKSPACE_FILE_UPLOAD_PATH,
        method: "POST",
        headers: {
          Origin: host.origin,
          "Content-Type": "application/octet-stream",
          ...headers,
        },
        agent: false,
      },
      (res) => {
        responseReceived = true;
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.once("end", () => {
          clearTimeout(timer);
          req.destroy();
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.once("error", reject);
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error("The unauthenticated upload request did not receive a response."));
    }, 2_000);
    req.once("error", (error) => {
      if (!responseReceived) {
        clearTimeout(timer);
        reject(error);
      }
    });
    req.write("partial body");
  });
}

function requestIncompletePairingBody(
  host: TestHost,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    let responseReceived = false;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: host.port,
        path: `${WEB_API_PATH}/session/pair`,
        method: "POST",
        headers: {
          Origin: host.origin,
          "Content-Type": "application/json",
          "Content-Length": "128",
        },
        agent: false,
      },
      (res) => {
        responseReceived = true;
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.once("end", () => {
          clearTimeout(timer);
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.once("error", reject);
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error("The incomplete pairing request did not receive a response."));
    }, 2_000);
    req.once("error", (error) => {
      if (!responseReceived) {
        clearTimeout(timer);
        reject(error);
      }
    });
    req.write('{"code":');
  });
}

async function pair(
  host: TestHost,
  pairingCode = host.app.createPairingCode("test-browser").code,
): Promise<{ cookie: string; cookieName: string; csrfToken: string }> {
  const response = await request(host, {
    path: `${WEB_API_PATH}/session/pair`,
    method: "POST",
    headers: { Origin: host.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ code: pairingCode }),
  });
  const setCookie = response.headers["set-cookie"]?.[0];
  if (!setCookie) throw new Error(`Pairing did not set a session cookie: ${response.body}`);
  const [cookiePair] = setCookie.split(";");
  const separator = cookiePair.indexOf("=");
  return {
    cookie: cookiePair,
    cookieName: cookiePair.slice(0, separator),
    csrfToken: JSON.parse(response.body).csrfToken,
  };
}

describe("WebApplication host core", () => {
  it("serves the public key directory without a session, and only when identity is on", async () => {
    const directory = vi.fn((authority: string) =>
      authority.startsWith("127.0.0.1")
        ? {
            body: '{"keys":[]}',
            headers: { "Content-Type": "application/http-message-signatures-directory+json" },
          }
        : null,
    );
    const host = await createHost({ getSignatureDirectory: directory });
    const served = await request(host, {
      path: "/.well-known/http-message-signatures-directory",
    });
    expect(served.status).toBe(200);
    expect(served.headers["content-type"]).toBe(
      "application/http-message-signatures-directory+json",
    );
    expect(served.body).toBe('{"keys":[]}');
    expect(directory).toHaveBeenCalledWith(`127.0.0.1:${host.port}`);
    const posted = await request(host, {
      path: "/.well-known/http-message-signatures-directory",
      method: "POST",
    });
    expect(posted.status).toBe(405);

    const off = await createHost({ getSignatureDirectory: () => null });
    expect(
      (await request(off, { path: "/.well-known/http-message-signatures-directory" })).status,
    ).toBe(404);

    const unreadableKey = await createHost({
      getSignatureDirectory: () => {
        throw new Error("The agent identity key could not be read");
      },
    });
    expect(
      (await request(unreadableKey, { path: "/.well-known/http-message-signatures-directory" }))
        .status,
    ).toBe(404);
  });

  it("admits raw uploads only after same-origin session and CSRF checks", async () => {
    const upload = vi.fn(async (_context, _req, res: http.ServerResponse) => {
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end('{"size":4}');
      return true;
    });
    const host = await createHost({ handleWorkspaceFileUpload: upload });
    const noSession = await requestIncompleteUpload(host);
    expect(noSession.status).toBe(401);
    expect(noSession.headers.connection).toBe("close");
    const wrongHost = await requestIncompleteUpload(host, { Host: "127.0.0.1:1" });
    expect(wrongHost.status).toBe(403);
    expect(wrongHost.headers.connection).toBe("close");
    const session = await pair(host);
    const denied = await request(host, {
      path: WEB_WORKSPACE_FILE_UPLOAD_PATH,
      method: "POST",
      headers: { Origin: host.origin, Cookie: session.cookie },
      body: "data",
    });
    expect(denied.status).toBe(403);
    const crossOrigin = await request(host, {
      path: WEB_WORKSPACE_FILE_UPLOAD_PATH,
      method: "POST",
      headers: {
        Origin: "http://hostile.invalid",
        Cookie: session.cookie,
        "x-cowork-csrf": session.csrfToken,
      },
      body: "data",
    });
    expect(crossOrigin.status).toBe(403);
    const accepted = await request(host, {
      path: WEB_WORKSPACE_FILE_UPLOAD_PATH,
      method: "POST",
      headers: {
        Origin: host.origin,
        Cookie: session.cookie,
        "x-cowork-csrf": session.csrfToken,
      },
      body: "data",
    });
    expect(accepted.status).toBe(201);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("admits workspace file streams only for same-origin authenticated CSRF requests", async () => {
    const download = vi.fn(async (_context, _req, res: http.ServerResponse) => {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end("file bytes");
      return true;
    });
    const host = await createHost({ handleWorkspaceFileDownload: download });
    const body = JSON.stringify({ workspaceId: "workspace-1", relativePath: "output.csv" });
    const noSession = await request(host, {
      path: WEB_WORKSPACE_FILE_DOWNLOAD_PATH,
      method: "POST",
      headers: { Origin: host.origin, "Content-Type": "application/json" },
      body,
    });
    expect(noSession.status).toBe(401);
    const session = await pair(host);
    const noCsrf = await request(host, {
      path: WEB_WORKSPACE_FILE_DOWNLOAD_PATH,
      method: "POST",
      headers: { Origin: host.origin, Cookie: session.cookie, "Content-Type": "application/json" },
      body,
    });
    expect(noCsrf.status).toBe(403);
    const wrongOrigin = await request(host, {
      path: WEB_WORKSPACE_FILE_DOWNLOAD_PATH,
      method: "POST",
      headers: {
        Origin: "http://hostile.invalid",
        Cookie: session.cookie,
        "x-cowork-csrf": session.csrfToken,
        "Content-Type": "application/json",
      },
      body,
    });
    expect(wrongOrigin.status).toBe(403);
    const accepted = await request(host, {
      path: WEB_WORKSPACE_FILE_DOWNLOAD_PATH,
      method: "POST",
      headers: {
        Origin: host.origin,
        Cookie: session.cookie,
        "x-cowork-csrf": session.csrfToken,
        "Content-Type": "application/json",
      },
      body,
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toBe("file bytes");
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("authenticates same-origin video range requests without requiring Origin or CSRF", async () => {
    const stream = vi.fn(async (_context, req: http.IncomingMessage, res: http.ServerResponse) => {
      expect(req.headers.range).toBe("bytes=0-3");
      res.writeHead(206, {
        "Content-Range": "bytes 0-3/8",
        "Content-Length": "4",
        "Accept-Ranges": "bytes",
      });
      res.end("vide");
      return true;
    });
    const host = await createHost({ handleWorkspaceFileMedia: stream });
    const mediaPath = `${WEB_WORKSPACE_FILE_MEDIA_PATH_PREFIX}${"a".repeat(43)}`;
    const noSession = await request(host, {
      path: mediaPath,
      headers: { Range: "bytes=0-3", "Sec-Fetch-Site": "same-origin" },
    });
    expect(noSession.status).toBe(401);

    const session = await pair(host);
    const crossOrigin = await request(host, {
      path: mediaPath,
      headers: {
        Origin: "http://hostile.invalid",
        Cookie: session.cookie,
        Range: "bytes=0-3",
      },
    });
    expect(crossOrigin.status).toBe(403);
    const crossSite = await request(host, {
      path: mediaPath,
      headers: {
        Cookie: session.cookie,
        Range: "bytes=0-3",
        "Sec-Fetch-Site": "cross-site",
      },
    });
    expect(crossSite.status).toBe(403);

    const accepted = await request(host, {
      path: mediaPath,
      headers: {
        Cookie: session.cookie,
        Range: "bytes=0-3",
        "Sec-Fetch-Site": "same-origin",
      },
    });
    expect(accepted.status).toBe(206);
    expect(accepted.body).toBe("vide");
    expect(stream).toHaveBeenCalledTimes(1);
    expect(stream.mock.calls[0]?.[0]).toMatchObject({
      audience: "test-browser",
      sessionId: expect.any(String),
    });
  });

  it("guards artifact streams and revokes their session handles on logout", async () => {
    const download = vi.fn(async (_context, _req, res: http.ServerResponse) => {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end("artifact bytes");
      return true;
    });
    const onSessionRevoked = vi.fn();
    const host = await createHost({ handleArtifactDownload: download, onSessionRevoked });
    const body = JSON.stringify({ handle: "opaque-handle" });
    const noSession = await request(host, {
      path: WEB_ARTIFACT_DOWNLOAD_PATH,
      method: "POST",
      headers: { Origin: host.origin, "Content-Type": "application/json" },
      body,
    });
    expect(noSession.status).toBe(401);

    const session = await pair(host);
    const noCsrf = await request(host, {
      path: WEB_ARTIFACT_DOWNLOAD_PATH,
      method: "POST",
      headers: { Origin: host.origin, Cookie: session.cookie },
      body,
    });
    expect(noCsrf.status).toBe(403);
    const accepted = await request(host, {
      path: WEB_ARTIFACT_DOWNLOAD_PATH,
      method: "POST",
      headers: {
        Origin: host.origin,
        Cookie: session.cookie,
        "x-cowork-csrf": session.csrfToken,
        "Content-Type": "application/json",
      },
      body,
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toBe("artifact bytes");
    expect(download).toHaveBeenCalledTimes(1);

    const logout = await request(host, {
      path: `${WEB_API_PATH}/session/logout`,
      method: "POST",
      headers: {
        Origin: host.origin,
        Cookie: session.cookie,
        "x-cowork-csrf": session.csrfToken,
      },
    });
    expect(logout.status).toBe(200);
    expect(onSessionRevoked).toHaveBeenCalledTimes(1);
    expect(onSessionRevoked).toHaveBeenCalledWith(expect.any(String));
  });

  it("serves the injected app with same-origin CSP and exposes only public bootstrap", async () => {
    const host = await createHost();
    const shell = await request(host, { path: "/app/" });
    const manifest = await request(host, { path: "/app/web-manifest.json" });
    const asset = await request(host, { path: "/app/assets/app.js" });
    const bootstrap = await request(host, { path: `${WEB_API_PATH}/bootstrap` });

    expect(shell.status).toBe(200);
    expect(shell.body).toContain("browser shell");
    expect(manifest.status).toBe(200);
    expect(manifest.headers["cache-control"]).toBe("no-store");
    expect(shell.headers["content-security-policy"]).toContain(
      `connect-src 'self' ws://127.0.0.1:${host.port}`,
    );
    expect(asset.body).toContain("globalThis.ready");
    expect(bootstrap.status).toBe(200);
    expect(JSON.parse(bootstrap.body)).toEqual({
      apiVersion: 1,
      appVersion: "1.2.3",
      authentication: "required",
    });
    expect(bootstrap.body).not.toContain(host.identity.installationId);
  });

  it("does not serve a symlinked application asset outside the injected directory", async () => {
    const host = await createHost();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-web-outside-"));
    try {
      await fs.writeFile(path.join(outside, "secret.txt"), "must stay outside");
      await fs.symlink(outside, path.join(host.directory, "assets", "escape"), "dir");
      const response = await request(host, { path: "/app/assets/escape/secret.txt" });
      expect(response.status).toBe(404);
      expect(response.body).not.toContain("must stay outside");
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("pairs once, binds an HttpOnly cookie to the session, enforces CSRF and revokes on logout", async () => {
    const host = await createHost();
    const pairing = host.app.createPairingCode("test-browser");
    const noOrigin = await request(host, {
      path: `${WEB_API_PATH}/session/pair`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: pairing.code }),
    });
    expect(noOrigin.status).toBe(403);

    const session = await pair(host, pairing.code);
    const serializedCookie = (
      await request(host, {
        path: `${WEB_API_PATH}/session/pair`,
        method: "POST",
        headers: { Origin: host.origin, "Content-Type": "application/json" },
        body: JSON.stringify({ code: pairing.code }),
      })
    ).headers["set-cookie"]?.[0];
    expect(serializedCookie).toBeUndefined();

    const bootstrap = await request(host, {
      path: `${WEB_API_PATH}/session/bootstrap`,
      headers: { Cookie: session.cookie, Origin: host.origin },
    });
    expect(bootstrap.status).toBe(200);
    expect(JSON.parse(bootstrap.body)).toMatchObject({
      host: { profileId: "profile-alpha" },
      csrfToken: session.csrfToken,
    });

    const noCsrf = await request(host, {
      path: `${WEB_API_PATH}/rpc`,
      method: "POST",
      headers: { Origin: host.origin, Cookie: session.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        apiVersion: 1,
        type: "request",
        id: "r1",
        method: "tasks.create",
        params: {},
      }),
    });
    expect(noCsrf.status).toBe(403);
    expect(host.calls).not.toHaveBeenCalled();

    const validMutation = await request(host, {
      path: `${WEB_API_PATH}/rpc`,
      method: "POST",
      headers: {
        Origin: host.origin,
        Cookie: session.cookie,
        "X-CoWork-CSRF": session.csrfToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        apiVersion: 1,
        type: "request",
        id: "r2",
        method: "tasks.create",
        operationKey: "task-create-001",
        params: { prompt: "hello" },
      }),
    });
    expect(validMutation.status).toBe(200);
    expect(host.calls).toHaveBeenCalledWith(
      expect.objectContaining({ audience: "test-browser", operationKey: "task-create-001" }),
      { prompt: "hello" },
    );

    const unsupported = await request(host, {
      path: `${WEB_API_PATH}/rpc`,
      method: "POST",
      headers: {
        Origin: host.origin,
        Cookie: session.cookie,
        "X-CoWork-CSRF": session.csrfToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        apiVersion: 1,
        type: "request",
        id: "r3",
        method: "electron.ipc",
        params: {},
      }),
    });
    expect(JSON.parse(unsupported.body).error.code).toBe("UNSUPPORTED_CAPABILITY");
    expect(host.calls).toHaveBeenCalledTimes(1);

    const logout = await request(host, {
      path: `${WEB_API_PATH}/session/logout`,
      method: "POST",
      headers: {
        Origin: host.origin,
        Cookie: session.cookie,
        "X-CoWork-CSRF": session.csrfToken,
      },
    });
    expect(logout.status).toBe(200);
    expect(logout.headers["set-cookie"]?.[0]).toContain("Max-Age=0");
    expect(
      (
        await request(host, {
          path: `${WEB_API_PATH}/session/bootstrap`,
          headers: { Cookie: session.cookie },
        })
      ).status,
    ).toBe(401);
  });

  it("times out an incomplete unauthenticated pairing body and closes its connection", async () => {
    const host = await createHost({ requestBodyTimeoutMs: 25 });
    const pairing = host.app.createPairingCode("test-browser");
    const incomplete = await requestIncompletePairingBody(host);

    expect(incomplete.status).toBe(408);
    expect(incomplete.headers.connection).toBe("close");
    expect(JSON.parse(incomplete.body).error.message).toBe("Request body timed out.");
    expect((await pair(host, pairing.code)).csrfToken).toBeTruthy();
  });

  it("rejects a mismatched Host and Origin before pairing", async () => {
    const host = await createHost();
    const pairing = host.app.createPairingCode("test-browser");
    const wrongOrigin = await request(host, {
      path: `${WEB_API_PATH}/session/pair`,
      method: "POST",
      headers: { Origin: "http://evil.example", "Content-Type": "application/json" },
      body: JSON.stringify({ code: pairing.code }),
    });
    const wrongHost = await request(host, {
      path: `${WEB_API_PATH}/bootstrap`,
      headers: { Host: `evil.example:${host.port}` },
    });
    expect(wrongOrigin.status).toBe(403);
    expect(wrongHost.status).toBe(403);
    expect((await pair(host)).csrfToken).toBeTruthy();
  });

  it("binds sessions to the injected profile and host generation", async () => {
    const host = await createHost();
    const session = await pair(host);
    host.identity.generation = "generation-two";
    const stale = await request(host, {
      path: `${WEB_API_PATH}/session/bootstrap`,
      headers: { Cookie: session.cookie },
    });
    expect(stale.status).toBe(401);
    expect(JSON.parse(stale.body).error.code).toBe("STALE_HOST");
    expect(stale.headers["set-cookie"]?.[0]).toContain("Max-Age=0");
  });

  it("isolates pairing codes and cookies by listener audience and revokes a changed profile", async () => {
    const host = await createHost();
    const otherServer = http.createServer();
    const otherMount = host.app.mount({
      audience: "other-listener",
      listenerHost: "127.0.0.1",
      getListenerPort: () => {
        const address = otherServer.address();
        return address && typeof address !== "string" ? address.port : undefined;
      },
    });
    otherServer.on("request", (req, res) => {
      void otherMount.handleRequest(req, res).then((handled) => {
        if (!handled && !res.writableEnded) {
          res.writeHead(404);
          res.end();
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      otherServer.once("error", reject);
      otherServer.listen(0, "127.0.0.1", () => resolve());
    });
    const otherAddress = otherServer.address();
    if (!otherAddress || typeof otherAddress === "string")
      throw new Error("Expected second listener address");
    const otherHost: TestHost = {
      ...host,
      server: otherServer,
      port: otherAddress.port,
      origin: `http://127.0.0.1:${otherAddress.port}`,
      close: async () => {
        await otherMount.close();
        await new Promise<void>((resolve) => otherServer.close(() => resolve()));
      },
    };
    listeners.add(otherHost.close);

    const wrongAudienceCode = host.app.createPairingCode("test-browser");
    const wrongAudience = await request(otherHost, {
      path: `${WEB_API_PATH}/session/pair`,
      method: "POST",
      headers: { Origin: otherHost.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ code: wrongAudienceCode.code }),
    });
    expect(wrongAudience.status).toBe(401);

    const otherPairingCode = host.app.createPairingCode("other-listener");
    const otherSession = await pair(otherHost, otherPairingCode.code);
    const crossedSession = await request(host, {
      path: `${WEB_API_PATH}/session/bootstrap`,
      headers: { Cookie: otherSession.cookie },
    });
    expect(crossedSession.status).toBe(401);

    host.identity.profileId = "profile-beta";
    const staleProfile = await request(otherHost, {
      path: `${WEB_API_PATH}/session/bootstrap`,
      headers: { Cookie: otherSession.cookie },
    });
    expect(staleProfile.status).toBe(401);
    expect(JSON.parse(staleProfile.body).error.code).toBe("STALE_HOST");
  });

  it("rejects an expired host-generated pairing code", async () => {
    const host = await createHost({ pairingTtlMs: 5 });
    const pairing = host.app.createPairingCode("test-browser");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const expired = await request(host, {
      path: `${WEB_API_PATH}/session/pair`,
      method: "POST",
      headers: { Origin: host.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ code: pairing.code }),
    });
    expect(expired.status).toBe(401);
    expect(JSON.parse(expired.body).error.code).toBe("UNAUTHENTICATED");
  });

  it("requires trusted HTTPS proxy metadata for remote mode and sets a Secure host cookie", async () => {
    expect(
      () =>
        new WebApplication({
          enabled: true,
          webDirectory: os.tmpdir(),
          deployment: {
            mode: "https-proxy",
            publicOrigin: "https://browser.example",
            trustedProxyAddresses: [],
          },
          getHostIdentity: () => ({
            installationId: "opaque",
            profileId: "profile",
            generation: "generation",
            runtime: "node",
            platform: "linux",
            appVersion: "1",
          }),
          getCapabilities: async () => ({}) as HostCapabilities,
          getSessionBootstrap: async () => ({
            capabilities: {} as HostCapabilities,
            providerReady: false,
            onboardingCompleted: false,
            disclaimerAccepted: false,
            activeWorkspaceId: null,
          }),
        }),
    ).toThrow(/trusted proxy/);

    const host = await createHost({
      deployment: {
        mode: "https-proxy",
        publicOrigin: "https://browser.example",
        trustedProxyAddresses: ["127.0.0.1"],
      },
    });
    const pairing = host.app.createPairingCode("test-browser");
    const denied = await request(host, {
      path: `${WEB_API_PATH}/session/pair`,
      method: "POST",
      headers: {
        Host: "browser.example",
        "Content-Type": "application/json",
        Origin: "https://browser.example",
      },
      body: JSON.stringify({ code: pairing.code }),
    });
    expect(denied.status).toBe(403);

    const response = await request(host, {
      path: `${WEB_API_PATH}/session/pair`,
      method: "POST",
      headers: {
        Host: "browser.example",
        Origin: "https://browser.example",
        "X-Forwarded-Proto": "https",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code: pairing.code }),
    });
    expect(response.status).toBe(200);
    expect(response.headers["set-cookie"]?.[0]).toMatch(/^__Host-cw_/);
    // Through the public HTTPS address a sign-in may last 90 days.
    expect(response.headers["set-cookie"]?.[0]).toContain(`Max-Age=${90 * 24 * 60 * 60}`);
    expect(response.headers["set-cookie"]?.[0]).toContain("Secure");
  });

  it("redeems valid codes behind a shared proxy without resetting its invalid-attempt throttle", async () => {
    const host = await createHost({
      deployment: {
        mode: "https-proxy",
        publicOrigin: "https://browser.example",
        trustedProxyAddresses: ["127.0.0.1"],
      },
    });
    const first = host.app.createPairingCode("test-browser");
    const second = host.app.createPairingCode("test-browser");
    const attempt = (code: string, client: string) =>
      request(host, {
        path: `${WEB_API_PATH}/session/pair`,
        method: "POST",
        headers: {
          Host: "browser.example",
          Origin: "https://browser.example",
          "X-Forwarded-Proto": "https",
          "X-Forwarded-For": client,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ code }),
      });
    for (let i = 0; i < 5; i++)
      expect((await attempt("invalid", `198.51.100.${i + 1}`)).status).toBe(401);
    expect((await attempt("invalid", "203.0.113.1")).status).toBe(429);
    expect((await attempt(first.code, "198.51.100.100")).status).toBe(200);
    expect((await attempt("invalid", "203.0.113.2")).status).toBe(429);
    expect((await attempt(second.code, "198.51.100.101")).status).toBe(200);
    expect((await attempt(first.code, "198.51.100.100")).status).toBe(429);
  });

  it("uses a one-use WebSocket ticket in the subprotocol and dispatches only registered RPC methods", async () => {
    const host = await createHost();
    const session = await pair(host);
    const issued = await request(host, {
      path: `${WEB_API_PATH}/session/ws-ticket`,
      method: "POST",
      headers: {
        Origin: host.origin,
        Cookie: session.cookie,
        "X-CoWork-CSRF": session.csrfToken,
      },
    });
    expect(issued.status).toBe(200);
    const { ticket } = JSON.parse(issued.body);
    expect(issued.body).not.toContain("?ticket=");

    const socket = new WebSocket(
      `ws://127.0.0.1:${host.port}${WEB_API_PATH}/ws`,
      ["cowork-web-v1", `cowork-ticket.${ticket}`],
      {
        headers: { Origin: host.origin, Cookie: session.cookie },
      },
    );
    const opened = new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    await opened;
    expect(socket.protocol).toBe("cowork-web-v1");

    const responsePromise = new Promise<string>((resolve, reject) => {
      socket.once("message", (data) => resolve(data.toString()));
      socket.once("error", reject);
    });
    socket.send(
      JSON.stringify({
        apiVersion: 1,
        type: "request",
        id: "socket-call",
        method: "tasks.create",
        operationKey: "ws-mutation-001",
        params: { prompt: "through allowlist" },
      }),
    );
    const response = JSON.parse(await responsePromise);
    expect(response).toMatchObject({ apiVersion: 1, type: "response", id: "socket-call" });
    expect(host.calls).toHaveBeenCalledWith(
      expect.objectContaining({ operationKey: "ws-mutation-001" }),
      { prompt: "through allowlist" },
    );

    const replay = new WebSocket(
      `ws://127.0.0.1:${host.port}${WEB_API_PATH}/ws`,
      ["cowork-web-v1", `cowork-ticket.${ticket}`],
      {
        headers: { Origin: host.origin, Cookie: session.cookie },
      },
    );
    const rejectionStatus = await new Promise<number>((resolve, reject) => {
      replay.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      replay.once("open", () => reject(new Error("Replayed WebSocket ticket was accepted")));
      replay.once("error", (error) => {
        if (!replay.listenerCount("unexpected-response")) reject(error);
      });
    });
    expect(rejectionStatus).toBe(401);
    socket.close();
  });

  it("revokes an idle WebSocket session before dispatching another operation", async () => {
    const host = await createHost({ sessionIdleTtlMs: 350 });
    const session = await pair(host);
    const issued = await request(host, {
      path: `${WEB_API_PATH}/session/ws-ticket`,
      method: "POST",
      headers: {
        Origin: host.origin,
        Cookie: session.cookie,
        "X-CoWork-CSRF": session.csrfToken,
      },
    });
    const { ticket } = JSON.parse(issued.body);
    const socket = new WebSocket(
      `ws://127.0.0.1:${host.port}${WEB_API_PATH}/ws`,
      ["cowork-web-v1", `cowork-ticket.${ticket}`],
      {
        headers: { Origin: host.origin, Cookie: session.cookie },
      },
    );
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });

    await new Promise((resolve) => setTimeout(resolve, 500));
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    socket.send(
      JSON.stringify({
        apiVersion: 1,
        type: "request",
        id: "idle",
        method: "tasks.read",
        params: {},
      }),
    );
    expect(await closed).toMatchObject({ code: 4001, reason: "Session revoked" });
    expect(host.calls).not.toHaveBeenCalled();
  });

  it("fails closed when disabled or bound outside loopback without HTTPS proxy mode", async () => {
    const disabled = new WebApplication({
      enabled: false,
      webDirectory: os.tmpdir(),
      deployment: { mode: "loopback" },
      getHostIdentity: () => ({
        installationId: "opaque",
        profileId: "profile",
        generation: "generation",
        runtime: "node",
        platform: "linux",
        appVersion: "1",
      }),
      getCapabilities: async () => ({}) as HostCapabilities,
      getSessionBootstrap: async () => ({
        capabilities: {} as HostCapabilities,
        providerReady: false,
        onboardingCompleted: false,
        disclaimerAccepted: false,
        activeWorkspaceId: null,
      }),
    });
    expect(() =>
      disabled.mount({ audience: "disabled", listenerHost: "127.0.0.1", getListenerPort: () => 0 }),
    ).toThrow(/disabled/);

    const host = await createHost();
    expect(() =>
      host.app.mount({
        audience: "public-bind",
        listenerHost: "0.0.0.0",
        getListenerPort: () => host.port,
      }),
    ).toThrow(/loopback/);
  });
});

describe("WebApplication browser app controls", () => {
  it("reports mounts, counts live sessions and returns how many sign-outs ended", async () => {
    const host = await createHost();
    expect(host.app.isMounted("test-browser")).toBe(true);
    expect(host.app.isMounted("another-listener")).toBe(false);
    expect(host.app.getPublicOrigin()).toBeNull();
    expect(host.app.countSessions()).toBe(0);

    await pair(host);
    await pair(host);
    expect(host.app.countSessions()).toBe(2);
    expect(host.app.countSessions("test-browser")).toBe(2);
    expect(host.app.countSessions("another-listener")).toBe(0);

    expect(host.app.revokeSessions("another-listener")).toBe(0);
    expect(host.app.revokeSessions()).toBe(2);
    expect(host.app.countSessions()).toBe(0);
  });

  it("signs a browser in from a one-use link and out again", async () => {
    const host = await createHost();
    const access: BrowserAppAccess = {
      getApplication: () => host.app,
      resolveListener: () => ({ origin: host.origin, audience: "test-browser" }),
      offMessage: "off",
      noListenerMessage: "no listener",
    };

    const link = createBrowserAppSignInLink(access);
    expect(link.appUrl).toBe(`${host.origin}/app/`);
    const url = new URL(link.url);
    expect(`${url.origin}${url.pathname}`).toBe(`${host.origin}/app/`);
    expect(url.search).toBe("");
    const code = readBrowserAppSignInCode(url.hash);
    expect(code).toBeTruthy();

    const { cookie } = await pair(host, code!);
    expect(cookie).toContain("=");
    expect(getBrowserAppStatus(access)).toEqual({
      enabled: true,
      appUrl: `${host.origin}/app/`,
      remote: false,
      signedInBrowsers: 1,
    });

    // The code works once.
    const reused = await request(host, {
      path: `${WEB_API_PATH}/session/pair`,
      method: "POST",
      headers: { Origin: host.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(reused.status).toBeGreaterThanOrEqual(400);

    expect(signOutBrowserApp(access)).toEqual({ signedOut: 1 });
    expect(getBrowserAppStatus(access).signedInBrowsers).toBe(0);
  });

  it("refuses a link when no listener serves the app", async () => {
    const host = await createHost();
    const access: BrowserAppAccess = {
      getApplication: () => host.app,
      resolveListener: () => ({ origin: host.origin, audience: "not-mounted" }),
      offMessage: "off",
      noListenerMessage: "Nothing is serving the browser app.",
    };
    expect(() => createBrowserAppSignInLink(access)).toThrow("Nothing is serving the browser app.");
    expect(getBrowserAppStatus(access)).toMatchObject({ enabled: true, signedInBrowsers: 0 });
    expect(getBrowserAppStatus(access).appUrl).toBeUndefined();
  });
});

const DAY_MS = 24 * 60 * 60_000;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** A store that lives for the test and counts its writes, standing in for encrypted settings. */
function memoryStore(initial: PersistedWebSession[] = []) {
  let records = initial.map((record) => ({ ...record }));
  const writes = { add: 0, touch: 0, remove: 0, clear: 0 };
  const store: WebSessionStore = {
    load: () => records.map((record) => ({ ...record })),
    add(session) {
      writes.add += 1;
      records = [...records.filter((record) => record.key !== session.key), { ...session }];
    },
    touch(updates) {
      writes.touch += 1;
      records = records.map((record) => {
        const update = updates.find((entry) => entry.key === record.key);
        return update ? { ...record, lastUsedAt: update.lastUsedAt } : record;
      });
    },
    remove(keys) {
      writes.remove += 1;
      records = records.filter((record) => !keys.includes(record.key));
    },
    clear(audience) {
      writes.clear += 1;
      records = audience === undefined ? [] : records.filter((r) => r.audience !== audience);
    },
  };
  return { store, writes, records: () => records };
}

/** A stored sign-in for the test host, and the cookie a browser would present for it. */
function storedSignIn(
  name: string,
  overrides: Partial<PersistedWebSession> = {},
): { record: PersistedWebSession; cookieValue: string } {
  const cookieValue = `${name}-${"x".repeat(40)}`.slice(0, 43);
  const now = Date.now();
  return {
    cookieValue,
    record: {
      key: sha256(cookieValue),
      audience: "test-browser",
      installationId: "opaque-web-installation",
      profileId: "profile-alpha",
      runtime: "node",
      deployment: "loopback",
      createdAt: now - 60 * 60_000,
      lastUsedAt: now - 60_000,
      expiresAt: now + 23 * 60 * 60_000,
      ...overrides,
    },
  };
}

function bootstrap(host: TestHost, cookie: string) {
  return request(host, { path: `${WEB_API_PATH}/session/bootstrap`, headers: { Cookie: cookie } });
}

function wsTicket(host: TestHost, cookie: string, csrfToken: string) {
  return request(host, {
    path: `${WEB_API_PATH}/session/ws-ticket`,
    method: "POST",
    headers: { Origin: host.origin, Cookie: cookie, "X-CoWork-CSRF": csrfToken },
  });
}

describe("WebApplication sign-ins across a host restart", () => {
  it("keeps a browser signed in after a restart, bound to the new process", async () => {
    const contexts: Array<{ sessionId: string; generation: string }> = [];
    const download: WebApplicationOptions["handleWorkspaceFileDownload"] = async (
      context,
      _req,
      res,
    ) => {
      contexts.push({ sessionId: context.sessionId, generation: context.identity.generation });
      res.writeHead(204);
      res.end();
      return true;
    };
    const callDownload = (host: TestHost, cookie: string, csrfToken: string) =>
      request(host, {
        path: WEB_WORKSPACE_FILE_DOWNLOAD_PATH,
        method: "POST",
        headers: {
          Origin: host.origin,
          Cookie: cookie,
          "X-CoWork-CSRF": csrfToken,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
    const { store, records } = memoryStore();

    const first = await createHost({ sessionStore: store, handleWorkspaceFileDownload: download });
    const session = await pair(first);
    const cookieValue = session.cookie.slice(session.cookie.indexOf("=") + 1);
    expect((await callDownload(first, session.cookie, session.csrfToken)).status).toBe(204);

    // The store holds a hash of the cookie and nothing a browser could present.
    expect(records()).toHaveLength(1);
    expect(records()[0].key).toBe(sha256(cookieValue));
    const stored = JSON.stringify(records());
    expect(stored).not.toContain(cookieValue);
    expect(stored).not.toContain(session.csrfToken);
    expect(stored).not.toContain(contexts[0].sessionId);

    await first.close();
    expect(first.app.countSessions()).toBe(0);
    expect(records()).toHaveLength(1);

    const second = await createHost({
      sessionStore: store,
      identity: { generation: "generation-two" },
      handleWorkspaceFileDownload: download,
    });
    expect(second.app.countSessions()).toBe(1);
    const restored = await bootstrap(second, session.cookie);
    expect(restored.status).toBe(200);
    const body = JSON.parse(restored.body);
    expect(body.host.generation).toBe("generation-two");
    expect(body.csrfToken).not.toBe(session.csrfToken);

    // The page that was open before the restart holds the old CSRF token: refused.
    expect((await wsTicket(second, session.cookie, session.csrfToken)).status).toBe(403);
    expect((await wsTicket(second, session.cookie, body.csrfToken)).status).toBe(200);

    // Host services scope handles by session id and generation. Both are new, so a file,
    // artifact or terminal handle issued before the restart matches nothing after it.
    expect((await callDownload(second, session.cookie, body.csrfToken)).status).toBe(204);
    expect(contexts).toHaveLength(2);
    expect(contexts[1].sessionId).not.toBe(contexts[0].sessionId);
    expect(contexts[1].generation).toBe("generation-two");
    for (const context of contexts) expect(context.sessionId).not.toBe(cookieValue);

    // The cookie keeps its name, so the browser sends it to the restarted host.
    expect((await pair(second)).cookieName).toBe(session.cookieName);
  });

  it("refuses a WebSocket ticket from before the restart", async () => {
    const { store } = memoryStore();
    const first = await createHost({ sessionStore: store });
    const code = first.app.createPairingCode("test-browser").code;
    const paired = await request(first, {
      path: `${WEB_API_PATH}/session/pair`,
      method: "POST",
      headers: { Origin: first.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const setCookie = paired.headers["set-cookie"]?.[0] ?? "";
    // On this computer the limits stay short: 24 hours in all.
    expect(setCookie).toContain(`Max-Age=${24 * 60 * 60}`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    const cookie = setCookie.split(";")[0];
    const issued = await wsTicket(first, cookie, JSON.parse(paired.body).csrfToken);
    const { ticket } = JSON.parse(issued.body);
    await first.close();

    const second = await createHost({
      sessionStore: store,
      identity: { generation: "generation-two" },
    });
    const socket = new WebSocket(
      `ws://127.0.0.1:${second.port}${WEB_API_PATH}/ws`,
      ["cowork-web-v1", `cowork-ticket.${ticket}`],
      { headers: { Origin: second.origin, Cookie: cookie } },
    );
    const outcome = await new Promise<string>((resolve) => {
      socket.once("open", () => resolve("open"));
      socket.once("error", (error) => resolve(String(error)));
    });
    socket.terminate();
    expect(outcome).toContain("401");
  });

  it("does not restore sign-ins that expired, or belong to another host, while it was down", async () => {
    const now = Date.now();
    const good = storedSignIn("good");
    const idle = storedSignIn("idle", { lastUsedAt: now - 31 * 60_000 });
    const tooOld = storedSignIn("tooold", { createdAt: now - 91 * DAY_MS, expiresAt: now - 1 });
    const stretched = storedSignIn("stretched", { expiresAt: now + 400 * DAY_MS });
    const future = storedSignIn("future", { lastUsedAt: now + DAY_MS });
    const otherInstall = storedSignIn("install", { installationId: "another-installation" });
    const otherProfile = storedSignIn("profile", { profileId: "profile-beta" });
    const otherAddress = storedSignIn("address", {
      deployment: "https-proxy:https://cowork.example",
    });
    const otherRuntime = storedSignIn("runtime", { runtime: "electron" });
    const otherListener = storedSignIn("listener", { audience: "another-listener" });
    const all = [
      good,
      idle,
      tooOld,
      stretched,
      future,
      otherInstall,
      otherProfile,
      otherAddress,
      otherRuntime,
      otherListener,
    ];
    const { store, records } = memoryStore(all.map((entry) => entry.record));

    const host = await createHost({ sessionStore: store });
    const cookieName = (await pair(host)).cookieName;
    const statusOf = async (entry: { cookieValue: string }) =>
      (await bootstrap(host, `${cookieName}=${entry.cookieValue}`)).status;

    expect(await statusOf(good)).toBe(200);
    for (const entry of all.slice(1)) expect(await statusOf(entry)).toBe(401);

    // Unusable sign-ins for this listener are forgotten. Another kind of host and another
    // listener keep theirs: this host cannot judge them.
    const keys = records().map((record) => record.key);
    expect(keys).toContain(good.record.key);
    expect(keys).toContain(otherRuntime.record.key);
    expect(keys).toContain(otherListener.record.key);
    for (const entry of [idle, tooOld, stretched, future, otherInstall, otherProfile, otherAddress])
      expect(keys).not.toContain(entry.record.key);
  });

  it("forgets every sign-in on Sign out all browsers, including a stopped listener's", async () => {
    const stopped = storedSignIn("stopped", { audience: "another-listener" });
    const { store, records } = memoryStore([stopped.record]);
    const first = await createHost({ sessionStore: store });
    const session = await pair(first);
    expect(records()).toHaveLength(2);

    expect(first.app.revokeSessions()).toBe(1);
    expect(records()).toHaveLength(0);
    expect((await bootstrap(first, session.cookie)).status).toBe(401);
    await first.close();

    const second = await createHost({ sessionStore: store });
    expect(second.app.countSessions()).toBe(0);
    expect((await bootstrap(second, session.cookie)).status).toBe(401);
  });

  it("forgets a browser's own sign-out and an expired session", async () => {
    const { store, records } = memoryStore();
    const host = await createHost({ sessionStore: store, sessionIdleTtlMs: 40 });
    const session = await pair(host);
    const loggedOut = await request(host, {
      path: `${WEB_API_PATH}/session/logout`,
      method: "POST",
      headers: { Origin: host.origin, Cookie: session.cookie, "X-CoWork-CSRF": session.csrfToken },
    });
    expect(loggedOut.status).toBe(200);
    expect(records()).toHaveLength(0);

    const idle = await pair(host);
    expect(records()).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect((await bootstrap(host, idle.cookie)).status).toBe(401);
    expect(records()).toHaveLength(0);
  });

  it("keeps sign-ins when a listener stops and restores them when it starts again", async () => {
    const revoked: string[] = [];
    const { store, records } = memoryStore();
    const host = await createHost({
      sessionStore: store,
      onSessionRevoked: (sessionId) => revoked.push(sessionId),
    });
    await pair(host);
    await host.close();

    // The stopped listener's sessions end here, with their handles, but stay stored.
    expect(host.app.countSessions()).toBe(0);
    expect(revoked).toHaveLength(1);
    expect(records()).toHaveLength(1);

    const again = host.app.mount({
      audience: "test-browser",
      listenerHost: "127.0.0.1",
      getListenerPort: () => undefined,
    });
    expect(host.app.countSessions("test-browser")).toBe(1);
    await again.close();
    expect(records()).toHaveLength(1);
  });

  it("refuses a cookie that is not the one that was issued", async () => {
    const { store, records } = memoryStore();
    const first = await createHost({ sessionStore: store });
    const session = await pair(first);
    await first.close();
    const second = await createHost({ sessionStore: store });

    // The stored hash is not a credential, and neither is a guess.
    const storedKey = records()[0].key;
    expect((await bootstrap(second, `${session.cookieName}=${storedKey}`)).status).toBe(401);
    const guess = `${session.cookie.slice(0, -1)}${session.cookie.endsWith("A") ? "B" : "A"}`;
    expect((await bootstrap(second, guess)).status).toBe(401);
    expect((await bootstrap(second, session.cookie)).status).toBe(200);
  });

  it("writes the last-used time at most once per interval, and once more when it stops", async () => {
    const { store, writes, records } = memoryStore();
    const host = await createHost({ sessionStore: store, sessionPersistIntervalMs: 60_000 });
    const session = await pair(host);
    const createdAt = records()[0].lastUsedAt;
    await new Promise((resolve) => setTimeout(resolve, 15));
    for (let index = 0; index < 5; index += 1) await bootstrap(host, session.cookie);
    expect(writes.touch).toBe(0);
    expect(records()[0].lastUsedAt).toBe(createdAt);

    await host.close();
    expect(writes.touch).toBe(1);
    expect(records()[0].lastUsedAt).toBeGreaterThan(createdAt);

    // With no interval, every use is written through.
    const eager = await createHost({ sessionStore: store, sessionPersistIntervalMs: 0 });
    await new Promise((resolve) => setTimeout(resolve, 15));
    await bootstrap(eager, session.cookie);
    expect(writes.touch).toBe(2);
  });

  it("keeps a sign-in for 30 days of disuse through the HTTPS address, not on this computer", async () => {
    const now = Date.now();
    const lifetime = { createdAt: now - 40 * DAY_MS, lastUsedAt: now - 20 * DAY_MS };
    const remote = storedSignIn("remote", {
      ...lifetime,
      expiresAt: now + 50 * DAY_MS,
      deployment: "https-proxy:https://browser.example",
    });
    const tooIdle = storedSignIn("tooidle", {
      ...remote.record,
      key: sha256("another-cookie"),
      lastUsedAt: now - 31 * DAY_MS,
    });
    const local = storedSignIn("local", { ...lifetime, expiresAt: now + 50 * DAY_MS });
    const { store, records } = memoryStore([remote.record, tooIdle.record, local.record]);

    const proxied = await createHost({
      sessionStore: store,
      deployment: {
        mode: "https-proxy",
        publicOrigin: "https://browser.example",
        trustedProxyAddresses: ["127.0.0.1"],
      },
    });
    expect(proxied.app.countSessions()).toBe(1);
    await proxied.close();

    // The same age of sign-in is far past the limits of a host reached over loopback.
    const loopback = await createHost({ sessionStore: store });
    expect(loopback.app.countSessions()).toBe(0);
    // And a sign-in made at another address is forgotten: the address change signs it out.
    expect(records()).toEqual([]);
  });

  it("retries a sign-out the store did not record, and never restores it meanwhile", async () => {
    const { store, records } = memoryStore();
    let failRemovals = true;
    const flaky: WebSessionStore = {
      ...store,
      remove(keys) {
        if (failRemovals) throw new Error("database is locked");
        store.remove(keys);
      },
      clear(audience) {
        if (failRemovals) throw new Error("database is locked");
        store.clear(audience);
      },
    };
    const host = await createHost({ sessionStore: flaky });
    const access: BrowserAppAccess = {
      getApplication: () => host.app,
      resolveListener: () => ({ origin: host.origin, audience: "test-browser" }),
      offMessage: "off",
      noListenerMessage: "no listener",
    };
    const session = await pair(host);
    const loggedOut = await request(host, {
      path: `${WEB_API_PATH}/session/logout`,
      method: "POST",
      headers: { Origin: host.origin, Cookie: session.cookie, "X-CoWork-CSRF": session.csrfToken },
    });
    expect(loggedOut.status).toBe(200);

    // The write failed, so the record is still stored, but this host will not honour it.
    expect(records()).toHaveLength(1);
    expect(host.app.hasUnsavedSignOuts()).toBe(true);
    await host.close();
    const remounted = host.app.mount({
      audience: "test-browser",
      listenerHost: "127.0.0.1",
      getListenerPort: () => undefined,
    });
    expect(host.app.countSessions()).toBe(0);

    // Sign out all says so instead of reporting a sign-out that a restart could undo.
    expect(() => signOutBrowserApp(access)).toThrow("could not save");
    expect(records()).toHaveLength(1);

    // Once the store works again, the next store call records every pending sign-out.
    failRemovals = false;
    expect(signOutBrowserApp(access)).toEqual({ signedOut: 0 });
    expect(records()).toHaveLength(0);
    expect(host.app.hasUnsavedSignOuts()).toBe(false);
    await remounted.close();
  });

  it("still signs browsers in when the store fails, and logs no stored detail", async () => {
    const log = vi.fn();
    const failing: WebSessionStore = {
      load: () => {
        throw new Error("cannot read secret-detail");
      },
      add: () => {
        throw new Error("cannot write secret-detail");
      },
      touch: () => {
        throw new Error("cannot write secret-detail");
      },
      remove: () => {
        throw new Error("cannot write secret-detail");
      },
      clear: () => {
        throw new Error("cannot write secret-detail");
      },
    };
    const host = await createHost({ sessionStore: failing, log, sessionPersistIntervalMs: 0 });
    const session = await pair(host);
    expect((await bootstrap(host, session.cookie)).status).toBe(200);
    expect(host.app.revokeSessions()).toBe(1);
    expect((await bootstrap(host, session.cookie)).status).toBe(401);

    expect(log).toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret-detail");
  });
});
