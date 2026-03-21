import { beforeEach, describe, expect, it } from "vitest";
import { AwarenessService } from "../AwarenessService";
import { AutonomyEngine } from "../AutonomyEngine";
import { RelationshipMemoryService } from "../../memory/RelationshipMemoryService";

describe("AutonomyEngine", () => {
  beforeEach(() => {
    AwarenessService.initialize({
      getDefaultWorkspaceId: () => undefined,
    });
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
    RelationshipMemoryService.ingestUserMessage(
      `remind me to review ${workspaceId} launch checklist tomorrow`,
    );

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
    expect(engine.listActions(workspaceId).some((action) => action.status === "success")).toBe(true);
    expect(engine.listDecisions(workspaceId).some((decision) => decision.status === "executed")).toBe(
      true,
    );
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
      engine.listDecisions(workspaceId).some(
        (decision) =>
          decision.actionType === "organize_work_session" && decision.status === "suggested",
      ),
    ).toBe(true);
  });
});
