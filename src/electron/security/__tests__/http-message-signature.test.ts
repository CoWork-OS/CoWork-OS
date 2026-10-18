import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  DIRECTORY_SIGNATURE_TAG,
  ed25519JwkThumbprint,
  ed25519PublicX,
  requestSignatureBase,
  signAgentRequest,
  signedSignatureDirectory,
  verifyAgentRequest,
  type Ed25519PublicJwk,
} from "../http-message-signature";

// RFC 9421 Appendix B.1.4 test key; the draft's Appendix E.2 vectors use it. Test use only.
const TEST_KEY_PEM = [
  "-----BEGIN PRIVATE KEY-----",
  "MC4CAQAwBQYDK2VwBCIEIJ+DYvh6SEqVTm50DFtMDoQikTmiCqirVv9mWG9qfSnF",
  "-----END PRIVATE KEY-----",
].join("\n");

const publicKeyFromJwk = (jwk: Ed25519PublicJwk) =>
  createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x }, format: "jwk" });

describe("Web Bot Auth request signatures", () => {
  it("reproduces the draft's Ed25519 test vector (Appendix E.2.1)", () => {
    const privateKey = createPrivateKey(TEST_KEY_PEM);
    const x = ed25519PublicX(createPublicKey(privateKey));
    expect(x).toBe("JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs");
    expect(ed25519JwkThumbprint(x)).toBe("poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U");

    const { base, signatureInput } = requestSignatureBase({
      authority: "example.com",
      label: "sig2",
      agentKey: "agent2",
      signatureAgent: "https://signature-agent.test",
      params: {
        created: 1735689600,
        keyid: "poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U",
        alg: "ed25519",
        expires: 4889289600,
        nonce:
          "n9p433xm+NJ3ph3upfBIGmsuwHw387YV7Q/F+6BSpGCVjYCqQw6rznNA8PVVLySrAWsv0hQtFioQb6E1YsauiA==",
        tag: "web-bot-auth",
      },
    });
    expect(signatureInput).toBe(
      'sig2=("@authority" "signature-agent";key="agent2");created=1735689600;keyid="poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";alg="ed25519";expires=4889289600;nonce="n9p433xm+NJ3ph3upfBIGmsuwHw387YV7Q/F+6BSpGCVjYCqQw6rznNA8PVVLySrAWsv0hQtFioQb6E1YsauiA==";tag="web-bot-auth"',
    );
    expect(sign(null, Buffer.from(base), privateKey).toString("base64")).toBe(
      "RdNFx5Bj6au3YgAMQL/RzmUlZE8QZLIaXGRpw985hWnwPfMxT228NMk6ehRS1PSl4e8PhbNZACSanGdhEwYCCg==",
    );
  });

  it("signs the authority and agent member, and verifies only on that authority and in time", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const x = ed25519PublicX(publicKey);
    const keyid = ed25519JwkThumbprint(x);
    const signed = signAgentRequest({
      url: "https://shop.example/cart?id=1",
      signatureAgent: "https://agent.example",
      privateKey,
      keyid,
      nowSeconds: 1_000,
      ttlSeconds: 600,
    });
    expect(signed.headers["Signature-Agent"]).toBe('sig="https://agent.example"');
    expect(signed.headers["Signature-Input"]).toContain('tag="web-bot-auth"');
    const jwks = { keys: [{ kty: "OKP" as const, crv: "Ed25519" as const, x }] };
    const check = (url: string, nowSeconds: number) =>
      verifyAgentRequest({ url, headers: signed.headers, jwks, publicKeyFromJwk, nowSeconds });

    expect(check("https://shop.example/other", 1_100)).toEqual({ ok: true, keyid });
    expect(check("https://evil.example/cart", 1_100)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(check("https://shop.example/cart", 1_700)).toEqual({ ok: false, reason: "expired" });
    expect(
      verifyAgentRequest({
        url: "https://shop.example/cart",
        headers: signed.headers,
        jwks: { keys: [] },
        publicKeyFromJwk,
        nowSeconds: 1_100,
      }),
    ).toEqual({ ok: false, reason: "unknown_key" });
  });

  it("serves a signed JWK Set directory with every listed key, signed by the first", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const x = ed25519PublicX(publicKey);
    const previousX = ed25519PublicX(generateKeyPairSync("ed25519").publicKey);
    const directory = signedSignatureDirectory({
      requestAuthority: "agent.example",
      keys: [
        { kty: "OKP", crv: "Ed25519", x },
        { kty: "OKP", crv: "Ed25519", x: previousX },
      ],
      privateKey,
      nowSeconds: 1_000,
    });
    expect(JSON.parse(directory.body)).toEqual({
      keys: [
        { kty: "OKP", crv: "Ed25519", kid: ed25519JwkThumbprint(x), x, use: "sig" },
        {
          kty: "OKP",
          crv: "Ed25519",
          kid: ed25519JwkThumbprint(previousX),
          x: previousX,
          use: "sig",
        },
      ],
    });
    expect(directory.headers["Content-Type"]).toBe(
      "application/http-message-signatures-directory+json",
    );
    // The signature covers the requested authority, so a shared cache must key on Host.
    expect(directory.headers.Vary).toBe("Host");
    expect(() =>
      signedSignatureDirectory({ requestAuthority: "agent.example", keys: [], privateKey }),
    ).toThrow("at least one key");
    expect(directory.headers["Signature-Input"]).toBe(
      `binding=("@authority";req "content-digest");created=1000;keyid="${ed25519JwkThumbprint(x)}";expires=87400;tag="${DIRECTORY_SIGNATURE_TAG}"`,
    );
    expect(directory.headers["Content-Digest"]).toMatch(/^sha-256=:[A-Za-z0-9+/]+=*:$/);
  });

  describe("against a loopback origin", () => {
    let server: http.Server | undefined;
    afterEach(
      () => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())),
    );

    it("is accepted by a verifying server on 127.0.0.1", async () => {
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const x = ed25519PublicX(publicKey);
      const jwks = { keys: [{ kty: "OKP" as const, crv: "Ed25519" as const, x }] };
      server = http.createServer((req, res) => {
        const url = `http://${req.headers.host}${req.url}`;
        const headers = Object.fromEntries(
          Object.entries(req.headers).map(([key, value]) => [key, String(value)]),
        );
        const result = verifyAgentRequest({ url, headers, jwks, publicKeyFromJwk });
        res.writeHead(result.ok ? 200 : 401).end(result.ok ? "ok" : result.reason);
      });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as { port: number };
      const url = `http://127.0.0.1:${port}/page`;
      const signed = signAgentRequest({
        url,
        signatureAgent: "https://agent.example",
        privateKey,
        keyid: ed25519JwkThumbprint(x),
      });

      const accepted = await fetch(url, { headers: signed.headers });
      expect(accepted.status).toBe(200);
      const unsigned = await fetch(url);
      expect(unsigned.status).toBe(401);
      expect(await unsigned.text()).toBe("missing_headers");
    });
  });
});
