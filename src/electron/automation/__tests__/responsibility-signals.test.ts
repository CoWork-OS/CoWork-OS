import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertResponsibilityMailboxEvent,
  selectedResponsibilityMailboxAccount,
} from "../responsibility-mailbox";
import { sampleResponsibilityFile } from "../responsibility-signals";

describe("bounded responsibility source sampling", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-signal-sample-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  const source = { connectorId: "workspace_files", method: "read_file", resourceId: "evidence.md" };
  const workspace = () => ({
    path: dir,
    permissions: { read: true, write: false, delete: false, shell: false, network: false },
  });
  it("samples selected bytes, handles a missing source, and detects same-size changes", async () => {
    expect(await sampleResponsibilityFile(workspace(), source)).toMatchObject({ hasSignal: false });
    await fs.writeFile(path.join(dir, "evidence.md"), "A");
    const first = await sampleResponsibilityFile(workspace(), source);
    expect(first.hasSignal).toBe(true);
    expect(await sampleResponsibilityFile(workspace(), source)).toEqual(first);
    await fs.writeFile(path.join(dir, "evidence.md"), "B");
    expect((await sampleResponsibilityFile(workspace(), source)).fingerprint).not.toBe(
      first.fingerprint,
    );
  });
  it("denies current profile rules and sources that resolve outside the workspace", async () => {
    await fs.writeFile(path.join(dir, "evidence.md"), "Private source");
    await expect(
      sampleResponsibilityFile(
        {
          ...workspace(),
          permissions: { ...workspace().permissions, accessProfileUnavailable: true },
        },
        source,
      ),
    ).rejects.toThrow("current workspace policy");
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-signal-outside-"));
    try {
      await fs.writeFile(path.join(outside, "private.md"), "Outside private context");
      await fs.symlink(path.join(outside, "private.md"), path.join(dir, "link.md"));
      await expect(
        sampleResponsibilityFile(workspace(), { ...source, resourceId: "link.md" }),
      ).rejects.toThrow();
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
  it("rejects unbounded/special sources and snapshots directory entries without following links", async () => {
    const handle = await fs.open(path.join(dir, "evidence.md"), "w");
    await handle.truncate(16 * 1024 * 1024 + 1);
    await handle.close();
    await expect(sampleResponsibilityFile(workspace(), source)).rejects.toThrow(
      "bounded signal sample",
    );
    await fs.rm(path.join(dir, "evidence.md"));
    const directory = { ...source, method: "list_directory", resourceId: "." };
    const before = await sampleResponsibilityFile(workspace(), directory);
    expect(before.hasSignal).toBe(false);
    await fs.writeFile(path.join(dir, "added.md"), "New evidence");
    const after = await sampleResponsibilityFile(workspace(), directory);
    expect(after.hasSignal).toBe(true);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });
});

describe("governed mailbox event source admission", () => {
  let db: Database.Database;
  const trigger = {
    source: "mailbox_event" as const,
    conditions: [{ field: "accountId", operator: "equals" as const, value: "mailbox-1" }],
  };
  const event = {
    source: "mailbox_event" as const,
    timestamp: 1,
    fields: {
      mailboxEventId: "event-1",
      workspaceId: "workspace-1",
      accountId: "mailbox-1",
      provider: "gmail",
      eventType: "thread_classified",
      subject: "untrusted subject must not enter the task prompt",
    },
  };
  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE mailbox_accounts (id TEXT PRIMARY KEY, provider TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE mailbox_events (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, event_type TEXT NOT NULL,
        account_id TEXT, provider TEXT
      );
    `);
    db.prepare("INSERT INTO mailbox_accounts VALUES (?, ?, ?)").run(
      "mailbox-1",
      "gmail",
      "connected",
    );
    db.prepare("INSERT INTO mailbox_events VALUES (?, ?, ?, ?, ?)").run(
      "event-1",
      "workspace-1",
      "thread_classified",
      "mailbox-1",
      "gmail",
    );
  });
  afterEach(() => db.close());

  it("admits only a persisted event from the explicitly selected connected account and workspace", () => {
    const account = selectedResponsibilityMailboxAccount(db, trigger);
    expect(account).toEqual({ accountId: "mailbox-1", provider: "gmail" });
    expect(assertResponsibilityMailboxEvent(db, trigger, event, "workspace-1", account)).toEqual(
      account,
    );
    expect(() =>
      assertResponsibilityMailboxEvent(db, trigger, event, "workspace-2", account),
    ).toThrow("selected workspace/account scope");
    expect(() =>
      assertResponsibilityMailboxEvent(db, { ...trigger, conditions: [] }, event, "workspace-1"),
    ).toThrow("select exactly one account");
    expect(() =>
      assertResponsibilityMailboxEvent(
        db,
        trigger,
        { ...event, fields: { ...event.fields, accountId: "mailbox-2" } },
        "workspace-1",
      ),
    ).toThrow("selected workspace/account scope");
  });

  it("rejects disconnected accounts and changed or missing durable event receipts", () => {
    db.prepare("UPDATE mailbox_accounts SET status='disconnected' WHERE id=?").run("mailbox-1");
    expect(() => selectedResponsibilityMailboxAccount(db, trigger)).toThrow(
      "account is unavailable",
    );
    db.prepare("UPDATE mailbox_accounts SET status='connected' WHERE id=?").run("mailbox-1");
    db.prepare("UPDATE mailbox_events SET provider='outlook_graph' WHERE id=?").run("event-1");
    expect(() => assertResponsibilityMailboxEvent(db, trigger, event, "workspace-1")).toThrow(
      "receipt is missing or changed",
    );
  });
});
