import { describe, it, expect, vi } from "vitest";
import {
  AppPermissionManager,
  accessLevelSatisfies,
} from "../app-permission-manager";

describe("accessLevelSatisfies", () => {
  it("ranks click_only above view_only", () => {
    expect(accessLevelSatisfies("click_only", "view_only")).toBe(true);
    expect(accessLevelSatisfies("view_only", "click_only")).toBe(false);
  });

  it("requires full_control for typing tools", () => {
    expect(accessLevelSatisfies("click_only", "full_control")).toBe(false);
    expect(accessLevelSatisfies("full_control", "click_only")).toBe(true);
  });
});

describe("AppPermissionManager", () => {
  it("allows only screenshot and move under view_only", async () => {
    const pm = new AppPermissionManager("test-session");
    pm.onPermissionRequest = async () => "view_only";
    await pm.requestPermission("Safari", "com.apple.Safari", "view_only", "test");
    expect(pm.isToolAllowed("Safari", "computer_screenshot", "com.apple.Safari")).toBe(true);
    expect(pm.isToolAllowed("Safari", "computer_click", "com.apple.Safari")).toBe(false);
    expect(pm.isToolAllowed("Safari", "computer_type", "com.apple.Safari")).toBe(false);
  });

  it("allows click under click_only but not type", async () => {
    const pm = new AppPermissionManager("test-session");
    pm.onPermissionRequest = async () => "click_only";
    await pm.requestPermission("Terminal", "com.apple.Terminal", "click_only", "test");
    expect(pm.isToolAllowed("Terminal", "computer_click", "com.apple.Terminal")).toBe(true);
    expect(pm.isToolAllowed("Terminal", "computer_type", "com.apple.Terminal")).toBe(false);
  });

  it("clears grants on revokeAll", async () => {
    const pm = new AppPermissionManager("test-session");
    pm.onPermissionRequest = async () => "full_control";
    await pm.requestPermission("Notes", undefined, "full_control", "test");
    expect(pm.getActivePermissions().length).toBe(1);
    pm.revokeAll();
    expect(pm.getActivePermissions().length).toBe(0);
  });

  it("re-prompts when upgrading access level", async () => {
    const handler = vi.fn().mockResolvedValueOnce("view_only").mockResolvedValueOnce("full_control");
    const pm = new AppPermissionManager("test-session");
    pm.onPermissionRequest = handler;
    await pm.requestPermission("App", "com.example.app", "view_only", "a");
    await pm.requestPermission("App", "com.example.app", "full_control", "b");
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
