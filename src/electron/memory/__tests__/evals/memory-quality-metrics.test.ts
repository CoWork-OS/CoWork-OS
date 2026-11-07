import { describe, expect, it } from "vitest";
import { gradeMemoryQuality, type QualityPair } from "./memory-quality-metrics";
import fixture from "./fixtures/memory-quality.json";

const good = (): QualityPair => ({
  id: "positive",
  category: "learning",
  expectation: {
    requiresRecall: true,
    expectedCommand: "npm run upgrade",
    supportedCommands: ["npm run upgrade"],
    staleCommands: ["npm run old"],
    mustNotExpose: ["private-command"],
  },
  enabled: {
    command: "npm run upgrade",
    context: "use `npm run upgrade`",
    recalled: ["use `npm run upgrade`"],
    estimatedMemoryTokens: 12,
  },
  disabled: { command: null, context: "", recalled: [], estimatedMemoryTokens: 0 },
});
const grade = (pair = good()) => gradeMemoryQuality([pair], fixture.thresholds);

describe("memory quality grading regressions", () => {
  it("passes supported useful recall and measures the paired gain", () => {
    expect(grade()).toMatchObject({
      passed: true,
      successGain: 1,
      enabled: { recallAt5: 1, unsupportedRate: 0, successRate: 1 },
      disabled: { successRate: 0 },
    });
  });
  it("fails empty responses even though unsupported and stale claim counts are zero", () => {
    const pair = good();
    pair.enabled.command = null;
    pair.enabled.recalled = [];
    expect(grade(pair).failures).toEqual(
      expect.arrayContaining([
        "Enabled task-proxy success below threshold",
        "Useful recall@5 below threshold",
        "Paired task-proxy gain below threshold",
      ]),
    );
  });
  it("fails fabricated and stale answers even when the text appears in memory", () => {
    const pair = good();
    pair.enabled.command = "npm run old";
    pair.enabled.context = "use `npm run old`";
    expect(grade(pair)).toMatchObject({
      passed: false,
      enabled: { unsupportedClaims: 1, staleClaims: 1 },
    });
    pair.disabled.command = "npm run invented";
    expect(grade(pair).failures).toContain("disabled: unsupported command claims");
  });
  it("fails leaked forbidden content and token overflows even with correct answers", () => {
    const pair = good();
    pair.enabled.context += " private-command";
    pair.enabled.estimatedMemoryTokens = 4001;
    expect(grade(pair).failures).toEqual(
      expect.arrayContaining([
        "enabled: forbidden content exposure",
        "enabled: memory token budget exceeded",
      ]),
    );
  });
  it("does not credit a hit below rank five or a command prefix", () => {
    const pair = good();
    pair.enabled.recalled = [...Array(5).fill("distractor"), "`npm run upgrade`"];
    expect(grade(pair).enabled.recallAt5).toBe(0);
    pair.enabled.recalled = ["`npm run upgrade:wrong`"];
    expect(grade(pair).enabled.recallAt5).toBe(0);
  });
  it("fails zero-positive, empty and duplicate corpora instead of reporting a vacuous pass", () => {
    expect(gradeMemoryQuality([], fixture.thresholds).passed).toBe(false);
    expect(gradeMemoryQuality([good(), good()], fixture.thresholds).passed).toBe(false);
    const pair = good();
    pair.expectation.expectedCommand = null;
    pair.expectation.requiresRecall = false;
    expect(grade(pair).failures).toContain("No positive recall cases");
  });
});
