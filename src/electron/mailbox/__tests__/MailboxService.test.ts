import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const nativeSqliteAvailable = await import("better-sqlite3")
  .then((module) => {
    try {
      const Database = module.default;
      const probe = new Database(":memory:");
      probe.close();
      return true;
    } catch {
      return false;
    }
  })
  .catch(() => false);

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

describeWithSqlite("MailboxService", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;
  let manager: import("../../database/schema").DatabaseManager;
  let service: import("../MailboxService").MailboxService;
  let db: ReturnType<import("../../database/schema").DatabaseManager["getDatabase"]>;

  const now = Date.now();

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-mailbox-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;

    const [{ DatabaseManager }, { MailboxService }] = await Promise.all([
      import("../../database/schema"),
      import("../MailboxService"),
    ]);

    manager = new DatabaseManager();
    db = manager.getDatabase();
    service = new MailboxService(db);

    db.prepare(
      `INSERT INTO mailbox_accounts
        (id, provider, address, display_name, status, capabilities_json, sync_cursor, last_synced_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "gmail:test@example.com",
      "gmail",
      "test@example.com",
      "Test User",
      "connected",
      JSON.stringify(["threads", "drafts"]),
      null,
      now,
      now,
      now,
    );

    db.prepare(
      `INSERT INTO mailbox_threads
        (id, account_id, provider_thread_id, provider, subject, snippet, participants_json, labels_json, category, priority_score, urgency_score, needs_reply, stale_followup, cleanup_candidate, handled, unread_count, message_count, last_message_at, last_synced_at, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "gmail-thread:alpha",
      "gmail:test@example.com",
      "alpha",
      "gmail",
      "Q2 launch review",
      "Can you send the revised launch plan by tomorrow and propose times?",
      JSON.stringify([{ email: "alex@acme.com", name: "Alex" }]),
      JSON.stringify(["IMPORTANT"]),
      "priority",
      82,
      76,
      1,
      1,
      0,
      0,
      1,
      2,
      now - 2 * 60 * 60 * 1000,
      now,
      JSON.stringify({}),
      now,
      now,
    );

    db.prepare(
      `INSERT INTO mailbox_messages
        (id, thread_id, provider_message_id, direction, from_name, from_email, to_json, cc_json, bcc_json, subject, snippet, body_text, received_at, is_unread, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      "gmail-thread:alpha",
      "m-1",
      "incoming",
      "Alex",
      "alex@acme.com",
      JSON.stringify([{ email: "test@example.com", name: "Test User" }]),
      JSON.stringify([]),
      JSON.stringify([]),
      "Q2 launch review",
      "Need revised plan",
      "Can you send the revised launch plan by tomorrow? Please also propose two meeting times for the review.",
      now - 2 * 60 * 60 * 1000,
      1,
      JSON.stringify({}),
      now,
      now,
    );

    db.prepare(
      `INSERT INTO mailbox_messages
        (id, thread_id, provider_message_id, direction, from_name, from_email, to_json, cc_json, bcc_json, subject, snippet, body_text, received_at, is_unread, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      "gmail-thread:alpha",
      "m-2",
      "outgoing",
      "Test User",
      "test@example.com",
      JSON.stringify([{ email: "alex@acme.com", name: "Alex" }]),
      JSON.stringify([]),
      JSON.stringify([]),
      "Re: Q2 launch review",
      "Working on it",
      "I am working on the revised plan now.",
      now - 90 * 60 * 1000,
      0,
      JSON.stringify({}),
      now,
      now,
    );
  });

  afterEach(() => {
    manager?.close();
    if (previousUserDataDir === undefined) {
      delete process.env.COWORK_USER_DATA_DIR;
    } else {
      process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("summarizes threads, extracts commitments, and reports queue counts", async () => {
    const summary = await service.summarizeThread("gmail-thread:alpha");
    expect(summary?.summary).toContain("Can you send the revised launch plan");
    expect(summary?.suggestedNextAction).toBe("Draft a reply");

    const commitments = await service.extractCommitments("gmail-thread:alpha");
    expect(commitments.length).toBeGreaterThan(0);
    expect(commitments[0]?.title.toLowerCase()).toContain("revised launch plan");

    const followups = await service.reviewBulkAction({ type: "follow_up", limit: 10 });
    expect(followups.count).toBeGreaterThan(0);
    expect(followups.proposals[0]?.threadId).toBe("gmail-thread:alpha");

    const detail = await service.getThread("gmail-thread:alpha");
    expect(detail?.summary?.keyAsks.length).toBeGreaterThan(0);
    expect(detail?.commitments.length).toBeGreaterThan(0);

    const status = await service.getSyncStatus();
    expect(status.threadCount).toBe(1);
    expect(status.needsReplyCount).toBe(1);
    expect(status.commitmentCount).toBeGreaterThan(0);
  });
});
