/**
 * Session Manager
 *
 * Manages channel sessions linking chats to CoWork tasks.
 */

import Database from 'better-sqlite3';
import {
  ChannelSessionRepository,
  ChannelSession,
  Channel,
} from '../database/repositories';

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
    defaultWorkspaceId?: string
  ): Promise<ChannelSession> {
    // Look for existing session
    let session = this.sessionRepo.findByChatId(channel.id, chatId);

    if (session) {
      // Update last activity
      this.sessionRepo.update(session.id, {
        lastActivityAt: Date.now(),
      });
      return { ...session, lastActivityAt: Date.now() };
    }

    // Create new session
    session = this.sessionRepo.create({
      channelId: channel.id,
      chatId,
      userId,
      workspaceId: defaultWorkspaceId,
      state: 'idle',
    });

    return session;
  }

  /**
   * Get session by ID
   */
  getSession(sessionId: string): ChannelSession | undefined {
    return this.sessionRepo.findById(sessionId);
  }

  /**
   * Get session by task ID
   */
  getSessionByTaskId(taskId: string): ChannelSession | undefined {
    return this.sessionRepo.findByTaskId(taskId);
  }

  /**
   * Update session state
   */
  updateSessionState(
    sessionId: string,
    state: 'idle' | 'active' | 'waiting_approval'
  ): void {
    this.sessionRepo.update(sessionId, {
      state,
      lastActivityAt: Date.now(),
    });
  }

  /**
   * Link a session to a task
   */
  linkSessionToTask(sessionId: string, taskId: string): void {
    this.sessionRepo.update(sessionId, {
      taskId,
      state: 'active',
      lastActivityAt: Date.now(),
    });
  }

  /**
   * Unlink session from task
   */
  unlinkSessionFromTask(sessionId: string): void {
    this.sessionRepo.update(sessionId, {
      taskId: undefined,
      state: 'idle',
      lastActivityAt: Date.now(),
    });
  }

  /**
   * Set session workspace
   */
  setSessionWorkspace(sessionId: string, workspaceId: string): void {
    this.sessionRepo.update(sessionId, {
      workspaceId,
      lastActivityAt: Date.now(),
    });
  }

  /**
   * Update session context
   */
  updateSessionContext(
    sessionId: string,
    context: Record<string, unknown>
  ): void {
    const session = this.sessionRepo.findById(sessionId);
    if (session) {
      const mergedContext = { ...session.context, ...context };
      this.sessionRepo.update(sessionId, {
        context: mergedContext,
        lastActivityAt: Date.now(),
      });
    }
  }

  /**
   * Get active sessions for a channel
   */
  getActiveSessions(channelId: string): ChannelSession[] {
    return this.sessionRepo.findActiveByChannelId(channelId);
  }

  /**
   * Clean up old idle sessions
   */
  cleanupOldSessions(maxAgeMs: number = 24 * 60 * 60 * 1000): void {
    // This would require a new method in the repository
    // For now, we'll skip automated cleanup
    console.log('Session cleanup not yet implemented');
  }
}
