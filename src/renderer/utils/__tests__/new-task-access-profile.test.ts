import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  forgetRememberedAccessProfileId,
  getAccessProfileIdForPermissionMode,
  readRememberedAccessProfileId,
  rememberAccessProfileId,
  resolveNewTaskAccessProfileId,
} from "../new-task-access-profile";

describe("new task access profile", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
        removeItem: (key: string) => store.delete(key),
      },
    };
  });
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("remembers the last pick until it is forgotten", () => {
    expect(readRememberedAccessProfileId()).toBeNull();
    rememberAccessProfileId("full_access");
    expect(readRememberedAccessProfileId()).toBe("full_access");
    forgetRememberedAccessProfileId();
    expect(readRememberedAccessProfileId()).toBeNull();
  });

  it("starts new tasks with the remembered pick while it still exists", () => {
    const availableProfileIds = ["ask_for_approval", "approve_for_me", "full_access", "custom"];
    expect(
      resolveNewTaskAccessProfileId({
        remembered: "approve_for_me",
        defaultProfileId: "ask_for_approval",
        availableProfileIds,
      }),
    ).toBe("approve_for_me");
    expect(
      resolveNewTaskAccessProfileId({
        remembered: "deleted_profile",
        defaultProfileId: "ask_for_approval",
        availableProfileIds,
      }),
    ).toBe("ask_for_approval");
    expect(
      resolveNewTaskAccessProfileId({
        remembered: null,
        defaultProfileId: "full_access",
        availableProfileIds,
      }),
    ).toBe("full_access");
  });

  it("shows tasks saved before access profiles as the profile their mode runs as", () => {
    expect(getAccessProfileIdForPermissionMode("bypass_permissions")).toBe("full_access");
    expect(getAccessProfileIdForPermissionMode("default")).toBe("ask_for_approval");
    expect(getAccessProfileIdForPermissionMode("dangerous_only")).toBe("ask_for_approval");
    expect(getAccessProfileIdForPermissionMode(undefined)).toBe("ask_for_approval");
  });
});
