import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AwarenessService } from "../AwarenessService";
import { AutonomyEngine, DEFAULT_AUTONOMY_CONFIG } from "../AutonomyEngine";
import { RelationshipMemoryService } from "../../memory/RelationshipMemoryService";
import { SecureSettingsRepository } from "../../database/SecureSettingsRepository";
import { BackgroundDispatchBudget } from "../../agents/BackgroundDispatchBudget";

describe("AutonomyEngine", () => {
  beforeEach(() => {
    AwarenessService.initialize({
      getDefaultWorkspaceId: () => undefined,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("derives a durable world model from awareness and commitments", async () => {
    const workspaceId = `ws-autonomy-${Date.now()}`;
    const awareness = AwarenessService.initialize({
      getDefaultWorkspaceId: () => workspaceId,
    });

    awareness.captureConversation("my goal is ship the launch checklist this week", workspaceId);
    awareness.captureEvent({
      source: "files",
      workspaceId,
      title: "Edited launch-plan.md",
      summary: "/tmp/launch-plan.md",
      sensitivity: "low",
      payload: { path: `/tmp/${workspaceId}/launch-plan.md` },
      tags: ["context"],
    });
    awareness.captureEvent({
      source: "apps",
      workspaceId,
      title: "Visual Studio Code",
      summary: "Visual Studio Code - launch-plan.md",
      sensitivity: "low",
      payload: {
        appName: "Visual Studio Code",
        windowTitle: "launch-plan.md",
      },
      tags: ["focus"],
    });
    const now = Date.now();
    const commitment = {
      id: `commitment-${workspaceId}`,
      layer: "commitments" as const,
      text: `remind me to review ${workspaceId} launch checklist tomorrow`,
      confidence: 0.82,
      source: "conversation" as const,
      status: "open" as const,
      dueAt: now + 24 * 60 * 60 * 1000,
      createdAt: now,
      updatedAt: now,
    };
    vi.spyOn(RelationshipMemoryService, "listDueSoonCommitments").mockReturnValue([commitment]);
    vi.spyOn(RelationshipMemoryService, "listOpenCommitments").mockReturnValue([commitment]);

    const engine = new AutonomyEngine({
      getDefaultWorkspaceId: () => workspaceId,
      listWorkspaceIds: () => [workspaceId],
    });

    const worldModel = await engine.triggerEvaluation(workspaceId);
    const decisions = engine.listDecisions(workspaceId);

    expect(worldModel).toBeTruthy();
    expect(worldModel?.goals.some((goal) => /ship the launch checklist/i.test(goal.title))).toBe(
      true,
    );
    expect(worldModel?.openLoops.some((loop) => loop.title.includes(workspaceId))).toBe(true);
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions.some((decision) => decision.actionType === "schedule_follow_up")).toBe(true);
  });

  it("executes bounded local decisions by creating internal tasks", async () => {
    mockSecureSettings();
    const workspaceId = `ws-autonomy-exec-${Date.now()}`;
    const createdTasks: Array<{ workspaceId: string; title: string; prompt: string }> = [];
    const awareness = AwarenessService.initialize({
      getDefaultWorkspaceId: () => workspaceId,
    });

    awareness.captureConversation("my goal is finish the onboarding redesign", workspaceId);
    awareness.captureEvent({
      source: "apps",
      workspaceId,
      title: "Cursor",
      summary: "Cursor - onboarding redesign",
      sensitivity: "low",
      payload: {
        appName: "Cursor",
        windowTitle: "onboarding redesign",
      },
      tags: ["focus"],
    });
    awareness.captureEvent({
      source: "files",
      workspaceId,
      title: "Edited onboarding.tsx",
      summary: `/tmp/${workspaceId}/src/onboarding.tsx`,
      sensitivity: "low",
      payload: { path: `/tmp/${workspaceId}/src/onboarding.tsx` },
      tags: ["context"],
    });

    const engine = new AutonomyEngine({
      getDefaultWorkspaceId: () => workspaceId,
      listWorkspaceIds: () => [workspaceId],
      createTask: async (currentWorkspaceId, title, prompt) => {
        createdTasks.push({ workspaceId: currentWorkspaceId, title, prompt });
        return { id: `task-${createdTasks.length}` };
      },
    });
    const config = engine.getConfig();
    config.actionPolicies.organize_work_session.level = "execute_local";
    engine.saveConfig(config);

    await engine.triggerEvaluation(workspaceId);

    expect(createdTasks.length).toBeGreaterThan(0);
    expect(engine.listActions(workspaceId).some((action) => action.status === "success")).toBe(
      true,
    );
    expect(
      engine.listDecisions(workspaceId).some((decision) => decision.status === "executed"),
    ).toBe(true);
  });

  it("does not auto-execute local decisions while a manual task is active", async () => {
    const workspaceId = `ws-autonomy-manual-${Date.now()}`;
    const createdTasks: Array<{ workspaceId: string; title: string; prompt: string }> = [];
    const awareness = AwarenessService.initialize({
      getDefaultWorkspaceId: () => workspaceId,
    });

    awareness.captureConversation("my goal is finish the onboarding redesign", workspaceId);
    awareness.captureEvent({
      source: "apps",
      workspaceId,
      title: "Cursor",
      summary: "Cursor - onboarding redesign",
      sensitivity: "low",
      payload: {
        appName: "Cursor",
        windowTitle: "onboarding redesign",
      },
      tags: ["focus"],
    });

    const engine = new AutonomyEngine({
      getDefaultWorkspaceId: () => workspaceId,
      listWorkspaceIds: () => [workspaceId],
      hasActiveManualTask: () => true,
      createTask: async (currentWorkspaceId, title, prompt) => {
        createdTasks.push({ workspaceId: currentWorkspaceId, title, prompt });
        return { id: `task-${createdTasks.length}` };
      },
    });
    const config = engine.getConfig();
    config.actionPolicies.organize_work_session.level = "execute_local";
    engine.saveConfig(config);

    await engine.triggerEvaluation(workspaceId);

    expect(createdTasks).toHaveLength(0);
    expect(engine.listActions(workspaceId)).toHaveLength(0);
    expect(
      engine
        .listDecisions(workspaceId)
        .some(
          (decision) =>
            decision.actionType === "organize_work_session" && decision.status === "suggested",
        ),
    ).toBe(true);
  });

  function mockCommitment(workspaceId: string) {
    const now = Date.now();
    const commitment = {
      id: `commitment-${workspaceId}`,
      layer: "commitments" as const,
      text: `send the ${workspaceId} contract`,
      confidence: 0.82,
      source: "conversation" as const,
      status: "open" as const,
      dueAt: now + 12 * 60 * 60 * 1000,
      createdAt: now,
      updatedAt: now,
    };
    vi.spyOn(RelationshipMemoryService, "listDueSoonCommitments").mockReturnValue([commitment]);
    vi.spyOn(RelationshipMemoryService, "listOpenCommitments").mockReturnValue([commitment]);
    return commitment;
  }

  function mockSecureSettings(stored?: unknown) {
    let persisted = stored === undefined ? undefined : structuredClone(stored);
    const save = vi.fn((_category: string, value: unknown) => {
      persisted = structuredClone(value);
      return true;
    });
    const update = vi.fn((_category: string, mutate: (current: unknown) => unknown) => {
      const next = mutate(persisted === undefined ? undefined : structuredClone(persisted));
      if (next !== undefined) save(_category, next);
      return {
        value: persisted === undefined ? undefined : structuredClone(persisted),
        revision: 1,
      };
    });
    const updateAsync = vi.fn(async (...args: Parameters<typeof update>) => update(...args));
    vi.spyOn(SecureSettingsRepository, "isInitialized").mockReturnValue(true);
    vi.spyOn(SecureSettingsRepository, "getInstance").mockReturnValue({
      load: () => (persisted === undefined ? null : structuredClone(persisted)),
      save,
      update,
      updateAsync,
      delete: () => {
        persisted = undefined;
        return true;
      },
    } as unknown as SecureSettingsRepository);
    return save;
  }

  function checkpointFixture(
    createTask?: (workspaceId: string, title: string, prompt: string) => Promise<{ id?: string }>,
  ) {
    const workspaceId = `ws-checkpoint-${Date.now()}`;
    mockCommitment(workspaceId);
    const budget = new BackgroundDispatchBudget({ maxPerWorkspacePerDay: 10 });
    const reserve = vi.spyOn(budget, "tryConsume");
    const engine = new AutonomyEngine({
      getDefaultWorkspaceId: () => workspaceId,
      dispatchBudget: budget,
      createTask,
    });
    const config = engine.getConfig();
    config.actionPolicies.schedule_follow_up.level = "execute_local";
    engine.saveConfig(config);
    return { engine, workspaceId, reserve, budget };
  }

  it("persists the pending occurrence before reserving or invoking the task executor", async () => {
    mockSecureSettings();
    const repo = SecureSettingsRepository.getInstance();
    let storedDecision: { id: string; status: string } | undefined;
    const { engine, workspaceId } = checkpointFixture(async () => {
      const state = repo.load<{ decisions: Array<{ id: string; status: string }> }>(
        "autonomy-chief-of-staff",
      );
      storedDecision = state?.decisions.find((decision) => decision.status === "pending");
      expect(storedDecision).toBeDefined();
      return { id: "committed-task" };
    });
    await engine.triggerEvaluation(workspaceId);
    expect(storedDecision?.id).toBe(engine.listActions(workspaceId)[0]?.decisionId);
    expect(storedDecision?.status).toBe("pending");
  });

  it.each(["uninitialized", "refused", "conflict"])(
    "does not reserve work when the decision checkpoint is %s",
    async (failure) => {
      mockSecureSettings();
      const task = vi.fn(async () => ({ id: "task" }));
      const { engine, workspaceId, reserve } = checkpointFixture(task);
      if (failure === "uninitialized")
        vi.spyOn(SecureSettingsRepository, "isInitialized").mockReturnValue(false);
      else
        vi.spyOn(SecureSettingsRepository.getInstance(), "updateAsync").mockRejectedValue(
          new Error(failure),
        );
      await engine.triggerEvaluation(workspaceId);
      expect(task).not.toHaveBeenCalled();
      expect(reserve).not.toHaveBeenCalled();
      expect(engine.listActions(workspaceId)).toHaveLength(0);
    },
  );

  it("honors a saved policy revocation after the engine loaded its local configuration", async () => {
    mockSecureSettings();
    const task = vi.fn(async () => ({ id: "task" }));
    const { engine, workspaceId, reserve } = checkpointFixture(task);
    const repo = SecureSettingsRepository.getInstance();
    const state = repo.load<{ config: typeof DEFAULT_AUTONOMY_CONFIG }>("autonomy-chief-of-staff")!;
    state.config.actionPolicies.schedule_follow_up.level = "suggest_only";
    repo.save("autonomy-chief-of-staff", state);
    await engine.triggerEvaluation(workspaceId);
    expect(task).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(
      repo.load<{ config: typeof DEFAULT_AUTONOMY_CONFIG }>("autonomy-chief-of-staff")?.config
        .actionPolicies.schedule_follow_up.level,
    ).toBe("suggest_only");
  });

  it.each(["policy", "decision"])(
    "refuses a %s change racing after checkpoint and refunds the unused reservation",
    async (change) => {
      mockSecureSettings();
      const task = vi.fn(async () => ({ id: "task" }));
      const { engine, workspaceId, reserve, budget } = checkpointFixture(task);
      const repo = SecureSettingsRepository.getInstance();
      reserve.mockImplementation((request) => {
        const grant = BackgroundDispatchBudget.prototype.tryConsume.call(budget, request);
        const state = repo.load<{
          config: typeof DEFAULT_AUTONOMY_CONFIG;
          decisions: Array<{ status: string }>;
        }>("autonomy-chief-of-staff")!;
        if (change === "policy")
          state.config.actionPolicies.schedule_follow_up.level = "suggest_only";
        else state.decisions[0].status = "dismissed";
        repo.save("autonomy-chief-of-staff", state);
        return grant;
      });
      await engine.triggerEvaluation(workspaceId);
      expect(task).not.toHaveBeenCalled();
      expect(budget.snapshot(workspaceId).dispatchesToday).toBe(0);
      const state = repo.load<{
        config: typeof DEFAULT_AUTONOMY_CONFIG;
        decisions: Array<{ status: string }>;
      }>("autonomy-chief-of-staff")!;
      if (change === "policy")
        expect(state.config.actionPolicies.schedule_follow_up.level).toBe("suggest_only");
      else expect(state.decisions[0].status).toBe("dismissed");
    },
  );

  it("does not admit a decision when the saved policy is incomplete", async () => {
    mockSecureSettings();
    const task = vi.fn(async () => ({ id: "task" }));
    const { engine, workspaceId, reserve } = checkpointFixture(task);
    const repo = SecureSettingsRepository.getInstance();
    const state = repo.load<{ config: Partial<typeof DEFAULT_AUTONOMY_CONFIG> }>(
      "autonomy-chief-of-staff",
    )!;
    delete state.config.enabled;
    repo.save("autonomy-chief-of-staff", state);
    await engine.triggerEvaluation(workspaceId);
    expect(task).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it("preserves another workspace's decision written after the engine loaded", async () => {
    mockSecureSettings();
    const { engine, workspaceId } = checkpointFixture(async () => ({ id: "task" }));
    const repo = SecureSettingsRepository.getInstance();
    const state = repo.load<{ decisions: unknown[] }>("autonomy-chief-of-staff")!;
    const other = {
      id: "other-workspace-decision",
      workspaceId: "other-workspace",
      status: "dismissed",
      actionType: "create_task",
      title: "Other work",
      description: "Preserve this",
      evidenceRefs: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    state.decisions.push(other);
    repo.save("autonomy-chief-of-staff", state);
    await engine.triggerEvaluation(workspaceId);
    expect(
      repo.load<{ decisions: unknown[] }>("autonomy-chief-of-staff")?.decisions,
    ).toContainEqual(other);
  });

  it.each(["policy", "decision", "other workspace"])(
    "preserves a %s change made while task creation is in flight",
    async (change) => {
      mockSecureSettings();
      const repo = SecureSettingsRepository.getInstance();
      let decisionId = "";
      const other = {
        id: "concurrent-other",
        workspaceId: "other-workspace",
        status: "dismissed",
        actionType: "create_task",
        title: "Other decision",
        evidenceRefs: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const { engine, workspaceId } = checkpointFixture(async () => {
        const state = repo.load<{
          config: typeof DEFAULT_AUTONOMY_CONFIG;
          decisions: Array<{ id: string; status: string }>;
          outcomes: unknown[];
        }>("autonomy-chief-of-staff")!;
        decisionId = state.decisions[0].id;
        if (change === "policy")
          state.config.actionPolicies.schedule_follow_up.level = "suggest_only";
        else if (change === "decision") state.decisions[0].status = "dismissed";
        else state.decisions.push(other);
        repo.save("autonomy-chief-of-staff", state);
        return { id: "created-task" };
      });
      await engine.triggerEvaluation(workspaceId);
      const state = repo.load<{
        config: typeof DEFAULT_AUTONOMY_CONFIG;
        decisions: Array<{ id: string; status: string }>;
        actions: Array<{ status: string }>;
      }>("autonomy-chief-of-staff")!;
      expect(state.actions.some((action) => action.status === "success")).toBe(true);
      if (change === "policy")
        expect(state.config.actionPolicies.schedule_follow_up.level).toBe("suggest_only");
      else if (change === "decision")
        expect(state.decisions.find((decision) => decision.id === decisionId)?.status).toBe(
          "dismissed",
        );
      else expect(state.decisions).toContainEqual(other);
    },
  );

  it("persists a task outcome completing after a concurrent stop saved the pending snapshot", async () => {
    mockSecureSettings();
    let finishTask!: (value: { id: string }) => void;
    const pendingTask = new Promise<{ id: string }>((resolve) => {
      finishTask = resolve;
    });
    const task = vi.fn(() => pendingTask);
    const { engine, workspaceId } = checkpointFixture(task);
    const evaluation = engine.triggerEvaluation(workspaceId);
    await vi.waitFor(() => expect(task).toHaveBeenCalledTimes(1));
    await engine.stop();
    finishTask({ id: "finished-task" });
    await evaluation;
    expect(
      SecureSettingsRepository.getInstance()
        .load<{ actions: Array<{ status: string }> }>("autonomy-chief-of-staff")
        ?.actions.some((action) => action.status === "success"),
    ).toBe(true);
  });

  it("changes only the requested decision status and preserves newer saved fields", async () => {
    mockSecureSettings();
    const { engine, workspaceId } = checkpointFixture(async () => ({ id: "task" }));
    await engine.triggerEvaluation(workspaceId);
    const decision = engine
      .listDecisions(workspaceId)
      .find((entry) => entry.status === "executed")!;
    const repo = SecureSettingsRepository.getInstance();
    const state = repo.load<{ decisions: Array<{ id: string; title: string; status: string }> }>(
      "autonomy-chief-of-staff",
    )!;
    const saved = state.decisions.find((entry) => entry.id === decision.id)!;
    saved.title = "Newer saved title";
    saved.status = "dismissed";
    repo.save("autonomy-chief-of-staff", state);
    expect(engine.updateDecision(decision.id, { status: "pending" })?.title).toBe(
      "Newer saved title",
    );
    expect(
      repo.load<{ decisions: Array<{ id: string; title: string; status: string }> }>(
        "autonomy-chief-of-staff",
      )?.decisions,
    ).toContainEqual(
      expect.objectContaining({ id: decision.id, title: "Newer saved title", status: "pending" }),
    );
  });

  it("does not restore cached execution policy after the saved category is reset during task creation", async () => {
    mockSecureSettings();
    const repo = SecureSettingsRepository.getInstance();
    const { engine, workspaceId } = checkpointFixture(async () => {
      repo.delete("autonomy-chief-of-staff");
      return { id: "created-task" };
    });
    await engine.triggerEvaluation(workspaceId);
    expect(
      repo.load<{ config: typeof DEFAULT_AUTONOMY_CONFIG }>("autonomy-chief-of-staff")?.config
        .actionPolicies.schedule_follow_up.level,
    ).toBe("suggest_only");
  });

  it("keeps explicit user policy edits available after an automatic save preserved revocation", async () => {
    mockSecureSettings();
    const repo = SecureSettingsRepository.getInstance();
    const { engine, workspaceId } = checkpointFixture(async () => {
      const state = repo.load<{ config: typeof DEFAULT_AUTONOMY_CONFIG }>(
        "autonomy-chief-of-staff",
      )!;
      state.config.actionPolicies.schedule_follow_up.level = "suggest_only";
      repo.save("autonomy-chief-of-staff", state);
      return { id: "task" };
    });
    await engine.triggerEvaluation(workspaceId);
    const config = engine.getConfig();
    config.actionPolicies.schedule_follow_up.level = "execute_local";
    engine.saveConfig(config);
    expect(
      repo.load<{ config: typeof DEFAULT_AUTONOMY_CONFIG }>("autonomy-chief-of-staff")?.config
        .actionPolicies.schedule_follow_up.level,
    ).toBe("execute_local");
  });

  it("refuses a status edit after the saved decision moved outside the original workspace", async () => {
    mockSecureSettings();
    const { engine, workspaceId } = checkpointFixture(async () => ({ id: "task" }));
    await engine.triggerEvaluation(workspaceId);
    const decision = engine
      .listDecisions(workspaceId)
      .find((entry) => entry.status === "executed")!;
    const repo = SecureSettingsRepository.getInstance();
    const state = repo.load<{
      decisions: Array<{ id: string; workspaceId: string; status: string }>;
      outcomes: unknown[];
    }>("autonomy-chief-of-staff")!;
    state.decisions.find((entry) => entry.id === decision.id)!.workspaceId = "other-workspace";
    repo.save("autonomy-chief-of-staff", state);
    const before = state.outcomes.length;
    expect(engine.updateDecision(decision.id, { status: "done" })).toBeNull();
    const saved = repo.load<typeof state>("autonomy-chief-of-staff")!;
    expect(saved.decisions).toContainEqual(
      expect.objectContaining({
        id: decision.id,
        workspaceId: "other-workspace",
        status: "executed",
      }),
    );
    expect(saved.outcomes).toHaveLength(before);
  });

  it("preserves a newer explicit pending choice even when its timestamp equals task completion", async () => {
    mockSecureSettings();
    vi.spyOn(Date, "now").mockReturnValue(1_791_273_000_000);
    const repo = SecureSettingsRepository.getInstance();
    let id = "";
    const { engine, workspaceId } = checkpointFixture(async () => {
      id = repo.load<{ decisions: Array<{ id: string }> }>("autonomy-chief-of-staff")!.decisions[0]
        .id;
      const controller = new AutonomyEngine();
      controller.getConfig();
      expect(controller.updateDecision(id, { status: "pending" })?.status).toBe("pending");
      return { id: "created-task" };
    });
    await engine.triggerEvaluation(workspaceId);
    expect(
      repo
        .load<{ decisions: Array<{ id: string; status: string }> }>("autonomy-chief-of-staff")
        ?.decisions.find((entry) => entry.id === id)?.status,
    ).toBe("pending");
  });

  it("does not report execution or consume a ticket without an installed task executor", async () => {
    mockSecureSettings();
    const { engine, workspaceId, reserve } = checkpointFixture();
    await engine.triggerEvaluation(workspaceId);
    expect(reserve).not.toHaveBeenCalled();
    expect(engine.listActions(workspaceId).some((action) => action.status === "success")).toBe(
      false,
    );
  });

  it("does not report success when the executor returns no task identity", async () => {
    mockSecureSettings();
    const { engine, workspaceId } = checkpointFixture(async () => ({}));
    await engine.triggerEvaluation(workspaceId);
    expect(engine.listActions(workspaceId).some((action) => action.status === "success")).toBe(
      false,
    );
  });

  it("makes autonomous task creation opt-in by default", () => {
    expect(DEFAULT_AUTONOMY_CONFIG.actionPolicies.create_task.level).toBe("suggest_only");
    expect(DEFAULT_AUTONOMY_CONFIG.actionPolicies.execute_local_action.level).toBe("suggest_only");
    expect(
      Object.values(DEFAULT_AUTONOMY_CONFIG.actionPolicies).some(
        (policy) => policy.level === "execute_local",
      ),
    ).toBe(false);
  });

  it("resets the former execute_local defaults in stored state but keeps a later opt-in", () => {
    const legacyConfig = structuredClone(DEFAULT_AUTONOMY_CONFIG);
    legacyConfig.actionPolicies.create_task.level = "execute_local";
    legacyConfig.actionPolicies.execute_local_action.level = "execute_local";
    const save = mockSecureSettings({
      config: legacyConfig,
      worldModels: {},
      decisions: [],
      actions: [],
      outcomes: [],
    });
    const engine = new AutonomyEngine({});
    const config = engine.getConfig();
    expect(config.actionPolicies.create_task.level).toBe("suggest_only");
    expect(config.actionPolicies.execute_local_action.level).toBe("suggest_only");

    config.actionPolicies.create_task.level = "execute_local";
    const saved = engine.saveConfig(config);
    expect(saved.actionPolicies.create_task.level).toBe("execute_local");
    const persisted = save.mock.calls.at(-1)?.[1] as { policyVersion?: number };
    expect(persisted.policyVersion).toBe(2);
  });

  it("has no timer of its own: Heartbeat drives evaluation", async () => {
    vi.useFakeTimers();
    try {
      const engine = new AutonomyEngine({ getDefaultWorkspaceId: () => "ws-timerless" });
      await engine.start();
      expect(vi.getTimerCount()).toBe(0);
      await engine.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("evaluates a workspace at most once per minute from pulses", async () => {
    const workspaceId = `ws-autonomy-throttle-${Date.now()}`;
    mockCommitment(workspaceId);
    const engine = new AutonomyEngine({ getDefaultWorkspaceId: () => workspaceId });

    expect(await engine.evaluate(workspaceId)).toBe(true);
    expect(await engine.evaluate(workspaceId)).toBe(false);
    expect(engine.getWorldModel(workspaceId)).toBeTruthy();

    const config = engine.getConfig();
    config.autoEvaluate = false;
    engine.saveConfig(config);
    expect(await engine.evaluate(`${workspaceId}-other`)).toBe(false);
  });

  it("writes the encrypted state only when the evaluation changed something", async () => {
    const workspaceId = `ws-autonomy-save-${Date.now()}`;
    mockCommitment(workspaceId);
    const save = mockSecureSettings();
    const engine = new AutonomyEngine({ getDefaultWorkspaceId: () => workspaceId });

    await engine.triggerEvaluation(workspaceId);
    const afterFirst = save.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    await engine.triggerEvaluation(workspaceId);
    await engine.triggerEvaluation(workspaceId);
    expect(save.mock.calls.length).toBe(afterFirst);
  });

  it("routes suggested decisions into the suggestion sink keyed by commitment", async () => {
    const workspaceId = `ws-autonomy-sink-${Date.now()}`;
    const commitment = mockCommitment(workspaceId);
    const proposals: Array<{ workspaceId: string; entityKey?: string; status: string }> = [];
    const createdTasks: string[] = [];
    const engine = new AutonomyEngine({
      getDefaultWorkspaceId: () => workspaceId,
      createTask: async (_workspaceId, title) => {
        createdTasks.push(title);
        return { id: "task-1" };
      },
      proposeSuggestion: async ({ workspaceId: proposalWorkspaceId, decision }) => {
        proposals.push({
          workspaceId: proposalWorkspaceId,
          entityKey: decision.entityKey,
          status: decision.status,
        });
      },
    });

    await engine.triggerEvaluation(workspaceId);

    expect(createdTasks).toHaveLength(0);
    expect(proposals).toContainEqual({
      workspaceId,
      entityKey: `commitment:${commitment.id}`,
      status: "suggested",
    });
    // A second evaluation inside the decision cooldown does not propose again.
    const count = proposals.length;
    await engine.triggerEvaluation(workspaceId);
    expect(proposals).toHaveLength(count);
  });

  it("keeps an opted-in local action as a suggestion when the shared budget is spent", async () => {
    mockSecureSettings();
    const workspaceId = `ws-autonomy-budget-${Date.now()}`;
    const createdTasks: string[] = [];
    const awareness = AwarenessService.initialize({ getDefaultWorkspaceId: () => workspaceId });
    awareness.captureConversation("my goal is finish the onboarding redesign", workspaceId);
    awareness.captureEvent({
      source: "apps",
      workspaceId,
      title: "Cursor",
      summary: "Cursor - onboarding redesign",
      sensitivity: "low",
      payload: { appName: "Cursor", windowTitle: "onboarding redesign" },
      tags: ["focus"],
    });
    const dispatchBudget = new BackgroundDispatchBudget({ maxPerWorkspacePerDay: 1 });
    dispatchBudget.tryConsume({ workspaceId, source: "heartbeat" });
    const engine = new AutonomyEngine({
      getDefaultWorkspaceId: () => workspaceId,
      dispatchBudget,
      createTask: async (_workspaceId, title) => {
        createdTasks.push(title);
        return { id: "task-1" };
      },
    });
    const config = engine.getConfig();
    config.actionPolicies.organize_work_session.level = "execute_local";
    engine.saveConfig(config);

    await engine.triggerEvaluation(workspaceId);

    expect(createdTasks).toHaveLength(0);
    expect(
      engine
        .listDecisions(workspaceId)
        .some(
          (decision) =>
            decision.actionType === "organize_work_session" && decision.status === "suggested",
        ),
    ).toBe(true);
  });
});
