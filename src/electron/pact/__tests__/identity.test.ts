import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  base64UrlEncode,
  generateEs256KeyPair,
  publicKeyFromJwk,
  signCompactJws,
  verifyCompactJws,
} from "../jws";
import { DevelopmentPactSigner } from "../development-signer";
import {
  checkSignedToken,
  HttpPactSigner,
  PactSignerError,
  PactTokenCache,
} from "../signer-client";
import { PactTransport } from "../transport";

const ISSUER = "https://pa.example.com";
const NOW = Date.parse("2026-10-08T10:00:00Z");

function token(claims: Record<string, unknown>, alg: "ES256" | "HS256" = "ES256") {
  const pair = generateEs256KeyPair();
  if (alg === "HS256") {
    return `${base64UrlEncode(JSON.stringify({ alg: "HS256" }))}.${base64UrlEncode(JSON.stringify(claims))}.c2ln`;
  }
  return signCompactJws(
    JSON.stringify(claims),
    { alg: "ES256", kid: pair.publicJwk.kid },
    pair.privateKey,
  );
}

const iat = Math.floor(NOW / 1000);
const good = { iss: ISSUER, sub: "subject-1", aud: "aud-1", iat, exp: iat + 120 };

describe("personal-agent JWT checks", () => {
  it("accepts a well-formed short-lived token", () => {
    const checked = checkSignedToken({
      token: token(good),
      issuer: ISSUER,
      audience: "aud-1",
      nowMs: NOW,
    });
    expect(checked).toMatchObject({ subject: "subject-1", audience: "aud-1" });
  });

  it.each([
    ["wrong issuer", { ...good, iss: "https://other.example" }],
    ["audience mismatch", { ...good, aud: "aud-2" }],
    ["lifetime over 300 s", { ...good, exp: iat + 301 }],
    ["iat in the future", { ...good, iat: iat + 31, exp: iat + 100 }],
    ["already expired", { ...good, iat: iat - 200, exp: iat - 1 }],
    ["missing subject", { ...good, sub: "" }],
  ])("rejects %s", (_label, claims) => {
    expect(() =>
      checkSignedToken({ token: token(claims), issuer: ISSUER, audience: "aud-1", nowMs: NOW }),
    ).toThrow(PactSignerError);
  });

  it("rejects HS256 and a subject change", () => {
    expect(() =>
      checkSignedToken({
        token: token(good, "HS256"),
        issuer: ISSUER,
        audience: "aud-1",
        nowMs: NOW,
      }),
    ).toThrow(/algorithm/);
    expect(() =>
      checkSignedToken({
        token: token(good),
        issuer: ISSUER,
        audience: "aud-1",
        expectedSubject: "subject-2",
        nowMs: NOW,
      }),
    ).toThrow(/subject changed/);
  });
});

describe("JWS and JWK handling", () => {
  it("verifies ES256 and RS256 and refuses tampering", async () => {
    const es = generateEs256KeyPair();
    const jws = signCompactJws("payload", { alg: "ES256", kid: es.publicJwk.kid }, es.privateKey);
    const resolver = async () => publicKeyFromJwk(es.publicJwk);
    await expect(verifyCompactJws(jws, resolver)).resolves.toMatchObject({});
    const [h, p, sig] = jws.split(".");
    await expect(
      verifyCompactJws(`${h}.${base64UrlEncode("other")}.${sig}`, resolver),
    ).rejects.toThrow(/signature/);
    void p;

    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaJwk = {
      ...(rsa.publicKey.export({ format: "jwk" }) as Record<string, string>),
      kid: "r1",
    };
    const rs = signCompactJws("payload", { alg: "RS256", kid: "r1" }, rsa.privateKey);
    await expect(verifyCompactJws(rs, async () => publicKeyFromJwk(rsaJwk))).resolves.toBeTruthy();
  });

  it("refuses private members, weak RSA keys and non-signing keys", () => {
    const es = generateEs256KeyPair();
    const privateJwk = es.privateKey.export({ format: "jwk" });
    expect(() => publicKeyFromJwk(privateJwk)).toThrow(/private/);
    const weak = generateKeyPairSync("rsa", { modulusLength: 1024 });
    expect(() => publicKeyFromJwk(weak.publicKey.export({ format: "jwk" }))).toThrow(/short/);
    expect(() => publicKeyFromJwk({ ...es.publicJwk, use: "enc" })).toThrow(/signing/);
  });

  it("refuses crit headers and unlisted algorithms", async () => {
    const es = generateEs256KeyPair();
    const header = base64UrlEncode(JSON.stringify({ alg: "ES256", crit: ["exp"] }));
    await expect(
      verifyCompactJws(`${header}.${base64UrlEncode("x")}.${base64UrlEncode("y")}`, async () =>
        publicKeyFromJwk(es.publicJwk),
      ),
    ).rejects.toThrow(/crit/);
    const none = base64UrlEncode(JSON.stringify({ alg: "none" }));
    await expect(
      verifyCompactJws(`${none}.${base64UrlEncode("x")}.c2ln`, async () => undefined),
    ).rejects.toThrow(/not allowed/);
  });
});

/** Network rules of the calling task; the signer must use them for its own calls. */
const NET = { networkEnabled: true, accessNetworkMode: "enabled" as const };

describe("signer contract client", () => {
  function signerWith(
    respond: (
      body: Record<string, unknown>,
      path: string,
    ) => Promise<{ status: number; body?: unknown }>,
  ) {
    const calls: { url: string; headers: Record<string, string>; networkContext: unknown }[] = [];
    const signer = new HttpPactSigner({
      deployment: "self_hosted",
      issuer: ISSUER,
      signerUrl: "https://signer.example.com",
      auth: { mode: "credential", credential: "credential-0123456789abcdef" },
      transport: (networkContext) =>
        new PactTransport({
          async fetch(input) {
            calls.push({ url: input.url, headers: input.headers, networkContext });
            const reply = await respond(
              JSON.parse(input.body ?? "{}"),
              new URL(input.url).pathname,
            );
            return {
              status: reply.status,
              headers: { get: () => null },
              bodyText: JSON.stringify(reply.body ?? {}),
              url: input.url,
              chain: [input.url],
            };
          },
        }),
    });
    return { signer, calls };
  }

  it("signs with the credential, checks the nonce echo and caches per audience", async () => {
    const dev = new DevelopmentPactSigner({ subject: "subject-1", issuer: ISSUER });
    let signCalls = 0;
    const { signer, calls } = signerWith(async (body, path) => {
      if (path !== "/pact/sign") return { status: 404 };
      signCalls += 1;
      return {
        status: 200,
        body: { token: (await dev.sign(String(body.audience))).token, nonce: body.nonce },
      };
    });
    const cache = new PactTokenCache(signer, () => Date.now());
    const first = await cache.token("aud-1", NET);
    const second = await cache.token("aud-1", NET);
    expect(first.token).toBe(second.token);
    expect(signCalls).toBe(1);
    expect(calls[0]?.headers.Authorization).toBe("Bearer credential-0123456789abcdef");
    expect(calls[0]?.url).toBe("https://signer.example.com/pact/sign");
    await cache.token("aud-2", NET);
    expect(signCalls).toBe(2);
  });

  it("calls the signer under each caller's network rules, never sharing a request across them", async () => {
    const dev = new DevelopmentPactSigner({ subject: "subject-1", issuer: ISSUER });
    const { signer, calls } = signerWith(async (body) => ({
      status: 200,
      body: { token: (await dev.sign(String(body.audience))).token, nonce: body.nonce },
    }));
    const cache = new PactTokenCache(signer, () => Date.now());
    const restricted = { networkEnabled: true, profileDomainRules: [] };
    await Promise.all([cache.token("aud", NET), cache.token("aud", restricted)]);
    expect(calls.map((call) => call.networkContext)).toEqual([NET, restricted]);
    // Cached tokens are served only under the rules they were fetched under.
    await cache.token("aud", NET);
    await cache.token("aud", restricted);
    expect(calls).toHaveLength(2);
    cache.invalidate("aud");
    await cache.token("aud", restricted);
    expect(calls).toHaveLength(3);
    await signer.status(restricted);
    expect(calls.at(-1)?.networkContext).toBe(restricted);
  });

  it("treats a missing nonce echo, a disabled signer and a foreign issuer as errors", async () => {
    const dev = new DevelopmentPactSigner({ subject: "subject-1", issuer: ISSUER });
    const make = (
      respond: (body: Record<string, unknown>) => Promise<{ status: number; body?: unknown }>,
    ) =>
      new HttpPactSigner({
        deployment: "self_hosted",
        issuer: ISSUER,
        signerUrl: "https://signer.example.com",
        auth: { mode: "credential", credential: "credential-0123456789abcdef" },
        transport: () =>
          new PactTransport({
            async fetch(input) {
              const reply = await respond(JSON.parse(input.body ?? "{}"));
              return {
                status: reply.status,
                headers: { get: () => null },
                bodyText: JSON.stringify(reply.body ?? {}),
                url: input.url,
                chain: [input.url],
              };
            },
          }),
      });
    await expect(
      make(async (body) => ({
        status: 200,
        body: { token: (await dev.sign(String(body.audience))).token },
      })).sign("aud", NET),
    ).rejects.toThrow(/nonce/);
    await expect(make(async () => ({ status: 403 })).sign("aud", NET)).rejects.toMatchObject({
      code: "disabled",
    });
    const foreign = new DevelopmentPactSigner({
      subject: "subject-1",
      issuer: "https://other.example",
    });
    await expect(
      make(async (body) => ({
        status: 200,
        body: { token: (await foreign.sign(String(body.audience))).token, nonce: body.nonce },
      })).sign("aud", NET),
    ).rejects.toThrow(/issuer/);
    const status = await make(async () => ({
      status: 200,
      body: { issuer: "https://other.example" },
    })).status(NET);
    expect(status.ok).toBe(false);
  });

  it("refreshes a cached token before it gets close to expiry", async () => {
    let now = NOW;
    const dev = new DevelopmentPactSigner({
      subject: "s",
      issuer: ISSUER,
      now: () => now,
      ttlSeconds: 120,
    });
    const spy = vi.spyOn(dev, "sign");
    const cache = new PactTokenCache(dev, () => now);
    await cache.token("aud", NET);
    now += 60_000;
    await cache.token("aud", NET);
    expect(spy).toHaveBeenCalledTimes(1);
    now += 40_000; // 100 s old, 20 s left: below the remaining-life floor
    await cache.token("aud", NET);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("publishes rotated keys alongside old ones", async () => {
    const dev = new DevelopmentPactSigner({ subject: "s", issuer: ISSUER });
    const before = dev.jwks().keys.map((key) => key.kid);
    dev.rotate();
    const after = dev.jwks().keys.map((key) => key.kid);
    expect(after).toHaveLength(2);
    expect(after).toContain(before[0]);
  });
});
