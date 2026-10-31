import { describe, expect, it, vi } from "vitest";
const fixtures = vi.hoisted(() => ({
  contents: null as Any,
  /** DNS answers by hostname; anything else resolves to a public address. */
  dns: {} as Record<string, string>,
}));
vi.mock("electron", () => ({ webContents: { fromId: () => fixtures.contents } }));
vi.mock("dns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("dns")>();
  const lookup = vi.fn(async (host: string) => {
    const address = fixtures.dns[host] ?? "93.184.215.14";
    return [{ address, family: address.includes(":") ? 6 : 4 }];
  });
  return { ...actual, promises: { ...actual.promises, lookup } };
});
vi.mock("../../security/browser-network-proxy", () => ({
  createBrowserNetworkProxy: vi.fn(async () => ({
    url: "http://127.0.0.1:12345",
    close: vi.fn(),
    closeConnections: vi.fn(),
  })),
}));
import { BrowserSessionManager } from "../browser-session-manager";
import { BrowserWorkbenchService } from "../browser-workbench-service";
import { createBrowserNetworkProxy } from "../../security/browser-network-proxy";
import { BrowserService } from "../../agent/browser/browser-service";
function contents() {
  let before!: Any;
  const handlers = new Map<string, Any>();
  const value = {
    id: 7,
    getURL: () => "about:blank",
    on: vi.fn(),
    isDestroyed: () => false,
    session: {
      setProxy: vi.fn(),
      closeAllConnections: vi.fn(),
      webRequest: { onBeforeRequest: vi.fn((_filter, handler) => (before = handler)) },
      protocol: { handle: vi.fn((scheme, handler) => handlers.set(scheme, handler)) },
    },
  };
  fixtures.contents = value;
  return {
    value,
    handlers,
    request: (url: string, id = 7) => {
      const callback = vi.fn();
      before({ url, webContentsId: id }, callback);
      return callback.mock.calls[0][0];
    },
    /** The decision for a request the guard may answer after a DNS check (WebSockets). */
    decide: async (url: string, id = 7) => {
      const callback = vi.fn();
      before({ url, webContentsId: id }, callback);
      await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce());
      return callback.mock.calls[0][0];
    },
  };
}
describe("browser guards before first remote load", () => {
  it("installs guards before registration resolves, applies the policy to sockets and denies unowned requests", async () => {
    const { value, request, decide } = contents();
    const manager = new BrowserSessionManager();
    manager.setAccessPolicy("test", { networkEnabled: true, accessNetworkMode: "enabled" });
    await manager.registerElectronWorkbenchSession({
      taskId: "test",
      webContentsId: 7,
      url: "about:blank",
      sessionId: "default",
    });
    expect(value.session.webRequest.onBeforeRequest).toHaveBeenCalledOnce();
    expect(request("https://example.com")).toEqual({});
    // A WebSocket gets the same decision as an HTTP request to its host.
    expect(await decide("wss://example.com/socket")).toEqual({});
    expect(await decide("ws://example.com")).toEqual({});
    expect(request("wss://169.254.169.254/")).toEqual({ cancel: true });
    expect(request("wss://example.com", -1)).toEqual({ cancel: true });
    expect(request("https://example.com", -1)).toEqual({ cancel: true });
    expect(value.session.setProxy).toHaveBeenCalledWith(
      expect.objectContaining({ proxyBypassRules: "<-loopback>" }),
    );
    const assertDestination = vi.mocked(createBrowserNetworkProxy).mock.calls.at(-1)![0];
    expect(() => assertDestination("https://example.com")).not.toThrow();
    manager.setAccessPolicy("test", {
      networkEnabled: true,
      accessNetworkMode: "enabled",
      profileDomainRules: [{ pattern: "chat.example.com", access: "deny" }],
    });
    expect(request("wss://chat.example.com/live")).toEqual({ cancel: true });
    expect(await decide("wss://example.com/live")).toEqual({});
    manager.setAccessPolicy("test", { networkEnabled: true, accessNetworkMode: "disabled" });
    expect(request("wss://example.com/live")).toEqual({ cancel: true });
    expect(() => assertDestination("https://example.com")).toThrow();
    manager.unregisterSession({ taskId: "test" });
    await manager.registerElectronWorkbenchSession({
      taskId: "test",
      webContentsId: 7,
      url: "about:blank",
    });
    expect(request("https://example.com")).toEqual({ cancel: true });
  });
  it("opens WebSockets to loopback only for local previews the user approved", async () => {
    const { request, decide } = contents();
    const manager = new BrowserSessionManager();
    manager.setAccessPolicy("test", { networkEnabled: true, accessNetworkMode: "enabled" });
    await manager.registerElectronWorkbenchSession({
      taskId: "test",
      webContentsId: 7,
      url: "about:blank",
      sessionId: "default",
    });
    fixtures.dns["loopback.example.com"] = "127.0.0.1";
    // Not approved yet, and every other spelling of loopback: no CORS protects a socket's replies.
    for (const url of [
      "ws://127.0.0.1:5173/",
      "ws://127.0.0.2:5173/",
      "ws://localhost.:5173/",
      "ws://app.localhost:5173/",
      "ws://[::ffff:7f00:1]:5173/",
      "wss://localhost:5173/",
      "ws://loopback.example.com:5173/",
    ]) {
      expect(await decide(url), url).toEqual({ cancel: true });
    }
    const { allowsLoopback } = vi.mocked(createBrowserNetworkProxy).mock.calls.at(-1)![1]!;
    expect(allowsLoopback!("http://127.0.0.1:5173")).toBe(false);
    expect(manager.allowUserLocalPreviewUrl("test", "http://127.0.0.1:5173/", "default")).toBe(
      true,
    );
    // The proxy reaches loopback only for that approved origin.
    expect(allowsLoopback!("http://127.0.0.1:5173")).toBe(true);
    expect(allowsLoopback!("http://localhost:5173")).toBe(false);
    expect(allowsLoopback!("http://127.0.0.2:5173")).toBe(false);
    expect(allowsLoopback!("http://loopback.example.com:5173")).toBe(false);
    expect(request("ws://127.0.0.1:5173/hmr")).toEqual({});
    expect(await decide("ws://127.0.0.2:5173/")).toEqual({ cancel: true });
    expect(await decide("ws://loopback.example.com:5173/")).toEqual({ cancel: true });
    delete fixtures.dns["loopback.example.com"];
  });
  it("denies unregistered workers before any guest has loaded", () => {
    const { value, request } = contents();
    const manager = new BrowserSessionManager();
    manager.prepareSessionNetworkGuards(value.session);
    expect(request("https://example.com", -1)).toEqual({ cancel: true });
    expect(request("https://example.com", 7)).toEqual({ cancel: true });
  });
  it("legacy content reads use the same guarded accessor", async () => {
    const manager = {
      getGuardedWebContents: vi.fn().mockRejectedValue(new Error("Browser access denied")),
    };
    const service = new BrowserWorkbenchService(manager as Any);
    (service as Any).sessions.set("test:default", {
      taskId: "test",
      sessionId: "default",
      webContentsId: 7,
    });
    await expect(service.getContent("test")).rejects.toThrow("access denied");
  });
  it("routes Playwright requests through strict pinning and blocks sockets at the context boundary", async () => {
    const service = new BrowserService({ permissions: { network: true } } as Any);
    let routeHandler!: Any;
    let socketHandler!: Any;
    const context = {
      serviceWorkers: () => [],
      pages: () => [],
      route: vi.fn(async (_pattern, h) => (routeHandler = h)),
      routeWebSocket: vi.fn(async (_pattern, h) => (socketHandler = h)),
    };
    await (service as Any).configureContext(context);
    const socket = { close: vi.fn() };
    socketHandler(socket);
    expect(socket.close).toHaveBeenCalledWith(expect.objectContaining({ code: 1008 }));
    const route = {
      request: () => ({
        url: () => "https://example.com",
        method: () => "GET",
        allHeaders: async () => ({}),
        postDataBuffer: () => null,
      }),
      continue: vi.fn(),
      abort: vi.fn(),
    };
    await routeHandler(route);
    expect(route.continue).toHaveBeenCalled();
    await expect(
      (service as Any).configureContext({ ...context, serviceWorkers: () => [{}] }),
    ).rejects.toThrow("service workers");
  });
});
