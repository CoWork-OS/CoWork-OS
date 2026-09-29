/**
 * Session Manager
 *
 * Manages channel sessions linking chats to CoWork tasks.
 */

import { ChannelSessionRepository } from "../database/repository-facades";
import type Database from "better-sqlite3";
import { ChannelSession, Channel } from "../database/repositories";

export class SessionManager {
  private sessionRepo: ChannelSessionRepository;

  constructor(db: Database.Database) {
    this.sessionRepo = new ChannelSessionRepository(db);
  }

  /**
   * Get or create a session for a chat
   */
  async getOrCreateSession(
    channel: Channel,
    chatId: string,
    userId?: string,
    defaultWorkspaceId?: string,
  ): Promise<ChannelSession> {
    // The existing session with its activity touched, or a new one, in one unit.
    return await this.sessionRepo.findOrCreateByChat({
      channelId: channel.id,
      chatId,
      userId,
      workspaceId: defaultWorkspaceId,
      state: "idle",
    });
  }

  /**
   * Get session by ID
   */
  async getSession(sessionId: string): Promise<ChannelSession | undefined> {
    return this.sessionRepo.findById(sessionId);
  }

  /**
   * Get session by task ID
   */
  async getSessionByTaskId(taskId: string): Promise<ChannelSession | undefined> {
    return this.sessionRepo.findByTaskId(taskId);
  }

  /**
   * Update session state
   */
  async updateSessionState(
    sessionId: string,
    state: "idle" | "active" | "waiting_approval",
  ): Promise<void> {
    await this.sessionRepo.update(sessionId, {
      state,
      lastActivityAt: Date.now(),
    });
  }

  /**
   * Link a session to a task
   */
  async linkSessionToTask(sessionId: string, taskId: string): Promise<void> {
    await this.sessionRepo.update(sessionId, {
      taskId,
      state: "active",
      lastActivityAt: Date.now(),
    });
  }

  /**
   * Unlink session from task
   */
  async unlinkSessionFromTask(sessionId: string): Promise<void> {
    await this.sessionRepo.update(sessionId, {
      taskId: undefined,
      state: "idle",
      lastActivityAt: Date.now(),
    });
  }

  /**
   * Set session workspace
   */
  async setSessionWorkspace(sessionId: string, workspaceId: string): Promise<void> {
    await this.sessionRepo.update(sessionId, {
      workspaceId,
      lastActivityAt: Date.now(),
    });
  }

  /**
   * Update session context
   */
  async updateSessionContext(sessionId: string, context: Record<string, unknown>): Promise<void> {
    // `update` merges the context into the stored one within its own unit.
    await this.sessionRepo.update(sessionId, {
      context,
      lastActivityAt: Date.now(),
    });
  }

  /**
   * Get active sessions for a channel
   */
  async getActiveSessions(channelId: string): Promise<ChannelSession[]> {
    return this.sessionRepo.findActiveByChannelId(channelId);
  }

  /**
   * Clean up old idle sessions
   */
  async cleanupOldSessions(maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<void> {
    const cutoff = Date.now() - Math.max(0, maxAgeMs);
    const removed = await this.sessionRepo.deleteIdleOlderThan(cutoff);
    if (removed > 0) {
      console.log(`[SessionManager] Cleaned up ${removed} stale idle sessions`);
    }
  }
}
