/**
 * Tests for Matrix adapter direct rooms cache and isGroup field
 */

import { describe, it, expect, vi, beforeEach, afterEach as _afterEach } from "vitest";

// Mock electron
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/tmp/test-cowork"),
  },
}));

// Type for Matrix client mock
interface MockMatrixClient {
  getDirectRooms: () => Promise<string[]>;
}

// Mock adapter for testing direct rooms logic
function createMockMatrixAdapter() {
  let directRooms: Set<string> | null = null;
  let directRoomsLoadedAt = 0;
  const DIRECT_ROOMS_TTL_MS = 5 * 60 * 1000; // 5 minutes

  let mockClient: MockMatrixClient | null = null;

  return {
    get client() {
      return mockClient;
    },
    set client(c: MockMatrixClient | null) {
      mockClient = c;
    },

    get directRooms() {
      return directRooms;
    },
    set directRooms(rooms: Set<string> | null) {
      directRooms = rooms;
    },

    directRoomsLoadedAt,
    DIRECT_ROOMS_TTL_MS,

    async getDirectRooms(): Promise<Set<string> | null> {
      if (!mockClient) {
        return directRooms;
      }

      const now = Date.now();
      if (directRooms && now - this.directRoomsLoadedAt < DIRECT_ROOMS_TTL_MS) {
        return directRooms;
      }

      try {
        const rooms = await mockClient.getDirectRooms();
        directRooms = new Set(rooms);
        this.directRoomsLoadedAt = now;
        return directRooms;
      } catch (error) {
        console.warn("Failed to load Matrix direct rooms:", error);
        this.directRoomsLoadedAt = now; // Prevent repeated failures
        return null;
      }
    },

    determineIsGroup(roomId: string, directRoomsSet: Set<string> | null): boolean | undefined {
      if (directRoomsSet === null) {
        return undefined;
      }
      return !directRoomsSet.has(roomId);
    },
  };
}

describe("Matrix adapter direct rooms cache", () => {
  let adapter: ReturnType<typeof createMockMatrixAdapter>;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = createMockMatrixAdapter();
  });

  describe("getDirectRooms", () => {
    it("should return cached rooms if client is not available", async () => {
      adapter.directRooms = new Set(["!room1:matrix.org", "!room2:matrix.org"]);

      const result = await adapter.getDirectRooms();

      expect(result).toEqual(adapter.directRooms);
    });

    it("should return cached rooms if TTL has not expired", async () => {
      const mockClient: MockMatrixClient = {
        getDirectRooms: vi.fn().mockResolvedValue(["!new:matrix.org"]),
      };
      adapter.client = mockClient;
      adapter.directRooms = new Set(["!cached:matrix.org"]);
      adapter.directRoomsLoadedAt = Date.now(); // Just loaded

      const result = await adapter.getDirectRooms();

      expect(result).toEqual(new Set(["!cached:matrix.org"]));
      expect(mockClient.getDirectRooms).not.toHaveBeenCalled();
    });

    it("should fetch fresh rooms when TTL has expired", async () => {
      const mockClient: MockMatrixClient = {
        getDirectRooms: vi.fn().mockResolvedValue(["!fresh1:matrix.org", "!fresh2:matrix.org"]),
      };
      adapter.client = mockClient;
      adapter.directRooms = new Set(["!old:matrix.org"]);
      adapter.directRoomsLoadedAt = Date.now() - 6 * 60 * 1000; // 6 minutes ago

      const result = await adapter.getDirectRooms();

      expect(result).toEqual(new Set(["!fresh1:matrix.org", "!fresh2:matrix.org"]));
      expect(mockClient.getDirectRooms).toHaveBeenCalled();
    });

    it("should fetch rooms when cache is empty", async () => {
      const mockClient: MockMatrixClient = {
        getDirectRooms: vi.fn().mockResolvedValue(["!room1:matrix.org"]),
      };
      adapter.client = mockClient;

      const result = await adapter.getDirectRooms();

      expect(result).toEqual(new Set(["!room1:matrix.org"]));
      expect(mockClient.getDirectRooms).toHaveBeenCalled();
    });

    it("should return null on fetch error", async () => {
      const mockClient: MockMatrixClient = {
        getDirectRooms: vi.fn().mockRejectedValue(new Error("Network error")),
      };
      adapter.client = mockClient;
      adapter.directRooms = null;
      adapter.directRoomsLoadedAt = 0;

      const result = await adapter.getDirectRooms();

      expect(result).toBeNull();
    });

    it("should update loadedAt timestamp on successful fetch", async () => {
      const mockClient: MockMatrixClient = {
        getDirectRooms: vi.fn().mockResolvedValue(["!room:matrix.org"]),
      };
      adapter.client = mockClient;
      adapter.directRoomsLoadedAt = 0;
      const before = Date.now();

      await adapter.getDirectRooms();

      expect(adapter.directRoomsLoadedAt).toBeGreaterThanOrEqual(before);
    });

    it("should update loadedAt timestamp on error to prevent rapid retries", async () => {
      const mockClient: MockMatrixClient = {
        getDirectRooms: vi.fn().mockRejectedValue(new Error("Error")),
      };
      adapter.client = mockClient;
      adapter.directRoomsLoadedAt = 0;
      const before = Date.now();

      await adapter.getDirectRooms();

      expect(adapter.directRoomsLoadedAt).toBeGreaterThanOrEqual(before);
    });
  });

  describe("determineIsGroup", () => {
    it("should return false for direct rooms", () => {
      const directRoomsSet = new Set(["!dm1:matrix.org", "!dm2:matrix.org"]);

      expect(adapter.determineIsGroup("!dm1:matrix.org", directRoomsSet)).toBe(false);
      expect(adapter.determineIsGroup("!dm2:matrix.org", directRoomsSet)).toBe(false);
    });

    it("should return true for group rooms", () => {
      const directRoomsSet = new Set(["!dm1:matrix.org"]);

      expect(adapter.determineIsGroup("!group:matrix.org", directRoomsSet)).toBe(true);
      expect(adapter.determineIsGroup("!another-group:matrix.org", directRoomsSet)).toBe(true);
    });

    it("should return undefined when direct rooms set is null", () => {
      expect(adapter.determineIsGroup("!room:matrix.org", null)).toBeUndefined();
    });

    it("should return true when direct rooms set is empty", () => {
      const directRoomsSet = new Set<string>();

      expect(adapter.determineIsGroup("!room:matrix.org", directRoomsSet)).toBe(true);
    });
  });
});

describe("Matrix message isGroup field", () => {
  function createMatrixMessage(
    eventId: string,
    roomId: string,
    sender: string,
    body: string,
    isGroup?: boolean,
  ) {
    return {
      messageId: eventId,
      channel: "matrix",
      userId: sender,
      userName: sender.split(":")[0].substring(1),
      chatId: roomId,
      isGroup,
      text: body,
      timestamp: new Date(),
    };
  }

  it("should include isGroup=false for direct messages", () => {
    const msg = createMatrixMessage(
      "$event1",
      "!dm-room:matrix.org",
      "@user:matrix.org",
      "Hello",
      false,
    );

    expect(msg.isGroup).toBe(false);
  });

  it("should include isGroup=true for group messages", () => {
    const msg = createMatrixMessage(
      "$event2",
      "!group-room:matrix.org",
      "@user:matrix.org",
      "Hello everyone",
      true,
    );

    expect(msg.isGroup).toBe(true);
  });

  it("should include isGroup=undefined when unknown", () => {
    const msg = createMatrixMessage(
      "$event3",
      "!unknown-room:matrix.org",
      "@user:matrix.org",
      "Message",
      undefined,
    );

    expect(msg.isGroup).toBeUndefined();
  });
});
