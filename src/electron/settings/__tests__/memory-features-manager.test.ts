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
    expect(settings.wakeUpLayersEnabled).toBe(true);
    expect(settings.temporalKnowledgeEnabled).toBe(true);
    expect(settings.transcriptStoreEnabled).toBe(false);
    expect(settings.durableContextEnabled).toBe(false);
    expect(settings.durableContextMode).toBe("off");
    expect(settings.durableContextLargePayloadThreshold).toBe(25000);
    expect(settings.queryOrchestratorEnabled).toBe(false);
    expect(settings.curatedMemoryEnabled).toBe(true);
    expect(settings.sessionRecallEnabled).toBe(true);
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
      progressiveRecallToolsEnabled: false,
    };

    MemoryFeaturesManager.clearCache();
    const settings = MemoryFeaturesManager.loadSettings();

    // Retired keys still present in stored settings load without error and are dropped.
    for (const legacyKey of [
      "promptStackV2Enabled",
      "durableContextThreshold",
      "durableContextFreshTailCount",
      "durableContextSummaryModel",
      "sessionLineageEnabled",
      "verbatimRecallEnabled",
      "progressiveRecallToolsEnabled",
      "layeredMemoryEnabled",
      "topicMemoryEnabled",
    ]) {
      expect(settings).not.toHaveProperty(legacyKey);
    }
    expect(settings.contextPackInjectionEnabled).toBe(false);
    expect(settings.heartbeatMaintenanceEnabled).toBe(true);
    expect(settings.checkpointCaptureEnabled).toBe(true);
    expect(settings.wakeUpLayersEnabled).toBe(false);
    expect(settings.temporalKnowledgeEnabled).toBe(false);
    expect(settings.transcriptStoreEnabled).toBe(true);
    expect(settings.durableContextEnabled).toBe(true);
    expect(settings.durableContextMode).toBe("on");
    expect(settings.durableContextLargePayloadThreshold).toBe(12000);
    expect(settings.queryOrchestratorEnabled).toBe(true);
    expect(settings.curatedMemoryEnabled).toBe(false);
    expect(settings.sessionRecallEnabled).toBe(false);
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
      wakeUpLayersEnabled: true,
      temporalKnowledgeEnabled: true,
      transcriptStoreEnabled: false,
      durableContextEnabled: false,
      durableContextMode: "off",
      durableContextLargePayloadThreshold: 25000,
      queryOrchestratorEnabled: false,
      curatedMemoryEnabled: true,
      sessionRecallEnabled: true,
      defaultArchiveInjectionEnabled: false,
      memoryWriteApprovalMode: "off",
      autoPromoteToCuratedMemoryEnabled: false,
      structuredObservationsEnabled: true,
      memoryInspectorEnabled: true,
      memoryCompressionDailyTokenBudget: 20000,
      memoryRepoEnabled: true,
      memoryRepoPath: "",
      memoryRepoDefaultOnApplied: true,
      memoryRepoDreamingEnabled: true,
      memoryRepoDreamDailyTokenBudget: 50000,
      memoryRepoRemoteUrl: "",
      memoryRepoRemoteConfirmedPrivate: false,
      memoryRepoTeamRepos: [],
    });
  });

  it("keeps sync off until confirmed and normalizes team repos", () => {
    MemoryFeaturesManager.saveSettings({
      memoryRepoRemoteUrl: "  git@github.com:me/memory.git ",
      memoryRepoTeamRepos: [
        { name: "Platform", path: "/Users/me/team-memory", workspaceIds: ["ws-1", 7 as never] },
        { name: "platform", path: "/Users/me/other" },
        { name: "bad/name", path: "/x" },
        { name: "", path: "/y" },
      ] as never,
    });
    expect(mocks.storedSettings).toMatchObject({
      memoryRepoRemoteUrl: "git@github.com:me/memory.git",
      memoryRepoRemoteConfirmedPrivate: false,
      memoryRepoTeamRepos: [{ name: "Platform", path: "/Users/me/team-memory", workspaceIds: ["ws-1"] }],
    });
  });

  it("keeps memory folder dreaming on by default with a bounded budget", () => {
    MemoryFeaturesManager.saveSettings({ memoryRepoDreamDailyTokenBudget: 5_000_000 });
    expect(mocks.storedSettings).toMatchObject({
      memoryRepoDreamingEnabled: true,
      memoryRepoDreamDailyTokenBudget: 1_000_000,
    });
    MemoryFeaturesManager.saveSettings({
      memoryRepoDreamingEnabled: false,
      memoryRepoDreamDailyTokenBudget: 0,
    });
    expect(mocks.storedSettings).toMatchObject({
      memoryRepoDreamingEnabled: false,
      memoryRepoDreamDailyTokenBudget: 50000,
    });
    MemoryFeaturesManager.saveSettings({ memoryRepoDreamDailyTokenBudget: 1234.9 });
    expect(mocks.storedSettings).toMatchObject({ memoryRepoDreamDailyTokenBudget: 1234 });
  });

  it("turns the memory folder on once, then keeps the user's choice", () => {
    // A stored `false` from before the default-on migration is turned on.
    MemoryFeaturesManager.saveSettings({
      contextPackInjectionEnabled: true,
      heartbeatMaintenanceEnabled: true,
      memoryRepoEnabled: false,
    });
    expect(mocks.storedSettings).toMatchObject({ memoryRepoEnabled: true, memoryRepoDefaultOnApplied: true });
    // After the migration, turning it off holds.
    MemoryFeaturesManager.saveSettings({
      contextPackInjectionEnabled: true,
      heartbeatMaintenanceEnabled: true,
      memoryRepoEnabled: false,
      memoryRepoDefaultOnApplied: true,
    });
    expect(mocks.storedSettings).toMatchObject({ memoryRepoEnabled: false });
  });

  it("tells listeners about saves", () => {
    const seen: Array<boolean | undefined> = [];
    const unsubscribe = MemoryFeaturesManager.onSaved((saved) => seen.push(saved.memoryRepoEnabled));
    MemoryFeaturesManager.saveSettings({
      contextPackInjectionEnabled: true,
      heartbeatMaintenanceEnabled: true,
      memoryRepoEnabled: true,
      memoryRepoPath: "  /Users/me/CoWork Memory  ",
    });
    unsubscribe();
    expect(mocks.storedSettings).toMatchObject({
      memoryRepoEnabled: true,
      memoryRepoPath: "/Users/me/CoWork Memory",
    });
    expect(seen).toEqual([true]);
  });

  it("keeps the AI compression budget positive and bounded", () => {
    MemoryFeaturesManager.saveSettings({
      contextPackInjectionEnabled: true,
      heartbeatMaintenanceEnabled: true,
      memoryCompressionDailyTokenBudget: 5_000_000,
    });
    expect(mocks.storedSettings).toMatchObject({ memoryCompressionDailyTokenBudget: 1_000_000 });
    MemoryFeaturesManager.saveSettings({
      contextPackInjectionEnabled: true,
      heartbeatMaintenanceEnabled: true,
      memoryCompressionDailyTokenBudget: -4,
    });
    expect(mocks.storedSettings).toMatchObject({ memoryCompressionDailyTokenBudget: 20000 });
  });

  it("enabling durable context enables checkpoint capture but not span writing", () => {
    MemoryFeaturesManager.saveSettings({
      durableContextEnabled: true,
      checkpointCaptureEnabled: false,
      transcriptStoreEnabled: false,
    });

    expect(mocks.storedSettings).toMatchObject({
      durableContextEnabled: true,
      durableContextMode: "experimental",
      checkpointCaptureEnabled: true,
      transcriptStoreEnabled: false,
    });
  });

  it("lets transcript span writing be turned off after durable context is disabled", () => {
    MemoryFeaturesManager.saveSettings({
      durableContextEnabled: true,
      transcriptStoreEnabled: true,
    });
    MemoryFeaturesManager.saveSettings({
      durableContextEnabled: false,
      durableContextMode: "off",
      transcriptStoreEnabled: false,
    });

    expect(MemoryFeaturesManager.loadSettings().transcriptStoreEnabled).toBe(false);
    expect(mocks.storedSettings).toMatchObject({
      durableContextEnabled: false,
      transcriptStoreEnabled: false,
    });
  });
});
