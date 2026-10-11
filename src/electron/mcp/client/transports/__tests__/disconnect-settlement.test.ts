import { describe, expect, it } from "vitest";
import { SSETransport } from "../SSETransport";
import { WebSocketTransport } from "../WebSocketTransport";

function pendingRequest() {
  let reject!: (error: Error) => void;
  const promise = new Promise<never>((_resolve, nextReject) => {
    reject = nextReject;
  });
  return {
    promise,
    reject,
    timeout: setTimeout(() => undefined, 60_000),
    resolve: () => undefined,
  };
}

describe("MCP transport disconnect settlement", () => {
  it("rejects every pending SSE request when cleanup follows an unexpected disconnect", async () => {
    const transport = new SSETransport({
      id: "sse",
      name: "SSE",
      enabled: true,
      transport: "sse",
      url: "https://example.invalid",
    });
    const request = pendingRequest();
    (transport as Any).pendingRequests.set(1, request);
    (transport as Any).cleanup();

    await expect(request.promise).rejects.toThrow(/outcome is uncertain/);
    expect((transport as Any).pendingRequests.size).toBe(0);
  });

  it("rejects every pending WebSocket request when the socket closes unexpectedly", async () => {
    const transport = new WebSocketTransport({
      id: "ws",
      name: "WS",
      enabled: true,
      transport: "websocket",
      url: "wss://example.invalid",
    });
    const request = pendingRequest();
    (transport as Any).pendingRequests.set(1, request);
    (transport as Any).cleanup();

    await expect(request.promise).rejects.toThrow(/outcome is uncertain/);
    expect((transport as Any).pendingRequests.size).toBe(0);
  });
});
