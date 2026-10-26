import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PermissionSettingsData } from "../../../shared/types";
import { PermissionUnsavedChangesBar } from "../PermissionSettingsPanel";
import {
  hasUnsavedPermissionChanges,
  permissionSaveErrorMessage,
  saveUnsavedPermissionDraftOnLeave,
  takeFailedPermissionDraft,
} from "../permission-settings-draft";

const SAVED: PermissionSettingsData = {
  version: 1,
  defaultMode: "dangerous_only",
  defaultShellEnabled: false,
  defaultPermissionAccess: "default",
  defaultAccessProfileId: "ask_for_approval",
  accessProfiles: [
    {
      id: "custom_workspace",
      label: "Custom workspace",
      description: "A named CoWork access profile.",
      sandbox: "read-only",
      approval: "on-request",
      reviewer: "user",
      network: "on-request",
    },
  ],
  rules: [],
};

/** The 2026-10-25 edit that was lost: custom_workspace opened up and a desk-test profile added. */
const EDITED: PermissionSettingsData = {
  ...SAVED,
  accessProfiles: [
    {
      ...SAVED.accessProfiles![0],
      sandbox: "workspace-write",
      approval: "never",
      reviewer: "none",
    },
    {
      id: "desk-test",
      label: "Desk test",
      description: "A named CoWork access profile.",
      sandbox: "workspace-write",
      approval: "never",
      reviewer: "none",
      network: "disabled",
    },
  ],
};

const IPC_INHERITANCE_ERROR = new Error(
  "Error invoking remote method 'permissions:saveSettings': Error: Invalid access profile inheritance: desk-test cannot widen read_only.",
);

describe("Permissions panel unsaved changes", () => {
  it("treats profile and new-profile edits as unsaved", () => {
    expect(hasUnsavedPermissionChanges(SAVED, EDITED)).toBe(true);
    expect(
      hasUnsavedPermissionChanges(SAVED, {
        ...SAVED,
        accessProfiles: [{ ...SAVED.accessProfiles![0], network: "disabled" }],
      }),
    ).toBe(true);
  });

  it("does not count key order or cleared optional fields as edits", () => {
    const [profile] = SAVED.accessProfiles!;
    const reorderedProfile = {
      ...(Object.fromEntries(Object.entries(profile).reverse()) as typeof profile),
      extends: undefined,
    };
    const reordered: PermissionSettingsData = {
      rules: [],
      accessProfiles: [reorderedProfile],
      defaultAccessProfileId: SAVED.defaultAccessProfileId,
      defaultPermissionAccess: SAVED.defaultPermissionAccess,
      defaultShellEnabled: SAVED.defaultShellEnabled,
      defaultMode: SAVED.defaultMode,
      version: 1,
    };
    expect(hasUnsavedPermissionChanges(SAVED, reordered)).toBe(false);
    expect(hasUnsavedPermissionChanges(SAVED, structuredClone(SAVED))).toBe(false);
  });

  it("shows main's save error without Electron's IPC prefix", () => {
    expect(permissionSaveErrorMessage(IPC_INHERITANCE_ERROR)).toBe(
      "Invalid access profile inheritance: desk-test cannot widen read_only.",
    );
    expect(permissionSaveErrorMessage(undefined)).toBe("Failed to save permission settings.");
  });

  it("saves unsaved edits when the panel is left", async () => {
    const save = vi.fn(async (_settings: PermissionSettingsData) => ({ success: true }));

    await saveUnsavedPermissionDraftOnLeave(EDITED, save);

    expect(save).toHaveBeenCalledWith(EDITED);
    await expect(takeFailedPermissionDraft()).resolves.toBeNull();
  });

  it("keeps a draft main refused, with its error, for the next time the panel opens", async () => {
    let rejectSave: (error: Error) => void = () => {};
    const save = vi.fn(
      () =>
        new Promise<unknown>((_resolve, reject) => {
          rejectSave = reject;
        }),
    );

    void saveUnsavedPermissionDraftOnLeave(EDITED, save);
    // The panel reopens before main has answered: it waits for that save first.
    const reopened = takeFailedPermissionDraft();
    rejectSave(IPC_INHERITANCE_ERROR);

    await expect(reopened).resolves.toEqual({
      draft: EDITED,
      error: "Invalid access profile inheritance: desk-test cannot widen read_only.",
    });
    // Handed back once: a later open loads what main has stored.
    await expect(takeFailedPermissionDraft()).resolves.toBeNull();
  });

  it("renders the unsaved-changes bar with Save and Discard", () => {
    const html = renderToStaticMarkup(
      <PermissionUnsavedChangesBar
        saving={false}
        error={null}
        onSave={() => {}}
        onDiscard={() => {}}
      />,
    );

    expect(html).toContain('role="status"');
    expect(html).toContain("Unsaved changes");
    expect(html).toContain("Leaving this page saves them.");
    expect(html).toContain(">Discard</button>");
    expect(html).toContain(">Save changes</button>");
  });

  it("puts a failed save's error in the bar", () => {
    const html = renderToStaticMarkup(
      <PermissionUnsavedChangesBar
        saving={false}
        error={permissionSaveErrorMessage(IPC_INHERITANCE_ERROR)}
        onSave={() => {}}
        onDiscard={() => {}}
      />,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("permission-unsaved-bar--error");
    expect(html).toContain(
      "Couldn&#x27;t save: Invalid access profile inheritance: desk-test cannot widen read_only.",
    );
  });

  it("disables both actions while a save runs", () => {
    const html = renderToStaticMarkup(
      <PermissionUnsavedChangesBar saving error={null} onSave={() => {}} onDiscard={() => {}} />,
    );

    expect(html).toContain(">Saving...</button>");
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });
});
