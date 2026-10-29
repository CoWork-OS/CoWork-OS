import { describe, expect, it } from "vitest";

import { chronicleEnableNeedsConsent } from "../ChronicleSettings";
import type { ChronicleSettings } from "../../../shared/types";

const OFF: ChronicleSettings = {
  enabled: false,
  mode: "hybrid",
  paused: false,
  captureIntervalSeconds: 10,
  retentionMinutes: 5,
  maxFrames: 60,
  captureScope: "frontmost_display",
  backgroundGenerationEnabled: true,
  respectWorkspaceMemory: true,
  consentAcceptedAt: null,
};

describe("chronicleEnableNeedsConsent", () => {
  it("asks before Chronicle is turned on for the first time", () => {
    expect(chronicleEnableNeedsConsent(OFF, { enabled: true })).toBe(true);
  });

  it("does not ask again once consent was given", () => {
    expect(chronicleEnableNeedsConsent({ ...OFF, consentAcceptedAt: 1 }, { enabled: true })).toBe(
      false,
    );
  });

  it("does not ask for other changes or when Chronicle is already on", () => {
    expect(chronicleEnableNeedsConsent(OFF, { retentionMinutes: 10 })).toBe(false);
    expect(chronicleEnableNeedsConsent(OFF, { enabled: false })).toBe(false);
    expect(chronicleEnableNeedsConsent({ ...OFF, enabled: true }, { enabled: true })).toBe(false);
  });
});
