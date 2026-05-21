import { describe, expect, it, beforeEach, vi } from "vitest";
import { IPC_CHANNELS } from "../../../shared/types";

const {
  registeredHandlers,
  mockConfigure,
  mockCheck,
  mockGetResetTime,
  mockHealthManager,
} = vi.hoisted(() => {
  const registeredHandlers = new Map<string, (...args: any[]) => unknown>();
  const mockConfigure = vi.fn();
  const mockCheck = vi.fn(() => true);
  const mockGetResetTime = vi.fn(() => Date.now() + 1_000);
  const mockHealthManager = {
    getDashboard: vi.fn(() => ({
      generatedAt: 1,
      isDemo: false,
      stats: {},
      sources: [],
      metrics: [],
      records: [],
      insights: [],
      workflows: [],
    })),
    listSources: vi.fn(() => []),
    upsertSource: vi.fn((source) => ({ id: "source-id", ...source })),
    removeSource: vi.fn(() => ({ success: true })),
    syncSource: vi.fn((sourceId: string) => ({ ok: true, sourceId })),
    importFiles: vi.fn(async (sourceId: string, filePaths: string[]) => ({
      ok: true,
      sourceId,
      filePaths,
      metrics: [],
      records: [],
      insights: [],
      workflow: null,
    })),
    generateWorkflow: vi.fn(async (request) => ({ success: true, request })),
    disconnectAppleHealth: vi.fn(() => ({ success: true })),
    connectAppleHealth: vi.fn(async (request) => ({ success: true, request })),
    getAppleHealthStatus: vi.fn(async () => ({
      available: true,
      authorizationStatus: "authorized",
      readableTypes: [],
      writableTypes: [],
      sourceMode: "native",
    })),
    previewAppleHealthWriteback: vi.fn(async (request) => ({ success: true, preview: { sourceId: request.sourceId } })),
    applyAppleHealthWriteback: vi.fn(async (request) => ({ success: true, writtenCount: request.items.length })),
  };
  return { registeredHandlers, mockConfigure, mockCheck, mockGetResetTime, mockHealthManager };
});

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => {
      registeredHandlers.set(channel, handler);
    }),
  },
  shell: {},
  BrowserWindow: class {},
  app: {
    getPath: vi.fn(() => "/tmp"),
  },
  nativeTheme: {
    shouldUseDarkColors: false,
  },
}));

vi.mock("../../utils/rate-limiter", () => ({
  rateLimiter: {
    configure: mockConfigure,
    check: mockCheck,
    getResetTime: mockGetResetTime,
  },
  RATE_LIMIT_CONFIGS: {
    limited: { maxRequests: 1, windowMs: 1_000 },
    standard: { maxRequests: 5, windowMs: 1_000 },
    expensive: { maxRequests: 1, windowMs: 5_000 },
  },
}));

vi.mock("../../health/HealthManager", () => ({
  HealthManager: mockHealthManager,
}));

vi.mock("../../terminal/TerminalPtyManager", () => ({
  TerminalPtyManager: {
    getInstance: vi.fn(() => ({
      listTabs: vi.fn(() => []),
      createTab: vi.fn(),
      runCommandInTab: vi.fn(),
      attachTerminalTabOutput: vi.fn(),
      writeToTab: vi.fn(),
      resizeTab: vi.fn(),
      stopTab: vi.fn(),
      closeTab: vi.fn(),
    })),
  },
}));

import { setupHealthHandlers } from "../handlers";

describe("health IPC handlers", () => {
  beforeEach(() => {
    registeredHandlers.clear();
    vi.clearAllMocks();
    setupHealthHandlers();
  });

  it("registers the health channel contract with rate limits", () => {
    expect(mockConfigure).toHaveBeenCalledWith(
      IPC_CHANNELS.HEALTH_UPSERT_SOURCE,
      expect.objectContaining({ maxRequests: 1 }),
    );
    expect(mockConfigure).toHaveBeenCalledWith(
      IPC_CHANNELS.HEALTH_REMOVE_SOURCE,
      expect.objectContaining({ maxRequests: 1 }),
    );
    expect(mockConfigure).toHaveBeenCalledWith(
      IPC_CHANNELS.HEALTH_SYNC_SOURCE,
      expect.objectContaining({ maxRequests: 5 }),
    );
    expect(mockConfigure).toHaveBeenCalledWith(
      IPC_CHANNELS.HEALTH_IMPORT_FILES,
      expect.objectContaining({ maxRequests: 1 }),
    );
    expect(mockConfigure).toHaveBeenCalledWith(
      IPC_CHANNELS.HEALTH_GENERATE_WORKFLOW,
      expect.objectContaining({ windowMs: 5_000 }),
    );

    expect(registeredHandlers.has(IPC_CHANNELS.HEALTH_GET_DASHBOARD)).toBe(true);
    expect(registeredHandlers.has(IPC_CHANNELS.HEALTH_LIST_SOURCES)).toBe(true);
    expect(registeredHandlers.has(IPC_CHANNELS.HEALTH_UPSERT_SOURCE)).toBe(true);
    expect(registeredHandlers.has(IPC_CHANNELS.HEALTH_REMOVE_SOURCE)).toBe(true);
    expect(registeredHandlers.has(IPC_CHANNELS.HEALTH_SYNC_SOURCE)).toBe(true);
    expect(registeredHandlers.has(IPC_CHANNELS.HEALTH_IMPORT_FILES)).toBe(true);
    expect(registeredHandlers.has(IPC_CHANNELS.HEALTH_GENERATE_WORKFLOW)).toBe(true);
    expect(registeredHandlers.has(IPC_CHANNELS.HEALTH_APPLE_STATUS)).toBe(true);
    expect(registeredHandlers.has(IPC_CHANNELS.HEALTH_APPLE_CONNECT)).toBe(true);
    expect(registeredHandlers.has(IPC_CHANNELS.HEALTH_APPLE_DISCONNECT)).toBe(true);
    expect(registeredHandlers.has(IPC_CHANNELS.HEALTH_APPLE_PREVIEW_WRITEBACK)).toBe(true);
    expect(registeredHandlers.has(IPC_CHANNELS.HEALTH_APPLE_APPLY_WRITEBACK)).toBe(true);
  });

  it("delegates dashboard, sync, and workflow requests to HealthManager", async () => {
    const dashboardHandler = registeredHandlers.get(IPC_CHANNELS.HEALTH_GET_DASHBOARD)!;
    const syncHandler = registeredHandlers.get(IPC_CHANNELS.HEALTH_SYNC_SOURCE)!;
    const workflowHandler = registeredHandlers.get(IPC_CHANNELS.HEALTH_GENERATE_WORKFLOW)!;
    const upsertHandler = registeredHandlers.get(IPC_CHANNELS.HEALTH_UPSERT_SOURCE)!;
    const disconnectHandler = registeredHandlers.get(IPC_CHANNELS.HEALTH_APPLE_DISCONNECT)!;
    const connectHandler = registeredHandlers.get(IPC_CHANNELS.HEALTH_APPLE_CONNECT)!;

    await expect(dashboardHandler()).resolves.toMatchObject({ isDemo: false });
    await expect(
      upsertHandler(null, {
        provider: "oura",
        kind: "wearable",
        name: "Oura Ring",
      }),
    ).resolves.toMatchObject({ id: "source-id" });
    await expect(syncHandler(null, "550e8400-e29b-41d4-a716-446655440000")).resolves.toMatchObject({
      ok: true,
      sourceId: "550e8400-e29b-41d4-a716-446655440000",
    });
    await expect(
      workflowHandler(null, {
        workflowType: "visit-prep",
        sourceIds: ["550e8400-e29b-41d4-a716-446655440000"],
      }),
    ).resolves.toMatchObject({
      success: true,
      request: {
        workflowType: "visit-prep",
        sourceIds: ["550e8400-e29b-41d4-a716-446655440000"],
      },
    });

    expect(mockHealthManager.getDashboard).toHaveBeenCalledTimes(1);
    expect(mockHealthManager.upsertSource).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Oura Ring" }),
    );
    expect(mockHealthManager.syncSource).toHaveBeenCalledWith(
      "550e8400-e29b-41d4-a716-446655440000",
    );
    expect(mockHealthManager.generateWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ workflowType: "visit-prep" }),
    );

    await expect(disconnectHandler(null, "health-source:abc123")).resolves.toEqual({ success: true });
    await expect(
      connectHandler(null, {
        sourceId: "health-source:abc123",
        connectionMode: "native",
      }),
    ).resolves.toEqual({
      success: true,
      request: {
        sourceId: "health-source:abc123",
        connectionMode: "native",
      },
    });
  });
});
