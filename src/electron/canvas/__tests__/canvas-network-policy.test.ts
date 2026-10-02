import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../../shared/types";
import { installCanvasNetworkGuards, isCanvasRequestAllowed } from "../canvas-network-policy";
import { GuardrailManager } from "../../guardrails/guardrail-manager";

describe("Canvas network enforcement", () => {
  let workspace: Workspace | undefined;
  let request: (details: { url: string }, callback: (r: { cancel?: boolean }) => void) => void;
  let listeners: Record<string, (event: { preventDefault(): void }, url: string) => void>;
  const contents = {
    session: {
      webRequest: {
        onBeforeRequest: vi.fn((_filter, handler) => {
          request = handler;
        }),
      },
    },
    on: vi.fn((name, handler) => {
      listeners[name] = handler;
    }),
    setWindowOpenHandler: vi.fn(),
    setWebRTCIPHandlingPolicy: vi.fn(),
  };
  beforeEach(() => {
    listeners = {};
    vi.spyOn(GuardrailManager, "loadSettings").mockReturnValue({
      enforceAllowedDomains: false,
    } as Any);
    workspace = { id: "ws", permissions: { network: false } } as Workspace;
    installCanvasNetworkGuards("canvas-id", contents as Any, () => workspace);
  });
  function blocked(url: string) {
    const cb = vi.fn();
    request({ url }, cb);
    return cb.mock.calls[0][0].cancel;
  }
  it("blocks HTML subresources and script requests for disabled and missing task policies", () => {
    expect(blocked("https://denied.example/collect")).toBe(true);
    expect(blocked("wss://denied.example/socket")).toBe(true);
    workspace = undefined; // restored session whose owner no longer exists
    expect(blocked("https://allowed.example/")).toBe(true);
    expect(blocked("canvas://canvas-id/index.html")).toBe(false);
    expect(blocked("canvas://other-task/index.html")).toBe(true);
    expect(blocked("file:///etc/passwd")).toBe(true);
  });
  it("requires origin-bound consent for on-request networking", () => {
    workspace!.permissions = { network: true, accessNetworkMode: "on-request" } as Any;
    expect(blocked("https://allowed.example/export")).toBe(true);
    expect(
      isCanvasRequestAllowed(
        "canvas-id",
        "https://allowed.example/image",
        workspace,
        new Set(["https://allowed.example"]),
      ),
    ).toBe(true);
    expect(
      isCanvasRequestAllowed(
        "canvas-id",
        "https://other.example/image",
        workspace,
        new Set(["https://allowed.example"]),
      ),
    ).toBe(false);
  });
  it("re-evaluates live policy for allowed assets, redirects and navigation", () => {
    workspace!.permissions = {
      network: true,
      accessNetworkMode: "allowlist",
      accessDomainRules: [{ pattern: "allowed.example", access: "allow" }],
    } as Any;
    expect(blocked("https://allowed.example/image.png")).toBe(false);
    expect(blocked("https://denied.example/image.png")).toBe(true);
    expect(blocked("wss://allowed.example/socket")).toBe(false);
    expect(blocked("ws://denied.example/socket")).toBe(true);
    for (const name of ["will-navigate", "will-redirect"]) {
      const event = { preventDefault: vi.fn() };
      listeners[name](event, "https://denied.example/");
      expect(event.preventDefault).toHaveBeenCalledOnce();
    }
    workspace!.permissions.network = false;
    expect(blocked("https://allowed.example/image.png")).toBe(true);
  });
});
