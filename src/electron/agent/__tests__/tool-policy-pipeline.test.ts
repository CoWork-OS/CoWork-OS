import { describe, expect, it, vi } from "vitest";

vi.mock("../../security/policy-manager", () => ({
  isToolAllowedQuick: vi.fn(() => true),
}));

vi.mock("../../security/monty-tool-policy", () => ({
  evaluateMontyToolPolicy: vi.fn(async () => ({ decision: "pass", reason: null })),
}));

import { evaluateToolPolicyPipeline } from "../runtime/ToolPolicyPipeline";
import { PermissionEngine } from "../runtime/PermissionEngine";

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

  it("requires approval for runtime metadata approval when permissions are unavailable", async () => {
    const result = await evaluateToolPolicyPipeline({
      workspace,
      toolName: "custom_sensitive_tool",
      toolInput: { target: "external-system" },
      approvalRequired: true,
    });

    expect(result.decision).toBe("require_approval");
    expect(result.reason).toBe("approval required by runtime metadata");
    expect(result.trace.finalDecision).toBe("require_approval");
    expect(result.trace.entries).toContainEqual(
      expect.objectContaining({
        stage: "approval",
        decision: "require_approval",
        reason: "approval required by runtime metadata",
      }),
    );
  });

  it("preserves runtime data_export approval semantics for custom tools", async () => {
    const permissionEvaluation = vi.fn(async (opts?: { approvalType?: string | null }) => ({
      decision: opts?.approvalType === "data_export" ? ("ask" as const) : ("allow" as const),
      reason:
        opts?.approvalType === "data_export"
          ? {
              type: "mode" as const,
              mode: "dont_ask",
              summary: "Data export always requires an explicit prompt, even in bypass modes.",
            }
          : {
              type: "mode" as const,
              mode: "dont_ask",
              summary: "Mode allows the action unless a higher-precedence hard policy blocks it.",
            },
      suggestions: [],
      scopePreview: "custom_data_export_tool",
    }));

    const result = await evaluateToolPolicyPipeline({
      workspace,
      toolName: "custom_data_export_tool",
      toolInput: { target: "external-system" },
      approvalRequired: true,
      runtimeApprovalType: "data_export",
      permissionApprovalType: "data_export",
      permissionEvaluation,
    });

    expect(result.decision).toBe("require_approval");
    expect(result.reason).toBe(
      "Data export always requires an explicit prompt, even in bypass modes.",
    );
    expect(result.trace.finalDecision).toBe("require_approval");
    expect(permissionEvaluation).toHaveBeenCalledWith({ approvalType: "data_export" });
  });

  it("preserves destructive runtime approval semantics for custom tools", async () => {
    const permissionEvaluation = vi.fn(async (opts?: { approvalType?: string | null }) =>
      PermissionEngine.evaluate({
        workspace,
        toolName: "custom_destructive_tool",
        toolInput: { target: "external-system" },
        mode: "default",
        rules: [],
        approvalType: opts?.approvalType as Any,
      }),
    );

    const result = await evaluateToolPolicyPipeline({
      workspace,
      toolName: "custom_destructive_tool",
      toolInput: { target: "external-system" },
      approvalRequired: true,
      runtimeApprovalType: "delete_file",
      permissionApprovalType: "delete_file",
      permissionEvaluation,
    });

    expect(result.decision).toBe("require_approval");
    expect(result.reason).toBe("Default mode prompts for writes, deletes, shell, and external effects.");
    expect(result.trace.finalDecision).toBe("require_approval");
    expect(result.trace.entries).toContainEqual(
      expect.objectContaining({
        stage: "permissions",
        decision: "require_approval",
        reason: "Default mode prompts for writes, deletes, shell, and external effects.",
      }),
    );
    expect(permissionEvaluation).toHaveBeenCalledWith({ approvalType: "delete_file" });
  });

  it("does not force runtime approval for ordinary permission approval types", async () => {
    const permissionEvaluation = vi.fn(async () => ({
      decision: "allow" as const,
      reason: {
        type: "mode" as const,
        mode: "default",
        summary: "Allowed by explicit test permission.",
      },
      suggestions: [],
      scopePreview: "web_fetch",
    }));

    const result = await evaluateToolPolicyPipeline({
      workspace,
      toolName: "web_fetch",
      toolInput: { url: "https://example.com" },
      approvalRequired: false,
      permissionApprovalType: "network_access",
      permissionEvaluation,
    });

    expect(result.decision).toBe("allow");
    expect(result.trace.finalDecision).toBe("allow");
    expect(result.trace.entries).toContainEqual(
      expect.objectContaining({
        stage: "approval",
        decision: "allow",
      }),
    );
    expect(permissionEvaluation).toHaveBeenCalledWith({ approvalType: "network_access" });
  });

  it("requires runtime metadata approval after permissive permission evaluation", async () => {
    const permissionEvaluation = vi.fn(async () => ({
      decision: "allow" as const,
      reason: {
        type: "mode" as const,
        mode: "default",
        summary: "Allowed by explicit test permission.",
      },
      suggestions: [],
      scopePreview: "custom_sensitive_tool",
    }));

    const result = await evaluateToolPolicyPipeline({
      workspace,
      toolName: "custom_sensitive_tool",
      toolInput: { target: "external-system" },
      approvalRequired: true,
      permissionEvaluation,
    });

    expect(result.decision).toBe("require_approval");
    expect(result.reason).toBe("approval required by runtime metadata");
    expect(result.trace.finalDecision).toBe("require_approval");
    expect(result.trace.entries).toContainEqual(
      expect.objectContaining({
        stage: "approval",
        decision: "require_approval",
        reason: "approval required by runtime metadata",
      }),
    );
    expect(permissionEvaluation).toHaveBeenCalled();
  });
});
