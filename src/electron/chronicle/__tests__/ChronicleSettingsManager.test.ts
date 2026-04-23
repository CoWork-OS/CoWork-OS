import { beforeEach, describe, expect, it, vi } from "vitest";

const isInitializedMock = vi.fn();
const getInstanceMock = vi.fn();
const loadMock = vi.fn();
const saveMock = vi.fn();

vi.mock("../../database/SecureSettingsRepository", () => ({
  SecureSettingsRepository: {
    isInitialized: () => isInitializedMock(),
    getInstance: () => getInstanceMock(),
  },
}));

import { ChronicleSettingsManager } from "../ChronicleSettingsManager";

describe("ChronicleSettingsManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isInitializedMock.mockReturnValue(false);
    getInstanceMock.mockReturnValue({
      load: loadMock,
      save: saveMock,
    });
  });

  it("returns defaults when secure settings are unavailable", () => {
    expect(ChronicleSettingsManager.loadSettings()).toEqual({
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
    });
  });

  it("normalizes and saves settings through the secure repository", () => {
    isInitializedMock.mockReturnValue(true);
    loadMock.mockReturnValue(undefined);

    const saved = ChronicleSettingsManager.saveSettings({
      enabled: true,
      captureIntervalSeconds: 1,
      retentionMinutes: 999,
      maxFrames: 3,
    });

    expect(saved).toEqual({
      enabled: true,
      mode: "hybrid",
      paused: false,
      captureIntervalSeconds: 5,
      retentionMinutes: 60,
      maxFrames: 6,
      captureScope: "frontmost_display",
      backgroundGenerationEnabled: true,
      respectWorkspaceMemory: true,
      consentAcceptedAt: null,
    });
    expect(saveMock).toHaveBeenCalledWith("chronicle", saved);
  });
});
