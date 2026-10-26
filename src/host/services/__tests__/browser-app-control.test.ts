import { describe, expect, it, vi } from "vitest";
import { Methods } from "../../../electron/control-plane/protocol";
import type { WebApplication } from "../../web/WebApplication";
import {
  getBrowserAppStatus,
  loopbackListenerOrigin,
  registerBrowserAppControlMethods,
  signOutBrowserApp,
  type BrowserAppAccess,
} from "../browser-app-control";

type Handler = (client: { hasScope(scope: string): boolean }, params?: unknown) => Promise<unknown>;

function fakeApplication(overrides: Partial<Record<keyof WebApplication, unknown>> = {}) {
  return {
    enabled: true,
    isMounted: vi.fn(() => true),
    getPublicOrigin: vi.fn(() => null),
    countSessions: vi.fn(() => 2),
    revokeSessions: vi.fn(() => 2),
    createPairingCode: vi.fn(() => ({ code: "a".repeat(32), expiresAt: 1_000 })),
    ...overrides,
  } as unknown as WebApplication;
}

function setup(application: WebApplication | null) {
  const handlers = new Map<string, Handler>();
  const access: BrowserAppAccess = {
    getApplication: () => application,
    resolveListener: () => ({ origin: "http://127.0.0.1:3847", audience: "web-access" }),
    offMessage: "The browser app is off.",
    noListenerMessage: "Nothing serves it.",
  };
  registerBrowserAppControlMethods(
    { registerMethod: (name, handler) => handlers.set(name, handler as Handler) },
    access,
  );
  const call = (method: string, scopes: string[]) =>
    handlers.get(method)!({ hasScope: (scope) => scopes.includes(scope) });
  return { handlers, call, access };
}

describe("browser app Control Plane methods", () => {
  it("registers every web method", () => {
    const { handlers } = setup(fakeApplication());
    const expected = Object.entries(Methods)
      .filter(([key]) => key.startsWith("WEB_"))
      .map(([, method]) => method);
    expect([...handlers.keys()].sort()).toEqual([...expected].sort());
  });

  it("requires admin scope for each method", async () => {
    const { handlers, call } = setup(fakeApplication());
    for (const method of handlers.keys()) {
      await expect(call(method, ["read", "operator"])).rejects.toThrow("Admin scope is required.");
    }
  });

  it("returns a sign-in link whose code rides in the fragment", async () => {
    const { call } = setup(fakeApplication());
    const link = (await call(Methods.WEB_SIGN_IN_LINK, ["admin"])) as { url: string };
    expect(link).toEqual({
      url: `http://127.0.0.1:3847/app/#pair=${"a".repeat(32)}`,
      appUrl: "http://127.0.0.1:3847/app/",
      expiresAt: 1_000,
    });
  });

  it("says how to turn the app on while it is off", async () => {
    const { call } = setup(null);
    await expect(call(Methods.WEB_SIGN_IN_LINK, ["admin"])).rejects.toThrow(
      "The browser app is off.",
    );
    await expect(call(Methods.WEB_PAIR, ["admin"])).rejects.toThrow("The browser app is off.");
    await expect(call(Methods.WEB_STATUS, ["admin"])).resolves.toEqual({
      enabled: false,
      remote: false,
      signedInBrowsers: 0,
    });
    await expect(call(Methods.WEB_SIGN_OUT, ["admin"])).resolves.toEqual({ signedOut: 0 });
  });

  it("refuses a link when the chosen listener does not serve the app", async () => {
    const { call } = setup(fakeApplication({ isMounted: vi.fn(() => false) }));
    await expect(call(Methods.WEB_SIGN_IN_LINK, ["admin"])).rejects.toThrow("Nothing serves it.");
  });

  it("reports remote reach and signs everyone out", () => {
    const application = fakeApplication({
      getPublicOrigin: vi.fn(() => "https://mac.example.ts.net"),
    });
    const { access } = setup(application);
    expect(getBrowserAppStatus(access)).toMatchObject({ remote: true, signedInBrowsers: 2 });
    expect(signOutBrowserApp(access)).toEqual({ signedOut: 2 });
    expect(application.revokeSessions).toHaveBeenCalledWith();
  });
});

describe("loopbackListenerOrigin", () => {
  it("brackets IPv6 hosts", () => {
    expect(loopbackListenerOrigin("127.0.0.1", 3847)).toBe("http://127.0.0.1:3847");
    expect(loopbackListenerOrigin("::1", 3847)).toBe("http://[::1]:3847");
    expect(loopbackListenerOrigin("[::1]", 3847)).toBe("http://[::1]:3847");
    expect(loopbackListenerOrigin("localhost", 18789)).toBe("http://localhost:18789");
  });
});
