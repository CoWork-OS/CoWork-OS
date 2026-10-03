import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSiwcAuthorizeUrl,
  clearOpenAIOAuthSession,
  createSiwcHostId,
  getOpenAISiwcClientId,
  isSiwcHostId,
  OpenAISiwcOAuth,
  SIWC_ISSUER,
  startSiwcCallbackServer,
  verifySiwcIdToken,
} from "../openai-siwc-oauth";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "key-1", alg: "RS256", use: "sig" };
const jwks = async () => [jwk as Record<string, unknown>];

function makeIdToken(claims: Record<string, unknown>, kid = "key-1"): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid })).toString(
    "base64url",
  );
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), privateKey).toString(
    "base64url",
  );
  return `${header}.${payload}.${signature}`;
}

const now = Math.floor(Date.now() / 1000);
const validClaims = {
  iss: SIWC_ISSUER,
  aud: "oaiapp_123",
  sub: "user-sub",
  email: "person@example.com",
  nonce: "nonce-1",
  exp: now + 600,
  iat: now,
};

describe("Sign in with ChatGPT authorize URL", () => {
  const base = {
    hostId: "urn:uuid:3f1c2a9e-1111-4222-8333-944455556666",
    redirectUri: "http://127.0.0.1:1455/auth/callback",
    state: "state-1",
    nonce: "nonce-1",
    codeChallenge: "challenge",
  };

  it("registers a new client with the dynamic client ID and agent name", () => {
    const url = new URL(buildSiwcAuthorizeUrl(base));
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/api/accounts/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "dynamic_agent_client",
      agent_name_hint: "CoWork OS",
      ext_agent_host_id: base.hostId,
      response_type: "code",
      redirect_uri: base.redirectUri,
      scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
      resource: "https://api.openai.com/v1",
      state: "state-1",
      nonce: "nonce-1",
      code_challenge_method: "S256",
      code_challenge: "challenge",
    });
  });

  it("reauthorizes a saved registration without agent_name_hint", () => {
    const url = new URL(
      buildSiwcAuthorizeUrl({
        ...base,
        registration: { clientId: "oaiapp_123", idToken: "old.id.token" },
      }),
    );
    expect(url.searchParams.get("client_id")).toBe("oaiapp_123");
    expect(url.searchParams.has("agent_name_hint")).toBe(false);
    expect(url.searchParams.get("id_token_hint")).toBe("old.id.token");
    expect(url.searchParams.get("ext_agent_host_id")).toBe(base.hostId);
  });

  it("creates opaque UUID host IDs", () => {
    const hostId = createSiwcHostId();
    expect(hostId).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    expect(isSiwcHostId(hostId)).toBe(true);
    expect(isSiwcHostId("person@example.com")).toBe(false);
  });
});

describe("Sign in with ChatGPT ID token validation", () => {
  it("accepts a correctly signed token for the issued client", async () => {
    const result = await verifySiwcIdToken(
      makeIdToken(validClaims),
      { clientId: "oaiapp_123", nonce: "nonce-1" },
      jwks,
    );
    expect(result).toMatchObject({ subject: "user-sub", email: "person@example.com" });
  });

  it.each([
    ["audience", { aud: "oaiapp_other" }, /different client/],
    ["issuer", { iss: "https://evil.example" }, /issuer/],
    ["nonce", { nonce: "other" }, /nonce/],
    ["expiry", { exp: now - 3600 }, /expired/],
    ["subject", { sub: "" }, /subject/],
  ])("rejects a token with the wrong %s", async (_label, override, error) => {
    await expect(
      verifySiwcIdToken(
        makeIdToken({ ...validClaims, ...override }),
        { clientId: "oaiapp_123", nonce: "nonce-1" },
        jwks,
      ),
    ).rejects.toThrow(error);
  });

  it("rejects a tampered signature", async () => {
    const [header, , signature] = makeIdToken(validClaims).split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ ...validClaims, sub: "attacker" })).toString(
      "base64url",
    );
    await expect(
      verifySiwcIdToken(
        `${header}.${forgedPayload}.${signature}`,
        { clientId: "oaiapp_123", nonce: "nonce-1" },
        jwks,
      ),
    ).rejects.toThrow(/signature is invalid/);
  });

  it("tries every compatible key when the token has no kid", async () => {
    const { publicKey: otherKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const keys = async () => [
      { ...otherKey.export({ format: "jwk" }), kid: "rotated", use: "sig" },
      { ...jwk, kid: "current" },
      { ...jwk, kid: "enc-only", use: "enc" },
    ] as Array<Record<string, unknown>>;
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify(validClaims)).toString("base64url");
    const signature = sign("sha256", Buffer.from(`${header}.${payload}`), privateKey).toString(
      "base64url",
    );
    await expect(
      verifySiwcIdToken(`${header}.${payload}.${signature}`, { clientId: "oaiapp_123", nonce: "nonce-1" }, keys),
    ).resolves.toMatchObject({ subject: "user-sub" });
  });

  it("rejects tokens signed with an unknown key", async () => {
    await expect(
      verifySiwcIdToken(
        makeIdToken(validClaims, "other-key"),
        { clientId: "oaiapp_123", nonce: "nonce-1" },
        jwks,
      ),
    ).rejects.toThrow(/No OpenAI signing key/);
  });
});

describe("Sign in with ChatGPT loopback callback", () => {
  it("ignores mismatched state and resolves the code with the issued client ID", async () => {
    const callback = await startSiwcCallbackServer("expected-state", 10_000, 0);
    try {
      const stray = await fetch(`${callback.redirectUri}?state=wrong&code=bad`);
      expect(stray.status).toBe(400);

      const ok = await fetch(`${callback.redirectUri}?state=expected-state&code=abc&client_id=oaiapp_9`);
      expect(ok.status).toBe(200);
      await expect(callback.result).resolves.toEqual({ code: "abc", issuedClientId: "oaiapp_9" });
    } finally {
      await callback.close();
    }
  });

  it("rejects when the user denies access", async () => {
    const callback = await startSiwcCallbackServer("s", 10_000, 0);
    try {
      await fetch(`${callback.redirectUri}?state=s&error=access_denied`);
      await expect(callback.result).rejects.toThrow(/cancelled/);
    } finally {
      await callback.close();
    }
  });
});

describe("Sign in with ChatGPT token refresh", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shares one refresh request between concurrent callers", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const tokens = { access_token: "old", refresh_token: "old-refresh", expires_at: 0, id_token: "id" };

    const [first, second] = await Promise.all([
      OpenAISiwcOAuth.refreshTokens("oaiapp_1", tokens),
      OpenAISiwcOAuth.refreshTokens("oaiapp_1", tokens),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://auth.openai.com/api/accounts/oauth/token");
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
      grant_type: "refresh_token",
      client_id: "oaiapp_1",
      refresh_token: "old-refresh",
      resource: "https://api.openai.com/v1",
    });
    expect(first).toEqual(second);
    expect(first).toMatchObject({ access_token: "new-access", refresh_token: "new-refresh", id_token: "id" });
  });

  it("flags unusable refresh tokens as requiring sign-in again", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "refresh_token_reused" }), { status: 400 })),
    );
    await expect(
      OpenAISiwcOAuth.refreshTokens("oaiapp_1", {
        access_token: "a",
        refresh_token: "reused",
        expires_at: 0,
      }),
    ).rejects.toMatchObject({ code: "refresh_token_reused", requiresReauth: true });
  });
});

describe("Sign in with ChatGPT settings helpers", () => {
  it("only reports a client ID for SIWC OAuth sessions", () => {
    expect(
      getOpenAISiwcClientId({
        openai: { authMethod: "oauth", oauthVariant: "siwc", siwcClientId: " oaiapp_1 " },
      }),
    ).toBe("oaiapp_1");
    expect(
      getOpenAISiwcClientId({ openai: { authMethod: "oauth", siwcClientId: "oaiapp_1" } }),
    ).toBeUndefined();
    expect(
      getOpenAISiwcClientId({
        openai: { authMethod: "api_key", oauthVariant: "siwc", siwcClientId: "oaiapp_1" },
      }),
    ).toBeUndefined();
  });

  it("clears the session but keeps the host and client registration", () => {
    const cleared = clearOpenAIOAuthSession({
      accessToken: "a",
      refreshToken: "r",
      tokenExpiresAt: 1,
      email: "person@example.com",
      authMethod: "oauth",
      oauthVariant: "siwc",
      siwcHostId: "urn:uuid:x",
      siwcClientId: "oaiapp_1",
      siwcSubject: "sub",
      model: "gpt-6-astra",
    });
    expect(cleared).toMatchObject({
      accessToken: undefined,
      refreshToken: undefined,
      authMethod: undefined,
      oauthVariant: undefined,
      siwcHostId: "urn:uuid:x",
      siwcClientId: "oaiapp_1",
      siwcSubject: "sub",
      model: "gpt-6-astra",
    });
  });
});
