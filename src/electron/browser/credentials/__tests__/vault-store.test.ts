import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ save: vi.fn(() => true) }));

vi.mock("../../../database/SecureSettingsRepository", () => ({
  SecureSettingsRepository: {
    isInitialized: () => true,
    getInstance: () => ({ save: mocks.save, load: () => undefined }),
  },
}));

import { VaultError, secureSettingsVaultStore, type VaultFile } from "../vault";

describe("secureSettingsVaultStore", () => {
  it("throws when secure storage refuses the write instead of reporting it saved", () => {
    const store = secureSettingsVaultStore();
    const file = {} as VaultFile;
    expect(() => store.save(file)).not.toThrow();
    mocks.save.mockReturnValueOnce(false);
    expect(() => store.save(file)).toThrow(VaultError);
  });
});
