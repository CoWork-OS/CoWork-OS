import { describe, expect, it, vi } from "vitest";

const mockFs = vi.hoisted(() => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => "{}"),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  watch: vi.fn(),
}));
vi.mock("fs", () => mockFs);
vi.mock("../../utils/user-data-dir", () => ({ getUserDataDir: () => "/mock/user/data" }));

import { getBrowserPolicy, loadPolicies, validatePolicies } from "../policies";
import { describePolicyRelaxations } from "../policy-relaxations";

describe("browser admin policy", () => {
  it("defaults to leaving developer mode to the user and blocking nothing", () => {
    mockFs.readFileSync.mockReturnValue("{}");
    expect(getBrowserPolicy(loadPolicies())).toEqual({
      developerMode: "user",
      blockedSitePermissions: [],
    });
  });

  it("reads a lock and blocked permissions", () => {
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        browser: { developerMode: "off", blockedSitePermissions: ["camera", "display-capture"] },
      }),
    );
    expect(getBrowserPolicy(loadPolicies())).toEqual({
      developerMode: "off",
      blockedSitePermissions: ["camera", "display-capture"],
    });
  });

  it("rejects unknown modes and permission keys", () => {
    expect(validatePolicies({ browser: { developerMode: "maybe" } })).toMatch(/developerMode/);
    expect(
      validatePolicies({ browser: { blockedSitePermissions: ["camera", "teleport"] } }),
    ).toMatch(/blockedSitePermissions/);
    expect(
      validatePolicies({ browser: { developerMode: "on", blockedSitePermissions: ["usb"] } }),
    ).toBeNull();
  });

  it("treats unlocking developer mode and unblocking permissions as relaxations", () => {
    mockFs.readFileSync.mockReturnValue("{}");
    const base = loadPolicies();
    const current = {
      ...base,
      browser: { developerMode: "off" as const, blockedSitePermissions: ["camera", "usb"] },
    };
    const next = {
      ...base,
      browser: { developerMode: "user" as const, blockedSitePermissions: ["usb"] },
    };
    expect(describePolicyRelaxations(current, next)).toEqual(
      expect.arrayContaining([
        "Allow in-app browser developer mode",
        "Unblock browser site permissions: camera",
      ]),
    );
  });
});
