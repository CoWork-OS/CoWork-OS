import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecureSettingsRepository } from "../../../database/SecureSettingsRepository";
import { OPENROUTER_FREE_MODEL_ID } from "../../../../shared/llm-provider-catalog";
import {
  applyOpenRouterOAuthKey,
  buildOpenRouterAuthorizeUrl,
  createOpenRouterCodeChallenge,
  createOpenRouterCodeVerifier,
  exchangeOpenRouterCode,
  OpenRouterOAuth,
  startOpenRouterCallbackServer,
} from "../openrouter-oauth";
import { LLMProviderFactory, type LLMSettings } from "../provider-factory";

const servers: Server[] = [];

afterEach(async () => {
  await OpenRouterOAuth.cancelActive();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  LLMProviderFactory.clearCache();
  vi.restoreAllMocks();
});

interface RecordedRequest {
  method?: string;
  url?: string;
  headers: IncomingMessage["headers"];
  body: string;
}

/** A stand-in for OpenRouter's key exchange endpoint, bound to loopback only. */
async function startExchangeServer(
  respond: (request: RecordedRequest) => { status: number; body: unknown },
): Promise<{ url: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const recorded = { method: req.method, url: req.url, headers: req.headers, body };
      requests.push(recorded);
      const reply = respond(recorded);
      res.statusCode = reply.status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(reply.body));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { address, port } = server.address() as AddressInfo;
  expect(address).toBe("127.0.0.1");
  return { url: `http://127.0.0.1:${port}/api/v1/auth/keys`, requests };
}

/** The callback URL names localhost as OpenRouter documents; the server listens on 127.0.0.1. */
function toLoopback(callbackUrl: string): URL {
  const url = new URL(callbackUrl);
  url.hostname = "127.0.0.1";
  return url;
}

describe("OpenRouter PKCE", () => {
  it("creates RFC 7636 verifiers", () => {
    const verifier = createOpenRouterCodeVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9._~-]+$/);
    expect(createOpenRouterCodeVerifier()).not.toBe(verifier);
  });

  it("derives the S256 challenge from the verifier", () => {
    // RFC 7636 appendix B test vector.
    expect(createOpenRouterCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("builds the documented authorize URL", () => {
    const url = new URL(
      buildOpenRouterAuthorizeUrl({
        callbackUrl: "http://localhost:51423/callback",
        codeChallenge: "challenge",
        state: "state-1",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://openrouter.ai/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      callback_url: "http://localhost:51423/callback",
      code_challenge: "challenge",
      code_challenge_method: "S256",
      state: "state-1",
      key_label: "CoWork OS",
    });
  });
});

describe("OpenRouter callback server", () => {
  it("listens on loopback and resolves with the returned code", async () => {
    const callback = await startOpenRouterCallbackServer("state-1");
    const url = toLoopback(callback.callbackUrl);
    expect(callback.callbackUrl).toMatch(/^http:\/\/localhost:\d+\/callback$/);

    const notFound = await fetch(new URL("/other", url));
    expect(notFound.status).toBe(404);

    url.search = new URLSearchParams({ code: "code-1", state: "state-1" }).toString();
    const response = await fetch(url);
    expect(response.status).toBe(200);
    await expect(callback.waitForCode).resolves.toBe("code-1");
  });

  it("rejects a callback with the wrong state", async () => {
    const callback = await startOpenRouterCallbackServer("state-1");
    const url = toLoopback(callback.callbackUrl);
    url.search = new URLSearchParams({ code: "code-1", state: "other" }).toString();
    expect((await fetch(url)).status).toBe(400);
    await expect(callback.waitForCode).rejects.toThrow("state mismatch");
  });

  it("rejects a callback without a code, as when the user denies access", async () => {
    const callback = await startOpenRouterCallbackServer("state-1");
    expect((await fetch(toLoopback(callback.callbackUrl))).status).toBe(400);
    await expect(callback.waitForCode).rejects.toThrow("cancelled");
  });

  it("gives up after the timeout", async () => {
    const callback = await startOpenRouterCallbackServer("state-1", 20);
    await expect(callback.waitForCode).rejects.toThrow("timed out");
  });
});

describe("OpenRouter key exchange", () => {
  it("posts the code and verifier as JSON and returns the user key", async () => {
    const exchange = await startExchangeServer(() => ({
      status: 200,
      body: { key: "sk-or-v1-disposable", user_id: "user_1" },
    }));
    const result = await exchangeOpenRouterCode({
      code: "code-1",
      codeVerifier: "verifier-1",
      exchangeUrl: exchange.url,
    });
    expect(result).toEqual({ key: "sk-or-v1-disposable", userId: "user_1" });
    const [request] = exchange.requests;
    expect(request.method).toBe("POST");
    expect(request.headers["content-type"]).toBe("application/json");
    expect(request.headers["x-openrouter-title"]).toBe("CoWork OS");
    expect(JSON.parse(request.body)).toEqual({
      code: "code-1",
      code_verifier: "verifier-1",
      code_challenge_method: "S256",
    });
  });

  it("reports OpenRouter's error message", async () => {
    const exchange = await startExchangeServer(() => ({
      status: 403,
      body: { error: { code: 403, message: "Invalid code or code_verifier" } },
    }));
    await expect(
      exchangeOpenRouterCode({ code: "bad", codeVerifier: "v", exchangeUrl: exchange.url }),
    ).rejects.toThrow("OpenRouter key exchange failed (403): Invalid code or code_verifier");
  });

  it("rejects a response without a key", async () => {
    const exchange = await startExchangeServer(() => ({ status: 200, body: { user_id: "u" } }));
    await expect(
      exchangeOpenRouterCode({ code: "c", codeVerifier: "v", exchangeUrl: exchange.url }),
    ).rejects.toThrow("no usable key");
  });
});

describe("OpenRouterOAuth.authenticate", () => {
  it("runs the browser round trip and exchanges with the matching verifier", async () => {
    const exchange = await startExchangeServer(() => ({
      status: 200,
      body: { key: "sk-or-v1-disposable", user_id: null },
    }));
    let challenge = "";
    const openExternal = vi.fn(async (authorizeUrl: string) => {
      const params = new URL(authorizeUrl).searchParams;
      challenge = params.get("code_challenge") || "";
      // Stand in for the browser following OpenRouter's redirect.
      const callback = toLoopback(params.get("callback_url") || "");
      callback.search = new URLSearchParams({
        code: "code-1",
        state: params.get("state") || "",
      }).toString();
      setTimeout(() => void fetch(callback), 0);
    });

    const result = await new OpenRouterOAuth().authenticate({
      openExternal,
      exchangeUrl: exchange.url,
    });

    expect(result).toEqual({ key: "sk-or-v1-disposable" });
    expect(openExternal).toHaveBeenCalledOnce();
    const body = JSON.parse(exchange.requests[0].body);
    expect(body.code).toBe("code-1");
    expect(createOpenRouterCodeChallenge(body.code_verifier)).toBe(challenge);
  });

  it("cancels an abandoned sign-in when another one starts", async () => {
    const first = new OpenRouterOAuth().authenticate({ openExternal: () => undefined });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await OpenRouterOAuth.cancelActive();
    await expect(first).rejects.toThrow("cancelled");
  });
});

describe("OpenRouter sign-in settings", () => {
  const base = { providerType: "anthropic", modelKey: "sonnet-4-6" } as LLMSettings;

  it("starts a first sign-in on the free-models router", () => {
    const next = applyOpenRouterOAuthKey(base, "sk-or-v1-disposable");
    expect(next.providerType).toBe("openrouter");
    expect(next.modelKey).toBe(OPENROUTER_FREE_MODEL_ID);
    expect(next.openrouter).toMatchObject({
      apiKey: "sk-or-v1-disposable",
      model: OPENROUTER_FREE_MODEL_ID,
      strongModelKey: OPENROUTER_FREE_MODEL_ID,
      cheapModelKey: OPENROUTER_FREE_MODEL_ID,
    });
  });

  it("keeps the model of an account that already had a key", () => {
    const next = applyOpenRouterOAuthKey(
      { ...base, openrouter: { apiKey: "sk-or-v1-old", model: "openai/gpt-5" } },
      "sk-or-v1-new",
    );
    expect(next.modelKey).toBe("openai/gpt-5");
    expect(next.openrouter).toEqual({ apiKey: "sk-or-v1-new", model: "openai/gpt-5" });
  });

  it("stores the key only through the encrypted settings repository", () => {
    const repository = { load: vi.fn(() => base), save: vi.fn(() => true) };
    vi.spyOn(SecureSettingsRepository, "isInitialized").mockReturnValue(true);
    vi.spyOn(SecureSettingsRepository, "getInstance").mockReturnValue(repository as never);
    LLMProviderFactory.clearCache();

    LLMProviderFactory.saveSettings(
      applyOpenRouterOAuthKey(LLMProviderFactory.loadSettings(), "sk-or-v1-disposable"),
    );

    expect(repository.save).toHaveBeenCalledOnce();
    const [category, saved] = repository.save.mock.calls[0] as unknown as [string, LLMSettings];
    expect(category).toBe("llm");
    expect(saved.openrouter?.apiKey).toBe("sk-or-v1-disposable");
    expect(LLMProviderFactory.loadSettings().openrouter?.apiKey).toBe("sk-or-v1-disposable");
  });
});
