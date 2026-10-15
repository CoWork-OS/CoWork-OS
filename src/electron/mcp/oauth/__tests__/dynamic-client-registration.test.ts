import { createHash } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { MCPAuthConfig } from "../../types";
import {
  authorizeWithPkce,
  canRenewWithoutUser,
  parseChallengeScopes,
  prepareDynamicClient,
  registerOAuthClient,
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

interface ProviderOptions {
  /** What the registration endpoint answers; defaults to a public client. */
  registration?: Record<string, unknown>;
  /** Overrides for the authorization server metadata. */
  metadata?: (base: string) => Record<string, unknown>;
  /** WWW-Authenticate challenge for an unauthenticated MCP request; none answers 404. */
  challenge?: (base: string) => string;
}

/**
 * A hosted MCP provider: protected-resource metadata, authorization server
 * metadata, RFC 7591 registration, and an authorization-code + PKCE flow.
 */
async function startProvider(options: ProviderOptions = {}) {
  const registrations: Record<string, unknown>[] = [];
  const tokenForms: URLSearchParams[] = [];
  const issued = new Map<string, { challenge: string; redirectUri: string; clientId: string }>();
  const server = http.createServer(async (req, res) => {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const url = new URL(req.url || "/", base);
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const readBody = async () => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      return raw;
    };
    if (url.pathname === "/mcp" && req.method === "POST") {
      await readBody();
      if (!options.challenge) return json({ error: "not found" }, 404);
      res.writeHead(401, { "WWW-Authenticate": options.challenge(base) }).end();
      return;
    }
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp")
      return json({
        resource: `${base}/mcp`,
        authorization_servers: [base],
        scopes_supported: ["read", "write"],
      });
    if (url.pathname === "/.well-known/oauth-authorization-server")
      return json(
        options.metadata?.(base) ?? {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
        },
      );
    if (url.pathname === "/register" && req.method === "POST") {
      const body = JSON.parse(await readBody());
      registrations.push(body);
      return json(
        options.registration ?? {
          client_id: "dcr-client-1",
          token_endpoint_auth_method: "none",
          redirect_uris: body.redirect_uris,
        },
        201,
      );
    }
    if (url.pathname === "/authorize") {
      const code = `code-${issued.size + 1}`;
      issued.set(code, {
        challenge: url.searchParams.get("code_challenge") || "",
        redirectUri: url.searchParams.get("redirect_uri") || "",
        clientId: url.searchParams.get("client_id") || "",
      });
      const target = new URL(url.searchParams.get("redirect_uri")!);
      target.searchParams.set("code", code);
      target.searchParams.set("state", url.searchParams.get("state") || "");
      res.writeHead(302, { Location: target.toString() }).end();
      return;
    }
    if (url.pathname === "/token") {
      const form = new URLSearchParams(await readBody());
      tokenForms.push(form);
      const grant = issued.get(form.get("code") || "");
      const challenge = createHash("sha256")
        .update(form.get("code_verifier") || "")
        .digest("base64url");
      if (!grant || grant.challenge !== challenge || grant.clientId !== form.get("client_id"))
        return json({ error: "invalid_grant" }, 400);
      return json({ access_token: "access-1", refresh_token: "refresh-1", token_type: "Bearer" });
    }
    res.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, registrations, tokenForms };
}

function registryAuth(redirectUri: string): MCPAuthConfig {
  return {
    type: "bearer",
    oauth: { grant: "authorization_code", redirectUri, dynamicClientRegistration: true },
  };
}

describe("MCP OAuth dynamic client registration", () => {
  it("discovers the provider, registers a public client and signs in with PKCE", async () => {
    const { base, registrations, tokenForms } = await startProvider();
    const redirectUri = `http://127.0.0.1:${await freePort()}/oauth/callback`;

    const prepared = await prepareDynamicClient(registryAuth(redirectUri), `${base}/mcp`, {
      fetchImpl: nativeFetch,
    });
    expect(registrations).toEqual([
      {
        client_name: "CoWork OS",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
    ]);
    expect(prepared).toMatchObject({
      clientId: "dcr-client-1",
      tokenUrl: `${base}/token`,
      oauth: {
        authorizationUrl: `${base}/authorize`,
        tokenAuthMethod: "none",
        resource: `${base}/mcp`,
        scopes: ["read", "write"],
        scopesDiscovered: true,
        dynamicClientRegistration: true,
      },
    });
    expect(prepared.clientSecret).toBeUndefined();

    let opened = "";
    const next = await authorizeWithPkce(prepared, {
      fetchImpl: nativeFetch,
      openUrl: async (url) => {
        opened = url;
        const response = await nativeFetch(url, { redirect: "manual" });
        await nativeFetch(response.headers.get("location")!);
      },
    });
    expect(new URL(opened).searchParams.get("client_id")).toBe("dcr-client-1");
    expect(tokenForms[0].get("client_secret")).toBeNull();
    expect(next).toMatchObject({ token: "access-1", refreshToken: "refresh-1" });
    expect(canRenewWithoutUser(next)).toBe(true);

    // Signing in again reuses the registered client.
    expect(await prepareDynamicClient(next, `${base}/mcp`, { fetchImpl: nativeFetch })).toBe(next);
    expect(registrations).toHaveLength(1);
  });

  it("keeps a confidential client's secret and the auth method the provider assigned", async () => {
    const { base } = await startProvider({
      registration: {
        client_id: "dcr-client-2",
        client_secret: "dcr-secret-2",
        token_endpoint_auth_method: "client_secret_basic",
      },
    });
    const prepared = await prepareDynamicClient(
      registryAuth("http://127.0.0.1:18768/oauth/callback"),
      `${base}/mcp`,
      { fetchImpl: nativeFetch },
    );
    expect(prepared).toMatchObject({
      clientId: "dcr-client-2",
      clientSecret: "dcr-secret-2",
      oauth: { tokenAuthMethod: "client_secret_basic" },
    });
  });

  it("asks for a confidential client when the server does not allow public ones", async () => {
    const { base, registrations } = await startProvider({
      metadata: (b) => ({
        issuer: b,
        authorization_endpoint: `${b}/authorize`,
        token_endpoint: `${b}/token`,
        registration_endpoint: `${b}/register`,
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      }),
      registration: { client_id: "dcr-client-3", client_secret: "dcr-secret-3" },
    });
    const prepared = await prepareDynamicClient(
      registryAuth("http://127.0.0.1:18768/oauth/callback"),
      `${base}/mcp`,
      { fetchImpl: nativeFetch },
    );
    expect(registrations[0].token_endpoint_auth_method).toBe("client_secret_basic");
    // No method in the answer: a client with a secret defaults to client_secret_basic (RFC 7591).
    expect(prepared.oauth?.tokenAuthMethod).toBe("client_secret_basic");
  });

  it("asks for the scopes the server's 401 challenge names over everything it supports", async () => {
    const { base } = await startProvider({
      challenge: (b) =>
        `Bearer resource_metadata="${b}/.well-known/oauth-protected-resource/mcp", scope="read"`,
    });
    const prepared = await prepareDynamicClient(
      registryAuth("http://127.0.0.1:18768/oauth/callback"),
      `${base}/mcp`,
      { fetchImpl: nativeFetch },
    );
    expect(prepared.oauth?.scopes).toEqual(["read"]);
  });

  it("asks a changed challenge's scopes again, unless the person typed the scopes", async () => {
    const { base } = await startProvider({
      challenge: (b) =>
        `Bearer resource_metadata="${b}/.well-known/oauth-protected-resource/mcp", scope="read write"`,
    });
    const auth = registryAuth("http://127.0.0.1:18768/oauth/callback");
    // Scopes a previous sign-in discovered: the server is asked again.
    const rediscovered = await prepareDynamicClient(
      { ...auth, oauth: { ...auth.oauth!, scopes: ["read"], scopesDiscovered: true } },
      `${base}/mcp`,
      { fetchImpl: nativeFetch },
    );
    expect(rediscovered.oauth?.scopes).toEqual(["read", "write"]);
    expect(rediscovered.oauth?.scopesDiscovered).toBe(true);
    // Scopes the person typed stay as typed.
    const typed = await prepareDynamicClient(
      { ...auth, oauth: { ...auth.oauth!, scopes: ["admin"] } },
      `${base}/mcp`,
      { fetchImpl: nativeFetch },
    );
    expect(typed.oauth?.scopes).toEqual(["admin"]);
    expect(typed.oauth?.scopesDiscovered).toBe(false);
  });

  it("falls back to the metadata's scopes when the challenge names none", async () => {
    const { base } = await startProvider({ challenge: () => 'Bearer error="invalid_token"' });
    const prepared = await prepareDynamicClient(
      registryAuth("http://127.0.0.1:18768/oauth/callback"),
      `${base}/mcp`,
      { fetchImpl: nativeFetch },
    );
    expect(prepared.oauth?.scopes).toEqual(["read", "write"]);
  });

  it("parses the scope parameter of a Bearer challenge", () => {
    expect(parseChallengeScopes('Bearer realm="x", scope="mcp  operator"')).toEqual([
      "mcp",
      "operator",
    ]);
    expect(parseChallengeScopes('Bearer resource_metadata="https://a.example/prm"')).toEqual([]);
    expect(parseChallengeScopes(null)).toEqual([]);
  });

  it("leaves servers without dynamic registration untouched", async () => {
    const auth: MCPAuthConfig = {
      type: "bearer",
      clientId: "manual",
      oauth: { grant: "authorization_code", redirectUri: "http://127.0.0.1:18768/oauth/callback" },
    };
    expect(await prepareDynamicClient(auth, "https://unused.example/mcp")).toBe(auth);
  });

  it("refuses a provider that offers no registration endpoint", async () => {
    const { base } = await startProvider({
      metadata: (b) => ({
        issuer: b,
        authorization_endpoint: `${b}/authorize`,
        token_endpoint: `${b}/token`,
      }),
    });
    await expect(
      prepareDynamicClient(registryAuth("http://127.0.0.1:18768/oauth/callback"), `${base}/mcp`, {
        fetchImpl: nativeFetch,
      }),
    ).rejects.toThrow(/no client registration endpoint/);
  });

  it("refuses metadata that points an endpoint at plain http off this machine", async () => {
    const { base, registrations } = await startProvider({
      metadata: (b) => ({
        issuer: b,
        authorization_endpoint: `${b}/authorize`,
        token_endpoint: "http://tokens.example/token",
        registration_endpoint: `${b}/register`,
      }),
    });
    await expect(
      prepareDynamicClient(registryAuth("http://127.0.0.1:18768/oauth/callback"), `${base}/mcp`, {
        fetchImpl: nativeFetch,
      }),
    ).rejects.toThrow(/token endpoint must use https/);
    expect(registrations).toHaveLength(0);
  });

  it("refuses metadata that describes a different resource", async () => {
    const { base, registrations } = await startProvider();
    // The provider's metadata names `${base}/mcp`; this server lives elsewhere on that host.
    await expect(
      prepareDynamicClient(registryAuth("http://127.0.0.1:18768/oauth/callback"), `${base}/other`, {
        fetchImpl: async (url, init) => {
          const target = String(url).replace(
            "/oauth-protected-resource/other",
            "/oauth-protected-resource/mcp",
          );
          return nativeFetch(target, init);
        },
      }),
    ).rejects.toThrow(/different resource/);
    expect(registrations).toHaveLength(0);
  });

  it("does not let a hosted server's metadata point the app at this machine", async () => {
    const requested: string[] = [];
    const fetchImpl = async (url: string) => {
      requested.push(url);
      const body = url.includes("oauth-protected-resource")
        ? {
            resource: "https://mcp.vendor.example/mcp",
            authorization_servers: ["http://127.0.0.1:9/"],
          }
        : {
            issuer: "https://mcp.vendor.example",
            authorization_endpoint: "https://mcp.vendor.example/authorize",
            token_endpoint: "https://mcp.vendor.example/token",
            registration_endpoint: "http://127.0.0.1:9/register",
          };
      return new Response(JSON.stringify(body), { status: 200 });
    };
    await expect(
      prepareDynamicClient(
        registryAuth("http://127.0.0.1:18768/oauth/callback"),
        "https://mcp.vendor.example/mcp",
        { fetchImpl },
      ),
    ).rejects.toThrow(/must use https|no authorization endpoint/);
    expect(requested.some((url) => url.startsWith("http://127.0.0.1"))).toBe(false);
  });

  it("stops discovery when the sign-in is cancelled", async () => {
    const controller = new AbortController();
    const fetchImpl = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        controller.abort();
      });
    await expect(
      prepareDynamicClient(
        registryAuth("http://127.0.0.1:18768/oauth/callback"),
        "https://mcp.vendor.example/mcp",
        { fetchImpl, signal: controller.signal },
      ),
    ).rejects.toThrow(/cancelled/i);
  });

  it("reports a rejected registration with credentials redacted", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: "invalid_redirect_uri", client_secret: "leak" }), {
        status: 400,
      });
    await expect(
      registerOAuthClient("https://as.example/register", "http://127.0.0.1:18768/oauth/callback", {
        fetchImpl,
      }),
    ).rejects.toThrow(/registration failed \(400\).*invalid_redirect_uri.*\[REDACTED\]/);
  });

  it("rejects a registration answer without a client_id", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({}), { status: 201 });
    await expect(
      registerOAuthClient("https://as.example/register", "http://127.0.0.1:18768/oauth/callback", {
        fetchImpl,
      }),
    ).rejects.toThrow(/did not return a client_id/);
  });
});
