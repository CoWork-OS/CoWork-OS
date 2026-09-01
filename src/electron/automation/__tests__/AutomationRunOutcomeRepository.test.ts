import { describe, expect, it } from "vitest";

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

describeWithSqlite("AutomationRunOutcomeRepository", () => {
  it("stores outcomes and summarizes usefulness counts", async () => {
    const [{ default: Database }, { AutomationRunOutcomeRepository }] = await Promise.all([
      import("better-sqlite3"),
      import("../AutomationRunOutcomeRepository"),
    ]);
    const db = new Database(":memory:");
    const repo = new AutomationRunOutcomeRepository(db);

    const actionable = repo.create({
      source: "heartbeat",
      title: "Heartbeat created work",
      summary: "Created one task.",
      usefulness: "actionable",
      trigger: "heartbeat",
      notificationRecommended: true,
      metrics: { dispatchedTaskCount: 1 },
      evidenceRefs: [{ type: "task", id: "task-1", label: "created" }],
    });
    repo.create({
      source: "strategic_planner",
      title: "Planner checked work",
      summary: "No changes.",
      usefulness: "informational",
      trigger: "schedule",
      notificationRecommended: false,
    });

    expect(repo.list({ limit: 5 })).toHaveLength(2);
    expect(repo.list({ source: "heartbeat" })[0]).toMatchObject({
      id: actionable.id,
      metrics: { dispatchedTaskCount: 1 },
      evidenceRefs: [{ type: "task", id: "task-1", label: "created" }],
    });
    expect(repo.summarize()).toEqual({
      total: 2,
      actionable: 1,
      informational: 1,
      lowValue: 0,
      failed: 0,
    });

    db.close();
  });

  it("keeps explicit notification keys scoped to their owning job", async () => {
    const [{ default: Database }, { AutomationRunOutcomeRepository }] = await Promise.all([
      import("better-sqlite3"),
      import("../AutomationRunOutcomeRepository"),
    ]);
    const db = new Database(":memory:");
    const repo = new AutomationRunOutcomeRepository(db);
    const base = {
      source: "heartbeat" as const,
      title: "Heartbeat result",
      summary: "Changed output.",
      usefulness: "actionable" as const,
      trigger: "heartbeat" as const,
      notificationRecommended: true,
      notificationKey: "shared-key",
      workspaceId: "workspace-1",
    };

    repo.create({ ...base, agentRoleId: "agent-a", createdAt: 1 });
    repo.create({ ...base, agentRoleId: "agent-b", createdAt: 2 });

    expect(repo.findLatestByNotificationKey("shared-key", "agent:agent-a")?.agentRoleId).toBe(
      "agent-a",
    );
    expect(repo.findLatestByNotificationKey("shared-key", "agent:agent-b")?.agentRoleId).toBe(
      "agent-b",
    );

    db.close();
  });
});
