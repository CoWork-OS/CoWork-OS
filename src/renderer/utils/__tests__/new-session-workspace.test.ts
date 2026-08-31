import { describe, expect, it } from "vitest";

import { shouldUseFreshTempWorkspaceForNewSession } from "../new-session-workspace";

describe("shouldUseFreshTempWorkspaceForNewSession", () => {
  it("keeps a selected real workspace for a new task", () => {
    expect(shouldUseFreshTempWorkspaceForNewSession({ id: "workspace-1", isTemp: false })).toBe(
      false,
    );
    expect(shouldUseFreshTempWorkspaceForNewSession({ id: "workspace-1" })).toBe(false);
  });

  it("creates a fresh temp workspace for scratch sessions", () => {
    expect(shouldUseFreshTempWorkspaceForNewSession(null)).toBe(true);
    expect(shouldUseFreshTempWorkspaceForNewSession({ id: "__temp_workspace__" })).toBe(true);
    expect(
      shouldUseFreshTempWorkspaceForNewSession({
        id: "__temp_workspace__:ui-session-abc",
        isTemp: false,
      }),
    ).toBe(true);
    expect(shouldUseFreshTempWorkspaceForNewSession({ id: "workspace-1", isTemp: true })).toBe(
      true,
    );
  });
});
