import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

describeWithSqlite("AgentRoleRepository heartbeat policy compatibility", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;
  let manager: import("../../database/schema").DatabaseManager;
  let agentRoleRepo: import("../AgentRoleRepository").AgentRoleRepository;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-agent-role-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;

    const [{ DatabaseManager }, { AgentRoleRepository }] = await Promise.all([
      import("../../database/schema"),
      import("../AgentRoleRepository"),
    ]);

    manager = new DatabaseManager();
    agentRoleRepo = new AgentRoleRepository(manager.getDatabase());
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

  it("persists heartbeat policy metadata for downstream compatibility", () => {
    const created = agentRoleRepo.create({
      name: "ops-planner",
      displayName: "Ops Planner",
      capabilities: ["plan"],
      heartbeatPolicy: {
        enabled: false,
        cadenceMinutes: 30,
        staggerOffsetMinutes: 5,
        dispatchCooldownMinutes: 90,
        maxDispatchesPerDay: 3,
        profile: "operator",
        activeHours: {
          startHour: 9,
          endHour: 17,
          timezone: "UTC",
        },
        primaryCategories: ["planning"],
        proactiveTasks: [
          {
            title: "Review queue health",
            prompt: "Check whether the queue is growing faster than work is closing.",
          },
        ],
      },
    });

    expect(created.heartbeatPolicy).toMatchObject({
      enabled: false,
      cadenceMinutes: 30,
      staggerOffsetMinutes: 5,
      dispatchCooldownMinutes: 90,
      maxDispatchesPerDay: 3,
      profile: "operator",
      primaryCategories: ["planning"],
    });
    expect(created.heartbeatPolicy?.proactiveTasks).toHaveLength(1);

    const persisted = agentRoleRepo.findById(created.id);
    expect(persisted?.heartbeatPolicy?.primaryCategories).toEqual(["planning"]);
    expect(persisted?.heartbeatPolicy?.proactiveTasks).toHaveLength(1);

    const soul = JSON.parse(persisted?.soul || "{}") as Record<string, unknown>;
    expect(soul.automationProfileMetadata).toMatchObject({
      primaryCategories: ["planning"],
    });
  });

  it("updates the editable bot profile fields without changing its handle", () => {
    const created = agentRoleRepo.create({
      name: "profile-editor",
      displayName: "Profile editor",
      description: "Original description",
      systemPrompt: "Original instructions",
      icon: "Bot",
      color: "#6366f1",
      capabilities: ["code"],
    });

    const updated = agentRoleRepo.update({
      id: created.id,
      displayName: "Research partner",
      description: "First line\nSecond line",
      systemPrompt: "Use the user's preferred language.\nBe concise.",
      icon: "Search",
      color: "#0ea5e9",
    });

    expect(updated).toMatchObject({
      id: created.id,
      name: "profile-editor",
      displayName: "Research partner",
      description: "First line\nSecond line",
      systemPrompt: "Use the user's preferred language.\nBe concise.",
      icon: "Search",
      color: "#0ea5e9",
    });
  });

  it("deactivates custom roles without breaking historical task references", () => {
    const db = manager.getDatabase();
    const workspaceId = "workspace-for-role-delete";
    db.prepare(
      `INSERT INTO workspaces (id, name, path, created_at, permissions)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(workspaceId, "Role delete test", "/tmp/cowork-role-delete-test", Date.now(), "{}");

    const custom = agentRoleRepo.create({
      name: "deletable-bot",
      displayName: "Deletable bot",
      capabilities: ["code"],
      heartbeatEnabled: true,
    });

    const taskId = "task-for-deletable-bot";
    db.prepare(
      `INSERT INTO tasks (
         id, title, prompt, status, workspace_id, created_at, updated_at, assigned_agent_role_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      taskId,
      "Historical bot task",
      "Keep this task linked to the removed bot.",
      "completed",
      workspaceId,
      Date.now(),
      Date.now(),
      custom.id,
    );

    expect(agentRoleRepo.delete(custom.id)).toBe(true);
    expect(agentRoleRepo.findById(custom.id)).toMatchObject({
      id: custom.id,
      isActive: false,
    });
    expect(agentRoleRepo.findAll()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: custom.id })]),
    );
    expect(db.prepare("SELECT assigned_agent_role_id FROM tasks WHERE id = ?").get(taskId)).toEqual(
      { assigned_agent_role_id: custom.id },
    );
    expect(
      db.prepare("SELECT enabled FROM automation_profiles WHERE agent_role_id = ?").get(custom.id),
    ).toEqual({ enabled: 0 });
  });

  it("refuses to delete seeded system roles", () => {
    const system = agentRoleRepo.seedDefaults()[0];
    expect(system?.isSystem).toBe(true);
    expect(agentRoleRepo.delete(system.id)).toBe(false);
    expect(agentRoleRepo.findById(system.id)).toMatchObject({ isSystem: true });
  });
});
