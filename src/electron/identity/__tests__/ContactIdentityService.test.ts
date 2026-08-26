import { beforeEach, describe, expect, it, vi } from "vitest";

// KnowledgeGraphService is used internally — mock it so the test stays focused
// on ContactIdentityService DB logic without requiring a full KG initialisation.
vi.mock("../../knowledge-graph/KnowledgeGraphService", () => ({
  KnowledgeGraphService: {
    isInitialized: vi.fn().mockReturnValue(false),
    searchEntities: vi.fn().mockReturnValue([]),
  },
}));

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

describeWithSqlite("ContactIdentityService", () => {
  let db: import("better-sqlite3").Database;
  let service: import("../ContactIdentityService").ContactIdentityService;

  beforeEach(async () => {
    const [Database, { ContactIdentityService }] = await Promise.all([
      import("better-sqlite3").then((m) => m.default),
      import("../ContactIdentityService"),
    ]);

    db = new Database(":memory:");

    // Create the minimal schema required by ContactIdentityService
    db.exec(`
      CREATE TABLE IF NOT EXISTS contact_identities (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        primary_email TEXT,
        company_hint TEXT,
        kg_entity_id TEXT,
        confidence REAL NOT NULL DEFAULT 0.5,
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS contact_identity_handles (
        id TEXT PRIMARY KEY,
        contact_identity_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        handle_type TEXT NOT NULL,
        normalized_value TEXT NOT NULL,
        display_value TEXT NOT NULL,
        source TEXT NOT NULL,
        channel_id TEXT,
        channel_type TEXT,
        channel_user_id TEXT,
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (contact_identity_id) REFERENCES contact_identities(id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_identity_handles_unique
        ON contact_identity_handles(workspace_id, handle_type, normalized_value);
      CREATE INDEX IF NOT EXISTS idx_contact_identity_handles_identity
        ON contact_identity_handles(contact_identity_id, handle_type);
      CREATE INDEX IF NOT EXISTS idx_contact_identity_handles_channel
        ON contact_identity_handles(channel_type, channel_user_id);

      CREATE TABLE IF NOT EXISTS contact_identity_suggestions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        contact_identity_id TEXT NOT NULL,
        handle_type TEXT NOT NULL,
        normalized_value TEXT NOT NULL,
        display_value TEXT NOT NULL,
        source TEXT NOT NULL,
        source_label TEXT NOT NULL,
        channel_id TEXT,
        channel_type TEXT,
        channel_user_id TEXT,
        confidence REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'suggested',
        reason_codes_json TEXT NOT NULL,
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (contact_identity_id) REFERENCES contact_identities(id)
      );

      CREATE TABLE IF NOT EXISTS contact_identity_audit (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        contact_identity_id TEXT,
        handle_id TEXT,
        suggestion_id TEXT,
        action TEXT NOT NULL,
        detail_json TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (contact_identity_id) REFERENCES contact_identities(id),
        FOREIGN KEY (handle_id) REFERENCES contact_identity_handles(id),
        FOREIGN KEY (suggestion_id) REFERENCES contact_identity_suggestions(id)
      );

      -- Minimal stubs for tables referenced by getCoverageStats / getReplyTargets
      CREATE TABLE IF NOT EXISTS mailbox_contacts (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        updated_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        config TEXT NOT NULL DEFAULT '{}',
        security_config TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'disconnected',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS channel_users (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        channel_user_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        username TEXT,
        allowed INTEGER NOT NULL DEFAULT 0,
        pairing_attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        FOREIGN KEY (channel_id) REFERENCES channels(id)
      );

      CREATE TABLE IF NOT EXISTS channel_sessions (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        user_id TEXT,
        task_id TEXT,
        workspace_id TEXT,
        state TEXT NOT NULL DEFAULT 'idle',
        created_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL,
        FOREIGN KEY (channel_id) REFERENCES channels(id)
      );

      CREATE TABLE IF NOT EXISTS channel_messages (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        session_id TEXT,
        channel_message_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        user_id TEXT,
        direction TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (channel_id) REFERENCES channels(id)
      );

      CREATE TABLE IF NOT EXISTS mailbox_events (
        id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        duplicate_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mailbox_threads (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        provider_thread_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        subject TEXT NOT NULL,
        snippet TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'other',
        priority_score REAL NOT NULL DEFAULT 0,
        urgency_score REAL NOT NULL DEFAULT 0,
        needs_reply INTEGER NOT NULL DEFAULT 0,
        stale_followup INTEGER NOT NULL DEFAULT 0,
        cleanup_candidate INTEGER NOT NULL DEFAULT 0,
        handled INTEGER NOT NULL DEFAULT 0,
        unread_count INTEGER NOT NULL DEFAULT 0,
        message_count INTEGER NOT NULL DEFAULT 0,
        last_message_at INTEGER NOT NULL,
        classification_state TEXT NOT NULL DEFAULT 'pending',
        classification_confidence REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mailbox_commitments (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        title TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'suggested',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS heartbeat_runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    service = new ContactIdentityService(db);
  });

  describe("resolveMailboxContact (creates identity)", () => {
    it("creates a new contact identity for a new email", () => {
      const result = service.resolveMailboxContact({
        workspaceId: "ws-1",
        email: "alice@example.com",
        displayName: "Alice",
      });

      expect(result.identity).not.toBeNull();
      expect(result.identity?.primaryEmail).toBe("alice@example.com");
      expect(result.identity?.displayName).toBe("Alice");
      expect(result.identity?.workspaceId).toBe("ws-1");
      expect(result.confidence).toBeGreaterThan(0);
    });

    it("returns the same identity on a second resolve with the same email", () => {
      const first = service.resolveMailboxContact({
        workspaceId: "ws-1",
        email: "bob@example.com",
        displayName: "Bob",
      });
      const second = service.resolveMailboxContact({
        workspaceId: "ws-1",
        email: "bob@example.com",
        displayName: "Bob Smith",
      });

      expect(second.identity?.id).toBe(first.identity?.id);
    });

    it("returns missing_primary_email reason when email is absent", () => {
      const result = service.resolveMailboxContact({
        workspaceId: "ws-1",
        displayName: "NoEmail",
      });
      expect(result.identity).toBeNull();
      expect(result.reasonCodes).toContain("missing_primary_email");
    });
  });

  describe("getIdentity", () => {
    it("retrieves a previously created identity by id", () => {
      const { identity } = service.resolveMailboxContact({
        workspaceId: "ws-1",
        email: "carol@example.com",
        displayName: "Carol",
      });
      expect(identity).not.toBeNull();
      const fetched = service.getIdentity(identity!.id);
      expect(fetched?.id).toBe(identity!.id);
      expect(fetched?.primaryEmail).toBe("carol@example.com");
    });

    it("returns null for an unknown identity id", () => {
      expect(service.getIdentity("non-existent-id")).toBeNull();
    });
  });

  describe("listIdentities", () => {
    it("lists all identities for a workspace", () => {
      service.resolveMailboxContact({ workspaceId: "ws-list", email: "d@example.com", displayName: "D" });
      service.resolveMailboxContact({ workspaceId: "ws-list", email: "e@example.com", displayName: "E" });

      const list = service.listIdentities("ws-list");
      expect(list.length).toBe(2);
      const emails = list.map((i) => i.primaryEmail);
      expect(emails).toContain("d@example.com");
      expect(emails).toContain("e@example.com");
    });

    it("isolates identities between workspaces", () => {
      service.resolveMailboxContact({ workspaceId: "ws-a", email: "a@example.com", displayName: "A" });
      service.resolveMailboxContact({ workspaceId: "ws-b", email: "b@example.com", displayName: "B" });

      expect(service.listIdentities("ws-a")).toHaveLength(1);
      expect(service.listIdentities("ws-b")).toHaveLength(1);
    });
  });

  describe("linkManualHandle", () => {
    it("links a handle to an existing identity", () => {
      const { identity } = service.resolveMailboxContact({
        workspaceId: "ws-1",
        email: "frank@example.com",
        displayName: "Frank",
      });
      expect(identity).not.toBeNull();

      const handle = service.linkManualHandle({
        workspaceId: "ws-1",
        contactIdentityId: identity!.id,
        handleType: "slack_user_id",
        normalizedValue: "U12345",
        displayValue: "frank_slack",
        source: "manual",
      });

      expect(handle).not.toBeNull();
      expect(handle?.handleType).toBe("slack_user_id");
      expect(handle?.normalizedValue).toBe("u12345"); // normalized to lowercase

      const fetched = service.getIdentity(identity!.id);
      const slackHandles = fetched?.handles.filter((h) => h.handleType === "slack_user_id") ?? [];
      expect(slackHandles.length).toBeGreaterThanOrEqual(1);
    });

    it("returns null when normalizedValue is empty", () => {
      const { identity } = service.resolveMailboxContact({
        workspaceId: "ws-1",
        email: "grace@example.com",
        displayName: "Grace",
      });
      expect(identity).not.toBeNull();

      const handle = service.linkManualHandle({
        workspaceId: "ws-1",
        contactIdentityId: identity!.id,
        handleType: "slack_user_id",
        normalizedValue: "",
        displayValue: "",
        source: "manual",
      });

      expect(handle).toBeNull();
    });
  });

  describe("unlinkHandle", () => {
    it("removes a linked handle and returns true", () => {
      const { identity } = service.resolveMailboxContact({
        workspaceId: "ws-1",
        email: "henry@example.com",
        displayName: "Henry",
      });
      expect(identity).not.toBeNull();

      const handle = service.linkManualHandle({
        workspaceId: "ws-1",
        contactIdentityId: identity!.id,
        handleType: "slack_user_id",
        normalizedValue: "U99999",
        displayValue: "henry_slack",
        source: "manual",
      });
      expect(handle).not.toBeNull();

      const result = service.unlinkHandle(handle!.id);
      expect(result).toBe(true);

      const fetched = service.getIdentity(identity!.id);
      const slackHandles = fetched?.handles.filter((h) => h.handleType === "slack_user_id") ?? [];
      expect(slackHandles).toHaveLength(0);

      const audit = db
        .prepare(
          `SELECT handle_id, detail_json
           FROM contact_identity_audit
           WHERE action = 'handle_unlinked'
           ORDER BY created_at DESC
           LIMIT 1`,
        )
        .get() as { handle_id: string | null; detail_json: string };
      expect(audit.handle_id).toBeNull();
      expect(JSON.parse(audit.detail_json)).toMatchObject({
        handleId: handle!.id,
        handleType: "slack_user_id",
      });
    });

    it("returns false for a non-existent handle id", () => {
      expect(service.unlinkHandle("ghost-handle-id")).toBe(false);
    });
  });
});
