/**
 * Edge Case Tests for WebSocket Control Plane Client
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { WebSocket } from "ws";
import { ControlPlaneClient, ClientRegistry, type ClientScope } from "../client";

// Mock WebSocket
const createMockSocket = (readyState: number = WebSocket.OPEN): WebSocket => {
  return {
    readyState,
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as WebSocket;
};

describe("ControlPlaneClient edge cases", () => {
  let mockSocket: WebSocket;

  beforeEach(() => {
    mockSocket = createMockSocket();
  });

  describe("constructor edge cases", () => {
    it("should handle empty remote address", () => {
      const client = new ControlPlaneClient(mockSocket, "");
      expect(client.info.remoteAddress).toBe("");
    });

    it("should handle undefined user agent", () => {
      const client = new ControlPlaneClient(mockSocket, "127.0.0.1");
      expect(client.info.userAgent).toBeUndefined();
    });

    it("should handle undefined origin", () => {
      const client = new ControlPlaneClient(mockSocket, "127.0.0.1", "Agent");
      expect(client.info.origin).toBeUndefined();
    });

    it("should handle IPv6 addresses", () => {
      const client = new ControlPlaneClient(mockSocket, "::1");
      expect(client.info.remoteAddress).toBe("::1");
    });

    it("should handle long user agent strings", () => {
      const longAgent = "A".repeat(1000);
      const client = new ControlPlaneClient(mockSocket, "127.0.0.1", longAgent);
      expect(client.info.userAgent).toBe(longAgent);
    });
  });

  describe("hasScope edge cases", () => {
    it("should return false for any scope when not authenticated", () => {
      const client = new ControlPlaneClient(mockSocket, "127.0.0.1");
      const scopes: ClientScope[] = ["admin", "read", "write", "operator"];

      for (const scope of scopes) {
        expect(client.hasScope(scope)).toBe(false);
      }
    });

    it("should grant all scopes with admin", () => {
      const client = new ControlPlaneClient(mockSocket, "127.0.0.1");
      client.authenticate(["admin"]);

      const allScopes: ClientScope[] = ["admin", "read", "write", "operator"];
      for (const scope of allScopes) {
        expect(client.hasScope(scope)).toBe(true);
      }
    });

    it("should not have admin when only specific scopes granted", () => {
      const client = new ControlPlaneClient(mockSocket, "127.0.0.1");
      client.authenticate(["read", "write"]);

      expect(client.hasScope("read")).toBe(true);
      expect(client.hasScope("write")).toBe(true);
      expect(client.hasScope("admin")).toBe(false);
      expect(client.hasScope("operator")).toBe(false);
    });

    it("should handle empty scopes array", () => {
      const client = new ControlPlaneClient(mockSocket, "127.0.0.1");
      client.authenticate([]);

      expect(client.hasScope("read")).toBe(false);
      expect(client.hasScope("admin")).toBe(false);
    });
  });

  describe("authenticate edge cases", () => {
    it("should handle re-authentication", () => {
      const client = new ControlPlaneClient(mockSocket, "127.0.0.1");
      client.authenticate(["read"]);
      expect(client.info.scopes).toEqual(["read"]);

      client.authenticate(["admin"]);
      expect(client.info.scopes).toEqual(["admin"]);
    });

    it("should update device name on re-auth", () => {
      const client = new ControlPlaneClient(mockSocket, "127.0.0.1");
      client.authenticate(["read"], "Device1");
      expect(client.info.deviceName).toBe("Device1");

      client.authenticate(["read"], "Device2");
      expect(client.info.deviceName).toBe("Device2");
    });

    it("should handle undefined device name", () => {
      const client = new ControlPlaneClient(mockSocket, "127.0.0.1");
      client.authenticate(["read"], undefined);
      expect(client.info.deviceName).toBeUndefined();
    });

    it("should handle empty device name", () => {
      const client = new ControlPlaneClient(mockSocket, "127.0.0.1");
      client.authenticate(["read"], "");
      expect(client.info.deviceName).toBe("");
    });
  });

  describe("send edge cases", () => {
    it("should handle send when socket throws", () => {
      mockSocket.send = vi.fn().mockImplementation(() => {
        throw new Error("Send failed");
      });
      const client = new ControlPlaneClient(mockSocket, "127.0.0.1");

      const result = client.send({ type: "res", id: "test", ok: true });
      expect(result).toBe(false);
    });

    it("should return false for all ready states except OPEN", () => {
      const states = [WebSocket.CONNECTING, WebSocket.CLOSING, WebSocket.CLOSED];

      for (const state of states) {
        const socket = createMockSocket(state);
        const client = new ControlPlaneClient(socket, "127.0.0.1");
        const result = client.send({ type: "res", id: "test", ok: true });
        expect(result).toBe(false);
        expect(socket.send).not.toHaveBeenCalled();
      }
    });

    it("should serialize large payloads", () => {
      const client = new ControlPlaneClient(mockSocket, "127.0.0.1");
      const largePayload: Record<string, number> = {};
      for (let i = 0; i < 1000; i++) {
        largePayload[`key${i}`] = i;
      }

      const result = client.send({
        type: "res",
        id: "test",
        ok: true,
        payload: largePayload,
      });

      expect(result).toBe(true);
      expect(mockSocket.send).toHaveBeenCalled();
    });
  });

  describe("sendEvent edge cases", () => {
    it("should increment seq correctly over many events", () => {
      const client = new ControlPlaneClient(mockSocket, "127.0.0.1");

      for (let i = 0; i < 100; i++) {
        client.sendEvent("test");
      }

      const calls = (mockSocket.send as Any).mock.calls;
      expect(calls).toHaveLength(100);

      // Check first and last sequence numbers
      const firstCall = JSON.parse(calls[0][0]);
      const lastCall = JSON.parse(calls[99][0]);
      expect(firstCall.seq).toBe(0);
      expect(lastCall.seq).toBe(99);
    });

    it("should handle empty event name", () => {
      const client = new ControlPlaneClient(mockSocket, "127.0.0.1");
      const result = client.sendEvent("");
      expect(result).toBe(true);
    });

    it("should handle undefined payload", () => {
      const client = new ControlPlaneClient(mockSocket, "127.0.0.1");
      const result = client.sendEvent("test", undefined);
      expect(result).toBe(true);
    });

    it("should handle null payload", () => {
      const client = new ControlPlaneClient(mockSocket, "127.0.0.1");
      const result = client.sendEvent("test", null);
      expect(result).toBe(true);
    });

    it("should include stateVersion when provided", () => {
      const client = new ControlPlaneClient(mockSocket, "127.0.0.1");
      client.sendEvent("test", { data: 1 }, "v1.2.3");

      const call = JSON.parse((mockSocket.send as Any).mock.calls[0][0]);
      expect(call.stateVersion).toBe("v1.2.3");
    });
  });

  describe("close edge cases", () => {
    it("should handle close with only code", () => {
      const client = new ControlPlaneClient(mockSocket, "127.0.0.1");
      client.close(4000);

      expect(mockSocket.close).toHaveBeenCalledWith(4000, "Connection closed");
    });

    it("should handle close with custom reason", () => {
      const client = new ControlPlaneClient(mockSocket, "127.0.0.1");
      client.close(1001, "Going away");

      expect(mockSocket.close).toHaveBeenCalledWith(1001, "Going away");
    });

    it("should handle close on already closing socket", () => {
      const socket = createMockSocket(WebSocket.CLOSING);
      const client = new ControlPlaneClient(socket, "127.0.0.1");
      client.close();

      expect(socket.close).not.toHaveBeenCalled();
    });

    it("should handle multiple close calls", () => {
      const client = new ControlPlaneClient(mockSocket, "127.0.0.1");
      client.close();
      (mockSocket as Any).readyState = WebSocket.CLOSED;
      client.close();

      expect(mockSocket.close).toHaveBeenCalledTimes(1);
    });
  });

  describe("getSummary edge cases", () => {
    it("should return correct summary for pending client", () => {
      const client = new ControlPlaneClient(mockSocket, "127.0.0.1");
      const summary = client.getSummary();

      expect(summary.authenticated).toBe(false);
      expect(summary.scopes).toEqual([]);
      expect(summary.deviceName).toBeUndefined();
    });

    it("should return correct summary for rejected client", () => {
      const client = new ControlPlaneClient(mockSocket, "127.0.0.1");
      client.reject();
      const summary = client.getSummary();

      expect(summary.authenticated).toBe(false);
    });

    it("should include all fields for authenticated client", () => {
      const client = new ControlPlaneClient(
        mockSocket,
        "192.168.1.100",
        "CustomAgent/2.0",
        "https://example.com",
      );
      client.authenticate(["read", "write"], "MyDevice");
      const summary = client.getSummary();

      expect(summary.id).toBeDefined();
      expect(summary.remoteAddress).toBe("192.168.1.100");
      expect(summary.deviceName).toBe("MyDevice");
      expect(summary.authenticated).toBe(true);
      expect(summary.scopes).toEqual(["read", "write"]);
      expect(summary.connectedAt).toBeDefined();
      expect(summary.lastActivityAt).toBeDefined();
    });
  });

  describe("timestamp handling", () => {
    it("should have consistent initial timestamps", () => {
      const client = new ControlPlaneClient(mockSocket, "127.0.0.1");

      expect(client.info.connectedAt).toBeLessThanOrEqual(Date.now());
      expect(client.info.lastActivityAt).toBeLessThanOrEqual(Date.now());
      expect(client.info.lastHeartbeatAt).toBeLessThanOrEqual(Date.now());

      // All should be close to each other (within 100ms)
      const diff1 = Math.abs(client.info.connectedAt - client.info.lastActivityAt);
      const diff2 = Math.abs(client.info.connectedAt - client.info.lastHeartbeatAt);
      expect(diff1).toBeLessThan(100);
      expect(diff2).toBeLessThan(100);
    });

    it("should update activity timestamp separately from heartbeat", () => {
      const client = new ControlPlaneClient(mockSocket, "127.0.0.1");
      const initialHeartbeat = client.info.lastHeartbeatAt;

      client.updateActivity();

      expect(client.info.lastActivityAt).toBeGreaterThanOrEqual(initialHeartbeat);
      // Heartbeat should not change
      expect(client.info.lastHeartbeatAt).toBe(initialHeartbeat);
    });

    it("should update both timestamps on heartbeat", () => {
      const client = new ControlPlaneClient(mockSocket, "127.0.0.1");
      const initial = client.info.lastActivityAt;

      client.updateHeartbeat();

      expect(client.info.lastHeartbeatAt).toBeGreaterThanOrEqual(initial);
      expect(client.info.lastActivityAt).toBeGreaterThanOrEqual(initial);
    });
  });
});

describe("ClientRegistry edge cases", () => {
  let registry: ClientRegistry;

  beforeEach(() => {
    registry = new ClientRegistry();
  });

  describe("add/remove operations", () => {
    it("should handle adding same client twice", () => {
      const socket = createMockSocket();
      const client = new ControlPlaneClient(socket, "127.0.0.1");

      registry.add(client);
      registry.add(client);

      expect(registry.count).toBe(1);
    });

    it("should handle removing non-existent client", () => {
      const result = registry.remove("non-existent-id");
      expect(result).toBe(false);
    });

    it("should handle removing client twice", () => {
      const socket = createMockSocket();
      const client = new ControlPlaneClient(socket, "127.0.0.1");

      registry.add(client);
      expect(registry.remove(client.id)).toBe(true);
      expect(registry.remove(client.id)).toBe(false);
    });
  });

  describe("getAll edge cases", () => {
    it("should return new array each time", () => {
      const socket = createMockSocket();
      const client = new ControlPlaneClient(socket, "127.0.0.1");
      registry.add(client);

      const arr1 = registry.getAll();
      const arr2 = registry.getAll();

      expect(arr1).not.toBe(arr2);
      expect(arr1).toEqual(arr2);
    });

    it("should handle many clients", () => {
      for (let i = 0; i < 100; i++) {
        const socket = createMockSocket();
        const client = new ControlPlaneClient(socket, `192.168.1.${i}`);
        registry.add(client);
      }

      expect(registry.count).toBe(100);
      expect(registry.getAll()).toHaveLength(100);
    });
  });

  describe("getAuthenticated edge cases", () => {
    it("should handle mixed authentication states", () => {
      for (let i = 0; i < 10; i++) {
        const socket = createMockSocket();
        const client = new ControlPlaneClient(socket, `192.168.1.${i}`);
        if (i % 2 === 0) {
          client.authenticate(["read"]);
        } else if (i % 3 === 0) {
          client.reject();
        }
        // Remaining stay pending
        registry.add(client);
      }

      const authenticated = registry.getAuthenticated();
      expect(authenticated).toHaveLength(5); // 0, 2, 4, 6, 8
    });
  });

  describe("broadcast edge cases", () => {
    it("should handle broadcast with no authenticated clients", () => {
      const socket = createMockSocket();
      const client = new ControlPlaneClient(socket, "127.0.0.1");
      registry.add(client);

      const sent = registry.broadcast("test.event", { data: "test" });
      expect(sent).toBe(0);
    });

    it("should handle broadcast when some sends fail", () => {
      const socket1 = createMockSocket();
      const socket2 = createMockSocket();
      socket2.send = vi.fn().mockImplementation(() => {
        throw new Error("Send failed");
      });

      const client1 = new ControlPlaneClient(socket1, "127.0.0.1");
      const client2 = new ControlPlaneClient(socket2, "192.168.1.1");

      client1.authenticate(["admin"]);
      client2.authenticate(["admin"]);

      registry.add(client1);
      registry.add(client2);

      const sent = registry.broadcast("test.event");
      expect(sent).toBe(1); // Only client1 succeeded
    });

    it("should handle broadcast with disconnected clients", () => {
      const socket1 = createMockSocket(WebSocket.OPEN);
      const socket2 = createMockSocket(WebSocket.CLOSED);

      const client1 = new ControlPlaneClient(socket1, "127.0.0.1");
      const client2 = new ControlPlaneClient(socket2, "192.168.1.1");

      client1.authenticate(["admin"]);
      client2.authenticate(["admin"]);

      registry.add(client1);
      registry.add(client2);

      const sent = registry.broadcast("test.event");
      expect(sent).toBe(1);
    });
  });

  describe("closeAll edge cases", () => {
    it("should handle closeAll on empty registry", () => {
      registry.closeAll(1000, "Test");
      expect(registry.count).toBe(0);
    });

    it("should close all clients regardless of state", () => {
      const sockets: WebSocket[] = [];
      for (let i = 0; i < 5; i++) {
        const socket = createMockSocket();
        sockets.push(socket);
        const client = new ControlPlaneClient(socket, `192.168.1.${i}`);
        if (i % 2 === 0) client.authenticate(["read"]);
        registry.add(client);
      }

      registry.closeAll(1001, "Shutdown");

      for (const socket of sockets) {
        expect(socket.close).toHaveBeenCalledWith(1001, "Shutdown");
      }
      expect(registry.count).toBe(0);
    });
  });

  describe("cleanup edge cases", () => {
    it("should handle cleanup on empty registry", () => {
      const removed = registry.cleanup();
      expect(removed).toBe(0);
    });

    it("should only remove disconnected clients", () => {
      const openSocket1 = createMockSocket(WebSocket.OPEN);
      const openSocket2 = createMockSocket(WebSocket.OPEN);
      const closedSocket = createMockSocket(WebSocket.CLOSED);
      const closingSocket = createMockSocket(WebSocket.CLOSING);

      registry.add(new ControlPlaneClient(openSocket1, "1.1.1.1"));
      registry.add(new ControlPlaneClient(openSocket2, "2.2.2.2"));
      registry.add(new ControlPlaneClient(closedSocket, "3.3.3.3"));
      registry.add(new ControlPlaneClient(closingSocket, "4.4.4.4"));

      const removed = registry.cleanup();

      expect(removed).toBe(2); // closed and closing
      expect(registry.count).toBe(2); // only open ones remain
    });
  });

  describe("getStatus edge cases", () => {
    it("should return zeros for empty registry", () => {
      const status = registry.getStatus();

      expect(status.total).toBe(0);
      expect(status.authenticated).toBe(0);
      expect(status.pending).toBe(0);
      expect(status.clients).toEqual([]);
    });

    it("should correctly count pending vs authenticated", () => {
      for (let i = 0; i < 10; i++) {
        const socket = createMockSocket();
        const client = new ControlPlaneClient(socket, `192.168.1.${i}`);
        if (i < 3) client.authenticate(["read"]);
        else if (i < 5) client.reject();
        // Rest stay pending
        registry.add(client);
      }

      const status = registry.getStatus();

      expect(status.total).toBe(10);
      expect(status.authenticated).toBe(3);
      expect(status.pending).toBe(5); // rejected ones are not pending
    });

    it("should include all client summaries", () => {
      for (let i = 0; i < 3; i++) {
        const socket = createMockSocket();
        const client = new ControlPlaneClient(socket, `192.168.1.${i}`);
        client.authenticate(["read"], `Device${i}`);
        registry.add(client);
      }

      const status = registry.getStatus();

      expect(status.clients).toHaveLength(3);
      for (let i = 0; i < 3; i++) {
        expect(status.clients[i]).toHaveProperty("id");
        expect(status.clients[i]).toHaveProperty("remoteAddress");
        expect(status.clients[i]).toHaveProperty("authenticated");
      }
    });
  });
});
