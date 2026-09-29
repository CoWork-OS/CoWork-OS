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
    methods?: WebApplicationOptions["methods"];
    handleWorkspaceFileDownload?: WebApplicationOptions["handleWorkspaceFileDownload"];
    handleWorkspaceFileUpload?: WebApplicationOptions["handleWorkspaceFileUpload"];
    handleArtifactDownload?: WebApplicationOptions["handleArtifactDownload"];
    onSessionRevoked?: WebApplicationOptions["onSessionRevoked"];
  } = {},
): Promise<TestHost> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-web-app-"));
  await fs.writeFile(path.join(directory, "index.html"), "<main>browser shell</main>");
  await fs.mkdir(path.join(directory, "assets"));
  await fs.writeFile(path.join(directory, "assets", "app.js"), "globalThis.ready = true;");

  const identity: HostIdentity = {
    installationId: "opaque-web-installation",
    profileId: "profile-alpha",
    generation: "generation-one",
    runtime: "node",
    platform: "linux",
    appVersion: "1.2.3",
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
    handleArtifactDownload: options.handleArtifactDownload,
    onSessionRevoked: options.onSessionRevoked,
    pairingTtlMs: options.pairingTtlMs,
    requestBodyTimeoutMs: options.requestBodyTimeoutMs,
    sessionIdleTtlMs: options.sessionIdleTtlMs,
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
    const asset = await request(host, { path: "/app/assets/app.js" });
    const bootstrap = await request(host, { path: `${WEB_API_PATH}/bootstrap` });

    expect(shell.status).toBe(200);
    expect(shell.body).toContain("browser shell");
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
    expect(response.headers["set-cookie"]?.[0]).toContain("Secure");
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
