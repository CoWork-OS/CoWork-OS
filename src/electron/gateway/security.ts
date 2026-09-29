/**
 * Security Manager
 *
 * Handles user authorization for channel access.
 * Supports three modes:
 * - open: Anyone can use the bot
 * - allowlist: Only pre-approved users
 * - pairing: Users must enter a pairing code generated in the desktop app
 *
 * Implements concurrent access safety using mutex locks to prevent race conditions
 * in pairing operations.
 */

import { ChannelUserRepository } from "../database/repository-facades";
import * as crypto from "crypto";
import type Database from "better-sqlite3";
import { ChannelUser, Channel } from "../database/repositories";
import { IncomingMessage } from "./channels/types";
import { pairingMutex, IdempotencyManager } from "../security/concurrency";
import { ContextPolicyManager } from "./context-policy-repository-facades";
import { ContextType, SecurityMode } from "../../shared/types";

export interface AccessCheckResult {
  allowed: boolean;
  user?: ChannelUser;
  reason?: string;
  pairingRequired?: boolean;
  /** The context type (dm or group) for this message */
  contextType?: ContextType;
  /** Tools denied in this context */
  deniedTools?: string[];
}

export interface PairingResult {
  success: boolean;
  user?: ChannelUser;
  error?: string;
}

export class SecurityManager {
  private userRepo: ChannelUserRepository;
  private pairingIdempotency: IdempotencyManager;
  private contextPolicyManager: ContextPolicyManager;

  // Channels that don't support group chats - always use DM context
  private static readonly DM_ONLY_CHANNELS = ["email", "imessage", "bluebubbles"];

  constructor(db: Database.Database) {
    this.userRepo = new ChannelUserRepository(db);
    this.pairingIdempotency = new IdempotencyManager(5 * 60 * 1000); // 5 min TTL
    this.contextPolicyManager = new ContextPolicyManager(db);
  }

  /**
   * Get the context policy manager for direct access to context policies
   */
  getContextPolicyManager(): ContextPolicyManager {
    return this.contextPolicyManager;
  }

  /**
   * Check if a message sender is allowed to interact
   * Supports per-context (DM vs group) security policies
   */
  async checkAccess(
    channel: Channel,
    message: IncomingMessage,
    isGroup?: boolean,
  ): Promise<AccessCheckResult> {
    const securityConfig = channel.securityConfig;

    // Determine context type
    // Priority: 1) Explicit isGroup parameter, 2) Channel type check, 3) Inference from IDs
    let contextType: ContextType;

    if (isGroup !== undefined) {
      // Explicit parameter takes precedence
      contextType = isGroup ? "group" : "dm";
    } else if (SecurityManager.DM_ONLY_CHANNELS.includes(channel.type)) {
      // Channels that don't support groups always use DM context
      contextType = "dm";
    } else {
      // Infer from message - chatId different from userId typically means group
      // This works for Telegram, Discord, Slack, etc.
      contextType = message.chatId !== message.userId ? "group" : "dm";
    }

    // Get context-specific policy (creates default if doesn't exist)
    const contextPolicy = await this.contextPolicyManager.getPolicy(channel.id, contextType);

    // Email authorization is handled by mailbox ownership and optional sender filters,
    // not chat-style pairing or user allowlists.
    const mode: SecurityMode =
      channel.type === "email" ? "open" : contextPolicy.securityMode || securityConfig.mode;

    // Get denied tools for this context
    const deniedTools = contextPolicy.toolRestrictions || [];

    // Get or create user record (refreshing a changed display name) in one unit
    let user = await this.userRepo.findOrCreateByChannelUser({
      channelId: channel.id,
      channelUserId: message.userId,
      displayName: message.userName,
      allowed: mode === "open", // Auto-allow in open mode
    });

    // Check based on security mode
    switch (mode) {
      case "open":
        // Everyone is allowed
        return { allowed: true, user, contextType, deniedTools };

      case "allowlist": {
        // Check if user is in allowlist
        if (user.allowed) {
          return { allowed: true, user, contextType, deniedTools };
        }
        // Check if user ID is in config allowlist
        const allowedUsers = securityConfig.allowedUsers || [];
        if (allowedUsers.includes(message.userId)) {
          // Add to allowed users
          await this.userRepo.update(user.id, { allowed: true });
          return {
            allowed: true,
            user: { ...user, allowed: true },
            contextType,
            deniedTools,
          };
        }
        return {
          allowed: false,
          user,
          reason: "User not in allowlist",
          contextType,
          deniedTools,
        };
      }

      case "pairing":
        // Check if user has been paired
        if (user.allowed) {
          return { allowed: true, user, contextType, deniedTools };
        }
        return {
          allowed: false,
          user,
          reason: "Pairing required",
          pairingRequired: true,
          contextType,
          deniedTools,
        };

      default:
        return {
          allowed: false,
          reason: `Unknown security mode: ${mode}`,
          contextType,
          deniedTools,
        };
    }
  }

  /**
   * Generate a pairing code for a channel
   * Creates a placeholder entry that can be claimed by any user who enters the code
   * Uses mutex to prevent race conditions in concurrent code generation
   */
  async generatePairingCode(
    channel: Channel,
    _userId?: string,
    _displayName?: string,
  ): Promise<string> {
    // Channel users are read and written through the async storage facade, so share the
    // verification lock: generating a code must not interleave with a verification.
    return await pairingMutex.withLock(`pairing:verify:${channel.id}`, () =>
      this.createPendingPairingCode(channel),
    );
  }

  private async createPendingPairingCode(channel: Channel): Promise<string> {
    // Clear any stale or existing pending entries so only the newest code remains.
    await this.userRepo.deletePendingByChannel(channel.id);

    // Generate code (synchronous operation, but we track idempotency)
    const code = this.createPairingCode();
    const ttl = channel.securityConfig.pairingCodeTTL || 300; // 5 minutes default
    const expiresAt = Date.now() + ttl * 1000;

    // Create a placeholder user entry with the pairing code
    // Use a unique placeholder ID so multiple codes can exist
    const placeholderId = `pending_${code}_${Date.now()}`;

    await this.userRepo.create({
      channelId: channel.id,
      channelUserId: placeholderId,
      displayName: "Pending User",
      allowed: false,
      pairingCode: code,
      pairingExpiresAt: expiresAt,
    });

    return code;
  }

  /**
   * Verify a pairing code
   * Looks up the code across all users in the channel and grants access to the caller
   * Uses idempotency to prevent double-verification race conditions
   */
  async verifyPairingCode(channel: Channel, userId: string, code: string): Promise<PairingResult> {
    // Generate idempotency key for this verification attempt
    const idempotencyKey = IdempotencyManager.generateKey(
      "pairing:verify",
      channel.id,
      userId,
      code.toUpperCase(),
    );

    // Check if this exact verification is already in progress or completed
    const existing = this.pairingIdempotency.check(idempotencyKey);
    if (existing.exists && existing.status === "completed") {
      return existing.result as PairingResult;
    }

    // Use mutex to ensure only one verification happens at a time per channel
    const mutexKey = `pairing:verify:${channel.id}`;

    return await pairingMutex.withLock(mutexKey, async () => {
      // Double-check idempotency after acquiring lock
      const recheck = this.pairingIdempotency.check(idempotencyKey);
      if (recheck.exists && recheck.status === "completed") {
        return recheck.result as PairingResult;
      }

      // Start tracking this operation
      this.pairingIdempotency.start(idempotencyKey);

      try {
        const result = await this.doVerifyPairingCode(channel, userId, code);
        this.pairingIdempotency.complete(idempotencyKey, result);
        return result;
      } catch (error) {
        this.pairingIdempotency.fail(idempotencyKey, error);
        throw error;
      }
    });
  }

  /**
   * Internal pairing verification logic (called within mutex)
   */
  // Maximum pairing attempts before lockout (brute-force protection)
  private static readonly MAX_PAIRING_ATTEMPTS = 5;
  // Lockout duration in milliseconds (15 minutes)
  private static readonly PAIRING_LOCKOUT_MS = 15 * 60 * 1000;

  private async doVerifyPairingCode(
    channel: Channel,
    userId: string,
    code: string,
  ): Promise<PairingResult> {
    // First check if user is already allowed
    const existingUser = await this.userRepo.findByChannelUserId(channel.id, userId);
    if (existingUser?.allowed) {
      return { success: true, user: existingUser };
    }

    // Brute-force protection: Check if user is locked out due to too many failed attempts
    if (existingUser && existingUser.pairingAttempts >= SecurityManager.MAX_PAIRING_ATTEMPTS) {
      // Check if lockout period has passed (use dedicated lockoutUntil field)
      const lockoutUntil = existingUser.lockoutUntil;
      if (lockoutUntil && Date.now() < lockoutUntil) {
        const remainingMinutes = Math.ceil((lockoutUntil - Date.now()) / 60000);
        return {
          success: false,
          error: `Too many failed attempts. Please wait ${remainingMinutes} minute(s) before trying again.`,
        };
      }
      // Lockout expired - reset attempts (keep pairingExpiresAt unchanged)
      await this.userRepo.update(existingUser.id, {
        pairingAttempts: 0,
        lockoutUntil: undefined,
      });
    }

    // Look up the pairing code across all users in the channel
    const codeOwner = await this.userRepo.findByPairingCode(channel.id, code.toUpperCase());

    if (!codeOwner) {
      // Code not found - increment attempts on the requesting user if they exist
      if (existingUser) {
        const newAttempts = existingUser.pairingAttempts + 1;
        const updates: { pairingAttempts: number; lockoutUntil?: number } = {
          pairingAttempts: newAttempts,
        };
        // Set lockout timestamp if max attempts reached (uses dedicated lockoutUntil field)
        if (newAttempts >= SecurityManager.MAX_PAIRING_ATTEMPTS) {
          updates.lockoutUntil = Date.now() + SecurityManager.PAIRING_LOCKOUT_MS;
        }
        await this.userRepo.update(existingUser.id, updates);

        // Warn user about remaining attempts
        const remaining = SecurityManager.MAX_PAIRING_ATTEMPTS - newAttempts;
        if (remaining > 0) {
          return {
            success: false,
            error: `Invalid pairing code. ${remaining} attempt(s) remaining.`,
          };
        } else {
          return {
            success: false,
            error: "Too many failed attempts. Please wait 15 minutes before trying again.",
          };
        }
      }
      return { success: false, error: "Invalid pairing code" };
    }

    // Check expiration
    if (codeOwner.pairingExpiresAt && Date.now() > codeOwner.pairingExpiresAt) {
      // Remove expired pending placeholders entirely
      if (codeOwner.channelUserId.startsWith("pending_")) {
        await this.userRepo.delete(codeOwner.id);
      } else {
        // Clear expired code for real users
        await this.userRepo.update(codeOwner.id, {
          pairingCode: undefined,
          pairingExpiresAt: undefined,
        });
      }
      return { success: false, error: "Pairing code has expired. Please request a new one." };
    }

    // Code is valid! Grant access to the requesting user
    if (existingUser) {
      // Update existing user to be allowed
      await this.userRepo.update(existingUser.id, {
        allowed: true,
        pairingCode: undefined,
        pairingExpiresAt: undefined,
        pairingAttempts: 0,
        lockoutUntil: undefined,
      });
      // Clear the code from wherever it was stored
      if (codeOwner.id !== existingUser.id) {
        if (codeOwner.channelUserId.startsWith("pending_")) {
          await this.userRepo.delete(codeOwner.id);
        } else {
          await this.userRepo.update(codeOwner.id, {
            pairingCode: undefined,
            pairingExpiresAt: undefined,
          });
        }
      }
      return { success: true, user: { ...existingUser, allowed: true } };
    } else {
      // This shouldn't happen since checkAccess creates the user, but handle it
      return { success: false, error: "User record not found" };
    }
  }

  /**
   * Revoke a user's access
   */
  async revokeAccess(channelId: string, userId: string): Promise<void> {
    const user = await this.userRepo.findByChannelUserId(channelId, userId);
    if (user) {
      await this.userRepo.update(user.id, { allowed: false });
    }
  }

  /**
   * Grant a user access directly (for allowlist management)
   */
  async grantAccess(channelId: string, userId: string, displayName?: string): Promise<void> {
    let user = await this.userRepo.findByChannelUserId(channelId, userId);

    if (user) {
      await this.userRepo.update(user.id, { allowed: true });
    } else if (displayName) {
      await this.userRepo.create({
        channelId,
        channelUserId: userId,
        displayName,
        allowed: true,
      });
    }
  }

  /**
   * Get all users for a channel
   * Automatically cleans up expired pending pairing entries before returning
   */
  async getChannelUsers(channelId: string): Promise<ChannelUser[]> {
    // Cleanup expired pending entries first
    await this.cleanupExpiredPending(channelId);
    return this.userRepo.findByChannelId(channelId);
  }

  /**
   * Cleanup expired pending pairing entries for a channel
   * These are placeholder entries created when generating pairing codes that have expired
   * Returns the number of deleted entries
   */
  async cleanupExpiredPending(channelId: string): Promise<number> {
    return this.userRepo.deleteExpiredPending(channelId);
  }

  /**
   * Get allowed users for a channel
   */
  async getAllowedUsers(channelId: string): Promise<ChannelUser[]> {
    return this.userRepo.findAllowedByChannelId(channelId);
  }

  // Private methods

  /**
   * Create a random pairing code
   */
  private createPairingCode(): string {
    // Generate 6-character alphanumeric code
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // Exclude similar chars (I, O, 1, 0)
    let code = "";
    const randomBytes = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) {
      code += chars[randomBytes[i] % chars.length];
    }
    return code;
  }
}
