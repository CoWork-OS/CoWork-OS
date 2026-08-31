import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// Mock getCronService — schedule operations depend on it but we test rules here.
// Schedule-specific tests mock it returning null so createSchedule throws.
vi.mock("../../cron", () => ({
  getCronService: vi.fn().mockReturnValue(null),
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

// Minimal in-memory EventTriggerService-compatible stub
function makeTriggerService() {
  const triggers = new Map<
    string,
    { id: string; name: string; enabled: boolean; [key: string]: unknown }
  >();
  let seq = 0;
  return {
    addTrigger: vi.fn((input: Record<string, unknown>) => {
      const id = `trigger-${++seq}`;
      const trigger = { id, ...input };
      triggers.set(id, trigger as typeof triggers extends Map<string, infer V> ? V : never);
      return trigger;
    }),
    getTrigger: vi.fn((id: string) => triggers.get(id)),
    updateTrigger: vi.fn((id: string, patch: Record<string, unknown>) => {
      const existing = triggers.get(id);
      if (!existing) return null;
      const updated = { ...existing, ...patch };
      triggers.set(id, updated);
      return updated;
    }),
    removeTrigger: vi.fn((id: string) => {
      if (!triggers.has(id)) return false;
      triggers.delete(id);
      return true;
    }),
  };
}

describeWithSqlite("MailboxAutomationRegistry", () => {
  let db: import("better-sqlite3").Database;
  let triggerService: ReturnType<typeof makeTriggerService>;

  beforeEach(async () => {
    const [Database, { MailboxAutomationRegistry }] = await Promise.all([
      import("better-sqlite3").then((m) => m.default),
      import("../MailboxAutomationRegistry"),
    ]);

    MailboxAutomationRegistry.reset();
    db = new Database(":memory:");
    triggerService = makeTriggerService();

    MailboxAutomationRegistry.configure({
      db,
      triggerService:
        triggerService as unknown as import("../../triggers/EventTriggerService").EventTriggerService,
      resolveDefaultWorkspaceId: () => "ws-default",
    });
  });

  afterEach(async () => {
    const { MailboxAutomationRegistry } = await import("../MailboxAutomationRegistry");
    MailboxAutomationRegistry.reset();
    db.close();
  });

  describe("createRule", () => {
    it("creates a rule and returns it", async () => {
      const { MailboxAutomationRegistry } = await import("../MailboxAutomationRegistry");
      const rule = MailboxAutomationRegistry.createRule({
        name: "High-priority rule",
        workspaceId: "ws-default",
        conditions: [],
        conditionLogic: "all",
        actionType: "create_task",
        actionPrompt: "Do something important",
        actionTitle: "Important task",
        enabled: true,
        source: "mailbox_event",
      });

      expect(rule.id).toBeTruthy();
      expect(rule.name).toBe("High-priority rule");
      expect(rule.kind).toBe("rule");
      expect(rule.status).toBe("active");
      expect(rule.workspaceId).toBe("ws-default");
      expect(rule.backingTriggerId).toBeTruthy();
      expect(triggerService.addTrigger).toHaveBeenCalledTimes(1);
    });

    it("creates a paused rule when enabled is false", async () => {
      const { MailboxAutomationRegistry } = await import("../MailboxAutomationRegistry");
      const rule = MailboxAutomationRegistry.createRule({
        name: "Paused rule",
        workspaceId: "ws-default",
        conditions: [],
        conditionLogic: "all",
        actionType: "create_task",
        actionPrompt: "Paused task prompt",
        enabled: false,
        source: "mailbox_event",
      });

      expect(rule.status).toBe("paused");
    });

    it("throws when triggerService is unavailable", async () => {
      const Database = (await import("better-sqlite3")).default;
      const { MailboxAutomationRegistry } = await import("../MailboxAutomationRegistry");
      MailboxAutomationRegistry.reset();
      const freshDb = new Database(":memory:");
      MailboxAutomationRegistry.configure({
        db: freshDb,
        triggerService: null,
        resolveDefaultWorkspaceId: () => "ws-default",
      });

      expect(() =>
        MailboxAutomationRegistry.createRule({
          name: "No trigger",
          conditions: [],
          conditionLogic: "all",
          actionType: "create_task",
          actionPrompt: "prompt",
          source: "mailbox_event",
        }),
      ).toThrow("Trigger service is not available");

      freshDb.close();
    });
  });

  describe("listAutomations", () => {
    it("returns all non-deleted automations", async () => {
      const { MailboxAutomationRegistry } = await import("../MailboxAutomationRegistry");

      MailboxAutomationRegistry.createRule({
        name: "Rule A",
        workspaceId: "ws-default",
        conditions: [],
        conditionLogic: "all",
        actionType: "create_task",
        actionPrompt: "prompt A",
        source: "mailbox_event",
      });
      MailboxAutomationRegistry.createRule({
        name: "Rule B",
        workspaceId: "ws-default",
        conditions: [],
        conditionLogic: "all",
        actionType: "create_task",
        actionPrompt: "prompt B",
        source: "mailbox_event",
      });

      const list = MailboxAutomationRegistry.listAutomations({ workspaceId: "ws-default" });
      expect(list).toHaveLength(2);
      const names = list.map((item) => item.name);
      expect(names).toContain("Rule A");
      expect(names).toContain("Rule B");
    });

    it("returns empty list when no automations exist", async () => {
      const { MailboxAutomationRegistry } = await import("../MailboxAutomationRegistry");
      expect(MailboxAutomationRegistry.listAutomations({ workspaceId: "ws-empty" })).toHaveLength(
        0,
      );
    });
  });

  describe("updateRule", () => {
    it("updates an existing rule's name and reflects the change", async () => {
      const { MailboxAutomationRegistry } = await import("../MailboxAutomationRegistry");
      const created = MailboxAutomationRegistry.createRule({
        name: "Original name",
        workspaceId: "ws-default",
        conditions: [],
        conditionLogic: "all",
        actionType: "create_task",
        actionPrompt: "original prompt",
        source: "mailbox_event",
      });

      const updated = MailboxAutomationRegistry.updateRule(created.id, { name: "Updated name" });
      expect(updated).not.toBeNull();
      expect(updated?.name).toBe("Updated name");
    });

    it("returns null for an unknown automation id", async () => {
      const { MailboxAutomationRegistry } = await import("../MailboxAutomationRegistry");
      expect(MailboxAutomationRegistry.updateRule("no-such-id", { name: "x" })).toBeNull();
    });

    it("pauses a rule when status is set to paused", async () => {
      const { MailboxAutomationRegistry } = await import("../MailboxAutomationRegistry");
      const created = MailboxAutomationRegistry.createRule({
        name: "Active rule",
        workspaceId: "ws-default",
        conditions: [],
        conditionLogic: "all",
        actionType: "create_task",
        actionPrompt: "prompt",
        source: "mailbox_event",
      });

      const updated = MailboxAutomationRegistry.updateRule(created.id, { status: "paused" });
      expect(updated?.status).toBe("paused");
    });
  });

  describe("deleteRule", () => {
    it("soft-deletes a rule and removes it from the active list", async () => {
      const { MailboxAutomationRegistry } = await import("../MailboxAutomationRegistry");
      const created = MailboxAutomationRegistry.createRule({
        name: "To be deleted",
        workspaceId: "ws-default",
        conditions: [],
        conditionLogic: "all",
        actionType: "create_task",
        actionPrompt: "prompt",
        source: "mailbox_event",
      });

      const deleted = MailboxAutomationRegistry.deleteRule(created.id);
      expect(deleted).toBe(true);

      const remaining = MailboxAutomationRegistry.listAutomations({ workspaceId: "ws-default" });
      expect(remaining.every((item) => item.id !== created.id)).toBe(true);
    });

    it("returns false for a non-existent rule id", async () => {
      const { MailboxAutomationRegistry } = await import("../MailboxAutomationRegistry");
      expect(MailboxAutomationRegistry.deleteRule("ghost-id")).toBe(false);
    });

    it("removes the backing trigger when deleting a rule", async () => {
      const { MailboxAutomationRegistry } = await import("../MailboxAutomationRegistry");
      const created = MailboxAutomationRegistry.createRule({
        name: "Trigger removal rule",
        workspaceId: "ws-default",
        conditions: [],
        conditionLogic: "all",
        actionType: "create_task",
        actionPrompt: "prompt",
        source: "mailbox_event",
      });

      MailboxAutomationRegistry.deleteRule(created.id);
      expect(triggerService.removeTrigger).toHaveBeenCalledWith(created.backingTriggerId);
    });
  });

  describe("forward automations", () => {
    it("creates a forwarding automation with normalized defaults", async () => {
      const { MailboxAutomationRegistry } = await import("../MailboxAutomationRegistry");
      const automation = MailboxAutomationRegistry.createForward({
        name: "Forward invoices",
        schedule: { kind: "every", everyMs: 15 * 60 * 1000 },
        targetEmail: "ops@example.com",
        allowedSenders: ["Billing@Vendor.com"],
        allowedDomains: [],
      });

      expect(automation.kind).toBe("forward");
      expect(automation.status).toBe("active");
      expect(automation.forward?.allowedSenders).toEqual(["billing@vendor.com"]);
      expect(automation.forward?.attachmentExtensions).toEqual([]);
      expect(typeof automation.nextRunAt).toBe("number");
    });

    it("updates a forwarding automation and recomputes next run", async () => {
      const { MailboxAutomationRegistry } = await import("../MailboxAutomationRegistry");
      const created = MailboxAutomationRegistry.createForward({
        name: "Forward invoices",
        schedule: { kind: "every", everyMs: 15 * 60 * 1000 },
        targetEmail: "ops@example.com",
        allowedSenders: ["billing@vendor.com"],
        allowedDomains: [],
      });

      const updated = MailboxAutomationRegistry.updateForward(created.id, {
        dryRun: false,
        subjectKeywords: ["invoice"],
      });

      expect(updated?.forward?.dryRun).toBe(false);
      expect(updated?.forward?.subjectKeywords).toEqual(["invoice"]);
      expect(typeof updated?.nextRunAt).toBe("number");
    });

    it("soft-deletes a forwarding automation", async () => {
      const { MailboxAutomationRegistry } = await import("../MailboxAutomationRegistry");
      const created = MailboxAutomationRegistry.createForward({
        name: "Forward invoices",
        schedule: { kind: "every", everyMs: 15 * 60 * 1000 },
        targetEmail: "ops@example.com",
        allowedSenders: ["billing@vendor.com"],
        allowedDomains: [],
      });

      expect(MailboxAutomationRegistry.deleteForward(created.id)).toBe(true);
      expect(
        MailboxAutomationRegistry.listAutomations({ workspaceId: "ws-default" }).find(
          (item) => item.id === created.id,
        ),
      ).toBeUndefined();
    });
  });
});
