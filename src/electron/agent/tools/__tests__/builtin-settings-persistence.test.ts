import { afterEach, describe, expect, it, vi } from "vitest";
import { SecureSettingsRepository } from "../../../database/SecureSettingsRepository";
import { BuiltinToolsSettingsManager } from "../builtin-settings";

afterEach(() => {
  vi.restoreAllMocks();
  BuiltinToolsSettingsManager.clearCache();
});

describe("built-in settings persistence", () => {
  it("does not publish a refused write into the live cache", () => {
    const saved = BuiltinToolsSettingsManager.getDefaultSettings();
    const repository = { exists: () => true, load: () => saved, save: vi.fn(() => false) };
    vi.spyOn(SecureSettingsRepository, "isInitialized").mockReturnValue(true);
    vi.spyOn(SecureSettingsRepository, "getInstance").mockReturnValue(repository as never);
    BuiltinToolsSettingsManager.clearCache();
    const changed = {
      ...saved,
      categories: { ...saved.categories, file: { ...saved.categories.file, enabled: false } },
    };
    expect(() => BuiltinToolsSettingsManager.saveSettings(changed)).toThrow("could not be saved");
    expect(BuiltinToolsSettingsManager.loadSettings().categories.file.enabled).toBe(true);
    repository.save.mockReturnValue(true);
    BuiltinToolsSettingsManager.saveSettings(changed);
    expect(BuiltinToolsSettingsManager.loadSettings().categories.file.enabled).toBe(false);
  });
});
