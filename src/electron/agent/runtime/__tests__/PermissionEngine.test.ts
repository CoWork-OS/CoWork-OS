import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PermissionRule, Workspace } from "../../../../shared/types";
import { PermissionEngine } from "../PermissionEngine";

const workspace: Workspace = {
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
};

function evaluate(input: Partial<Parameters<typeof PermissionEngine.evaluate>[0]> = {}) {
  return PermissionEngine.evaluate({
    workspace,
    toolName: "read_file",
    mode: "default",
    rules: [],
    ...input,
  });
}

describe("PermissionEngine", () => {
  it("applies explicit tool rules", () => {
    const result = evaluate({
      toolName: "open_url",
      rules: [
        {
          source: "profile",
          effect: "deny",
          scope: { kind: "tool", toolName: "open_url" },
        },
      ],
    });

    expect(result.decision).toBe("deny");
    expect(result.reason.type).toBe("rule");
    expect(result.matchedRule?.source).toBe("profile");
  });

  it("prefers the most specific matching path rule", () => {
    const filePath = path.resolve("/tmp/workspace/src/runtime/engine.ts");
    const rules: PermissionRule[] = [
      {
        source: "profile",
        effect: "allow",
        scope: { kind: "path", toolName: "edit_file", path: "/tmp/workspace/src" },
      },
      {
        source: "workspace_db",
        effect: "deny",
        scope: { kind: "path", toolName: "edit_file", path: "/tmp/workspace/src/runtime" },
      },
    ];

    const result = evaluate({
      toolName: "edit_file",
      mode: "accept_edits",
      path: filePath,
      rules,
    });

    expect(result.decision).toBe("deny");
    expect(result.matchedRule?.source).toBe("workspace_db");
    expect(result.scopePreview).toContain(filePath);
  });

  it("matches normalized command prefixes", () => {
    const result = evaluate({
      toolName: "run_command",
      approvalType: "run_command",
      command: "git    status   --short",
      rules: [
        {
          source: "session",
          effect: "allow",
          scope: { kind: "command_prefix", prefix: "git status" },
        },
      ],
    });

    expect(result.decision).toBe("allow");
    expect(result.matchedRule?.scope.kind).toBe("command_prefix");
  });

  it("prefers a more specific rule over a higher-priority source", () => {
    const result = evaluate({
      toolName: "run_command",
      approvalType: "run_command",
      command: "git status --short",
      rules: [
        {
          source: "session",
          effect: "allow",
          scope: { kind: "command_prefix", prefix: "git status" },
        },
        {
          source: "workspace_db",
          effect: "deny",
          scope: { kind: "command_prefix", prefix: "git status --short" },
        },
      ],
    });

    expect(result.decision).toBe("deny");
    expect(result.matchedRule).toEqual(
      expect.objectContaining({
        source: "workspace_db",
        effect: "deny",
      }),
    );
  });

  it("matches MCP server rules", () => {
    const result = evaluate({
      toolName: "mcp_fetch_issue",
      serverName: "GitHub",
      rules: [
        {
          source: "workspace_manifest",
          effect: "deny",
          scope: { kind: "mcp_server", serverName: "github" },
        },
      ],
    });

    expect(result.decision).toBe("deny");
    expect(result.matchedRule?.scope.kind).toBe("mcp_server");
  });

  it("uses mode defaults when no explicit rule matches", () => {
    expect(
      evaluate({
        toolName: "read_file",
        mode: "plan",
      }).decision,
    ).toBe("allow");

    expect(
      evaluate({
        toolName: "edit_file",
        mode: "plan",
      }).decision,
    ).toBe("deny");

    expect(
      evaluate({
        toolName: "edit_file",
        mode: "accept_edits",
      }).decision,
    ).toBe("allow");

    expect(
      evaluate({
        toolName: "edit_file",
        mode: "dangerous_only",
      }).decision,
    ).toBe("allow");

    expect(
      evaluate({
        toolName: "open_url",
        mode: "default",
      }).decision,
    ).toBe("ask");

    expect(
      evaluate({
        toolName: "open_url",
        mode: "dont_ask",
      }).decision,
    ).toBe("allow");

    expect(
      evaluate({
        toolName: "open_url",
        mode: "bypass_permissions",
      }).decision,
    ).toBe("allow");

    expect(
      evaluate({
        toolName: "http_request",
        approvalType: "data_export",
        mode: "dont_ask",
        toolInput: {
          url: "https://api.example.com/export",
          method: "POST",
          body: "payload",
        },
      }).decision,
    ).toBe("ask");
  });

  it("allows safe commands and read-only tools in dangerous_only mode", () => {
    expect(
      evaluate({
        toolName: "run_command",
        approvalType: "run_command",
        command: "npm test -- --runInBand",
        mode: "dangerous_only",
      }).decision,
    ).toBe("allow");

    expect(
      evaluate({
        toolName: "read_file",
        mode: "dangerous_only",
      }).decision,
    ).toBe("allow");
  });

  it("prompts for privacy-sensitive or ambiguous reads in dangerous_only mode", () => {
    expect(
      evaluate({
        toolName: "read_clipboard",
        mode: "dangerous_only",
      }).decision,
    ).toBe("ask");

    expect(
      evaluate({
        toolName: "browser_get_content",
        mode: "dangerous_only",
      }).decision,
    ).toBe("ask");

    expect(
      evaluate({
        toolName: "screenshot",
        approvalType: "computer_use",
        mode: "dangerous_only",
      }).decision,
    ).toBe("ask");
  });

  it("prompts for destructive or ambiguous actions in dangerous_only mode", () => {
    expect(
      evaluate({
        toolName: "delete_file",
        approvalType: "delete_file",
        mode: "dangerous_only",
      }).decision,
    ).toBe("ask");

    expect(
      evaluate({
        toolName: "run_command",
        approvalType: "run_command",
        command: "rm -rf dist",
        mode: "dangerous_only",
      }).decision,
    ).toBe("ask");

    expect(
      evaluate({
        toolName: "http_request",
        toolInput: {
          url: "https://example.com/api",
          method: "POST",
        },
        mode: "dangerous_only",
      }).decision,
    ).toBe("ask");

    expect(
      evaluate({
        toolName: "mcp_fetch_issue",
        serverName: "github",
        mode: "dangerous_only",
      }).decision,
    ).toBe("ask");

    expect(
      evaluate({
        toolName: "run_applescript",
        mode: "dangerous_only",
      }).decision,
    ).toBe("ask");

    expect(
      evaluate({
        toolName: "run_command",
        approvalType: "run_command",
        command: "npm install",
        mode: "dangerous_only",
      }).decision,
    ).toBe("ask");
  });

  it("allows read-only network tools in default mode when network permission is enabled", () => {
    const result = evaluate({
      toolName: "web_fetch",
      mode: "default",
    });

    expect(result.decision).toBe("allow");
    expect(result.reason.type).toBe("mode");
  });

  it("still enforces workspace network permission for network read tools", () => {
    const result = evaluate({
      workspace: {
        ...workspace,
        permissions: {
          ...workspace.permissions,
          network: false,
        },
      },
      toolName: "web_fetch",
      mode: "default",
    });

    expect(result.decision).toBe("deny");
    expect(result.reason.type).toBe("workspace_capability");
    expect(result.reason.summary).toContain("network");
  });

  it("treats GET http_request as read-only network access in default mode", () => {
    const result = evaluate({
      toolName: "http_request",
      mode: "default",
      toolInput: {
        url: "https://example.com/api",
        method: "GET",
      },
    });

    expect(result.decision).toBe("allow");
    expect(result.reason.type).toBe("mode");
  });

  it("treats mutating http_request methods as approval-worthy external side effects", () => {
    const result = evaluate({
      toolName: "http_request",
      approvalType: "data_export",
      mode: "default",
      toolInput: {
        url: "https://example.com/api",
        method: "POST",
        body: '{"name":"test"}',
      },
    });

    expect(result.decision).toBe("ask");
    expect(result.reason.type).toBe("mode");
    expect(result.suggestions.some((entry) => entry.action === "allow_profile")).toBe(false);
  });

  it("infers a domain scope for network and export requests", () => {
    const readResult = evaluate({
      toolName: "web_fetch",
      approvalType: "network_access",
      mode: "default",
      toolInput: {
        url: "https://docs.example.com/page",
      },
    });
    const exportResult = evaluate({
      toolName: "http_request",
      approvalType: "data_export",
      mode: "default",
      toolInput: {
        url: "https://api.example.com/export",
        method: "POST",
        body: "payload",
      },
      rules: [
        {
          source: "session",
          effect: "allow",
          scope: {
            kind: "domain",
            toolName: "http_request",
            domain: "api.example.com",
          },
        },
      ],
    });

    expect(PermissionEngine.inferScope({
      workspace,
      toolName: "web_fetch",
      approvalType: "network_access",
      mode: "default",
      rules: [],
      toolInput: { url: "https://docs.example.com/page" },
    })).toEqual({
      kind: "domain",
      toolName: "web_fetch",
      domain: "docs.example.com",
    });
    expect(exportResult.decision).toBe("allow");
    expect(readResult.scopePreview).toContain("docs.example.com");
  });

  it("treats browser navigation as a mutating action in default mode", () => {
    const result = evaluate({
      toolName: "browser_navigate",
      mode: "default",
    });

    expect(result.decision).toBe("ask");
    expect(result.reason.type).toBe("mode");
  });

  it("prompts for non-workspace browser and system tools in accept_edits mode", () => {
    expect(
      evaluate({
        toolName: "browser_navigate",
        mode: "accept_edits",
      }).decision,
    ).toBe("ask");

    expect(
      evaluate({
        toolName: "canvas_snapshot",
        mode: "accept_edits",
      }).decision,
    ).toBe("ask");

    expect(
      evaluate({
        toolName: "open_url",
        mode: "accept_edits",
      }).decision,
    ).toBe("ask");

    expect(
      evaluate({
        toolName: "screenshot",
        mode: "accept_edits",
        approvalType: "computer_use",
      }).decision,
    ).toBe("ask");
  });

  it("prompts for read-only browser and system tools in default mode", () => {
    expect(
      evaluate({
        toolName: "browser_get_content",
        mode: "default",
      }).decision,
    ).toBe("ask");

    expect(
      evaluate({
        toolName: "read_clipboard",
        mode: "default",
      }).decision,
    ).toBe("ask");
  });

  it("does not treat read-only system tools as workspace writes", () => {
    const result = evaluate({
      workspace: {
        ...workspace,
        permissions: {
          ...workspace.permissions,
          write: false,
        },
      },
      toolName: "read_clipboard",
      mode: "default",
    });

    expect(result.decision).toBe("ask");
    expect(result.reason.type).toBe("mode");
  });

  it("treats generated documents as file mutations in default mode", () => {
    const result = evaluate({
      toolName: "generate_document",
      mode: "default",
    });

    expect(result.decision).toBe("ask");
    expect(result.reason.type).toBe("mode");
  });

  it("switches repeated soft denials into explicit prompts", () => {
    const result = evaluate({
      toolName: "open_url",
      mode: "plan",
      denyState: {
        consecutiveDenials: 3,
        totalDenials: 3,
      },
    });

    expect(result.decision).toBe("ask");
    expect(result.reason.type).toBe("denial_fallback");
  });

  it("does not fallback hard guardrail denials", () => {
    const result = evaluate({
      toolName: "run_command",
      approvalType: "run_command",
      command: "rm -rf /",
      denyState: {
        consecutiveDenials: 99,
        totalDenials: 99,
      },
    });

    expect(result.decision).toBe("deny");
    expect(result.reason.type).toBe("guardrail");
  });
});
