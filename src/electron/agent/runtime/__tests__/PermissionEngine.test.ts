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

  it("allows approval-gated actions in bypass-permissions mode", () => {
    const cases = [
      evaluate({
        toolName: "run_command",
        approvalType: "run_command",
        command: "npm run build",
        mode: "bypass_permissions",
      }),
      evaluate({
        toolName: "gmail_action",
        approvalType: "external_service",
        mode: "bypass_permissions",
      }),
      evaluate({
        toolName: "http_request",
        approvalType: "data_export",
        mode: "bypass_permissions",
        toolInput: {
          url: "https://api.example.com/export",
          method: "POST",
          body: "payload",
        },
      }),
    ];

    expect(cases.map((result) => result.decision)).toEqual(["allow", "allow", "ask"]);
  });

  it("keeps protected credential actions explicitly approved and out of recurring suggestions", () => {
    for (const mode of ["default", "dont_ask", "bypass_permissions"] as const) {
      const result = evaluate({
        toolName: "http_request",
        approvalType: "protected_credential",
        mode,
        toolInput: {
          url: "https://api.example.com/items",
          credentialId: "credential-1",
        },
      });

      expect(result.decision).toBe("ask");
      expect(result.suggestions.map((suggestion) => suggestion.action)).not.toContain(
        "allow_recurring",
      );
    }
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

    expect(
      evaluate({
        toolName: "file_tools",
        approvalType: "external_file_access",
        mode: "dangerous_only",
        path: "/tmp/external-output.txt",
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

  it("prompts for one-time location access by default and disables persistent suggestions", () => {
    const result = evaluate({
      toolName: "get_current_location",
      approvalType: "location_access",
      mode: "default",
      allowPersistence: false,
    });

    expect(result.decision).toBe("ask");
    expect(result.scopePreview).toContain("get_current_location");
    expect(result.suggestions.map((entry) => entry.action)).toEqual(["deny_once", "allow_once"]);
  });

  it("does not allow location access through persisted rules or bypass modes", () => {
    const rules: PermissionRule[] = [
      {
        source: "session",
        effect: "allow",
        scope: { kind: "tool", toolName: "get_current_location" },
      },
    ];

    for (const mode of ["dont_ask", "bypass_permissions"] as const) {
      const result = evaluate({
        toolName: "get_current_location",
        approvalType: "location_access",
        mode,
        rules,
      });

      expect(result.decision).toBe("ask");
      expect(result.matchedRule).toBeUndefined();
      expect(result.suggestions.map((entry) => entry.action)).toEqual(["deny_once", "allow_once"]);
    }
  });

  it("denies location access when workspace network capability is disabled", () => {
    const result = evaluate({
      workspace: {
        ...workspace,
        permissions: {
          ...workspace.permissions,
          network: false,
        },
      },
      toolName: "get_current_location",
      approvalType: "location_access",
      mode: "default",
    });

    expect(result.decision).toBe("deny");
    expect(result.reason.type).toBe("workspace_capability");
    expect(result.reason.summary).toContain("network");
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

  it("requires approval for every external surface when the profile is on-request", () => {
    for (const toolName of ["web_search", "x_search", "open_url", "mcp_fetch_issue"]) {
      const result = evaluate({
        toolName,
        mode: "bypass_permissions",
        workspace: {
          ...workspace,
          permissions: { ...workspace.permissions, accessNetworkMode: "on-request" },
        },
        toolInput:
          toolName === "open_url"
            ? { url: "https://example.com" }
            : toolName === "web_search"
              ? { query: "example" }
              : undefined,
      });

      expect(result.decision, toolName).toBe("ask");
      expect(result.reason.type, toolName).toBe("workspace_capability");
    }
  });

  it("keeps an explicit network deny ahead of an on-request profile boundary", () => {
    const result = evaluate({
      toolName: "web_fetch",
      mode: "bypass_permissions",
      workspace: {
        ...workspace,
        permissions: { ...workspace.permissions, accessNetworkMode: "on-request" },
      },
      rules: [
        {
          source: "profile",
          effect: "deny",
          scope: { kind: "tool", toolName: "web_fetch" },
        },
      ],
    });

    expect(result.decision).toBe("deny");
    expect(result.reason.type).toBe("rule");
  });

  it("classifies network-capable tool groups as network access", () => {
    for (const toolName of [
      "generate_image",
      "generate_video",
      "scrape_page",
      "youtube_ingest_video",
    ]) {
      const result = evaluate({
        toolName,
        mode: "bypass_permissions",
        workspace: {
          ...workspace,
          permissions: { ...workspace.permissions, accessNetworkMode: "on-request" },
        },
      });

      expect(result.decision, toolName).toBe("ask");
      expect(result.reason.type, toolName).toBe("workspace_capability");
    }
  });

  it("treats execute_code allow_network as a network capability request", () => {
    const onRequest = evaluate({
      toolName: "execute_code",
      approvalType: "network_access",
      mode: "default",
      toolInput: { language: "javascript", code: "fetch(url)", allow_network: true },
      workspace: {
        ...workspace,
        permissions: { ...workspace.permissions, accessNetworkMode: "on-request" },
      },
    });
    expect(onRequest.decision).toBe("ask");
    expect(onRequest.reason.type).toBe("workspace_capability");

    const disabled = evaluate({
      toolName: "execute_code",
      approvalType: "network_access",
      mode: "bypass_permissions",
      toolInput: { language: "javascript", code: "fetch(url)", allow_network: true },
      workspace: {
        ...workspace,
        permissions: { ...workspace.permissions, accessNetworkMode: "disabled" },
      },
    });
    expect(disabled.decision).toBe("deny");
    expect(disabled.reason.type).toBe("workspace_capability");
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

    expect(
      PermissionEngine.inferScope({
        workspace,
        toolName: "web_fetch",
        approvalType: "network_access",
        mode: "default",
        rules: [],
        toolInput: { url: "https://docs.example.com/page" },
      }),
    ).toEqual({
      kind: "domain",
      toolName: "web_fetch",
      domain: "docs.example.com",
    });
    expect(exportResult.decision).toBe("allow");
    expect(readResult.scopePreview).toContain("docs.example.com");
  });

  it("matches browser domain rules by tool prefix without granting unrelated tools", () => {
    const rules: PermissionRule[] = [
      {
        source: "session",
        effect: "allow",
        scope: {
          kind: "domain",
          domain: "github.com",
          toolPrefix: "browser_",
        },
      },
    ];

    for (const toolName of ["browser_navigate", "browser_click", "browser_fill"]) {
      const result = evaluate({
        toolName,
        approvalType: "network_access",
        mode: "default",
        toolInput: { url: "https://github.com/openai/codex" },
        rules,
      });

      expect(result.decision).toBe("allow");
      expect(result.matchedRule?.scope).toEqual({
        kind: "domain",
        domain: "github.com",
        toolPrefix: "browser_",
      });
    }

    for (const toolName of ["web_fetch", "http_request", "open_url"]) {
      const result = evaluate({
        toolName,
        approvalType: "network_access",
        mode: "default",
        toolInput: { url: "https://github.com/openai/codex" },
        rules,
      });

      expect(result.matchedRule).toBeUndefined();
    }
  });

  it("infers browser domain approvals as browser-only domain rules", () => {
    expect(
      PermissionEngine.inferScope({
        workspace,
        toolName: "browser_navigate",
        approvalType: "network_access",
        mode: "default",
        rules: [],
        toolInput: { url: "https://github.com/openai/codex" },
      }),
    ).toEqual({
      kind: "domain",
      domain: "github.com",
      toolPrefix: "browser_",
    });
  });

  it("keeps workspace network blocks hard for Browser Use domain access", () => {
    const result = evaluate({
      workspace: {
        ...workspace,
        permissions: {
          ...workspace.permissions,
          network: false,
        },
      },
      toolName: "browser_navigate",
      approvalType: "network_access",
      mode: "default",
      toolInput: { url: "https://github.com/openai/codex" },
    });

    expect(result.decision).toBe("deny");
    expect(result.reason.type).toBe("workspace_capability");
    expect(result.reason.summary).toContain("network");
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

  it("hard-denies scoped filesystem escapes before they can become approval prompts", () => {
    const scopedWorkspace = {
      ...workspace,
      permissions: {
        ...workspace.permissions,
        accessProfileId: "project_sources",
        accessProfileScoped: true,
        accessFilesystemScoped: true,
        accessWorkspaceRoots: ["."],
      },
    };

    for (const input of [
      { toolName: "read_file", toolInput: { path: "../outside.txt" } },
      {
        toolName: "write_file",
        approvalType: "external_file_access" as const,
        toolInput: { path: "../outside.txt" },
      },
      { toolName: "create_document", toolInput: { filename: "../outside.docx" } },
    ]) {
      const result = evaluate({
        workspace: scopedWorkspace,
        mode: "default",
        ...input,
      });

      expect(result.decision).toBe("deny");
      expect(result.reason.type).toBe("workspace_capability");
      expect(result.reason.summary).toContain("Filesystem access denied");
      expect(result.reason.metadata).toEqual(
        expect.objectContaining({ policyReason: "profile_filesystem_outside" }),
      );
    }
  });

  it("hard-denies protected mutation paths without asking for approval", () => {
    const result = evaluate({
      toolName: "write_file",
      approvalType: "external_file_access",
      mode: "dont_ask",
      toolInput: { path: "/etc/cowork-edge-case.conf" },
    });

    expect(result.decision).toBe("deny");
    expect(result.reason.type).toBe("workspace_capability");
    expect(result.reason.metadata).toEqual(
      expect.objectContaining({ policyReason: "protected_path" }),
    );
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
