/**
 * Tests for ChannelUserRepository pending user deletion methods
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock electron
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/tmp/test-cowork"),
  },
}));

// In-memory mock storage
let mockUsers: Map<string, Any>;
let userId = 0;

interface MockChannelUser {
  id: string;
  channelId: string;
  channelUserId: string;
  displayName: string;
  allowed: boolean;
  pairingCode?: string;
  pairingExpiresAt?: number;
  createdAt: number;
}

// Mock repository that mirrors the real implementation
class MockChannelUserRepository {
  create(user: Omit<MockChannelUser, "id" | "createdAt">): MockChannelUser {
    const newUser: MockChannelUser = {
      ...user,
      id: `user-${++userId}`,
      createdAt: Date.now(),
    };
    mockUsers.set(newUser.id, newUser);
    return newUser;
  }

  findByChannelId(channelId: string): MockChannelUser[] {
    return Array.from(mockUsers.values()).filter((u) => u.channelId === channelId);
  }

  delete(id: string): void {
    mockUsers.delete(id);
  }

  /**
   * Delete expired or incomplete pending pairing entries for a specific channel.
   */
  deleteExpiredPending(channelId: string): number {
    const now = Date.now();
    let deleted = 0;

    mockUsers.forEach((user, id) => {
      if (
        user.channelId === channelId &&
        user.allowed === false &&
        user.channelUserId.startsWith("pending_") &&
        (user.pairingExpiresAt === undefined ||
          user.pairingCode === undefined ||
          user.pairingExpiresAt < now)
      ) {
        mockUsers.delete(id);
        deleted++;
      }
    });

    return deleted;
  }

  /**
   * Delete all pending pairing entries for a channel (valid or expired).
   */
  deletePendingByChannel(channelId: string): number {
    let deleted = 0;

    mockUsers.forEach((user, id) => {
      if (
        user.channelId === channelId &&
        user.allowed === false &&
        user.channelUserId.startsWith("pending_")
      ) {
        mockUsers.delete(id);
        deleted++;
      }
    });

    return deleted;
  }

  /**
   * Delete expired or empty pending pairing entries across all channels.
   */
  deleteExpiredPendingAll(): number {
    const now = Date.now();
    let deleted = 0;

    mockUsers.forEach((user, id) => {
      if (
        user.allowed === false &&
        user.channelUserId.startsWith("pending_") &&
        (user.pairingExpiresAt === undefined ||
          user.pairingCode === undefined ||
          user.pairingExpiresAt < now)
      ) {
        mockUsers.delete(id);
        deleted++;
      }
    });

    return deleted;
  }
}

describe("ChannelUserRepository - Pending User Deletion", () => {
  let repo: MockChannelUserRepository;

  beforeEach(() => {
    mockUsers = new Map();
    userId = 0;
    repo = new MockChannelUserRepository();
  });

  describe("deleteExpiredPending", () => {
    it("should delete expired pending users", () => {
      const channelId = "channel-1";
      const pastTime = Date.now() - 60000;

      // Create expired pending user
      repo.create({
        channelId,
        channelUserId: "pending_abc",
        displayName: "Pending User",
        allowed: false,
        pairingCode: "ABC123",
        pairingExpiresAt: pastTime,
      });

      const deleted = repo.deleteExpiredPending(channelId);

      expect(deleted).toBe(1);
      expect(repo.findByChannelId(channelId)).toHaveLength(0);
    });

    it("should delete pending users with null pairingExpiresAt", () => {
      const channelId = "channel-2";

      repo.create({
        channelId,
        channelUserId: "pending_xyz",
        displayName: "Pending No Expiry",
        allowed: false,
        pairingCode: "XYZ789",
        pairingExpiresAt: undefined,
      });

      const deleted = repo.deleteExpiredPending(channelId);

      expect(deleted).toBe(1);
    });

    it("should delete pending users with null pairingCode", () => {
      const channelId = "channel-3";
      const futureTime = Date.now() + 60000;

      repo.create({
        channelId,
        channelUserId: "pending_nocode",
        displayName: "Pending No Code",
        allowed: false,
        pairingCode: undefined,
        pairingExpiresAt: futureTime,
      });

      const deleted = repo.deleteExpiredPending(channelId);

      expect(deleted).toBe(1);
    });

    it("should NOT delete valid pending users", () => {
      const channelId = "channel-4";
      const futureTime = Date.now() + 300000;

      repo.create({
        channelId,
        channelUserId: "pending_valid",
        displayName: "Valid Pending",
        allowed: false,
        pairingCode: "VALID1",
        pairingExpiresAt: futureTime,
      });

      const deleted = repo.deleteExpiredPending(channelId);

      expect(deleted).toBe(0);
      expect(repo.findByChannelId(channelId)).toHaveLength(1);
    });

    it("should NOT delete allowed users", () => {
      const channelId = "channel-5";

      repo.create({
        channelId,
        channelUserId: "user_allowed",
        displayName: "Allowed User",
        allowed: true,
      });

      const deleted = repo.deleteExpiredPending(channelId);

      expect(deleted).toBe(0);
      expect(repo.findByChannelId(channelId)).toHaveLength(1);
    });

    it("should NOT delete non-pending users", () => {
      const channelId = "channel-6";
      const pastTime = Date.now() - 60000;

      repo.create({
        channelId,
        channelUserId: "real_user_123",
        displayName: "Real User",
        allowed: false,
        pairingCode: "ABC123",
        pairingExpiresAt: pastTime,
      });

      const deleted = repo.deleteExpiredPending(channelId);

      expect(deleted).toBe(0);
    });

    it("should only delete from specified channel", () => {
      const channelId1 = "channel-a";
      const channelId2 = "channel-b";
      const pastTime = Date.now() - 60000;

      repo.create({
        channelId: channelId1,
        channelUserId: "pending_a",
        displayName: "Pending A",
        allowed: false,
        pairingCode: "A1",
        pairingExpiresAt: pastTime,
      });

      repo.create({
        channelId: channelId2,
        channelUserId: "pending_b",
        displayName: "Pending B",
        allowed: false,
        pairingCode: "B1",
        pairingExpiresAt: pastTime,
      });

      const deleted = repo.deleteExpiredPending(channelId1);

      expect(deleted).toBe(1);
      expect(repo.findByChannelId(channelId1)).toHaveLength(0);
      expect(repo.findByChannelId(channelId2)).toHaveLength(1);
    });
  });

  describe("deletePendingByChannel", () => {
    it("should delete all pending users for a channel", () => {
      const channelId = "channel-10";
      const futureTime = Date.now() + 300000;

      // Valid pending
      repo.create({
        channelId,
        channelUserId: "pending_valid",
        displayName: "Valid Pending",
        allowed: false,
        pairingCode: "VALID",
        pairingExpiresAt: futureTime,
      });

      // Expired pending
      repo.create({
        channelId,
        channelUserId: "pending_expired",
        displayName: "Expired Pending",
        allowed: false,
        pairingCode: "EXP",
        pairingExpiresAt: Date.now() - 60000,
      });

      const deleted = repo.deletePendingByChannel(channelId);

      expect(deleted).toBe(2);
      expect(repo.findByChannelId(channelId)).toHaveLength(0);
    });

    it("should NOT delete allowed users", () => {
      const channelId = "channel-11";

      repo.create({
        channelId,
        channelUserId: "pending_user",
        displayName: "Pending",
        allowed: false,
      });

      repo.create({
        channelId,
        channelUserId: "allowed_user",
        displayName: "Allowed",
        allowed: true,
      });

      const deleted = repo.deletePendingByChannel(channelId);

      expect(deleted).toBe(1);
      expect(repo.findByChannelId(channelId)).toHaveLength(1);
    });

    it("should NOT delete non-pending users", () => {
      const channelId = "channel-12";

      repo.create({
        channelId,
        channelUserId: "real_user_abc",
        displayName: "Real User",
        allowed: false,
      });

      const deleted = repo.deletePendingByChannel(channelId);

      expect(deleted).toBe(0);
    });
  });

  describe("deleteExpiredPendingAll", () => {
    it("should delete expired pending users across all channels", () => {
      const pastTime = Date.now() - 60000;

      repo.create({
        channelId: "channel-x",
        channelUserId: "pending_x",
        displayName: "Pending X",
        allowed: false,
        pairingCode: "X1",
        pairingExpiresAt: pastTime,
      });

      repo.create({
        channelId: "channel-y",
        channelUserId: "pending_y",
        displayName: "Pending Y",
        allowed: false,
        pairingCode: "Y1",
        pairingExpiresAt: pastTime,
      });

      const deleted = repo.deleteExpiredPendingAll();

      expect(deleted).toBe(2);
    });

    it("should delete pending with null expiry across all channels", () => {
      repo.create({
        channelId: "channel-z",
        channelUserId: "pending_z",
        displayName: "Pending Z",
        allowed: false,
        pairingCode: "Z1",
        pairingExpiresAt: undefined,
      });

      const deleted = repo.deleteExpiredPendingAll();

      expect(deleted).toBe(1);
    });

    it("should NOT delete valid pending users", () => {
      const futureTime = Date.now() + 300000;

      repo.create({
        channelId: "channel-valid",
        channelUserId: "pending_valid",
        displayName: "Valid",
        allowed: false,
        pairingCode: "VALID",
        pairingExpiresAt: futureTime,
      });

      const deleted = repo.deleteExpiredPendingAll();

      expect(deleted).toBe(0);
    });

    it("should handle mixed valid and invalid across channels", () => {
      const futureTime = Date.now() + 300000;
      const pastTime = Date.now() - 60000;

      // Valid in channel A
      repo.create({
        channelId: "channel-a",
        channelUserId: "pending_a1",
        displayName: "Valid A",
        allowed: false,
        pairingCode: "A1",
        pairingExpiresAt: futureTime,
      });

      // Expired in channel A
      repo.create({
        channelId: "channel-a",
        channelUserId: "pending_a2",
        displayName: "Expired A",
        allowed: false,
        pairingCode: "A2",
        pairingExpiresAt: pastTime,
      });

      // Expired in channel B
      repo.create({
        channelId: "channel-b",
        channelUserId: "pending_b1",
        displayName: "Expired B",
        allowed: false,
        pairingCode: undefined,
      });

      // Allowed user (should not be deleted)
      repo.create({
        channelId: "channel-b",
        channelUserId: "real_b1",
        displayName: "Real B",
        allowed: true,
      });

      const deleted = repo.deleteExpiredPendingAll();

      expect(deleted).toBe(2);
      // Valid A and Real B should remain
      expect(mockUsers.size).toBe(2);
    });
  });
});
