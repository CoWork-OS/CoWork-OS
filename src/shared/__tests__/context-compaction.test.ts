import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTEXT_COMPACTION_TARGET_RATIO,
  DEFAULT_CONTEXT_COMPACTION_TRIGGER_RATIO,
  CONTEXT_COMPACTION_OVERFLOW_TARGET_RATIO,
  compactPreview,
  isContextCompactionEventPayload,
  resolveContextCompactionPolicy,
} from "../context-compaction";

describe("context compaction policy", () => {
  it("uses the Codex-style trigger and normal replacement target", () => {
    const policy = resolveContextCompactionPolicy({
      availableTokens: 100_000,
      currentTokens: 90_000,
    });

    expect(policy.triggerRatio).toBe(DEFAULT_CONTEXT_COMPACTION_TRIGGER_RATIO);
    expect(policy.targetRatio).toBe(DEFAULT_CONTEXT_COMPACTION_TARGET_RATIO);
    expect(policy.triggerTokens).toBe(90_000);
    expect(policy.targetTokens).toBe(55_000);
    expect(policy.shouldCompact).toBe(true);
  });

  it("uses an aggressive target when recovering from capacity overflow", () => {
    const policy = resolveContextCompactionPolicy({
      availableTokens: 10_000,
      currentTokens: 10_001,
      overflow: true,
    });

    expect(policy.targetRatio).toBe(CONTEXT_COMPACTION_OVERFLOW_TARGET_RATIO);
    expect(policy.targetTokens).toBe(3_500);
    expect(policy.shouldCompact).toBe(true);
  });

  it("does not trigger below the threshold", () => {
    const policy = resolveContextCompactionPolicy({
      availableTokens: 100_000,
      currentTokens: 89_999,
    });

    expect(policy.shouldCompact).toBe(false);
  });
});

describe("context compaction event payloads", () => {
  it("validates correlated lifecycle payloads", () => {
    expect(
      isContextCompactionEventPayload({
        compactionId: "compact-1",
        status: "completed",
        trigger: "automatic",
        phase: "pre_turn",
        historyGenerationBefore: 3,
        historyGenerationAfter: 4,
      }),
    ).toBe(true);
    expect(isContextCompactionEventPayload({ status: "completed" })).toBe(false);
  });

  it("creates a safe one-line preview", () => {
    expect(compactPreview("  Decisions:\n- keep the API  ")).toBe("Decisions: - keep the API");
    expect(compactPreview("x".repeat(8), 5)).toBe("xxxx…");
    expect(compactPreview("   ")).toBeUndefined();
  });
});
