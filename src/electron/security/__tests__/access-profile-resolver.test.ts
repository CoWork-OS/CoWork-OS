import { describe, expect, it } from "vitest";

import {
  BUILTIN_ACCESS_PROFILE_IDS,
  type AccessProfileDefinition,
  resolveAccessProfileDefinitionWithStatus,
} from "../../../shared/access-profiles";
import type { PermissionSettingsData, Workspace } from "../../../shared/types";
import { PermissionEngine } from "../../agent/runtime/PermissionEngine";
import {
  applyDefaultAccessProfile,
  applyAccessProfileToWorkspace,
  RELEASE_BRIEF_ACCESS_PROFILE_ID,
  resolveEffectiveAccessProfile,
} from "../access-profile-resolver";

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
    sandboxType: "none",
    allowedPaths: [],
  },
  createdAt: 0,
  lastAccessed: 0,
};

const settings: PermissionSettingsData = {
  version: 1,
  defaultMode: "default",
  defaultShellEnabled: false,
  defaultPermissionAccess: "default",
  defaultAccessProfileId: BUILTIN_ACCESS_PROFILE_IDS.askForApproval,
  accessProfiles: [],
  rules: [],
};

function withProfiles(profiles: AccessProfileDefinition[]): PermissionSettingsData {
  return { ...settings, accessProfiles: profiles };
}

describe("access profile resolver", () => {
  it("keeps the internal sample in a workspace-only, offline boundary", () => {
    const profile = resolveEffectiveAccessProfile({
      task: { source: "sample", agentConfig: { accessProfileId: RELEASE_BRIEF_ACCESS_PROFILE_ID } },
      workspace,
      settings,
    });
    const effective = applyAccessProfileToWorkspace(workspace, profile);
    expect(profile).toMatchObject({
      profileUnavailable: false,
      shellEnabled: false,
      networkEnabled: false,
      definition: { workspaceRoots: ["."] },
      sandboxMode: "workspace-write",
    });
    expect(effective.permissions).toMatchObject({
      unrestrictedFileAccess: false,
      shell: false,
      network: false,
    });
  });

  it("maps the built-in profiles to the expected approval and sandbox boundaries", () => {
    const ask = resolveEffectiveAccessProfile({
      task: { agentConfig: { accessProfileId: BUILTIN_ACCESS_PROFILE_IDS.askForApproval } },
      workspace,
      settings,
    });
    const approve = resolveEffectiveAccessProfile({
      task: { agentConfig: { accessProfileId: BUILTIN_ACCESS_PROFILE_IDS.approveForMe } },
      workspace,
      settings,
    });
    const full = resolveEffectiveAccessProfile({
      task: { agentConfig: { accessProfileId: BUILTIN_ACCESS_PROFILE_IDS.fullAccess } },
      workspace,
      settings,
    });

    expect(ask).toMatchObject({
      permissionMode: "default",
      sandboxMode: "workspace-write",
      requiresSandbox: true,
      shellEnabled: true,
      networkEnabled: true,
      filesystemScoped: false,
    });
    expect(approve).toMatchObject({
      definition: { reviewer: "auto-review" },
      permissionMode: "dangerous_only",
    });
    expect(full).toMatchObject({
      permissionMode: "bypass_permissions",
      sandboxMode: "danger-full-access",
      requiresSandbox: false,
      shellEnabled: true,
      networkEnabled: true,
    });
  });

  it("applies the named default to new tasks without overwriting legacy overrides", () => {
    const defaulted = applyDefaultAccessProfile({ allowUserInput: true }, settings);
    const blankProfile = applyDefaultAccessProfile(
      { accessProfileId: "  ", allowUserInput: true },
      { ...settings, defaultAccessProfileId: BUILTIN_ACCESS_PROFILE_IDS.approveForMe },
    );
    const explicitProfile = applyDefaultAccessProfile(
      { accessProfileId: "custom-profile", allowUserInput: true },
      { ...settings, defaultAccessProfileId: BUILTIN_ACCESS_PROFILE_IDS.approveForMe },
    );
    const legacyShell = applyDefaultAccessProfile({ shellAccess: false }, settings);
    const legacyMode = applyDefaultAccessProfile({ permissionMode: "plan" }, settings);

    expect(defaulted).toMatchObject({
      allowUserInput: true,
      accessProfileId: BUILTIN_ACCESS_PROFILE_IDS.askForApproval,
    });
    expect(blankProfile).toEqual({
      allowUserInput: true,
      accessProfileId: BUILTIN_ACCESS_PROFILE_IDS.approveForMe,
    });
    expect(explicitProfile).toEqual({
      allowUserInput: true,
      accessProfileId: "custom-profile",
    });
    expect(legacyShell).toEqual({ shellAccess: false });
    expect(legacyMode).toEqual({ permissionMode: "plan" });
  });

  it("preserves legacy default permission modes when no named default was stored", () => {
    const profile = resolveEffectiveAccessProfile({
      workspace,
      settings: {
        ...settings,
        defaultAccessProfileId: undefined,
        defaultMode: "dangerous_only",
      },
    });

    expect(profile.permissionMode).toBe("dangerous_only");
    expect(profile.sandboxMode).toBe("workspace-write");
    expect(profile.requiresSandbox).toBe(true);
  });

  it("does not leave named profile metadata on a legacy compatibility workspace", () => {
    const legacy = resolveEffectiveAccessProfile({
      task: { agentConfig: { permissionMode: "default" } },
      workspace,
      settings: { ...settings, defaultAccessProfileId: undefined },
    });
    const applied = applyAccessProfileToWorkspace(workspace, legacy);

    expect(legacy.requestedId).toBeUndefined();
    expect(applied.permissions).toMatchObject({
      accessProfileId: undefined,
      accessSandboxMode: undefined,
      accessApprovalPolicy: undefined,
      accessReviewer: undefined,
      accessNetworkMode: undefined,
      accessWorkspaceRoots: undefined,
      accessFilesystemRules: undefined,
      accessDomainRules: undefined,
    });
  });

  it("fails closed when runtime profile inheritance widens a parent", () => {
    const unsafe: AccessProfileDefinition = {
      id: "runtime_unsafe",
      label: "Runtime unsafe",
      description: "Wider than the bounded parent.",
      sandbox: "danger-full-access",
      approval: "never",
      reviewer: "none",
      network: "enabled",
      extends: BUILTIN_ACCESS_PROFILE_IDS.askForApproval,
    };

    expect(resolveAccessProfileDefinitionWithStatus(unsafe.id, [unsafe])).toMatchObject({
      status: "invalid",
      profileId: unsafe.id,
    });
    const effective = resolveEffectiveAccessProfile({
      task: { agentConfig: { accessProfileId: unsafe.id } },
      workspace,
      settings: withProfiles([unsafe]),
    });
    expect(effective.profileUnavailable).toBe(true);
    expect(effective.definition.sandbox).toBe("read-only");
  });

  it("lets an explicit built-in profile provide command tools without a workspace shell toggle", () => {
    const shellOffWorkspace = {
      ...workspace,
      permissions: { ...workspace.permissions, shell: false },
    };
    const profile = resolveEffectiveAccessProfile({
      task: { agentConfig: { accessProfileId: BUILTIN_ACCESS_PROFILE_IDS.askForApproval } },
      workspace: shellOffWorkspace,
      settings,
    });

    expect(profile.shellEnabled).toBe(true);
  });

  it("lets a selected profile own network capability when legacy workspace network is off", () => {
    const profile = resolveEffectiveAccessProfile({
      task: { agentConfig: { accessProfileId: BUILTIN_ACCESS_PROFILE_IDS.askForApproval } },
      workspace: { ...workspace, permissions: { ...workspace.permissions, network: false } },
      settings,
    });
    const applied = applyAccessProfileToWorkspace(
      { ...workspace, permissions: { ...workspace.permissions, network: false } },
      profile,
    );

    expect(profile.networkEnabled).toBe(true);
    expect(applied.permissions.network).toBe(true);
    expect(applied.permissions.accessNetworkMode).toBe("on-request");
  });

  it("derives command-tool access for new custom profiles without a shell field", () => {
    const custom: AccessProfileDefinition = {
      id: "custom_mode_only",
      label: "Custom mode only",
      description: "A custom profile whose command tools follow its mode.",
      sandbox: "workspace-write",
      approval: "on-request",
      reviewer: "user",
      network: "on-request",
    };
    const profile = resolveEffectiveAccessProfile({
      task: { agentConfig: { accessProfileId: custom.id } },
      workspace: { ...workspace, permissions: { ...workspace.permissions, shell: false } },
      settings: withProfiles([custom]),
    });

    expect(profile.shellEnabled).toBe(true);
  });

  it("preserves a legacy shell-disabled task until it explicitly selects a profile", () => {
    const shellOffWorkspace = {
      ...workspace,
      permissions: { ...workspace.permissions, shell: false },
    };
    const profile = resolveEffectiveAccessProfile({
      task: { agentConfig: {} },
      workspace: shellOffWorkspace,
      settings,
    });

    expect(profile.shellEnabled).toBe(false);
    expect(profile.permissionMode).toBe(settings.defaultMode);
    expect(profile.requestedId).toBeUndefined();
  });

  it("honors a persisted legacy shell=false override even when the workspace flag is enabled", () => {
    const profile = resolveEffectiveAccessProfile({
      task: { agentConfig: { shellAccess: false } },
      workspace,
      settings: { ...settings, defaultAccessProfileId: undefined },
    });

    expect(profile.shellEnabled).toBe(false);
  });

  it("resolves custom roots and converts restricted legacy sandbox settings to a real sandbox", () => {
    const custom: AccessProfileDefinition = {
      id: "docs_read_only",
      label: "Docs read-only",
      description: "Read documents without writes or network access.",
      sandbox: "read-only",
      approval: "on-request",
      reviewer: "user",
      network: "disabled",
      workspaceRoots: ["../shared-docs"],
    };
    const profile = resolveEffectiveAccessProfile({
      task: { agentConfig: { accessProfileId: custom.id } },
      workspace,
      settings: withProfiles([custom]),
    });
    const applied = applyAccessProfileToWorkspace(workspace, profile);

    expect(applied.permissions.accessWorkspaceRoots).toEqual(["/tmp/shared-docs"]);
    expect(applied.permissions.write).toBe(false);
    expect(applied.permissions.delete).toBe(false);
    expect(applied.permissions.network).toBe(false);
    expect(applied.permissions.accessFilesystemScoped).toBe(true);
    expect(applied.permissions.sandboxType).toBe("auto");
  });

  it("constrains full access when the administrator requires sandboxed shell execution", () => {
    const profile = resolveEffectiveAccessProfile({
      task: { agentConfig: { accessProfileId: BUILTIN_ACCESS_PROFILE_IDS.fullAccess } },
      workspace,
      settings,
      adminPolicies: {
        runtime: {
          requireSandboxForShell: true,
          allowedPermissionModes: [],
        },
      } as Any,
    });

    expect(profile.adminConstrained).toBe(true);
    expect(profile.constraintReason).toContain("requires OS sandboxing");
    expect(profile.permissionMode).toBe("default");
    expect(profile.requiresSandbox).toBe(true);
  });

  it("maps a legacy bypass task to the same unrestricted profile boundary", () => {
    const profile = resolveEffectiveAccessProfile({
      task: { agentConfig: { permissionMode: "bypass_permissions" } },
      workspace,
      settings: { ...settings, defaultAccessProfileId: undefined },
    });
    const applied = applyAccessProfileToWorkspace(workspace, profile);

    expect(profile.permissionMode).toBe("bypass_permissions");
    expect(applied.permissions.unrestrictedFileAccess).toBe(true);
    expect(applied.permissions.sandboxType).toBe("none");
  });

  it("overlays a read-only verifier boundary onto broad custom profiles", () => {
    const broad: AccessProfileDefinition = {
      id: "broad_custom",
      label: "Broad custom",
      description: "A profile that would otherwise allow unrestricted actions.",
      sandbox: "danger-full-access",
      approval: "never",
      reviewer: "none",
      network: "enabled",
      workspaceRoots: ["../shared-docs"],
      filesystemRules: [{ path: "../shared-docs", access: "read" }],
      domainRules: [{ pattern: "example.com", access: "allow" }],
    };
    const profile = resolveEffectiveAccessProfile({
      task: {
        workerRole: "verifier",
        agentConfig: {
          accessProfileId: broad.id,
          permissionMode: "bypass_permissions",
          shellAccess: true,
        },
      },
      workspace,
      settings: withProfiles([broad]),
    });
    const applied = applyAccessProfileToWorkspace(workspace, profile);

    expect(profile).toMatchObject({
      permissionMode: "plan",
      sandboxMode: "read-only",
      shellEnabled: false,
      networkEnabled: false,
      definition: {
        sandbox: "read-only",
        network: "disabled",
        shellAccess: false,
        workspaceRoots: ["../shared-docs"],
        filesystemRules: [{ path: "../shared-docs", access: "read" }],
        domainRules: [{ pattern: "example.com", access: "allow" }],
      },
    });
    expect(applied.permissions).toMatchObject({
      write: false,
      delete: false,
      network: false,
      shell: false,
      accessWorkspaceRoots: ["/tmp/shared-docs"],
    });
    expect(applied.permissions.unrestrictedFileAccess).toBe(false);

    // A permissive session rule must not re-enable an unknown MCP/external
    // tool after the verifier overlay has disabled the network capability.
    const mcpEvaluation = PermissionEngine.evaluate({
      workspace: applied,
      toolName: "mcp_external_mutator",
      mode: profile.permissionMode,
      rules: [
        {
          source: "session",
          effect: "allow",
          scope: { kind: "tool", toolName: "mcp_external_mutator" },
        },
      ],
    });
    expect(mcpEvaluation.decision).toBe("deny");
    expect(mcpEvaluation.reason).toMatchObject({
      type: "workspace_capability",
      capability: "network",
    });
  });

  it("overlays the read-only helper flag for researcher children before allow rules", () => {
    const broad: AccessProfileDefinition = {
      id: "broad_helper_custom",
      label: "Broad helper custom",
      description: "A broad profile supplied by the parent task.",
      sandbox: "danger-full-access",
      approval: "never",
      reviewer: "none",
      network: "enabled",
    };
    const profile = resolveEffectiveAccessProfile({
      task: {
        workerRole: "researcher",
        agentConfig: {
          readOnlyExecution: true,
          accessProfileId: broad.id,
          permissionMode: "bypass_permissions",
          shellAccess: true,
        },
      },
      workspace,
      settings: withProfiles([broad]),
    });
    const applied = applyAccessProfileToWorkspace(workspace, profile);

    expect(profile).toMatchObject({
      permissionMode: "plan",
      sandboxMode: "read-only",
      shellEnabled: false,
      networkEnabled: false,
      definition: {
        sandbox: "read-only",
        network: "disabled",
        shellAccess: false,
      },
    });
    expect(applied.permissions).toMatchObject({
      write: false,
      delete: false,
      network: false,
      shell: false,
      unrestrictedFileAccess: false,
    });

    const shellEvaluation = PermissionEngine.evaluate({
      workspace: applied,
      toolName: "run_command",
      approvalType: "run_command",
      command: "echo safe",
      mode: profile.permissionMode,
      rules: [
        {
          source: "session",
          effect: "allow",
          scope: { kind: "command_prefix", prefix: "echo" },
        },
      ],
    });
    expect(shellEvaluation.decision).toBe("deny");
    expect(shellEvaluation.reason).toMatchObject({
      type: "workspace_capability",
      capability: "shell",
    });

    const mcpEvaluation = PermissionEngine.evaluate({
      workspace: applied,
      toolName: "mcp_external_mutator",
      mode: profile.permissionMode,
      rules: [
        {
          source: "session",
          effect: "allow",
          scope: { kind: "tool", toolName: "mcp_external_mutator" },
        },
      ],
    });
    expect(mcpEvaluation.decision).toBe("deny");
    expect(mcpEvaluation.reason).toMatchObject({
      type: "workspace_capability",
      capability: "network",
    });
  });

  it("forces scoped danger-full profiles through a sandbox and honors shell denial", () => {
    const custom: AccessProfileDefinition = {
      id: "scoped_full",
      label: "Scoped full",
      description: "Full approval autonomy with bounded paths and domains.",
      sandbox: "danger-full-access",
      approval: "never",
      reviewer: "none",
      network: "enabled",
      shellAccess: false,
      filesystemRules: [{ path: "/tmp/private", access: "deny" }],
      domainRules: [{ pattern: "example.com", access: "allow" }],
    };
    const profile = resolveEffectiveAccessProfile({
      task: {
        agentConfig: {
          accessProfileId: custom.id,
          shellAccess: true,
        },
      },
      workspace,
      settings: withProfiles([custom]),
    });
    const applied = applyAccessProfileToWorkspace(workspace, profile);

    expect(profile.sandboxMode).toBe("workspace-write");
    expect(profile.requiresSandbox).toBe(true);
    expect(profile.shellEnabled).toBe(false);
    expect(applied.permissions.unrestrictedFileAccess).toBe(false);
    expect(applied.permissions.sandboxType).toBe("auto");
    expect(applied.permissions.shell).toBe(false);
  });

  it("keeps the sandbox and the file boundary for a danger-full profile that still asks", () => {
    const custom: AccessProfileDefinition = {
      id: "danger_full_on_request",
      label: "Danger full on request",
      description: "Unbounded local execution with explicit external consent.",
      sandbox: "danger-full-access",
      approval: "on-request",
      reviewer: "user",
      network: "enabled",
    };
    const profile = resolveEffectiveAccessProfile({
      task: { agentConfig: { accessProfileId: custom.id } },
      workspace,
      settings: withProfiles([custom]),
    });
    const applied = applyAccessProfileToWorkspace(workspace, profile);

    // Both dimensions have to line up before the boundary comes off. Deriving
    // this from `sandbox` alone silently turned the profile's "on-request"
    // into "never ask": every path outside the workspace resolved to
    // `allow / unrestricted_file_access`, so reads of ~/.ssh/id_rsa never
    // raised an external_file_access approval.
    expect(profile.requiresSandbox).toBe(true);
    expect(applied.permissions).toMatchObject({
      accessSandboxMode: "danger-full-access",
      accessApprovalPolicy: "on-request",
      unrestrictedFileAccess: false,
      sandboxType: "auto",
    });
  });

  it("keeps an explicitly disabled network off for a full-access filesystem profile", () => {
    const custom: AccessProfileDefinition = {
      id: "local_full_no_network",
      label: "Local full access",
      description: "Unrestricted local access without network access.",
      sandbox: "danger-full-access",
      approval: "never",
      reviewer: "none",
      network: "disabled",
      shellAccess: true,
    };
    const profile = resolveEffectiveAccessProfile({
      task: { agentConfig: { accessProfileId: custom.id } },
      workspace,
      settings: withProfiles([custom]),
    });
    const applied = applyAccessProfileToWorkspace(workspace, profile);

    expect(profile.networkEnabled).toBe(false);
    expect(applied.permissions.unrestrictedFileAccess).toBe(true);
    expect(applied.permissions.network).toBe(false);
    expect(applied.permissions.accessNetworkMode).toBe("disabled");
  });

  it("recognizes workspace roots as a scoped child-task boundary", () => {
    const custom: AccessProfileDefinition = {
      id: "shared_docs",
      label: "Shared docs",
      description: "Adds a second workspace root.",
      sandbox: "workspace-write",
      approval: "on-request",
      reviewer: "user",
      network: "on-request",
      workspaceRoots: ["../shared-docs"],
    };

    expect(
      resolveEffectiveAccessProfile({
        task: { agentConfig: { accessProfileId: custom.id } },
        workspace,
        settings: withProfiles([custom]),
      }),
    ).toMatchObject({
      requestedId: custom.id,
      definition: { workspaceRoots: ["../shared-docs"] },
    });
  });
});
