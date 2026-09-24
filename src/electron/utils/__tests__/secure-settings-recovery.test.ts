import { describe, expect, it, vi } from "vitest";
import type { LoadStatus, SettingsCategory } from "../../database/SecureSettingsRepository";
import { resetUnreadableSettings } from "../secure-settings-recovery";

describe("resetUnreadableSettings", () => {
  it("preserves secure settings when decryption is unavailable and only resets verified checksum damage", () => {
    const statuses: Partial<Record<SettingsCategory, LoadStatus>> = {
      "awareness-state": "decryption_failed",
      webaccess: "checksum_mismatch",
      "subconscious-migration-v1": "os_encryption_unavailable",
      "autonomy-chief-of-staff": "success",
    };
    const repository = {
      checkHealth: vi.fn((category: SettingsCategory) => statuses[category] || "not_found"),
      delete: vi.fn(() => true),
    };

    const result = resetUnreadableSettings(repository, [
      "awareness-state",
      "webaccess",
      "subconscious-migration-v1",
      "autonomy-chief-of-staff",
    ]);

    expect(result.resetCategories).toEqual(["webaccess"]);
    expect(result.preservedCategories).toEqual([
      { category: "awareness-state", status: "decryption_failed" },
      { category: "subconscious-migration-v1", status: "os_encryption_unavailable" },
    ]);
    expect(repository.delete).toHaveBeenCalledTimes(1);
    expect(repository.delete).toHaveBeenCalledWith("webaccess");
  });
});
