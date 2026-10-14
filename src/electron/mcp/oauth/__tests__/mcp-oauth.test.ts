import { createHash, generateKeyPairSync, verify } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { MCPAuthConfig } from "../../types";
import {
  authorizeWithPkce,
  buildJwtAssertion,
  canRenewWithoutUser,
  discoverOAuthMetadata,
  McpAuthorizationRequiredError,
  parseExpiresIn,
  renewOAuthToken,
  workdayEndpoints,
} from "../mcp-oauth";

const nativeFetch = globalThis.fetch;
const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

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
