import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const healthState = new Map<string, unknown>();

const mockRepo = {
  load: vi.fn((category: string) => healthState.get(category)),
  save: vi.fn((category: string, value: unknown) => {
    healthState.set(category, JSON.parse(JSON.stringify(value)));
  }),
};

const mockSecureSettingsRepository = {
  isInitialized: vi.fn(() => true),
  getInstance: vi.fn(() => mockRepo),
};

const mockProvider = {
  createMessage: vi.fn(async () => {
    throw new Error("LLM unavailable");
  }),
};

const mockLLMProviderFactory = {
  createProvider: vi.fn(() => mockProvider),
  loadSettings: vi.fn(() => ({ modelKey: "sonnet-4-5" })),
};

const mockAppleHealthBridge = {
  isAvailable: vi.fn(() => false),
  getExecutablePath: vi.fn(() => null),
  getStatus: vi.fn(async (sourceMode: string) => ({
    available: false,
    authorizationStatus: sourceMode === "import" ? "import-only" : "unavailable",
    readableTypes: [],
    writableTypes: [],
    sourceMode,
    lastSyncedAt: undefined,
    lastError: "bridge unavailable",
  })),
  authorize: vi.fn(async () => ({
    granted: false,
    authorizationStatus: "unavailable",
    readableTypes: [],
    writableTypes: [],
    sourceMode: "native",
  })),
  sync: vi.fn(async () => null),
  write: vi.fn(async () => null),
};

vi.mock("../../database/SecureSettingsRepository", () => ({
  SecureSettingsRepository: mockSecureSettingsRepository,
}));

vi.mock("../../agent/llm/provider-factory", () => ({
  LLMProviderFactory: mockLLMProviderFactory,
}));

vi.mock("../apple-health-bridge", () => ({
  AppleHealthBridge: mockAppleHealthBridge,
}));

let HealthManager: typeof import("../HealthManager").HealthManager;

describe("HealthManager", () => {
  beforeEach(async () => {
    healthState.clear();
    vi.clearAllMocks();
    mockAppleHealthBridge.isAvailable.mockReturnValue(false);
    mockAppleHealthBridge.getExecutablePath.mockReturnValue(null);
    mockAppleHealthBridge.getStatus.mockImplementation(async (sourceMode: string) => ({
      available: false,
      authorizationStatus: sourceMode === "import" ? "import-only" : "unavailable",
      readableTypes: [],
      writableTypes: [],
      sourceMode,
      lastSyncedAt: undefined,
      lastError: "bridge unavailable",
    }));
    mockAppleHealthBridge.authorize.mockImplementation(async () => ({
      granted: false,
      authorizationStatus: "unavailable",
      readableTypes: [],
      writableTypes: [],
      sourceMode: "native",
    }));
    mockAppleHealthBridge.sync.mockResolvedValue(null);
    mockAppleHealthBridge.write.mockResolvedValue(null);
    vi.resetModules();
    const mod = await import("../HealthManager");
    HealthManager = mod.HealthManager;
  });

  afterEach(() => {
    healthState.clear();
  });

  it("returns a demo dashboard when no user data exists", () => {
    const dashboard = HealthManager.getDashboard();

    expect(dashboard.isDemo).toBe(true);
    expect(dashboard.sources.length).toBeGreaterThan(0);
    expect(dashboard.metrics.length).toBeGreaterThan(0);
    expect(dashboard.records.length).toBeGreaterThan(0);
  });

  it("normalizes health sources and keeps them enabled by default", () => {
    const source = HealthManager.upsertSource({
      provider: "oura",
      kind: "wearable",
      name: "  Oura Ring  ",
      accountLabel: " Runner ",
    });

    expect(source.name).toBe("Oura Ring");
    expect(source.description).toContain("Sleep, readiness, recovery");
    expect(source.enabled).toBe(true);
    expect(source.status).toBe("connected");
    expect(HealthManager.listSources()).toHaveLength(1);
  });

  it("syncs wearable data into normalized metrics and insights", async () => {
    const source = HealthManager.upsertSource({
      provider: "fitbit",
      kind: "wearable",
      name: "Fitbit",
    });

    const resolved = await HealthManager.syncSource(source.id);

    expect(resolved.ok).toBe(true);
    expect(resolved.metrics?.length).toBeGreaterThan(0);
    expect(resolved.records?.length).toBeGreaterThan(0);

    const dashboard = HealthManager.getDashboard();
    const synced = dashboard.sources.find((item) => item.id === source.id);

    expect(synced?.status).toBe("connected");
    expect(synced?.lastSyncStatus).toBe("success");
    expect(dashboard.stats.connectedCount).toBe(1);
    expect(dashboard.stats.metricsCount).toBeGreaterThan(0);
    expect(dashboard.stats.recordsCount).toBeGreaterThan(0);
    expect(dashboard.insights.length).toBeGreaterThan(0);
  });

  it("imports parsed lab values from files", async () => {
    const source = HealthManager.upsertSource({
      provider: "lab-results",
      kind: "lab",
      name: "Lab Imports",
    });

    const filePath = path.join(os.tmpdir(), `health-import-${Date.now()}.txt`);
    fs.writeFileSync(
      filePath,
      ["A1C: 5.9", "Glucose: 118", "LDL: 104", "Symptom score: 7"].join("\n"),
    );

    try {
      const result = await HealthManager.importFiles(source.id, [filePath]);

      expect(result.ok).toBe(true);
      expect(result.metrics?.map((metric) => metric.key)).toEqual(
        expect.arrayContaining(["a1c", "glucose", "ldl", "symptom_score"]),
      );
      expect(result.records?.[0].summary).toContain("A1C: 5.9");

      const dashboard = HealthManager.getDashboard();
      expect(dashboard.stats.metricsCount).toBeGreaterThanOrEqual(4);
      expect(dashboard.stats.recordsCount).toBeGreaterThan(0);
    } finally {
      fs.unlinkSync(filePath);
    }
  });

  it("revokes disabled sources and rejects sync attempts", async () => {
    const source = HealthManager.upsertSource({
      provider: "medical-records",
      kind: "record",
      name: "Records",
    });

    const revoked = HealthManager.removeSource(source.id);
    const dashboard = HealthManager.getDashboard();
    const disabled = dashboard.sources.find((item) => item.id === source.id);

    expect(revoked.success).toBe(true);
    expect(disabled?.status).toBe("disabled");
    expect(disabled?.enabled).toBe(false);
    const result = await HealthManager.syncSource(source.id);
    expect(result).toEqual({
      ok: false,
      error: "Health source is disabled.",
    });
  });

  it("preserves disabled sources when updating their metadata", () => {
    const source = HealthManager.upsertSource({
      provider: "medical-records",
      kind: "record",
      name: "Records",
    });

    HealthManager.removeSource(source.id);
    const updated = HealthManager.upsertSource({
      provider: "medical-records",
      kind: "record",
      name: "Records",
      accountLabel: "Updated label",
    });

    expect(updated.id).toBe(source.id);
    expect(updated.status).toBe("disabled");
    expect(updated.enabled).toBe(false);
  });

  it("falls back to a deterministic workflow when the LLM is unavailable", async () => {
    const source = HealthManager.upsertSource({
      provider: "oura",
      kind: "wearable",
      name: "Oura Ring",
    });
    await HealthManager.syncSource(source.id);

    const response = await HealthManager.generateWorkflow({
      workflowType: "visit-prep",
      sourceIds: [source.id],
    });

    expect(response.success).toBe(true);
    expect(response.workflow).toMatchObject({
      workflowType: "visit-prep",
      title: "Doctor visit prep summary",
    });
    expect(response.workflow?.sections).toHaveLength(2);
    expect(response.workflow?.sourceIds).toContain(source.id);

    const dashboard = HealthManager.getDashboard();
    expect(dashboard.workflows[0]?.workflowType).toBe("visit-prep");
  });

  it("connects native Apple Health and previews writeback through the bridge", async () => {
    mockAppleHealthBridge.isAvailable.mockReturnValue(true);
    mockAppleHealthBridge.getExecutablePath.mockReturnValue("/tmp/HealthKitBridge");
    mockAppleHealthBridge.getStatus.mockResolvedValue({
      available: true,
      authorizationStatus: "not-determined",
      readableTypes: ["steps", "sleep", "heart_rate", "hrv", "weight", "glucose", "workout"],
      writableTypes: ["steps", "sleep", "heart_rate", "hrv", "weight", "glucose", "workout"],
      sourceMode: "native",
      lastSyncedAt: undefined,
      lastError: undefined,
    });
    mockAppleHealthBridge.authorize.mockResolvedValue({
      granted: true,
      authorizationStatus: "authorized",
      readableTypes: ["steps", "sleep", "heart_rate", "hrv", "weight", "glucose", "workout"],
      writableTypes: ["steps", "sleep", "heart_rate", "hrv", "weight", "glucose", "workout"],
      sourceMode: "native",
    });
    mockAppleHealthBridge.sync.mockResolvedValue({
      permissions: { read: true, write: true },
      readableTypes: ["steps", "sleep", "heart_rate", "hrv", "weight", "glucose", "workout"],
      writableTypes: ["steps", "sleep", "heart_rate", "hrv", "weight", "glucose", "workout"],
      metrics: [
        { key: "steps", value: 12500, unit: "steps", label: "Steps", recordedAt: Date.now() },
      ],
      records: [
        {
          title: "Steps Snapshot",
          summary: "Steps recorded from HealthKit.",
          recordedAt: Date.now(),
          sourceLabel: "Apple Health",
          kind: "wearable",
          tags: ["steps", "healthkit"],
        },
      ],
      sourceMode: "native",
      lastSyncedAt: Date.now(),
    });
    mockAppleHealthBridge.write.mockResolvedValue({ writtenCount: 1, warnings: [] });

    const connect = await HealthManager.connectAppleHealth({});
    expect(connect.success).toBe(true);
    expect(connect.source?.provider).toBe("apple-health");
    expect(connect.source?.permissionState).toBe("authorized");

    const source = HealthManager.listSources().find((item) => item.provider === "apple-health");
    expect(source?.connectionMode).toBe("native");

    const preview = await HealthManager.previewAppleHealthWriteback({
      sourceId: source!.id,
      items: [
        {
          id: "item-1",
          type: "steps",
          label: "Steps",
          value: "12500",
        },
      ],
    });
    expect(preview.success).toBe(true);
    expect(preview.preview?.connectionMode).toBe("native");

    const apply = await HealthManager.applyAppleHealthWriteback({
      sourceId: source!.id,
      items: [
        {
          id: "item-1",
          type: "steps",
          label: "Steps",
          value: "12500",
        },
      ],
    });
    expect(apply.success).toBe(true);
    expect(apply.writtenCount).toBe(1);
    expect(mockAppleHealthBridge.write).toHaveBeenCalledTimes(1);
  });
});
