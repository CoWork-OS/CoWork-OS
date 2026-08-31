import { describe, expect, it } from "vitest";

import {
  buildWorkerRolePrompt,
  getWorkerRoleSpec,
  inferWorkerRoleKindFromPrompt,
  parseVerificationVerdict,
  resolveDelegationWorkerRole,
  resolveDefaultWorkerRoleKind,
  resolveWorkerRoleAgentConfig,
} from "../worker-role-registry";

describe("worker-role-registry", () => {
  it("keeps implementer as the default and verifier read-only", () => {
    expect(resolveDefaultWorkerRoleKind()).toBe("implementer");

    const verifier = resolveWorkerRoleAgentConfig("verifier", {});
    expect(verifier.executionMode).toBe("verified");
    expect(verifier.allowUserInput).toBe(false);
    expect(verifier.toolRestrictions).toEqual(
      expect.arrayContaining(["group:write", "spawn_agent"]),
    );
    expect(verifier.toolRestrictions).not.toContain("group:destructive");

    const researcher = resolveWorkerRoleAgentConfig("researcher", {});
    expect(researcher.toolRestrictions).toContain("delete_file");
    expect(researcher.toolRestrictions).not.toContain("group:destructive");
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
});
