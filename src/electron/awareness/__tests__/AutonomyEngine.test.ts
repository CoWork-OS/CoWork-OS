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
    const save = vi.fn(() => true);
    vi.spyOn(SecureSettingsRepository, "isInitialized").mockReturnValue(true);
    vi.spyOn(SecureSettingsRepository, "getInstance").mockReturnValue({
      load: () => (stored === undefined ? null : structuredClone(stored)),
      save,
    } as unknown as SecureSettingsRepository);
    return save;
  }

  it("makes autonomous task creation opt-in by default", () => {
    expect(DEFAULT_AUTONOMY_CONFIG.actionPolicies.create_task.level).toBe("suggest_only");
    expect(DEFAULT_AUTONOMY_CONFIG.actionPolicies.execute_local_action.level).toBe(
      "suggest_only",
    );
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
