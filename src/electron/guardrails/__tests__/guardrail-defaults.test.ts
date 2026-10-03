import { afterEach, describe, expect, it, vi } from "vitest";

const savedRecords: unknown[] = [];

vi.mock("../../database/SecureSettingsRepository", () => ({
  SecureSettingsRepository: {
    isInitialized: () => true,
    getInstance: () => ({
      getRevision: () => null,
      readRecord: () => ({ data: null, revision: null }),
      update: (_key: string, updater: () => unknown) => {
        savedRecords.push(updater());
        return { revision: savedRecords.length };
      },
    }),
  },
}));

import { GuardrailManager } from "../guardrail-manager";
import { GuardrailSettingsSchema, validateInput } from "../../utils/validation";

afterEach(() => {
  savedRecords.length = 0;
  GuardrailManager.clearCache();
});

describe("guardrail settings schema defaults", () => {
  it("fills every omitted field with the manager's defaults", () => {
    expect(GuardrailSettingsSchema.parse({})).toEqual(GuardrailManager.getDefaults());
  });

  it("keeps the manager's defaults for fields a partial save omits", () => {
    // GUARDRAIL_SAVE_SETTINGS validates the renderer payload with this schema
    // before saving it whole, so an omitted field is stored with the schema
    // default. A stale, stricter schema default silently tightened guardrails.
    const validated = validateInput(
      GuardrailSettingsSchema,
      { maxFileSizeMB: 75 },
      "guardrail settings",
    );
    GuardrailManager.saveSettings(validated);

    expect(savedRecords).toHaveLength(1);
    expect(savedRecords[0]).toEqual({ ...GuardrailManager.getDefaults(), maxFileSizeMB: 75 });
  });

  it("does not share array defaults between parses", () => {
    const first = GuardrailSettingsSchema.parse({});
    first.customBlockedPatterns.push("mutated");
    expect(GuardrailSettingsSchema.parse({}).customBlockedPatterns).toEqual([]);
    expect(GuardrailManager.getDefaults().customBlockedPatterns).toEqual([]);
  });
});
