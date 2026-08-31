import { describe, expect, it } from "vitest";

import {
  BUILTIN_ACCESS_PROFILE_IDS,
  type AccessProfileDefinition,
} from "../../../shared/access-profiles";
import type { PermissionSettingsData, Workspace } from "../../../shared/types";
import {
  applyDefaultAccessProfile,
  applyAccessProfileToWorkspace,
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
