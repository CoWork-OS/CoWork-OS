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

import * as crypto from 'crypto';
import Database from 'better-sqlite3';
import {
  ChannelUserRepository,
  ChannelUser,
  Channel,
} from '../database/repositories';
import { IncomingMessage } from './channels/types';
import { pairingMutex, IdempotencyManager } from '../security/concurrency';

export interface AccessCheckResult {
  allowed: boolean;
  user?: ChannelUser;
  reason?: string;
  pairingRequired?: boolean;
}

export interface PairingResult {
  success: boolean;
  user?: ChannelUser;
  error?: string;
}

export class SecurityManager {
  private userRepo: ChannelUserRepository;
  private pairingIdempotency: IdempotencyManager;

  constructor(db: Database.Database) {
    this.userRepo = new ChannelUserRepository(db);
    this.pairingIdempotency = new IdempotencyManager(5 * 60 * 1000); // 5 min TTL
  }

  /**
   * Check if a message sender is allowed to interact
   */
  async checkAccess(channel: Channel, message: IncomingMessage): Promise<AccessCheckResult> {
    const securityConfig = channel.securityConfig;
    const mode = securityConfig.mode;

    // Get or create user record
    let user = this.userRepo.findByChannelUserId(channel.id, message.userId);

    if (!user) {
      // Create new user record
      user = this.userRepo.create({
        channelId: channel.id,
        channelUserId: message.userId,
        displayName: message.userName,
        allowed: mode === 'open', // Auto-allow in open mode
      });
    } else {
      // Update display name if changed
      if (user.displayName !== message.userName) {
        this.userRepo.update(user.id, { displayName: message.userName });
      }
    }

    // Check based on security mode
    switch (mode) {
      case 'open':
        // Everyone is allowed
        return { allowed: true, user };

      case 'allowlist': {
        // Check if user is in allowlist
        if (user.allowed) {
          return { allowed: true, user };
        }
        // Check if user ID is in config allowlist
        const allowedUsers = securityConfig.allowedUsers || [];
        if (allowedUsers.includes(message.userId)) {
          // Add to allowed users
          this.userRepo.update(user.id, { allowed: true });
          return { allowed: true, user: { ...user, allowed: true } };
        }
        return { allowed: false, user, reason: 'User not in allowlist' };
      }

      case 'pairing':
        // Check if user has been paired
        if (user.allowed) {
          return { allowed: true, user };
        }
        return {
          allowed: false,
          user,
          reason: 'Pairing required',
          pairingRequired: true,
        };

      default:
        return { allowed: false, reason: `Unknown security mode: ${mode}` };
    }
  }

  /**
   * Generate a pairing code for a channel
   * Creates a placeholder entry that can be claimed by any user who enters the code
   * Uses mutex to prevent race conditions in concurrent code generation
   */
  generatePairingCode(channel: Channel, _userId?: string, _displayName?: string): string {
    // Use synchronous mutex key for this channel to prevent concurrent generation issues
    const mutexKey = `pairing:generate:${channel.id}`;

    // Generate code (synchronous operation, but we track idempotency)
    const code = this.createPairingCode();
    const ttl = channel.securityConfig.pairingCodeTTL || 300; // 5 minutes default
    const expiresAt = Date.now() + ttl * 1000;

    // Create a placeholder user entry with the pairing code
    // Use a unique placeholder ID so multiple codes can exist
    const placeholderId = `pending_${code}_${Date.now()}`;

    this.userRepo.create({
      channelId: channel.id,
      channelUserId: placeholderId,
      displayName: 'Pending User',
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
  async verifyPairingCode(
    channel: Channel,
    userId: string,
    code: string
  ): Promise<PairingResult> {
    // Generate idempotency key for this verification attempt
    const idempotencyKey = IdempotencyManager.generateKey(
      'pairing:verify',
      channel.id,
      userId,
      code.toUpperCase()
    );

    // Check if this exact verification is already in progress or completed
    const existing = this.pairingIdempotency.check(idempotencyKey);
    if (existing.exists && existing.status === 'completed') {
      return existing.result as PairingResult;
    }

    // Use mutex to ensure only one verification happens at a time per channel
    const mutexKey = `pairing:verify:${channel.id}`;

    return await pairingMutex.withLock(mutexKey, async () => {
      // Double-check idempotency after acquiring lock
      const recheck = this.pairingIdempotency.check(idempotencyKey);
      if (recheck.exists && recheck.status === 'completed') {
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
    code: string
  ): Promise<PairingResult> {
    // First check if user is already allowed
    const existingUser = this.userRepo.findByChannelUserId(channel.id, userId);
    if (existingUser?.allowed) {
      return { success: true, user: existingUser };
    }

    // Brute-force protection: Check if user is locked out due to too many failed attempts
    if (existingUser && existingUser.pairingAttempts >= SecurityManager.MAX_PAIRING_ATTEMPTS) {
      // Check if lockout period has passed (use pairingExpiresAt as lockout timestamp)
      const lockoutUntil = existingUser.pairingExpiresAt;
      if (lockoutUntil && Date.now() < lockoutUntil) {
        const remainingMinutes = Math.ceil((lockoutUntil - Date.now()) / 60000);
        return {
          success: false,
          error: `Too many failed attempts. Please wait ${remainingMinutes} minute(s) before trying again.`,
        };
      }
      // Lockout expired - reset attempts
      this.userRepo.update(existingUser.id, {
        pairingAttempts: 0,
        pairingExpiresAt: undefined,
      });
    }

    // Look up the pairing code across all users in the channel
    const codeOwner = this.userRepo.findByPairingCode(channel.id, code.toUpperCase());

    if (!codeOwner) {
      // Code not found - increment attempts on the requesting user if they exist
      if (existingUser) {
        const newAttempts = existingUser.pairingAttempts + 1;
        const updates: { pairingAttempts: number; pairingExpiresAt?: number } = {
          pairingAttempts: newAttempts,
        };
        // Set lockout timestamp if max attempts reached
        if (newAttempts >= SecurityManager.MAX_PAIRING_ATTEMPTS) {
          updates.pairingExpiresAt = Date.now() + SecurityManager.PAIRING_LOCKOUT_MS;
        }
        this.userRepo.update(existingUser.id, updates);

        // Warn user about remaining attempts
        const remaining = SecurityManager.MAX_PAIRING_ATTEMPTS - newAttempts;
        if (remaining > 0) {
          return { success: false, error: `Invalid pairing code. ${remaining} attempt(s) remaining.` };
        } else {
          return { success: false, error: 'Too many failed attempts. Please wait 15 minutes before trying again.' };
        }
      }
      return { success: false, error: 'Invalid pairing code' };
    }

    // Check expiration
    if (codeOwner.pairingExpiresAt && Date.now() > codeOwner.pairingExpiresAt) {
      // Clear expired code
      this.userRepo.update(codeOwner.id, {
        pairingCode: undefined,
        pairingExpiresAt: undefined,
      });
      return { success: false, error: 'Pairing code has expired. Please request a new one.' };
    }

    // Code is valid! Grant access to the requesting user
    if (existingUser) {
      // Update existing user to be allowed
      this.userRepo.update(existingUser.id, {
        allowed: true,
        pairingCode: undefined,
        pairingExpiresAt: undefined,
        pairingAttempts: 0,
      });
      // Clear the code from wherever it was stored
      if (codeOwner.id !== existingUser.id) {
        this.userRepo.update(codeOwner.id, {
          pairingCode: undefined,
          pairingExpiresAt: undefined,
        });
      }
      return { success: true, user: { ...existingUser, allowed: true } };
    } else {
      // This shouldn't happen since checkAccess creates the user, but handle it
      return { success: false, error: 'User record not found' };
    }
  }

  /**
   * Revoke a user's access
   */
  revokeAccess(channelId: string, userId: string): void {
    const user = this.userRepo.findByChannelUserId(channelId, userId);
    if (user) {
      this.userRepo.update(user.id, { allowed: false });
    }
  }

  /**
   * Grant a user access directly (for allowlist management)
   */
  grantAccess(channelId: string, userId: string, displayName?: string): void {
    let user = this.userRepo.findByChannelUserId(channelId, userId);

    if (user) {
      this.userRepo.update(user.id, { allowed: true });
    } else if (displayName) {
      this.userRepo.create({
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
  getChannelUsers(channelId: string): ChannelUser[] {
    // Cleanup expired pending entries first
    this.cleanupExpiredPending(channelId);
    return this.userRepo.findByChannelId(channelId);
  }

  /**
   * Cleanup expired pending pairing entries for a channel
   * These are placeholder entries created when generating pairing codes that have expired
   * Returns the number of deleted entries
   */
  cleanupExpiredPending(channelId: string): number {
    return this.userRepo.deleteExpiredPending(channelId);
  }

  /**
   * Get allowed users for a channel
   */
  getAllowedUsers(channelId: string): ChannelUser[] {
    return this.userRepo.findAllowedByChannelId(channelId);
  }

  // Private methods

  /**
   * Create a random pairing code
   */
  private createPairingCode(): string {
    // Generate 6-character alphanumeric code
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Exclude similar chars (I, O, 1, 0)
    let code = '';
    const randomBytes = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) {
      code += chars[randomBytes[i] % chars.length];
    }
    return code;
  }
}
