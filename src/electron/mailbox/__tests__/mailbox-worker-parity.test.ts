import { buildSync } from "esbuild";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DatabaseClient } from "../../database/async/DatabaseClient";
import { DATABASE_COMMANDS, requiredTablesFor } from "../../database/async/commands";
import { DatabaseManager } from "../../database/schema";
import { setStatementClient } from "../../database/statements/statement-route";
import { MailboxAutomationRegistry } from "../MailboxAutomationRegistry";
import { MailboxService } from "../MailboxService";

// The mailbox domain on both backends (async SQLite migration plan, DB6): the same
// workload through the host connection and through the database worker must leave the
// same rows and return the same results.

type Any = any; // oxlint-disable-line typescript/no-explicit-any -- private upsertThread access

const BUILD_DIR = path.resolve("node_modules/.cache/cowork-db-worker-test");
let workerPath: string;

beforeAll(() => {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  workerPath = path.join(BUILD_DIR, `database-worker-mailbox-${process.pid}.js`);
  buildSync({
    entryPoints: [path.resolve("src/electron/database/async/database-worker.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile: workerPath,
    external: ["better-sqlite3", "electron"],
    logLevel: "silent",
  });
});

afterAll(() => {
  fs.rmSync(workerPath, { force: true });
});

// Fixture times only; the compared columns never hold the wall clock.
const NOW = Date.now();
const ACCOUNT_ID = "gmail:test@example.com";

function thread(
  id: string,
  options: { subject: string; category: string; needsReply: boolean; unread: boolean; at: number },
) {
  return {
    id,
    accountId: ACCOUNT_ID,
    provider: "gmail",
    providerThreadId: id.replace("gmail-thread:", ""),
    subject: options.subject,
    snippet: `${options.subject} snippet`,
    participants: [{ email: "sender@vendor.com", name: "Sender" }],
    labels: ["INBOX"],
    category: options.category,
    priorityScore: 40,
    urgencyScore: 20,
    needsReply: options.needsReply,
    staleFollowup: false,
    cleanupCandidate: false,
    handled: false,
    unreadCount: options.unread ? 1 : 0,
    lastMessageAt: options.at,
    messages: [
      {
        id: `${id}:m1`,
        providerMessageId: `${id}:m1`,
        direction: "incoming",
        from: { email: "sender@vendor.com", name: "Sender" },
        to: [{ email: "test@example.com", name: "Test User" }],
        cc: [],
        bcc: [],
        subject: options.subject,
        snippet: `${options.subject} snippet`,
        body: `${options.subject} body text for the search index.`,
        receivedAt: options.at,
        unread: options.unread,
      },
    ],
  };
}

describe("mailbox domain on the host and in the database worker", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  const previousUserDataDir = process.env.COWORK_USER_DATA_DIR;

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    setStatementClient(null, null, null);
    MailboxAutomationRegistry.reset();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    vi.restoreAllMocks();
  });

  async function runWorkload(backend: "host" | "worker") {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cowork-mailbox-${backend}-`));
    process.env.COWORK_USER_DATA_DIR = dir;
    const manager = new DatabaseManager();
    cleanups.push(() => {
      manager.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const db = manager.getDatabase();
    let statementCalls = 0;
    if (backend === "worker") {
      const client = await DatabaseClient.start({
        dbPath: manager.getDatabasePath(),
        requiredTables: requiredTablesFor(DATABASE_COMMANDS),
        workerPath,
      });
      cleanups.push(() => client.close(2_000).then(() => undefined));
      const execute = client.execute.bind(client);
      vi.spyOn(client, "execute").mockImplementation(((name: string, args: unknown) => {
        if (name.startsWith("statements.")) statementCalls += 1;
        return execute(name as Parameters<typeof execute>[0], args as never);
      }) as typeof client.execute);
      setStatementClient("mailbox", manager.getDatabasePath(), client);
    }

    db.prepare(
      `INSERT INTO mailbox_accounts
        (id, provider, address, display_name, status, capabilities_json, sync_cursor, last_synced_at, created_at, updated_at)
       VALUES (?, 'gmail', 'test@example.com', 'Test User', 'connected', '["threads","drafts"]', NULL, ?, ?, ?)`,
    ).run(ACCOUNT_ID, NOW, NOW, NOW);

    const service = new MailboxService(db);
    const usesWorker = (service as Any).sql.usesWorker() as boolean;
    MailboxAutomationRegistry.configure({ db, resolveDefaultWorkspaceId: () => "ws-default" });

    await (service as Any).upsertThread(
      thread("gmail-thread:alpha", {
        subject: "Invoice for September",
        category: "priority",
        needsReply: true,
        unread: true,
        at: NOW - 60_000,
      }),
    );
    await (service as Any).upsertThread(
      thread("gmail-thread:beta", {
        subject: "Weekly newsletter",
        category: "updates",
        needsReply: false,
        unread: false,
        at: NOW - 120_000,
      }),
    );
    // A second sync of the same thread updates it in place.
    await (service as Any).upsertThread(
      thread("gmail-thread:alpha", {
        subject: "Invoice for September",
        category: "priority",
        needsReply: true,
        unread: false,
        at: NOW - 30_000,
      }),
    );

    const inbox = await service.listThreads({ mailboxView: "inbox", limit: 20 });
    const unread = await service.listThreads({ mailboxView: "inbox", unreadOnly: true, limit: 20 });
    const status = await service.getSyncStatus();

    const forward = await MailboxAutomationRegistry.createForward({
      name: "Forward invoices",
      schedule: { kind: "every", everyMs: 15 * 60 * 1000 },
      targetEmail: "ops@example.com",
      allowedSenders: ["Sender@Vendor.com"],
      allowedDomains: [],
    });
    const updated = await MailboxAutomationRegistry.updateForward(forward.id, {
      subjectKeywords: ["invoice"],
    });
    const listed = await MailboxAutomationRegistry.listAutomations({ workspaceId: "ws-default" });
    const deleted = await MailboxAutomationRegistry.deleteForward(forward.id);
    const afterDelete = await MailboxAutomationRegistry.listAutomations();

    const rows = {
      threads: db
        .prepare(
          `SELECT id, category, needs_reply, handled, unread_count, message_count, last_message_at,
                  local_inbox_hidden
           FROM mailbox_threads ORDER BY id`,
        )
        .all(),
      messages: db
        .prepare("SELECT id, thread_id, subject, is_unread FROM mailbox_messages ORDER BY id")
        .all(),
      searchRecords: db
        .prepare("SELECT record_type, record_id FROM mailbox_search_embeddings ORDER BY record_id")
        .all(),
      audit: db
        .prepare("SELECT event_type FROM mailbox_automation_audit ORDER BY event_type")
        .all(),
    };

    return {
      usesWorker,
      statementCalls,
      result: {
        inbox: inbox.map((item) => [item.id, item.unreadCount, item.needsReply]),
        unread: unread.map((item) => item.id),
        status: {
          accounts: status.accounts.map((account) => account.id),
          threadCount: status.threadCount,
          unreadCount: status.unreadCount,
          needsReplyCount: status.needsReplyCount,
          proposalCount: status.proposalCount,
          commitmentCount: status.commitmentCount,
          classificationPendingCount: status.classificationPendingCount,
        },
        forward: [forward.kind, forward.status, forward.forward?.allowedSenders],
        updated: updated?.forward?.subjectKeywords,
        listed: listed.map((item) => [item.name, item.kind, item.status]),
        deleted,
        afterDelete: afterDelete.length,
        rows,
      },
    };
  }

  it("returns the same results and leaves the same rows on either backend", async () => {
    const host = await runWorkload("host");
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    MailboxAutomationRegistry.reset();
    const worker = await runWorkload("worker");

    expect(host.usesWorker).toBe(false);
    expect(worker.usesWorker).toBe(true);
    // Every mailbox statement of the workload ran in the worker.
    expect(worker.statementCalls).toBeGreaterThan(20);
    expect(worker.result).toEqual(host.result);
    expect(host.result.inbox.map(([id]) => id)).toEqual([
      "gmail-thread:alpha",
      "gmail-thread:beta",
    ]);
    expect(host.result.deleted).toBe(true);
    expect(host.result.rows.threads).toHaveLength(2);
    expect(host.result.rows.messages).toHaveLength(2);
    expect(host.result.rows.audit.length).toBeGreaterThan(0);
  });

  it("keeps a read-modify-write operation uninterrupted in the worker", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-mailbox-race-"));
    process.env.COWORK_USER_DATA_DIR = dir;
    const manager = new DatabaseManager();
    cleanups.push(() => {
      manager.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const db = manager.getDatabase();
    const client = await DatabaseClient.start({
      dbPath: manager.getDatabasePath(),
      requiredTables: requiredTablesFor(DATABASE_COMMANDS),
      workerPath,
    });
    cleanups.push(() => client.close(2_000).then(() => undefined));
    setStatementClient("mailbox", manager.getDatabasePath(), client);

    db.prepare(
      `INSERT INTO mailbox_accounts
        (id, provider, address, display_name, status, capabilities_json, sync_cursor, last_synced_at, created_at, updated_at)
       VALUES (?, 'gmail', 'test@example.com', 'Test User', 'connected', '["threads","drafts"]', NULL, ?, ?, ?)`,
    ).run(ACCOUNT_ID, NOW, NOW, NOW);
    db.prepare(
      `INSERT INTO workspaces (id, name, path, created_at, last_used_at, permissions)
       VALUES ('ws-race', 'Race', ?, ?, ?, ?)`,
    ).run(
      dir,
      NOW,
      NOW + 1_000_000,
      JSON.stringify({ read: true, write: true, delete: false, network: true, shell: false }),
    );
    const service = new MailboxService(db);
    expect((service as Any).sql.usesWorker()).toBe(true);
    await (service as Any).upsertThread(
      thread("gmail-thread:alpha", {
        subject: "Invoice for September",
        category: "priority",
        needsReply: true,
        unread: true,
        at: NOW,
      }),
    );
    const draft = await service.createMailboxDraft({
      threadId: "gmail-thread:alpha",
      mode: "reply",
      bodyText: "original body",
    });

    // Each update reads the draft, merges its field and writes the whole draft back.
    // Run concurrently, neither may lose the other's field.
    await Promise.all([
      service.updateMailboxDraft(draft.id, { subject: "Updated subject" }),
      service.updateMailboxDraft(draft.id, { bodyText: "Updated body" }),
    ]);
    const stored = await service.getMailboxComposeDraft(draft.id);
    expect(stored?.subject).toBe("Updated subject");
    expect(stored?.bodyText).toBe("Updated body");
  });

  it("syncs a thread in round trips that do not grow with its messages", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-mailbox-batch-"));
    process.env.COWORK_USER_DATA_DIR = dir;
    const manager = new DatabaseManager();
    cleanups.push(() => {
      manager.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const db = manager.getDatabase();
    const client = await DatabaseClient.start({
      dbPath: manager.getDatabasePath(),
      requiredTables: requiredTablesFor(DATABASE_COMMANDS),
      workerPath,
    });
    cleanups.push(() => client.close(2_000).then(() => undefined));
    const execute = client.execute.bind(client);
    const calls: string[] = [];
    vi.spyOn(client, "execute").mockImplementation(((name: string, args: unknown) => {
      if (name.startsWith("statements.")) calls.push(name);
      return execute(name as Parameters<typeof execute>[0], args as never);
    }) as typeof client.execute);
    setStatementClient("mailbox", manager.getDatabasePath(), client);
    db.prepare(
      `INSERT INTO mailbox_accounts
        (id, provider, address, display_name, status, capabilities_json, sync_cursor, last_synced_at, created_at, updated_at)
       VALUES (?, 'gmail', 'test@example.com', 'Test User', 'connected', '["threads","drafts"]', NULL, ?, ?, ?)`,
    ).run(ACCOUNT_ID, NOW, NOW, NOW);
    const service = new MailboxService(db);

    const withMessages = (id: string, count: number) => {
      const base = thread(id, {
        subject: "Quarterly planning",
        category: "priority",
        needsReply: true,
        unread: true,
        at: NOW - 60_000,
      });
      const [message] = base.messages;
      return {
        ...base,
        messages: Array.from({ length: count }, (_value, index) => ({
          ...message,
          id: `${id}:m${index + 1}`,
          providerMessageId: `${id}:m${index + 1}`,
          body: `Message ${index + 1} of the planning thread.`,
          receivedAt: NOW - 60_000 + index,
          attachments: [
            {
              id: `${id}:m${index + 1}:a1`,
              providerAttachmentId: `a${index + 1}`,
              filename: `notes-${index + 1}.txt`,
              mimeType: "text/plain",
              size: 12,
            },
          ],
        })),
      };
    };

    calls.length = 0;
    await (service as Any).upsertThread(withMessages("gmail-thread:small", 1));
    const small = calls.length;
    calls.length = 0;
    await (service as Any).upsertThread(withMessages("gmail-thread:large", 12));
    const large = calls.length;

    // One snapshot and one write unit per thread, plus the per-thread contact and
    // proposal statements; nothing per message.
    expect(large).toBe(small);
    expect(calls.filter((name) => name === "statements.readUnit")).toHaveLength(1);
    expect(calls.filter((name) => name === "statements.unit")).toHaveLength(1);
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM mailbox_messages WHERE thread_id = ?")
        .get("gmail-thread:large"),
    ).toEqual({ count: 12 });
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM mailbox_attachments WHERE thread_id = ?")
        .get("gmail-thread:large"),
    ).toEqual({ count: 12 });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM mailbox_search_records WHERE record_type = 'message' AND thread_id = ?",
        )
        .get("gmail-thread:large"),
    ).toEqual({ count: 12 });
  });
});
