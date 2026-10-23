import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  normalizeDeclaredAgentSettings,
  type DeclaredAgentSettings,
} from "../../../shared/browser-settings";
import {
  agentRequestIdentity,
  agentSignatureDirectory,
  honestUserAgent,
  isAgentIdentityHeader,
} from "../agent-request-identity";
import { ed25519JwkThumbprint, ed25519PublicX } from "../http-message-signature";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const x = ed25519PublicX(publicKey);
const key = { privateKey, x, keyid: ed25519JwkThumbprint(x), createdAt: 1 };
const jwksOf = (k: typeof key) => ({
  keys: [{ kty: "OKP" as const, crv: "Ed25519" as const, kid: k.keyid, x: k.x }],
});

function settings(overrides: Partial<DeclaredAgentSettings>): DeclaredAgentSettings {
  return normalizeDeclaredAgentSettings({ enabled: true, ...overrides });
}

describe("declared agent identity", () => {
  it("changes nothing when it is off (the default)", () => {
    expect(normalizeDeclaredAgentSettings(undefined)).toEqual({
      enabled: false,
      signatureAgent: "",
      compatibleUserAgentDomains: [],
    });
    expect(
      agentRequestIdentity(new URL("https://site.example"), {
        settings: normalizeDeclaredAgentSettings(undefined),
        version: "1.0.0",
        getKey: () => key,
      }),
    ).toBeUndefined();
    expect(
      agentSignatureDirectory("agent.example", {
        settings: normalizeDeclaredAgentSettings(undefined),
        getKey: () => key,
        getJwks: jwksOf,
      }),
    ).toBeUndefined();
  });

  it("sends an honest user agent, unsigned until a directory origin is set", () => {
    const identity = agentRequestIdentity(new URL("https://site.example/page"), {
      settings: settings({}),
      version: "1.2.3",
      getKey: () => key,
    });
    expect(identity).toEqual({
      headers: { "User-Agent": honestUserAgent("1.2.3") },
      userAgentMode: "declared",
    });
    expect(honestUserAgent("1.2.3")).toBe("CoWork-OS/1.2.3 (+https://coworkosapp.com/agent)");
  });

  it("keeps a browser user agent on listed domains and their subdomains", () => {
    const identity = agentRequestIdentity(new URL("https://login.bank.example/"), {
      settings: settings({ compatibleUserAgentDomains: ["bank.example", "bad domain"] }),
      version: "1.2.3",
      getKey: () => key,
    });
    expect(identity).toEqual({ headers: {}, userAgentMode: "compatible" });
  });

  it("signs for the request authority when a directory origin is set", () => {
    const identity = agentRequestIdentity(new URL("https://site.example:8443/a"), {
      settings: settings({ signatureAgent: "https://agent.example/" }),
      version: "1.2.3",
      getKey: () => key,
      includeUserAgent: false,
      nowSeconds: 1_000,
    });
    expect(identity?.headers["User-Agent"]).toBeUndefined();
    expect(identity?.headers["Signature-Agent"]).toBe('sig="https://agent.example"');
    // A one-minute window: the signature covers only the authority, so it is replayable there.
    expect(identity?.signature).toEqual({
      keyid: key.keyid,
      authority: "site.example:8443",
      expires: 1_060,
    });
  });

  it("never signs a cleartext hop", () => {
    const identity = agentRequestIdentity(new URL("http://site.example/a"), {
      settings: settings({ signatureAgent: "https://agent.example" }),
      version: "1.2.3",
      getKey: () => key,
    });
    expect(identity).toEqual({
      headers: { "User-Agent": honestUserAgent("1.2.3") },
      userAgentMode: "declared",
    });
  });

  it("owns the signature headers, case-insensitively", () => {
    for (const name of ["Signature", "signature-input", "SIGNATURE-AGENT"]) {
      expect(isAgentIdentityHeader(name)).toBe(true);
    }
    expect(isAgentIdentityHeader("Authorization")).toBe(false);
  });

  it("drops directory origins that are not public https origins", () => {
    expect(settings({ signatureAgent: "https://agent.example/" }).signatureAgent).toBe(
      "https://agent.example",
    );
    expect(settings({ signatureAgent: "https://agent.example:8443" }).signatureAgent).toBe(
      "https://agent.example:8443",
    );
    for (const bad of [
      "http://agent.example",
      "https://agent.example/keys",
      "https://u:p@agent.example",
      "https://localhost",
      "https://agent.localhost",
      "https://127.0.0.1",
      "https://[::1]",
      "not a url",
    ]) {
      expect(settings({ signatureAgent: bad }).signatureAgent).toBe("");
    }
  });

  it("serves the directory only for the configured directory host, with every listed key", () => {
    const previous = { kty: "OKP" as const, crv: "Ed25519" as const, kid: "old", x: "b2xk" };
    const options = {
      settings: settings({ signatureAgent: "https://agent.example" }),
      getKey: () => key,
      getJwks: (k: typeof key) => ({ keys: [...jwksOf(k).keys, previous] }),
    };
    const directory = agentSignatureDirectory("Agent.Example", options);
    expect(JSON.parse(directory!.body).keys).toEqual([
      { kty: "OKP", crv: "Ed25519", kid: key.keyid, x, use: "sig" },
      { ...previous, use: "sig" },
    ]);
    // Never signed over an authority the client picked.
    expect(agentSignatureDirectory("other.example", options)).toBeUndefined();
    expect(agentSignatureDirectory("agent.example:8443", options)).toBeUndefined();
    // On, but no directory origin set: nothing to serve.
    expect(
      agentSignatureDirectory("agent.example", { ...options, settings: settings({}) }),
    ).toBeUndefined();
  });
});
