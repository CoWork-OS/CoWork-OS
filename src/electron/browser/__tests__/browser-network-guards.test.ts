import { describe, expect, it, vi } from "vitest";
const fixtures = vi.hoisted(() => ({ contents: null as Any }));
vi.mock("electron", () => ({ webContents: { fromId: () => fixtures.contents } }));
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
  };
}
describe("browser guards before first remote load", () => {
  it("installs guards before registration resolves and denies socket/unowned requests", async () => {
    const { value, request } = contents();
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
    expect(request("wss://example.com")).toEqual({ cancel: true });
    expect(request("ws://example.com")).toEqual({ cancel: true });
    expect(request("https://example.com", -1)).toEqual({ cancel: true });
    expect(value.session.setProxy).toHaveBeenCalledWith(
      expect.objectContaining({ proxyBypassRules: "<-loopback>" }),
    );
    const assertDestination = vi.mocked(createBrowserNetworkProxy).mock.calls.at(-1)![0];
    expect(() => assertDestination("https://example.com")).not.toThrow();
    manager.setAccessPolicy("test", { networkEnabled: true, accessNetworkMode: "disabled" });
    expect(() => assertDestination("https://example.com")).toThrow();
    manager.unregisterSession({ taskId: "test" });
    await manager.registerElectronWorkbenchSession({
      taskId: "test",
      webContentsId: 7,
      url: "about:blank",
    });
    expect(request("https://example.com")).toEqual({ cancel: true });
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
