import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupermemorySettings } from "../../../shared/types";

const mocks = vi.hoisted(() => {
  let storedSettings: SupermemorySettings | undefined;
  return {
    get storedSettings() {
      return storedSettings;
    },
    set storedSettings(value: SupermemorySettings | undefined) {
      storedSettings = value;
    },
    repositorySave: vi.fn().mockImplementation((_key: string, settings: SupermemorySettings) => {
      storedSettings = settings;
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

import { SupermemoryService } from "../SupermemoryService";

describe("SupermemoryService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.storedSettings = undefined;
    SupermemoryService.clearCache();
  });

  it("returns disabled defaults when no settings exist", () => {
    const status = SupermemoryService.getConfigStatus();

    expect(status.enabled).toBe(false);
    expect(status.apiKeyConfigured).toBe(false);
    expect(status.baseUrl).toBe("https://api.supermemory.ai");
    expect(status.containerTagTemplate).toBe("cowork:{workspaceId}");
    expect(status.searchMode).toBe("hybrid");
    expect(status.isConfigured).toBe(false);
  });

  it("preserves the stored api key when saving without a replacement", () => {
    mocks.storedSettings = {
      enabled: true,
      apiKey: "sm_test_existing",
      containerTagTemplate: "cowork:{workspaceName}",
    };

    SupermemoryService.clearCache();
    SupermemoryService.saveSettings({
      enabled: true,
      apiKey: "",
      baseUrl: "https://api.supermemory.ai/",
      customContainers: [
        { tag: " work bucket ", description: " Work context " },
        { tag: "", description: "ignored" },
      ],
      threshold: 5,
    });

    expect(mocks.storedSettings?.apiKey).toBe("sm_test_existing");
    expect(mocks.storedSettings?.baseUrl).toBe("https://api.supermemory.ai");
    expect(mocks.storedSettings?.threshold).toBe(1);
    expect(mocks.storedSettings?.customContainers).toEqual([
      { tag: "work-bucket", description: "Work context" },
    ]);
  });

  it("renders and sanitizes workspace-scoped container tags", () => {
    mocks.storedSettings = {
      enabled: true,
      apiKey: "sm_test",
      containerTagTemplate: "cowork:{workspaceName}:{workspaceId}",
    };

    SupermemoryService.clearCache();
    const tag = SupermemoryService.resolveContainerTag({
      id: "ws_123",
      name: "My Workspace / Dev",
    });

    expect(tag).toBe("cowork:My-Workspace-Dev:ws_123");
  });

  it("redacts the stored api key from renderer-facing settings views", () => {
    mocks.storedSettings = {
      enabled: true,
      apiKey: "sm_test_secret",
      baseUrl: "https://api.supermemory.ai",
    };

    const view = SupermemoryService.getSettingsView();

    expect(view.apiKeyConfigured).toBe(true);
    expect("apiKey" in view).toBe(false);
  });

  it("rejects explicit container overrides outside the workspace or allowlist", () => {
    mocks.storedSettings = {
      enabled: true,
      apiKey: "sm_test",
      containerTagTemplate: "cowork:{workspaceId}",
      customContainers: [{ tag: "cowork:shared-research" }],
    };

    expect(() =>
      SupermemoryService.resolveContainerTag(
        { id: "workspace-a", name: "Workspace A" },
        "cowork:workspace-b",
      ),
    ).toThrow(/not allowed/i);

    expect(
      SupermemoryService.resolveContainerTag(
        { id: "workspace-a", name: "Workspace A" },
        "cowork:shared-research",
      ),
    ).toBe("cowork:shared-research");
  });
});
