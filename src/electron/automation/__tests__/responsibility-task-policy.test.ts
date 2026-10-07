import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseManager } from "../../database/schema";
import { WorkspaceStore, TaskStore } from "../../database/repositories";
import { AgentRoleStore } from "../../agents/AgentRoleRepository";
import { RoutineService } from "../../routines/service";
import {
  BOT_RESPONSIBILITY_SCHEMA,
  BotResponsibilityStore,
  upgradeResponsibilityStateSchema,
  readResponsibilityTaskRun,
} from "../responsibility-store";
import {
  assertResponsibilityTaskPolicy,
  responsibilityActionReviewContextInUnit,
  fileResponsibilityOperation,
  enforceResponsibilityToolPolicy,
  responsibilityWriteReviewTarget,
} from "../responsibility-task-policy";
import { responsibilityActivationIssues } from "../responsibility-capabilities";
import type {
  BotResponsibilityDefinition,
  BotResponsibilityScope,
} from "../../../shared/bot-responsibility";

describe("immutable responsibility task admission and per-tool policy", () => {
  let dir: string,
    manager: DatabaseManager,
    db: Database.Database,
    scope: BotResponsibilityScope,
    engine: string;
  let store: BotResponsibilityStore, tasks: TaskStore, routines: RoutineService;
  const selected = {
    connectorId: "workspace_files",
    method: "read_file",
    resourceId: "evidence.md",
  };
  let definition: BotResponsibilityDefinition;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-run-policy-"));
    manager = new DatabaseManager({ dbPath: path.join(dir, "fixture.db") });
    db = manager.getDatabase();
    const ws = new WorkspaceStore(db).create("Fixture", dir, {
      read: true,
      write: true,
      delete: false,
      shell: false,
      network: false,
    });
    const bot = new AgentRoleStore(db).create({
      name: "private",
      displayName: "Private",
      description: "Fixture",
      capabilities: [],
      systemPrompt: "Private",
    });
    scope = { workspaceId: ws.id, agentRoleId: bot.id };
    routines = new RoutineService({
      db,
      getCronService: () => null,
      getEventTriggerService: () => null,
      loadHooksSettings: () => ({
        enabled: false,
        token: "fixture",
        path: "/hooks",
        maxBodyBytes: 1024,
        presets: [],
        mappings: [],
      }),
      saveHooksSettings: vi.fn(),
      createTask: vi.fn(),
    });
    engine = (
      await routines.create({
        name: "Fixture",
        workspaceId: ws.id,
        enabled: false,
        prompt: "Inspect",
        connectors: [],
        triggers: [{ id: "manual", type: "manual", enabled: true }],
      })
    ).id;
    definition = {
      objective: "Inspect",
      engine: { kind: "routine", id: engine },
      mode: "observe",
      sources: [selected],
      permittedActions: [],
      expectedOutput: "Summary",
      reviewBoundary: "all_effects",
      destination: { channel: "internal", id: "results" },
      backend: "node",
      budget: { maxTokens: 1000, maxCost: 0 },
    };
    store = new BotResponsibilityStore(db);
    tasks = new TaskStore(db);
  });
  afterEach(async () => {
    await routines.stopWorkflowRuntime();
    manager.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  function bind(mode: "observe" | "propose" | "act" = "observe") {
    const b = store.create(
      scope,
      {
        ...definition,
        mode,
        ...(mode === "act"
          ? {
              reviewBoundary: "outside_granted_scope",
              permittedActions: [
                { connectorId: "workspace_files", method: "write_file", resourceId: "approved.md" },
              ],
            }
          : {}),
      },
      Date.now(),
    );
    // Explicit test-only activation; no user profile or public activation API is used.
    db.prepare("UPDATE bot_responsibilities SET state='active' WHERE id=?").run(b.id);
    return b;
  }
  const task = () =>
    tasks.create({
      title: "Run",
      prompt: "Inspect",
      status: "pending",
      workspaceId: scope.workspaceId,
      agentConfig: { automationRoutineId: engine },
      budgetTokens: 2000,
      budgetCost: 2,
    });
  it("captures the exact bot/revision and caps budgets, including zero cost", () => {
    const b = bind();
    const t = task();
    expect(t.agentConfig?.responsibilityRun).toMatchObject({ id: b.id, revision: 1, ...scope });
    expect(t.assignedAgentRoleId).toBe(scope.agentRoleId);
    expect(t.budgetTokens).toBe(1000);
    expect(tasks.findById(t.id)?.budgetCost).toBe(0);
    expect(readResponsibilityTaskRun(db, t.id)).toEqual(t.agentConfig?.responsibilityRun);
  });
  it.each(["observe", "propose"] as const)(
    "%s permits only selected reads and denies writes/unknown tools",
    async (mode) => {
      bind(mode);
      const t = task();
      await expect(
        enforceResponsibilityToolPolicy(db, t.id, scope.workspaceId, dir, "read_file", {
          path: "evidence.md",
        }),
      ).resolves.toBeUndefined();
      expect(() =>
        assertResponsibilityTaskPolicy(
          db,
          t.id,
          scope.workspaceId,
          fileResponsibilityOperation("read_file", { path: "other.md" }, dir),
        ),
      ).toThrow("source_not_selected");
      expect(() =>
        assertResponsibilityTaskPolicy(
          db,
          t.id,
          scope.workspaceId,
          fileResponsibilityOperation("write_file", { path: "approved.md" }, dir),
        ),
      ).toThrow("mode_denies_effect");
      expect(() => assertResponsibilityTaskPolicy(db, t.id, scope.workspaceId, null)).toThrow(
        "trusted scope adapter",
      );
    },
  );
  it("matches mailbox reads to the selected account and method exactly", () => {
    const accountOperation = {
      connectorId: "mailbox",
      method: "list_threads",
      resourceId: "gmail:user@example.com",
    };
    const b = store.create(scope, { ...definition, sources: [accountOperation] }, Date.now());
    db.prepare("UPDATE bot_responsibilities SET state='active' WHERE id=?").run(b.id);
    const t = task();
    expect(
      assertResponsibilityTaskPolicy(
        db,
        t.id,
        scope.workspaceId,
        fileResponsibilityOperation(
          "mailbox_action",
          { action: "list_threads", account_id: "gmail:user@example.com" },
          dir,
        ),
      ),
    ).toBe(true);
    expect(() =>
      assertResponsibilityTaskPolicy(
        db,
        t.id,
        scope.workspaceId,
        fileResponsibilityOperation(
          "mailbox_action",
          { action: "list_threads", account_id: "imap:other@example.com" },
          dir,
        ),
      ),
    ).toThrow("source_not_selected");
    expect(() =>
      assertResponsibilityTaskPolicy(
        db,
        t.id,
        scope.workspaceId,
        fileResponsibilityOperation(
          "mailbox_action",
          { action: "get_thread", account_id: "gmail:user@example.com" },
          dir,
        ),
      ),
    ).toThrow("source_not_selected");
  });
  it("Act allows exact grants and requires review for writes outside the granted scope", () => {
    bind("act");
    const t = task();
    expect(() =>
      assertResponsibilityTaskPolicy(
        db,
        t.id,
        scope.workspaceId,
        fileResponsibilityOperation("write_file", { path: "approved.md" }, dir),
      ),
    ).not.toThrow();
    expect(() =>
      assertResponsibilityTaskPolicy(
        db,
        t.id,
        scope.workspaceId,
        fileResponsibilityOperation("write_file", { path: "other.md" }, dir),
      ),
    ).toThrow("review_required");
    expect(
      responsibilityActionReviewContextInUnit(db, t.id, scope.workspaceId, dir, "approved.md"),
    ).toBeNull();
    expect(
      responsibilityActionReviewContextInUnit(db, t.id, scope.workspaceId, dir, "other.md"),
    ).toMatchObject({ id: expect.any(String), revision: 1, ...scope });
  });
  it("all_effects makes an exact selected action require review", () => {
    const b = store.create(
      scope,
      {
        ...definition,
        mode: "act",
        reviewBoundary: "all_effects",
        permittedActions: [
          { connectorId: "workspace_files", method: "write_file", resourceId: "approved.md" },
        ],
      },
      Date.now(),
    );
    db.prepare("UPDATE bot_responsibilities SET state='active' WHERE id=?").run(b.id);
    const t = task();
    expect(() =>
      assertResponsibilityTaskPolicy(
        db,
        t.id,
        scope.workspaceId,
        fileResponsibilityOperation("write_file", { path: "approved.md" }, dir),
      ),
    ).toThrow("review_required");
  });
  it("only advertises native all-effects review when its base revision is readable", () => {
    const reviewed = {
      ...definition,
      mode: "act" as const,
      reviewBoundary: "all_effects" as const,
      permittedActions: [
        { connectorId: "workspace_files", method: "write_file", resourceId: "approved.md" },
      ],
    };
    expect(responsibilityActivationIssues(reviewed, null, { read: false, write: true })).toContain(
      "Reviewed workspace writes require read access to capture the current base revision.",
    );
    expect(
      responsibilityActivationIssues(reviewed, null, { read: true, write: true }),
    ).not.toContain("Action review handling is not connected yet.");
    expect(
      responsibilityActivationIssues(
        {
          ...reviewed,
          permittedActions: [{ connectorId: "external", method: "send", resourceId: "all" }],
        },
        null,
        { read: true, write: true },
      ),
    ).toContain("A selected action has no trusted effect scope adapter.");
  });
  it("normalizes absolute and relative write targets to the canonical review path", () => {
    fs.mkdirSync(path.join(dir, "notes dir"), { recursive: true });
    expect(responsibilityWriteReviewTarget("approved.md", dir)).toBe("approved.md");
    expect(responsibilityWriteReviewTarget(path.join(dir, "approved.md"), dir)).toBe("approved.md");
    expect(
      responsibilityWriteReviewTarget(path.join(fs.realpathSync(dir), "notes dir", "a.md"), dir),
    ).toBe("notes dir/a.md");
    expect(responsibilityWriteReviewTarget(path.join(dir, "..", "outside.md"), dir)).toBeNull();
    expect(responsibilityWriteReviewTarget(dir, dir)).toBeNull();
    expect(responsibilityWriteReviewTarget(undefined, dir)).toBeNull();
  });
  it("reports reviewed Act effects as unavailable on a headless runtime", () => {
    const reviewed = {
      ...definition,
      mode: "act" as const,
      reviewBoundary: "all_effects" as const,
      permittedActions: [
        { connectorId: "workspace_files", method: "write_file", resourceId: "approved.md" },
      ],
    };
    const headlessIssue =
      "Reviewed effects need the desktop app to present the exact review; this headless runtime cannot ask for a decision.";
    const permissions = { read: true, write: true };
    expect(
      responsibilityActivationIssues(reviewed, null, { ...permissions, interactiveReview: false }),
    ).toContain(headlessIssue);
    expect(
      responsibilityActivationIssues(reviewed, null, { ...permissions, interactiveReview: true }),
    ).not.toContain(headlessIssue);
    // Grants inside the scope run without review, and Observe has no effects.
    expect(
      responsibilityActivationIssues(
        { ...reviewed, reviewBoundary: "outside_granted_scope" },
        null,
        { ...permissions, interactiveReview: false },
      ),
    ).not.toContain(headlessIssue);
    expect(
      responsibilityActivationIssues(definition, null, { ...permissions, interactiveReview: false }),
    ).not.toContain(headlessIssue);
    // An unknown runtime is treated as unable to present the review.
    expect(responsibilityActivationIssues(reviewed, null, permissions)).toContain(headlessIssue);
  });
  it("reports reviewed Act effects as unavailable for scheduled or event-started runs", () => {
    const reviewed = {
      ...definition,
      mode: "act" as const,
      reviewBoundary: "all_effects" as const,
      permittedActions: [
        { connectorId: "workspace_files", method: "write_file", resourceId: "approved.md" },
      ],
    };
    const unattendedIssue =
      "Scheduled or event-started runs cannot present the exact review; use a manual trigger or grant the exact action within scope.";
    const routine = (triggers: unknown[]) =>
      ({
        contextBindings: {},
        executionTarget: { kind: "workspace" },
        outputs: [{ kind: "task_only" }],
        triggers,
      }) as unknown as Parameters<typeof responsibilityActivationIssues>[1];
    const permissions = { read: true, write: true, interactiveReview: true };
    expect(
      responsibilityActivationIssues(
        reviewed,
        routine([{ id: "s", type: "schedule", enabled: true, schedule: { kind: "every", everyMs: 60000 } }]),
        permissions,
      ),
    ).toContain(unattendedIssue);
    expect(
      responsibilityActivationIssues(
        reviewed,
        routine([{ id: "m", type: "manual", enabled: true }]),
        permissions,
      ),
    ).not.toContain(unattendedIssue);
    expect(
      responsibilityActivationIssues(
        { ...reviewed, reviewBoundary: "outside_granted_scope" },
        routine([{ id: "s", type: "schedule", enabled: true, schedule: { kind: "every", everyMs: 60000 } }]),
        permissions,
      ),
    ).not.toContain(unattendedIssue);
  });
  it("blocks a headless run of an all-effects Act responsibility before dispatch", () => {
    const previous = process.env.COWORK_HEADLESS;
    process.env.COWORK_HEADLESS = "1";
    try {
      const b = store.create(
        scope,
        {
          ...definition,
          mode: "act",
          reviewBoundary: "all_effects",
          permittedActions: [
            { connectorId: "workspace_files", method: "write_file", resourceId: "approved.md" },
          ],
        },
        Date.now(),
      );
      expect(store.activationIssues(scope, b.definition)).toContain(
        "Reviewed effects need the desktop app to present the exact review; this headless runtime cannot ask for a decision.",
      );
    } finally {
      if (previous === undefined) delete process.env.COWORK_HEADLESS;
      else process.env.COWORK_HEADLESS = previous;
    }
  });
  it("current revision and pause are checked again on every tool", () => {
    const b = bind();
    const t = task();
    store.revise(scope, b.id, 1, { ...definition, objective: "Changed" }, Date.now());
    expect(() =>
      assertResponsibilityTaskPolicy(
        db,
        t.id,
        scope.workspaceId,
        fileResponsibilityOperation("read_file", { path: "evidence.md" }, dir),
      ),
    ).toThrow("revision changed");
    db.prepare("UPDATE bot_responsibilities SET revision=1,state='paused' WHERE id=?").run(b.id);
    expect(() =>
      assertResponsibilityTaskPolicy(
        db,
        t.id,
        scope.workspaceId,
        fileResponsibilityOperation("read_file", { path: "evidence.md" }, dir),
      ),
    ).toThrow("paused");
  });
  it("dropping mutable config cannot drop the durable run receipt", () => {
    const b = bind();
    const t = task();
    tasks.update(t.id, { agentConfig: {} });
    db.prepare("UPDATE bot_responsibilities SET state='paused' WHERE id=?").run(b.id);
    expect(() => assertResponsibilityTaskPolicy(db, t.id, scope.workspaceId, null)).toThrow(
      "paused",
    );
    expect(readResponsibilityTaskRun(db, t.id)?.id).toBe(b.id);
  });
  it("delegation inherits its parent scope and rejects replacement/cross-workspace admission", () => {
    bind();
    const parent = task();
    const child = tasks.create({
      title: "Child",
      prompt: "Read",
      status: "pending",
      workspaceId: scope.workspaceId,
      parentTaskId: parent.id,
      agentConfig: {},
    });
    expect(child.agentConfig?.responsibilityRun).toEqual(parent.agentConfig?.responsibilityRun);
    expect(() =>
      tasks.create({
        title: "Bad",
        prompt: "Read",
        status: "pending",
        workspaceId: scope.workspaceId,
        parentTaskId: parent.id,
        agentConfig: {
          responsibilityRun: { ...parent.agentConfig!.responsibilityRun!, revision: 2 },
        },
      }),
    ).toThrow("replace parent");
    const other = new WorkspaceStore(db).create("Other", path.join(dir, "other"), {
      read: true,
      write: false,
      delete: false,
      shell: false,
      network: false,
    });
    expect(() =>
      tasks.create({
        title: "Bad",
        prompt: "Read",
        status: "pending",
        workspaceId: other.id,
        parentTaskId: parent.id,
      }),
    ).toThrow("workspace mismatch");
  });
  it("bot deactivation and scope mismatch block already admitted work", () => {
    bind();
    const t = task();
    db.prepare("UPDATE agent_roles SET is_active=0 WHERE id=?").run(scope.agentRoleId);
    expect(() => assertResponsibilityTaskPolicy(db, t.id, scope.workspaceId, null)).toThrow(
      "bot is unavailable",
    );
    expect(() => assertResponsibilityTaskPolicy(db, t.id, "foreign", null)).toThrow(
      "workspace mismatch",
    );
  });
  it("production registered-tool entrypoint checks persisted authority despite runtime wrappers", async () => {
    const { ToolRegistry } = await import("../../agent/tools/registry");
    bind();
    const t = task();
    const handler = vi.fn().mockResolvedValue({ result: { text: "Selected" } });
    const registry = Object.create(ToolRegistry.prototype);
    Object.assign(registry, {
      daemon: { getDatabase: () => db },
      workspace: { id: scope.workspaceId, path: dir },
      taskId: t.id,
      handlerRegistry: { has: () => true },
      executeWithRegisteredHandler: handler,
    });
    await expect(
      registry.executeTool("write_file", { path: "approved.md" }, { __agentSecurityWrapped: true }),
    ).rejects.toThrow("mode_denies_effect");
    expect(handler).not.toHaveBeenCalled();
    await expect(registry.executeTool("read_file", { path: "evidence.md" })).resolves.toEqual({
      text: "Selected",
    });
    expect(handler).toHaveBeenCalledOnce();
    db.prepare("UPDATE bot_responsibilities SET state='paused'").run();
    await expect(
      registry.executeTool("read_file", { path: "evidence.md" }, { __agentSecurityWrapped: true }),
    ).rejects.toThrow("paused");
    expect(handler).toHaveBeenCalledOnce();
  });
  it("native writes recheck pause after mutation preparation and leave the file intact", async () => {
    const { FileTools } = await import("../../agent/tools/file-tools");
    const b = bind("act");
    const t = task();
    fs.writeFileSync(path.join(dir, "approved.md"), "Original");
    const daemon = {
      getDatabase: () => db,
      getTaskById: async () => tasks.findById(t.id),
      logEvent: vi.fn(),
      captureTaskMutationBaseline: async () => {
        db.prepare("UPDATE bot_responsibilities SET state='paused' WHERE id=?").run(b.id);
      },
    };
    const files = new FileTools(
      new WorkspaceStore(db).findById(scope.workspaceId)!,
      daemon as never,
      t.id,
    );
    await expect(files.writeFile("approved.md", "Changed")).rejects.toThrow("paused");
    expect(fs.readFileSync(path.join(dir, "approved.md"), "utf8")).toBe("Original");
  });
  it("unbound legacy work retains its tool behavior", () => {
    const t = tasks.create({
      title: "Legacy",
      prompt: "Read",
      status: "pending",
      workspaceId: scope.workspaceId,
    });
    expect(() => assertResponsibilityTaskPolicy(db, t.id, scope.workspaceId, null)).not.toThrow();
  });
  it("rejects external paths while normalizing a selected local path", () => {
    expect(fileResponsibilityOperation("read_file", { path: "../outside" }, dir)).toBeNull();
    expect(
      fileResponsibilityOperation("mcp_unknown_read", { path: "evidence.md" }, dir),
    ).toBeNull();
    expect(
      fileResponsibilityOperation("read_file", { path: path.join(dir, "evidence.md") }, dir),
    ).toMatchObject(selected);
  });
  it("normalizes canonical absolute paths beneath the workspace root", () => {
    fs.writeFileSync(path.join(dir, "evidence.md"), "selected evidence");
    const canonicalRoot = fs.realpathSync(dir);
    expect(
      fileResponsibilityOperation(
        "read_file",
        { path: path.join(canonicalRoot, "evidence.md") },
        dir,
      ),
    ).toMatchObject(selected);
    expect(
      fileResponsibilityOperation(
        "write_file",
        { path: path.join(canonicalRoot, "new-evidence.md") },
        dir,
      ),
    ).toMatchObject({
      connectorId: "workspace_files",
      method: "write_file",
      resourceId: "new-evidence.md",
    });
  });
  it("upgrades paused-only schema atomically with revisions and foreign keys intact", () => {
    const old = new Database(":memory:");
    try {
      old.pragma("foreign_keys=ON");
      old.exec("CREATE TABLE tasks(id TEXT PRIMARY KEY)");
      old.exec(
        BOT_RESPONSIBILITY_SCHEMA.replace(
          "CHECK (state IN ('paused','active'))",
          "CHECK (state = 'paused')",
        ),
      );
      old
        .prepare(
          "INSERT INTO bot_responsibilities VALUES('private','workspace','bot','routine','engine',1,'paused',1,1)",
        )
        .run();
      old
        .prepare("INSERT INTO bot_responsibility_revisions VALUES('private',1,?,1)")
        .run(JSON.stringify(definition));
      upgradeResponsibilityStateSchema(old);
      old.exec(BOT_RESPONSIBILITY_SCHEMA);
      expect(old.prepare("SELECT * FROM bot_responsibility_revisions").all()).toHaveLength(1);
      expect(old.pragma("foreign_key_check")).toEqual([]);
      old.prepare("UPDATE bot_responsibilities SET state='active' WHERE id='private'").run();
      expect(old.prepare("SELECT state FROM bot_responsibilities").get()).toEqual({
        state: "active",
      });
      upgradeResponsibilityStateSchema(old);
      expect(old.prepare("SELECT * FROM bot_responsibility_revisions").all()).toHaveLength(1);
    } finally {
      old.close();
    }
  });
});

it("the production tool entrypoint blocks a registered handler before execution", async () => {
  const { ToolRegistry } = await import("../../agent/tools/registry");
  const blocked = vi.fn();
  const registry = Object.create(ToolRegistry.prototype);
  Object.assign(registry, {
    daemon: {
      getTaskById: async () => ({ agentConfig: { responsibilityRun: { id: "persisted" } } }),
    },
    workspace: { id: "fixture", path: "/tmp/fixture" },
    taskId: "fixture",
    handlerRegistry: { has: () => true },
    executeWithRegisteredHandler: blocked,
  });
  await expect(
    registry.executeTool("write_file", { path: "out.md" }, { __agentSecurityWrapped: true }),
  ).rejects.toThrow("policy storage is unavailable");
  expect(blocked).not.toHaveBeenCalled();
});
