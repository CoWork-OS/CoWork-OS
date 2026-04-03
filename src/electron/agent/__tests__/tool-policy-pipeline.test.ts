import { describe, expect, it, vi } from "vitest";

vi.mock("../../security/policy-manager", () => ({
  isToolAllowedQuick: vi.fn(() => true),
}));

vi.mock("../../security/monty-tool-policy", () => ({
  evaluateMontyToolPolicy: vi.fn(async () => ({ decision: "pass", reason: null })),
}));

import { evaluateToolPolicyPipeline } from "../runtime/ToolPolicyPipeline";

describe("ToolPolicyPipeline", () => {
  const workspace = {
    id: "workspace-1",
    name: "Workspace",
    path: "/tmp/workspace",
    permissions: {
      read: true,
      write: true,
      delete: true,
      network: true,
      shell: true,
    },
    createdAt: Date.now(),
  } as Any;

  it("produces an allow trace for a permitted tool", async () => {
    const result = await evaluateToolPolicyPipeline({
      workspace,
      toolName: "read_file",
      toolInput: { path: "foo.ts" },
      policyContext: {
        executionMode: "execute",
        taskDomain: "code",
        shellEnabled: true,
      },
      availabilityContext: {
        executionMode: "execute",
        taskDomain: "code",
        shellEnabled: true,
        taskText: "read file",
      },
    });

    expect(result.decision).toBe("allow");
    expect(result.trace.entries.length).toBeGreaterThan(0);
    expect(result.trace.finalDecision).toBe("allow");
  });

  it("records the permissions stage and requires approval for ask decisions", async () => {
    const result = await evaluateToolPolicyPipeline({
      workspace,
      toolName: "edit_file",
      toolInput: { path: "foo.ts" },
      permissionEvaluation: async () => ({
        decision: "ask",
        reason: {
          type: "mode",
          mode: "default",
          summary: "Default mode prompts for edits.",
        },
        suggestions: [
          { action: "deny_once", label: "Deny once", effect: "deny" },
          { action: "allow_once", label: "Allow once", effect: "allow" },
        ],
        scopePreview: "edit_file on path /tmp/workspace/foo.ts",
      }),
    });

    expect(result.decision).toBe("require_approval");
    expect(result.trace.finalDecision).toBe("require_approval");
    expect(result.trace.entries.some((entry) => entry.stage === "permissions")).toBe(true);
  });
});
