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

    expect(repository.save).toHaveBeenCalledTimes(2);
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
});
