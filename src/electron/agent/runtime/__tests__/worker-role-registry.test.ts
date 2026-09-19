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
