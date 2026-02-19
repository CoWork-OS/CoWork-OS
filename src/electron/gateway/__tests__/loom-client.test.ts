import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { LoomEmailClient } from '../channels/loom-client';

function createMockResponse(opts: {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  statusText?: string;
} = {}): Response {
  const status = opts.status ?? 200;
  const bodyText =
    opts.body === undefined || opts.body === null
      ? ''
      : (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: opts.statusText ?? '',
    headers: new Headers(opts.headers),
    text: vi.fn().mockResolvedValue(bodyText),
  } as unknown as Response;
}

describe('LoomEmailClient', () => {
  const originalFetch = global.fetch;
  const tempDirs: string[] = [];

  const createStatePath = (): string => {
    const dir = mkdtempSync(path.join(tmpdir(), 'loom-client-state-'));
    tempDirs.push(dir);
    return path.join(dir, 'state.json');
  };

  beforeEach(() => {
    vi.useFakeTimers();
    global.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    global.fetch = originalFetch;
    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup failures.
      }
    }
  });

  it('rejects insecure non-localhost base URLs', () => {
    expect(() => new LoomEmailClient({
      baseUrl: 'http://example.com',
      accessTokenProvider: () => 'token',
      folder: 'INBOX',
      pollInterval: 1000,
    })).toThrow('LOOM base URL must use HTTPS');
  });

  it('rejects mailbox folders with traversal', () => {
    expect(() => new LoomEmailClient({
      baseUrl: 'https://loom.example.com',
      accessTokenProvider: () => 'token',
      folder: 'INBOX/../Work',
      pollInterval: 1000,
    })).toThrow('LOOM mailbox folder contains invalid characters');
  });

  it('accepts standard mailbox path with slash separators', async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(createMockResponse({
      body: { threads: [] },
    }));

    const client = new LoomEmailClient({
      baseUrl: 'https://loom.example.com',
      accessTokenProvider: () => 'token',
      folder: 'INBOX/Work',
      pollInterval: 1000,
    });

    await client.fetchUnreadEmails(1);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = String(fetchMock.mock.calls[0]?.[0] || '');
    expect(calledUrl).toContain('/v1/gateway/imap/folders/INBOX%2FWork/messages');
  });

  it('fetches exactly the requested unread limit from LOOM folder', async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(createMockResponse({
      body: {
        messages: [
          { uid: 1, thread_id: 'thread-a', message_id: '<a@loom>', mailbox_state: { seen: true }, subject: 'Read Message' },
        { uid: 2, thread_id: 'thread-b', message_id: '<b@loom>', mailbox_state: { seen: false }, subject: 'Unread Message' },
        { uid: 3, thread_id: 'thread-c', message_id: '<c@loom>', mailbox_state: { seen: false }, subject: 'Unread Message 2' },
          { uid: 4, thread_id: 'thread-d', message_id: '<d@loom>', mailbox_state: { seen: false }, subject: 'Unread Message 3' },
        ],
      },
    }));

    const client = new LoomEmailClient({
      baseUrl: 'https://loom.example.com',
      accessTokenProvider: () => 'token',
      folder: 'INBOX',
      pollInterval: 1000,
    });

    await client.fetchUnreadEmails(2);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = String(fetchMock.mock.calls[0]?.[0] || '');
    expect(calledUrl).toContain('/v1/gateway/imap/folders/INBOX/messages?limit=2');
  });

  it('allows localhost HTTP and maps unread messages for markAsRead', async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(createMockResponse({
        body: {
          messages: [
            { uid: 1, thread_id: 'thread-a', message_id: '<a@loom>', mailbox_state: { seen: false }, subject: 'A' },
            { uid: 2, thread_id: 'thread-b', message_id: '<b@loom>', mailbox_state: { seen: true }, subject: 'B' },
            { uid: 3, thread_id: 'thread-c', message_id: '<c@loom>', mailbox_state: { seen: false }, subject: 'C' },
          ],
        },
      }))
      .mockResolvedValueOnce(createMockResponse({ status: 204 }));

    const client = new LoomEmailClient({
      baseUrl: 'http://127.0.0.1:8787',
      accessTokenProvider: () => 'token',
      folder: 'INBOX',
      pollInterval: 1000,
    });

    const unread = await client.fetchUnreadEmails(2);
    expect(unread).toHaveLength(2);
    expect(unread.every((m) => m.isRead === false)).toBe(true);

    await client.markAsRead(unread[0].uid);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toContain('/v1/mailbox/threads/thread-a/state');
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'PATCH' });
  });

  it('pollMailbox emits only unread new messages and deduplicates', async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const mailboxPayload = {
      messages: [
        { uid: 11, thread_id: 'thread-11', message_id: '<m11@loom>', mailbox_state: { seen: false }, subject: 'unread-1', date: '2025-01-01T00:00:00Z' },
        { uid: 12, thread_id: 'thread-12', message_id: '<m12@loom>', mailbox_state: { seen: true }, subject: 'read-should-skip', date: '2025-01-01T00:01:00Z' },
        { uid: 13, thread_id: 'thread-13', message_id: '<m13@loom>', mailbox_state: { seen: false }, subject: 'unread-2', date: '2025-01-01T00:02:00Z' },
      ],
    };

    fetchMock
      .mockResolvedValueOnce(createMockResponse({ body: mailboxPayload }))
      .mockResolvedValueOnce(createMockResponse({ body: mailboxPayload }));

    const client = new LoomEmailClient({
      baseUrl: 'http://localhost:8787',
      accessTokenProvider: () => 'token',
      folder: 'INBOX',
      pollInterval: 1000,
    });

    const onMessage = vi.fn();
    client.on('message', onMessage);

    await client.startReceiving();
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onMessage.mock.calls[0]?.[0]?.subject).toBe('unread-1');
    expect(onMessage.mock.calls[1]?.[0]?.subject).toBe('unread-2');

    await vi.advanceTimersByTimeAsync(1000);
    expect(onMessage).toHaveBeenCalledTimes(2);

    await client.stopReceiving();
  });

  it('deduplicates messages without provider IDs using deterministic fallback IDs', async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const payload = {
      messages: [
        {
          thread_id: 'fallback-thread-1',
          from: 'Alice <alice@example.com>',
          to: ['bob@example.com'],
          subject: 'Fallback identity',
          body_text: 'same body',
          date: '2025-01-01T00:00:00Z',
          mailbox_state: { seen: false },
        },
      ],
    };

    fetchMock
      .mockResolvedValueOnce(createMockResponse({ body: payload }))
      .mockResolvedValueOnce(createMockResponse({ body: payload }));

    const client = new LoomEmailClient({
      baseUrl: 'http://localhost:8787',
      accessTokenProvider: () => 'token',
      folder: 'INBOX',
      pollInterval: 1000,
    });

    const onMessage = vi.fn();
    client.on('message', onMessage);

    await client.startReceiving();
    expect(onMessage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(onMessage).toHaveBeenCalledTimes(1);

    await client.stopReceiving();
  });

  it('persists dedupe state to disk and restores it on restart', async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const payload = {
      messages: [
        {
          thread_id: 'fallback-thread-restore',
          from: 'Alice <alice@example.com>',
          to: ['bob@example.com'],
          subject: 'Restore test',
          body_text: 'same body for restore',
          date: '2025-01-03T00:00:00Z',
          mailbox_state: { seen: false },
        },
      ],
    };

    fetchMock
      .mockResolvedValueOnce(createMockResponse({ body: payload }))
      .mockResolvedValueOnce(createMockResponse({ body: payload }));

    const stateFilePath = createStatePath();
    const clientA = new LoomEmailClient({
      baseUrl: 'http://localhost:8787',
      accessTokenProvider: () => 'token',
      folder: 'INBOX',
      pollInterval: 1000,
      stateFilePath,
    });

    const unreadA = await clientA.fetchUnreadEmails(10);
    expect(unreadA).toHaveLength(1);
    await vi.runAllTimersAsync();

    const stateText = readFileSync(stateFilePath, 'utf8');
    const state = JSON.parse(stateText);
    expect(state.seenMessageIds).toContain(unreadA[0].messageId);
    expect(Array.isArray(state.threadByUid)).toBe(true);
    expect(state.nextSyntheticUid).toBeGreaterThanOrEqual(1_000_000);

    const clientB = new LoomEmailClient({
      baseUrl: 'http://localhost:8787',
      accessTokenProvider: () => 'token',
      folder: 'INBOX',
      pollInterval: 1000,
      stateFilePath,
    });

    const unreadB = await clientB.fetchUnreadEmails(10);
    expect(unreadB).toHaveLength(0);
  });

  it('maps fallback synthetic uid to thread id when marking as read', async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;

    const payload = {
      messages: [
        {
          thread_id: 'thread-fallback-mark-read',
          from: 'alice@example.com',
          subject: 'Needs synthetic uid',
          body_text: 'body',
          date: '2025-01-02T00:00:00Z',
          mailbox_state: { seen: false },
        },
      ],
    };

    fetchMock
      .mockResolvedValueOnce(createMockResponse({ body: payload }))
      .mockResolvedValueOnce(createMockResponse({ status: 204 }));

    const client = new LoomEmailClient({
      baseUrl: 'http://127.0.0.1:8787',
      accessTokenProvider: () => 'token',
      folder: 'INBOX',
      pollInterval: 1000,
    });

    const unread = await client.fetchUnreadEmails(10);
    expect(unread).toHaveLength(1);

    await client.markAsRead(unread[0].uid);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toContain('/v1/mailbox/threads/thread-fallback-mark-read/state');
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'PATCH' });
  });

  it('includes HTTP status details in LOOM request errors', async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      createMockResponse({ status: 403, statusText: 'Forbidden', body: 'denied' })
    );

    const client = new LoomEmailClient({
      baseUrl: 'https://loom.example.com',
      accessTokenProvider: () => 'token',
      folder: 'INBOX',
      pollInterval: 1000,
    });

    await expect(client.fetchUnreadEmails(5)).rejects.toThrow('LOOM request failed (403): denied');
  });
});
