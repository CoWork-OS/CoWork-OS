import { describe, expect, it } from "vitest";

import {
  buildWorkerRolePrompt,
  getWorkerRoleSpec,
  inferWorkerRoleKindFromPrompt,
  normalizeWorkerRoleTaskConfig,
  parseVerificationVerdict,
  resolveDelegationWorkerRole,
  resolveDefaultWorkerRoleKind,
  resolveWorkerRoleAgentConfig,
  stripTeamWorkItemLaneOverride,
} from "../worker-role-registry";

describe("worker-role-registry", () => {
  it("keeps implementer as the default and verifier read-only", () => {
    expect(resolveDefaultWorkerRoleKind()).toBe("implementer");

    const verifier = resolveWorkerRoleAgentConfig("verifier", {});
    expect(verifier.executionMode).toBe("verified");
    expect(verifier.allowUserInput).toBe(false);
    expect(verifier.toolRestrictions).toEqual(
      expect.arrayContaining([
        "group:write",
        "group:destructive",
        "group:system",
        "group:memory",
        "spawn_agent",
        "gmail_send_email",
        "browser_click",
        "git_commit",
      ]),
    );
    expect(verifier.permissionMode).toBe("plan");
    expect(verifier.shellAccess).toBe(false);

    const researcher = resolveWorkerRoleAgentConfig("researcher", {});
    expect(researcher.toolRestrictions).toContain("group:destructive");
    expect(researcher.permissionMode).toBe("plan");
    expect(researcher.shellAccess).toBe(false);
    expect(researcher.readOnlyExecution).toBe(true);
  });

  it("denies memory writes to the verifier and researcher roles (SEC-12)", () => {
    const verifier = resolveWorkerRoleAgentConfig("verifier", {});
    const researcherSpec = getWorkerRoleSpec("researcher");
    for (const tool of ["memory_save", "memory_curate", "supermemory_remember", "kg_create_entity"]) {
      expect(verifier.toolRestrictions).toContain(tool);
      expect(researcherSpec.toolRestrictions).toContain(tool);
    }
  });

  it("builds a worker prompt with the role contract", () => {
    const prompt = buildWorkerRolePrompt("researcher", {
      taskTitle: "Review release notes",
      taskPrompt: "Summarize useful changes",
      workspacePath: "/tmp/workspace",
      parentSummary: "Previous step found 3 relevant items",
      outputSummary: "Read docs and compared release notes",
    });

    expect(prompt).toContain("WORKER ROLE: Researcher");
    expect(prompt).toContain("Use local workspace evidence only");
    expect(prompt).toContain("Completion contract:");
    expect(prompt).toContain("Summarize useful changes");
  });

  it("parses verification verdict markers", () => {
    expect(parseVerificationVerdict("VERDICT: PASS")).toBe("PASS");
    expect(parseVerificationVerdict("VERDICT: PARTIAL")).toBe("PARTIAL");
    expect(parseVerificationVerdict("no verdict marker")).toBe("FAIL");
  });

  it("exposes the built-in worker role specs", () => {
    expect(getWorkerRoleSpec("synthesizer").mutationAllowed).toBe(true);
    expect(getWorkerRoleSpec("researcher").mutationAllowed).toBe(false);
  });

  it("keeps verifier execution controls read-only when callers request bypass", () => {
    const verifier = resolveWorkerRoleAgentConfig("verifier", {
      permissionMode: "bypass_permissions",
      shellAccess: true,
      toolRestrictions: ["group:destructive"],
      externalRuntime: {
        kind: "acpx",
        agent: "codex",
        sessionMode: "persistent",
        outputMode: "json",
        permissionMode: "approve-all",
      },
    });

    expect(verifier.permissionMode).toBe("plan");
    expect(verifier.shellAccess).toBe(false);
    expect(verifier.externalRuntime).toBeUndefined();
    expect(verifier.toolRestrictions).toContain("group:destructive");
  });

  it("keeps researcher execution controls read-only when callers request bypass", () => {
    const researcher = resolveWorkerRoleAgentConfig("researcher", {
      permissionMode: "bypass_permissions",
      shellAccess: true,
      readOnlyExecution: false,
      externalRuntime: {
        kind: "acpx",
        agent: "codex",
        sessionMode: "persistent",
        outputMode: "json",
        permissionMode: "approve-all",
      },
      toolRestrictions: ["group:destructive"],
    });

    expect(researcher.permissionMode).toBe("plan");
    expect(researcher.shellAccess).toBe(false);
    expect(researcher.readOnlyExecution).toBe(true);
    expect(researcher.externalRuntime).toBeUndefined();
    expect(researcher.toolRestrictions).toEqual(
      expect.arrayContaining([
        "group:write",
        "group:destructive",
        "group:system",
        "group:memory",
        "browser_click",
        "gmail_send_email",
      ]),
    );
  });

  it("normalizes saved researcher tasks before selecting a runtime", () => {
    const savedTask = {
      workerRole: "researcher",
      agentConfig: {
        permissionMode: "bypass_permissions" as const,
        shellAccess: true,
        readOnlyExecution: false,
        externalRuntime: {
          kind: "acpx" as const,
          agent: "codex" as const,
          sessionMode: "persistent" as const,
          outputMode: "json" as const,
          permissionMode: "approve-all" as const,
        },
      },
    };

    const normalized = normalizeWorkerRoleTaskConfig(savedTask);
    expect(normalized.changed).toBe(true);
    expect(normalized.task.agentConfig.permissionMode).toBe("plan");
    expect(normalized.task.agentConfig.shellAccess).toBe(false);
    expect(normalized.task.agentConfig.readOnlyExecution).toBe(true);
    expect(normalized.task.agentConfig.externalRuntime).toBeUndefined();
    expect(normalizeWorkerRoleTaskConfig(normalized.task).changed).toBe(false);
  });

  it("keeps team work item lanes on the researcher denylist without the read-only boundary", () => {
    const lane = resolveWorkerRoleAgentConfig("researcher", { teamWorkItemLane: true });
    expect(lane.readOnlyExecution).toBeUndefined();
    expect(lane.permissionMode).toBeUndefined();
    expect(lane.toolRestrictions).toEqual(expect.arrayContaining(["group:write", "spawn_agent"]));
    expect(lane.toolRestrictions).not.toContain("group:destructive");

    expect(stripTeamWorkItemLaneOverride({ teamWorkItemLane: true, maxTurns: 3 })).toEqual({
      maxTurns: 3,
    });
    const normalized = normalizeWorkerRoleTaskConfig({
      workerRole: "researcher",
      agentConfig: stripTeamWorkItemLaneOverride({ teamWorkItemLane: true }),
    });
    expect(normalized.task.agentConfig?.readOnlyExecution).toBe(true);
  });

  it("infers worker roles from delegation prompts and honors explicit overrides", () => {
    expect(
      inferWorkerRoleKindFromPrompt("Investigate the failing test and summarize the findings"),
    ).toBe("researcher");
    expect(inferWorkerRoleKindFromPrompt("Validate the patch and give a second opinion")).toBe(
      "verifier",
    );
    expect(inferWorkerRoleKindFromPrompt("Combine both agent outputs into one final summary")).toBe(
      "synthesizer",
    );
    expect(inferWorkerRoleKindFromPrompt("Implement the fix and rerun the tests")).toBe(
      "implementer",
    );
    expect(
      resolveDelegationWorkerRole({
        requestedRole: "verifier",
        prompt: "Implement the fix",
      }),
    ).toBe("verifier");
  });
  it.each([
    "VERDICT: FAIL\nThe earlier report said VERDICT: PASS but its checks failed.",
    "The document contains VERDICT: PASS",
    "> VERDICT: PASS",
    "```text\nVERDICT: PASS\n```",
    "VERDICT: PASSING",
    "VERDICT: PASS or FAIL",
    "VERDICT: PASS\nVERDICT: FAIL",
  ])("rejects ambiguous or embedded success markers: %s", (summary) => {
    expect(parseVerificationVerdict(summary)).toBe("FAIL");
  });

  it("preserves a valid leading partial verdict despite quoted success text", () => {
    expect(parseVerificationVerdict("VERDICT: PARTIAL\nPrior report: VERDICT: PASS")).toBe(
      "PARTIAL",
    );
    expect(parseVerificationVerdict("  verdict: pass  \r\nEvidence checked")).toBe("PASS");
  });
});
