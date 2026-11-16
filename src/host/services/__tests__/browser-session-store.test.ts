import { describe, expect, it } from "vitest";
import { DELETE_SECURE_SETTINGS } from "../../../electron/database/SecureSettingsRepository";
import {
  MAX_PERSISTED_WEB_SESSIONS,
  sanitizePersistedWebSessions,
  type PersistedWebSession,
} from "../../web/session-store";
import {
  createBrowserSessionStore,
  forgetStoredBrowserSessions,
  type BrowserSessionSettings,
} from "../browser-session-store";

/** Encrypted settings reduced to one row, with the read-modify-write the real one does. */
function fakeSettings(initial?: object) {
  let row: object | undefined = initial;
  const calls = { update: 0, written: 0, deleted: 0 };
  let failUpdates = false;
  const settings: BrowserSessionSettings = {
    load: () => (row ? structuredClone(row) : undefined),
    update(_category, mutate) {
      calls.update += 1;
      if (failUpdates) throw new Error("write refused");
      const next = mutate(row ? (structuredClone(row) as never) : undefined);
      if (next === undefined) return;
      calls.written += 1;
      row = next === DELETE_SECURE_SETTINGS ? undefined : next;
    },
    delete() {
      calls.deleted += 1;
      const existed = row !== undefined;
      row = undefined;
      return existed;
    },
  };
  return {
    settings,
    calls,
    row: () => row,
    refuseUpdates: () => {
      failUpdates = true;
    },
  };
}

function record(name: string, overrides: Partial<PersistedWebSession> = {}): PersistedWebSession {
  return {
    key: name.padEnd(64, "0").replace(/[^0-9a-f]/g, "a"),
    audience: "web-access",
    installationId: "installation",
    profileId: "default",
    runtime: "electron",
    deployment: "loopback",
    createdAt: 1_000,
    lastUsedAt: 2_000,
    expiresAt: 9_000,
    ...overrides,
  };
}

describe("stored browser sign-ins", () => {
  it("adds, updates, removes and clears records one atomic change at a time", () => {
    const { settings, row } = fakeSettings();
    const store = createBrowserSessionStore(settings);
    expect(store.load()).toEqual([]);

    const first = record("a1");
    const second = record("b2", { audience: "control-plane", lastUsedAt: 3_000 });
    store.add(first);
    store.add(second);
    expect(store.load().map((entry) => entry.key)).toEqual([second.key, first.key]);

    store.touch([{ key: first.key, lastUsedAt: 5_000 }]);
    expect(store.load().find((entry) => entry.key === first.key)?.lastUsedAt).toBe(5_000);

    store.clear("control-plane");
    expect(store.load().map((entry) => entry.key)).toEqual([first.key]);

    store.remove([first.key]);
    expect(store.load()).toEqual([]);
    // The last record leaves no row behind.
    expect(row()).toBeUndefined();
  });

  it("never writes back a sign-in that was signed out elsewhere", () => {
    const { settings, calls } = fakeSettings();
    const store = createBrowserSessionStore(settings);
    const kept = record("a1");
    store.add(kept);
    const writesBefore = calls.written;

    // Another host signed this one out; a late last-used update must not restore it.
    store.touch([{ key: record("c3").key, lastUsedAt: 7_000 }]);
    // An older time than the stored one changes nothing either.
    store.touch([{ key: kept.key, lastUsedAt: 1_500 }]);

    expect(store.load()).toEqual([kept]);
    expect(calls.written).toBe(writesBefore);
  });

  it("forgets every sign-in when a sign-out cannot be written", () => {
    const { settings, calls, row, refuseUpdates } = fakeSettings();
    const store = createBrowserSessionStore(settings);
    store.add(record("a1"));
    store.add(record("b2"));
    refuseUpdates();

    expect(() => store.remove([record("a1").key])).toThrow("write refused");
    expect(row()).toBeUndefined();
    expect(calls.deleted).toBe(1);
  });

  it("clears with a plain delete, which needs no working encryption", () => {
    const { settings, calls, row, refuseUpdates } = fakeSettings();
    const store = createBrowserSessionStore(settings);
    store.add(record("a1"));
    refuseUpdates();

    store.clear();
    expect(row()).toBeUndefined();
    expect(calls.deleted).toBe(1);
  });

  it("reads stored data as untrusted: malformed records and unknown versions are dropped", () => {
    const good = record("a1");
    expect(
      sanitizePersistedWebSessions([
        good,
        { ...good, key: "not-a-hash" },
        { ...record("b2"), expiresAt: "soon" },
        { ...record("c3"), audience: "" },
        { ...record("d4"), cookie: "ignored extra field" },
        null,
        "text",
      ]),
    ).toEqual([good, record("d4")]);
    expect(sanitizePersistedWebSessions({ sessions: [good] })).toEqual([]);

    const many = Array.from({ length: MAX_PERSISTED_WEB_SESSIONS + 20 }, (_, index) =>
      record(index.toString(16).padStart(4, "0"), { lastUsedAt: 10_000 + index }),
    );
    const capped = sanitizePersistedWebSessions(many);
    expect(capped).toHaveLength(MAX_PERSISTED_WEB_SESSIONS);
    // The stalest are the ones dropped.
    expect(Math.min(...capped.map((entry) => entry.lastUsedAt))).toBe(10_020);

    const future = createBrowserSessionStore(
      fakeSettings({ version: 2, sessions: [good] }).settings,
    );
    expect(future.load()).toEqual([]);
  });

  it("forgets one kind of host's sign-ins and leaves the other's", () => {
    const desktop = record("a1", { runtime: "electron" });
    const daemon = record("b2", { runtime: "node" });
    const { settings, row } = fakeSettings({ version: 1, sessions: [desktop, daemon] });

    forgetStoredBrowserSessions("node", settings);
    expect(createBrowserSessionStore(settings).load()).toEqual([desktop]);

    forgetStoredBrowserSessions("electron", settings);
    expect(row()).toBeUndefined();

    // Nothing stored, or no settings yet: nothing to do.
    forgetStoredBrowserSessions("node", settings);
    forgetStoredBrowserSessions("node", undefined);
  });

  it("forgets everything when the per-host edit cannot be written", () => {
    const { settings, row, refuseUpdates } = fakeSettings({
      version: 1,
      sessions: [record("a1", { runtime: "node" }), record("b2", { runtime: "electron" })],
    });
    refuseUpdates();
    forgetStoredBrowserSessions("node", settings);
    expect(row()).toBeUndefined();
  });
});
