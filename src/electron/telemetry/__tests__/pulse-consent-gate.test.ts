import { beforeEach, describe, expect, it, vi } from "vitest";

const load = vi.fn();

vi.mock("../../database/SecureSettingsRepository", () => ({
  SecureSettingsRepository: {
    getInstance: () => ({ load }),
  },
}));

import { isPulseConsentGranted } from "../pulse-service";

describe("isPulseConsentGranted", () => {
  beforeEach(() => {
    load.mockReset();
  });

  it("is true only for an explicit opt-in", () => {
    load.mockReturnValue({ consentState: "enabled" });
    expect(isPulseConsentGranted()).toBe(true);
  });

  it.each([
    ["disabled", { consentState: "disabled" }],
    ["unset", { consentState: "unset" }],
    ["absent record", undefined],
    ["null record", null],
  ])("is false for %s", (_label, stored) => {
    load.mockReturnValue(stored);
    expect(isPulseConsentGranted()).toBe(false);
  });

  it("fails closed when the settings repository is unavailable", () => {
    // The updater calls this before the repository is guaranteed to exist.
    // Throwing must read as "no consent", never as consent.
    load.mockImplementation(() => {
      throw new Error("SecureSettingsRepository has not been initialized.");
    });
    expect(isPulseConsentGranted()).toBe(false);
  });
});
