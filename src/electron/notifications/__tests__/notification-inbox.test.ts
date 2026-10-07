import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NotificationInboxStore, NOTIFICATION_INBOX_SCHEMA } from "../NotificationInboxStore";
import { NotificationService, type NotificationEvent } from "../service";
import type { AppNotification } from "../../../shared/types";

describe("canonical notification inbox", () => {
  let directory: string, first: Database.Database, second: Database.Database;
  const notice = (id: string, createdAt = Date.now()): AppNotification => ({
    id,
    type: "info",
    title: "Result",
    message: "Private body",
    read: false,
    createdAt,
    workspaceId: "ws",
    agentRoleId: "bot",
    taskId: "task",
  });
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-transactions-"));
    first = new Database(path.join(directory, "inbox.db"));
    first.pragma("journal_mode=WAL");
    first.exec(NOTIFICATION_INBOX_SCHEMA);
    second = new Database(path.join(directory, "inbox.db"));
  });
  afterEach(() => {
    second.close();
    first.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  it("imports legacy bodies once and never resurrects them after deletion", () => {
    const a = new NotificationInboxStore(first),
      b = new NotificationInboxStore(second);
    a.initialize([{ notification: notice("legacy"), key: null }]);
    expect(b.list()).toHaveLength(1);
    b.delete("legacy");
    a.initialize([{ notification: notice("legacy"), key: null }]);
    expect(a.list()).toEqual([]);
    expect(a.contains("legacy")).toBe(true);
    expect(a.add(notice("legacy"), null).added).toBe(false);
    expect(a.list()).toEqual([]);
    expect(() => a.add({ ...notice("legacy"), workspaceId: "foreign" }, null)).toThrow(
      "another scope",
    );
    expect(
      first
        .prepare("SELECT payload_json,dedupe_key FROM notification_inbox_items WHERE id='legacy'")
        .get(),
    ).toEqual({ payload_json: null, dedupe_key: null });
  });
  it("imports the newest hundred legacy entries, preserving only identities for retired entries", () => {
    const store = new NotificationInboxStore(first);
    store.initialize(
      Array.from({ length: 105 }, (_, i) => ({ notification: notice(String(i), i), key: null })),
    );
    expect(store.list()).toHaveLength(100);
    expect(store.list()[0].id).toBe("104");
    store.add(notice("new", 106), null);
    expect(store.contains("5")).toBe(true);
    expect(store.list().some((row) => row.id === "5")).toBe(false);
    store.deleteAll();
    expect(store.list()).toEqual([]);
    expect(store.contains("new")).toBe(true);
  });
  it("keeps independent connection mutations instead of replacing cached snapshots", () => {
    const a = new NotificationInboxStore(first),
      b = new NotificationInboxStore(second);
    a.initialize([]);
    a.add(notice("a"), null);
    b.add(notice("b"), null);
    a.markRead("a");
    b.delete("b");
    b.add(notice("c"), null);
    expect(
      a
        .list()
        .map((row) => row.id)
        .sort(),
    ).toEqual(["a", "c"]);
    expect(a.list().find((row) => row.id === "a")?.read).toBe(true);
    expect(a.contains("b")).toBe(true);
  });
  it("publishes only new durable writes and refreshes other service instances", async () => {
    const events: NotificationEvent[] = [];
    const storePath = path.join(directory, "legacy.json");
    fs.writeFileSync(storePath, JSON.stringify({ version: 1, notifications: [notice("legacy")] }));
    const original = fs.readFileSync(storePath, "utf8");
    const a = new NotificationService({
        db: first,
        storePath,
        onEvent: (event) => {
          events.push(event);
          return { desktopRequested: true };
        },
      }),
      b = new NotificationService({ db: second, storePath });
    await Promise.all([a.refresh(), b.refresh()]);
    await Promise.all([a.add({ ...notice("a"), id: "a" }), b.add({ ...notice("b"), id: "b" })]);
    await a.refresh();
    expect(
      a
        .list()
        .map((row) => row.id)
        .sort(),
    ).toEqual(["a", "b", "legacy"]);
    await b.markRead("a");
    await a.delete("b");
    await b.refresh();
    expect(b.list().find((row) => row.id === "a")?.read).toBe(true);
    expect(b.list().some((row) => row.id === "b")).toBe(false);
    await a.add({ ...notice("a"), id: "a" });
    expect(events.filter((row) => row.type === "added")).toHaveLength(1);
    expect(await b.containsDeliveryIdentity("b")).toBe(true);
    expect(fs.readFileSync(storePath, "utf8")).toBe(original);
  });
  it("preserves committed identity when the post-write guard fails without emitting an alert", async () => {
    const events: NotificationEvent[] = [];
    const service = new NotificationService({
      db: first,
      storePath: path.join(directory, "empty.json"),
      onEvent: (event) => events.push(event),
    });
    let checks = 0;
    await expect(
      service.add({
        ...notice("interrupted"),
        beforePublish: async () => {
          if (++checks === 2) throw Error("ownership changed");
        },
      }),
    ).rejects.toThrow("ownership changed");
    expect(events).toEqual([]);
    expect(await service.containsDeliveryIdentity("interrupted")).toBe(true);
    await service.refresh();
    expect(service.list()).toHaveLength(1);
  });
  it("fails closed when the canonical schema is unavailable and preserves the legacy source", async () => {
    first.exec("DROP TABLE notification_inbox_items");
    const storePath = path.join(directory, "legacy.json");
    fs.writeFileSync(storePath, JSON.stringify({ version: 1, notifications: [notice("legacy")] }));
    const source = fs.readFileSync(storePath, "utf8");
    const events: NotificationEvent[] = [];
    const service = new NotificationService({
      db: first,
      storePath,
      onEvent: (event) => events.push(event),
    });
    await expect(service.add(notice("new"))).rejects.toThrow();
    expect(events).toEqual([]);
    expect(fs.readFileSync(storePath, "utf8")).toBe(source);
  });
});
