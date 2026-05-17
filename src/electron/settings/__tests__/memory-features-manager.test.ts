import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryFeaturesSettings } from "../../../shared/types";

const mocks = vi.hoisted(() => {
  let storedSettings: Partial<MemoryFeaturesSettings> | undefined;

  return {
    get storedSettings() {
      return storedSettings;
    },
    set storedSettings(value: Partial<MemoryFeaturesSettings> | undefined) {
      storedSettings = value;
    },
    repositorySave: vi.fn().mockImplementation((_key: string, settings: unknown) => {
      storedSettings = settings as Partial<MemoryFeaturesSettings>;
    }),
    repositoryLoad: vi.fn().mockImplementation(() => storedSettings),
  };
});

vi.mock("../../database/SecureSettingsRepository", () => ({
  SecureSettingsRepository: {
    isInitialized: vi.fn().mockReturnValue(true),
    getInstance: vi.fn().mockReturnValue({
      save: mocks.repositorySave,
      load: mocks.repositoryLoad,
    }),
  },
}));

import { MemoryFeaturesManager } from "../memory-features-manager";

describe("MemoryFeaturesManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.storedSettings = undefined;
    MemoryFeaturesManager.clearCache();
    MemoryFeaturesManager.initialize();
  });

  it("defaults the experimental memory stack off", () => {
    const settings = MemoryFeaturesManager.loadSettings();

    expect(settings.contextPackInjectionEnabled).toBe(true);
    expect(settings.heartbeatMaintenanceEnabled).toBe(true);
    expect(settings.checkpointCaptureEnabled).toBe(true);
    expect(settings.verbatimRecallEnabled).toBe(true);
    expect(settings.wakeUpLayersEnabled).toBe(true);
    expect(settings.temporalKnowledgeEnabled).toBe(true);
    expect(settings.promptStackV2Enabled).toBe(false);
    expect(settings.layeredMemoryEnabled).toBe(false);
    expect(settings.transcriptStoreEnabled).toBe(false);
    expect(settings.durableContextEnabled).toBe(false);
    expect(settings.durableContextMode).toBe("off");
    expect(settings.durableContextThreshold).toBe(0.75);
    expect(settings.durableContextFreshTailCount).toBe(64);
    expect(settings.durableContextLargePayloadThreshold).toBe(25000);
    expect(settings.durableContextSummaryModel).toBe("");
    expect(settings.backgroundConsolidationEnabled).toBe(false);
    expect(settings.queryOrchestratorEnabled).toBe(false);
    expect(settings.sessionLineageEnabled).toBe(false);
    expect(settings.curatedMemoryEnabled).toBe(true);
    expect(settings.sessionRecallEnabled).toBe(true);
    expect(settings.topicMemoryEnabled).toBe(true);
    expect(settings.defaultArchiveInjectionEnabled).toBe(false);
    expect(settings.autoPromoteToCuratedMemoryEnabled).toBe(false);
  });

  it("preserves explicit experimental settings when loaded", () => {
    mocks.storedSettings = {
      contextPackInjectionEnabled: false,
      heartbeatMaintenanceEnabled: true,
      checkpointCaptureEnabled: false,
      verbatimRecallEnabled: false,
      wakeUpLayersEnabled: false,
      temporalKnowledgeEnabled: false,
      promptStackV2Enabled: true,
      layeredMemoryEnabled: true,
      transcriptStoreEnabled: true,
      durableContextEnabled: true,
      durableContextMode: "on",
      durableContextThreshold: 0.9,
      durableContextFreshTailCount: 48,
      durableContextLargePayloadThreshold: 12000,
      durableContextSummaryModel: "summary-model",
      backgroundConsolidationEnabled: true,
      queryOrchestratorEnabled: true,
      sessionLineageEnabled: true,
      curatedMemoryEnabled: false,
      sessionRecallEnabled: false,
      topicMemoryEnabled: false,
      defaultArchiveInjectionEnabled: true,
      autoPromoteToCuratedMemoryEnabled: true,
    };

    MemoryFeaturesManager.clearCache();
    const settings = MemoryFeaturesManager.loadSettings();

    expect(settings.contextPackInjectionEnabled).toBe(false);
    expect(settings.heartbeatMaintenanceEnabled).toBe(true);
    expect(settings.checkpointCaptureEnabled).toBe(true);
    expect(settings.verbatimRecallEnabled).toBe(false);
    expect(settings.wakeUpLayersEnabled).toBe(false);
    expect(settings.temporalKnowledgeEnabled).toBe(false);
    expect(settings.promptStackV2Enabled).toBe(true);
    expect(settings.layeredMemoryEnabled).toBe(true);
    expect(settings.transcriptStoreEnabled).toBe(true);
    expect(settings.durableContextEnabled).toBe(true);
    expect(settings.durableContextMode).toBe("on");
    expect(settings.durableContextThreshold).toBe(0.9);
    expect(settings.durableContextFreshTailCount).toBe(48);
    expect(settings.durableContextLargePayloadThreshold).toBe(12000);
    expect(settings.durableContextSummaryModel).toBe("summary-model");
    expect(settings.backgroundConsolidationEnabled).toBe(true);
    expect(settings.queryOrchestratorEnabled).toBe(true);
    expect(settings.sessionLineageEnabled).toBe(true);
    expect(settings.curatedMemoryEnabled).toBe(false);
    expect(settings.sessionRecallEnabled).toBe(false);
    expect(settings.topicMemoryEnabled).toBe(false);
    expect(settings.defaultArchiveInjectionEnabled).toBe(true);
    expect(settings.autoPromoteToCuratedMemoryEnabled).toBe(true);
  });

  it("saves partial settings with experimental features disabled by default", () => {
    const settings: MemoryFeaturesSettings = {
      contextPackInjectionEnabled: true,
      heartbeatMaintenanceEnabled: true,
    };

    MemoryFeaturesManager.saveSettings(settings);

    expect(mocks.storedSettings).toEqual({
      contextPackInjectionEnabled: true,
      heartbeatMaintenanceEnabled: true,
      checkpointCaptureEnabled: true,
      verbatimRecallEnabled: true,
      wakeUpLayersEnabled: true,
      temporalKnowledgeEnabled: true,
      promptStackV2Enabled: false,
      layeredMemoryEnabled: false,
      transcriptStoreEnabled: false,
      durableContextEnabled: false,
      durableContextMode: "off",
      durableContextThreshold: 0.75,
      durableContextFreshTailCount: 64,
      durableContextLargePayloadThreshold: 25000,
      durableContextSummaryModel: "",
      backgroundConsolidationEnabled: false,
      queryOrchestratorEnabled: false,
      sessionLineageEnabled: false,
      curatedMemoryEnabled: true,
      sessionRecallEnabled: true,
      topicMemoryEnabled: true,
      defaultArchiveInjectionEnabled: false,
      autoPromoteToCuratedMemoryEnabled: false,
      structuredObservationsEnabled: true,
      progressiveRecallToolsEnabled: true,
      memoryInspectorEnabled: true,
    });
  });

  it("enabling durable context enables required capture features", () => {
    MemoryFeaturesManager.saveSettings({
      durableContextEnabled: true,
      checkpointCaptureEnabled: false,
      transcriptStoreEnabled: false,
    });

    expect(mocks.storedSettings).toMatchObject({
      durableContextEnabled: true,
      durableContextMode: "experimental",
      checkpointCaptureEnabled: true,
      transcriptStoreEnabled: true,
    });
  });
});
