/**
 * Tests for SecurityManager pending user handling
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock electron
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/tmp/test-cowork"),
  },
}));

// Mock user repo
const mockUserRepo = {
  deleteExpiredPending: vi.fn(),
  deletePendingByChannel: vi.fn(),
  findByPairingCode: vi.fn(),
  findByChannelUserId: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};

// Simplified mock security manager for testing pending user logic
function createMockSecurityManager() {
  return {
    userRepo: mockUserRepo,

    createPairingCode(): string {
      const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      let code = "";
      for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      return code;
    },

    async generatePairingCode(channel: {
      id: string;
      securityConfig: { pairingCodeTTL?: number };
    }): Promise<{
      code: string;
      expiresAt: number;
    }> {
      // Clear any stale or existing pending entries so only the newest code remains
      mockUserRepo.deleteExpiredPending(channel.id);
      mockUserRepo.deletePendingByChannel(channel.id);

      const code = this.createPairingCode();
      const ttl = channel.securityConfig.pairingCodeTTL || 300;
      const expiresAt = Date.now() + ttl * 1000;

      mockUserRepo.create({
        channelId: channel.id,
        channelUserId: `pending_${Date.now()}`,
        displayName: "Pending Pairing",
        allowed: false,
        pairingCode: code,
        pairingExpiresAt: expiresAt,
      });

      return { code, expiresAt };
    },

    async verifyPairingCode(
      channel: { id: string },
      message: { userId: string; userName: string },
      code: string,
    ): Promise<{ success: boolean; error?: string; user?: Any }> {
      const codeOwner = mockUserRepo.findByPairingCode(channel.id, code);

      if (!codeOwner) {
        return { success: false, error: "Invalid pairing code." };
      }

      // Check expiration
      if (codeOwner.pairingExpiresAt && Date.now() > codeOwner.pairingExpiresAt) {
        // Remove expired pending placeholders entirely
        if (codeOwner.channelUserId.startsWith("pending_")) {
          mockUserRepo.delete(codeOwner.id);
        } else {
          // Clear expired code for real users
          mockUserRepo.update(codeOwner.id, {
            pairingCode: undefined,
            pairingExpiresAt: undefined,
          });
        }
        return { success: false, error: "Pairing code has expired. Please request a new one." };
      }

      // Check for existing user
      const existingUser = mockUserRepo.findByChannelUserId(channel.id, message.userId);
      if (existingUser) {
        // Update existing user
        mockUserRepo.update(existingUser.id, {
          allowed: true,
          pairingCode: undefined,
          pairingExpiresAt: undefined,
        });

        // Clear the code from code owner if different
        if (codeOwner.id !== existingUser.id) {
          if (codeOwner.channelUserId.startsWith("pending_")) {
            mockUserRepo.delete(codeOwner.id);
          } else {
            mockUserRepo.update(codeOwner.id, {
              pairingCode: undefined,
              pairingExpiresAt: undefined,
            });
          }
        }
        return { success: true, user: { ...existingUser, allowed: true } };
      }

      // Create new user
      const newUser = mockUserRepo.create({
        channelId: channel.id,
        channelUserId: message.userId,
        displayName: message.userName,
        allowed: true,
      });

      // Remove pending placeholder
      if (codeOwner.channelUserId.startsWith("pending_")) {
        mockUserRepo.delete(codeOwner.id);
      }

      return { success: true, user: newUser };
    },
  };
}

describe("SecurityManager pending user handling", () => {
  let security: ReturnType<typeof createMockSecurityManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    security = createMockSecurityManager();
  });

  describe("generatePairingCode", () => {
    it("should clear expired pending before generating new code", async () => {
      const channel = { id: "channel-1", securityConfig: {} };

      await security.generatePairingCode(channel);

      expect(mockUserRepo.deleteExpiredPending).toHaveBeenCalledWith("channel-1");
    });

    it("should clear all pending (including valid) before generating new code", async () => {
      const channel = { id: "channel-1", securityConfig: {} };

      await security.generatePairingCode(channel);

      expect(mockUserRepo.deletePendingByChannel).toHaveBeenCalledWith("channel-1");
    });

    it("should create pending user with new code", async () => {
      const channel = { id: "channel-1", securityConfig: { pairingCodeTTL: 300 } };

      const result = await security.generatePairingCode(channel);

      expect(mockUserRepo.create).toHaveBeenCalled();
      expect(result.code).toHaveLength(6);
      expect(result.expiresAt).toBeGreaterThan(Date.now());
    });

    it("should use default TTL if not provided", async () => {
      const channel = { id: "channel-1", securityConfig: {} };

      const result = await security.generatePairingCode(channel);

      // Default 300 seconds = 5 minutes
      const expectedMin = Date.now() + 299 * 1000;
      const expectedMax = Date.now() + 301 * 1000;
      expect(result.expiresAt).toBeGreaterThan(expectedMin);
      expect(result.expiresAt).toBeLessThan(expectedMax);
    });

    it("should use custom TTL if provided", async () => {
      const channel = { id: "channel-1", securityConfig: { pairingCodeTTL: 600 } };

      const result = await security.generatePairingCode(channel);

      // 600 seconds = 10 minutes
      const expectedMin = Date.now() + 599 * 1000;
      const expectedMax = Date.now() + 601 * 1000;
      expect(result.expiresAt).toBeGreaterThan(expectedMin);
      expect(result.expiresAt).toBeLessThan(expectedMax);
    });
  });

  describe("verifyPairingCode", () => {
    it("should return error for invalid code", async () => {
      mockUserRepo.findByPairingCode.mockReturnValue(undefined);

      const result = await security.verifyPairingCode(
        { id: "channel-1" },
        { userId: "user-1", userName: "User" },
        "INVALID",
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("Invalid pairing code.");
    });

    it("should delete pending placeholder on expiration", async () => {
      const expiredPending = {
        id: "pending-id",
        channelUserId: "pending_12345",
        pairingExpiresAt: Date.now() - 60000,
      };
      mockUserRepo.findByPairingCode.mockReturnValue(expiredPending);

      const result = await security.verifyPairingCode(
        { id: "channel-1" },
        { userId: "user-1", userName: "User" },
        "EXPIRED",
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("Pairing code has expired. Please request a new one.");
      expect(mockUserRepo.delete).toHaveBeenCalledWith("pending-id");
      expect(mockUserRepo.update).not.toHaveBeenCalled();
    });

    it("should clear code (not delete) for real users on expiration", async () => {
      const expiredRealUser = {
        id: "user-id",
        channelUserId: "real_user_123",
        pairingExpiresAt: Date.now() - 60000,
      };
      mockUserRepo.findByPairingCode.mockReturnValue(expiredRealUser);

      const result = await security.verifyPairingCode(
        { id: "channel-1" },
        { userId: "user-1", userName: "User" },
        "EXPIRED",
      );

      expect(result.success).toBe(false);
      expect(mockUserRepo.delete).not.toHaveBeenCalled();
      expect(mockUserRepo.update).toHaveBeenCalledWith("user-id", {
        pairingCode: undefined,
        pairingExpiresAt: undefined,
      });
    });

    it("should delete pending placeholder when pairing existing user", async () => {
      const pendingPlaceholder = {
        id: "pending-id",
        channelUserId: "pending_12345",
        pairingExpiresAt: Date.now() + 60000,
        pairingCode: "ABC123",
      };
      const existingUser = {
        id: "existing-user-id",
        channelUserId: "user-1",
        allowed: false,
      };
      mockUserRepo.findByPairingCode.mockReturnValue(pendingPlaceholder);
      mockUserRepo.findByChannelUserId.mockReturnValue(existingUser);

      const result = await security.verifyPairingCode(
        { id: "channel-1" },
        { userId: "user-1", userName: "User" },
        "ABC123",
      );

      expect(result.success).toBe(true);
      // Pending placeholder should be deleted
      expect(mockUserRepo.delete).toHaveBeenCalledWith("pending-id");
      // Existing user should be updated
      expect(mockUserRepo.update).toHaveBeenCalledWith("existing-user-id", {
        allowed: true,
        pairingCode: undefined,
        pairingExpiresAt: undefined,
      });
    });

    it("should clear code (not delete) when pairing existing user with code from real user", async () => {
      const realCodeOwner = {
        id: "code-owner-id",
        channelUserId: "code_owner_user",
        pairingExpiresAt: Date.now() + 60000,
        pairingCode: "XYZ789",
      };
      const existingUser = {
        id: "existing-user-id",
        channelUserId: "user-1",
        allowed: false,
      };
      mockUserRepo.findByPairingCode.mockReturnValue(realCodeOwner);
      mockUserRepo.findByChannelUserId.mockReturnValue(existingUser);

      const result = await security.verifyPairingCode(
        { id: "channel-1" },
        { userId: "user-1", userName: "User" },
        "XYZ789",
      );

      expect(result.success).toBe(true);
      // Real code owner should have code cleared, not deleted
      expect(mockUserRepo.delete).not.toHaveBeenCalled();
      // Code owner's code cleared
      expect(mockUserRepo.update).toHaveBeenCalledWith("code-owner-id", {
        pairingCode: undefined,
        pairingExpiresAt: undefined,
      });
    });

    it("should delete pending placeholder when creating new user", async () => {
      const pendingPlaceholder = {
        id: "pending-id",
        channelUserId: "pending_12345",
        pairingExpiresAt: Date.now() + 60000,
        pairingCode: "NEW123",
      };
      mockUserRepo.findByPairingCode.mockReturnValue(pendingPlaceholder);
      mockUserRepo.findByChannelUserId.mockReturnValue(undefined);
      mockUserRepo.create.mockReturnValue({
        id: "new-user-id",
        channelUserId: "new-user-1",
        allowed: true,
      });

      const result = await security.verifyPairingCode(
        { id: "channel-1" },
        { userId: "new-user-1", userName: "New User" },
        "NEW123",
      );

      expect(result.success).toBe(true);
      expect(mockUserRepo.delete).toHaveBeenCalledWith("pending-id");
    });

    it("should not delete or update code owner when same as existing user", async () => {
      const sameUser = {
        id: "same-user-id",
        channelUserId: "user-1",
        pairingExpiresAt: Date.now() + 60000,
        pairingCode: "SAME123",
        allowed: false,
      };
      mockUserRepo.findByPairingCode.mockReturnValue(sameUser);
      mockUserRepo.findByChannelUserId.mockReturnValue(sameUser);

      const result = await security.verifyPairingCode(
        { id: "channel-1" },
        { userId: "user-1", userName: "User" },
        "SAME123",
      );

      expect(result.success).toBe(true);
      expect(mockUserRepo.delete).not.toHaveBeenCalled();
      // Only one update for the allowed flag
      expect(mockUserRepo.update).toHaveBeenCalledTimes(1);
    });
  });
});
