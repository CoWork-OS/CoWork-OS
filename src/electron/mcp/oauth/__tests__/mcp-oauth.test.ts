import { createHash, generateKeyPairSync, verify, X509Certificate } from "node:crypto";
import * as http from "node:http";
import * as https from "node:https";
import type { AddressInfo } from "node:net";
import * as net from "node:net";
import type { TLSSocket } from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import type { MCPAuthConfig } from "../../types";
import {
  activeLoopbackPorts,
  authorizeWithPkce,
  buildJwtAssertion,
  canRenewWithoutUser,
  discoverOAuthMetadata,
  isMcpSignInCancelled,
  McpAuthorizationRequiredError,
  McpSignInCancelledError,
  parseExpiresIn,
  parseLoopbackRedirect,
  renewOAuthToken,
  workdayEndpoints,
} from "../mcp-oauth";
import { createLoopbackTlsCredentials } from "../loopback-tls";

const nativeFetch = globalThis.fetch;
const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

/** What a client sees when it dials the port: "connected" or the socket error code. */
function probePort(port: number): Promise<string> {
  return new Promise<string>((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve("connected");
    });
    socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code || "error"));
  });
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

async function freePort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

type TokenHandler = (
  form: URLSearchParams,
  req: http.IncomingMessage,
) => {
  status?: number;
  body: Record<string, unknown>;
};

/** Minimal OAuth server: /authorize redirects with a code; /token runs the handler. */
async function startAuthServer(onToken: TokenHandler) {
  const issued = new Map<string, { challenge: string; redirectUri: string }>();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/authorize") {
      const code = `code-${issued.size + 1}`;
      issued.set(code, {
        challenge: url.searchParams.get("code_challenge") || "",
        redirectUri: url.searchParams.get("redirect_uri") || "",
      });
      const target = new URL(url.searchParams.get("redirect_uri")!);
      target.searchParams.set("code", code);
      target.searchParams.set("state", url.searchParams.get("state") || "");
      res.writeHead(302, { Location: target.toString() }).end();
      return;
    }
    if (url.pathname === "/token") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const form = new URLSearchParams(raw);
      if (form.get("grant_type") === "authorization_code") {
        const grant = issued.get(form.get("code") || "");
        const challenge = createHash("sha256")
          .update(form.get("code_verifier") || "")
          .digest("base64url");
        if (
          !grant ||
          grant.challenge !== challenge ||
          grant.redirectUri !== form.get("redirect_uri")
        ) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
      }
      const result = onToken(form, req);
      res.writeHead(result.status ?? 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result.body));
      return;
    }
    res.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, issued };
}

describe("MCP OAuth", () => {
  it("accepts expires_in as an integer or a numeric string", () => {
    expect(parseExpiresIn(14400)).toBe(14400);
    expect(parseExpiresIn("14400")).toBe(14400);
    expect(parseExpiresIn("soon")).toBeUndefined();
    expect(parseExpiresIn(-1)).toBeUndefined();
  });

  it("derives Workday endpoints and rejects unsafe region or tenant values", () => {
    expect(workdayEndpoints("us", "acme_dev1")).toEqual({
      url: "https://us.agent.workday.com/acme_dev1/mcp",
      authorizationUrl: "https://us.agent.workday.com/auth/authorize/acme_dev1",
      tokenUrl: "https://us.agent.workday.com/auth/oauth2/acme_dev1/token",
    });
    expect(() => workdayEndpoints("us.evil.com/x", "t")).toThrow(/region/);
    expect(() => workdayEndpoints("us", "../admin")).toThrow(/tenant/);
  });

  it("signs a JWT bearer assertion the key holder can verify", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const auth: MCPAuthConfig = {
      type: "bearer",
      clientId: "client-1",
      tokenUrl: "https://us.agent.workday.com/auth/oauth2/acme/token",
      privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      oauth: { grant: "jwt_bearer", jwt: { subject: "asu-agent", keyId: "k1" } },
    };
    const [header, payload, signature] = buildJwtAssertion(auth, 1_800_000_000_000).split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
      kid: "k1",
    });
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toMatchObject({
      iss: "client-1",
      sub: "asu-agent",
      aud: auth.tokenUrl,
      iat: 1_800_000_000,
      exp: 1_800_000_300,
    });
    expect(
      verify(
        "sha256",
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
  });

  it("completes authorization code + PKCE through the registered loopback redirect", async () => {
    const { base } = await startAuthServer((form) => ({
      body: {
        access_token: "access-1",
        refresh_token: "refresh-1",
        token_type: "Bearer",
        expires_in: "14400",
        client: form.get("client_id"),
      },
    }));
    const port = await freePort();
    const auth: MCPAuthConfig = {
      type: "bearer",
      clientId: "client-1",
      clientSecret: "secret-1",
      tokenUrl: `${base}/token`,
      oauth: {
        grant: "authorization_code",
        authorizationUrl: `${base}/authorize`,
        redirectUri: `http://127.0.0.1:${port}/oauth/callback`,
        resource: "https://us.agent.workday.com/acme/mcp",
      },
    };
    let openedUrl = "";
    const next = await authorizeWithPkce(auth, {
      fetchImpl: nativeFetch,
      openUrl: async (url) => {
        openedUrl = url;
        // Stand in for the browser: follow the provider's redirect to the loopback.
        const response = await nativeFetch(url, { redirect: "manual" });
        await nativeFetch(response.headers.get("location")!);
      },
    });
    const opened = new URL(openedUrl);
    expect(opened.searchParams.get("code_challenge_method")).toBe("S256");
    expect(opened.searchParams.get("resource")).toBe("https://us.agent.workday.com/acme/mcp");
    expect(next).toMatchObject({ token: "access-1", refreshToken: "refresh-1" });
    expect(next.expiresAt! - Date.now()).toBeGreaterThan(14_000 * 1000);
    expect(canRenewWithoutUser(next)).toBe(true);
  });

  it("accepts http and https loopback redirects with an explicit port only", () => {
    expect(parseLoopbackRedirect("http://127.0.0.1:18768/oauth/callback").port).toBe("18768");
    expect(parseLoopbackRedirect("https://127.0.0.1:18768/oauth/callback").protocol).toBe("https:");
    expect(parseLoopbackRedirect("https://localhost:9000/cb").hostname).toBe("localhost");
    expect(parseLoopbackRedirect("https://[::1]:9000/cb").hostname).toBe("[::1]");
    for (const rejected of [
      "https://example.com:18768/oauth/callback",
      "https://10.0.0.5:18768/oauth/callback",
      "http://127.0.0.1/oauth/callback",
      "https://127.0.0.1/oauth/callback",
      "ftp://127.0.0.1:21/cb",
    ])
      expect(() => parseLoopbackRedirect(rejected)).toThrow(/http or https loopback/);
  });

  it("issues a fresh one-day self-signed loopback certificate per sign-in", () => {
    const now = Date.now();
    const first = createLoopbackTlsCredentials(now);
    const second = createLoopbackTlsCredentials(now);
    const cert = new X509Certificate(first.cert);
    expect(cert.subject).toBe("CN=127.0.0.1");
    expect(cert.checkIP("127.0.0.1")).toBe("127.0.0.1");
    expect(cert.checkIP("::1")).toBe("::1");
    expect(cert.checkHost("localhost")).toBe("localhost");
    expect(cert.ca).toBe(false);
    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(Date.parse(cert.validTo) - now).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    expect(Date.parse(cert.validFrom)).toBeLessThan(now);
    expect(first.cert).not.toContain("PRIVATE KEY");
    expect(second.key).not.toBe(first.key);
    expect(new X509Certificate(second.cert).serialNumber).not.toBe(cert.serialNumber);
  });

  it("completes authorization code + PKCE through an https loopback redirect", async () => {
    const { base } = await startAuthServer(() => ({
      body: { access_token: "access-tls", refresh_token: "refresh-tls", expires_in: 3600 },
    }));
    const port = await freePort();
    const redirectUri = `https://127.0.0.1:${port}/oauth/callback`;
    const auth: MCPAuthConfig = {
      type: "bearer",
      clientId: "client-1",
      tokenUrl: `${base}/token`,
      oauth: { grant: "authorization_code", authorizationUrl: `${base}/authorize`, redirectUri },
    };
    // Stand in for a browser whose person accepted the certificate warning.
    const visit = (target: string) =>
      new Promise<{ status: number; body: string; cert: X509Certificate | undefined }>(
        (resolve, reject) => {
          https
            .get(target, { rejectUnauthorized: false, agent: false }, (res) => {
              const raw = (res.socket as TLSSocket).getPeerX509Certificate?.();
              let body = "";
              res.on("data", (chunk) => (body += chunk));
              res.on("end", () => resolve({ status: res.statusCode ?? 0, body, cert: raw }));
            })
            .on("error", reject);
        },
      );
    let stray: Awaited<ReturnType<typeof visit>> | undefined;
    let callback: Awaited<ReturnType<typeof visit>> | undefined;
    const next = await authorizeWithPkce(auth, {
      fetchImpl: nativeFetch,
      openUrl: async (url) => {
        const response = await nativeFetch(url, { redirect: "manual" });
        const location = new URL(response.headers.get("location")!);
        expect(location.protocol).toBe("https:");
        // A callback with the wrong state is refused and does not end the flow.
        const wrong = new URL(location);
        wrong.searchParams.set("state", "not-the-state");
        wrong.searchParams.set("code", "stolen");
        stray = await visit(wrong.toString());
        callback = await visit(location.toString());
      },
    });
    expect(stray?.status).toBe(400);
    expect(stray?.body).toContain("does not match");
    expect(callback?.status).toBe(200);
    expect(callback?.body).toContain("Authorization complete");
    expect(callback?.cert?.checkIP("127.0.0.1")).toBe("127.0.0.1");
    expect(next).toMatchObject({ token: "access-tls", refreshToken: "refresh-tls" });
    // The listener is gone once sign-in finishes.
    const refused = await new Promise<string>((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve("connected");
      });
      socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code || "error"));
    });
    expect(refused).toBe("ECONNREFUSED");
  });

  it("cancels a pending http or https sign-in: the port is released and no token is requested", async () => {
    for (const scheme of ["http", "https"]) {
      const port = await freePort();
      const tokenRequests: string[] = [];
      const opened = deferred();
      const controller = new AbortController();
      const pending = authorizeWithPkce(
        {
          type: "bearer",
          clientId: "client-1",
          tokenUrl: "https://idp.invalid/token",
          oauth: {
            grant: "authorization_code",
            authorizationUrl: "https://idp.invalid/authorize",
            redirectUri: `${scheme}://127.0.0.1:${port}/oauth/callback`,
          },
        },
        {
          signal: controller.signal,
          openUrl: () => opened.resolve(),
          fetchImpl: async (url) => {
            tokenRequests.push(url);
            throw new Error("no token request expected");
          },
        },
      );
      const outcome = pending.then(
        () => undefined,
        (error: unknown) => error,
      );
      await opened.promise;
      expect(await probePort(port)).toBe("connected");
      expect(activeLoopbackPorts()).toContain(port);
      controller.abort();
      const error = await outcome;
      expect(isMcpSignInCancelled(error)).toBe(true);
      expect((error as McpSignInCancelledError).reason).toBe("cancelled");
      expect(await probePort(port)).toBe("ECONNREFUSED");
      expect(activeLoopbackPorts()).not.toContain(port);
      expect(tokenRequests).toEqual([]);
    }
  });

  it("still cancels when opening the browser never settles", async () => {
    const port = await freePort();
    const controller = new AbortController();
    const pending = authorizeWithPkce(
      {
        type: "bearer",
        clientId: "client-1",
        tokenUrl: "https://idp.invalid/token",
        oauth: {
          grant: "authorization_code",
          authorizationUrl: "https://idp.invalid/authorize",
          redirectUri: `http://127.0.0.1:${port}/oauth/callback`,
        },
      },
      { signal: controller.signal, openUrl: () => new Promise<void>(() => {}) },
    );
    const outcome = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(await probePort(port)).toBe("connected");
    controller.abort();
    expect(isMcpSignInCancelled(await outcome)).toBe(true);
    expect(await probePort(port)).toBe("ECONNREFUSED");
  });

  it("refuses to start a sign-in whose signal is already aborted", async () => {
    const port = await freePort();
    const controller = new AbortController();
    controller.abort();
    let opened = false;
    const error = await authorizeWithPkce(
      {
        type: "bearer",
        clientId: "c",
        tokenUrl: "https://idp.invalid/token",
        oauth: {
          grant: "authorization_code",
          authorizationUrl: "https://idp.invalid/authorize",
          redirectUri: `http://127.0.0.1:${port}/oauth/callback`,
        },
      },
      { signal: controller.signal, openUrl: () => void (opened = true) },
    ).catch((caught: unknown) => caught);
    expect(isMcpSignInCancelled(error)).toBe(true);
    expect(opened).toBe(false);
    expect(await probePort(port)).toBe("ECONNREFUSED");
  });

  it("lets a newer sign-in take over the port from CoWork's own pending sign-in", async () => {
    const { base } = await startAuthServer((form) => ({
      body: { access_token: `token-for-${form.get("client_id")}`, expires_in: 3600 },
    }));
    const port = await freePort();
    const auth = (clientId: string): MCPAuthConfig => ({
      type: "bearer",
      clientId,
      tokenUrl: `${base}/token`,
      oauth: {
        grant: "authorization_code",
        authorizationUrl: `${base}/authorize`,
        redirectUri: `http://127.0.0.1:${port}/oauth/callback`,
      },
    });
    const firstOpened = deferred();
    const first = authorizeWithPkce(auth("first"), {
      fetchImpl: nativeFetch,
      // The person never finishes this sign-in.
      openUrl: () => firstOpened.resolve(),
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    await firstOpened.promise;
    const second = await authorizeWithPkce(auth("second"), {
      fetchImpl: nativeFetch,
      openUrl: async (url) => {
        const response = await nativeFetch(url, { redirect: "manual" });
        await nativeFetch(response.headers.get("location")!);
      },
    });
    const superseded = await first;
    expect(isMcpSignInCancelled(superseded)).toBe(true);
    expect((superseded as McpSignInCancelledError).reason).toBe("superseded");
    expect(second.token).toBe("token-for-second");
    expect(await probePort(port)).toBe("ECONNREFUSED");
  });

  it("still reports the port in use when another process holds it", async () => {
    const port = await freePort();
    const foreign = net.createServer();
    await new Promise<void>((resolve) => foreign.listen(port, "127.0.0.1", resolve));
    try {
      let opened = false;
      await expect(
        authorizeWithPkce(
          {
            type: "bearer",
            clientId: "c",
            tokenUrl: "https://idp.invalid/token",
            oauth: {
              grant: "authorization_code",
              authorizationUrl: "https://idp.invalid/authorize",
              redirectUri: `https://127.0.0.1:${port}/oauth/callback`,
            },
          },
          { openUrl: () => void (opened = true) },
        ),
      ).rejects.toThrow(`OAuth redirect port ${port} is in use`);
      expect(opened).toBe(false);
      expect(activeLoopbackPorts()).not.toContain(port);
    } finally {
      await new Promise<void>((resolve) => foreign.close(() => resolve()));
    }
  });

  it("refreshes a public client without a secret and keeps a refresh token the server did not rotate", async () => {
    let form: URLSearchParams | undefined;
    const { base } = await startAuthServer((received) => {
      form = received;
      return { body: { access_token: "access-2", expires_in: 60 } };
    });
    const next = await renewOAuthToken(
      {
        type: "bearer",
        token: "old",
        clientId: "public-client",
        tokenUrl: `${base}/token`,
        refreshToken: "refresh-1",
        oauth: { grant: "authorization_code" },
      },
      nativeFetch,
    );
    expect(form?.get("grant_type")).toBe("refresh_token");
    expect(form?.get("client_id")).toBe("public-client");
    expect(form?.has("client_secret")).toBe(false);
    expect(next).toMatchObject({ token: "access-2", refreshToken: "refresh-1" });
  });

  it("mints ambient tokens with a JWT bearer grant and needs no person", async () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    let grant = "";
    const { base } = await startAuthServer((form) => {
      grant = `${form.get("grant_type")}|${form.get("assertion")?.split(".").length}`;
      return { body: { access_token: "ambient-1", expires_in: 3600 } };
    });
    const auth: MCPAuthConfig = {
      type: "bearer",
      clientId: "client-1",
      tokenUrl: `${base}/token`,
      privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      oauth: { grant: "jwt_bearer", jwt: { subject: "asu-agent", algorithm: "ES256" } },
    };
    expect(canRenewWithoutUser(auth)).toBe(true);
    expect(await renewOAuthToken(auth, nativeFetch)).toMatchObject({ token: "ambient-1" });
    expect(grant).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer|3");
  });

  it("asks for a fresh sign-in when the refresh token is rejected or expired", async () => {
    const { base } = await startAuthServer(() => ({
      status: 400,
      body: { error: "invalid_grant", refresh_token: "should-not-leak" },
    }));
    const auth: MCPAuthConfig = {
      type: "bearer",
      clientId: "c",
      tokenUrl: `${base}/token`,
      refreshToken: "r",
      oauth: { grant: "authorization_code" },
    };
    const failure = await renewOAuthToken(auth, nativeFetch).catch((error) => error);
    expect(failure).toBeInstanceOf(McpAuthorizationRequiredError);
    expect(String(failure.message)).not.toContain("should-not-leak");
    expect(canRenewWithoutUser({ ...auth, refreshExpiresAt: Date.now() - 1 })).toBe(false);
  });

  it("discovers authorization endpoints from the 401 challenge's resource metadata", async () => {
    const server = http.createServer((req, res) => {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/prm")
        res.end(JSON.stringify({ resource: `${base}/mcp`, authorization_servers: [`${base}/as`] }));
      else if (req.url === "/.well-known/oauth-authorization-server/as")
        res.end(
          JSON.stringify({
            issuer: `${base}/as`,
            authorization_endpoint: `${base}/as/authorize`,
            token_endpoint: `${base}/as/token`,
          }),
        );
      else res.writeHead(404).end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect(
      await discoverOAuthMetadata(`${base}/mcp`, {
        wwwAuthenticate: `Bearer resource_metadata="${base}/prm"`,
        fetchImpl: nativeFetch,
      }),
    ).toEqual({
      authorizationUrl: `${base}/as/authorize`,
      tokenUrl: `${base}/as/token`,
      issuer: `${base}/as`,
      resource: `${base}/mcp`,
    });
  });
});
