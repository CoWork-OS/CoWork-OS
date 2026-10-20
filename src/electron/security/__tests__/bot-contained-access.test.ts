import { describe, expect, it } from "vitest";
import { BUILTIN_ACCESS_PROFILE_IDS } from "../../../shared/access-profiles";
import type { PermissionSettingsData, Workspace } from "../../../shared/types";
import {
  applyAccessProfileToWorkspace,
  resolveEffectiveAccessProfile,
} from "../access-profile-resolver";

const workspace: Workspace = {
  id: "__bot_workspace__:bot-1",
  name: "Bot (own folder)",
  path: "/tmp/bot-folder",
  permissions: { read: true, write: true, delete: true, network: true, shell: true },
  createdAt: 0,
};

const settings = (defaultAccessProfileId: string): PermissionSettingsData =>
  ({
    version: 1,
    defaultMode: "default",
    defaultShellEnabled: false,
    defaultPermissionAccess: "default",
    defaultAccessProfileId,
    accessProfiles: [],
    rules: [],
  }) as PermissionSettingsData;

const resolve = (accessProfileId: string) =>
  resolveEffectiveAccessProfile({
    task: { agentConfig: { accessProfileId, botContained: true } },
    workspace,
    settings: settings(accessProfileId),
  });

describe("access for a run in a bot's own folder", () => {
  it("keeps the shell sandboxed under Full access, without adding prompts", () => {
    const profile = resolve(BUILTIN_ACCESS_PROFILE_IDS.fullAccess);
    expect(profile.definition.sandbox).toBe("workspace-write");
    expect(profile.definition.network).toBe("enabled");
    expect(profile.accessLimited).toBe(true);

    const applied = applyAccessProfileToWorkspace(workspace, profile);
    expect(applied.permissions.unrestrictedFileAccess).toBe(false);
    expect(applied.permissions.sandboxType).not.toBe("none");
    expect(applied.permissions.accessSandboxMode).toBe("workspace-write");
  });

  it("leaves Ask for approval and Approve for me as they are", () => {
    for (const id of [
      BUILTIN_ACCESS_PROFILE_IDS.askForApproval,
      BUILTIN_ACCESS_PROFILE_IDS.approveForMe,
    ]) {
      const profile = resolve(id);
      expect(profile.id).toBe(id);
      expect(profile.adminConstrained).toBe(false);
    }
  });
});
