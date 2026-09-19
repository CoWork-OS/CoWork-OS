import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SecureSettingsRepository } from "../../database/SecureSettingsRepository";
import { PermissionSettingsManager } from "../permission-settings-manager";

describe("PermissionSettingsManager", () => {
  const repository = {
    load: vi.fn(),
    save: vi.fn(),
  };

  beforeEach(() => {
    PermissionSettingsManager.clearCache();
    repository.load.mockReset();
    repository.save.mockReset();
    vi.spyOn(SecureSettingsRepository, "isInitialized").mockReturnValue(true);
    vi.spyOn(SecureSettingsRepository, "getInstance").mockReturnValue(repository as Any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    PermissionSettingsManager.clearCache();
  });

  it("loads and normalizes persisted profile rules", () => {
    repository.load.mockReturnValue({
      version: 1,
      defaultMode: "accept_edits",
      rules: [
        {
          effect: "allow",
          source: "workspace_db",
          scope: {
            kind: "command_prefix",
            prefix: "git    status",
          },
        },
      ],
    });

    const settings = PermissionSettingsManager.loadSettings();

    expect(settings.defaultMode).toBe("accept_edits");
    expect(settings.rules).toEqual([
      expect.objectContaining({
        source: "profile",
        effect: "allow",
        scope: {
          kind: "command_prefix",
          prefix: "git status",
        },
      }),
    ]);
  });

  it("falls back to dangerous_only when no settings are stored", () => {
    repository.load.mockReturnValue(undefined);

    const settings = PermissionSettingsManager.loadSettings();

    expect(settings.defaultMode).toBe("dangerous_only");
    expect(settings.defaultShellEnabled).toBe(false);
    expect(settings.defaultPermissionAccess).toBe("default");
    expect(settings.rules).toEqual([]);
  });

  it("loads persisted default access preferences", () => {
    repository.load.mockReturnValue({
      version: 1,
      defaultMode: "default",
      defaultShellEnabled: true,
      defaultPermissionAccess: "full",
      rules: [],
    });

    const settings = PermissionSettingsManager.loadSettings();

    expect(settings.defaultShellEnabled).toBe(true);
    expect(settings.defaultPermissionAccess).toBe("full");
  });

  it("appends deduplicated profile rules and persists them", () => {
    repository.load.mockReturnValue({
      version: 1,
      defaultMode: "default",
      rules: [],
    });

    PermissionSettingsManager.appendRule({
      source: "session",
      effect: "deny",
      scope: {
        kind: "tool",
        toolName: "open_url",
      },
    });
    PermissionSettingsManager.appendRule({
      source: "workspace_db",
      effect: "deny",
      scope: {
        kind: "tool",
        toolName: "open_url",
      },
    });

    // Loading the legacy record performs one durable v1 -> v2 migration,
    // followed by the two explicit rule writes.
    expect(repository.save).toHaveBeenCalledTimes(3);
    const lastSaved = repository.save.mock.calls.at(-1)?.[1];
    expect(lastSaved.rules).toHaveLength(1);
    expect(lastSaved.rules[0]).toEqual(
      expect.objectContaining({
        source: "profile",
        effect: "deny",
        scope: {
          kind: "tool",
          toolName: "open_url",
        },
      }),
    );
  });

  it("normalizes domain-scoped permission rules", () => {
    repository.load.mockReturnValue({
      version: 1,
      defaultMode: "default",
      rules: [
        {
          effect: "allow",
          source: "profile",
          scope: {
            kind: "domain",
            toolName: "http_request",
            domain: "API.Example.COM",
          },
        },
      ],
    });

    const settings = PermissionSettingsManager.loadSettings();

    expect(settings.rules).toEqual([
      expect.objectContaining({
        scope: {
          kind: "domain",
          toolName: "http_request",
          domain: "api.example.com",
        },
      }),
    ]);
  });

  it("sanitizes named access profiles without accepting built-in collisions or malformed rules", () => {
    repository.load.mockReturnValue({
      version: 1,
      defaultMode: "default",
      defaultAccessProfileId: "custom_safe",
      accessProfiles: [
        {
          id: "custom_safe",
          label: " Safe profile ",
          description: " Read selected files ",
          sandbox: "workspace-write",
          approval: "on-request",
          reviewer: "user",
          network: "on-request",
          filesystemRules: [
            { path: " /tmp/shared ", access: "read" },
            { path: "", access: "deny" },
            { path: "/tmp/nope", access: "invalid" },
          ],
          domainRules: [
            { pattern: " API.Example.COM ", access: "allow" },
            { pattern: "private.example.com", access: "invalid" },
          ],
        },
        {
          id: "full_access",
          label: "Must be rejected",
          description: "",
          sandbox: "danger-full-access",
          approval: "never",
          reviewer: "none",
          network: "enabled",
        },
      ],
      rules: [],
    });

    const settings = PermissionSettingsManager.loadSettings();

    expect(settings.accessProfiles).toEqual([
      expect.objectContaining({
        id: "custom_safe",
        label: "Safe profile",
        description: "Read selected files",
        filesystemRules: [{ path: "/tmp/shared", access: "read" }],
        domainRules: [{ pattern: "api.example.com", access: "allow" }],
      }),
    ]);
  });

  it("preserves an unknown default id and fails the mode closed", () => {
    repository.load.mockReturnValue({
      version: 1,
      defaultMode: "accept_edits",
      defaultAccessProfileId: "missing-profile",
      rules: [],
    });

    const settings = PermissionSettingsManager.loadSettings();

    expect(settings.defaultAccessProfileId).toBe("missing-profile");
    expect(settings.defaultMode).toBe("dangerous_only");
    expect(settings.defaultPermissionAccess).toBe("default");
    expect(settings.migration?.defaultProvenance).toBe("fail_closed_unknown_profile");
  });

  it("does not let a deleted named default preserve a bypass mode", () => {
    repository.load.mockReturnValue({
      version: 1,
      defaultMode: "bypass_permissions",
      defaultAccessProfileId: "deleted-profile",
      rules: [],
    });

    const settings = PermissionSettingsManager.loadSettings();

    // A profile-less legacy task inherits defaultMode directly, so preserving
    // bypass_permissions here would resolve it to the full-access profile.
    expect(settings.defaultMode).toBe("dangerous_only");
  });

  it("migrates a profile-less legacy default with a recoverable snapshot", () => {
    const legacy = {
      version: 1,
      defaultMode: "accept_edits",
      defaultShellEnabled: false,
      defaultPermissionAccess: "default",
      rules: [],
    } as const;
    repository.load.mockReturnValue(legacy);

    const settings = PermissionSettingsManager.loadSettings();
    const migratedProfile = settings.accessProfiles?.find(
      (profile) => profile.id === settings.defaultAccessProfileId,
    );

    expect(settings.version).toBe(2);
    expect(migratedProfile).toEqual(
      expect.objectContaining({
        sandbox: "workspace-write",
        shellAccess: false,
      }),
    );
    expect(settings.migration).toEqual(
      expect.objectContaining({
        version: 2,
        sourceVersion: 1,
        previous: expect.objectContaining({
          version: 1,
          defaultMode: "accept_edits",
          defaultShellEnabled: false,
        }),
      }),
    );
    expect(repository.save).toHaveBeenCalledTimes(1);
  });

  it("keeps legacy dont_ask bounded during migration", () => {
    repository.load.mockReturnValue({
      version: 1,
      defaultMode: "dont_ask",
      defaultShellEnabled: false,
      defaultPermissionAccess: "default",
      rules: [],
    });

    const settings = PermissionSettingsManager.loadSettings();
    const migratedProfile = settings.accessProfiles?.find(
      (profile) => profile.id === settings.defaultAccessProfileId,
    );

    expect(migratedProfile).toEqual(
      expect.objectContaining({
        sandbox: "workspace-write",
        approval: "never",
        reviewer: "none",
        network: "on-request",
        shellAccess: false,
      }),
    );
    expect(migratedProfile?.sandbox).not.toBe("danger-full-access");
    expect(settings.migration?.defaultProvenance).toBe("legacy_mode");
  });

  it("preserves shell access without widening legacy dont_ask", () => {
    repository.load.mockReturnValue({
      version: 1,
      defaultMode: "dont_ask",
      defaultShellEnabled: true,
      defaultPermissionAccess: "default",
      rules: [],
    });

    const settings = PermissionSettingsManager.loadSettings();
    const migratedProfile = settings.accessProfiles?.find(
      (profile) => profile.id === settings.defaultAccessProfileId,
    );

    expect(migratedProfile).toEqual(
      expect.objectContaining({
        sandbox: "workspace-write",
        approval: "never",
        reviewer: "none",
        network: "on-request",
        shellAccess: true,
      }),
    );
    expect(migratedProfile?.sandbox).not.toBe("danger-full-access");
  });

  it("does not rewrite an already migrated settings record", () => {
    const legacy = {
      version: 1,
      defaultMode: "dangerous_only",
      defaultShellEnabled: false,
      defaultPermissionAccess: "default",
      rules: [],
    } as const;
    repository.load.mockReturnValueOnce(legacy);
    const first = PermissionSettingsManager.loadSettings();
    const saved = repository.save.mock.calls[0]?.[1];

    PermissionSettingsManager.clearCache();
    repository.load.mockReturnValue(saved);
    const second = PermissionSettingsManager.loadSettings();

    expect(second).toEqual(first);
    expect(repository.save).toHaveBeenCalledTimes(1);
  });

  it("does not rewrite a complete v2 record that has no diagnostic backup", () => {
    repository.load.mockReturnValue({
      version: 2,
      defaultMode: "default",
      defaultShellEnabled: false,
      defaultPermissionAccess: "default",
      defaultAccessProfileId: "ask_for_approval",
      accessProfiles: [],
      rules: [],
    });

    const settings = PermissionSettingsManager.loadSettings();

    expect(settings.version).toBe(2);
    expect(settings.defaultAccessProfileId).toBe("ask_for_approval");
    expect(settings.migration).toBeUndefined();
    expect(repository.save).not.toHaveBeenCalled();
  });

  it("records a recoverable snapshot for a v2 record with a missing default profile", () => {
    repository.load.mockReturnValue({
      version: 2,
      defaultMode: "dont_ask",
      defaultShellEnabled: true,
      defaultPermissionAccess: "default",
      defaultAccessProfileId: "deleted-profile",
      accessProfiles: [],
      rules: [],
    });

    const settings = PermissionSettingsManager.loadSettings();

    expect(settings.defaultAccessProfileId).toBe("deleted-profile");
    expect(settings.migration).toEqual(
      expect.objectContaining({
        version: 2,
        sourceVersion: 2,
        defaultProvenance: "fail_closed_unknown_profile",
        previous: expect.objectContaining({
          defaultMode: "dont_ask",
          defaultShellEnabled: true,
          defaultAccessProfileId: "deleted-profile",
        }),
      }),
    );
    expect(repository.save).toHaveBeenCalledTimes(1);
  });

  it("drops malformed legacy rules while preserving the migration", () => {
    repository.load.mockReturnValue({
      version: 1,
      defaultMode: "default",
      rules: [{ effect: "allow" }, { effect: "invalid", scope: {} }],
    });

    const settings = PermissionSettingsManager.loadSettings();

    expect(settings.rules).toEqual([]);
    expect(settings.migration?.previous.rules).toHaveLength(2);
    expect(repository.save).toHaveBeenCalledTimes(1);
  });

  it("preserves explicit empty child scopes so inheritance cannot restore a parent grant", () => {
    repository.load.mockReturnValue({
      version: 1,
      defaultMode: "default",
      accessProfiles: [
        {
          id: "parent",
          label: "Parent",
          description: "Parent profile",
          sandbox: "workspace-write",
          approval: "on-request",
          reviewer: "user",
          network: "on-request",
          workspaceRoots: ["/tmp/shared"],
          filesystemRules: [{ path: "/tmp/shared", access: "write" }],
        },
        {
          id: "child",
          label: "Child",
          description: "Narrowed profile",
          sandbox: "workspace-write",
          approval: "on-request",
          reviewer: "user",
          network: "on-request",
          extends: "parent",
          workspaceRoots: [],
          filesystemRules: [],
          domainRules: [],
        },
      ],
      rules: [],
    });

    const settings = PermissionSettingsManager.loadSettings();
    const child = settings.accessProfiles?.find((profile) => profile.id === "child");

    expect(child).toEqual(
      expect.objectContaining({
        workspaceRoots: [],
        filesystemRules: [],
        domainRules: [],
      }),
    );
  });
});
