import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WEB_API_VERSION, type WebSessionBootstrap } from "../shared/host-api/contracts";
import { BrowserHostTransport } from "./transport";

type Listener = (event: { data?: unknown; code?: number; reason?: string }) => void;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  readonly sent: string[] = [];
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  private readonly listeners = new Map<string, Listener[]>();

  constructor(
    readonly url: string | URL,
    readonly protocols?: string | string[],
  ) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", { code, reason });
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }

  frame(data: unknown): void {
    this.emit("message", { data });
  }

  private emit(type: string, event: { data?: unknown; code?: number; reason?: string }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const session = {
  apiVersion: WEB_API_VERSION,
  host: {
    installationId: "installation",
    profileId: "profile",
    generation: "generation",
    runtime: "node",
    platform: "linux",
    appVersion: "test",
  },
  capabilities: {},
  csrfToken: "csrf-token-kept-in-memory",
  providerReady: false,
  onboardingCompleted: true,
  disclaimerAccepted: true,
  activeWorkspaceId: null,
} as WebSessionBootstrap;

function ticketResponse(): Response {
  return new Response(JSON.stringify({ ticket: "ticket_0123456789abcdef" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function setupGlobals(): void {
  vi.stubGlobal("document", { baseURI: "http://127.0.0.1:5174/app/" });
  vi.stubGlobal("WebSocket", FakeWebSocket);
}

async function openTransport(transport: BrowserHostTransport): Promise<FakeWebSocket> {
  const starting = transport.start();
  for (let attempt = 0; attempt < 6 && FakeWebSocket.instances.length === 0; attempt += 1) {
    await Promise.resolve();
  }
  const socket = FakeWebSocket.instances[0];
  if (!socket) throw new Error("The transport did not create a WebSocket.");
  socket.open();
  await starting;
  return socket;
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  setupGlobals();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("BrowserHostTransport", () => {
  it("retries an initial ticket request failure and connects after recovery", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockResolvedValueOnce(ticketResponse());
    vi.stubGlobal("fetch", fetchMock);
    const transport = new BrowserHostTransport(session);

    await transport.start();
    expect(transport.connectionState).toBe("disconnected");
    await vi.advanceTimersByTimeAsync(800);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances).toHaveLength(1);
    FakeWebSocket.instances[0].open();
    expect(transport.connectionState).toBe("connected");
    expect(fetchMock.mock.calls[0][0]).toBeInstanceOf(URL);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      credentials: "same-origin",
      headers: { "X-CoWork-CSRF": session.csrfToken },
    });

    transport.close();
  });

  it("rejects malformed frames and reconnects instead of dispatching them", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(ticketResponse());
    vi.stubGlobal("fetch", fetchMock);
    const transport = new BrowserHostTransport(session);
    const socket = await openTransport(transport);

    socket.frame("not-json");

    expect(socket.closeCalls).toContainEqual({ code: 1002, reason: "Invalid response" });
    expect(transport.connectionState).toBe("disconnected");
    transport.close();
  });

  it("surfaces version mismatch without automatically retrying", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(ticketResponse());
    vi.stubGlobal("fetch", fetchMock);
    const transport = new BrowserHostTransport(session);
    const socket = await openTransport(transport);

    socket.frame(JSON.stringify({ apiVersion: WEB_API_VERSION + 1, type: "event" }));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(transport.connectionState).toBe("version_mismatch");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    transport.close();
  });

  it("requires re-pairing on an unauthenticated ticket request", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const transport = new BrowserHostTransport(session);

    await transport.start();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(transport.connectionState).toBe("reauth_required");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    transport.close();
  });
});
