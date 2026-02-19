/**
 * LOOM Email Client
 *
 * Bridges CoWork Email channel behavior to a LOOM node using:
 * - GET /v1/gateway/imap/folders/{folder}/messages
 * - POST /v1/gateway/smtp/submit
 * - PATCH /v1/mailbox/threads/{id}/state
 *
 * Uses bearer auth provided by the configured LOOM access token.
 */

import { EventEmitter } from 'events';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { EmailAddress, EmailMessage } from './email-client';
import { assertSafeLoomBaseUrl, assertSafeLoomMailboxFolder, normalizeLoomBaseUrl } from '../../utils/loom';

interface LoomMailboxMessage {
  uid?: number;
  envelope_id?: string;
  thread_id?: string;
  subject?: string;
  from?: string;
  from_email?: string;
  to?: unknown[];
  date?: string;
  message_id?: string;
  in_reply_to?: string;
  body_text?: string;
  mailbox_state?: {
    seen?: boolean;
  };
  headers?: Record<string, unknown>;
}

interface LoomFolderMessagesResponse {
  folder?: string;
  messages?: LoomMailboxMessage[];
}

interface LoomSmtpSubmitResponse {
  envelope_id?: string;
  thread_id?: string;
  message_id?: string;
}

export interface LoomEmailClientOptions {
  baseUrl: string;
  accessTokenProvider: () => string | Promise<string>;
  identity?: string;
  folder: string;
  pollInterval: number;
  verbose?: boolean;
  stateFilePath?: string;
}

interface LoomRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH';
  body?: unknown;
  idempotencyKey?: string;
}

export class LoomEmailClient extends EventEmitter {
  private readonly baseUrl: URL;
  private readonly accessTokenProvider: () => string | Promise<string>;
  private readonly folder: string;
  private readonly identity?: string;
  private readonly pollInterval: number;
  private connected = false;
  private pollInFlight = false;
  private pollTimer?: NodeJS.Timeout;
  private seenMessageIds = new Set<string>();
  private seenOrder: string[] = [];
  private readonly MAX_SEEN_CACHE = 2000;
  private threadByUid = new Map<number, string>();
  private nextSyntheticUid = 1_000_000;
  private readonly persistedStateVersion = 1;
  private readonly stateFilePath?: string;
  private persistStateTimer?: NodeJS.Timeout;
  private readonly STATE_WRITE_DELAY_MS = 250;
  private readonly MAX_THREAD_MAP_SIZE = 2000;

  constructor(options: LoomEmailClientOptions) {
    super();
    const parsedBaseUrl = assertSafeLoomBaseUrl(options.baseUrl);
    this.baseUrl = normalizeLoomBaseUrl(parsedBaseUrl);

    if (typeof options.accessTokenProvider !== 'function') {
      throw new Error('LOOM access token is required');
    }

    this.accessTokenProvider = options.accessTokenProvider;

    this.folder = assertSafeLoomMailboxFolder(options.folder);
    this.pollInterval = Math.max(1000, Number(options.pollInterval || 30000));
    this.identity = options.identity;
    this.stateFilePath = options.stateFilePath ? String(options.stateFilePath) : undefined;
    this.loadPersistedState();
  }

  async checkConnection(): Promise<{ success: boolean; email?: string; error?: string }> {
    try {
      await this.request<{ threads?: unknown[] }>('/v1/threads');
      return { success: true, email: this.getEmail() };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async startReceiving(): Promise<void> {
    if (this.connected) return;

    this.connected = true;
    this.emit('connected');

    await this.pollMailbox();
    this.pollTimer = setInterval(() => {
      void this.pollMailbox();
    }, this.pollInterval);
  }

  async stopReceiving(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.persistStateTimer) {
      clearTimeout(this.persistStateTimer);
      this.persistStateTimer = undefined;
      this.persistState();
    }
    this.connected = false;
    this.pollInFlight = false;
    this.threadByUid.clear();
    this.emit('disconnected');
  }

  private loadPersistedState(): void {
    if (!this.stateFilePath) return;

    try {
      const raw = readFileSync(this.stateFilePath, 'utf8');
      const parsed = JSON.parse(raw);

      if (!parsed || typeof parsed !== 'object') return;
      if (typeof parsed.version === 'number' && parsed.version > this.persistedStateVersion) return;

      if (Array.isArray(parsed.seenMessageIds)) {
        for (const rawId of parsed.seenMessageIds) {
          if (typeof rawId !== 'string' || !rawId.trim()) continue;
          this.seenMessageIds.add(rawId);
          this.seenOrder.push(rawId);
        }
      }

      if (Array.isArray(parsed.seenOrder)) {
        for (const rawId of parsed.seenOrder) {
          if (typeof rawId !== 'string' || !rawId.trim() || this.seenMessageIds.has(rawId)) continue;
          this.seenMessageIds.add(rawId);
          this.seenOrder.push(rawId);
        }
      }

      if (Array.isArray(parsed.threadByUid)) {
        for (const entry of parsed.threadByUid) {
          if (!Array.isArray(entry) || entry.length < 2) continue;
          const [rawUid, rawThreadId] = entry;
          const uid = Number(rawUid);
          if (!Number.isFinite(uid) || uid <= 0) continue;
          if (typeof rawThreadId !== 'string' || !rawThreadId.trim()) continue;
          this.threadByUid.set(uid, rawThreadId);
        }
      } else if (parsed.threadByUid && typeof parsed.threadByUid === 'object') {
        for (const [rawUid, rawThreadId] of Object.entries(parsed.threadByUid)) {
          const uid = Number(rawUid);
          if (!Number.isFinite(uid) || uid <= 0) continue;
          if (typeof rawThreadId !== 'string' || !rawThreadId.trim()) continue;
          this.threadByUid.set(uid, rawThreadId);
        }
      }

      if (Number.isFinite(parsed.nextSyntheticUid)) {
        this.nextSyntheticUid = Math.max(this.nextSyntheticUid, Math.floor(Number(parsed.nextSyntheticUid)));
      }

      this.pruneInMemoryState();
      this.pruneThreadMap();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[LoomEmailClient] Failed to load persisted state:', error);
      }
    }
  }

  private persistState(): void {
    if (!this.stateFilePath) return;

    try {
      const directory = path.dirname(this.stateFilePath);
      mkdirSync(directory, { recursive: true });

      const payload = {
        version: this.persistedStateVersion,
        seenMessageIds: Array.from(this.seenMessageIds),
        seenOrder: this.seenOrder,
        threadByUid: Array.from(this.threadByUid.entries()),
        nextSyntheticUid: this.nextSyntheticUid,
      };

      const tempPath = `${this.stateFilePath}.tmp`;
      writeFileSync(tempPath, JSON.stringify(payload), 'utf8');
      renameSync(tempPath, this.stateFilePath);
    } catch (error) {
      console.warn('[LoomEmailClient] Failed to persist state:', error);
    }
  }

  private schedulePersistState(): void {
    if (!this.stateFilePath) return;
    if (this.persistStateTimer) {
      clearTimeout(this.persistStateTimer);
    }
    this.persistStateTimer = setTimeout(() => {
      this.persistState();
      this.persistStateTimer = undefined;
    }, this.STATE_WRITE_DELAY_MS);
  }

  private pruneInMemoryState(): void {
    while (this.seenOrder.length > this.MAX_SEEN_CACHE) {
      const oldest = this.seenOrder.shift();
      if (oldest) this.seenMessageIds.delete(oldest);
    }
  }

  private pruneThreadMap(): void {
    if (this.threadByUid.size <= this.MAX_THREAD_MAP_SIZE) return;

    const entries = Array.from(this.threadByUid.entries());
    this.threadByUid.clear();
    for (const [uid, threadId] of entries.slice(-this.MAX_THREAD_MAP_SIZE)) {
      this.threadByUid.set(uid, threadId);
    }
  }

  async fetchUnreadEmails(limit: number): Promise<EmailMessage[]> {
    const cappedLimit = Math.max(1, Math.min(Number(limit || 20), 100));
    const mailboxMessages = await this.fetchFolderMessages(this.folder, cappedLimit);
    const unread = mailboxMessages.filter((message) => message?.mailbox_state?.seen !== true);
    const unseen: EmailMessage[] = [];

    for (const message of unread.slice(0, cappedLimit)) {
      const messageId = this.resolveMessageId(message);
      if (this.seenMessageIds.has(messageId)) {
        continue;
      }

      this.rememberSeenMessage(messageId);
      unseen.push(this.toEmailMessage(message, true));
    }

    return unseen;
  }

  async sendEmail(options: {
    to: string;
    subject: string;
    text: string;
    inReplyTo?: string;
    references?: string[];
  }): Promise<string> {
    const headers: Record<string, string> = {};
    if (options.inReplyTo) headers['In-Reply-To'] = options.inReplyTo;
    if (options.references && options.references.length > 0) {
      headers.References = options.references.join(' ');
    }

    const payload: Record<string, unknown> = {
      to: [options.to],
      subject: options.subject,
      text: options.text,
    };

    if (Object.keys(headers).length > 0) {
      payload.headers = headers;
    }

    const submitted = await this.request<LoomSmtpSubmitResponse>('/v1/gateway/smtp/submit', {
      method: 'POST',
      body: payload,
      idempotencyKey: this.buildIdempotencyKey(),
    });

    return (
      (typeof submitted.message_id === 'string' && submitted.message_id) ||
      (typeof submitted.envelope_id === 'string' && submitted.envelope_id) ||
      `loom-${Date.now()}`
    );
  }

  async markAsRead(uid: number): Promise<void> {
    const threadId = this.threadByUid.get(uid);
    if (!threadId) return;

    await this.request(`/v1/mailbox/threads/${encodeURIComponent(threadId)}/state`, {
      method: 'PATCH',
      body: { seen: true },
    });
  }

  getEmail(): string {
    return this.identity || 'loom://identity@local';
  }

  private async pollMailbox(): Promise<void> {
    if (!this.connected || this.pollInFlight) return;
    this.pollInFlight = true;

    try {
      const messages = await this.fetchFolderMessages(this.folder, 200);
      const unreadMessages = messages.filter((message) => message?.mailbox_state?.seen !== true);
      const oldestFirst = [...unreadMessages].sort((a, b) => {
        const aDate = Date.parse(String(a.date || ''));
        const bDate = Date.parse(String(b.date || ''));
        if (Number.isNaN(aDate) && Number.isNaN(bDate)) return 0;
        if (Number.isNaN(aDate)) return -1;
        if (Number.isNaN(bDate)) return 1;
        return aDate - bDate;
      });

      for (const message of oldestFirst) {
        const messageId = this.resolveMessageId(message);
        if (this.seenMessageIds.has(messageId)) continue;

        this.rememberSeenMessage(messageId);
        const parsed = this.toEmailMessage(message, true);
        this.emit('message', parsed);
      }
    } catch (error) {
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.pollInFlight = false;
    }
  }

  private async fetchFolderMessages(folder: string, limit: number): Promise<LoomMailboxMessage[]> {
    const normalizedFolder = encodeURIComponent(assertSafeLoomMailboxFolder(folder));
    const cappedLimit = Math.max(1, Math.min(Number(limit || 100), 500));
    const response = await this.request<LoomFolderMessagesResponse>(
      `/v1/gateway/imap/folders/${normalizedFolder}/messages?limit=${cappedLimit}`
    );
    return Array.isArray(response.messages) ? response.messages : [];
  }

  private toEmailMessage(message: LoomMailboxMessage, trackUid: boolean): EmailMessage {
    const headers = this.toHeadersMap(message.headers);
    const messageId = this.resolveMessageId(message);
    const fromAddress = this.resolveFromAddress(message);
    const toAddresses = this.resolveToAddresses(message.to);
    const subject = String(message.subject || '(no subject)');
    const text = typeof message.body_text === 'string' ? message.body_text : '';

    let uid = Number(message.uid);
    if (!Number.isFinite(uid) || uid <= 0) {
      uid = this.nextSyntheticUid++;
    }

    const threadId = typeof message.thread_id === 'string' ? message.thread_id : '';
    if (trackUid && threadId) {
      this.threadByUid.set(uid, threadId);
      this.pruneThreadMap();
      this.schedulePersistState();
    }

    const inReplyTo =
      (typeof message.in_reply_to === 'string' && message.in_reply_to) ||
      headers.get('in-reply-to') ||
      undefined;

    const references = this.parseReferences(headers.get('references'));

    return {
      messageId,
      uid,
      from: fromAddress,
      to: toAddresses,
      subject,
      text,
      date: this.parseDate(message.date),
      inReplyTo,
      references,
      attachments: [],
      isRead: message.mailbox_state?.seen === true,
      headers,
    };
  }

  private toHeadersMap(value: unknown): Map<string, string> {
    const map = new Map<string, string>();
    if (!value || typeof value !== 'object') return map;

    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (typeof raw === 'string') {
        map.set(key.toLowerCase(), raw);
      } else if (raw != null) {
        map.set(key.toLowerCase(), String(raw));
      }
    }

    return map;
  }

  private parseReferences(raw: string | undefined): string[] | undefined {
    if (!raw) return undefined;
    const matches = raw.match(/<[^>]+>/g);
    if (matches && matches.length > 0) return matches;

    const parts = raw
      .split(/\s+/)
      .map((part) => part.trim())
      .filter(Boolean);
    return parts.length > 0 ? parts : undefined;
  }

  private parseDate(raw: unknown): Date {
    const parsed = Date.parse(String(raw || ''));
    return Number.isNaN(parsed) ? new Date() : new Date(parsed);
  }

  private resolveMessageId(message: LoomMailboxMessage): string {
    if (typeof message.message_id === 'string' && message.message_id.trim()) {
      return message.message_id.trim();
    }
    if (typeof message.envelope_id === 'string' && message.envelope_id.trim()) {
      return `<${message.envelope_id.trim()}@loom>`;
    }
    return this.resolveMessageFallbackId(message);
  }

  private resolveMessageFallbackId(message: LoomMailboxMessage): string {
    const toSeed = Array.isArray(message.to)
      ? message.to
          .map((entry) => (typeof entry === 'string' ? entry : String(entry || '').trim()))
          .filter(Boolean)
          .sort()
          .join(',')
      : '';

    const seed = [
      message.thread_id || '',
      message.uid || '',
      message.from || '',
      message.from_email || '',
      message.subject || '',
      message.date || '',
      toSeed,
      (message.body_text || '').slice(0, 1024),
      message.in_reply_to || '',
      (typeof message.mailbox_state?.seen === 'boolean' ? String(message.mailbox_state.seen) : ''),
    ]
      .join('\n')
      .toLowerCase()
      .trim();

    const hash = createHash('sha256').update(seed).digest('hex').slice(0, 16);
    return `<loom-fallback-${hash}@loom>`;
  }

  private resolveFromAddress(message: LoomMailboxMessage): EmailAddress {
    const identity = typeof message.from === 'string' ? message.from : '';
    const address =
      (typeof message.from_email === 'string' && message.from_email.trim()) ||
      this.inferEmailFromIdentity(identity) ||
      'unknown@loom.local';

    return {
      name: identity || address,
      address,
    };
  }

  private resolveToAddresses(to: unknown): EmailAddress[] {
    if (!Array.isArray(to)) return [];
    return to
      .map((entry) => {
        const identity = typeof entry === 'string' ? entry : '';
        const address = this.inferEmailFromIdentity(identity);
        if (!address) return null;
        return {
          name: identity || address,
          address,
        } as EmailAddress;
      })
      .filter((entry): entry is EmailAddress => Boolean(entry));
  }

  private inferEmailFromIdentity(identity: string): string | null {
    const normalized = String(identity || '').trim();
    if (!normalized) return null;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return normalized;

    const loomPrefix = normalized.match(/^loom:\/\/([^/]+)$/i);
    if (loomPrefix && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(loomPrefix[1])) {
      return loomPrefix[1];
    }

    const bridgePrefix = normalized.match(/^bridge:\/\/(.+)$/i);
    if (bridgePrefix && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bridgePrefix[1])) {
      return bridgePrefix[1];
    }

    return null;
  }

  private rememberSeenMessage(messageId: string): void {
    this.seenMessageIds.add(messageId);
    this.seenOrder.push(messageId);
    while (this.seenOrder.length > this.MAX_SEEN_CACHE) {
      const oldest = this.seenOrder.shift();
      if (oldest) this.seenMessageIds.delete(oldest);
    }
    this.schedulePersistState();
  }

  private buildIdempotencyKey(): string {
    return `cowork-loom-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  private async request<T = unknown>(path: string, options: LoomRequestOptions = {}): Promise<T> {
    const tokenValue = await Promise.resolve(this.accessTokenProvider());
    const token = typeof tokenValue === 'string' ? tokenValue.trim() : '';
    if (!token) {
      throw new Error('LOOM access token is required');
    }

    const method = options.method || 'GET';
    const url = new URL(path.startsWith('/') ? path : `/${path}`, this.baseUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const headers: Record<string, string> = {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      };

      if (options.idempotencyKey) {
        headers['Idempotency-Key'] = options.idempotencyKey;
      }

      let body: string | undefined;
      if (options.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(options.body);
      }

      const response = await fetch(url.toString(), {
        method,
        headers,
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        const errorDetail = text || response.statusText;
        throw new Error(`LOOM request failed (${response.status}): ${errorDetail}`);
      }

      if (response.status === 204) {
        return undefined as T;
      }

      const text = await response.text();
      if (!text) {
        return undefined as T;
      }

      try {
        return JSON.parse(text) as T;
      } catch {
        throw new Error(`LOOM request returned invalid JSON (${response.status}): ${method} ${url.pathname}`);
      }
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') {
        throw new Error(`LOOM request timed out: ${method} ${path}`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
