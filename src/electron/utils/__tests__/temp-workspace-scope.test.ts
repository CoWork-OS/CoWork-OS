import { describe, expect, it } from "vitest";
import { TEMP_WORKSPACE_ID_PREFIX } from "../../../shared/types";
import {
  createScopedTempWorkspaceIdentity,
  isTempWorkspaceInScope,
  parseTempWorkspaceScope,
  sanitizeTempWorkspaceKey,
} from "../temp-workspace-scope";

describe("temp-workspace-scope", () => {
  it("creates scoped IDs and parses scope correctly", () => {
    const identity = createScopedTempWorkspaceIdentity("ui", "session-abc");
    expect(identity.workspaceId).toBe(`${TEMP_WORKSPACE_ID_PREFIX}ui-session-abc`);
    expect(parseTempWorkspaceScope(identity.workspaceId)).toBe("ui");
    expect(isTempWorkspaceInScope(identity.workspaceId, "ui")).toBe(true);
  });

  it("marks unscoped temp IDs as legacy", () => {
    const legacyId = `${TEMP_WORKSPACE_ID_PREFIX}session-123`;
    expect(parseTempWorkspaceScope(legacyId)).toBe("legacy");
    expect(isTempWorkspaceInScope(legacyId, "ui")).toBe(false);
  });

  it("sanitizes unsafe key characters", () => {
    const key = sanitizeTempWorkspaceKey("  !!!hooks/source  ");
    expect(key).toBe("hooks-source");
  });
});
