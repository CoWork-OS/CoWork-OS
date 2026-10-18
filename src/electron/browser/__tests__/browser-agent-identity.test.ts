import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => ({
  declaredAgent: {
    enabled: true,
    signatureAgent: "https://agent.example",
    compatibleUserAgentDomains: [] as string[],
  },
  key: undefined as Any,
}));

vi.mock("electron", () => ({ webContents: { fromId: () => null } }));
vi.mock("../../gateway/router-helpers", () => ({ getCoworkVersion: () => "1.2.3" }));
vi.mock("../../settings/browser-settings-manager", () => ({
  BrowserSettingsManager: {
    loadSettings: () => ({ declaredAgent: fixtures.declaredAgent }),
    loadPolicy: () => ({ blockedSitePermissions: [] }),
  },
}));
vi.mock("../../identity/agent-signing-keys", () => ({
  getAgentSigningKey: () => fixtures.key,
}));

import { BrowserSessionManager } from "../browser-session-manager";
import { BrowserWorkbenchService } from "../browser-workbench-service";
import {
  ed25519JwkThumbprint,
  ed25519PublicX,
  verifyAgentRequest,
  type Ed25519PublicJwk,
} from "../../security/http-message-signature";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const x = ed25519PublicX(publicKey);
fixtures.key = { privateKey, x, keyid: ed25519JwkThumbprint(x), createdAt: 1 };
const jwks = { keys: [{ kty: "OKP" as const, crv: "Ed25519" as const, x }] };
const publicKeyFromJwk = (jwk: Ed25519PublicJwk) =>
  createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x }, format: "jwk" });

function partition() {
  let hook!: Any;
  const webRequest = {
    onBeforeRequest: vi.fn(),
    onBeforeSendHeaders: vi.fn((_filter: unknown, handler: Any) => (hook = handler)),
  };
  const manager = new BrowserSessionManager();
  manager.prepareSessionNetworkGuards({ webRequest });
  const send = (details: {
    url: string;
    webContentsId?: number;
    resourceType?: string;
    requestHeaders?: Record<string, string>;
  }) => {
    const callback = vi.fn();
    hook({ resourceType: "mainFrame", webContentsId: 7, requestHeaders: {}, ...details }, callback);
    return callback.mock.calls[0][0];
  };
  return { manager, send, webRequest };
}

describe("declared agent identity on in-app browser navigations", () => {
  afterEach(() => {
    fixtures.declaredAgent.enabled = true;
    vi.useRealTimers();
  });

  it("signs each main-frame hop of an agent navigation for that hop's authority", () => {
    const { manager, send } = partition();
    const navigation = manager.beginAgentNavigation(7);
    const first = send({ url: "https://site.example/start", requestHeaders: { Accept: "*/*" } });
    const second = send({ url: "https://login.example/next" });
    const signed = navigation.end();

    expect(first.requestHeaders.Accept).toBe("*/*");
    expect(first.requestHeaders["Signature-Agent"]).toBe('sig="https://agent.example"');
    // The browser keeps its own user agent; only the signature is added.
    expect(first.requestHeaders["User-Agent"]).toBeUndefined();
    const verify = (url: string, headers: Record<string, string>) =>
      verifyAgentRequest({ url, headers, jwks, publicKeyFromJwk });
    expect(verify("https://site.example/", first.requestHeaders).ok).toBe(true);
    expect(verify("https://login.example/", second.requestHeaders).ok).toBe(true);
    expect(verify("https://login.example/", first.requestHeaders).ok).toBe(false);
    expect(signed.map((entry) => entry.authority)).toEqual(["site.example", "login.example"]);
  });

  it("never signs the user's own navigations, reloads, subresources or other tabs", () => {
    const { manager, send } = partition();
    expect(send({ url: "https://site.example/" })).toEqual({});
    const navigation = manager.beginAgentNavigation(7);
    expect(send({ url: "https://cdn.example/app.js", resourceType: "script" })).toEqual({});
    expect(send({ url: "https://site.example/", webContentsId: 8 })).toEqual({});
    navigation.end();
    // After the agent's navigation ends, a reload of the same page goes out unsigned.
    expect(send({ url: "https://site.example/" })).toEqual({});
  });

  it("strips identity headers a page tries to send on a navigation", () => {
    const { send } = partition();
    expect(
      send({
        url: "https://site.example/",
        requestHeaders: { "signature-agent": 'sig="https://evil.example"', Accept: "*/*" },
      }),
    ).toEqual({ requestHeaders: { Accept: "*/*" } });
  });

  it("stops signing when the navigation window lapses or identity is off", () => {
    vi.useFakeTimers();
    const { manager, send } = partition();
    manager.beginAgentNavigation(7);
    vi.advanceTimersByTime(61_000);
    expect(send({ url: "https://site.example/" })).toEqual({});

    fixtures.declaredAgent.enabled = false;
    manager.beginAgentNavigation(7);
    expect(send({ url: "https://site.example/" })).toEqual({});
  });

  it("navigate marks only the agent's own load and reports what was signed", async () => {
    const end = vi.fn(() => [{ keyid: "k1", authority: "site.example", expires: 1 }]);
    const manager = {
      assertUrlAllowed: vi.fn(),
      allowLocalPreviewUrl: vi.fn(),
      beginAgentNavigation: vi.fn(() => ({ end })),
    };
    const service = new BrowserWorkbenchService(manager as Any);
    const contents = {
      id: 7,
      loadURL: vi.fn(async () => undefined),
      getURL: () => "https://site.example/",
      getTitle: () => "Site",
      executeJavaScript: vi.fn(async () => false),
    };
    Object.assign(service as Any, {
      getSession: () => ({ taskId: "task", sessionId: "default", webContentsId: 7 }),
      getWebContents: async () => contents,
      waitForLoad: async () => undefined,
      emitCursor: () => undefined,
    });

    const result = await service.navigate({ taskId: "task", url: "https://site.example/" });

    // No headers are stored on the navigation entry.
    expect(contents.loadURL).toHaveBeenCalledWith("https://site.example/");
    expect(manager.beginAgentNavigation).toHaveBeenCalledWith(7);
    expect(end).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      agentIdentity: { keyid: "k1", signedAuthorities: ["site.example"] },
    });
  });
});
