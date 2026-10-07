import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseManager } from "../../database/schema";
import { WorkspaceStore } from "../../database/repositories";
import { AgentRoleStore } from "../../agents/AgentRoleRepository";
import { BotResponsibilityRepository } from "../BotResponsibilityRepository";
import {
  evaluateResponsibilityOperation,
  type BotResponsibilityDefinition,
  type BotResponsibilityScope,
} from "../../../shared/bot-responsibility";

const read = { connectorId: "connector", method: "messages.get", resourceId: "channel:a" };
const write = { connectorId: "connector", method: "messages.send", resourceId: "channel:a" };
const definition = (engineId = "routine:a"): BotResponsibilityDefinition => ({
  objective: "Inspect selected evidence",
  engine: { kind: "routine", id: engineId },
  mode: "observe",
  sources: [read],
  permittedActions: [],
  expectedOutput: "Internal evidence report",
  reviewBoundary: "all_effects",
  destination: { channel: "internal", id: "results" },
  backend: "node",
  budget: { maxTokens: 1000, maxCost: 1 },
});
describe("bot responsibility revisions", () => {
  let directory: string;
  let manager: DatabaseManager;
  let scope: BotResponsibilityScope;
  let repository: BotResponsibilityRepository;
  let otherWorkspace: string;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-responsibility-"));
    manager = new DatabaseManager({ dbPath: path.join(directory, "fixture.db") });
    const db = manager.getDatabase();
    const workspaces = new WorkspaceStore(db);
    const permissions = { read: true, write: false, delete: false, shell: false, network: false };
    const workspace = workspaces.create("Fixture", directory, permissions);
    otherWorkspace = workspaces.create("Other", path.join(directory, "other"), permissions).id;
    const bot = new AgentRoleStore(db).create({
      name: "private-bot",
      displayName: "Private bot",
      description: "User configuration",
      systemPrompt: "Private instructions",
      capabilities: [],
    });
    scope = { workspaceId: workspace.id, agentRoleId: bot.id };
    db.exec(
      "CREATE TABLE automation_routines (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, enabled INTEGER NOT NULL)",
    );
    for (const id of ["routine:a", "routine:b"])
      db.prepare("INSERT INTO automation_routines VALUES (?,?,0)").run(id, workspace.id);
    repository = new BotResponsibilityRepository(db);
  });
  afterEach(() => {
    manager.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  it("saves independent paused definitions without enabling engines or creating tasks", async () => {
    const first = await repository.create(scope, definition());
    const second = await repository.create(scope, definition("routine:b"));
    expect(first).toMatchObject({ revision: 1, state: "paused", agentRoleId: scope.agentRoleId });
    expect(second.id).not.toBe(first.id);
    expect(await repository.list(scope)).toHaveLength(2);
    expect(
      manager.getDatabase().prepare("SELECT SUM(enabled) total FROM automation_routines").get(),
    ).toEqual({ total: 0 });
    expect(manager.getDatabase().prepare("SELECT COUNT(*) total FROM tasks").get()).toEqual({
      total: 0,
    });
  });
  it("retains old revisions and accepts only one concurrent edit", async () => {
    const first = await repository.create(scope, definition());
    const revised = { ...definition(), objective: "Inspect revised evidence" };
    const outcomes = await Promise.allSettled([
      repository.revise(scope, first.id, 1, revised),
      repository.revise(scope, first.id, 1, { ...revised, objective: "Other edit" }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect((await repository.get(scope, first.id))?.revision).toBe(2);
    expect((await repository.get(scope, first.id, 1))?.definition).toEqual(first.definition);
    expect(
      manager
        .getDatabase()
        .prepare("SELECT COUNT(*) total FROM bot_responsibility_revisions")
        .get(),
    ).toEqual({ total: 2 });
  });
  it("preserves bindings and revisions after database reopen", async () => {
    const first = await repository.create(scope, definition());
    await repository.revise(scope, first.id, 1, { ...definition(), mode: "propose" });
    manager.close();
    manager = new DatabaseManager({ dbPath: path.join(directory, "fixture.db") });
    repository = new BotResponsibilityRepository(manager.getDatabase());
    expect((await repository.get(scope, first.id))?.definition.mode).toBe("propose");
    expect((await repository.get(scope, first.id, 1))?.definition.mode).toBe("observe");
  });
  it("adds the schema to a prior profile without rewriting bot configuration", async () => {
    const db = manager.getDatabase();
    new AgentRoleStore(db).update({ id: scope.agentRoleId, isActive: false });
    const before = db.prepare("SELECT * FROM agent_roles WHERE id = ?").get(scope.agentRoleId);
    db.exec("DROP TABLE bot_responsibility_revisions; DROP TABLE bot_responsibilities");
    manager.close();
    manager = new DatabaseManager({ dbPath: path.join(directory, "fixture.db") });
    repository = new BotResponsibilityRepository(manager.getDatabase());
    expect(
      manager
        .getDatabase()
        .prepare("SELECT * FROM agent_roles WHERE id = ?")
        .get(scope.agentRoleId),
    ).toEqual(before);
    expect(await repository.list(scope)).toEqual([]);
  });
  it("rejects foreign engines, enabled engines, foreign contexts and inactive bots", async () => {
    await expect(
      repository.create({ ...scope, workspaceId: otherWorkspace }, definition()),
    ).rejects.toThrow("outside the selected workspace");
    await expect(
      repository.create(scope, { ...definition(), contextId: "missing" }),
    ).rejects.toThrow("context is unavailable");
    manager
      .getDatabase()
      .prepare("UPDATE automation_routines SET enabled = 1 WHERE id = ?")
      .run("routine:a");
    await expect(repository.create(scope, definition())).rejects.toThrow("must be paused");
    manager.getDatabase().prepare("UPDATE automation_routines SET enabled = 0").run();
    new AgentRoleStore(manager.getDatabase()).update({ id: scope.agentRoleId, isActive: false });
    await expect(repository.create(scope, definition())).rejects.toThrow("bot is unavailable");
    expect(await repository.list(scope)).toEqual([]);
  });
  it("does not move or duplicate an engine binding and hides foreign-scope revisions", async () => {
    const first = await repository.create(scope, definition());
    await expect(repository.create(scope, definition())).rejects.toThrow("UNIQUE");
    await expect(repository.revise(scope, first.id, 1, definition("routine:b"))).rejects.toThrow(
      "binding is immutable",
    );
    expect(await repository.get({ ...scope, workspaceId: otherWorkspace }, first.id)).toBeNull();
    expect((await repository.get(scope, first.id))?.revision).toBe(1);
  });
  it("rejects undeclared fields and external effect grants in Observe or Propose", async () => {
    await expect(
      repository.create(scope, { ...definition(), permittedActions: [write] }),
    ).rejects.toThrow();
    await expect(
      repository.create(scope, { ...definition(), mode: "propose", permittedActions: [write] }),
    ).rejects.toThrow();
    await expect(
      repository.create(scope, { ...definition(), enabled: true } as BotResponsibilityDefinition),
    ).rejects.toThrow();
  });
});
describe("responsibility connector policy", () => {
  const check = (overrides: Partial<Parameters<typeof evaluateResponsibilityOperation>[0]> = {}) =>
    evaluateResponsibilityOperation({
      definition: definition(),
      revision: 1,
      currentRevision: 1,
      active: true,
      operation: read,
      catalog: [
        { ...read, effect: "read" },
        { ...write, effect: "write" },
      ],
      currentPolicyAllows: true,
      ...overrides,
    });
  it("permits only exact selected reads and rejects unknown connector methods and resources", () => {
    expect(check().allowed).toBe(true);
    expect(check({ operation: { ...read, method: "messages.getAll" } })).toMatchObject({
      allowed: false,
      reason: "unknown_method_or_resource",
    });
    expect(check({ operation: { ...read, resourceId: "channel:b" } }).allowed).toBe(false);
    expect(check({ definition: { ...definition(), sources: [] } })).toMatchObject({
      allowed: false,
      reason: "source_not_selected",
    });
  });
  it("denies writes in Observe and Propose regardless of the connector catalog", () => {
    for (const mode of ["observe", "propose"] as const)
      expect(check({ operation: write, definition: { ...definition(), mode } })).toMatchObject({
        allowed: false,
        reason: "mode_denies_effect",
      });
  });
  it("requires current permission, an active binding and the exact current revision", () => {
    expect(check({ currentPolicyAllows: false })).toMatchObject({
      allowed: false,
      reason: "current_policy_denied",
    });
    expect(check({ active: false })).toMatchObject({ allowed: false, reason: "paused" });
    expect(check({ currentRevision: 2 })).toMatchObject({
      allowed: false,
      reason: "revision_changed",
    });
  });
  it("requires review outside exact granted actions or when all effects require review", () => {
    const act = {
      ...definition(),
      mode: "act" as const,
      permittedActions: [write],
      reviewBoundary: "outside_granted_scope" as const,
    };
    expect(check({ definition: act, operation: write }).allowed).toBe(true);
    expect(check({ definition: { ...act, permittedActions: [] }, operation: write })).toMatchObject(
      { allowed: false, reason: "review_required" },
    );
    expect(
      check({ definition: { ...act, reviewBoundary: "all_effects" }, operation: write }).allowed,
    ).toBe(false);
  });
});
