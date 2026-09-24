import { describe, expect, it, vi } from "vitest";
import type { ApprovalType } from "../../../shared/types";

vi.mock("../../security/policy-manager", () => ({
  isToolAllowedQuick: vi.fn(() => true),
}));

vi.mock("../../security/monty-tool-policy", () => ({
  evaluateMontyToolPolicy: vi.fn(async () => ({ decision: "pass", reason: null })),
  TOOL_POLICY_UNAVAILABLE_REASON: "workspace tool policy unavailable",
}));

import {
  evaluateMontyToolPolicy,
  TOOL_POLICY_UNAVAILABLE_REASON,
} from "../../security/monty-tool-policy";
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

  it("treats a configured empty allow-list as deny-all at execution time", async () => {
    const result = await evaluateToolPolicyPipeline({
      workspace,
      toolName: "read_file",
      toolInput: { path: "foo.ts" },
      allowedTools: new Set(),
    });

    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("tool not present in task allowlist");
  });

  it("treats an absent allow-list as no restriction", async () => {
    const result = await evaluateToolPolicyPipeline({
      workspace,
      toolName: "read_file",
      toolInput: { path: "foo.ts" },
      // allowedTools intentionally omitted (undefined) — means "no allowlist".
    });

    expect(result.decision).toBe("allow");
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
    expect(result.trace.entries).toContainEqual(
      expect.objectContaining({
        stage: "permissions",
        metadata: expect.objectContaining({
          runtimeApprovalType: "data_export",
          requestedPermissionApprovalType: "data_export",
          resolvedPermissionApprovalType: "data_export",
        }),
      }),
    );
    expect(permissionEvaluation).toHaveBeenCalledWith({ approvalType: "data_export" });
  });

  it("preserves destructive runtime approval semantics for custom tools", async () => {
    const permissionEvaluation = vi.fn(async (opts?: { approvalType?: ApprovalType | null }) =>
      PermissionEngine.evaluate({
        workspace,
        toolName: "custom_destructive_tool",
        toolInput: { target: "external-system" },
        mode: "default",
        rules: [],
        approvalType: opts?.approvalType ?? undefined,
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
    expect(result.reason).toBe(
      "Default mode prompts for writes, deletes, shell, and external effects.",
    );
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

  it("records advisory semantic review only after hard policy and permission allow", async () => {
    const order: string[] = [];
    const semanticReviewEvaluation = vi.fn(async () => {
      order.push("semantic_review");
      return {
        status: "concerning" as const,
        reasonCodes: ["possible_sensitive_export"],
        model: "jev-latest",
        latencyMs: 12,
        stateDigest: "digest-1",
      };
    });
    const permissionEvaluation = vi.fn(async () => {
      order.push("permissions");
      return {
        decision: "allow" as const,
        reason: {
          type: "mode" as const,
          mode: "dont_ask" as const,
          summary: "Permission mode allows this tool.",
        },
        suggestions: [],
        scopePreview: "http_request",
      };
    });

    const result = await evaluateToolPolicyPipeline({
      workspace,
      toolName: "http_request",
      toolInput: { method: "POST" },
      permissionEvaluation,
      semanticReviewEvaluation,
    });

    expect(result.decision).toBe("allow");
    expect(order).toEqual(["permissions", "semantic_review"]);
    expect(result.trace.finalDecision).toBe("allow");
    expect(result.trace.entries).toContainEqual(
      expect.objectContaining({
        stage: "semantic_review",
        decision: "allow",
        metadata: expect.objectContaining({
          mode: "observe",
          status: "concerning",
          reasonCodes: ["possible_sensitive_export"],
          stateDigest: "digest-1",
        }),
      }),
    );
  });

  it("uses active semantic review to require the existing approval path", async () => {
    const semanticReviewEvaluation = vi.fn(async () => ({
      mode: "active" as const,
      status: "concerning" as const,
      reasonCodes: ["possible_sensitive_export"],
      model: "jev-latest",
    }));

    const result = await evaluateToolPolicyPipeline({
      workspace,
      toolName: "http_request",
      toolInput: { method: "POST" },
      permissionEvaluation: async () => ({
        decision: "allow" as const,
        reason: {
          type: "mode" as const,
          mode: "dont_ask" as const,
          summary: "Permission mode allows this tool.",
        },
        suggestions: [],
        scopePreview: "http_request",
      }),
      semanticReviewEvaluation,
    });

    expect(result.decision).toBe("require_approval");
    expect(result.approvalSource).toBe("semantic_review");
    expect(result.trace.finalDecision).toBe("require_approval");
    expect(result.trace.entries).toContainEqual(
      expect.objectContaining({
        stage: "semantic_review",
        decision: "require_approval",
        metadata: expect.objectContaining({ mode: "active", status: "concerning" }),
      }),
    );
  });

  it("keeps explicit headless full authority from becoming a second Jev prompt", async () => {
    const result = await evaluateToolPolicyPipeline({
      workspace,
      toolName: "write_file",
      toolInput: { path: "notes.md", content: "hello" },
      permissionEvaluation: async () => ({
        decision: "allow" as const,
        reason: {
          type: "mode" as const,
          mode: "bypass_permissions" as const,
          summary: "Full access explicitly authorizes this workspace write.",
        },
        suggestions: [],
        scopePreview: "write_file",
      }),
      semanticReviewEvaluation: async () => ({
        mode: "active" as const,
        status: "concerning" as const,
        reasonCodes: ["consequential_change"],
        model: "jev-latest",
      }),
      headlessSemanticReviewPolicy: "allow_if_authorized",
    });

    expect(result.decision).toBe("allow");
    expect(result.approvalSource).toBeUndefined();
    expect(result.trace.finalDecision).toBe("allow");
    expect(result.trace.entries).toContainEqual(
      expect.objectContaining({
        stage: "semantic_review",
        decision: "allow",
        reason: "Jev concern recorded; explicit headless authority remains authoritative",
        metadata: expect.objectContaining({ mode: "active", status: "concerning" }),
      }),
    );
  });

  it("does not add a second approval gate when the semantic reviewer is unavailable", async () => {
    const result = await evaluateToolPolicyPipeline({
      workspace,
      toolName: "http_request",
      toolInput: { method: "POST" },
      permissionEvaluation: async () => ({
        decision: "allow" as const,
        reason: {
          type: "mode" as const,
          mode: "dont_ask" as const,
          summary: "Permission mode allows this tool.",
        },
        suggestions: [],
        scopePreview: "http_request",
      }),
      semanticReviewMode: "active",
      semanticReviewEvaluation: async () => {
        throw new Error("unexpected reviewer failure");
      },
    });

    expect(result.decision).toBe("allow");
    expect(result.approvalSource).toBeUndefined();
    expect(result.trace.entries).toContainEqual(
      expect.objectContaining({
        stage: "semantic_review",
        decision: "allow",
        metadata: expect.objectContaining({ mode: "active", status: "unavailable" }),
      }),
    );
  });

  it("lets deterministic policy remain authoritative for active uncertainty", async () => {
    const result = await evaluateToolPolicyPipeline({
      workspace,
      toolName: "write_file",
      toolInput: { path: "notes.md", content: "hello" },
      permissionEvaluation: async () => ({
        decision: "allow" as const,
        reason: {
          type: "mode" as const,
          mode: "dont_ask" as const,
          summary: "Permission mode allows this workspace write.",
        },
        suggestions: [],
        scopePreview: "write_file",
      }),
      semanticReviewEvaluation: async () => ({
        mode: "active" as const,
        status: "uncertain" as const,
        reasonCodes: ["state_incomplete"],
      }),
    });

    expect(result.decision).toBe("allow");
    expect(result.trace.entries).toContainEqual(
      expect.objectContaining({
        stage: "semantic_review",
        decision: "allow",
        metadata: expect.objectContaining({ mode: "active", status: "uncertain" }),
      }),
    );
  });

  it("does not run advisory review after a hard denial or approval request", async () => {
    const semanticReviewEvaluation = vi.fn(async () => ({ status: "benign" as const }));
    const denied = await evaluateToolPolicyPipeline({
      workspace,
      toolName: "run_command",
      toolInput: { command: "rm -rf draft" },
      deniedTools: new Set(["run_command"]),
      semanticReviewEvaluation,
    });
    expect(denied.decision).toBe("deny");
    expect(semanticReviewEvaluation).not.toHaveBeenCalled();

    const approval = await evaluateToolPolicyPipeline({
      workspace,
      toolName: "edit_file",
      toolInput: { path: "draft.ts" },
      permissionEvaluation: async () => ({
        decision: "ask" as const,
        reason: {
          type: "mode" as const,
          mode: "default" as const,
          summary: "Approval required.",
        },
        suggestions: [],
        scopePreview: "edit_file",
      }),
      semanticReviewEvaluation,
    });
    expect(approval.decision).toBe("require_approval");
    expect(semanticReviewEvaluation).not.toHaveBeenCalled();

    const runtimeReview = vi.fn(async () => ({
      status: "concerning" as const,
      reasonCodes: ["consequential_change"],
    }));
    const runtimeApproval = await evaluateToolPolicyPipeline({
      workspace,
      toolName: "run_command",
      toolInput: { command: "npm test" },
      approvalRequired: true,
      runtimeApprovalType: "run_command",
      permissionApprovalType: "run_command",
      permissionEvaluation: async () => ({
        decision: "allow" as const,
        reason: {
          type: "mode" as const,
          mode: "dont_ask" as const,
          summary: "Permission mode allows this tool.",
        },
        suggestions: [],
        scopePreview: "run_command",
      }),
      semanticReviewEvaluation: runtimeReview,
    });
    expect(runtimeApproval.decision).toBe("require_approval");
    expect(runtimeReview).toHaveBeenCalledTimes(1);
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

  it("keeps runtime approval required after permissive workspace policy", async () => {
    vi.mocked(evaluateMontyToolPolicy).mockResolvedValueOnce({
      decision: "allow",
      reason: "workspace policy allows this tool",
    });
    const permissionEvaluation = vi.fn(async () => ({
      decision: "allow" as const,
      reason: {
        type: "mode" as const,
        mode: "dont_ask",
        summary: "Permission mode allows this tool.",
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
      permissionEvaluation,
    });

    expect(result.decision).toBe("require_approval");
    expect(result.reason).toBe("approval required by runtime metadata");
    expect(result.trace.finalDecision).toBe("require_approval");
    expect(result.trace.entries).toContainEqual(
      expect.objectContaining({
        stage: "workspace_script",
        decision: "allow",
        reason: "workspace policy allows this tool",
      }),
    );
    expect(result.trace.entries).toContainEqual(
      expect.objectContaining({
        stage: "approval",
        decision: "require_approval",
        reason: "approval required by runtime metadata",
      }),
    );
    expect(permissionEvaluation).toHaveBeenCalledWith({ approvalType: "data_export" });
  });

  it("evaluates agent security after workspace policy and before permissions", async () => {
    const order: string[] = [];
    vi.mocked(evaluateMontyToolPolicy).mockImplementationOnce(async () => {
      order.push("workspace");
      return { decision: "pass", reason: null };
    });
    const agentSecurityEvaluation = vi.fn(async () => {
      order.push("agent_security");
      return {
        decision: "no_override" as const,
        health: "ok" as const,
        durationMs: 4,
      };
    });
    const permissionEvaluation = vi.fn(async () => {
      order.push("permissions");
      return {
        decision: "allow" as const,
        reason: {
          type: "mode" as const,
          mode: "dont_ask",
          summary: "Permission mode allows this tool.",
        },
        suggestions: [],
        scopePreview: "run_command",
      };
    });

    const result = await evaluateToolPolicyPipeline({
      workspace,
      toolName: "run_command",
      toolInput: { command: "git status" },
      agentSecurityEvaluation,
      permissionEvaluation,
    });

    expect(result.decision).toBe("allow");
    expect(order).toEqual(["workspace", "agent_security", "permissions"]);
    expect(result.trace.entries).toContainEqual(
      expect.objectContaining({
        stage: "agent_security",
        decision: "allow",
      }),
    );
  });

  it("treats an agent-security deny as monotonic and skips approval evaluation", async () => {
    const permissionEvaluation = vi.fn();
    const result = await evaluateToolPolicyPipeline({
      workspace,
      toolName: "run_command",
      toolInput: { command: "rm -rf /" },
      approvalRequired: true,
      agentSecurityEvaluation: async () => ({
        decision: "deny",
        health: "ok",
        reason: "Blocked by agent security.",
        decisionId: "decision-1",
        durationMs: 3,
      }),
      permissionEvaluation,
    });

    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("Blocked by agent security.");
    expect(result.agentSecurity?.decisionId).toBe("decision-1");
    expect(permissionEvaluation).not.toHaveBeenCalled();
    expect(result.trace.entries.some((entry) => entry.stage === "approval")).toBe(false);
  });

  it("fails closed when the workspace policy evaluator throws", async () => {
    vi.mocked(evaluateMontyToolPolicy).mockRejectedValueOnce(new Error("policy runtime failure"));

    const result = await evaluateToolPolicyPipeline({
      workspace,
      toolName: "read_file",
      toolInput: { path: "foo.ts" },
    });

    expect(result.decision).toBe("deny");
    expect(result.reason).toBe(TOOL_POLICY_UNAVAILABLE_REASON);
    expect(result.trace.entries).toContainEqual(
      expect.objectContaining({
        stage: "workspace_script",
        decision: "deny",
        reason: TOOL_POLICY_UNAVAILABLE_REASON,
      }),
    );
  });

  it("does not reinstate blanket shell approval after a named profile allows it", async () => {
    const result = await evaluateToolPolicyPipeline({
      workspace: {
        ...workspace,
        permissions: {
          ...workspace.permissions,
          accessProfileId: "ask_for_approval",
          accessApprovalPolicy: "on-request",
        },
      },
      toolName: "run_command",
      toolInput: { command: "npm test" },
      approvalRequired: true,
      runtimeApprovalType: "run_command",
      permissionApprovalType: "run_command",
      permissionEvaluation: async () => ({
        decision: "allow",
        reason: {
          type: "mode",
          mode: "default",
          summary: "Allowed inside the enforced workspace scope.",
        },
        suggestions: [],
        scopePreview: "npm test",
      }),
    });
    expect(result.decision).toBe("allow");
    expect(result.trace.entries.some((entry) => entry.decision === "require_approval")).toBe(false);
  });

  it.each(["permission", "workspace", "metadata"])(
    "never denies missing %s authority without asking",
    async (source) => {
      vi.mocked(evaluateMontyToolPolicy).mockResolvedValueOnce(
        source === "workspace"
          ? { decision: "require_approval", reason: "Explicit workspace consent" }
          : { decision: "pass", reason: null },
      );
      const result = await evaluateToolPolicyPipeline({
        workspace: {
          ...workspace,
          permissions: {
            ...workspace.permissions,
            accessProfileId: "bounded-no-prompts",
            accessApprovalPolicy: "never",
          },
        },
        toolName: "custom_action",
        toolInput: {},
        approvalRequired: source === "metadata",
        permissionEvaluation: async () => ({
          decision: source === "permission" ? "ask" : "allow",
          reason: { type: "mode", mode: "default", summary: "Extra authority needed" },
          suggestions: [],
          scopePreview: "custom_action",
        }),
      });
      expect(result.decision).toBe("deny");
    },
  );

  it("allows a credential-free bot research read when prompts are disabled", async () => {
    const previousPromptMode = process.env.COWORK_APPROVAL_PROMPTS;
    process.env.COWORK_APPROVAL_PROMPTS = "off";
    try {
      const result = await evaluateToolPolicyPipeline({
        workspace: {
          ...workspace,
          permissions: {
            ...workspace.permissions,
            accessApprovalPolicy: "on-request",
            accessNetworkMode: "on-request",
          },
        },
        toolName: "http_request",
        toolInput: { url: "https://docs.example.com/guide", method: "GET" },
        permissionEvaluation: async () => ({
          decision: "ask",
          reason: {
            type: "workspace_capability",
            capability: "network",
            summary: "The active access profile requires approval before internet access.",
          },
          suggestions: [],
          scopePreview: "domain docs.example.com",
        }),
        allowReadOnlyNetworkWhenApprovalDisabled: true,
      });

      expect(result.decision).toBe("allow");
      expect(result.trace.entries).toContainEqual(
        expect.objectContaining({
          stage: "approval",
          decision: "allow",
          metadata: expect.objectContaining({ source: "bot_research_read_lane" }),
        }),
      );
    } finally {
      if (previousPromptMode === undefined) delete process.env.COWORK_APPROVAL_PROMPTS;
      else process.env.COWORK_APPROVAL_PROMPTS = previousPromptMode;
    }
  });

  it("does not auto-authorize bot writes or credential-backed reads", async () => {
    const previousPromptMode = process.env.COWORK_APPROVAL_PROMPTS;
    process.env.COWORK_APPROVAL_PROMPTS = "off";
    try {
      for (const [toolName, toolInput] of [
        ["http_request", { url: "https://api.example.com", method: "POST", body: "x" }],
        ["http_request", { url: "https://api.example.com", method: "GET", credentialId: "secret" }],
        ["web_fetch", { url: "https://api.example.com", credentialId: "secret" }],
      ] as const) {
        const result = await evaluateToolPolicyPipeline({
          workspace: {
            ...workspace,
            permissions: {
              ...workspace.permissions,
              accessApprovalPolicy: "on-request",
              accessNetworkMode: "on-request",
            },
          },
          toolName,
          toolInput,
          permissionEvaluation: async () => ({
            decision: "ask",
            reason: {
              type: "workspace_capability",
              capability: "network",
              summary: "The active access profile requires approval before internet access.",
            },
            suggestions: [],
            scopePreview: "network boundary",
          }),
          allowReadOnlyNetworkWhenApprovalDisabled: true,
        });

        expect(result.decision, toolName).toBe("deny");
        expect(result.reason).toContain("approval requests are disabled");
      }
    } finally {
      if (previousPromptMode === undefined) delete process.env.COWORK_APPROVAL_PROMPTS;
      else process.env.COWORK_APPROVAL_PROMPTS = previousPromptMode;
    }
  });

  it("keeps the boundary reason when an approval cannot be requested", async () => {
    const previousPromptMode = process.env.COWORK_APPROVAL_PROMPTS;
    process.env.COWORK_APPROVAL_PROMPTS = "off";
    try {
      const result = await evaluateToolPolicyPipeline({
        workspace,
        toolName: "write_file",
        toolInput: { path: "/tmp/other-workspace/report.md", content: "test" },
        permissionEvaluation: async () => ({
          decision: "ask",
          reason: {
            type: "workspace_capability",
            capability: "write",
            summary: "The requested path is outside the active workspace boundary.",
          },
          suggestions: [],
          scopePreview: "write_file outside workspace",
        }),
      });

      expect(result.decision).toBe("deny");
      expect(result.reason).toContain("approval requests are disabled");
      expect(result.reason).toContain("outside the active workspace boundary");
    } finally {
      if (previousPromptMode === undefined) delete process.env.COWORK_APPROVAL_PROMPTS;
      else process.env.COWORK_APPROVAL_PROMPTS = previousPromptMode;
    }
  });

  it("fails closed for malformed credential, body, and header inputs", async () => {
    const previousPromptMode = process.env.COWORK_APPROVAL_PROMPTS;
    process.env.COWORK_APPROVAL_PROMPTS = "off";
    try {
      for (const [toolName, toolInput] of [
        ["http_request", { url: "https://api.example.com", method: "GET", credentialId: 1 }],
        ["http_request", { url: "https://api.example.com", method: "GET", body: {} }],
        ["http_request", { url: "https://api.example.com", method: "GET", headers: [] }],
        ["web_fetch", { url: "https://api.example.com", credentialId: { id: "secret" } }],
        ["web_fetch", {}],
        ["web_fetch", []],
        ["http_request", { method: "GET" }],
      ] as const) {
        const result = await evaluateToolPolicyPipeline({
          workspace: {
            ...workspace,
            permissions: {
              ...workspace.permissions,
              accessApprovalPolicy: "on-request",
              accessNetworkMode: "on-request",
            },
          },
          toolName,
          toolInput,
          permissionEvaluation: async () => ({
            decision: "ask",
            reason: {
              type: "workspace_capability",
              capability: "network",
              summary: "The active access profile requires approval before internet access.",
            },
            suggestions: [],
            scopePreview: "network boundary",
          }),
          allowReadOnlyNetworkWhenApprovalDisabled: true,
        });

        expect(result.decision, toolName).toBe("deny");
      }
    } finally {
      if (previousPromptMode === undefined) delete process.env.COWORK_APPROVAL_PROMPTS;
      else process.env.COWORK_APPROVAL_PROMPTS = previousPromptMode;
    }
  });
});
