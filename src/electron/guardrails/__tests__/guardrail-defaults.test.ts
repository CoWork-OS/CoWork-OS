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

describe("token budget defaults", () => {
  it("allows 2,000,000 tokens per user turn by default", () => {
    // 100,000 counted every turn of the task stopped local providers (no cache
    // reporting) within a handful of calls and ended long threads.
    expect(GuardrailManager.getDefaults()).toMatchObject({
      tokenBudgetEnabled: true,
      maxTokensPerTask: 2_000_000,
    });
    expect(GuardrailManager.isTokenBudgetExceeded(1_999_999).exceeded).toBe(false);
    expect(GuardrailManager.isTokenBudgetExceeded(2_000_000)).toMatchObject({
      exceeded: true,
      limit: 2_000_000,
      source: "global",
    });
  });

  it("keeps the $10 cumulative cost cap as the lifetime spend guard", () => {
    expect(GuardrailManager.getDefaults()).toMatchObject({
      costBudgetEnabled: true,
      maxCostPerTask: 10,
    });
  });

  it("measures a task's own budgetTokens against whole-task usage", () => {
    // The global cap counts the current turn; an explicit task budget counts
    // everything the task has used.
    expect(
      GuardrailManager.isTokenBudgetExceeded(1_000, { taskBudget: 50_000, taskTokensUsed: 60_000 }),
    ).toMatchObject({ exceeded: true, used: 60_000, limit: 50_000, source: "task" });
    expect(
      GuardrailManager.isTokenBudgetExceeded(1_000, { taskBudget: 50_000, taskTokensUsed: 40_000 }),
    ).toMatchObject({ exceeded: false, source: "task" });
    expect(
      GuardrailManager.isTokenBudgetExceeded(1_000, { taskTokensUsed: 9_000_000 }),
    ).toMatchObject({ exceeded: false, used: 1_000, source: "global" });
  });
});
