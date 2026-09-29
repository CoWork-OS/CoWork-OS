import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DatabaseManager } from "../../../database/schema";
import { normalizeLlmProviderType } from "../../../../shared/llmProviderDisplay";
import { LLM_PROVIDER_TYPES } from "../../../../shared/types";
import { recordLlmCallError, recordLlmCallSuccess } from "../usage-telemetry";

describe("usage telemetry provider registration", () => {
  const run = vi.fn();
  const prepare = vi.fn(() => ({ run }));
  // Inserts run as units, in a transaction (DB6); the fake runs the body directly.
  const db = { prepare, transaction: (fn: unknown) => fn } as Any;

  beforeEach(() => {
    vi.spyOn(DatabaseManager, "getInstance").mockReturnValue({
      getDatabase: () => db,
    } as Any);
    prepare.mockClear();
    run.mockClear();
    prepare.mockReturnValue({ run });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stores normalized provider ids for every registered provider in llm_call_events success rows", () => {
    for (const providerType of LLM_PROVIDER_TYPES) {
      recordLlmCallSuccess(
        {
          sourceKind: "usage-insights-test",
          providerType,
          modelId: "gpt-5.4",
          modelKey: "gpt-5.4",
        },
        {
          usage: undefined,
        } as never,
      );

      const args = run.mock.calls.at(-1);
      expect(args?.[6]).toBe(normalizeLlmProviderType(providerType));
    }
  });

  it("stores normalized provider ids for every registered provider in llm_call_events error rows", () => {
    for (const providerType of LLM_PROVIDER_TYPES) {
      recordLlmCallError(
        {
          sourceKind: "usage-insights-test",
          providerType,
          modelId: "gpt-5.4-mini",
          modelKey: "gpt-5.4-mini",
        },
        new Error("quota exceeded"),
      );

      const args = run.mock.calls.at(-1);
      expect(args?.[6]).toBe(normalizeLlmProviderType(providerType));
    }
  });

  it("redacts obvious secret material before storing error messages", () => {
    recordLlmCallError(
      {
        sourceKind: "usage-insights-test",
        providerType: "openai",
        modelId: "gpt-5.4",
        modelKey: "gpt-5.4",
      },
      new Error("401 Bearer sk_test_secret apiKey=super-secret-token"),
    );

    // Shared 16-column insert: error_code and error_message are the last two parameters.
    const args = run.mock.calls.at(-1);
    expect(args?.[14]).toBe("Error");
    expect(args?.[15]).not.toContain("sk_test_secret");
    expect(args?.[15]).not.toContain("super-secret-token");
    expect(args?.[15]).toContain("[REDACTED]");
  });
});
