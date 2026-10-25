import { afterEach, describe, expect, it, vi } from "vitest";
import { SecureSettingsRepository } from "../../electron/database/SecureSettingsRepository";
import { PermissionSettingsManager } from "../../electron/security/permission-settings-manager";
import type { AccessProfileDefinition } from "../../shared/access-profiles";
import { checkRunAccessProfile } from "../run-access-profile";

const deskTest: AccessProfileDefinition = {
  id: "desk-test",
  label: "Desk Test",
  description: "Writes in the workspace, never asks.",
  sandbox: "workspace-write",
  approval: "never",
  reviewer: "none",
  network: "disabled",
};

function settings(
  overrides: { defaultAccessProfileId?: string; accessProfiles?: AccessProfileDefinition[] } = {},
) {
  return { accessProfiles: [deskTest], ...overrides };
}

function errorOf(run: () => void): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected checkRunAccessProfile to throw");
}

afterEach(() => {
  vi.restoreAllMocks();
  PermissionSettingsManager.clearCache();
});

describe("checkRunAccessProfile", () => {
  it.each(["ask_for_approval", "approve_for_me", "full_access", "desk-test", "  desk-test  "])(
    "accepts the profile %s",
    (accessProfileId) => {
      expect(() => checkRunAccessProfile({ accessProfileId }, settings())).not.toThrow();
    },
  );

  it("accepts a run that names no profile when there is no default", () => {
    expect(() => checkRunAccessProfile({}, settings())).not.toThrow();
  });

  it("names an unknown id, the profiles that exist, and where to create one", () => {
    const message = errorOf(() =>
      checkRunAccessProfile({ accessProfileId: "does-not-exist" }, settings()),
    );

    expect(message).toBe(
      'Access profile "does-not-exist" does not exist. Available profiles: ask_for_approval, approve_for_me, full_access, desk-test. Create custom profiles in the desktop app: Settings > System & Security > Permissions.',
    );
  });

  it("checks the default profile a run without --access-profile inherits", () => {
    const message = errorOf(() =>
      checkRunAccessProfile({}, settings({ defaultAccessProfileId: "deleted-default" })),
    );

    expect(message).toContain('The default access profile "deleted-default" does not exist.');
    expect(message).toContain("Settings > System & Security > Permissions");
  });

  it("prefers the named profile over a broken default", () => {
    expect(() =>
      checkRunAccessProfile(
        { accessProfileId: "desk-test" },
        settings({ defaultAccessProfileId: "deleted-default" }),
      ),
    ).not.toThrow();
  });

  it("leaves legacy --permission-mode runs alone, as task creation does", () => {
    expect(() =>
      checkRunAccessProfile(
        { permissionMode: "default" },
        settings({ defaultAccessProfileId: "deleted-default" }),
      ),
    ).not.toThrow();
  });

  it("reports a profile whose inheritance doesn't resolve as invalid", () => {
    const orphan: AccessProfileDefinition = { ...deskTest, id: "orphan", extends: "gone" };
    const message = errorOf(() =>
      checkRunAccessProfile(
        { accessProfileId: "orphan" },
        settings({ accessProfiles: [deskTest, orphan] }),
      ),
    );

    expect(message).toContain('Access profile "orphan" is invalid');
    expect(message).toContain("Settings > System & Security > Permissions");
  });

  it("finds a custom profile saved in the desktop settings", () => {
    // The stored permissions row as the desktop app saves it, read the way `cowork run` reads it.
    const stored = {
      version: 2,
      defaultAccessProfileId: "ask_for_approval",
      accessProfiles: [deskTest],
    };
    PermissionSettingsManager.clearCache();
    vi.spyOn(SecureSettingsRepository, "isInitialized").mockReturnValue(true);
    vi.spyOn(SecureSettingsRepository, "getInstance").mockReturnValue({
      getRevision: () => 1,
      readRecord: () => ({ status: "success", data: structuredClone(stored), revision: 1 }),
      update: () => ({ value: stored, revision: 1 }),
    } as unknown as SecureSettingsRepository);
    const loaded = PermissionSettingsManager.loadSettings();

    expect(() => checkRunAccessProfile({ accessProfileId: "desk-test" }, loaded)).not.toThrow();
    expect(() => checkRunAccessProfile({ accessProfileId: "desk-tset" }, loaded)).toThrow(
      "Available profiles: ask_for_approval, approve_for_me, full_access, desk-test.",
    );
  });
});
